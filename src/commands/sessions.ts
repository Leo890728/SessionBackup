/** Sessions 側欄的對話操作：預覽、匯出、開啟原始檔。 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { renderSessionMarkdown } from "../agents/transcript";
import {
  openSessionConversation,
  showSessionPreview,
} from "../ui/sessionPreview";
import { TreeNode } from "../ui/treeNodes";
import { ChangedSessionNode } from "../ui/repositoryTree";
import { ProjectMappingRegistry } from "../store/projectMapping";
import { Tool } from "../agents/types";
import { CommandDeps } from "./deps";

/**
 * Sessions 側欄傳進來的是樹節點，Github Backup 側欄的變更清單傳的是另一種節點，
 * 兩邊記 session 身分的欄位不一樣，在這裡收斂成同一組開啟參數。
 */
async function conversationTarget(
  node: TreeNode | ChangedSessionNode | undefined,
  projects: ProjectMappingRegistry,
): Promise<{ tool: Tool; sessionId: string; cwd?: string } | undefined> {
  if (node?.kind === "session") {
    return {
      tool: node.info.tool,
      sessionId:
        node.info.tool === "claude" ? node.info.id : node.info.backupId,
      cwd: node.conversationCwd,
    };
  }
  if (node?.kind === "changedSession") {
    const session = node.session;
    // 變更清單沒帶工作目錄，但 Claude 得知道要在哪個專案視窗開，只好回頭查映射。
    const mapping = session.project
      ? await projects.locateProject(session.project, false)
      : undefined;
    return {
      tool: session.tool,
      sessionId:
        session.tool === "claude"
          ? session.ownId ?? session.id
          : session.id,
      cwd: mapping?.localPath,
    };
  }
  return undefined;
}

export function registerSessionsCommands(deps: CommandDeps): vscode.Disposable[] {
  const { context, tree } = deps;
  return [
    vscode.commands.registerCommand("sessionBackup.refreshSessions", () =>
      tree.refresh(),
    ),
    vscode.commands.registerCommand(
      "sessionBackup.previewSession",
      async (node?: TreeNode) => {
        // 待匯入的對話沒有本機檔案，讀的是備份庫裡的 revision。內容格式一樣，
        // 預覽器吃的本來就是一個 JSONL 路徑。
        if (node?.kind === "pendingSession") {
          if (!fs.existsSync(node.file)) {
            vscode.window.showWarningMessage(
              "Session Backup: 這則對話的內容不在本機備份庫裡，請先同步備份庫。",
            );
            return;
          }
          await showSessionPreview(
            node.session.tool,
            node.file,
            node.session.id,
            context.extensionUri,
            context.globalStorageUri.fsPath,
            "synced",
          );
          return;
        }
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
    // 兩個側欄列尾（滑過才出現）與右鍵都指向這裡，
    // 跟預覽面板的「在對話開啟」同一條路徑。
    vscode.commands.registerCommand(
      "sessionBackup.openConversation",
      async (node?: TreeNode | ChangedSessionNode) => {
        const target = await conversationTarget(node, deps.projects);
        if (!target) {
          return;
        }
        await openSessionConversation(
          target.tool,
          target.sessionId,
          target.cwd,
          context.globalStorageUri.fsPath,
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
