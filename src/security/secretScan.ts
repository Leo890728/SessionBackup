import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

export interface SecretFinding {
  rel: string;
  kind: string;
  line: number;
  /** 命中的字串本身；顯示給使用者時預設遮蔽。 */
  match: string;
  /** 命中處之前的內容（往前最多 CONTEXT_CHARS 字元）。 */
  before: string;
  /** 命中處之後的內容（往後最多 CONTEXT_CHARS 字元）。 */
  after: string;
}

/**
 * 命中處前後各保留多少字元。
 * session 檔是 JSONL，一行就是一整則訊息（可能好幾萬字），
 * 整行丟給使用者看沒有意義，只截命中處附近足夠判斷誤判的範圍。
 */
const CONTEXT_CHARS = 120;

function excerpt(
  text: string,
  index: number,
  match: string
): Pick<SecretFinding, "match" | "before" | "after"> {
  const start = Math.max(0, index - CONTEXT_CHARS);
  const end = Math.min(text.length, index + match.length + CONTEXT_CHARS);
  return {
    match,
    before: (start > 0 ? "…" : "") + text.slice(start, index),
    after: text.slice(index + match.length, end) + (end < text.length ? "…" : ""),
  };
}

export interface SecretPattern {
  /** 給使用者看的名稱。 */
  kind: string;
  /** 不能帶 g 旗標：scanFiles 逐行共用同一個 RegExp，lastIndex 會讓比對跳號。 */
  re: RegExp;
}

/**
 * 一律使用「前綴錨定」的高精確度規則，不做熵值啟發式。
 *
 * 命中會擋下整次備份並要使用者做決定，誤判多了就會有人乾脆把掃描關掉；
 * 而 AI 對話裡高熵字串（檔案 sha、base64、UUID、build hash）滿地都是。
 * 寧可漏抓自訂格式，也不能錯抓。
 */
export const PATTERNS: SecretPattern[] = [
  { kind: "Anthropic API key", re: /sk-ant-[A-Za-z0-9_-]{16,}/ },
  {
    kind: "OpenAI API key",
    re: /sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/,
  },
  // 舊版 OpenAI key：sk- 之後直接接英數，不會和上面帶連字號的前綴重疊。
  { kind: "OpenAI API key (legacy)", re: /\bsk-[A-Za-z0-9]{32,}\b/ },
  {
    kind: "GitHub token",
    re: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}/,
  },
  { kind: "GitLab token", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { kind: "AWS access key", re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/ },
  { kind: "Slack token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  {
    kind: "Slack webhook",
    re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_\/]{20,}/,
  },
  { kind: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  {
    kind: "Stripe key",
    re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  },
  { kind: "npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { kind: "PyPI token", re: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}\b/ },
  { kind: "Hugging Face token", re: /\bhf_[A-Za-z0-9]{34,}\b/ },
  { kind: "Groq API key", re: /\bgsk_[A-Za-z0-9]{40,}\b/ },
  { kind: "Notion token", re: /\bntn_[A-Za-z0-9]{40,}\b/ },
  {
    kind: "SendGrid API key",
    re: /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{40,}\b/,
  },
  {
    kind: "JWT",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    kind: "Connection string password",
    re: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@\/]+:([^\s:@\/]+)@/,
  },
  {
    kind: "Private key",
    re: /-----BEGIN (?:RSA|EC|DSA|OPENSSH|PGP) PRIVATE KEY-----/,
  },
];

/** 掃描指定相對路徑清單（root 之下）的文字檔，回報疑似金鑰。 */
export async function scanFiles(
  root: string,
  rels: string[]
): Promise<SecretFinding[]> {
  const findings: SecretFinding[] = [];
  for (const rel of rels) {
    const full = path.join(root, rel);
    let input: fs.ReadStream | undefined;
    try {
      input = fs.createReadStream(full, { encoding: "utf8" });
      const lines = readline.createInterface({ input, crlfDelay: Infinity });
      const found = new Set<string>();
      let line = 0;
      for await (const text of lines) {
        line++;
        for (const p of PATTERNS) {
          if (found.has(p.kind)) {
            continue;
          }
          // 用 exec 而不是 test：要拿到命中的位置與內容才能給出可判讀的片段。
          // PATTERNS 保證沒有 g 旗標，所以 lastIndex 不會殘留。
          const m = p.re.exec(text);
          if (m) {
            findings.push({ rel, kind: p.kind, line, ...excerpt(text, m.index, m[0]) });
            found.add(p.kind);
          }
        }
      }
    } catch {
      continue;
    } finally {
      input?.destroy();
    }
  }
  return findings;
}
