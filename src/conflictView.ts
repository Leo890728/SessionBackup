import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { renderSessionMarkdown, Tool } from "./sessions";

export type ConflictChoice = "A" | "B" | "skip";

export interface ConflictViewInput {
  tool: Tool;
  sessionId: string;
  aFile: string;
  aMachine: string;
  bFile: string;
  bMachine: string;
}

export async function showConflictComparison(input: ConflictViewInput): Promise<ConflictChoice> {
  const [aMarkdown, bMarkdown, aStat, bStat] = await Promise.all([
    renderSessionMarkdown(input.tool, input.aFile),
    renderSessionMarkdown(input.tool, input.bFile),
    fs.promises.stat(input.aFile),
    fs.promises.stat(input.bFile),
  ]);
  const panel = vscode.window.createWebviewPanel(
    "sessionBackup.conflict",
    `Session 衝突：${input.sessionId}`,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = conflictHtml(input, aMarkdown, bMarkdown, aStat, bStat);

  return new Promise<ConflictChoice>((resolve) => {
    let settled = false;
    const finish = (choice: ConflictChoice) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(choice);
      panel.dispose();
    };
    panel.webview.onDidReceiveMessage((message) => {
      if (message?.choice === "A" || message?.choice === "B" || message?.choice === "skip") {
        finish(message.choice);
      }
    });
    panel.onDidDispose(() => {
      if (!settled) {
        settled = true;
        resolve("skip");
      }
    });
  });
}

function conflictHtml(
  input: ConflictViewInput,
  aMarkdown: string,
  bMarkdown: string,
  aStat: fs.Stats,
  bStat: fs.Stats
): string {
  const nonce = Math.random().toString(36).slice(2);
  const meta = (machine: string, file: string, stat: fs.Stats) =>
    `${escapeHtml(machine)} · ${escapeHtml(new Date(stat.mtimeMs).toLocaleString())} · ` +
    `${formatBytes(stat.size)} · ${escapeHtml(path.basename(file))}`;
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root { color-scheme: light dark; }
    html, body { height: 100%; }
    body { margin: 0; display: flex; flex-direction: column; overflow: hidden; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
    header { flex: none; padding: 10px 16px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    header h1 { font-size: 15px; margin: 0 0 4px; }
    header p { margin: 0; color: var(--vscode-descriptionForeground); font-size: 12px; }
    /* min-height: 0 是關鍵：沒有它，grid/flex 子元素不會小於內容高度，
       pre 永遠不會出現捲軸，內容會直接溢出蓋到 footer 上。 */
    .compare { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 1fr; }
    .side { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
    .side + .side { border-left: 1px solid var(--vscode-panel-border); }
    .side-title { flex: none; padding: 9px 14px; background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-panel-border); font-weight: 600; }
    .side-title small { display: block; margin-top: 4px; color: var(--vscode-descriptionForeground); font-weight: normal; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    pre { flex: 1; min-height: 0; overflow: auto; box-sizing: border-box; margin: 0; padding: 16px; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--vscode-font-family); font-size: 13px; line-height: 1.55; }
    footer { flex: none; background: var(--vscode-editor-background); border-top: 1px solid var(--vscode-panel-border); display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; }
    .actions { display: flex; gap: 8px; }
    button { border: 1px solid var(--vscode-button-border, transparent); padding: 7px 14px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    label { color: var(--vscode-descriptionForeground); font-size: 12px; }
    @media (max-width: 760px) { .compare { grid-template-columns: 1fr; grid-template-rows: 1fr 1fr; } .side + .side { border-left: 0; border-top: 1px solid var(--vscode-panel-border); } }
  </style>
</head>
<body>
  <header><div><h1>Session 分支衝突</h1><p>${escapeHtml(input.tool)} · ${escapeHtml(input.sessionId)} · 關閉視窗等同跳過這次</p></div></header>
  <main class="compare">
    <section class="side"><div class="side-title">A：遠端版本<small>${meta(input.aMachine, input.aFile, aStat)}</small></div><pre id="a">${escapeHtml(aMarkdown)}</pre></section>
    <section class="side"><div class="side-title">B：本機版本<small>${meta(input.bMachine, input.bFile, bStat)}</small></div><pre id="b">${escapeHtml(bMarkdown)}</pre></section>
  </main>
  <footer>
    <label><input id="sync-scroll" type="checkbox" checked> 同步捲動</label>
    <div class="actions"><button data-choice="A">保留 A</button><button data-choice="B">保留 B</button><button class="secondary" data-choice="skip">跳過這次</button></div>
  </footer>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const a = document.getElementById('a'); const b = document.getElementById('b'); const sync = document.getElementById('sync-scroll'); let active = false;
    function mirror(from, to) { if (!sync.checked || active) return; active = true; const maxFrom = from.scrollHeight - from.clientHeight; const maxTo = to.scrollHeight - to.clientHeight; to.scrollTop = maxFrom > 0 ? (from.scrollTop / maxFrom) * maxTo : 0; active = false; }
    a.addEventListener('scroll', () => mirror(a, b)); b.addEventListener('scroll', () => mirror(b, a));
    document.querySelectorAll('button[data-choice]').forEach((button) => button.addEventListener('click', () => vscode.postMessage({ choice: button.dataset.choice })));
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
