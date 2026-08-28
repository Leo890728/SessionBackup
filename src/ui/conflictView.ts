import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { escapeHtml } from "../render/htmlEscape";
import { Tool } from "../agents/types";
import { readTranscript } from "../agents/transcript";
import type { Transcript } from "../agents/types";
import {
  SESSION_PREVIEW_STYLE,
  sessionThreadHtml,
} from "../render/sessionPreviewHtml";

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
  const [aTranscript, bTranscript, aStat, bStat] = await Promise.all([
    readTranscript(input.tool, input.aFile),
    readTranscript(input.tool, input.bFile),
    fs.promises.stat(input.aFile),
    fs.promises.stat(input.bFile),
  ]);
  const panel = vscode.window.createWebviewPanel(
    "sessionBackup.conflict",
    `Session 衝突：${input.sessionId}`,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = conflictHtml(
    input,
    aTranscript,
    bTranscript,
    aStat,
    bStat
  );

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
  aTranscript: Transcript,
  bTranscript: Transcript,
  aStat: fs.Stats,
  bStat: fs.Stats
): string {
  const nonce = Math.random().toString(36).slice(2);
  const toolName = input.tool === "claude" ? "Claude Code" : "Codex";
  const sharedTurns = sharedTurnCount(aTranscript, bTranscript);
  const meta = (machine: string, file: string, stat: fs.Stats) =>
    `${escapeHtml(machine)} · ${escapeHtml(new Date(stat.mtimeMs).toLocaleString())} · ` +
    `${formatBytes(stat.size)} · ${escapeHtml(path.basename(file))}`;
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>${SESSION_PREVIEW_STYLE}${CONFLICT_STYLE}</style>
</head>
<body>
  <div class="page conflict-page tool-${input.tool}">
    <div class="sticky-header">
      <header class="topbar">
        <div class="topbar-main">
          <h1>${escapeHtml(bTranscript.title || aTranscript.title)}</h1>
          <p>分支衝突 · ${escapeHtml(input.sessionId)}</p>
        </div>
        <div class="topbar-side">
          <span class="conflict-status">衝突</span>
          <span class="badge badge-${input.tool}">${toolName}</span>
        </div>
      </header>
    </div>
    <main class="compare" aria-label="Session 版本比較">
      <section class="side" aria-labelledby="remote-title">
        <div class="side-header">
          <div class="side-heading">
            <span class="version-mark" aria-hidden="true">A</span>
            <h2 id="remote-title">遠端版本</h2>
          </div>
          <p title="${escapeHtml(input.aFile)}">${meta(input.aMachine, input.aFile, aStat)}</p>
        </div>
        <div id="a" class="side-scroll" tabindex="0">
          <div class="side-thread">${sessionThreadHtml(aTranscript, "remote-")}<div class="tail-spacer" aria-hidden="true"></div></div>
        </div>
      </section>
      <section class="side" aria-labelledby="local-title">
        <div class="side-header">
          <div class="side-heading">
            <span class="version-mark" aria-hidden="true">B</span>
            <h2 id="local-title">本機版本</h2>
          </div>
          <p title="${escapeHtml(input.bFile)}">${meta(input.bMachine, input.bFile, bStat)}</p>
        </div>
        <div id="b" class="side-scroll" tabindex="0">
          <div class="side-thread">${sessionThreadHtml(bTranscript, "local-")}<div class="tail-spacer" aria-hidden="true"></div></div>
        </div>
      </section>
    </main>
    <footer class="actionbar">
      <label class="sync-control"><input id="sync-scroll" type="checkbox" checked> <span>同步捲動</span></label>
      <div class="actions">
        <button class="choice-button" data-choice="A" type="button">保留遠端</button>
        <button class="choice-button primary" data-choice="B" type="button">保留本機</button>
        <button class="secondary" data-choice="skip" type="button">跳過這次</button>
      </div>
    </footer>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const a = document.getElementById('a');
    const b = document.getElementById('b');
    const sync = document.getElementById('sync-scroll');
    const sharedTurnCount = ${sharedTurns};
    const scrollEpsilon = 0.01;

    function setHeight(el, px) {
      if (Math.abs((parseFloat(el.style.height) || 0) - px) > 0.5) {
        el.style.height = px + 'px';
      }
    }

    // Lazily create (or reuse, on later passes) a blank filler element right
    // after a turn, sized to make up whatever height difference that turn
    // has from its counterpart in the other pane.
    function spacerAfter(turn) {
      let spacer = turn.nextElementSibling;
      if (!spacer || !spacer.classList.contains('turn-spacer')) {
        spacer = document.createElement('div');
        spacer.className = 'turn-spacer';
        spacer.setAttribute('aria-hidden', 'true');
        turn.after(spacer);
      }
      return spacer;
    }

    // Shared turns are byte-for-byte identical content, but can still render
    // a few pixels taller or shorter on one side than the other -- a
    // timestamp that happens to wrap differently is enough. Padding each
    // pair to match, turn by turn, keeps the two panes pixel-aligned all the
    // way through the shared prefix. Then the two branches' unique tails get
    // padded the same way (the .tail-spacer already in the template) so the
    // two panes end up with the exact same total height, period -- the same
    // trick VS Code's diff editor uses (blank filler on whichever side has
    // no corresponding content), rather than reconciling differently-sized
    // regions with anchor or proportional math at scroll time. Once both
    // panes are truly the same height throughout, syncing scroll is just
    // copying scrollTop directly.
    function alignPanes() {
      const turnsA = Array.from(a.querySelectorAll('.turn'));
      const turnsB = Array.from(b.querySelectorAll('.turn'));
      const shared = Math.min(sharedTurnCount, turnsA.length, turnsB.length);
      for (let i = 0; i < shared; i++) {
        const heightA = turnsA[i].getBoundingClientRect().height;
        const heightB = turnsB[i].getBoundingClientRect().height;
        setHeight(spacerAfter(turnsA[i]), Math.max(0, heightB - heightA));
        setHeight(spacerAfter(turnsB[i]), Math.max(0, heightA - heightB));
      }

      const tailSpacerA = a.querySelector('.tail-spacer');
      const tailSpacerB = b.querySelector('.tail-spacer');
      // Reset before reading scrollHeight: it's the pane's own previous
      // filler, and has to come out before we can measure real content.
      tailSpacerA.style.height = '0px';
      tailSpacerB.style.height = '0px';
      const maxA = Math.max(0, a.scrollHeight - a.clientHeight);
      const maxB = Math.max(0, b.scrollHeight - b.clientHeight);
      const max = Math.max(maxA, maxB);
      tailSpacerA.style.height = (max - maxA) + 'px';
      tailSpacerB.style.height = (max - maxB) + 'px';
    }

    function mirror(from, to) {
      if (Math.abs(to.scrollTop - from.scrollTop) < scrollEpsilon) return;
      to.scrollTop = from.scrollTop;
    }

    alignPanes();
    const resizeObserver = new ResizeObserver(alignPanes);
    resizeObserver.observe(a);
    resizeObserver.observe(b);
    resizeObserver.observe(a.querySelector('.side-thread'));
    resizeObserver.observe(b.querySelector('.side-thread'));

    // Driving the sync off 'scroll' events means trusting the browser to
    // dispatch one for every visible change, at the same rate on both panes.
    // Under a fast/inertial scroll it doesn't: events get batched unevenly,
    // so the passive pane's updates can arrive less often than the active
    // pane's own compositor-smoothed motion, and it visibly falls behind
    // right as it closes in on its own scroll limit. Polling both positions
    // every animation frame instead reads ground truth directly, with no
    // dependency on how many (or how few) 'scroll' events the browser chose
    // to deliver in between.
    let prevA = a.scrollTop;
    let prevB = b.scrollTop;
    function pollFrame() {
      if (sync.checked) {
        const deltaA = Math.abs(a.scrollTop - prevA);
        const deltaB = Math.abs(b.scrollTop - prevB);
        if (deltaA > scrollEpsilon || deltaB > scrollEpsilon) {
          // Normally only one side moves between frames. If both appear to
          // (e.g. our own previous write to the passive side is still
          // settling), the one that moved further is almost certainly the
          // one the user is actually driving.
          if (deltaA >= deltaB) mirror(a, b);
          else mirror(b, a);
        }
      }
      prevA = a.scrollTop;
      prevB = b.scrollTop;
      requestAnimationFrame(pollFrame);
    }
    requestAnimationFrame(pollFrame);

    document.querySelectorAll('button[data-choice]').forEach((button) => button.addEventListener('click', () => vscode.postMessage({ choice: button.dataset.choice })));
  </script>
</body>
</html>`;
}

function sharedTurnCount(a: Transcript, b: Transcript): number {
  const aTurns = a.messages.filter((message) => message.role !== "notice");
  const bTurns = b.messages.filter((message) => message.role !== "notice");
  const limit = Math.min(aTurns.length, bTurns.length);
  let count = 0;
  while (
    count < limit &&
    aTurns[count].role === bTurns[count].role &&
    JSON.stringify(aTurns[count].blocks) === JSON.stringify(bTurns[count].blocks)
  ) {
    count++;
  }
  return count;
}

const CONFLICT_STYLE = `
html, body, .conflict-page { height: 100%; }
body { overflow: hidden; }
.conflict-page {
  display: flex;
  min-width: 0;
  flex-direction: column;
}
.conflict-page .sticky-header { position: relative; flex: none; }
.conflict-status {
  padding: 3px 9px;
  border: 1px solid var(--modified);
  border-radius: 999px;
  color: var(--modified);
  font-size: 11px;
  line-height: 1.7;
  white-space: nowrap;
}
.compare {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 1px;
  background: var(--border);
}
.side {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}
.side-header {
  flex: none;
  padding: 10px 18px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
.side-heading { display: flex; align-items: center; gap: 9px; }
.side-heading h2 { margin: 0; font-size: 13px; font-weight: 600; line-height: 1.5; }
.version-mark {
  display: inline-grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border: 1px solid var(--accent);
  border-radius: 6px;
  color: var(--accent);
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
}
.side-header p {
  margin: 3px 0 0 31px;
  overflow: hidden;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.side-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  /* auto (not smooth): a smooth scroll-behavior would turn each programmatic
     scrollTop write below into a multi-frame animation, firing a burst of
     'scroll' events instead of one — breaking the guard that tells a pane's
     own writes apart from the user's input. */
  scroll-behavior: auto;
  padding: 24px 20px 44px;
  scrollbar-gutter: stable;
  overscroll-behavior: contain;
}
.side-scroll:focus-visible {
  outline: 2px solid var(--vscode-focusBorder, var(--accent));
  outline-offset: -2px;
}
.side-thread { width: 100%; max-width: 42rem; margin: 0 auto; }
.side-thread .turn { margin-bottom: 24px; }
.side-thread .turn.user .bubble { max-width: 88%; }
/* Filled in by script to keep a shared turn pixel-aligned with its
   counterpart in the other pane even when it renders a little taller or
   shorter there (a timestamp wrapping differently is enough) -- invisible,
   since both sides genuinely have the same content here. */
.turn-spacer { height: 0; }
/* Filled in by script to pad the shorter branch's tail up to the longer
   one's height -- same idea as VS Code's diff editor shading the side with
   no corresponding line, so it's visually clear there's nothing more here
   rather than the pane just looking frozen. */
.tail-spacer {
  height: 0;
  opacity: 0.4;
  background: repeating-linear-gradient(
    135deg,
    transparent,
    transparent 7px,
    var(--muted) 7px,
    var(--muted) 8px
  );
}
.actionbar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
  background: var(--bg);
}
.sync-control {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.sync-control input { accent-color: var(--accent); }
.actions { display: flex; align-items: center; gap: 8px; }
.actionbar button { min-height: 32px; padding-inline: 14px; }
.actionbar button.primary {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--bg);
}
.actionbar button.primary:hover { filter: brightness(1.06); color: var(--bg); }
.actionbar button.secondary { color: var(--muted); }
@media (max-width: 760px) {
  .compare { grid-template-columns: 1fr; grid-template-rows: minmax(0, 1fr) minmax(0, 1fr); }
  .actionbar { align-items: flex-start; flex-direction: column; gap: 8px; }
  .actions { width: 100%; }
  .actions button { flex: 1 1 0; }
}
@media (max-width: 520px) {
  .conflict-page .topbar { align-items: flex-start; }
  .conflict-page .topbar-side { flex-direction: column; align-items: flex-end; }
  .side-scroll { padding-inline: 14px; }
  .actions { flex-wrap: wrap; }
  .actions button { min-width: calc(50% - 4px); }
}
@media (prefers-reduced-motion: reduce) {
  .actionbar button:active { transform: none; }
}
`;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
