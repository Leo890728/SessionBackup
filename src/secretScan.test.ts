import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { scanFiles } from "./secretScan";

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
