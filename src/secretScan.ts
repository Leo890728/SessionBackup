import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

export interface SecretFinding {
  rel: string;
  kind: string;
  line: number;
}

const PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "Anthropic API key", re: /sk-ant-[A-Za-z0-9_-]{16,}/ },
  { kind: "OpenAI API key", re: /sk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,}/ },
  {
    kind: "GitHub token",
    re: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}/,
  },
  { kind: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "Slack token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { kind: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
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
          if (!found.has(p.kind) && p.re.test(text)) {
            findings.push({ rel, kind: p.kind, line });
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
