import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  conversationOpenTarget,
  queueClaudeConversationHandoff,
  sameConversationWorkspace,
} from "./sessionConversation";
import { readTranscript, Tool } from "./sessions";
import { previewHtml } from "./sessionPreviewHtml";
import type { SessionSyncStatus } from "./sessionStatus";

/** 同一份對話重複開啟時沿用既有面板，預覽才不會把編輯器塞滿分頁。 */
const panels = new Map<
  string,
  {
    panel: vscode.WebviewPanel;
    status: SessionSyncStatus;
    sessionId: string;
    conversationCwd?: string;
  }
>();

export async function showSessionPreview(
  tool: Tool,
  file: string,
  sessionId: string,
  extensionUri: vscode.Uri,
  handoffStorageRoot: string,
  status: SessionSyncStatus,
  conversationCwd?: string,
): Promise<void> {
  const media = vscode.Uri.joinPath(extensionUri, "media");
  const assets = (webview: vscode.Webview) => ({
    iconUri: webview
      .asWebviewUri(vscode.Uri.joinPath(media, `${tool}.png`))
      .toString(),
    imageSource: webview.cspSource,
  });

  const existing = panels.get(file);
  if (existing) {
    // 同一個檔案可能先從 Sessions 開啟，之後再從變動清單開啟；
    // 重用面板時也要更新狀態，reload 才不會沿用第一次開啟時的標記。
    existing.status = status;
    existing.sessionId = sessionId;
    existing.conversationCwd = conversationCwd;
    existing.panel.reveal(existing.panel.viewColumn, false);
    existing.panel.webview.html = previewHtml(
      await readTranscript(tool, file),
      newNonce(),
      assets(existing.panel.webview),
      { status: existing.status },
    );
    return;
  }

  const transcript = await readTranscript(tool, file);
  const panel = vscode.window.createWebviewPanel(
    "sessionBackup.preview",
    transcript.title,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media],
    },
  );
  const state = { panel, status, sessionId, conversationCwd };
  panels.set(file, state);
  panel.onDidDispose(() => panels.delete(file));
  panel.webview.onDidReceiveMessage(async (message) => {
    if (message?.command === "reload") {
      // 對話還在進行時，重新讀檔就能看到後續內容。
      panel.webview.html = previewHtml(
        await readTranscript(tool, file),
        newNonce(),
        assets(panel.webview),
        { status: state.status },
      );
    } else if (
      message?.command === "open" &&
      typeof message.path === "string"
    ) {
      await openReferencedFile(message.path, message.line, transcript.cwd);
    } else if (message?.command === "open-conversation") {
      await openSessionConversation(
        tool,
        state.sessionId,
        state.conversationCwd,
        handoffStorageRoot,
      );
    }
  });
  panel.webview.html = previewHtml(
    transcript,
    newNonce(),
    assets(panel.webview),
    {
      status: state.status,
    },
  );
}

/**
 * 使用 AI 擴充套件本身的 session 入口，不複製成新對話：
 * Claude Code 必須在 session 所屬專案的 extension host 中開啟；Codex 則開啟
 * VS Code Chat Sessions 使用的 resource。
 */
async function openSessionConversation(
  tool: Tool,
  sessionId: string,
  conversationCwd: string | undefined,
  handoffStorageRoot: string,
): Promise<void> {
  let target: ReturnType<typeof conversationOpenTarget>;
  try {
    target = conversationOpenTarget(tool, sessionId);
    const extension = vscode.extensions.getExtension(target.extensionId);
    if (!extension) {
      vscode.window.showWarningMessage(
        `Session Backup: 尚未安裝 ${target.toolName} 擴充套件，無法開啟這份對話。`,
      );
      return;
    }
    if (target.kind === "command") {
      const currentCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!sameConversationWorkspace(conversationCwd, currentCwd)) {
        if (!conversationCwd || !isDirectory(conversationCwd)) {
          vscode.window.showWarningMessage(
            "Session Backup: 找不到這份 Claude 對話所屬的本機專案，請先在「管理專案映射」指定資料夾。",
          );
          return;
        }

        // Claude 的 session loader 以 extension host 第一個 workspace folder 為查詢範圍。
        // 先留下 handoff，新專案視窗中的 Session Backup 啟動後會自行領取並開啟。
        await queueClaudeConversationHandoff(
          handoffStorageRoot,
          sessionId,
          conversationCwd,
        );
        await vscode.commands.executeCommand(
          "vscode.openFolder",
          vscode.Uri.file(conversationCwd),
          { forceNewWindow: true },
        );
        return;
      }

      await extension.activate();
      await vscode.commands.executeCommand(target.command, ...target.args);
      return;
    }

    await extension.activate();
    const resource = vscode.Uri.from({
      scheme: target.scheme,
      authority: target.authority,
      path: target.path,
    });
    try {
      await vscode.commands.executeCommand(
        "vscode.openWith",
        resource,
        target.viewType,
        {
          preserveFocus: false,
          preview: false,
        },
      );
    } catch {
      // 舊版 Codex 若沒有 conversation custom editor，仍可走它註冊的 /local/:id URI。
      const opened = await vscode.env.openExternal(
        vscode.Uri.from({
          scheme: vscode.env.uriScheme,
          authority: target.extensionId,
          path: target.fallbackPath,
        }),
      );
      if (!opened) {
        throw new Error("VS Code 無法處理 Codex 對話 URI");
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? `：${error.message}` : "";
    const toolName = tool === "claude" ? "Claude Code" : "Codex";
    vscode.window.showErrorMessage(
      `Session Backup: 無法在 ${toolName} 開啟這份對話${detail}`,
    );
  }
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 對話裡的檔案連結多半是專案內的相對路徑，以這份對話當時的工作目錄為基準解析。
 * 找不到檔案就只提示，不要開出一個空白的新檔。
 */
async function openReferencedFile(
  target: string,
  line: unknown,
  cwd: string | undefined,
): Promise<void> {
  const candidates = path.isAbsolute(target)
    ? [target]
    : [
        ...(cwd ? [path.resolve(cwd, target)] : []),
        ...(vscode.workspace.workspaceFolders ?? []).map((folder) =>
          path.resolve(folder.uri.fsPath, target),
        ),
      ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    vscode.window.showWarningMessage(`Session Backup: 找不到 ${target}`);
    return;
  }
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.file(found),
  );
  const number = Number(line);
  const position =
    Number.isFinite(number) && number > 0
      ? new vscode.Position(Math.min(number - 1, document.lineCount - 1), 0)
      : undefined;
  await vscode.window.showTextDocument(document, {
    preview: true,
    selection: position ? new vscode.Range(position, position) : undefined,
  });
}

function newNonce(): string {
  return Math.random().toString(36).slice(2);
}
