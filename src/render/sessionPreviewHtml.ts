import * as path from "path";
import { escapeHtml } from "./htmlEscape";
import { renderMarkdown } from "./markdownHtml";
import { Transcript, TranscriptBlock, TranscriptMessage } from "../agents/types";
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
  /**
   * 已備份內容在這個檔案裡的長度（JSONL 紀錄數）。橫桿掛在第一則由更後面的
   * 紀錄產生的訊息之前；沒給就當作 0，也就是整份都算新的。
   */
  backedUpRecords?: number;
  /**
   * 這份對話能不能在 AI 那邊開起來。專案還沒對應時不行——本機沒有那個工作目錄；
   * 待匯入的更是連檔案都不在 ~/.claude／~/.codex 裡，讀的是備份庫裡的 revision。
   * 這種時候「在對話開啟」只會跳警告，不如不要出現。沒給就當作可以開。
   */
  openable?: boolean;
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
  const imageSource = assets.imageSource ? ` img-src ${assets.imageSource};` : "";
  const divider = state ? DIVIDERS[state.status] : undefined;
  const statusDivider = divider
    ? `<div class="status-divider tone-${divider.tone}" role="separator" aria-label="${divider.label}">
      <div class="status-divider-inner"><span>${divider.label}</span></div>
    </div>`
    : "";
  const questions = questionEntries(transcript.messages);
  const body = threadHtml(
    transcript.messages,
    avatar,
    statusDivider,
    state?.backedUpRecords ?? 0
  );
  const rail = questionRailHtml(questions) + currentQuestionHtml(questions);
  const openConversationButton =
    state?.openable === false
      ? ""
      : `<button id="open-conversation" class="conversation-button" type="button" title="在 ${toolName} 開啟此 session">在對話開啟</button>`;

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
  </div>
  <main class="thread">
    ${body}
    <footer class="source">${escapeHtml(path.basename(transcript.file))}</footer>
  </main>
  ${rail}
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    // 標題列高度會隨標題換行改變，量到多少就讓橫桿黏在多少的位置。
    const header = document.querySelector('.sticky-header');
    const syncHeaderHeight = () =>
      document.documentElement.style.setProperty('--header-h', header.offsetHeight + 'px');
    syncHeaderHeight();
    new ResizeObserver(syncHeaderHeight).observe(header);
    // 開啟時停在最新的訊息：對話是往下長的，最後一則幾乎都是使用者要看的那則。
    window.scrollTo({ top: document.body.scrollHeight });
    document.getElementById('reload').addEventListener('click', () => vscode.postMessage({ command: 'reload' }));
    document.getElementById('open-conversation')?.addEventListener('click', () => vscode.postMessage({ command: 'open-conversation' }));
    document.addEventListener('click', (event) => {
      const link = event.target.closest('a.file-link');
      if (!link) return;
      event.preventDefault();
      vscode.postMessage({ command: 'open', path: link.dataset.path, line: link.dataset.line });
    });
    // 右側提問面板：滑鼠移開就收回去，點手把可以固定展開。
    const rail = document.getElementById('question-rail');
    if (rail) {
      const handle = document.getElementById('rail-handle');
      const pill = document.getElementById('current-question');
      const pillIndex = pill.querySelector('.cq-index');
      const pillText = pill.querySelector('.cq-text');
      const statusDivider = document.querySelector('.status-divider');
      const items = Array.from(rail.querySelectorAll('.rail-item'));
      const targets = items.map((item) => document.getElementById(item.dataset.target));
      // 收合要自己來：點過的按鈕還留著 focus，光靠 CSS 的 :focus-within 會縮不回去。
      const collapse = () => {
        rail.classList.remove('is-open', 'is-keyboard');
        rail.classList.add('is-dismissed');
        handle.setAttribute('aria-expanded', 'false');
      };
      handle.addEventListener('click', () => {
        const open = rail.classList.toggle('is-open');
        handle.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (!open) handle.blur();
      });
      // 只有鍵盤走進來才撐開；滑鼠點出來的 focus 不算，否則放開滑鼠也收不回去。
      rail.addEventListener('focusin', (event) => {
        if (event.target.matches(':focus-visible')) rail.classList.add('is-keyboard');
      });
      rail.addEventListener('focusout', (event) => {
        if (!rail.contains(event.relatedTarget)) rail.classList.remove('is-keyboard');
      });
      rail.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        collapse();
        handle.blur();
      });
      // 指標每次進出都把「剛剛收起來」的記號清掉，下一次滑過才展得開。
      for (const type of ['pointerenter', 'pointerleave']) {
        rail.addEventListener(type, () => rail.classList.remove('is-dismissed'));
      }
      let flash;
      const jumpTo = (target) => {
        if (!target) return;
        // 捲到訊息上緣再讓開標題列，不然跳過去的那則會被標題列壓住。
        window.scrollTo({
          top: target.getBoundingClientRect().top + window.scrollY - header.offsetHeight - 16,
          behavior: 'smooth',
        });
        clearTimeout(flash);
        for (const marked of document.querySelectorAll('.turn.is-target')) {
          marked.classList.remove('is-target');
        }
        target.classList.add('is-target');
        flash = setTimeout(() => target.classList.remove('is-target'), 1600);
      };
      items.forEach((item, index) => {
        item.addEventListener('click', (event) => {
          jumpTo(targets[index]);
          // 用滑鼠點就順手收起來，跳過去的那則才不會被面板擋著；
          // 鍵盤（event.detail 為 0）則留著，不然 focus 會跑到看不見的地方。
          if (event.detail === 0) return;
          collapse();
          item.blur();
        });
      });
      pill.addEventListener('click', () => jumpTo(document.getElementById(pill.dataset.target)));
      // 捲動時標出目前看到的是第幾則提問，並把它貼在標題列底下。
      let pending = false;
      const markCurrent = () => {
        pending = false;
        const headerHeight = header.offsetHeight;
        let current = -1;
        targets.forEach((target, index) => {
          if (target && target.getBoundingClientRect().top <= headerHeight + 24) current = index;
        });
        items.forEach((item, index) => item.classList.toggle('is-current', index === current));
        // 橫桿黏在標題列底下時會佔掉那一條，標籤就往下讓一個橫桿的高度。
        const stuck =
          statusDivider && statusDivider.getBoundingClientRect().top <= headerHeight + 1
            ? statusDivider.offsetHeight
            : 0;
        pill.style.top = headerHeight + stuck + 8 + 'px';
        // 提問本身還看得到就不用貼，整則捲出上緣之後才顯示。
        const target = current < 0 ? undefined : targets[current];
        const show = !!target && target.getBoundingClientRect().bottom < headerHeight;
        if (show) {
          pillIndex.textContent = items[current].querySelector('.rail-index').textContent;
          pillText.textContent = items[current].querySelector('.rail-text').textContent;
          pill.dataset.target = items[current].dataset.target;
        }
        pill.classList.toggle('is-visible', show);
      };
      window.addEventListener(
        'scroll',
        () => {
          if (pending) return;
          pending = true;
          requestAnimationFrame(markCurrent);
        },
        { passive: true }
      );
      markCurrent();
    }
  </script>
</body>
</html>`;
}

/**
 * 訊息串，並把「新內容從這裡開始」的橫桿插在對的位置。
 *
 * 位置由產生訊息的那筆 JSONL 紀錄序號決定：第一則序號 >= 已備份長度的訊息之前。
 * 整份都還沒備份時 backedUpRecords 是 0，橫桿自然落在最上面；新內容不對應任何
 * 可顯示的訊息時（例如只多了標題紀錄）掛到最後，總比整條消失讓人以為沒事好。
 */
function threadHtml(
  messages: TranscriptMessage[],
  avatar: string,
  divider: string,
  backedUpRecords: number
): string {
  if (!messages.length) {
    return divider + '<p class="empty">這份對話沒有可顯示的訊息。</p>';
  }
  const parts: string[] = [];
  let placed = !divider;
  let questions = 0;
  for (const message of messages) {
    if (
      !placed &&
      message.sourceLine !== undefined &&
      message.sourceLine >= backedUpRecords
    ) {
      parts.push(divider);
      placed = true;
    }
    parts.push(
      messageHtml(
        message,
        avatar,
        message.role === "user" ? questionAnchorId(questions++) : undefined
      )
    );
  }
  if (!placed) {
    parts.push(divider);
  }
  return parts.join("\n");
}

function messageHtml(
  message: TranscriptMessage,
  avatar: string,
  questionId?: string
): string {
  const time = formatTime(message.timestamp);
  const blocks = message.blocks.map(blockHtml).join("\n");
  if (message.role === "notice") {
    return `<div class="notice">${message.blocks
      .map((block) => (block.kind === "text" ? escapeHtml(block.text) : ""))
      .join("")}</div>`;
  }
  if (message.role === "user") {
    return `<article class="turn user"${questionId ? ` id="${questionId}"` : ""}>
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

/** 側邊提問面板的一筆，對應訊息串上的一則使用者訊息。 */
interface QuestionEntry {
  /** 訊息 article 的 id，點清單就是捲到它。 */
  id: string;
  /** 第幾次提問，從 1 開始。 */
  ordinal: number;
  summary: string;
}

/**
 * 提問清單。編號規則與 threadHtml 掛 anchor 的規則一致（依出現順序數使用者訊息），
 * 兩邊才對得起來。
 */
function questionEntries(messages: TranscriptMessage[]): QuestionEntry[] {
  const entries: QuestionEntry[] = [];
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    entries.push({
      id: questionAnchorId(entries.length),
      ordinal: entries.length + 1,
      summary: questionSummary(message),
    });
  }
  return entries;
}

function questionAnchorId(index: number): string {
  return `q${index}`;
}

/**
 * 摘要只要認得出是哪則提問就夠：取文字內容壓成一行，並拿掉 markdown 記號。
 * 只夾帶 IDE 上下文的提問沒有文字可取，就用那個檔案的路徑當標示。
 */
function questionSummary(message: TranscriptMessage, max = 80): string {
  const text = message.blocks
    .map((block) => (block.kind === "text" ? block.text : ""))
    .join(" ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    const context = message.blocks.find((block) => block.kind === "context");
    return context && context.kind === "context"
      ? shortPath(context.detail, 40)
      : "（沒有文字內容）";
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * 貼在右緣的提問清單：平常只露出手把，滑過才滑出來。對話一長，要回到自己問過的
 * 某一題就得一路往回捲，這條就是那個捷徑。
 */
function questionRailHtml(questions: QuestionEntry[]): string {
  if (!questions.length) {
    return "";
  }
  const items = questions
    .map(
      (question) =>
        `<li><button class="rail-item" type="button" data-target="${question.id}" title="${escapeHtml(
          question.summary
        )}"><span class="rail-index">${question.ordinal}</span><span class="rail-text">${escapeHtml(
          question.summary
        )}</span></button></li>`
    )
    .join("\n");
  return `<aside id="question-rail" class="question-rail" aria-label="提問清單">
    <button id="rail-handle" class="rail-handle" type="button" aria-expanded="false" aria-controls="question-list" title="提問清單（點一下固定展開）">
      <span class="rail-grip" aria-hidden="true"></span>
      <span class="rail-handle-label">提問 ${questions.length}</span>
    </button>
    <div class="rail-body">
      <ol id="question-list" class="rail-list">
        ${items}
      </ol>
    </div>
  </aside>`;
}

/**
 * 捲過一則提問之後，把它貼在標題列底下的小標籤，點了就回到那則。
 * 內容由腳本填，這裡只留空殼；用 fixed 浮在對話上而不佔版面高度，
 * 否則它一出現就把內容往下推，推完又變成「還看得到提問」而自己閃掉。
 */
function currentQuestionHtml(questions: QuestionEntry[]): string {
  if (!questions.length) {
    return "";
  }
  return `<button id="current-question" class="current-question" type="button" title="回到這則提問">
    <span class="cq-index" aria-hidden="true"></span>
    <span class="cq-text"></span>
  </button>`;
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
/*
 * 橫桿落在對話流裡「已備份到哪裡」的位置，但捲過它之後黏在標題列底下，
 * 才不會一往下捲就忘了自己在分界的哪一邊。--header-h 由腳本量標題列高度後寫入。
 */
.status-divider {
  position: sticky;
  top: var(--header-h, 56px);
  z-index: 1;
  padding: 10px 24px 12px;
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
/*
 * 提問清單貼在右緣，平常只露出手把；滑過或用鍵盤 focus 進去才滑出來，
 * 免得一直蓋著對話。點手把可以固定展開，捲清單時就不會一離開手把就收回去。
 */
.question-rail {
  position: fixed;
  top: 50%;
  right: 0;
  z-index: 3;
  display: flex;
  align-items: stretch;
  max-height: min(70vh, 620px);
  transform: translate(calc(100% - 26px), -50%);
  transition: transform 0.22s ease;
}
.question-rail:hover:not(.is-dismissed),
.question-rail.is-keyboard,
.question-rail.is-open { transform: translate(0, -50%); }
.rail-handle {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: 26px;
  padding: 14px 0;
  border-right: 0;
  border-radius: 10px 0 0 10px;
  color: var(--muted);
  font-size: 11px;
  letter-spacing: 0.08em;
}
.rail-handle-label { writing-mode: vertical-rl; white-space: nowrap; }
.rail-grip {
  flex: none;
  width: 3px;
  height: 20px;
  border-radius: 999px;
  background: currentColor;
  opacity: 0.55;
}
.question-rail:hover:not(.is-dismissed) .rail-handle,
.question-rail.is-keyboard .rail-handle,
.question-rail.is-open .rail-handle { border-color: var(--accent); color: var(--accent); }
.rail-body {
  width: 272px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-right: 0;
  border-radius: 12px 0 0 12px;
  background: var(--surface);
  box-shadow: -10px 0 26px rgba(0, 0, 0, 0.14);
}
.rail-list { margin: 0; padding: 8px; list-style: none; }
.rail-item {
  display: flex;
  gap: 9px;
  width: 100%;
  padding: 7px 9px;
  border: 0;
  border-left: 2px solid transparent;
  border-radius: 8px;
  background: none;
  color: var(--text);
  text-align: left;
  line-height: 1.45;
}
.rail-item:hover { border-color: transparent; border-left-color: var(--accent); background: var(--bubble); color: var(--text); }
.rail-item:active { transform: none; }
.rail-item.is-current { border-left-color: var(--accent); color: var(--accent); }
.rail-index {
  flex: none;
  width: 1.8em;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}
.rail-item.is-current .rail-index { color: var(--accent); }
.rail-text {
  min-width: 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 12.5px;
}
/* 跳過去之後閃一下，才看得出停在哪一則。 */
.turn.user.is-target .bubble {
  box-shadow: 0 0 0 2px var(--accent);
  transition: box-shadow 0.4s ease;
}
/* 貼在標題列底下的「目前這一題」，太長就截成 …。 */
.current-question {
  position: fixed;
  left: 50%;
  top: calc(var(--header-h, 56px) + 8px);
  z-index: 2;
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: fit-content;
  max-width: min(46rem, calc(100% - 48px));
  padding: 5px 15px;
  border-radius: 999px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.14);
  font-size: 12.5px;
  color: var(--muted);
  opacity: 0;
  pointer-events: none;
  transform: translate(-50%, -6px);
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.current-question.is-visible { opacity: 1; pointer-events: auto; transform: translate(-50%, 0); }
/* 通用的 :active 位移會把置中的 translate 蓋掉，這裡自己補一組。 */
.current-question:active { transform: translate(-50%, 1px); }
.cq-index { flex: none; font-size: 11px; font-variant-numeric: tabular-nums; color: var(--accent); }
.cq-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 620px) {
  .rail-body { width: 200px; }
}
@media (prefers-reduced-motion: reduce) {
  .question-rail, .current-question { transition: none; }
}

.empty { color: var(--muted); text-align: center; padding: 48px 0; }
.source { margin-top: 40px; font-size: 11px; color: var(--muted); text-align: center; }
`;
