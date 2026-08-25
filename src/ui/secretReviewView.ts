/**
 * 疑似金鑰的逐一確認面板。
 *
 * 仿 Windows 複製檔案的衝突視窗：一次只問一個 session，並提供「後續全部比照辦理」。
 * 不用 showWarningMessage 的 modal 是因為它只有按鈕：沒有勾選框可以做「套用到後續」，
 * detail 也只能放純文字，使用者看不到命中的那一段長什麼樣，等於要他盲猜是不是誤判。
 */

import * as vscode from "vscode";
import { escapeHtml } from "../render/htmlEscape";
import { SecretFinding } from "../security/secretScan";

export type SecretDecision = "skip" | "deselect" | "backup";

export interface SecretReviewItem {
  /** 回傳的決定以此為鍵；呼叫端目前用 session 檔案路徑。 */
  key: string;
  toolLabel: string;
  displayName: string;
  fileName: string;
  findings: SecretFinding[];
}

export interface SecretReview {
  /** 面板已經開著時把它帶到前景，而不是再開一個。 */
  reveal(): void;
  /** undefined＝使用者取消整次備份（含直接關掉面板）。 */
  decisions: Promise<Map<string, SecretDecision> | undefined>;
}

/** 一個 session 最多列幾筆命中；同一個 session 命中十幾種格式時畫面會爆掉。 */
const MAX_FINDINGS_SHOWN = 8;

export function reviewSessionSecrets(items: SecretReviewItem[]): SecretReview {
  const panel = vscode.window.createWebviewPanel(
    "sessionBackup.secretReview",
    "Session Backup：疑似金鑰確認",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = reviewHtml(items);

  const decisions = new Promise<Map<string, SecretDecision> | undefined>((resolve) => {
    let settled = false;
    const finish = (result: Map<string, SecretDecision> | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
      panel.dispose();
    };
    panel.webview.onDidReceiveMessage((message) => {
      if (message?.type === "cancel") {
        finish(undefined);
        return;
      }
      if (message?.type !== "done" || !Array.isArray(message.decisions)) {
        return;
      }
      const map = new Map<string, SecretDecision>();
      for (const entry of message.decisions) {
        const index = Number(entry?.index);
        const decision = entry?.decision;
        const item = items[index];
        if (
          !item ||
          (decision !== "skip" && decision !== "deselect" && decision !== "backup")
        ) {
          continue;
        }
        map.set(item.key, decision);
      }
      finish(map);
    });
    // 關掉面板＝沒有做決定。備份庫沒有刪除機制，金鑰推上去就等於外流，
    // 所以「沒有答案」一律當成取消，不能預設放行。
    panel.onDidDispose(() => {
      if (!settled) {
        settled = true;
        resolve(undefined);
      }
    });
  });

  return { reveal: () => panel.reveal(undefined, false), decisions };
}

function findingHtml(finding: SecretFinding): string {
  return (
    "<li>" +
    `<div class="kind">${escapeHtml(finding.kind)}` +
    `<span class="line">第 ${finding.line} 行</span></div>` +
    `<pre class="excerpt">${escapeHtml(finding.before)}` +
    `<span class="secret">${escapeHtml(finding.match)}</span>` +
    `${escapeHtml(finding.after)}</pre></li>`
  );
}

function itemHtml(item: SecretReviewItem, index: number, total: number): string {
  const shown = item.findings.slice(0, MAX_FINDINGS_SHOWN);
  const rest = item.findings.length - shown.length;
  return (
    `<section class="item" data-index="${index}" hidden>` +
    `<div class="counter">${index + 1} / ${total}</div>` +
    `<h2>${escapeHtml(item.toolLabel)}「${escapeHtml(item.displayName)}」</h2>` +
    `<p class="file">${escapeHtml(item.fileName)}</p>` +
    `<ul class="findings">${shown.map(findingHtml).join("")}</ul>` +
    (rest > 0
      ? `<p class="more">還有 ${rest} 筆命中未列出（完整清單見輸出面板）。</p>`
      : "") +
    "</section>"
  );
}

function reviewHtml(items: SecretReviewItem[]): string {
  const nonce = Math.random().toString(36).slice(2);
  const body = items.map((item, index) => itemHtml(item, index, items.length)).join("");
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root { color-scheme: light dark; }
    html, body { height: 100%; }
    body { margin: 0; display: flex; flex-direction: column; overflow: hidden; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: 13px; }
    header { flex: none; padding: 12px 18px; border-bottom: 1px solid var(--vscode-panel-border); }
    header h1 { margin: 0 0 4px; font-size: 15px; }
    header p { margin: 0; color: var(--vscode-descriptionForeground); font-size: 12px; }
    /* min-height: 0 讓 main 真的能縮小並長出捲軸，不然內容會溢出蓋到 footer。 */
    main { flex: 1; min-height: 0; overflow: auto; padding: 16px 18px; }
    .counter { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 6px; }
    .item h2 { margin: 0 0 4px; font-size: 14px; }
    .file { margin: 0 0 14px; color: var(--vscode-descriptionForeground); font-size: 12px; word-break: break-all; }
    .findings { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
    .findings li { border: 1px solid var(--vscode-panel-border); border-left: 3px solid var(--vscode-inputValidation-warningBorder, #b58900); padding: 8px 10px; }
    .kind { font-weight: 600; display: flex; gap: 10px; align-items: baseline; }
    .kind .line { font-weight: normal; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .excerpt { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; line-height: 1.5; color: var(--vscode-descriptionForeground); }
    .secret { color: var(--vscode-editor-foreground); background: var(--vscode-inputValidation-warningBackground, rgba(181, 137, 0, .25)); padding: 0 2px; }
    .more { color: var(--vscode-descriptionForeground); font-size: 12px; }
    footer { flex: none; border-top: 1px solid var(--vscode-panel-border); padding: 10px 18px; display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-left: auto; }
    button { border: 1px solid var(--vscode-button-border, transparent); padding: 7px 14px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; font-family: inherit; font-size: inherit; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    label { display: flex; align-items: center; gap: 6px; color: var(--vscode-descriptionForeground); font-size: 12px; }
    label[hidden] { display: none; }
  </style>
</head>
<body>
  <header>
    <h1>在 ${items.length} 個 session 偵測到疑似金鑰／憑證</h1>
    <p>備份庫沒有刪除機制，推上去就等於外流。關閉此視窗等同取消整次備份。</p>
  </header>
  <main id="items">${body}</main>
  <footer>
    <label id="apply-rest-label"><input id="apply-rest" type="checkbox"> 後續 <span id="rest-count"></span> 個都這樣處理</label>
    <div class="actions">
      <button data-decision="skip">跳過此次</button>
      <button class="secondary" data-decision="deselect">取消追蹤</button>
      <button class="secondary" data-decision="backup">仍要備份</button>
      <button class="secondary" data-cancel="1">取消整次備份</button>
    </div>
  </footer>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const total = ${items.length};
    const sections = Array.from(document.querySelectorAll('.item'));
    const applyRest = document.getElementById('apply-rest');
    const applyRestLabel = document.getElementById('apply-rest-label');
    const restCount = document.getElementById('rest-count');
    const main = document.getElementById('items');
    const decisions = [];
    let index = 0;

    function show() {
      sections.forEach((section, i) => { section.hidden = i !== index; });
      const rest = total - index - 1;
      applyRestLabel.hidden = rest <= 0;
      applyRest.checked = false;
      restCount.textContent = String(rest);
      main.scrollTop = 0;
    }

    function choose(decision) {
      if (applyRest.checked) {
        for (let i = index; i < total; i++) { decisions.push({ index: i, decision: decision }); }
        index = total;
      } else {
        decisions.push({ index: index, decision: decision });
        index++;
      }
      if (index >= total) {
        vscode.postMessage({ type: 'done', decisions: decisions });
        return;
      }
      show();
    }

    document.querySelectorAll('button[data-decision]').forEach(function (button) {
      button.addEventListener('click', function () { choose(button.dataset.decision); });
    });
    document.querySelectorAll('button[data-cancel]').forEach(function (button) {
      button.addEventListener('click', function () { vscode.postMessage({ type: 'cancel' }); });
    });
    show();
  </script>
</body>
</html>`;
}
