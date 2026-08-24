import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ManifestSession } from "../store/sessionStore";
import { fileKey, newestRemoteFiles } from "../store/syncState";

describe("newestRemoteFiles", () => {
  const entry = (
    id: string,
    relativePath: string,
    mtimeMs: number
  ): ManifestSession => ({
    tool: "codex",
    id,
    relativePath,
    mtimeMs,
    size: 1,
    hash: `h-${relativePath}-${mtimeMs}`,
  });

  it("keeps every rollout file of a resumed thread instead of collapsing by id", () => {
    // 同一個 thread（resume）有兩個 rollout 檔——兩個都要保留，
    // 否則遠端檔案會被拿去跟錯誤的本機檔案比對，產生假衝突。
    const manifests = [
      {
        machineId: "LAPTOP",
        sessions: [
          entry("thread-1", "sessions/2026/07/01/rollout-a.jsonl", 100),
          entry("thread-1", "sessions/2026/07/01/rollout-b.jsonl", 200),
        ],
      },
    ];
    const files = newestRemoteFiles(manifests);
    assert.deepEqual(
      files.map((f) => f.session.relativePath).sort(),
      ["sessions/2026/07/01/rollout-a.jsonl", "sessions/2026/07/01/rollout-b.jsonl"]
    );
  });

  it("dedupes the same file across machines by newest mtime", () => {
    const manifests = [
      { machineId: "A", sessions: [entry("t", "sessions/x.jsonl", 100)] },
      { machineId: "B", sessions: [entry("t", "sessions/x.jsonl", 300)] },
    ];
    const files = newestRemoteFiles(manifests);
    assert.equal(files.length, 1);
    assert.equal(files[0].machineId, "B");
    assert.equal(files[0].session.mtimeMs, 300);
  });

  it("normalizes path separators in file keys", () => {
    assert.equal(
      fileKey("codex", "sessions\\2026\\x.jsonl"),
      "codex:sessions/2026/x.jsonl"
    );
  });
});
