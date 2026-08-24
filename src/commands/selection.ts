/** 選擇要備份哪些對話。 */

import * as vscode from "vscode";
import { getConfig, updateSelectedSessions } from "../config";
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
          `Session Backup: 已加入備份 — ${nodeLabel(node)}`,
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
          `Session Backup: 已移出備份 — ${nodeLabel(node)}（已上傳的舊備份不會被刪除）`,
        );
      },
    ),
    vscode.commands.registerCommand(
      "sessionBackup.manageSelection",
      async () => {
        const selected = getConfig().selectedSessions;
        if (!selected.length) {
          vscode.window.showInformationMessage(
            "Session Backup: 尚未選取任何要備份的對話，請在 Sessions 側欄勾選。",
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
            placeHolder: "勾選要刪除的選取規則（保留不動的請勿勾選）",
          },
        );
        if (!picks?.length) {
          return;
        }
        const remove = new Set(picks.map((p) => p.description));
        await updateSelectedSessions((current) =>
          current.filter((key) => !remove.has(key)),
        );
        tree.reloadSelection();
        vscode.window.showInformationMessage(
          `Session Backup: 已刪除 ${picks.length} 條選取規則。`,
        );
      },
    )
  ];
}
