import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { PATTERNS, scanFiles } from "./secretScan";

it("scans session files larger than the former 5 MB cutoff", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "secret-scan-test-"));
  const file = path.join(root, "large.jsonl");
  try {
    const harmless = `${"x".repeat(1023)}\n`.repeat(6 * 1024);
    await fs.promises.writeFile(file, harmless + "sk-proj-123456789012345678901234567890\n");
    const findings = await scanFiles(root, ["large.jsonl"]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, "OpenAI API key");
    assert.equal(findings[0].line, 6145);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

it("reports the matched text with surrounding context", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "secret-excerpt-test-"));
  const file = path.join(root, "one.jsonl");
  try {
    const key = "sk-ant-" + "a".repeat(20);
    // 前後刻意超過 120 字元的截斷範圍，確認兩側都會加上省略號。
    // 用非英數字元當填充，否則會被 key 的字元集吃進命中範圍。
    const pad = "。".repeat(200);
    await fs.promises.writeFile(file, pad + key + pad + "\n");
    const [finding] = await scanFiles(root, ["one.jsonl"]);
    assert.equal(finding.match, key);
    assert.ok(finding.before.startsWith("…"), finding.before.slice(0, 5));
    assert.ok(finding.after.endsWith("…"), finding.after.slice(-5));
    // 命中處兩側各留 120 字元，加上省略號共 121。
    assert.equal(finding.before.length, 121);
    assert.equal(finding.after.length, 121);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

describe("PATTERNS", () => {
  it("uses no global flags", () => {
    // scanFiles 逐行重複用同一個 RegExp；帶 g 的話 lastIndex 會留在上一行，
    // 之後的行就會被跳過，掃描變成時有時無。
    for (const pattern of PATTERNS) {
      assert.equal(pattern.re.global, false, `global flag on ${pattern.kind}`);
    }
  });

  it("matches the credential formats it claims to", () => {
    const samples: [string, string][] = [
      ["sk-ant-" + "a".repeat(20), "Anthropic API key"],
      ["sk-proj-" + "a".repeat(24), "OpenAI API key"],
      ["ghp_" + "a".repeat(36), "GitHub token"],
      ["glpat-" + "a".repeat(20), "GitLab token"],
      ["AKIA" + "A".repeat(16), "AWS access key"],
      ["xoxb-" + "1".repeat(12), "Slack token"],
      ["AIza" + "a".repeat(35), "Google API key"],
      ["sk_live_" + "a".repeat(20), "Stripe key"],
      ["npm_" + "a".repeat(36), "npm token"],
      ["hf_" + "a".repeat(34), "Hugging Face token"],
      ["gsk_" + "a".repeat(40), "Groq API key"],
      ["ntn_" + "a".repeat(40), "Notion token"],
      ["eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.dBjftJeZ4CVP", "JWT"],
      ["postgres://user:hunter2hunter2@db.example.com:5432/app", "Connection string password"],
    ];
    for (const [sample, kind] of samples) {
      const matched = PATTERNS.filter((pattern) => pattern.re.test(sample));
      assert.ok(matched.length, `no match for ${kind}`);
      assert.ok(
        matched.some((pattern) => pattern.kind === kind),
        `${kind} matched ${matched.map((pattern) => pattern.kind).join(", ")}`
      );
    }
  });

  it("leaves ordinary high-entropy strings alone", () => {
    for (const sample of [
      "a".repeat(64), // 檔案 sha
      "3f2b1c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d", // UUID
      "https://example.com/build/9f8e7d6c5b4a3210",
    ]) {
      const matched = PATTERNS.filter((pattern) => pattern.re.test(sample));
      assert.deepEqual(matched.map((pattern) => pattern.kind), [], sample);
    }
  });
});
