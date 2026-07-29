import { createHash } from "crypto";
import { PATTERNS, SecretPattern } from "./secretScan";

export interface Redaction {
  placeholder: string;
  /** 被取代掉的原文，供本機還原使用；絕不進備份庫。 */
  secret: string;
  kind: string;
  /** 1-based，指原文中的行號。 */
  line: number;
}

export interface RedactResult {
  text: string;
  redactions: Redaction[];
}

/**
 * placeholder 必須是「原文的純函式」。
 *
 * 用流水號（<OPENAI_SECRET_01>）會讓兩台電腦依各自的掃描順序編出不同的號碼，
 * 同一段對話遮出來的位元組就不一樣；備份庫是 content-addressed 又靠逐行比對合併，
 * 結果是每個含金鑰的 session 都變成永久假衝突。內容衍生的標籤則到處都一樣。
 *
 * 刻意不加 salt：加了就得把 salt 也放進備份庫（否則跨機對不上），等於沒加。
 * 這裡遮的是 32 字元以上的高熵憑證，對雜湊做暴力還原不可行。
 */
export function placeholderFor(slug: string, secret: string): string {
  const digest = createHash("sha256").update(secret, "utf8").digest("hex");
  return `<SECRET:${slug}:${digest.slice(0, 8)}>`;
}

interface Span {
  start: number;
  end: number;
  pattern: SecretPattern;
}

/**
 * 遮蔽文字中所有命中的憑證。
 *
 * 對 JSONL 直接做字串取代是安全的：憑證本身都是英數與 -._ 這類不需 JSON 逃脫的字元，
 * placeholder 也不含 " 或反斜線，所以取代前後每一行都仍是合法 JSON，不需要重新編碼。
 */
export function redactText(
  text: string,
  patterns: readonly SecretPattern[] = PATTERNS
): RedactResult {
  const spans: Span[] = [];
  for (const pattern of patterns) {
    const re = new RegExp(pattern.re.source, "g");
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
      if (match[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const group = pattern.group;
      if (group !== undefined) {
        const value = match[group];
        // 整段沒對上就跳過，不要退回去遮整個 match（會連主機名一起吃掉）。
        if (!value) {
          continue;
        }
        const offset = match[0].indexOf(value);
        if (offset < 0) {
          continue;
        }
        spans.push({
          start: match.index + offset,
          end: match.index + offset + value.length,
          pattern,
        });
      } else {
        spans.push({ start: match.index, end: match.index + match[0].length, pattern });
      }
    }
  }
  if (!spans.length) {
    return { text, redactions: [] };
  }

  // 規則之間可能重疊（例如 sk-proj- 與舊版 sk- 規則）：長的優先，重疊的丟掉，
  // 否則巢狀取代會產生對不回去的殘骸。
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Span[] = [];
  for (const span of spans) {
    const previous = kept[kept.length - 1];
    if (previous && span.start < previous.end) {
      continue;
    }
    kept.push(span);
  }

  const redactions: Redaction[] = [];
  const seen = new Set<string>();
  let out = "";
  let cursor = 0;
  let line = 1;
  for (const span of kept) {
    const before = text.slice(cursor, span.start);
    line += countNewlines(before);
    const secret = text.slice(span.start, span.end);
    const placeholder = placeholderFor(span.pattern.slug, secret);
    out += before + placeholder;
    cursor = span.end;
    // 同一把金鑰在檔案裡出現很多次是常態，只記一次。
    if (!seen.has(placeholder)) {
      seen.add(placeholder);
      redactions.push({ placeholder, secret, kind: span.pattern.kind, line });
    }
  }
  out += text.slice(cursor);
  return { text: out, redactions };
}

/** 把 placeholder 換回原文；遮蔽是純字串取代，所以還原是精確的逆運算。 */
export function restoreText(
  text: string,
  redactions: readonly Pick<Redaction, "placeholder" | "secret">[]
): { text: string; restored: number } {
  let out = text;
  let restored = 0;
  for (const entry of redactions) {
    const parts = out.split(entry.placeholder);
    if (parts.length > 1) {
      restored += parts.length - 1;
      out = parts.join(entry.secret);
    }
  }
  return { text: out, restored };
}

function countNewlines(value: string): number {
  let count = 0;
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) === 10) {
      count++;
    }
  }
  return count;
}
