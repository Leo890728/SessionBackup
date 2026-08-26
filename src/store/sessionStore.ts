import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { readCodexSessionIndex } from "../agents/codexIndex";
import {
  codexMetaCwd,
  codexOwnId,
  codexParentThreadId,
  codexSessionMeta,
  codexSubagentName,
  codexThreadId,
} from "../agents/codexMeta";
import { BackupConfig, SourceConfig } from "../config";
import { SelectionSet } from "./selection";
import { Tool } from "../agents/types";

export const STORE_FORMAT_VERSION = 2;

/**
 * 檔案在這段時間內有寫入就視為使用中，不覆寫也不改寫。
 * rollout/session JSONL 是 append-only 的，agent 還在寫的時候動它會壞資料。
 */
export const ACTIVE_WINDOW_MS = 2 * 60 * 1000;

export interface ProjectRef {
  id: string;
  displayName: string;
  gitRemoteHash?: string;
  workspaceRelativePath?: string;
}

export interface LocalSession {
  tool: Tool;
  id: string;
  file: string;
  relativePath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  /**
   * 略過本機連線紀錄之後的內容雜湊，「這段對話有沒有變」一律看它。
   * hash 仍是原始位元組的雜湊，store 以它定址，不能混用。
   */
  contentHash?: string;
  title?: string;
  titleUpdatedAt?: string;
  project?: ProjectRef;
  /** Claude 的 projects/<dir> bucket 名稱，供專案層級的選取規則比對。 */
  claudeProjectDir?: string;
  /**
   * Codex 子代理檔的身分。`id` 是所屬 thread（子代理檔為父 thread），這三個
   * 欄位才分得出同一個 thread 底下的各個檔案，供變動清單收合成樹。
   */
  ownId?: string;
  parentThreadId?: string;
  subagent?: string;
}

export interface ManifestSession {
  tool: Tool;
  id: string;
  relativePath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  /** 見 LocalSession.contentHash。舊 manifest 沒有這個欄位，比對時退回用 hash。 */
  contentHash?: string;
  title?: string;
  titleUpdatedAt?: string;
  project?: ProjectRef;
}

export interface MachineManifest {
  formatVersion: number;
  machineId: string;
  updatedAt: string;
  sessions: ManifestSession[];
}

export type MergeRelation = "same" | "remote-newer" | "local-newer" | "conflict";

/**
 * mtimeMs/size 只是來源檔案的觀察值，不是 revision 的身分。
 * Claude 載入舊對話時可能原封不動重寫檔案；內容與 manifest 中繼資料都相同時，
 * 沿用舊紀錄，避免把單純推進的檔案時間誤當成一次備份變更。
 */
function sameManifestEntryIgnoringFileStats(
  previous: ManifestSession,
  current: ManifestSession
): boolean {
  return (
    previous.tool === current.tool &&
    previous.id === current.id &&
    previous.relativePath === current.relativePath &&
    previous.hash === current.hash &&
    previous.contentHash === current.contentHash &&
    previous.title === current.title &&
    previous.titleUpdatedAt === current.titleUpdatedAt &&
    JSON.stringify(previous.project) === JSON.stringify(current.project)
  );
}

/**
 * 對話內容與 manifest 中繼資料都沒變（差別只在被濾掉的本機連線紀錄）。
 *
 * 舊 manifest 沒有 contentHash，這時改成拿已經備份好的 revision 現算一次：
 * 升級之前就被點開過的對話才不用再多備份一輪。
 */
async function sameConversation(
  repoPath: string,
  previous: ManifestSession,
  session: LocalSession
): Promise<boolean> {
  if (
    previous.title !== session.title ||
    previous.titleUpdatedAt !== session.titleUpdatedAt ||
    JSON.stringify(previous.project) !== JSON.stringify(session.project)
  ) {
    return false;
  }
  if (previous.contentHash !== undefined) {
    return previous.contentHash === session.contentHash;
  }
  const revision = path.join(
    repoPath,
    ...revisionRelativePath(previous.tool, previous.id, previous.hash).split("/")
  );
  try {
    return (await sessionContentHash(revision)) === session.contentHash;
  } catch {
    return false;
  }
}

const SESSION_ROOTS: Record<Tool, string[]> = {
  claude: ["projects", "sessions"],
  codex: ["sessions", "archived_sessions"],
};

export function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+$/, "_");
  return cleaned.slice(0, 160) || "unknown";
}

/**
 * sessionBackup.machineId 留空時使用的自動值，由 extension 啟動時同步注入
 * （deriveMachineId 是純計算，不需等 I/O，所以不會有備份搶先跑到 fallback 的競態）。
 */
let autoMachineId: string | undefined;

export function setAutoMachineId(machineId: string): void {
  autoMachineId = machineId || undefined;
}

export function machineIdFromConfig(cfg: BackupConfig): string {
  return safeSegment(cfg.machineId || autoMachineId || os.hostname());
}

export function sourceForTool(cfg: BackupConfig, tool: Tool): SourceConfig | undefined {
  return cfg.sources.find((source) => source.name === tool);
}

export function revisionRelativePath(tool: Tool, id: string, hash: string): string {
  return path.posix.join("store", tool, safeSegment(id), `${hash}.jsonl`);
}

/** 此 session 的目前內容（hash）是否已存在於 store。已存在的內容備份時不會再寫入。 */
export function isRevisionStored(
  repoPath: string,
  session: { tool: Tool; id: string; hash: string }
): boolean {
  return fs.existsSync(
    path.join(
      repoPath,
      ...revisionRelativePath(session.tool, session.id, session.hash).split("/")
    )
  );
}

export interface PendingSession {
  session: LocalSession;
  /**
   * 上一輪已經備份出去、而且確定是目前檔案前綴的行數。
   * 只有這幾行之後的內容才是這次會新上傳的東西。
   */
  backedUpLines: number;
}

/**
 * 這次備份真的會把新內容寫進 store 的 sessions（以及各自已備份到第幾行）。
 *
 * 判斷條件與 storeSessions 一致：內容沒變（差別只在被濾掉的本機連線紀錄）就不算，
 * 不然光是點開一段舊對話就會被當成有新內容。金鑰掃描靠它決定要掃哪些檔案的哪一段。
 */
export async function pendingSessions(
  repoPath: string,
  machineId: string,
  sessions: readonly LocalSession[]
): Promise<PendingSession[]> {
  const manifestFile = path.join(
    repoPath,
    ...manifestRelativePath(machineId).split("/")
  );
  const previous = await readManifest(manifestFile);
  const previousByPath = new Map(
    (previous?.sessions ?? []).map((session) => [
      `${session.tool}:${session.relativePath}`,
      session,
    ])
  );
  const pending: PendingSession[] = [];
  for (const session of sessions) {
    const stored = previousByPath.get(`${session.tool}:${session.relativePath}`);
    if (stored && (await sameConversation(repoPath, stored, session))) {
      continue;
    }
    // 這份內容已經在 store 裡（例如另一台電腦先備份過同一段對話）：
    // 再備份一次不會多送出任何東西。
    if (isRevisionStored(repoPath, session)) {
      continue;
    }
    pending.push({
      session,
      backedUpLines: stored ? await backedUpLineCount(session, stored) : 0,
    });
  }
  return pending;
}

/**
 * 已備份的 revision 是目前檔案的位元組前綴時，回傳它涵蓋的完整行數。
 *
 * 直接拿 manifest 記的大小與雜湊比對檔案開頭，對不上（對話被改寫、或 manifest
 * 與檔案不同步）就回 0，整份重掃——寧可多問一次，也不能把沒備份過的內容當成看過了。
 */
async function backedUpLineCount(
  session: LocalSession,
  stored: ManifestSession
): Promise<number> {
  if (!stored.size || stored.size > session.size) {
    return 0;
  }
  const digest = createHash("sha256");
  let lines = 0;
  let read = 0;
  const input = fs.createReadStream(session.file, { start: 0, end: stored.size - 1 });
  try {
    for await (const chunk of input) {
      const buffer = chunk as Buffer;
      digest.update(buffer);
      read += buffer.length;
      for (let at = buffer.indexOf(10); at !== -1; at = buffer.indexOf(10, at + 1)) {
        lines++;
      }
    }
  } catch {
    return 0;
  } finally {
    input.destroy();
  }
  return read === stored.size && digest.digest("hex") === stored.hash ? lines : 0;
}

export function manifestRelativePath(machineId: string): string {
  return path.posix.join("machines", safeSegment(machineId), "manifest.json");
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

/**
 * Claude 在「開啟一段舊對話」時會往檔案尾巴補寫這幾種紀錄，實際觀察到的是
 * `{"type":"atis-latch",…}`、`{"type":"bridge-session","bridgeSessionId":"cse_…"}`
 * 與 `{"type":"mode","mode":"normal",…}`。它們是這個 client 的連線與模式狀態，
 * 不是對話內容，但足以讓檔案雜湊改變——不濾掉的話，光是點開一段對話就會讓它
 * 出現在「有變動的 sessions」並多備份一輪。
 *
 * 只收「純 client 狀態」。ai-title、last-prompt、queue-operation、file-history-*
 * 都帶著使用者看得到或由內容衍生的東西，寧可多備份一次也不能當成沒變。
 */
const CLAUDE_PLUMBING_TYPES = new Set(["atis-latch", "bridge-session", "mode"]);

const TYPE_PREFIX = '{"type":"';

function isPlumbingRecord(line: string): boolean {
  // 每分鐘要掃過全部 sessions，逐行 JSON.parse 太貴：這幾種紀錄都以 type 開頭，
  // 先用字串切出型別；沒對上但行內出現這些名稱時才真的 parse 確認。
  if (line.startsWith(TYPE_PREFIX)) {
    const end = line.indexOf('"', TYPE_PREFIX.length);
    if (end > 0) {
      return CLAUDE_PLUMBING_TYPES.has(line.slice(TYPE_PREFIX.length, end));
    }
  }
  if (![...CLAUDE_PLUMBING_TYPES].some((type) => line.includes(`"${type}"`))) {
    return false;
  }
  try {
    return CLAUDE_PLUMBING_TYPES.has(JSON.parse(line)?.type);
  } catch {
    return false;
  }
}

/**
 * 內容雜湊：略過本機連線紀錄，並把換行正規化成 \n。
 *
 * 刻意與 hash 分開而不是取代它：store 是以原始位元組的雜湊定址，
 * 複製 revision 時還會重算驗證（copyVerifiedRevision），兩者混用會讓那道檢查永遠失敗。
 */
export async function sessionContentHash(file: string): Promise<string> {
  const digest = createHash("sha256");
  const input = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (isPlumbingRecord(line)) {
        continue;
      }
      digest.update(line + "\n");
    }
  } finally {
    input.destroy();
  }
  return digest.digest("hex");
}

// SHA-256 以 mtime+size 快取：狀態掃描每分鐘都會收集全部 sessions，
// 沒有快取的話等於每分鐘重算約 100MB 的雜湊。
const hashCache = new Map<
  string,
  { mtimeMs: number; size: number; hash: string; contentHash: string }
>();

export async function hashFileCached(
  file: string,
  stat: { mtimeMs: number; size: number }
): Promise<{ hash: string; contentHash: string }> {
  const cached = hashCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return { hash: cached.hash, contentHash: cached.contentHash };
  }
  const hash = await sha256File(file);
  const contentHash = await sessionContentHash(file);
  hashCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, hash, contentHash });
  return { hash, contentHash };
}

export function classifyJsonlText(localText: string, remoteText: string): MergeRelation {
  const local = jsonlRecords(localText);
  const remote = jsonlRecords(remoteText);
  if (sameRecords(local, remote)) {
    return "same";
  }
  if (isRecordPrefix(local, remote)) {
    return "remote-newer";
  }
  if (isRecordPrefix(remote, local)) {
    return "local-newer";
  }
  return "conflict";
}

export async function classifyJsonlFiles(
  localFile: string,
  remoteFile: string
): Promise<MergeRelation> {
  const [local, remote] = await Promise.all([
    fs.promises.readFile(localFile, "utf8"),
    fs.promises.readFile(remoteFile, "utf8"),
  ]);
  return classifyJsonlText(local, remote);
}

export async function collectLocalSessions(
  cfg: BackupConfig,
  resolveClaudeProject?: (
    cwd: string | undefined,
    claudeProjectDir: string
  ) => Promise<ProjectRef | undefined>,
  resolveCodexProject?: (cwd: string | undefined) => Promise<ProjectRef | undefined>
): Promise<LocalSession[]> {
  const sessions: LocalSession[] = [];
  const selection = new SelectionSet(cfg.trackedSessions ?? []);
  if (selection.isEmpty) {
    return sessions;
  }
  for (const tool of ["claude", "codex"] as const) {
    const source = sourceForTool(cfg, tool);
    if (!source || !fs.existsSync(source.path)) {
      continue;
    }
    const codexIndex =
      tool === "codex"
        ? await readCodexSessionIndex(path.join(source.path, "session_index.jsonl"))
        : undefined;
    for (const rootName of SESSION_ROOTS[tool]) {
      const root = path.join(source.path, rootName);
      await walkJsonl(root, async (file) => {
        const stat = await fs.promises.stat(file);
        const metadata = await sessionMetadata(tool, file);
        const sourceRelativePath = path.relative(source.path, file).replace(/\\/g, "/");
        const rootRelativeParts = path.relative(root, file).split(path.sep);
        const projectDir =
          rootName === "projects" && rootRelativeParts.length > 1
            ? rootRelativeParts[0]
            : undefined;
        // 白名單：沒被選取的 session 直接跳過，連 hash 都不用算。
        if (
          !selection.includes({
            tool,
            id: metadata.id,
            claudeProjectDir: tool === "claude" ? projectDir : undefined,
          })
        ) {
          return;
        }
        const relativePath =
          tool === "claude" && projectDir
            ? path.posix.join("projects", path.basename(file))
            : sourceRelativePath;
        const project =
          tool === "claude" && projectDir && resolveClaudeProject
            ? await resolveClaudeProject(metadata.cwd, projectDir)
            : tool === "codex" && resolveCodexProject
              ? await resolveCodexProject(metadata.cwd)
              : undefined;
        // 子代理檔的 session_id 指向父 thread，拿它去查索引會讓同一個 thread 底下
        // 的每個檔案都掛上主 thread 的標題，變動清單就會出現一排同名項目。
        const codexTitle = metadata.parentThreadId ? undefined : codexIndex?.get(metadata.id);
        sessions.push({
          tool,
          id: metadata.id,
          file,
          relativePath,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          ...(await hashFileCached(file, stat)),
          ...(codexTitle
            ? { title: codexTitle.thread_name, titleUpdatedAt: codexTitle.updated_at }
            : {}),
          project,
          claudeProjectDir: tool === "claude" ? projectDir : undefined,
          ownId: metadata.ownId,
          parentThreadId: metadata.parentThreadId,
          subagent: metadata.subagent,
        });
      });
    }
  }
  return sessions.sort((a, b) => a.tool.localeCompare(b.tool) || a.id.localeCompare(b.id));
}

export async function storeSessions(
  repoPath: string,
  machineId: string,
  sessions: LocalSession[],
  maxBytes: number,
  /**
   * 這次不上傳新內容、但要原封保留上一輪 manifest 紀錄的 session 檔案路徑
   * （例如新內容掃到疑似金鑰而被跳過）。直接把它們從 sessions 拿掉的話，
   * manifest 會連同以前備份過的那份紀錄一起消失。
   */
  held: ReadonlySet<string> = new Set()
): Promise<{
  copied: string[];
  skipped: LocalSession[];
  deferred: LocalSession[];
  manifest: MachineManifest;
}> {
  const copied: string[] = [];
  const skipped: LocalSession[] = [];
  const deferred: LocalSession[] = [];
  const manifestSessions: ManifestSession[] = [];

  const manifestRel = manifestRelativePath(machineId);
  const manifestFile = path.join(repoPath, ...manifestRel.split("/"));
  const previous = await readManifest(manifestFile);
  const previousByPath = new Map(
    (previous?.sessions ?? []).map((session) => [
      `${session.tool}:${session.relativePath}`,
      session,
    ])
  );

  const formatFile = path.join(repoPath, "format.json");
  const formatContent = JSON.stringify(
    { format: "ai-session-store", version: STORE_FORMAT_VERSION },
    null,
    2
  ) + "\n";
  if ((await readText(formatFile)) !== formatContent) {
    await fs.promises.writeFile(formatFile, formatContent, "utf8");
    copied.push("format.json");
  }

  for (const session of sessions) {
    if (session.size > maxBytes) {
      skipped.push(session);
      continue;
    }
    const stored = previousByPath.get(`${session.tool}:${session.relativePath}`);
    if (held.has(session.file)) {
      if (stored) {
        manifestSessions.push(stored);
      }
      continue;
    }
    // 檔案變了但對話沒變（Claude 開啟舊對話時補寫的連線紀錄）：沿用上一輪的 revision，
    // 不然每點開一次舊對話就會多備份一輪一模一樣的內容。
    if (stored && (await sameConversation(repoPath, stored, session))) {
      // 補上 contentHash，下一輪就不必再為了這筆重讀 revision。
      manifestSessions.push(
        stored.contentHash ? stored : { ...stored, contentHash: session.contentHash }
      );
      continue;
    }
    const rel = revisionRelativePath(session.tool, session.id, session.hash);
    const destination = path.join(repoPath, ...rel.split("/"));
    if (!fs.existsSync(destination)) {
      if (!(await copyVerifiedRevision(session.file, destination, session.hash))) {
        // 檔案在算 hash 之後、複製之前又被寫入。沿用上一輪的 manifest 紀錄，
        // manifest 才不會指向一份內容與檔名對不上的 revision；下一輪備份會重收。
        deferred.push(session);
        const stale = previousByPath.get(`${session.tool}:${session.relativePath}`);
        if (stale) {
          manifestSessions.push(stale);
        }
        continue;
      }
      copied.push(rel);
    }
    const manifestSession: ManifestSession = {
      tool: session.tool,
      id: session.id,
      relativePath: session.relativePath,
      mtimeMs: session.mtimeMs,
      size: session.size,
      hash: session.hash,
      ...(session.contentHash ? { contentHash: session.contentHash } : {}),
      ...(session.title
        ? { title: session.title, titleUpdatedAt: session.titleUpdatedAt }
        : {}),
      project: session.project,
    };
    const previousSession = previousByPath.get(`${session.tool}:${session.relativePath}`);
    manifestSessions.push(
      previousSession && sameManifestEntryIgnoringFileStats(previousSession, manifestSession)
        ? previousSession
        : manifestSession
    );
  }

  let manifest: MachineManifest = {
    formatVersion: STORE_FORMAT_VERSION,
    machineId,
    updatedAt: new Date().toISOString(),
    sessions: manifestSessions,
  };
  await fs.promises.mkdir(path.dirname(manifestFile), { recursive: true });
  if (
    previous?.formatVersion === manifest.formatVersion &&
    previous.machineId === manifest.machineId &&
    JSON.stringify(previous.sessions) === JSON.stringify(manifest.sessions)
  ) {
    manifest = previous;
  } else {
    await fs.promises.writeFile(manifestFile, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    copied.push(manifestRel);
  }
  return { copied, skipped, deferred, manifest };
}

/**
 * hash 是收集階段算的，session 還在被寫入時（Claude 正在回話）複製到的內容
 * 會與 hash 對不上，store 的 content-addressed 前提就破了。
 * 先寫進暫存檔驗算，對得上才 rename 到正式位置。
 */
async function copyVerifiedRevision(
  source: string,
  destination: string,
  expectedHash: string
): Promise<boolean> {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const temp = `${destination}.${process.pid}.tmp`;
  try {
    await fs.promises.copyFile(source, temp);
    if ((await sha256File(temp)) !== expectedHash) {
      return false;
    }
    await fs.promises.rename(temp, destination);
    return true;
  } catch {
    // 另一個備份同時寫入了同一個 revision：內容相同，視為已存在。
    return fs.existsSync(destination);
  } finally {
    await fs.promises.rm(temp, { force: true }).catch(() => undefined);
  }
}

export async function readMachineManifests(repoPath: string): Promise<MachineManifest[]> {
  const root = path.join(repoPath, "machines");
  let machines: fs.Dirent[];
  try {
    machines = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const manifests: MachineManifest[] = [];
  for (const machine of machines) {
    if (!machine.isDirectory()) {
      continue;
    }
    try {
      const raw = await fs.promises.readFile(path.join(root, machine.name, "manifest.json"), "utf8");
      const parsed = JSON.parse(raw) as MachineManifest;
      if (
        parsed.formatVersion === STORE_FORMAT_VERSION &&
        typeof parsed.machineId === "string" &&
        Array.isArray(parsed.sessions)
      ) {
        manifests.push(parsed);
      }
    } catch {
      // Ignore incomplete or foreign manifests; the content-addressed revisions remain intact.
    }
  }
  return manifests;
}

export function resolveLocalTarget(sourceRoot: string, relativePath: string): string | undefined {
  if (!relativePath || path.isAbsolute(relativePath)) {
    return undefined;
  }
  const root = path.resolve(sourceRoot);
  const target = path.resolve(root, ...relativePath.replace(/\\/g, "/").split("/"));
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return target.startsWith(prefix) ? target : undefined;
}

/**
 * 比對時忽略 codex 的機器本地欄位：session_meta.cwd 與 turn_context 的
 * cwd/workspace_roots 在不同電腦本來就不同（C:\ vs D:\），
 * 不正規化的話跨機同步會把只差路徑的檔案誤判成分叉。
 */
function canonicalRecord(record: string): string {
  try {
    const value = JSON.parse(record);
    if (
      (value?.type === "session_meta" || value?.type === "turn_context") &&
      value.payload &&
      typeof value.payload === "object"
    ) {
      const payload: Record<string, unknown> = { ...value.payload };
      delete payload.cwd;
      if (value.type === "turn_context") {
        delete payload.workspace_roots;
      }
      if (value.type === "session_meta") {
        // 匯入時可能補上預設 model_provider（舊格式修復），比對時一併忽略。
        delete payload.model_provider;
      }
      return JSON.stringify({ ...value, payload });
    }
  } catch {
    /* 非 JSON 行照原樣比對 */
  }
  return record;
}

function jsonlRecords(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    // 本機連線紀錄不算對話的一部分：留著會讓「只是被點開過」的檔案看起來比遠端新。
    .filter((line) => !isPlumbingRecord(line))
    .map(canonicalRecord);
}

function sameRecords(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((record, index) => record === b[index]);
}

function isRecordPrefix(shorter: string[], longer: string[]): boolean {
  return (
    shorter.length < longer.length &&
    shorter.every((record, index) => record === longer[index])
  );
}

async function walkJsonl(root: string, visit: (file: string) => Promise<void>): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walkJsonl(full, visit);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      await visit(full);
    }
  }
}

interface SessionMetadata {
  id: string;
  cwd?: string;
  ownId?: string;
  parentThreadId?: string;
  subagent?: string;
}

async function sessionMetadata(tool: Tool, file: string): Promise<SessionMetadata> {
  const fallback = path.basename(file, ".jsonl");
  let id = fallback;
  let cwd: string | undefined;
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(file, "r");
    const buffer = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/).slice(0, 200);
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      let value: any;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (tool === "claude") {
        if (!cwd && typeof value.cwd === "string") {
          cwd = value.cwd;
        }
        if (typeof value.sessionId === "string") {
          id = value.sessionId;
        }
        if (cwd && id !== fallback) {
          return { id, cwd };
        }
      }
      if (tool === "codex") {
        const meta = codexSessionMeta(value);
        const threadId = meta && codexThreadId(meta);
        if (meta && threadId !== undefined) {
          return {
            id: threadId,
            cwd: codexMetaCwd(meta),
            ownId: codexOwnId(meta),
            parentThreadId: codexParentThreadId(meta),
            subagent: codexSubagentName(meta.source),
          };
        }
      }
    }
  } catch {
    return { id, cwd };
  } finally {
    await handle?.close();
  }
  return { id, cwd };
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

export async function readManifest(file: string): Promise<MachineManifest | undefined> {
  try {
    return JSON.parse(await fs.promises.readFile(file, "utf8")) as MachineManifest;
  } catch {
    return undefined;
  }
}
