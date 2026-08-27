import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LocalSession, ProjectRef } from "../store/sessionStore";
import {
  candidateProjects,
  orphanedThreadIds,
  pickEvictable,
} from "./evictUnmapped";

const project = (id: string): ProjectRef => ({ id, displayName: id });

const session = (over: Partial<LocalSession> = {}): LocalSession => ({
  tool: "codex",
  id: "thread-1",
  file: "/codex/sessions/2026/01/01/rollout-1.jsonl",
  relativePath: "sessions/2026/01/01/rollout-1.jsonl",
  mtimeMs: 0,
  size: 10,
  hash: "h1",
  ...over,
});

const scope = (over: Partial<Parameters<typeof pickEvictable>[0]> = {}) => ({
  localSessions: [session()],
  remoteBySession: new Map([["codex:thread-1", project("p")]]),
  unmappedProjectIds: new Set(["p"]),
  isStored: () => true,
  now: 10 * 60 * 1000,
  ...over,
});

describe("pickEvictable", () => {
  it("takes an imported Codex file whose project is still unmapped", () => {
    assert.deepEqual(
      pickEvictable(scope()).map((s) => s.id),
      ["thread-1"],
    );
  });

  it("keeps a file this machine can place itself", () => {
    assert.deepEqual(
      pickEvictable(scope({ localSessions: [session({ project: project("p") })] })),
      [],
    );
  });

  it("keeps a conversation no other machine has backed up", () => {
    assert.deepEqual(pickEvictable(scope({ remoteBySession: new Map() })), []);
  });

  it("keeps it once the project is mapped: sync will fix the cwd instead", () => {
    assert.deepEqual(pickEvictable(scope({ unmappedProjectIds: new Set() })), []);
  });

  it("never deletes content that is not in the store yet", () => {
    assert.deepEqual(pickEvictable(scope({ isStored: () => false })), []);
  });

  it("leaves a file that was just written — it may be in use", () => {
    assert.deepEqual(pickEvictable(scope({ now: 1000 })), []);
  });

  it("ignores Claude sessions: those were never imported unmapped", () => {
    assert.deepEqual(
      pickEvictable(
        scope({
          localSessions: [session({ tool: "claude" })],
          remoteBySession: new Map([["claude:thread-1", project("p")]]),
        }),
      ),
      [],
    );
  });
});

describe("candidateProjects", () => {
  it("asks about a project only when a local file is stuck under it", () => {
    const remote = new Map([
      ["codex:thread-1", project("p")],
      ["codex:thread-9", project("elsewhere")],
    ]);
    assert.deepEqual([...candidateProjects([session()], remote).keys()], ["p"]);
  });

  it("skips files this machine already places itself", () => {
    const remote = new Map([["codex:thread-1", project("p")]]);
    assert.deepEqual(
      [...candidateProjects([session({ project: project("p") })], remote).keys()],
      [],
    );
  });
});

describe("orphanedThreadIds", () => {
  it("reports a thread only when its last local file is gone", () => {
    const host = session({ file: "/a.jsonl" });
    const sub = session({ file: "/b.jsonl" });
    const other = session({ id: "thread-2", file: "/c.jsonl" });
    assert.deepEqual(
      [...orphanedThreadIds([host, sub, other], [host])],
      [],
    );
    assert.deepEqual(
      [...orphanedThreadIds([host, sub, other], [host, sub])],
      ["thread-1"],
    );
  });
});
