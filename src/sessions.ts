import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { readCodexSessionIndex } from "./codexIndex";
import {
  codexMetaCwd,
  codexParentThreadId,
  codexSessionMeta,
  codexSubagentName,
  codexThreadId,
} from "./codexMeta";

export type Tool = "claude" | "codex";

export interface SessionInfo {
  tool: Tool;
  file: string;
  id: string;
  /**
   * 備份端辨識這個 session 的 id（規則見 codexMeta.codexThreadId）。
   * 選取規則一律用這個值，否則 Codex 子代理檔（id 是自身、備份端用父 thread id）
   * 會勾了卻備份不到。
   */
  backupId: string;
  mtime: number;
  size: number;
  title: string;
  cwd?: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
  /** Codex 子 thread：session_meta 的 parent_thread_id */
  parentThreadId?: string;
  /** Codex 子代理名稱（thread_source=subagent 時，如 guardian） */
  subagent?: string;
}

export interface ClaudeProject {
  dir: string;
  label: string;
  /** 從 session 內容讀出的實際工作目錄；讀不到時使用 decoded 的近似路徑。 */
  cwd?: string;
  decoded: string;
  mtime: number;
  count: number;
  /**
   * 專案底下每個 session 的 id（= 去掉副檔名的檔名）。樹狀圖用它算「部分選取」，
   * 不必先把整個專案的 session 讀出來。備份用的 backupId 取自檔案裡的 sessionId，
   * Claude 兩者一致；萬一不一致也只影響這個提示，不影響備份範圍。
   */
  sessionIds: string[];
}

export interface CodexFile {
  file: string;
  id: string;
  title?: string;
  date: string;
  mtime: number;
  size: number;
}

const FIRST_CHUNK = 262144;
const titleCache = new Map<string, { mtime: number; size: number; info: SessionInfo }>();

export function clearSessionCache(): void {
  titleCache.clear();
}

export function claudeAiTitle(lines: any[]): string | undefined {
  for (const line of lines) {
    if (typeof line?.aiTitle === "string" && line.aiTitle.trim()) {
      return line.aiTitle.trim();
    }
  }
  return undefined;
}

export async function readClaudeMetadata(
  file: string
): Promise<{ aiTitle?: string; cwd?: string; sessionId?: string }> {
  let input: fs.ReadStream | undefined;
  let aiTitle: string | undefined;
  let cwd: string | undefined;
  let sessionId: string | undefined;
  try {
    input = fs.createReadStream(file, { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const text of lines) {
      if (!text.trim()) {
        continue;
      }
      let value: any;
      try {
        value = JSON.parse(text);
      } catch {
        continue;
      }
      if (!aiTitle && typeof value?.aiTitle === "string" && value.aiTitle.trim()) {
        aiTitle = value.aiTitle.trim();
      }
      if (!cwd && typeof value?.cwd === "string") {
        cwd = value.cwd;
      }
      if (!sessionId && typeof value?.sessionId === "string") {
        sessionId = value.sessionId;
      }
      if (aiTitle && cwd && sessionId) {
        break;
      }
    }
  } catch {
    // 無法讀取時回傳目前已取得的中繼資料。
  } finally {
    input?.destroy();
  }
  return { aiTitle, cwd, sessionId };
}

function fmt(ms: number): { date: string; time: string } {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}:${p(d.getMinutes())}`,
  };
}

function cleanTitle(s: string): string {
  const t = s.replace(/^[#\s]+/, "").replace(/\s+/g, " ").trim();
  return t.length > 60 ? t.slice(0, 60) + "…" : t || "(無標題)";
}

async function readFirstLines(file: string): Promise<any[]> {
  let fd: fs.promises.FileHandle | undefined;
  try {
    fd = await fs.promises.open(file, "r");
    const buf = Buffer.alloc(FIRST_CHUNK);
    const { bytesRead } = await fd.read(buf, 0, FIRST_CHUNK, 0);
    const lines = buf.subarray(0, bytesRead).toString("utf8").split("\n");
    if (bytesRead === FIRST_CHUNK) {
      lines.pop(); // 最後一行可能被截斷
    }
    return lines
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return undefined;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  } finally {
    await fd?.close();
  }
}

async function readAllLines(file: string): Promise<any[]> {
  try {
    const text = await fs.promises.readFile(file, "utf8");
    return text
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return undefined;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/* ---------- Claude ---------- */

const CLAUDE_SKIP_PREFIX = [
  "<command-name>",
  "<local-command",
  "<command-message>",
  "Caveat:",
  "<system-reminder",
  "<user-prompt-submit-hook",
];

function claudeText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const texts = content
      .filter((c) => c?.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string);
    if (texts.length) {
      return texts.join("\n");
    }
  }
  return undefined;
}

function claudeUserOk(t: string): boolean {
  return !CLAUDE_SKIP_PREFIX.some((p) => t.startsWith(p));
}

/** projects 目錄名還原成路徑（近似）：c--Users-user-x → C:\Users\user\x */
export function decodeProjectDir(name: string): string {
  const m = /^([A-Za-z])--(.+)$/.exec(name);
  if (m) {
    return m[1].toUpperCase() + ":\\" + m[2].replace(/-/g, "\\");
  }
  return name;
}

/** 只讀第一個 chunk 找 cwd，避免為了建立專案樹掃完整份 Claude 對話。 */
async function readClaudeProjectCwd(file: string): Promise<string | undefined> {
  for (const value of await readFirstLines(file)) {
    if (typeof value?.cwd === "string" && value.cwd.trim()) {
      return value.cwd;
    }
  }
  return undefined;
}

function cwdMatchesClaudeProjectDir(cwd: string, projectDir: string): boolean {
  const normalized = sessionProjectIdentity(cwd).cwd;
  return (
    normalized?.replace(/[:\\/]/g, "-").toLowerCase() === projectDir.toLowerCase()
  );
}

export async function listClaudeProjects(projectsRoot: string): Promise<ClaudeProject[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ClaudeProject[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) {
      continue;
    }
    const dir = path.join(projectsRoot, e.name);
    let files: { name: string; mtime: number }[] = [];
    try {
      const names = (await fs.promises.readdir(dir)).filter((f) => f.endsWith(".jsonl"));
      files = (
        await Promise.all(
          names.map(async (name) => {
            try {
              return { name, mtime: (await fs.promises.stat(path.join(dir, name))).mtimeMs };
            } catch {
              return undefined;
            }
          })
        )
      )
        .filter((file): file is { name: string; mtime: number } => Boolean(file))
        .sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
    } catch {
      continue;
    }
    if (!files.length) {
      continue;
    }
    let recordedCwd: string | undefined;
    for (const file of files) {
      const candidate = await readClaudeProjectCwd(path.join(dir, file.name));
      if (candidate && cwdMatchesClaudeProjectDir(candidate, e.name)) {
        recordedCwd = candidate;
        break;
      }
    }
    const identity = sessionProjectIdentity(recordedCwd ?? decodeProjectDir(e.name));
    const decoded = identity.cwd ?? decodeProjectDir(e.name);
    out.push({
      dir,
      label: identity.label,
      cwd: recordedCwd ? identity.cwd : undefined,
      decoded,
      mtime: files[0].mtime,
      count: files.length,
      sessionIds: files.map((file) => file.name.replace(/\.jsonl$/, "")),
    });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export async function listClaudeSessions(projectDir: string): Promise<SessionInfo[]> {
  let files: string[];
  try {
    files = (await fs.promises.readdir(projectDir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const out: SessionInfo[] = [];
  for (const f of files) {
    const file = path.join(projectDir, f);
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(file);
    } catch {
      continue;
    }
    const cached = titleCache.get(file);
    if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) {
      out.push(cached.info);
      continue;
    }
    const { aiTitle, cwd, sessionId } = await readClaudeMetadata(file);
    const { date, time } = fmt(st.mtimeMs);
    const fileId = f.replace(/\.jsonl$/, "");
    const info: SessionInfo = {
      tool: "claude",
      file,
      id: fileId,
      backupId: sessionId ?? fileId,
      mtime: st.mtimeMs,
      size: st.size,
      title: cleanTitle(aiTitle ?? "(無標題)"),
      cwd,
      date,
      time,
    };
    titleCache.set(file, { mtime: st.mtimeMs, size: st.size, info });
    out.push(info);
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/* ---------- Codex ---------- */

function codexUserOk(t: string): boolean {
  return (
    !t.startsWith("<") &&
    !t.startsWith("# AGENTS.md") &&
    !t.startsWith("The following is the Codex agent history")
  );
}

/** IDE 包裝訊息（# Context from my IDE setup...）只取真正的提問部分。 */
function codexTexts(content: unknown, kind: string): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const texts = content
    .filter((c) => c?.type === kind && typeof c.text === "string")
    .map((c) => c.text as string);
  return texts.length ? texts.join("\n") : undefined;
}

/** 便宜列舉：只掃路徑與 stat，不讀內容。日期取自 sessions/YYYY/MM/DD 路徑。 */
export async function listCodexFiles(sessionsRoot: string): Promise<CodexFile[]> {
  const out: CodexFile[] = [];
  const index = await readCodexSessionIndex(
    path.join(path.dirname(sessionsRoot), "session_index.jsonl")
  );
  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile() && e.name.endsWith(".jsonl")) {
        let st: fs.Stats;
        try {
          st = await fs.promises.stat(full);
        } catch {
          continue;
        }
        const m = /(\d{4})[\\/](\d{2})[\\/](\d{2})/.exec(full);
        const date = m ? `${m[1]}-${m[2]}-${m[3]}` : fmt(st.mtimeMs).date;
        const id = codexSessionIdFromFilename(full);
        out.push({
          file: full,
          id,
          title: index.get(id)?.thread_name,
          date,
          mtime: st.mtimeMs,
          size: st.size,
        });
      }
    }
  }
  await walk(sessionsRoot);
  return out.sort((a, b) => b.mtime - a.mtime);
}

export function codexSessionIdFromFilename(file: string): string {
  const basename = path.basename(file, ".jsonl");
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
    basename
  );
  return match?.[1] ?? basename;
}

export async function codexSessionInfo(cf: CodexFile): Promise<SessionInfo> {
  const cached = titleCache.get(cf.file);
  if (
    cached &&
    cached.mtime === cf.mtime &&
    cached.size === cf.size &&
    (!cf.title || cached.info.title === cleanTitle(cf.title))
  ) {
    return cached.info;
  }
  const lines = await readFirstLines(cf.file);
  let cwd: string | undefined;
  let id = cf.id;
  let backupId = cf.id;
  let parentThreadId: string | undefined;
  let subagent: string | undefined;
  for (const o of lines) {
    const meta = codexSessionMeta(o);
    if (meta) {
      cwd = codexMetaCwd(meta) ?? cwd;
      backupId = codexThreadId(meta) ?? backupId;
      const parent = codexParentThreadId(meta);
      if (parent !== undefined) {
        parentThreadId = parent;
        // 新版子代理檔的 session_id 是「父」thread id，自身身分要用 payload.id（=檔名 uuid）
        const own = typeof meta.id === "string" ? meta.id : undefined;
        id = own && own !== parentThreadId ? own : cf.id;
      } else {
        id = codexThreadId(meta) ?? id;
      }
      subagent = codexSubagentName(meta.source);
      break;
    }
  }
  const fallback = subagent ? `子代理：${subagent}` : "(無標題)";
  const { date, time } = fmt(cf.mtime);
  const info: SessionInfo = {
    tool: "codex",
    file: cf.file,
    id,
    backupId,
    mtime: cf.mtime,
    size: cf.size,
    title: cleanTitle(cf.title ?? fallback),
    cwd,
    date,
    time,
    parentThreadId,
    subagent,
  };
  titleCache.set(cf.file, { mtime: cf.mtime, size: cf.size, info });
  return info;
}

/* ---------- Codex thread 分組 ---------- */

export interface CodexThreadGroup {
  /** 頂層 sessions（沒有 parent_thread_id 的） */
  topLevel: SessionInfo[];
  /** 子 thread 掛載點：key 是父 thread「最新 rollout 檔」的路徑 */
  subsByHost: Map<string, SessionInfo[]>;
  /** 有 parent_thread_id 但父檔案已不在本機的子 thread（不顯示於樹上，仍會備份） */
  orphans: SessionInfo[];
}

/**
 * 把含 parent_thread_id 的子 thread 掛到父 thread 底下。
 * 父 thread 可能因 resume 有多個 rollout 檔，子 thread 掛在最新的那個檔案節點上；
 * 父檔案不存在的子 thread 歸入 orphans，不當獨立 session 顯示。
 */
export function groupCodexThreads(infos: SessionInfo[]): CodexThreadGroup {
  const byId = new Map<string, SessionInfo[]>();
  for (const info of infos) {
    const arr = byId.get(info.id) ?? [];
    arr.push(info);
    byId.set(info.id, arr);
  }
  const newestFileOf = (threadId: string): string | undefined =>
    byId
      .get(threadId)
      ?.slice()
      .sort((a, b) => b.mtime - a.mtime)[0]?.file;

  const topLevel: SessionInfo[] = [];
  const subsByHost = new Map<string, SessionInfo[]>();
  const orphans: SessionInfo[] = [];
  for (const info of infos) {
    if (!info.parentThreadId || info.parentThreadId === info.id) {
      topLevel.push(info);
      continue;
    }
    const host = newestFileOf(info.parentThreadId);
    if (!host) {
      orphans.push(info);
      continue;
    }
    const arr = subsByHost.get(host) ?? [];
    arr.push(info);
    subsByHost.set(host, arr);
  }
  for (const arr of subsByHost.values()) {
    arr.sort((a, b) => b.mtime - a.mtime);
  }
  return { topLevel, subsByHost, orphans };
}

/* ---------- Codex 專案分組 ---------- */

export interface CodexProjectGroup {
  /** 跨平台正規化後的工作目錄；供樹節點 id 與分組使用。 */
  key: string;
  /** 工作目錄的最後一段；側欄以此作為專案名稱。 */
  label: string;
  /** 正規化後、供使用者辨識的完整工作目錄。 */
  cwd?: string;
  sessions: SessionInfo[];
  /** 專案中最新 session 的修改時間；用來排列專案。 */
  latestMtime: number;
}

export interface SessionProjectIdentity {
  key: string;
  label: string;
  cwd?: string;
}

export interface ClaudeProjectAiGroup {
  tool: "claude";
  projects: ClaudeProject[];
  latestMtime: number;
}

export interface CodexProjectAiGroup {
  tool: "codex";
  sessions: SessionInfo[];
  latestMtime: number;
}

export type SessionProjectAiGroup = ClaudeProjectAiGroup | CodexProjectAiGroup;

export interface SessionProjectGroup extends SessionProjectIdentity {
  ai: SessionProjectAiGroup[];
  latestMtime: number;
}

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

export type TranscriptBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; name: string; detail?: string }
  /** IDE 附加在提問前面的上下文（開啟中的檔案、選取範圍），不是使用者打的字。 */
  | { kind: "context"; label: string; detail: string }
  /** 一輪回覆中途的過程（進度說明與工具呼叫），預覽收合起來只留最後的答案。 */
  | { kind: "work"; durationMs?: number; items: TranscriptBlock[] };

export interface TranscriptMessage {
  /** notice 是對話流程本身的事件（例如使用者中斷），不屬於任何一方的發言。 */
  role: "user" | "assistant" | "notice";
  blocks: TranscriptBlock[];
  /** 這則訊息第一段內容的時間（Codex 的部分紀錄沒有時間欄位）。 */
  timestamp?: string;
}

export interface Transcript {
  tool: Tool;
  file: string;
  title: string;
  cwd?: string;
  messages: TranscriptMessage[];
}

/** 工具呼叫在預覽裡只佔一行，從參數挑一個最能代表這次呼叫的值。 */
const TOOL_DETAIL_KEYS = [
  "command",
  "file_path",
  "path",
  "pattern",
  "query",
  "url",
  "description",
  "prompt",
];

function toolDetail(input: unknown): string | undefined {
  if (typeof input === "string") {
    return oneLine(input);
  }
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  for (const key of TOOL_DETAIL_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return oneLine(value);
    }
    if (Array.isArray(value) && value.length) {
      return oneLine(value.join(" "));
    }
  }
  return undefined;
}

function oneLine(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 160 ? text.slice(0, 160) + "…" : text;
}

/** IDE 注入的上下文標籤：預覽裡收成一張小卡片，而不是原封不動印出標籤。 */
const IDE_CONTEXT_TAGS = [
  { tag: "ide_opened_file", label: "開啟檔案" },
  { tag: "ide_selection", label: "選取內容" },
];

const PATH_IN_TEXT = /([A-Za-z]:[\\/][^\s"'<>]+|\/[^\s"'<>]{2,})/;

/**
 * 從使用者訊息中抽出 IDE 上下文與注入的 system-reminder。
 * 這些都不是使用者打的字，混在內文裡會讓預覽讀起來像雜訊。
 */
export function extractUserContext(text: string): {
  contexts: { label: string; detail: string }[];
  rest: string;
} {
  const contexts: { label: string; detail: string }[] = [];
  let rest = text;
  for (const { tag, label } of IDE_CONTEXT_TAGS) {
    const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
    rest = rest.replace(pattern, (_, inner: string) => {
      const detail = PATH_IN_TEXT.exec(inner)?.[1] ?? oneLine(inner);
      if (detail) {
        contexts.push({ label, detail });
      }
      return "";
    });
  }
  rest = rest.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  return { contexts, rest: rest.trim() };
}

/** Claude Code 在使用者按下中斷時寫入的標記，獨立成一則流程訊息。 */
const INTERRUPTED = /^\s*\[Request interrupted by user[^\]]*\]\s*$/;

export function interruptionNotice(text: string): string | undefined {
  return INTERRUPTED.test(text) ? "使用者中斷了這次回覆" : undefined;
}

/** 兩種工具各自解析出來的結果，差別只在怎麼讀，讀完的形狀是一樣的。 */
interface ParsedTranscript {
  title: string;
  cwd?: string;
  messages: TranscriptMessage[];
}

/** 使用者訊息＝IDE 注入的上下文卡片，後面接真正打出來的問題。 */
function userMessage(
  contexts: { label: string; detail: string }[],
  text: string,
  timestamp?: string
): TranscriptMessage {
  return {
    role: "user",
    blocks: [
      ...contexts.map((context) => ({ kind: "context" as const, ...context })),
      { kind: "text" as const, text },
    ],
    timestamp,
  };
}

/**
 * 把 JSONL 轉成訊息串，預覽與 Markdown 匯出共用同一份解析結果。
 * 連續的同角色內容會併成一則訊息：工具呼叫因此留在觸發它的那次回覆裡，
 * 而不是變成一則獨立訊息。
 */
export async function readTranscript(tool: Tool, file: string): Promise<Transcript> {
  const lines = await readAllLines(file);
  const parsed =
    tool === "claude"
      ? parseClaudeTranscript(lines)
      : await parseCodexTranscript(lines, file);
  return {
    tool,
    file,
    title: cleanTitle(parsed.title),
    cwd: parsed.cwd,
    messages: parsed.messages,
  };
}

function parseClaudeTranscript(lines: any[]): ParsedTranscript {
  const messages: TranscriptMessage[] = [];
  let cwd: string | undefined;

  /**
   * 助理的連續紀錄併成一則，工具呼叫才會留在觸發它的那次回覆裡。
   * 使用者訊息不併：每一次送出都是獨立的一輪，併起來會讓中斷前後的兩句話黏成一段。
   */
  const appendAssistant = (block: TranscriptBlock, timestamp?: string) => {
    const last = messages[messages.length - 1];
    if (last?.role === "assistant") {
      last.blocks.push(block);
      return;
    }
    messages.push({ role: "assistant", blocks: [block], timestamp });
  };

  for (const o of lines) {
    if (!cwd && typeof o.cwd === "string") {
      cwd = o.cwd;
    }
    if (o.type === "user" && o.message && o.isMeta !== true) {
      const t = claudeText(o.message.content);
      if (t && claudeUserOk(t)) {
        const notice = interruptionNotice(t);
        if (notice) {
          messages.push({
            role: "notice",
            blocks: [{ kind: "text", text: notice }],
            timestamp: o.timestamp,
          });
        } else {
          const { contexts, rest } = extractUserContext(t);
          // 只有 IDE 上下文、沒有真正提問的訊息不顯示。
          if (rest) {
            messages.push(userMessage(contexts, rest, o.timestamp));
          }
        }
      }
    } else if (o.type === "assistant" && o.message && Array.isArray(o.message.content)) {
      for (const c of o.message.content) {
        if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) {
          appendAssistant({ kind: "text", text: c.text }, o.timestamp);
        } else if (
          c?.type === "thinking" &&
          typeof c.thinking === "string" &&
          c.thinking.trim()
        ) {
          // thinking 的明文不一定會被寫進紀錄（只留加密的 signature），空的就跳過。
          appendAssistant({ kind: "thinking", text: c.thinking }, o.timestamp);
        } else if (c?.type === "tool_use" && c.name) {
          appendAssistant(
            { kind: "tool", name: c.name, detail: toolDetail(c.input) },
            o.timestamp
          );
        }
      }
    }
  }

  return { title: claudeAiTitle(lines) ?? "(無標題)", cwd, messages };
}

async function parseCodexTranscript(
  lines: any[],
  file: string
): Promise<ParsedTranscript> {
  const messages: TranscriptMessage[] = [];
  let cwd: string | undefined;
  let id = codexSessionIdFromFilename(file);
  // Codex 一輪回覆會夾雜數次進度說明，最後一則才是答案；
  // 先收集起來，等這一輪結束（task_complete）再決定哪些要收合。
  let pending: TranscriptBlock[] = [];
  let pendingAt: string | undefined;
  let durationMs: number | undefined;

  const flushTurn = () => {
    if (pending.length) {
      const lastText = findLastTextIndex(pending);
      const work = lastText >= 0 ? pending.slice(0, lastText) : pending;
      const answer = lastText >= 0 ? pending.slice(lastText) : [];
      messages.push({
        role: "assistant",
        blocks: [
          ...(work.length ? [{ kind: "work" as const, durationMs, items: work }] : []),
          ...answer,
        ],
        timestamp: pendingAt,
      });
    }
    pending = [];
    pendingAt = undefined;
    durationMs = undefined;
  };
  const collect = (block: TranscriptBlock, timestamp?: string) => {
    pending.push(block);
    pendingAt = pendingAt ?? timestamp;
  };

  for (const o of lines) {
    const meta = codexSessionMeta(o);
    if (meta) {
      cwd = codexMetaCwd(meta) ?? cwd;
      id = codexThreadId(meta) ?? id;
    }
    if (o.type === "event_msg" && o.payload?.type === "task_complete") {
      if (typeof o.payload.duration_ms === "number") {
        durationMs = o.payload.duration_ms;
      }
      flushTurn();
      continue;
    }
    if (o.type !== "response_item" || !o.payload) {
      continue;
    }
    const p = o.payload;
    if (p.type === "message" && p.role === "user") {
      const t = codexTexts(p.content, "input_text");
      if (t && codexUserOk(t)) {
        const { contexts, rest } = extractUserContext(t);
        if (rest) {
          // 沒有 task_complete 的舊紀錄：遇到下一次提問就把上一輪收掉。
          flushTurn();
          messages.push(userMessage(contexts, rest, o.timestamp));
        }
      }
    } else if (p.type === "message" && p.role === "assistant") {
      const t = codexTexts(p.content, "output_text");
      if (t) {
        collect({ kind: "text", text: t }, o.timestamp);
      }
    } else if (p.type === "reasoning") {
      const t = codexTexts(p.summary, "summary_text");
      if (t) {
        collect({ kind: "thinking", text: t }, o.timestamp);
      }
    } else if (p.type === "function_call" && p.name) {
      collect(
        { kind: "tool", name: p.name, detail: toolDetail(safeJson(p.arguments)) },
        o.timestamp
      );
    } else if (p.type === "local_shell_call" && p.action?.command) {
      collect({ kind: "tool", name: "shell", detail: toolDetail(p.action.command) }, o.timestamp);
    }
  }
  flushTurn();

  const codexRoot = codexRootFromSessionFile(file);
  const title = codexRoot
    ? (await readCodexSessionIndex(path.join(codexRoot, "session_index.jsonl"))).get(id)
        ?.thread_name ?? "(無標題)"
    : "(無標題)";
  return { title, cwd, messages };
}

function findLastTextIndex(blocks: TranscriptBlock[]): number {
  for (let index = blocks.length - 1; index >= 0; index--) {
    if (blocks[index].kind === "text") {
      return index;
    }
  }
  return -1;
}

function safeJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/* ---------- Markdown 匯出 ---------- */

export async function renderSessionMarkdown(tool: Tool, file: string): Promise<string> {
  const transcript = await readTranscript(tool, file);
  const parts: string[] = [];
  for (const message of transcript.messages) {
    const body: string[] = [];
    const tools: string[] = [];
    for (const block of message.blocks) {
      if (block.kind === "text") {
        body.push(block.text);
      } else if (block.kind === "thinking") {
        body.push(`> 💭 ${block.text.replace(/\n/g, "\n> ")}`);
      } else if (block.kind === "context") {
        body.push(`> 📄 ${block.label}：\`${block.detail}\``);
      } else if (block.kind === "work") {
        for (const item of block.items) {
          if (item.kind === "text" || item.kind === "thinking") {
            body.push(`> ${item.text.replace(/\n/g, "\n> ")}`);
          } else if (item.kind === "tool") {
            tools.push(item.detail ? `${item.name}：\`${item.detail}\`` : item.name);
          }
        }
      } else {
        tools.push(block.detail ? `${block.name}：\`${block.detail}\`` : block.name);
      }
    }
    if (tools.length) {
      body.push(`> 🔧 ${tools.join("、")}`);
    }
    const text = body.join("\n\n").trim();
    if (!text) {
      continue;
    }
    if (message.role === "notice") {
      parts.push(`_${text}_`);
    } else {
      parts.push(`## ${message.role === "user" ? "👤 User" : "🤖 Assistant"}\n\n${text}`);
    }
  }

  const header =
    `# ${transcript.title}\n\n` +
    `- 工具：${tool === "claude" ? "Claude Code" : "Codex"}\n` +
    (transcript.cwd ? `- 工作目錄：\`${transcript.cwd}\`\n` : "") +
    `- 原始檔：\`${file}\`\n`;
  return header + "\n---\n\n" + parts.join("\n\n---\n\n") + "\n";
}

function codexRootFromSessionFile(file: string): string | undefined {
  let current = path.dirname(file);
  while (true) {
    const name = path.basename(current);
    if (name === "sessions" || name === "archived_sessions") {
      return path.dirname(current);
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}
