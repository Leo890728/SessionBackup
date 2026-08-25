import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionInfo } from "../agents/types";
import { claudeProjectKey, SelectionSet, sessionKey } from "../store/selection";
import { ClaudeProjectNode, CodexProjectNode, TreeNode } from "./treeNodes";
import {
  applyAiSelection,
  collectCodexInfos,
  flattenSessions,
  groupDescription,
  projectSelectionTip,
  ruleFor,
  selectionSummary,
} from "./treeSelection";

const info = (id: string, file = `${id}.jsonl`, over: Partial<SessionInfo> = {}) =>
  ({
    tool: "codex",
    file,
    id,
    backupId: id,
    mtime: 0,
    size: 0,
    title: id,
    date: "2026-01-01",
    time: "00:00",
    ...over,
  }) as SessionInfo;

const claudeNode = (
  projects: { dir: string; sessionIds: string[] }[],
): ClaudeProjectNode =>
  ({
    kind: "claudeProject",
    projectKey: "p",
    projectLabel: "p",
    projects: projects.map((p) => ({ ...p, label: p.dir, decoded: p.dir, mtime: 0, count: 0 })),
  }) as ClaudeProjectNode;

const codexNode = (
  topLevel: SessionInfo[],
  subsByHost = new Map<string, SessionInfo[]>(),
): CodexProjectNode =>
  ({
    kind: "codexProject",
    projectKey: "p",
    projectLabel: "p",
    codexRoot: "/codex",
    topLevel,
    subsByHost,
  }) as CodexProjectNode;

describe("collectCodexInfos", () => {
  it("walks sub-threads under their host and keeps the host first", () => {
    const parent = info("parent");
    const child = info("child");
    const subs = new Map([["parent.jsonl", [child]]]);
    assert.deepEqual(
      collectCodexInfos([parent], subs).map((i) => i.id),
      ["parent", "child"],
    );
  });

  it("follows sub-threads recursively", () => {
    const subs = new Map([
      ["a.jsonl", [info("b")]],
      ["b.jsonl", [info("c")]],
    ]);
    assert.deepEqual(
      collectCodexInfos([info("a")], subs).map((i) => i.id),
      ["a", "b", "c"],
    );
  });

  it("visits each file once even when two hosts claim the same sub", () => {
    // 迴圈或重複掛載不能讓統計數字灌水，否則「全選」永遠算不成立。
    const shared = info("shared");
    const subs = new Map([
      ["a.jsonl", [shared]],
      ["b.jsonl", [shared]],
    ]);
    assert.deepEqual(
      collectCodexInfos([info("a"), info("b")], subs).map((i) => i.id),
      ["a", "shared", "b"],
    );
  });

  it("survives a sub-thread that lists itself as its own host", () => {
    const subs = new Map([["a.jsonl", [info("a")]]]);
    assert.deepEqual(collectCodexInfos([info("a")], subs).map((i) => i.id), ["a"]);
  });
});

describe("selectionSummary", () => {
  it("counts a Claude group across all of its project buckets", () => {
    const node = claudeNode([
      { dir: "/p/one", sessionIds: ["s1", "s2"] },
      { dir: "/p/two", sessionIds: ["s3"] },
    ]);
    const selection = new SelectionSet([sessionKey("claude", "s1")]);
    assert.deepEqual(selectionSummary(selection, node), {
      total: 3,
      chosen: 1,
      selected: false,
    });
  });

  it("reports selected only when every Claude bucket has a project rule", () => {
    const node = claudeNode([
      { dir: "/p/one", sessionIds: ["s1"] },
      { dir: "/p/two", sessionIds: ["s2"] },
    ]);
    const partial = new SelectionSet([claudeProjectKey("one")]);
    assert.equal(selectionSummary(partial, node).selected, false);
    const both = new SelectionSet([claudeProjectKey("one"), claudeProjectKey("two")]);
    assert.equal(selectionSummary(both, node).selected, true);
  });

  it("treats an empty Claude group as not selected", () => {
    assert.deepEqual(selectionSummary(new SelectionSet(), claudeNode([])), {
      total: 0,
      chosen: 0,
      selected: false,
    });
  });

  it("counts Codex sub-threads towards the group total", () => {
    const node = codexNode([info("a")], new Map([["a.jsonl", [info("b")]]]));
    const selection = new SelectionSet([sessionKey("codex", "a")]);
    assert.deepEqual(selectionSummary(selection, node), {
      total: 2,
      chosen: 1,
      selected: false,
    });
  });

  it("is selected once every Codex session is chosen", () => {
    const node = codexNode([info("a"), info("b")]);
    const selection = new SelectionSet([
      sessionKey("codex", "a"),
      sessionKey("codex", "b"),
    ]);
    assert.equal(selectionSummary(selection, node).selected, true);
  });

  it("treats an empty Codex group as not selected", () => {
    assert.equal(selectionSummary(new SelectionSet(), codexNode([])).selected, false);
  });
});

describe("groupDescription", () => {
  it("shows the partial hint ahead of any other state", () => {
    assert.equal(groupDescription(4, 2, false, "2/4"), "4 個對話 · 2/4");
    assert.equal(groupDescription(4, 4, true, "2/4"), "4 個對話 · 2/4");
  });

  it("distinguishes a standing rule from merely having everything ticked", () => {
    // 「已追蹤」代表有規則涵蓋（含之後新增的），「目前全選」只是剛好都勾到了。
    assert.equal(groupDescription(3, 3, true, undefined), "3 個對話 · 已追蹤");
    assert.equal(groupDescription(3, 3, false, undefined), "3 個對話 · 目前全選");
  });

  it("shows only the count when nothing is chosen", () => {
    assert.equal(groupDescription(3, 0, false, undefined), "3 個對話");
    assert.equal(groupDescription(0, 0, false, undefined), "0 個對話");
  });
});

describe("projectSelectionTip", () => {
  const claude = { kind: "claudeProject" } as ClaudeProjectNode;
  const codex = { kind: "codexProject" } as CodexProjectNode;

  it("warns that the two AIs behave differently when both are present", () => {
    const tip = projectSelectionTip([claude, codex]);
    assert.match(tip, /Claude Code 包含之後新增的對話/);
    assert.match(tip, /Codex 只包含目前已有的對話/);
  });

  it("says future conversations are included for Claude alone", () => {
    assert.match(projectSelectionTip([claude]), /含之後新增的/);
  });

  it("says future conversations are excluded for Codex alone", () => {
    assert.match(projectSelectionTip([codex]), /不含之後新增的/);
  });
});

describe("applyAiSelection", () => {
  it("writes one project rule per Claude bucket, not per session", () => {
    const node = claudeNode([
      { dir: "/p/one", sessionIds: ["s1", "s2"] },
      { dir: "/p/two", sessionIds: ["s3"] },
    ]);
    const next = applyAiSelection([], node, true);
    assert.deepEqual(next.sort(), [claudeProjectKey("one"), claudeProjectKey("two")].sort());
  });

  it("writes a session rule for every Codex session including subs", () => {
    const node = codexNode([info("a")], new Map([["a.jsonl", [info("b")]]]));
    const next = applyAiSelection([], node, true);
    assert.deepEqual(next.sort(), [sessionKey("codex", "a"), sessionKey("codex", "b")].sort());
  });

  it("deselecting removes the rules it previously added", () => {
    const node = codexNode([info("a")]);
    const on = applyAiSelection([], node, true);
    assert.deepEqual(applyAiSelection(on, node, false), []);
  });
});

describe("flattenSessions", () => {
  it("collects nested sub-threads and skips non-session nodes", () => {
    const nodes = [
      { kind: "project", key: "p", label: "p", latestMtime: 0, children: [] },
      {
        kind: "session",
        info: info("a"),
        subs: [{ kind: "session", info: info("b"), subs: [] }],
      },
    ] as unknown as TreeNode[];
    assert.deepEqual(flattenSessions(nodes).map((i) => i.id), ["a", "b"]);
  });

  it("returns nothing when no session nodes are present", () => {
    assert.deepEqual(flattenSessions([{ kind: "project" } as TreeNode]), []);
  });
});

describe("ruleFor", () => {
  it("keys a session by its backupId, not the filename id", () => {
    // Codex 子代理檔的 id 是自身、備份端用父 thread id，勾錯就備份不到。
    const node = {
      kind: "session",
      info: info("own-id", "own-id.jsonl", { backupId: "parent-thread" }),
      claudeProjectDir: undefined,
    } as unknown as Extract<TreeNode, { kind: "session" }>;
    const rule = ruleFor(node);
    assert.equal(rule.key, sessionKey("codex", "parent-thread"));
    assert.equal(rule.target.id, "parent-thread");
    assert.equal(rule.level, "session");
  });

  it("carries the Claude project dir into the target", () => {
    const node = {
      kind: "session",
      info: info("s1", "s1.jsonl", { tool: "claude", backupId: "s1" }),
      claudeProjectDir: "proj",
    } as unknown as Extract<TreeNode, { kind: "session" }>;
    assert.equal(ruleFor(node).target.claudeProjectDir, "proj");
  });
});
