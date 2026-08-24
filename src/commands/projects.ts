/** Claude 專案與本機資料夾的對應。 */

import * as vscode from "vscode";
import { TreeNode } from "../ui/treeNodes";
import { CommandDeps } from "./deps";

export function registerProjectsCommands(deps: CommandDeps): vscode.Disposable[] {
  const { out, projects, tree } = deps;
  return [
    vscode.commands.registerCommand("sessionBackup.manageProjects", () =>
      projects
        .manage()
        .catch((err) =>
          vscode.window.showErrorMessage(
            "Session Backup 管理專案對應失敗：" + err.message,
          ),
        ),
    ),
    vscode.commands.registerCommand(
      "sessionBackup.mapProject",
      async (node?: TreeNode) => {
        if (node?.kind !== "unmappedProject") {
          return;
        }
        try {
          // locateProject 的互動分支就是「使用目前工作區 / 選擇本機資料夾」那組 UI。
          const mapping = await projects.locateProject(node.project, true);
          if (!mapping) {
            return;
          }
          out.appendLine(
            `已對應專案「${node.project.displayName}」到 ${mapping.localPath}，開始同步`,
          );
          tree.refresh();
          // 對應好之後立刻同步，使用者不必再自己跑一次命令。
          await vscode.commands.executeCommand("sessionBackup.sync");
        } catch (err: any) {
          vscode.window.showErrorMessage(
            "Session Backup 對應專案失敗：" + err.message,
          );
        }
      },
    )
  ];
}
