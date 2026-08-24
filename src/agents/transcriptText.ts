/** 兩種工具共用的對話文字處理（工具摘要、IDE 上下文、中斷標記）。 */

import type { TranscriptMessage } from "./types";

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

export function toolDetail(input: unknown): string | undefined {
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

/** 使用者訊息＝IDE 注入的上下文卡片，後面接真正打出來的問題。 */
export function userMessage(
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
