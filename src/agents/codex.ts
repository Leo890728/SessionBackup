/** Codex 的 session 列舉、thread 分組與對話解析。 */

import * as fs from "fs";
import * as path from "path";

import { readCodexSessionIndex } from "./codexIndex";
import {
  codexMetaCwd,
  codexParentThreadId,
  codexSessionMeta,
  codexSubagentName,
  codexThreadId,
} from "./codexMeta";
import { cleanTitle, fmt, readFirstLines, titleCache } from "./sessionFile";
import { extractUserContext, toolDetail, userMessage } from "./transcriptText";
import type {
  CodexFile,
  CodexThreadGroup,
  ParsedTranscript,
  SessionInfo,
  TranscriptBlock,
  TranscriptMessage,
} from "./types";

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

export async function parseCodexTranscript(
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
