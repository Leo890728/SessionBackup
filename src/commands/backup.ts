/** 立即備份與同步：兩個最常用的命令。 */

import * as vscode from "vscode";
import { runSync } from "../ops/sync";
import { CommandDeps } from "./deps";

export function registerBackupCommands(deps: CommandDeps): vscode.Disposable[] {
  const { out, projects, conflicts, repository, tree, backupNow } = deps;
  return [
    vscode.commands.registerCommand("sessionBackup.backupNow", () =>
      backupNow(),
    ),
    vscode.commands.registerCommand("sessionBackup.sync", async () => {
      try {
        const summary = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Session Backup: 同步並合併其他電腦紀錄...",
          },
          () => runSync(out, projects, conflicts),
        );
        tree.refresh();
        repository.refresh();
        const parts =
          `新增 ${summary.added}、更新 ${summary.updated}、保留本機 ${summary.keptLocal}、` +
          `相同 ${summary.identical}、跳過 ${summary.skipped}` +
          (summary.deferred ? `、延後 ${summary.deferred}` : "") +
          // 刪本機檔案的動作要講出來，不能只寫在 Output 裡。
          (summary.evicted ? `、移出未對應 ${summary.evicted}` : "");
        const unmappedNote = summary.unmappedProjects.length
          ? `，另有 ${summary.unmappedProjects.length} 個專案（` +
            summary.unmappedProjects
              .map((project) => project.displayName)
              .join("、") +
            "）在本機找不到位置，對話尚未匯入"
          : "";
        if (summary.conflicts > 0) {
          const open = await vscode.window.showWarningMessage(
            `Session Backup: 同步完成（${parts}），有 ${summary.conflicts} 個衝突待處理${unmappedNote}。`,
            "開啟側欄處理",
          );
          if (open) {
            await vscode.commands.executeCommand(
              "sessionBackup.repository.focus",
            );
          }
        } else if (summary.unmappedProjects.length) {
          const open = "開啟 Sessions 側欄";
          const pick = await vscode.window.showWarningMessage(
            `Session Backup: 同步完成（${parts}）${unmappedNote}。` +
              "請在 Sessions 側欄點擊 ☁ 待對應的專案指定本機資料夾。",
            open,
          );
          if (pick === open) {
            await vscode.commands.executeCommand(
              "sessionBackup.sessions.focus",
            );
          }
        } else {
          vscode.window.showInformationMessage(
            `Session Backup: 同步完成（${parts}）`,
          );
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(
          "Session Backup 同步失敗：" + err.message,
        );
      }
    })
  ];
}
