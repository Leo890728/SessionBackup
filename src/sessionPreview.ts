import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { readTranscript, Tool } from "./sessions";
import { previewHtml } from "./sessionPreviewHtml";

/** 同一份對話重複開啟時沿用既有面板，預覽才不會把編輯器塞滿分頁。 */
const panels = new Map<string, vscode.WebviewPanel>();

export async function showSessionPreview(
  tool: Tool,
  file: string,
  extensionUri: vscode.Uri
): Promise<void> {
  const media = vscode.Uri.joinPath(extensionUri, "media");
  const assets = (webview: vscode.Webview) => ({
    iconUri: webview.asWebviewUri(vscode.Uri.joinPath(media, `${tool}.png`)).toString(),
    imageSource: webview.cspSource,
  });

  const existing = panels.get(file);
  if (existing) {
    existing.reveal(existing.viewColumn, false);
    existing.webview.html = previewHtml(
      await readTranscript(tool, file),
      newNonce(),
      assets(existing.webview)
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
    }
  );
  panels.set(file, panel);
  panel.onDidDispose(() => panels.delete(file));
  panel.webview.onDidReceiveMessage(async (message) => {
    if (message?.command === "reload") {
      // 對話還在進行時，重新讀檔就能看到後續內容。
      panel.webview.html = previewHtml(
        await readTranscript(tool, file),
        newNonce(),
        assets(panel.webview)
      );
    } else if (message?.command === "open" && typeof message.path === "string") {
      await openReferencedFile(message.path, message.line, transcript.cwd);
    }
  });
  panel.webview.html = previewHtml(transcript, newNonce(), assets(panel.webview));
}

/**
 * 對話裡的檔案連結多半是專案內的相對路徑，以這份對話當時的工作目錄為基準解析。
 * 找不到檔案就只提示，不要開出一個空白的新檔。
 */
async function openReferencedFile(
  target: string,
  line: unknown,
  cwd: string | undefined
): Promise<void> {
  const candidates = path.isAbsolute(target)
    ? [target]
    : [
        ...(cwd ? [path.resolve(cwd, target)] : []),
        ...(vscode.workspace.workspaceFolders ?? []).map((folder) =>
          path.resolve(folder.uri.fsPath, target)
        ),
      ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    vscode.window.showWarningMessage(`Session Backup: 找不到 ${target}`);
    return;
  }
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(found));
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
