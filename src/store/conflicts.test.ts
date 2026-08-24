import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { ConflictRecord, ConflictRegistry } from "./conflicts";

const record = (key: string, remoteHash: string): ConflictRecord => ({
  key,
  tool: "codex",
  id: "t1",
  relativePath: key.split(":")[1] ?? key,
  localFile: "C:\\s\\a.jsonl",
  localHash: "local",
  remoteHash,
  remoteMachine: "LAPTOP",
  detectedAt: "2026-07-15T00:00:00Z",
  displayName: "測試 session",
});

describe("ConflictRegistry", () => {
  it("replaceAll persists and remove clears a resolved conflict", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "conflicts-"));
    try {
      const registry = new ConflictRegistry(dir);
      await registry.replaceAll([
        record("codex:sessions/a.jsonl", "h1"),
        record("codex:sessions/b.jsonl", "h2"),
      ]);

      // 重新載入（模擬重啟）也讀得到
      const reloaded = new ConflictRegistry(dir);
      assert.equal((await reloaded.list()).length, 2);

      await reloaded.remove("codex:sessions/a.jsonl");
      assert.deepEqual(
        (await reloaded.list()).map((r) => r.key),
        ["codex:sessions/b.jsonl"]
      );

      // 下次同步 replaceAll 會清掉已消失的衝突
      await reloaded.replaceAll([]);
      assert.equal((await reloaded.list()).length, 0);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });
});
