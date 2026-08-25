/** 選擇要備份哪些對話。 */

import * as vscode from "vscode";
import { getConfig, updateTrackedSessions } from "../config";
import { describeSelectionKey } from "../store/selection";
import { nodeLabel } from "../ui/nodeLabel";
import { TreeNode } from "../ui/treeNodes";
import { CommandDeps } from "./deps";

export function registerSelectionCommands(deps: CommandDeps): vscode.Disposable[] {
  const { tree } = deps;
  return [
    vscode.commands.registerCommand(
      "sessionBackup.includeSession",
      async (node?: TreeNode) => {
        if (!node) {
          return;
        }
        await tree.setSelected(node, true);
        vscode.window.showInformationMessage(
          `Session Backup: 已納入追蹤 — ${nodeLabel(node)}`,
        );
      },
    ),
    vscode.commands.registerCommand(
      "sessionBackup.excludeSession",
      async (node?: TreeNode) => {
        if (!node) {
          return;
        }
        await tree.setSelected(node, false);
        vscode.window.showInformationMessage(
          `Session Backup: 已取消追蹤 — ${nodeLabel(node)}（已備份的內容仍保留在備份庫）`,
        );
      },
    ),
    vscode.commands.registerCommand(
      "sessionBackup.manageSelection",
      async () => {
        const selected = getConfig().trackedSessions;
        if (!selected.length) {
          vscode.window.showInformationMessage(
            "Session Backup: 尚未追蹤任何對話，請在 Sessions 側欄勾選。",
          );
          return;
        }
        const picks = await vscode.window.showQuickPick(
          selected.map((key) => ({
            label: describeSelectionKey(key),
            description: key,
          })),
          {
            canPickMany: true,
            placeHolder: "勾選要刪除的追蹤規則（保留不動的請勿勾選）",
          },
        );
        if (!picks?.length) {
          return;
        }
        const remove = new Set(picks.map((p) => p.description));
        await updateTrackedSessions((current) =>
          current.filter((key) => !remove.has(key)),
        );
        tree.reloadSelection();
        vscode.window.showInformationMessage(
          `Session Backup: 已刪除 ${picks.length} 條追蹤規則。`,
        );
      },
    )
  ];
}
