/** Claude Code 的 session 列舉、中繼資料與對話解析。 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

import { sessionProjectIdentity } from "./grouping";
import { cleanTitle, fmt, readFirstLines, titleCache } from "./sessionFile";
import {
  extractUserContext,
  interruptionNotice,
  toolDetail,
  userMessage,
} from "./transcriptText";
import type {
  ClaudeProject,
  ParsedTranscript,
  SessionInfo,
  TranscriptBlock,
  TranscriptMessage,
} from "./types";

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

export function parseClaudeTranscript(lines: any[]): ParsedTranscript {
  const messages: TranscriptMessage[] = [];
  let cwd: string | undefined;

  /**
   * 助理的連續紀錄併成一則，工具呼叫才會留在觸發它的那次回覆裡。
   * 使用者訊息不併：每一次送出都是獨立的一輪，併起來會讓中斷前後的兩句話黏成一段。
   */
  const appendAssistant = (
    block: TranscriptBlock,
    timestamp: string | undefined,
    sourceLine: number
  ) => {
    const last = messages[messages.length - 1];
    if (last?.role === "assistant") {
      last.blocks.push(block);
      return;
    }
    messages.push({ role: "assistant", blocks: [block], timestamp, sourceLine });
  };

  for (const [sourceLine, o] of lines.entries()) {
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
            sourceLine,
          });
        } else {
          const { contexts, rest } = extractUserContext(t);
          // 只有 IDE 上下文、沒有真正提問的訊息不顯示。
          if (rest) {
            messages.push({ ...userMessage(contexts, rest, o.timestamp), sourceLine });
          }
        }
      }
    } else if (o.type === "assistant" && o.message && Array.isArray(o.message.content)) {
      for (const c of o.message.content) {
        if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) {
          appendAssistant({ kind: "text", text: c.text }, o.timestamp, sourceLine);
        } else if (
          c?.type === "thinking" &&
          typeof c.thinking === "string" &&
          c.thinking.trim()
        ) {
          // thinking 的明文不一定會被寫進紀錄（只留加密的 signature），空的就跳過。
          appendAssistant({ kind: "thinking", text: c.thinking }, o.timestamp, sourceLine);
        } else if (c?.type === "tool_use" && c.name) {
          appendAssistant(
            { kind: "tool", name: c.name, detail: toolDetail(c.input) },
            o.timestamp,
            sourceLine
          );
        }
      }
    }
  }

  return { title: claudeAiTitle(lines) ?? "(無標題)", cwd, messages };
}
