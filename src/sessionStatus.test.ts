import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildStatusLookup, sessionSyncStatus } from "./sessionStatus";
import { MachineManifest } from "./sessionStore";

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
