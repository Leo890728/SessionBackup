/** 備份儲存庫：連接、登入、發佈與檢視。 */

import * as vscode from "vscode";
import { getConfig } from "../config";
import { Git } from "../git/git";
import { getSessionToken } from "../git/github/auth";
import { setupRemote } from "../git/setupRemote";
import { CommandDeps } from "./deps";

export function registerRepositoryCommands(deps: CommandDeps): vscode.Disposable[] {
  const { out, repository, tree, backupNow } = deps;
  return [
    vscode.commands.registerCommand("sessionBackup.setupRemote", async () => {
      try {
        await setupRemote(out);
        repository.refresh();
        // 連接的過程可能以遠端重建了本地備份庫，Sessions 側欄的雲端專案要跟著重讀。
        tree.refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(
          "Session Backup 設定遠端失敗：" + err.message,
        );
      }
    }),
    vscode.commands.registerCommand(
      "sessionBackup.reconnectRemote",
      async () => {
        try {
          // forcePick：從「已連接」進來的意圖是換一個儲存庫，自動挑選只會挑回原本那個。
          await setupRemote(out, { forcePick: true });
          repository.refresh();
          tree.refresh();
        } catch (err: any) {
          vscode.window.showErrorMessage(
            "Session Backup 重新連接儲存庫失敗：" + err.message,
          );
        }
      },
    ),
    vscode.commands.registerCommand("sessionBackup.signInGithub", async () => {
      const token = await getSessionToken(true);
      if (!token) {
        vscode.window.showWarningMessage(
          "Session Backup: 尚未取得 GitHub 授權。",
        );
        return;
      }
      repository.refresh();
      tree.refresh();
    }),
    vscode.commands.registerCommand("sessionBackup.publishGithub", async () => {
      try {
        const cfg = getConfig();
        const git = new Git(cfg.repoPath, out);
        let remote = await git.getRemote();
        if (!remote) {
          await setupRemote(out);
          remote = await git.getRemote();
          repository.refresh();
          tree.refresh();
        }
        if (!remote) {
          return;
        }
        await backupNow();
      } catch (err: any) {
        vscode.window.showErrorMessage(
          "Session Backup 發布至 GitHub 失敗：" + err.message,
        );
      }
    }),
    vscode.commands.registerCommand("sessionBackup.refreshRepository", () =>
      repository.refresh(),
    ),
    vscode.commands.registerCommand("sessionBackup.repositoryViewAsTree", () =>
      repository.setViewMode("tree"),
    ),
    vscode.commands.registerCommand("sessionBackup.repositoryViewAsList", () =>
      repository.setViewMode("list"),
    ),
    vscode.commands.registerCommand("sessionBackup.openRepo", () => {
      vscode.env.openExternal(vscode.Uri.file(getConfig().repoPath));
    }),
    vscode.commands.registerCommand("sessionBackup.showLog", () => out.show())
  ];
}
