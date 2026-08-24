/** 衝突處理：比對遠端與本機版本，擇一保留。 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { materializeCodexRevision, readCodexMetaCwd } from "../agents/codexLocalize";
import { getConfig } from "../config";
import { rememberKeepLocal } from "../ops/sync";
import { ConflictRecord } from "../store/conflicts";
import { machineIdFromConfig, revisionRelativePath } from "../store/sessionStore";
import { showConflictComparison } from "../ui/conflictView";
import { CommandDeps } from "./deps";

export function registerConflictCommands(deps: CommandDeps): vscode.Disposable[] {
  const { conflicts, repository, tree } = deps;
  return [
    vscode.commands.registerCommand(
      "sessionBackup.resolveConflict",
      async (record?: ConflictRecord) => {
        if (!record?.key) {
          return;
        }
        try {
          const cfg = getConfig();
          const remoteFile = path.join(
            cfg.repoPath,
            ...revisionRelativePath(
              record.tool,
              record.id,
              record.remoteHash,
            ).split("/"),
          );
          if (!fs.existsSync(remoteFile) || !fs.existsSync(record.localFile)) {
            await conflicts.remove(record.key);
            repository.refresh(false);
            vscode.window.showInformationMessage(
              "Session Backup: 此衝突已不存在，已自清單移除。",
            );
            return;
          }
          const choice = await showConflictComparison({
            tool: record.tool,
            sessionId: record.id,
            aFile: remoteFile,
            aMachine: record.remoteMachine,
            bFile: record.localFile,
            bMachine: machineIdFromConfig(cfg),
          });
          if (choice === "A") {
            if (record.tool === "codex") {
              await materializeCodexRevision(
                remoteFile,
                record.localFile,
                await readCodexMetaCwd(record.localFile),
              );
            } else {
              await fs.promises.copyFile(remoteFile, record.localFile);
            }
            await conflicts.remove(record.key);
            vscode.window.showInformationMessage(
              "Session Backup: 已採用遠端版本（本機原內容仍保存在備份庫中，隨時可反悔）。",
            );
          } else if (choice === "B") {
            await rememberKeepLocal(
              cfg.repoPath,
              machineIdFromConfig(cfg),
              record,
            );
            await conflicts.remove(record.key);
            vscode.window.showInformationMessage(
              "Session Backup: 已保留本機版本。",
            );
          }
          repository.refresh(false);
          tree.refresh();
        } catch (err: any) {
          vscode.window.showErrorMessage(
            "Session Backup 解決衝突失敗：" + err.message,
          );
        }
      },
    )
  ];
}
