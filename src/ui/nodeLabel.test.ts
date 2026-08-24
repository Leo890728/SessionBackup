import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TreeNode } from "./treeNodes";
import { nodeLabel } from "./nodeLabel";

/**
 * TreeNode 只以型別匯入，測試不會載入 sessionTree.ts（它相依 vscode）。
 * 節點以 as TreeNode 收斂，只填每個分支實際會讀到的欄位。
 */
const node = (value: unknown) => value as TreeNode;

describe("nodeLabel", () => {
  it("names a project bucket", () => {
    assert.equal(
      nodeLabel(node({ kind: "project", label: "SessionBackup" })),
      "專案「SessionBackup」",
    );
  });

  it("distinguishes the two AI groups under the same project", () => {
    const claude = node({ kind: "claudeProject", projectLabel: "SessionBackup" });
    const codex = node({ kind: "codexProject", projectLabel: "SessionBackup" });
    assert.equal(nodeLabel(claude), "專案「SessionBackup」的 Claude Code");
    assert.equal(nodeLabel(codex), "專案「SessionBackup」的 Codex");
    assert.notEqual(nodeLabel(claude), nodeLabel(codex));
  });

  it("names a session by its title", () => {
    assert.equal(
      nodeLabel(node({ kind: "session", info: { title: "重構 sessions.ts" } })),
      "「重構 sessions.ts」",
    );
  });

  it("marks an unmapped project as awaiting a local folder", () => {
    assert.equal(
      nodeLabel(node({ kind: "unmappedProject", project: { displayName: "old-laptop" } })),
      "待對應專案「old-laptop」",
    );
  });
});
