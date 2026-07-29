import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SelectionSet } from "./selection";
import { MachineManifest, ManifestSession, ProjectRef } from "./sessionStore";
import { aggregateRemoteProjects, filterUnmapped } from "./unmappedProjects";

const SESSION_BACKUP: ProjectRef = {
  id: "local-c9240e161b03a2a7100bb8df17974bbb",
  displayName: "SessionBackup",
};

function session(
  id: string,
  project?: ProjectRef,
  tool: ManifestSession["tool"] = "claude"
): ManifestSession {
  return {
    tool,
    id,
    relativePath: `projects/${id}.jsonl`,
    mtimeMs: 1,
    size: 1,
    hash: `h-${id}`,
    project,
  };
}

function manifest(machineId: string, sessions: ManifestSession[]): MachineManifest {
  return { formatVersion: 2, machineId, updatedAt: "", sessions };
}

describe("aggregateRemoteProjects", () => {
  it("groups other machines' claude sessions by project id", () => {
    const result = aggregateRemoteProjects(
      [manifest("A", [session("s1", SESSION_BACKUP), session("s2", SESSION_BACKUP)])],
      "B"
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].count, 2);
    assert.deepEqual(result[0].machines, ["A"]);
    assert.equal(result[0].project.displayName, "SessionBackup");
  });

  it("ignores this machine's own manifest", () => {
    const result = aggregateRemoteProjects(
      [manifest("B", [session("s1", SESSION_BACKUP)])],
      "B"
    );
    assert.deepEqual(result, []);
  });

  it("dedupes a session id backed up by two machines and lists both", () => {
    const result = aggregateRemoteProjects(
      [
        manifest("A", [session("s1", SESSION_BACKUP)]),
        manifest("C", [session("s1", SESSION_BACKUP)]),
      ],
      "B"
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].count, 1);
    assert.deepEqual(result[0].machines, ["A", "C"]);
  });

  it("skips codex sessions and claude sessions without a project ref", () => {
    const result = aggregateRemoteProjects(
      [
        manifest("A", [
          session("s1", SESSION_BACKUP, "codex"),
          session("s2", undefined),
        ]),
      ],
      "B"
    );
    assert.deepEqual(result, []);
  });

  it("skips sessions the user explicitly excluded", () => {
    // 排除的對話同步時不會匯入，讓它撐出一個待對應節點只會變成點不掉的雜訊。
    const selection = new SelectionSet([
      "tool:claude",
      "-session:claude:s1",
    ]);
    const result = aggregateRemoteProjects(
      [manifest("A", [session("s1", SESSION_BACKUP), session("s2", SESSION_BACKUP)])],
      "B",
      selection
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].count, 1);
  });

  it("drops the project entirely when every session is excluded", () => {
    const selection = new SelectionSet(["tool:claude", "-session:claude:s1"]);
    const result = aggregateRemoteProjects(
      [manifest("A", [session("s1", SESSION_BACKUP)])],
      "B",
      selection
    );
    assert.deepEqual(result, []);
  });
});

describe("filterUnmapped", () => {
  const mapped: ProjectRef = { id: "git-mapped", displayName: "Mapped" };

  it("keeps only the projects the local machine cannot resolve", async () => {
    const remote = aggregateRemoteProjects(
      [
        manifest("A", [session("s1", SESSION_BACKUP), session("s2", mapped)]),
      ],
      "B"
    );
    const result = await filterUnmapped(remote, async (project) => project.id === mapped.id);
    assert.deepEqual(
      result.map((entry) => entry.project.id),
      [SESSION_BACKUP.id]
    );
  });

  it("returns nothing when every project resolves", async () => {
    const remote = aggregateRemoteProjects(
      [manifest("A", [session("s1", SESSION_BACKUP)])],
      "B"
    );
    assert.deepEqual(await filterUnmapped(remote, async () => true), []);
  });
});
