/**
 * 樹節點在訊息中的稱呼。TreeNode 只以型別匯入，這個模組執行時不相依 vscode。
 */

import type { TreeNode } from "./treeNodes";

export function nodeLabel(node: TreeNode): string {
  switch (node.kind) {
    case "unmappedGroup":
      return "未對應專案";
    case "project":
      return `專案「${node.label}」`;
    case "claudeProject":
      return `專案「${node.projectLabel}」的 Claude Code`;
    case "codexProject":
      return `專案「${node.projectLabel}」的 Codex`;
    case "session":
      return `「${node.info.title}」`;
    case "unmappedProject":
      return `待對應專案「${node.project.displayName}」`;
  }
}
