import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ChangedNode,
  ChangedSession,
  classifyRemoteError,
  classifyRepositoryChanges,
  groupChangedSessions,
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

describe("classifyRemoteError", () => {
  it("recognises a remote that is gone or mistyped", () => {
    for (const message of [
      "remote: Repository not found.\nfatal: repository 'https://github.com/me/.backup.git/' not found",
      "fatal: '/srv/git/backup.git' does not appear to be a git repository",
    ]) {
      assert.equal(classifyRemoteError(message), "not-found");
    }
  });

  it("recognises authorization failures", () => {
    for (const message of [
      "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/me/backup.git/'",
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
    ]) {
      assert.equal(classifyRemoteError(message), "auth");
    }
  });

  // 私人儲存庫在權限不足時 GitHub 也回 404，此時該提示重新授權而不是重新連接。
  it("prefers authorization over not-found when SSO is the real cause", () => {
    assert.equal(
      classifyRemoteError(
        "remote: The `acme' organization has enabled or enforced SAML SSO.\n" +
          "remote: Repository not found."
      ),
      "auth"
    );
  });

  it("recognises transient network failures, which are the only retryable kind", () => {
    for (const message of [
      "fatal: unable to access 'https://github.com/me/backup.git/': Could not resolve host: github.com",
      "fatal: unable to access '...': Failed to connect to github.com port 443 after 21000 ms: Timed out",
    ]) {
      assert.equal(classifyRemoteError(message), "network");
    }
  });

  it("falls back to unknown so the retry action stays available", () => {
    assert.equal(classifyRemoteError("fatal: something entirely new"), "unknown");
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

describe("groupChangedSessions", () => {
  /** Codex 子代理檔與主 thread 共用 session_id，只有 ownId/parentThreadId 分得出親子。 */
  const entry = (
    relativePath: string,
    extra: Partial<LocalSession> = {}
  ): ChangedSession => ({
    change: "added",
    session: {
      tool: "codex",
      id: "thread-1",
      file: `C:\\codex\\${relativePath}`,
      relativePath,
      mtimeMs: 1,
      size: 10,
      hash: relativePath,
      ...extra,
    },
  });

  const names = (nodes: ChangedNode[]): unknown =>
    nodes.map((n) => [n.entry.session.relativePath, names(n.children)]);

  it("把主 thread 與 3 個子代理（各帶 guardian）收成一列", () => {
    // 對應實際資料：8 個檔案的 session_id 全是主 thread。
    const groups = groupChangedSessions([
      entry("root.jsonl", { ownId: "thread-1", title: "產生重構評估報告" }),
      entry("g0.jsonl", { ownId: "g0", parentThreadId: "thread-1", subagent: "guardian" }),
      entry("a.jsonl", { ownId: "a", parentThreadId: "thread-1", subagent: "baseline_tests" }),
      entry("ag.jsonl", { ownId: "ag", parentThreadId: "a", subagent: "guardian" }),
      entry("b.jsonl", { ownId: "b", parentThreadId: "thread-1", subagent: "complexity" }),
      entry("bg.jsonl", { ownId: "bg", parentThreadId: "b", subagent: "guardian" }),
      entry("c.jsonl", { ownId: "c", parentThreadId: "thread-1", subagent: "duplication" }),
      entry("cg.jsonl", { ownId: "cg", parentThreadId: "c", subagent: "guardian" }),
    ]);

    assert.equal(groups.length, 1);
    assert.equal(groups[0].total, 8);
    assert.deepEqual(names(groups[0].roots), [
      [
        "root.jsonl",
        [
          ["g0.jsonl", []],
          ["a.jsonl", [["ag.jsonl", []]]],
          ["b.jsonl", [["bg.jsonl", []]]],
          ["c.jsonl", [["cg.jsonl", []]]],
        ],
      ],
    ]);
  });

  it("單一檔案的 session 仍然是一個 root，不會多長一層", () => {
    const groups = groupChangedSessions([entry("only.jsonl", { ownId: "thread-1" })]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].total, 1);
    assert.equal(groups[0].roots.length, 1);
    assert.equal(groups[0].roots[0].children.length, 0);
  });

  it("不同 thread 各自成組", () => {
    const groups = groupChangedSessions([
      entry("a.jsonl", { id: "thread-1", ownId: "thread-1" }),
      entry("b.jsonl", { id: "thread-2", ownId: "thread-2" }),
    ]);
    assert.deepEqual(
      groups.map((g) => g.id),
      ["thread-1", "thread-2"]
    );
  });

  it("接續的 rollout 檔沒有 parent，會並列成多個 root", () => {
    const groups = groupChangedSessions([
      entry("first.jsonl", { ownId: "thread-1" }),
      entry("second.jsonl", { ownId: "resumed" }),
    ]);
    assert.equal(groups[0].total, 2);
    assert.equal(groups[0].roots.length, 2);
  });

  it("父檔不在變動清單裡的孤兒仍然列得出來", () => {
    const groups = groupChangedSessions([
      entry("orphan.jsonl", { ownId: "x", parentThreadId: "not-changed", subagent: "guardian" }),
    ]);
    assert.equal(groups[0].roots.length, 1);
    assert.equal(groups[0].roots[0].entry.session.relativePath, "orphan.jsonl");
  });

  it("互指成環的異常資料不會讓節點從清單消失", () => {
    const groups = groupChangedSessions([
      entry("x.jsonl", { ownId: "x", parentThreadId: "y" }),
      entry("y.jsonl", { ownId: "y", parentThreadId: "x" }),
    ]);
    const flatten = (nodes: ChangedNode[]): string[] =>
      nodes.flatMap((n) => [n.entry.session.relativePath, ...flatten(n.children)]);
    assert.deepEqual(flatten(groups[0].roots).sort(), ["x.jsonl", "y.jsonl"]);
    assert.equal(groups[0].total, 2);
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
