import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyRule,
  applySessionRules,
  claudeProjectKey,
  partialHint,
  SelectionSet,
  sessionKey,
  toolKey,
} from "./selection";
import { initialSelectionKeys } from "./selectionMigration";
import { MachineManifest } from "./sessionStore";

const target = {
  tool: "claude" as const,
  id: "s1",
  claudeProjectDir: "C--proj",
};

describe("SelectionSet", () => {
  it("selects nothing when there are no rules", () => {
    const selection = new SelectionSet([]);
    assert.equal(selection.includes(target), false);
    assert.equal(selection.excludes(target), false);
  });

  it("matches every level", () => {
    assert.equal(new SelectionSet([toolKey("claude")]).includes(target), true);
    assert.equal(
      new SelectionSet([claudeProjectKey("C--proj")]).includes(target),
      true
    );
    assert.equal(
      new SelectionSet([sessionKey("claude", "s1")]).includes(target),
      true
    );
    assert.equal(new SelectionSet([toolKey("codex")]).includes(target), false);
    assert.equal(
      new SelectionSet([claudeProjectKey("C--other")]).includes(target),
      false
    );
  });

  it("lets the most specific rule win", () => {
    const selection = new SelectionSet(["tool:claude", "-claudeProject:C--proj"]);
    assert.equal(selection.includes(target), false);
    assert.equal(selection.excludes(target), true);
    assert.equal(
      selection.includes({ tool: "claude", id: "s2", claudeProjectDir: "C--other" }),
      true
    );

    const reinstated = new SelectionSet([...selection.toArray(), "session:claude:s1"]);
    assert.equal(reinstated.includes(target), true);
  });

  it("reports coverage from the levels above", () => {
    const selection = new SelectionSet(["claudeProject:C--proj"]);
    assert.equal(selection.coveredByScope(target, "session"), true);
    assert.equal(selection.coveredByScope(target, "claudeProject"), false);
    assert.equal(selection.claudeProjectSelected("C--proj"), true);
    assert.equal(selection.toolSelected("claude"), false);
  });

  it("spots narrower rules under a tool", () => {
    // 沒勾整個工具時，個別加選的規則代表部分選取。
    const added = new SelectionSet(["session:codex:c1"]);
    assert.equal(added.hasNarrowerRule("codex", false), true);
    assert.equal(added.hasNarrowerRule("claude", false), false);

    // 勾了整個工具時，看的是排除規則。
    const excluded = new SelectionSet(["tool:claude", "-session:claude:s1"]);
    assert.equal(excluded.hasNarrowerRule("claude", true), true);
    assert.equal(excluded.hasNarrowerRule("claude", false), false);

    // claudeProject 也算 tool 底下更細的一層，codex 沒有這一層。
    const project = new SelectionSet(["claudeProject:C--proj"]);
    assert.equal(project.hasNarrowerRule("claude", false), true);
    assert.equal(project.hasNarrowerRule("codex", false), false);

    // tool 規則本身不算「更細」。
    const whole = new SelectionSet(["tool:claude"]);
    assert.equal(whole.hasNarrowerRule("claude", false), false);
  });
});

describe("partialHint", () => {
  it("only labels a genuinely half-checked group", () => {
    assert.equal(partialHint(2, 5), "部分選取 2/5");
    assert.equal(partialHint(0, 5), undefined);
    assert.equal(partialHint(5, 5), undefined);
    assert.equal(partialHint(0, 0), undefined);
  });
});

describe("applyRule", () => {
  it("writes a plain rule when no scope covers the target", () => {
    assert.deepEqual(applyRule([], sessionKey("claude", "s1"), true, false), [
      "session:claude:s1",
    ]);
  });

  it("does not duplicate a rule already implied by a scope", () => {
    assert.deepEqual(
      applyRule(["tool:claude"], sessionKey("claude", "s1"), true, true),
      ["tool:claude"]
    );
  });

  it("writes an exclusion only when a scope would otherwise select it", () => {
    assert.deepEqual(
      applyRule(["tool:claude"], sessionKey("claude", "s1"), false, true),
      ["-session:claude:s1", "tool:claude"]
    );
    assert.deepEqual(
      applyRule(["session:claude:s1"], sessionKey("claude", "s1"), false, false),
      []
    );
  });

  it("replaces the opposite rule at the same level", () => {
    assert.deepEqual(
      applyRule(["-session:claude:s1", "tool:claude"], sessionKey("claude", "s1"), true, true),
      ["tool:claude"]
    );
  });
});

describe("applySessionRules", () => {
  it("applies a batch against the evolving rule set", () => {
    const keys = applySessionRules(
      ["tool:codex"],
      [
        { tool: "codex", id: "a" },
        { tool: "claude", id: "b" },
      ],
      false
    );
    assert.deepEqual(keys, ["-session:codex:a", "tool:codex"]);
  });
});

describe("initialSelectionKeys", () => {
  const manifest: MachineManifest = {
    formatVersion: 2,
    machineId: "A",
    updatedAt: "2026-07-14T00:00:00Z",
    sessions: [
      {
        tool: "claude",
        id: "s1",
        relativePath: "projects/s1.jsonl",
        mtimeMs: 1,
        size: 1,
        hash: "a",
      },
      {
        tool: "codex",
        id: "t1",
        relativePath: "sessions/t1.jsonl",
        mtimeMs: 1,
        size: 1,
        hash: "b",
      },
    ],
  };

  it("keeps already backed up sessions selected", () => {
    assert.deepEqual(initialSelectionKeys(manifest), [
      "session:claude:s1",
      "session:codex:t1",
    ]);
  });

  it("drops legacy ignored sessions without adding exclusions", () => {
    assert.deepEqual(initialSelectionKeys(manifest, ["claude:s1", "bogus"]), [
      "session:codex:t1",
    ]);
  });

  it("starts empty when nothing has been backed up", () => {
    assert.deepEqual(initialSelectionKeys(undefined), []);
  });
});
