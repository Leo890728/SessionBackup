/** Claude 專案與本機資料夾的對應。 */

import * as path from "path";
import * as vscode from "vscode";
import { relocalizeCodexProject } from "../agents/codexLocalize";
import { sessionProjectIdentity } from "../agents/grouping";
import { toolDirs } from "../config";
import { ProjectRef } from "../store/sessionStore";
import { TreeNode } from "../ui/treeNodes";
import { CommandDeps } from "./deps";

/**
 * 這個節點要對應哪個專案。兩種來源：只在其他電腦備份過的專案（本機還沒有檔案），
 * 以及本機已經有檔案、但其中一部分的工作目錄還指著來源電腦的專案。後者多帶
 * strayCwdKeys，對應完才知道要把哪些既有檔案的 cwd 改過來。
 */
function mapTarget(
  node?: TreeNode
): { project: ProjectRef; strayCwdKeys: string[] } | undefined {
  if (node?.kind === "unmappedProject") {
    return { project: node.project, strayCwdKeys: [] };
  }
  if (node?.kind === "project" && node.projectRef) {
    return { project: node.projectRef, strayCwdKeys: node.strayCwdKeys };
  }
  return undefined;
}

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
        const target = mapTarget(node);
        if (!target) {
          return;
        }
        try {
          // locateProject 的互動分支就是「使用目前工作區 / 選擇本機資料夾」那組 UI。
          const mapping = await projects.locateProject(target.project, true);
          if (!mapping) {
            return;
          }
          out.appendLine(
            `已對應專案「${target.project.displayName}」到 ${mapping.localPath}`,
          );
          if (target.strayCwdKeys.length) {
            const stray = new Set(target.strayCwdKeys);
            const relocalized = await relocalizeCodexProject(
              path.join(toolDirs().codex, "sessions"),
              (cwd) => stray.has(sessionProjectIdentity(cwd).key),
              mapping.localPath,
            );
            if (relocalized.length) {
              out.appendLine(
                `已把 ${relocalized.length} 個 Codex 對話的工作目錄改寫成 ${mapping.localPath}`,
              );
            }
          }
          out.appendLine("開始同步");
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
