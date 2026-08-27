/** 跨 AI 的專案分組：把 Claude buckets 與 Codex cwd 併成同一個專案模型。 */

import * as path from "path";

import type {
  ClaudeProject,
  CodexProjectGroup,
  SessionInfo,
  SessionProjectAiGroup,
  SessionProjectGroup,
  SessionProjectIdentity,
} from "./types";

/**
 * 依 Codex session 記錄的 cwd 分組。Windows 路徑不分大小寫且接受兩種分隔符，
 * POSIX 路徑則保留大小寫；沒有 cwd 的舊紀錄集中到同一個 fallback 群組。
 */
export function groupCodexProjects(infos: SessionInfo[]): CodexProjectGroup[] {
  const groups = new Map<string, CodexProjectGroup>();
  for (const info of infos) {
    const project = sessionProjectIdentity(info.cwd);
    let group = groups.get(project.key);
    if (!group) {
      group = {
        ...project,
        sessions: [],
        latestMtime: info.mtime,
      };
      groups.set(project.key, group);
    }
    group.sessions.push(info);
    group.latestMtime = Math.max(group.latestMtime, info.mtime);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      sessions: group.sessions.slice().sort((a, b) => b.mtime - a.mtime),
    }))
    .sort(
      (a, b) =>
        b.latestMtime - a.latestMtime ||
        a.label.localeCompare(b.label) ||
        a.key.localeCompare(b.key)
    );
}

export function sessionProjectIdentity(
  cwd: string | undefined
): SessionProjectIdentity {
  const raw = cwd?.trim();
  if (!raw) {
    return { key: "missing:", label: "未識別專案" };
  }

  // 不能直接使用主機的 path 實作：同步回來的 session 可能來自另一種作業系統。
  const isWindows =
    /^[a-z]:[\\/]/i.test(raw) ||
    raw.startsWith("\\\\") ||
    (!raw.startsWith("/") && raw.includes("\\"));
  const flavor = isWindows ? path.win32 : path.posix;
  const normalized = flavor.normalize(raw);
  const root = flavor.parse(normalized).root;
  const clean =
    normalized.length > root.length ? normalized.replace(/[\\/]+$/, "") : normalized;
  return {
    key: `${isWindows ? "windows" : "posix"}:${
      isWindows ? clean.toLowerCase() : clean
    }`,
    label: flavor.basename(clean) || clean,
    cwd: clean,
  };
}

/**
 * 把 Claude 的 project buckets 與 Codex 頂層 sessions 合成「專案 → AI」資料模型。
 * Claude 沒有可信 cwd 時刻意以 bucket 自成一組，避免近似解碼誤併到 Codex 專案。
 *
 * isLocalPath 判斷專案在這台電腦上有沒有位置；解不出位置的排在最後，
 * 不會和真正的本機專案混在一起（呼叫端據此顯示成「未對應」）。
 *
 * projectIdFor 把工作目錄分組再往上收斂成「專案身分」分組：同一個專案在兩台電腦
 * 的路徑不同，同步回來的檔案帶著來源電腦的 cwd，光看路徑會是兩組。認得出身分就
 * 併成一組，並以本機真的存在的那個路徑當這組的門面。認不出身分的維持路徑分組。
 */
export function groupSessionProjects(
  claudeProjects: readonly ClaudeProject[],
  codexTopLevel: readonly SessionInfo[],
  isLocalPath: (cwd: string | undefined) => boolean = () => true,
  projectIdFor: (identityKey: string) => string | undefined = () => undefined
): SessionProjectGroup[] {
  interface MutableProject extends SessionProjectIdentity {
    claudeProjects: ClaudeProject[];
    codexSessions: SessionInfo[];
    latestMtime: number;
    /** 吸收進來、但工作目錄不在本機的路徑分組 key，供呼叫端回頭找那些檔案。 */
    strayKeys: Set<string>;
  }

  // 合併判斷會對同一個工作目錄問好幾次（是不是 stray、要不要當門面、最後的 local）。
  // isLocalPath 實際上是 fs.existsSync，每個路徑只該問一次。
  const localCache = new Map<string, boolean>();
  const local = (cwd: string | undefined): boolean => {
    const cacheKey = cwd ?? "";
    let hit = localCache.get(cacheKey);
    if (hit === undefined) {
      hit = isLocalPath(cwd);
      localCache.set(cacheKey, hit);
    }
    return hit;
  };

  const projects = new Map<string, MutableProject>();
  const ensure = (
    identity: SessionProjectIdentity,
    latestMtime: number
  ): MutableProject => {
    const groupKey = projectIdFor(identity.key) ?? identity.key;
    let project = projects.get(groupKey);
    if (!project) {
      project = {
        ...identity,
        claudeProjects: [],
        codexSessions: [],
        latestMtime,
        strayKeys: new Set<string>(),
      };
      projects.set(groupKey, project);
    }
    if (!local(identity.cwd)) {
      project.strayKeys.add(identity.key);
    }
    // 門面要用本機真的找得到的那個路徑，否則合併後的節點會顯示來源電腦的路徑。
    if (!local(project.cwd) && local(identity.cwd)) {
      project.key = identity.key;
      project.label = identity.label;
      project.cwd = identity.cwd;
    }
    project.latestMtime = Math.max(project.latestMtime, latestMtime);
    return project;
  };

  for (const claude of claudeProjects) {
    const projectDir = path.basename(claude.dir);
    const identity = claude.cwd
      ? sessionProjectIdentity(claude.cwd)
      : {
          key: `claudeBucket:${projectDir.toLowerCase()}`,
          label: claude.label,
          cwd: claude.decoded,
        };
    ensure(identity, claude.mtime).claudeProjects.push(claude);
  }

  for (const codex of groupCodexProjects([...codexTopLevel])) {
    ensure(
      { key: codex.key, label: codex.label, cwd: codex.cwd },
      codex.latestMtime
    ).codexSessions.push(...codex.sessions);
  }

  return [...projects.values()]
    .map((project) => {
      const ai: SessionProjectAiGroup[] = [];
      if (project.claudeProjects.length) {
        const items = project.claudeProjects
          .slice()
          .sort((a, b) => b.mtime - a.mtime || a.dir.localeCompare(b.dir));
        ai.push({
          tool: "claude",
          projects: items,
          latestMtime: items[0].mtime,
        });
      }
      if (project.codexSessions.length) {
        const sessions = project.codexSessions
          .slice()
          .sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file));
        ai.push({
          tool: "codex",
          sessions,
          latestMtime: sessions[0].mtime,
        });
      }
      return {
        key: project.key,
        label: project.label,
        cwd: project.cwd,
        ai,
        latestMtime: project.latestMtime,
        local: local(project.cwd),
        // 工作目錄不在本機的那些路徑：檔案還帶著來源電腦的 cwd，要改寫才會
        // 連 Codex CLI 自己也用本機路徑列出它們。
        strayCwdKeys: [...project.strayKeys],
      };
    })
    .sort(
      (a, b) =>
        Number(b.local) - Number(a.local) ||
        b.latestMtime - a.latestMtime ||
        a.label.localeCompare(b.label) ||
        a.key.localeCompare(b.key)
    );
}

/* ---------- 對話內容解析 ---------- */
