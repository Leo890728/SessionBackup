import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { placeholderFor } from "./redact";
import { redactSessions, restoreSessionFile, SecretVault } from "./sessionRedact";
import { LocalSession, sha256File } from "./sessionStore";

const GITHUB = "ghp_" + "a".repeat(36);
const ACTIVE_WINDOW_MS = 2 * 60 * 1000;

let dir: string;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-redact-"));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

let counter = 0;

async function makeSession(content: string): Promise<LocalSession> {
  const file = path.join(dir, `session-${counter++}.jsonl`);
  await fs.promises.writeFile(file, content, "utf8");
  const stat = await fs.promises.stat(file);
  return {
    tool: "codex",
    id: path.basename(file, ".jsonl"),
    file,
    relativePath: `sessions/${path.basename(file)}`,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    hash: await sha256File(file),
  };
}

/** 檔案 mtime 已經超出使用中視窗，可以安全改寫。 */
function settled(session: LocalSession): number {
  return session.mtimeMs + ACTIVE_WINDOW_MS + 1000;
}

describe("redactSessions", () => {
  it("rewrites the file in place and refreshes hash/size/mtime", async () => {
    const vault = new SecretVault(path.join(dir, "vault-a"));
    const line = JSON.stringify({ type: "message", text: `key ${GITHUB}` });
    const session = await makeSession(line + "\n");

    const outcome = await redactSessions([session], vault, settled(session));

    assert.equal(outcome.redacted.length, 1);
    assert.equal(outcome.count, 1);
    const onDisk = await fs.promises.readFile(session.file, "utf8");
    assert.ok(!onDisk.includes(GITHUB), "原文仍留在檔案裡");
    assert.ok(onDisk.includes(placeholderFor("github", GITHUB)));
    // 每一行仍必須是合法 JSON，否則整個 session 都讀不回來。
    JSON.parse(onDisk.trim());

    const updated = outcome.redacted[0];
    assert.equal(updated.hash, await sha256File(session.file));
    assert.equal(updated.size, (await fs.promises.stat(session.file)).size);
    assert.notEqual(updated.hash, session.hash);
  });

  it("stores the original in the vault and restores it exactly", async () => {
    const vault = new SecretVault(path.join(dir, "vault-b"));
    const original = `a ${GITHUB} b\n`;
    const session = await makeSession(original);

    await redactSessions([session], vault, settled(session));
    const entries = await vault.forFile(session.file);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].secret, GITHUB);

    const restored = await restoreSessionFile(session.file, vault);
    assert.equal(restored, 1);
    assert.equal(await fs.promises.readFile(session.file, "utf8"), original);
  });

  it("defers a file that was written within the active window", async () => {
    // agent 還在 append 的 rollout 檔中途重寫會壞資料。
    const vault = new SecretVault(path.join(dir, "vault-c"));
    const session = await makeSession(`key ${GITHUB}\n`);

    const outcome = await redactSessions([session], vault, session.mtimeMs + 1000);

    assert.deepEqual(outcome.redacted, []);
    assert.equal(outcome.skipped[0].reason, "active");
    assert.ok((await fs.promises.readFile(session.file, "utf8")).includes(GITHUB));
    assert.deepEqual(await vault.all(), []);
  });

  it("defers when the file changed after it was collected", async () => {
    const vault = new SecretVault(path.join(dir, "vault-d"));
    const session = await makeSession(`key ${GITHUB}\n`);
    await fs.promises.appendFile(session.file, "later line\n", "utf8");

    const outcome = await redactSessions([session], vault, settled(session));

    assert.equal(outcome.skipped[0].reason, "changed");
    assert.ok((await fs.promises.readFile(session.file, "utf8")).includes(GITHUB));
  });

  it("reports no-match without touching the file", async () => {
    const vault = new SecretVault(path.join(dir, "vault-e"));
    const session = await makeSession("nothing sensitive here\n");

    const outcome = await redactSessions([session], vault, settled(session));

    assert.equal(outcome.skipped[0].reason, "no-match");
    assert.equal(outcome.count, 0);
  });

  it("leaves no temp file behind", async () => {
    const vault = new SecretVault(path.join(dir, "vault-f"));
    const session = await makeSession(`key ${GITHUB}\n`);

    await redactSessions([session], vault, settled(session));

    const leftovers = (await fs.promises.readdir(dir)).filter((name) =>
      name.endsWith(".sb-redact.tmp")
    );
    assert.deepEqual(leftovers, []);
  });

  it("is idempotent — a second pass finds nothing to redact", async () => {
    const vault = new SecretVault(path.join(dir, "vault-g"));
    const session = await makeSession(`key ${GITHUB}\n`);

    const first = await redactSessions([session], vault, settled(session));
    const redacted = first.redacted[0];
    const second = await redactSessions([redacted], vault, settled(redacted));

    assert.equal(second.skipped[0].reason, "no-match");
    assert.equal(second.count, 0);
  });
});

describe("SecretVault", () => {
  it("persists across instances and dedupes the same placeholder", async () => {
    const storage = path.join(dir, "vault-h");
    const first = new SecretVault(storage);
    const entry = { placeholder: "<SECRET:github:deadbeef>", secret: GITHUB, kind: "GitHub token", line: 1 };
    await first.add("C:/x.jsonl", [entry]);
    await first.add("C:/x.jsonl", [entry]);

    const second = new SecretVault(storage);
    assert.equal((await second.all()).length, 1);
  });

  it("removes every entry for a file", async () => {
    const vault = new SecretVault(path.join(dir, "vault-i"));
    await vault.add("C:/y.jsonl", [
      { placeholder: "<SECRET:github:aaaaaaaa>", secret: GITHUB, kind: "GitHub token", line: 1 },
    ]);
    await vault.removeFile("c:/Y.jsonl");
    assert.deepEqual(await vault.all(), []);
  });
});
