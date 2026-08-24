/** Sessions 側欄的對話操作：預覽、匯出、開啟原始檔。 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { renderSessionMarkdown } from "../agents/transcript";
import { showSessionPreview } from "../ui/sessionPreview";
import { TreeNode } from "../ui/sessionTree";
import { CommandDeps } from "./deps";

export function registerSessionsCommands(deps: CommandDeps): vscode.Disposable[] {
  const { context, tree } = deps;
  return [
    vscode.commands.registerCommand("sessionBackup.refreshSessions", () =>
      tree.refresh(),
    ),
    vscode.commands.registerCommand(
      "sessionBackup.previewSession",
      async (node?: TreeNode) => {
        if (node?.kind !== "session") {
          return;
        }
        await showSessionPreview(
          node.info.tool,
          node.info.file,
          node.info.tool === "claude" ? node.info.id : node.info.backupId,
          context.extensionUri,
          context.globalStorageUri.fsPath,
          node.status,
          node.conversationCwd,
        );
      },
    ),
    vscode.commands.registerCommand(
      "sessionBackup.exportSession",
      async (node?: TreeNode) => {
        if (node?.kind !== "session") {
          return;
        }
        const s = node.info;
        const safe =
          s.title
            .replace(/[\\/:*?"<>|]/g, " ")
            .replace(/\s+/g, " ")
            .trim() || s.id;
        const target = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(
            path.join(os.homedir(), `${s.date} ${safe.slice(0, 50)}.md`),
          ),
          filters: { Markdown: ["md"] },
        });
        if (!target) {
          return;
        }
        const md = await renderSessionMarkdown(s.tool, s.file);
        await fs.promises.writeFile(target.fsPath, md, "utf8");
        vscode.window.showInformationMessage(
          `Session Backup: 已匯出 ${path.basename(target.fsPath)}`,
        );
      },
    ),
    vscode.commands.registerCommand(
      "sessionBackup.openSessionFile",
      async (node?: TreeNode) => {
        if (node?.kind !== "session") {
          return;
        }
        await vscode.window.showTextDocument(vscode.Uri.file(node.info.file));
      },
    )
  ];
}
