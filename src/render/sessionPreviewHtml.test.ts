import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Transcript } from "../agents/types";
import { formatDuration, previewHtml } from "./sessionPreviewHtml";

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
    assert.ok(html.includes('<article class="turn user">'));
    assert.ok(html.includes('<div class="bubble">'));
    assert.ok(html.includes('<article class="turn assistant">'));
    assert.ok(html.includes("1 次提問"));
    assert.ok(html.includes("2 則訊息"));
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

  it("marks a newly added conversation with a green sticky divider", () => {
    const added = previewHtml(transcript([]), "n0", {}, { status: "unbacked" });
    assert.ok(
      added.includes(
        '<div class="status-divider tone-added" role="separator" aria-label="對話新增">'
      )
    );
    assert.ok(added.includes("<span>對話新增</span>"));
    assert.ok(added.includes(".sticky-header {\n  position: sticky;"));
    assert.ok(added.indexOf('class="topbar"') < added.indexOf('class="status-divider'));
    assert.ok(added.indexOf('class="status-divider') < added.indexOf('class="thread"'));
  });

  it("marks a changed conversation with a yellow sticky divider", () => {
    const modified = previewHtml(transcript([]), "n0", {}, { status: "modified" });
    assert.ok(
      modified.includes(
        '<div class="status-divider tone-modified" role="separator" aria-label="新對話">'
      )
    );
    assert.ok(modified.includes("<span>新對話</span>"));
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
});
