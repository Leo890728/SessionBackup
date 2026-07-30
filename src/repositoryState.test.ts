import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyRepositoryChanges,
  localSessionsChanged,
  remoteLabel,
} from "./repositoryState";
import { LocalSession, MachineManifest } from "./sessionStore";

describe("remoteLabel", () => {
  it("formats HTTPS GitHub remotes", () => {
    assert.equal(remoteLabel("https://github.com/example/backup.git"), "example/backup");
  });

  it("formats SSH GitHub remotes", () => {
    assert.equal(remoteLabel("git@github.com:example/backup.git"), "example/backup");
  });
});

describe("classifyRepositoryChanges", () => {
  it("selects the action for each local/remote combination", () => {
    assert.equal(classifyRepositoryChanges(true, false), "backup");
    assert.equal(classifyRepositoryChanges(false, true), "sync");
    assert.equal(classifyRepositoryChanges(true, true), "merge");
    assert.equal(classifyRepositoryChanges(false, false), "synced");
  });
});

describe("localSessionsChanged", () => {
  const local: LocalSession = {
    tool: "codex",
    id: "session-1",
    file: "C:\\source\\session.jsonl",
    relativePath: "sessions/session.jsonl",
    mtimeMs: 1,
    size: 10,
    hash: "abc",
    title: "標題",
  };
  const manifest: MachineManifest = {
    formatVersion: 2,
    machineId: "machine-a",
    updatedAt: "2026-07-14T00:00:00Z",
    sessions: [
      {
        tool: local.tool,
        id: local.id,
        relativePath: local.relativePath,
        mtimeMs: local.mtimeMs,
        size: local.size,
        hash: local.hash,
        title: local.title,
      },
    ],
  };

  it("recognizes an unchanged local session set", () => {
    assert.equal(localSessionsChanged([local], manifest), false);
  });

  it("recognizes content and title changes", () => {
    assert.equal(localSessionsChanged([{ ...local, hash: "new" }], manifest), true);
    assert.equal(localSessionsChanged([{ ...local, title: "新標題" }], manifest), true);
  });

  it("ignores a bumped mtime when the content hash is unchanged", () => {
    // Claude Code 載入舊對話會把檔案原封不動重寫一次、只推進 mtime。
    // 那不是變更，否則「只是打開來看」的對話全部會列進「有變動的 sessions」。
    assert.equal(localSessionsChanged([{ ...local, mtimeMs: 999 }], manifest), false);
  });

  it("treats resumed Codex rollouts sharing a session id as unchanged", () => {
    // Codex resume 會有多個 rollout 檔共用同一個 session id。
    const resumed: LocalSession = {
      ...local,
      relativePath: "sessions/rollout-resumed.jsonl",
      file: "C:\\source\\rollout-resumed.jsonl",
      mtimeMs: 2,
      size: 20,
      hash: "def",
    };
    const twoFiles: MachineManifest = {
      ...manifest,
      sessions: [
        { ...manifest.sessions[0] },
        {
          tool: resumed.tool,
          id: resumed.id,
          relativePath: resumed.relativePath,
          mtimeMs: resumed.mtimeMs,
          size: resumed.size,
          hash: resumed.hash,
          title: resumed.title,
        },
      ],
    };
    assert.equal(localSessionsChanged([local, resumed], twoFiles), false);
    assert.equal(
      localSessionsChanged([local, { ...resumed, hash: "grew" }], twoFiles),
      true
    );
  });
});

describe("listChangedSessions", () => {
  const session = (id: string, relativePath: string, hash: string): LocalSession => ({
    tool: "codex",
    id,
    file: `C:\\s\\${id}.jsonl`,
    relativePath,
    mtimeMs: 1,
    size: 10,
    hash,
  });
  const { listChangedSessions } = require("./repositoryState") as typeof import("./repositoryState");

  it("reports added and modified sessions against the manifest", () => {
    const kept = session("a", "sessions/a.jsonl", "h-a");
    const grown = session("b", "sessions/b.jsonl", "h-b2");
    const fresh = session("c", "sessions/c.jsonl", "h-c");
    const manifest: MachineManifest = {
      formatVersion: 2,
      machineId: "m",
      updatedAt: "2026-07-15T00:00:00Z",
      sessions: [
        { tool: "codex", id: "a", relativePath: "sessions/a.jsonl", mtimeMs: 1, size: 10, hash: "h-a" },
        { tool: "codex", id: "b", relativePath: "sessions/b.jsonl", mtimeMs: 1, size: 10, hash: "h-b1" },
      ],
    };
    const changed = listChangedSessions([kept, grown, fresh], manifest);
    assert.deepEqual(
      changed.map((c) => `${c.session.id}:${c.change}`),
      ["b:modified", "c:added"]
    );
  });

  it("treats every session as added without a manifest", () => {
    const changed = listChangedSessions([session("a", "sessions/a.jsonl", "h")], undefined);
    assert.deepEqual(changed.map((c) => c.change), ["added"]);
  });
});
