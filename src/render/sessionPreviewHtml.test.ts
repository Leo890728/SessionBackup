import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Transcript } from "../agents/types";
import { formatDuration, previewHtml, sessionThreadHtml } from "./sessionPreviewHtml";

describe("previewHtml", () => {
  const transcript = (messages: Transcript["messages"]): Transcript => ({
    tool: "claude",
    file: "C:\\work\\sessions\\s1.jsonl",
    title: "測試對話",
    cwd: "C:\\work",
    messages,
  });

  it("renders user turns as bubbles and assistant turns as plain body", () => {
    const html = previewHtml(
      transcript([
        { role: "user", blocks: [{ kind: "text", text: "你好" }] },
        { role: "assistant", blocks: [{ kind: "text", text: "哈囉" }] },
      ]),
      "n0"
    );
    assert.ok(html.includes('<article class="turn user" id="q0">'));
    assert.ok(html.includes('<div class="bubble">'));
    assert.ok(html.includes('<article class="turn assistant">'));
    assert.ok(html.includes("1 次提問"));
    assert.ok(html.includes("2 則訊息"));
  });

  it("reuses the conversation layout with unique conflict-side anchors", () => {
    const value = transcript([
      { role: "user", blocks: [{ kind: "text", text: "要保留哪一份？" }] },
      { role: "assistant", blocks: [{ kind: "text", text: "比較內容" }] },
    ]);
    const remote = sessionThreadHtml(value, "remote-");
    const local = sessionThreadHtml(value, "local-");

    assert.ok(remote.includes('<article class="turn user" id="remote-q0">'));
    assert.ok(local.includes('<article class="turn user" id="local-q0">'));
    assert.ok(remote.includes('<div class="bubble">'));
    assert.ok(remote.includes('<article class="turn assistant">'));
    assert.equal(remote.includes('id="local-q0"'), false);
  });

  it("never emits raw markup from the conversation", () => {
    const html = previewHtml(
      transcript([
        { role: "user", blocks: [{ kind: "text", text: "<script>alert(1)</script>" }] },
        {
          role: "assistant",
          blocks: [{ kind: "tool", name: "<img onerror=x>", detail: '"><b>' }],
        },
      ]),
      "n0"
    );
    assert.equal(html.includes("<script>alert(1)</script>"), false);
    assert.equal(html.includes("<img onerror=x>"), false);
    assert.ok(html.includes("&lt;script&gt;"));
    // 只有面板自己的 script 標籤，而且帶著 nonce
    assert.equal(html.split("<script").length - 1, 1);
    assert.ok(html.includes('<script nonce="n0">'));
  });

  it("restricts the webview to inline styles and the nonced script", () => {
    const html = previewHtml(transcript([]), "n1");
    assert.ok(
      html.includes(
        "content=\"default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-n1';\""
      )
    );
    assert.ok(html.includes("這份對話沒有可顯示的訊息。"));
  });

  it("folds the work of a turn and labels it with the duration", () => {
    const html = previewHtml(
      transcript([
        {
          role: "assistant",
          blocks: [
            {
              kind: "work",
              durationMs: 104457,
              items: [
                { kind: "text", text: "我先檢查專案技術棧" },
                { kind: "tool", name: "shell", detail: "ls" },
              ],
            },
            { kind: "text", text: "已完成。" },
          ],
        },
      ]),
      "n0"
    );
    assert.ok(html.includes("<summary>工作過程 · 1m 44s</summary>"));
    assert.ok(html.indexOf("我先檢查專案技術棧") < html.indexOf("已完成。"));
  });

  it("uses the tool icon and colour when assets are provided", () => {
    const codex: Transcript = {
      ...transcript([{ role: "assistant", blocks: [{ kind: "text", text: "好" }] }]),
      tool: "codex",
    };
    const html = previewHtml(codex, "n0", {
      iconUri: "https://file+.vscode-resource/media/codex.png",
      imageSource: "vscode-resource:",
    });
    assert.ok(html.includes('<div class="page tool-codex">'));
    assert.ok(html.includes("img-src vscode-resource:;"));
    assert.ok(html.includes('src="https://file+.vscode-resource/media/codex.png"'));
    assert.ok(html.includes("Codex"));
  });

  it("formats durations the way Codex does", () => {
    assert.equal(formatDuration(13218), "13s");
    assert.equal(formatDuration(104457), "1m 44s");
    assert.equal(formatDuration(3_930_000), "1h 5m");
  });

  it("puts thinking behind a collapsed section", () => {
    const html = previewHtml(
      transcript([{ role: "assistant", blocks: [{ kind: "thinking", text: "先想想" }] }]),
      "n0"
    );
    assert.ok(html.includes('<details class="thinking"><summary>思考過程</summary>'));
  });

  it("puts the added divider above everything when nothing was backed up yet", () => {
    const added = previewHtml(
      transcript([
        { role: "user", blocks: [{ kind: "text", text: "第一個提問" }], sourceLine: 0 },
      ]),
      "n0",
      {},
      { status: "unbacked" }
    );
    assert.ok(
      added.includes(
        '<div class="status-divider tone-added" role="separator" aria-label="對話新增">'
      )
    );
    assert.ok(added.indexOf('class="status-divider') < added.indexOf("第一個提問"));
  });

  it("puts the changed divider where the backed up content ends", () => {
    // 前兩筆紀錄已經備份過，橫桿要落在第三筆產生的那則訊息之前，不是最上面。
    const html = previewHtml(
      transcript([
        { role: "user", blocks: [{ kind: "text", text: "舊提問" }], sourceLine: 0 },
        { role: "assistant", blocks: [{ kind: "text", text: "舊回覆" }], sourceLine: 1 },
        { role: "user", blocks: [{ kind: "text", text: "新提問" }], sourceLine: 2 },
      ]),
      "n0",
      {},
      { status: "modified", backedUpRecords: 2 }
    );
    assert.ok(
      html.includes(
        '<div class="status-divider tone-modified" role="separator" aria-label="新對話">'
      )
    );
    assert.ok(html.indexOf("舊回覆") < html.indexOf('class="status-divider'));
    assert.ok(html.indexOf('class="status-divider') < html.indexOf("新提問"));
  });

  it("falls back to the end when the new records produced no visible message", () => {
    const html = previewHtml(
      transcript([
        { role: "user", blocks: [{ kind: "text", text: "舊提問" }], sourceLine: 0 },
      ]),
      "n0",
      {},
      { status: "modified", backedUpRecords: 5 }
    );
    assert.ok(html.indexOf("舊提問") < html.indexOf('class="status-divider'));
  });

  it("leaves out the divider for sessions the next backup will skip", () => {
    for (const status of ["synced", "unselected", "too-large"] as const) {
      const html = previewHtml(transcript([]), "n0", {}, { status });
      assert.equal(html.includes('class="status-divider'), false, status);
    }
    assert.equal(
      previewHtml(transcript([]), "n0").includes('class="status-divider'),
      false
    );
  });

  it("drops 在對話開啟 when the conversation cannot be opened", () => {
    const html = previewHtml(
      transcript([]),
      "n0",
      {},
      { status: "synced", openable: false }
    );
    assert.equal(html.includes('id="open-conversation"'), false);
    assert.equal(html.includes("在對話開啟"), false);
    // 重新整理照留：預覽本身照常可用。
    assert.ok(html.includes('id="reload"'));
  });

  it("shows native conversation actions regardless of sync status", () => {
    const synced = previewHtml(transcript([]), "n0", {}, { status: "synced" });
    assert.ok(synced.includes('id="reload" class="icon-button"'));
    assert.ok(synced.includes('aria-label="重新整理"'));
    assert.equal(synced.includes(">重新整理</button>"), false);
    assert.ok(synced.includes('id="open-conversation"'));
    assert.ok(synced.includes('title="在 Claude Code 開啟此 session"'));
    assert.ok(synced.includes("{ command: 'open-conversation' }"));

    for (const status of ["unbacked", "modified", "unselected", "too-large"] as const) {
      const html = previewHtml(transcript([]), "n0", {}, { status });
      assert.ok(html.includes('id="open-conversation"'), status);
    }

    assert.ok(previewHtml(transcript([]), "n0").includes('id="open-conversation"'));
  });

  it("lists every question in the side rail and anchors it to that turn", () => {
    const html = previewHtml(
      transcript([
        { role: "user", blocks: [{ kind: "text", text: "## 第一個提問" }] },
        { role: "assistant", blocks: [{ kind: "text", text: "回覆" }] },
        {
          role: "user",
          blocks: [{ kind: "context", label: "開啟中", detail: "/work/src/a.ts" }],
        },
      ]),
      "n0"
    );
    assert.ok(html.includes('<aside id="question-rail"'));
    assert.ok(html.includes('<article class="turn user" id="q0">'));
    assert.ok(html.includes('<article class="turn user" id="q1">'));
    assert.ok(html.includes('data-target="q0"'));
    assert.ok(html.includes('data-target="q1"'));
    // markdown 記號不進摘要，只夾帶上下文的提問則用檔案路徑代替
    assert.ok(html.includes(">第一個提問</span>"));
    assert.ok(html.includes("a.ts</span>"));
    assert.ok(html.includes("提問 2"));
    // 捲過提問後貼在標題列底下的標籤
    assert.ok(html.includes('id="current-question"'));
  });

  it("leaves out the rail when nobody asked anything", () => {
    const html = previewHtml(
      transcript([{ role: "assistant", blocks: [{ kind: "text", text: "只有回覆" }] }]),
      "n0"
    );
    assert.equal(html.includes('id="question-rail"'), false);
    assert.equal(html.includes('id="current-question"'), false);
  });
});
