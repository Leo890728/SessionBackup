import * as path from "path";
import { escapeHtml } from "./htmlEscape";
import { renderMarkdown } from "./markdownHtml";
import { Transcript, TranscriptBlock, TranscriptMessage } from "../agents/sessions";
import type { SessionSyncStatus } from "../store/sessionStatus";

/**
 * 對話預覽的 HTML。與 VS Code API 無關，方便單獨測試轉出來的標記。
 * 所有對話內容都經過 escapeHtml/renderMarkdown，webview 不會被內容注入標籤。
 */
export interface PreviewAssets {
  /** media/ 底下該工具圖示的 webview URI；沒有時退回文字標記。 */
  iconUri?: string;
  /** webview.cspSource，載入圖示需要。 */
  imageSource?: string;
}

export interface PreviewState {
  /** unbacked 代表 manifest 尚無此 session，modified 代表備份後又有新內容。 */
  status: SessionSyncStatus;
}

/**
 * 只有「下次備份會寫入」的兩種狀態要掛橫桿，顏色跟樹狀圖的 diff 圖示同一套：
 * 新增是綠色、已變更是黃色。其餘狀態不顯示。
 */
const DIVIDERS: Partial<Record<SessionSyncStatus, { tone: string; label: string }>> = {
  unbacked: { tone: "added", label: "對話新增" },
  modified: { tone: "modified", label: "新對話" },
};

export function previewHtml(
  transcript: Transcript,
  nonce: string,
  assets: PreviewAssets = {},
  state?: PreviewState
): string {
  const toolName = transcript.tool === "claude" ? "Claude Code" : "Codex";
  const turns = transcript.messages.filter((message) => message.role === "user").length;
  const meta = [
    `${turns} 次提問`,
    `${transcript.messages.length} 則訊息`,
    transcript.cwd ? escapeHtml(transcript.cwd) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const avatar = assets.iconUri
    ? `<img class="avatar" src="${escapeHtml(assets.iconUri)}" alt="">`
    : `<div class="avatar avatar-mark" aria-hidden="true">${
        transcript.tool === "claude" ? "✳" : "◇"
      }</div>`;
  const body =
    transcript.messages.map((message) => messageHtml(message, avatar)).join("\n") ||
    '<p class="empty">這份對話沒有可顯示的訊息。</p>';
  const imageSource = assets.imageSource ? ` img-src ${assets.imageSource};` : "";
  const divider = state ? DIVIDERS[state.status] : undefined;
  const statusDivider = divider
    ? `<div class="status-divider tone-${divider.tone}" role="separator" aria-label="${divider.label}">
      <div class="status-divider-inner"><span>${divider.label}</span></div>
    </div>`
    : "";
  const openConversationButton = `<button id="open-conversation" class="conversation-button" type="button" title="在 ${toolName} 開啟此 session">在對話開啟</button>`;

  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';${imageSource}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>${STYLE}</style>
</head>
<body>
  <div class="page tool-${transcript.tool}">
  <div class="sticky-header">
    <header class="topbar">
      <div class="topbar-main">
        <h1>${escapeHtml(transcript.title)}</h1>
        <p>${meta}</p>
      </div>
      <div class="topbar-side">
        <span class="badge badge-${transcript.tool}">${toolName}</span>
        <div class="topbar-actions">
          <button id="reload" class="icon-button" type="button" aria-label="重新整理" title="重新讀取原始檔">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
              <path d="M13.25 3.25v3.5h-3.5M12.82 6.45A5.25 5.25 0 1 0 13.2 9" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
          ${openConversationButton}
        </div>
      </div>
    </header>
    ${statusDivider}
  </div>
  <main class="thread">
    ${body}
    <footer class="source">${escapeHtml(path.basename(transcript.file))}</footer>
  </main>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('reload').addEventListener('click', () => vscode.postMessage({ command: 'reload' }));
    document.getElementById('open-conversation')?.addEventListener('click', () => vscode.postMessage({ command: 'open-conversation' }));
    document.addEventListener('click', (event) => {
      const link = event.target.closest('a.file-link');
      if (!link) return;
      event.preventDefault();
      vscode.postMessage({ command: 'open', path: link.dataset.path, line: link.dataset.line });
    });
  </script>
</body>
</html>`;
}

function messageHtml(message: TranscriptMessage, avatar: string): string {
  const time = formatTime(message.timestamp);
  const blocks = message.blocks.map(blockHtml).join("\n");
  if (message.role === "notice") {
    return `<div class="notice">${message.blocks
      .map((block) => (block.kind === "text" ? escapeHtml(block.text) : ""))
      .join("")}</div>`;
  }
  if (message.role === "user") {
    return `<article class="turn user">
      <div class="bubble">${blocks}</div>
      ${time ? `<div class="stamp">${time}</div>` : ""}
    </article>`;
  }
  return `<article class="turn assistant">
    ${avatar}
    <div class="body">
      ${blocks}
      ${time ? `<div class="stamp">${time}</div>` : ""}
    </div>
  </article>`;
}

function blockHtml(block: TranscriptBlock): string {
  if (block.kind === "text") {
    return `<div class="prose">${renderMarkdown(block.text)}</div>`;
  }
  if (block.kind === "thinking") {
    return `<details class="thinking"><summary>思考過程</summary><div class="prose">${renderMarkdown(
      block.text
    )}</div></details>`;
  }
  if (block.kind === "work") {
    // Codex 的一輪回覆中途會有多次進度說明，跟它自己的介面一樣收合起來。
    const label = block.durationMs ? `工作過程 · ${formatDuration(block.durationMs)}` : "工作過程";
    return `<details class="work"><summary>${label}</summary><div class="work-body">${block.items
      .map(blockHtml)
      .join("\n")}</div></details>`;
  }
  if (block.kind === "context") {
    return `<div class="context" title="${escapeHtml(
      `${block.label}：${block.detail}`
    )}"><span class="context-icon" aria-hidden="true">&lt;/&gt;</span><span class="context-path">${escapeHtml(
      shortPath(block.detail)
    )}</span></div>`;
  }
  return `<div class="tool"><span class="tool-name">${escapeHtml(block.name)}</span>${
    block.detail ? `<span class="tool-detail">${escapeHtml(block.detail)}</span>` : ""
  }</div>`;
}

/**
 * 路徑太長時砍掉前面留下尾端：同一個專案的前綴都一樣，檔名才是有用的部分。
 * 用程式裁而不是靠 CSS direction:rtl，避免 Windows 路徑的 `:` `\` 被雙向文字演算法重排。
 */
function shortPath(value: string, max = 46): string {
  return value.length > max ? "…" + value.slice(value.length - max + 1) : value;
}

/** 與 Codex 介面一致的長度標示：1m 44s、13s。 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatTime(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleString();
}

/**
 * 版面與配色模仿 Claude 的對話介面：暖白底、使用者訊息是靠右的圓角區塊、
 * 助理訊息不加外框直接排版。明暗色跟著 VS Code 主題切換（body 上的 vscode-* class）。
 */
const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #faf9f5;
  --surface: #ffffff;
  --text: #23221f;
  --muted: #79776f;
  --border: #e6e2d8;
  --bubble: #f0eee6;
  --accent: #c96442;
  --code-bg: #23221f;
  --code-text: #f2f0ea;
  --code-border: #35332f;
  --inline-code-bg: #efece2;
  --added: var(--vscode-gitDecoration-untrackedResourceForeground, #1f7a3d);
  --modified: var(--vscode-gitDecoration-modifiedResourceForeground, #895503);
}
body.vscode-dark, body.vscode-high-contrast {
  --bg: #262624;
  --surface: #30302e;
  --text: #f2f0ea;
  --muted: #a4a29a;
  --border: #3f3e3a;
  --bubble: #3a3a36;
  --accent: #e0906f;
  --code-bg: #1a1a19;
  --code-text: #eceae4;
  --code-border: #333330;
  --inline-code-bg: #45443f;
  --added: var(--vscode-gitDecoration-untrackedResourceForeground, #73d68b);
  --modified: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d);
}
/* 工具色掛在 .page 上而不是 body：body 的 class 由 VS Code 主題控制。 */
.page.tool-codex { --accent: #7c5cd6; }
body.vscode-dark .page.tool-codex, body.vscode-high-contrast .page.tool-codex { --accent: #b39dff; }
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: ui-sans-serif, -apple-system, "Segoe UI", "Noto Sans TC", "Microsoft JhengHei", sans-serif;
  font-size: 15px;
  line-height: 1.7;
}
.sticky-header {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--bg);
}
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 24px;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
}
.status-divider {
  padding: 7px 24px 9px;
  background: var(--bg);
}
.status-divider.tone-added { color: var(--added); }
.status-divider.tone-modified { color: var(--modified); }
.status-divider-inner {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  max-width: 46rem;
  margin: 0 auto;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.4;
  letter-spacing: 0.04em;
}
.status-divider-inner::before,
.status-divider-inner::after {
  content: "";
  height: 1px;
  flex: 1 1 auto;
  background: currentColor;
  opacity: 0.65;
}
.status-divider-inner span { flex: none; white-space: nowrap; }
body.vscode-high-contrast .status-divider-inner::before,
body.vscode-high-contrast .status-divider-inner::after { opacity: 1; }
.topbar h1 { margin: 0; font-size: 15px; font-weight: 600; }
.topbar p { margin: 2px 0 0; font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.topbar-main { min-width: 0; }
.topbar-side { display: flex; align-items: center; gap: 10px; flex: none; }
.topbar-actions { display: flex; align-items: center; gap: 8px; }
.badge {
  font-size: 11px;
  padding: 3px 9px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--muted);
  white-space: nowrap;
}
.badge { color: var(--accent); border-color: var(--accent); }
button {
  font: inherit;
  font-size: 12px;
  padding: 5px 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
}
button:hover { border-color: var(--accent); color: var(--accent); }
button:active { transform: translateY(1px); }
button:focus-visible {
  outline: 2px solid var(--vscode-focusBorder, var(--accent));
  outline-offset: 2px;
}
.icon-button {
  display: inline-grid;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
}
.icon-button svg { width: 16px; height: 16px; }
.conversation-button { height: 30px; white-space: nowrap; }

@media (max-width: 620px) {
  .topbar { align-items: flex-start; padding-inline: 16px; }
  .topbar-side { flex-wrap: wrap; justify-content: flex-end; }
  .status-divider { padding-inline: 16px; }
}

.thread { max-width: 46rem; margin: 0 auto; padding: 28px 24px 64px; }
.turn { margin: 0 0 28px; }
.turn.user { display: flex; flex-direction: column; align-items: flex-end; }
.turn.user .bubble {
  max-width: 85%;
  background: var(--bubble);
  border-radius: 18px;
  padding: 12px 18px;
}
.turn.assistant { display: flex; gap: 14px; align-items: flex-start; }
.avatar {
  flex: none;
  width: 26px;
  height: 26px;
  margin-top: 2px;
  border-radius: 50%;
  object-fit: contain;
  background: var(--surface);
  border: 1px solid var(--border);
}
/* 沒有圖示可載入時的替代標記 */
.avatar-mark {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  font-size: 14px;
  line-height: 24px;
  text-align: center;
}
.turn.assistant .body { min-width: 0; flex: 1; }
.stamp { margin-top: 6px; font-size: 11px; color: var(--muted); }

.prose > *:first-child { margin-top: 0; }
.prose > *:last-child { margin-bottom: 0; }
.prose p { margin: 0 0 12px; overflow-wrap: anywhere; }
.prose h3, .prose h4, .prose h5, .prose h6 { margin: 20px 0 8px; line-height: 1.4; }
.prose h3 { font-size: 1.15em; }
.prose h4 { font-size: 1.05em; }
.prose h5, .prose h6 { font-size: 1em; color: var(--muted); }
.prose ul, .prose ol { margin: 0 0 12px; padding-left: 22px; }
.prose li { margin: 4px 0; }
.prose blockquote {
  margin: 0 0 12px;
  padding: 2px 0 2px 14px;
  border-left: 2px solid var(--border);
  color: var(--muted);
}
.prose hr { border: 0; border-top: 1px solid var(--border); margin: 20px 0; }
.prose .table-wrap { margin: 0 0 14px; overflow-x: auto; }
.prose table { border-collapse: collapse; font-size: 0.92em; }
.prose th, .prose td {
  border: 1px solid var(--border);
  padding: 6px 11px;
  text-align: left;
  vertical-align: top;
}
.prose th { background: var(--bubble); font-weight: 600; white-space: nowrap; }
.prose a { color: var(--accent); }
.prose a.file-link {
  cursor: pointer;
  text-decoration: none;
  border-bottom: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 0.92em;
}
.prose a.file-link:hover { border-bottom-color: var(--accent); }

.prose .callout {
  margin: 0 0 14px;
  padding: 14px 16px 2px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
}
.prose .callout-label {
  display: inline-block;
  margin: 0 0 10px;
  padding: 2px 9px;
  border-radius: 999px;
  background: var(--bubble);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--accent);
}

.context {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  max-width: 100%;
  margin: 0 0 10px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  font-size: 12px;
  color: var(--muted);
}
.context-icon { flex: none; font-family: ui-monospace, Consolas, monospace; color: var(--accent); }
.context-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
}
.prose code {
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 0.88em;
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--inline-code-bg);
}
.prose pre.code {
  margin: 0 0 14px;
  padding: 14px 16px;
  border-radius: 12px;
  border: 1px solid var(--code-border);
  background: var(--code-bg);
  color: var(--code-text);
  overflow-x: auto;
}
.prose pre.code code { background: none; padding: 0; font-size: 0.85em; line-height: 1.6; }
/* 程式碼區塊在明暗主題下都是深底，所以一組 token 配色就夠。 */
.tc { color: #8c8880; font-style: italic; }
.ts { color: #a8cd8a; }
.tk { color: #c99bdd; }
.tn { color: #e8a06a; }
.tf { color: #7fb0e8; }
.tp { color: #6fc9bd; }
.tv { color: #e0868a; }
.tt { color: #e8c46a; }
.prose pre.code[data-lang]::before {
  content: attr(data-lang);
  display: block;
  margin-bottom: 8px;
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #9b978d;
}

.tool {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin: 0 0 8px;
  padding: 7px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  font-size: 12.5px;
}
.tool-name {
  flex: none;
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  color: var(--accent);
}
.tool-detail {
  color: var(--muted);
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.work { margin: 0 0 14px; }
.work > summary {
  cursor: pointer;
  display: inline-block;
  padding: 4px 11px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  font-size: 12px;
  color: var(--muted);
}
.work > summary:hover { border-color: var(--accent); color: var(--accent); }
.work[open] > summary { margin-bottom: 12px; }
.work-body { padding-left: 14px; border-left: 2px solid var(--border); }
.thinking { margin: 0 0 12px; }
.thinking summary { cursor: pointer; font-size: 12.5px; color: var(--muted); }
.thinking > .prose {
  margin-top: 8px;
  padding-left: 14px;
  border-left: 2px solid var(--border);
  color: var(--muted);
}

.notice {
  margin: 0 0 24px;
  font-style: italic;
  font-size: 13px;
  color: var(--muted);
}
.empty { color: var(--muted); text-align: center; padding: 48px 0; }
.source { margin-top: 40px; font-size: 11px; color: var(--muted); text-align: center; }
`;
