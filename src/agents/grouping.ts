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
 */
export function groupSessionProjects(
  claudeProjects: readonly ClaudeProject[],
  codexTopLevel: readonly SessionInfo[]
): SessionProjectGroup[] {
  interface MutableProject extends SessionProjectIdentity {
    claudeProjects: ClaudeProject[];
    codexSessions: SessionInfo[];
    latestMtime: number;
  }

  const projects = new Map<string, MutableProject>();
  const ensure = (
    identity: SessionProjectIdentity,
    latestMtime: number
  ): MutableProject => {
    let project = projects.get(identity.key);
    if (!project) {
      project = {
        ...identity,
        claudeProjects: [],
        codexSessions: [],
        latestMtime,
      };
      projects.set(identity.key, project);
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
      };
    })
    .sort(
      (a, b) =>
        b.latestMtime - a.latestMtime ||
        a.label.localeCompare(b.label) ||
        a.key.localeCompare(b.key)
    );
}

/* ---------- 對話內容解析 ---------- */
