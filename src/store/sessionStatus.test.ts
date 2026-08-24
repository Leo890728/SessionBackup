import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildStatusLookup, resolveSessionStatus, sessionSyncStatus } from "./sessionStatus";
import { MachineManifest, sha256File } from "./sessionStore";

describe("sessionSyncStatus", () => {
  const manifest: MachineManifest = {
    formatVersion: 2,
    machineId: "A",
    updatedAt: "2026-07-14T00:00:00Z",
    sessions: [
      {
        tool: "claude",
        id: "s1",
        relativePath: "projects/s1.jsonl",
        mtimeMs: 100,
        size: 10,
        hash: "abc",
      },
    ],
  };
  const base = {
    tool: "claude" as const,
    id: "s1",
    relativePath: "projects/s1.jsonl",
    mtimeMs: 100,
    size: 10,
  };

  it("classifies each state", () => {
    const lookup = buildStatusLookup(manifest, ["tool:claude", "tool:codex"], 95);
    assert.equal(sessionSyncStatus(lookup, base), "synced");
    assert.equal(sessionSyncStatus(lookup, { ...base, mtimeMs: 200, size: 12 }), "modified");
    assert.equal(
      sessionSyncStatus(lookup, { ...base, id: "s2", relativePath: "projects/s2.jsonl" }),
      "unbacked"
    );
    assert.equal(
      sessionSyncStatus(lookup, { ...base, size: 96 * 1024 * 1024 }),
      "too-large"
    );
  });

  it("treats a missing manifest as unbacked", () => {
    const lookup = buildStatusLookup(undefined, ["tool:claude"], 95);
    assert.equal(sessionSyncStatus(lookup, base), "unbacked");
  });

  it("reports anything outside the selection as unselected", () => {
    assert.equal(
      sessionSyncStatus(buildStatusLookup(manifest, [], 95), base),
      "unselected"
    );
    // 選了整個工具，但這個 session 被單獨排除。
    const lookup = buildStatusLookup(manifest, ["tool:claude", "-session:claude:s1"], 95);
    assert.equal(sessionSyncStatus(lookup, base), "unselected");
    assert.equal(
      sessionSyncStatus(lookup, { ...base, id: "s2", relativePath: "projects/s2.jsonl" }),
      "unbacked"
    );
  });

  it("resolves the most specific rule first", () => {
    const lookup = buildStatusLookup(
      manifest,
      ["-claudeProject:C--proj", "session:claude:s1"],
      95
    );
    assert.equal(sessionSyncStatus(lookup, { ...base, claudeProjectDir: "C--proj" }), "synced");
    assert.equal(
      sessionSyncStatus(lookup, {
        ...base,
        id: "s2",
        relativePath: "projects/s2.jsonl",
        claudeProjectDir: "C--proj",
      }),
      "unselected"
    );
  });
});

describe("resolveSessionStatus", () => {
  const withFile = async (
    content: string,
    run: (file: string, size: number, hash: string) => Promise<void>
  ) => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "session-status-test-"));
    const file = path.join(root, "s1.jsonl");
    try {
      await fs.promises.writeFile(file, content);
      await run(file, (await fs.promises.stat(file)).size, await sha256File(file));
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  };

  const lookupFor = (size: number, hash: string) =>
    buildStatusLookup(
      {
        formatVersion: 2,
        machineId: "A",
        updatedAt: "2026-07-14T00:00:00Z",
        sessions: [
          { tool: "claude", id: "s1", relativePath: "projects/s1.jsonl", mtimeMs: 100, size, hash },
        ],
      },
      ["tool:claude"],
      95
    );

  // Claude 讀歷史會把同樣的內容重寫一次，只推進 mtime。
  it("keeps a touched but unchanged session synced", async () => {
    await withFile('{"a":1}\n', async (file, size, hash) => {
      const status = await resolveSessionStatus(lookupFor(size, hash), {
        tool: "claude",
        id: "s1",
        file,
        relativePath: "projects/s1.jsonl",
        mtimeMs: 200,
        size,
      });
      assert.equal(status, "synced");
    });
  });

  it("still reports edited content of the same length as modified", async () => {
    await withFile('{"a":1}\n', async (file, size, hash) => {
      const status = await resolveSessionStatus(lookupFor(size, hash.replace(/^./, "0")), {
        tool: "claude",
        id: "s1",
        file,
        relativePath: "projects/s1.jsonl",
        mtimeMs: 200,
        size,
      });
      assert.equal(status, "modified");
    });
  });
});
