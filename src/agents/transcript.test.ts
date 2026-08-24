import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { readTranscript } from "./transcript";

describe("readTranscript", () => {
  const withClaudeFile = async (records: unknown[], run: (file: string) => Promise<void>) => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "transcript-"));
    const file = path.join(dir, "claude.jsonl");
    try {
      await fs.promises.writeFile(
        file,
        records.map((record) => JSON.stringify(record)).join("\n") + "\n",
        "utf8"
      );
      await run(file);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  };

  it("merges consecutive assistant records so tool calls stay in their turn", async () => {
    await withClaudeFile(
      [
        { aiTitle: "測試對話", cwd: "C:\\work" },
        { type: "user", message: { content: "幫我看一下" }, timestamp: "2026-07-30T01:00:00Z" },
        {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "我先讀檔案。" },
              { type: "tool_use", name: "Read", input: { file_path: "C:\\work\\a.ts" } },
            ],
          },
        },
        // 工具結果是 user 紀錄，預覽不顯示，也不該切斷助理的這一輪
        { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "看完了。" }] } },
      ],
      async (file) => {
        const transcript = await readTranscript("claude", file);
        assert.equal(transcript.title, "測試對話");
        assert.equal(transcript.cwd, "C:\\work");
        assert.deepEqual(
          transcript.messages.map((message) => message.role),
          ["user", "assistant"]
        );
        assert.deepEqual(transcript.messages[1].blocks, [
          { kind: "text", text: "我先讀檔案。" },
          { kind: "tool", name: "Read", detail: "C:\\work\\a.ts" },
          { kind: "text", text: "看完了。" },
        ]);
      }
    );
  });

  it("keeps interrupted turns apart instead of merging them into one bubble", async () => {
    await withClaudeFile(
      [
        { type: "user", message: { content: "第一句" } },
        { type: "user", message: { content: "[Request interrupted by user]" } },
        { type: "user", message: { content: "第二句" } },
      ],
      async (file) => {
        const transcript = await readTranscript("claude", file);
        assert.deepEqual(
          transcript.messages.map((message) => [message.role, message.blocks[0]]),
          [
            ["user", { kind: "text", text: "第一句" }],
            ["notice", { kind: "text", text: "使用者中斷了這次回覆" }],
            ["user", { kind: "text", text: "第二句" }],
          ]
        );
      }
    );
  });

  it("keeps thinking blocks and skips injected meta prompts", async () => {
    await withClaudeFile(
      [
        { type: "user", message: { content: "<system-reminder>忽略我</system-reminder>" } },
        { type: "user", isMeta: true, message: { content: "也忽略我" } },
        {
          type: "assistant",
          message: { content: [{ type: "thinking", thinking: "先想一下" }] },
        },
      ],
      async (file) => {
        const transcript = await readTranscript("claude", file);
        assert.deepEqual(transcript.messages, [
          {
            role: "assistant",
            blocks: [{ kind: "thinking", text: "先想一下" }],
            timestamp: undefined,
            // 第三筆紀錄（前兩筆是被略過的 meta 提問）。
            sourceLine: 2,
          },
        ]);
      }
    );
  });
});

describe("readTranscript (codex)", () => {
  const id = "019f121b-aa1f-7e52-abd5-3ad11ea8c256";
  const withCodexFile = async (
    records: unknown[],
    run: (file: string) => Promise<void>,
    threadName = "Codex 對話"
  ) => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-transcript-"));
    const dir = path.join(root, "sessions", "2026", "07", "14");
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(
        path.join(root, "session_index.jsonl"),
        JSON.stringify({ id, thread_name: threadName }) + "\n",
        "utf8"
      );
      const file = path.join(dir, `rollout-2026-07-14T00-00-00-${id}.jsonl`);
      await fs.promises.writeFile(
        file,
        records.map((record) => JSON.stringify(record)).join("\n") + "\n",
        "utf8"
      );
      await run(file);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  };
  const item = (payload: unknown, timestamp?: string) => ({
    type: "response_item",
    payload,
    timestamp,
  });
  const userText = (text: string) => ({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  });
  const assistantText = (text: string) => ({
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
  });

  it("collapses a turn's progress into a work block and keeps the last answer", async () => {
    await withCodexFile(
      [
        { type: "session_meta", payload: { session_id: id, cwd: "C:\\work" } },
        item(userText("幫我修好"), "2026-07-14T01:00:00Z"),
        item(
          { type: "reasoning", summary: [{ type: "summary_text", text: "先看檔案" }] },
          "2026-07-14T01:00:01Z"
        ),
        item(assistantText("我先讀檔。"), "2026-07-14T01:00:02Z"),
        item(
          {
            type: "function_call",
            name: "shell",
            arguments: JSON.stringify({ command: "ls -la" }),
          },
          "2026-07-14T01:00:03Z"
        ),
        item(assistantText("修好了。"), "2026-07-14T01:00:04Z"),
        { type: "event_msg", payload: { type: "task_complete", duration_ms: 4200 } },
      ],
      async (file) => {
        const transcript = await readTranscript("codex", file);
        assert.equal(transcript.title, "Codex 對話");
        assert.equal(transcript.cwd, "C:\\work");
        assert.deepEqual(
          transcript.messages.map((message) => message.role),
          ["user", "assistant"]
        );
        assert.deepEqual(transcript.messages[1], {
          role: "assistant",
          timestamp: "2026-07-14T01:00:01Z",
          // 這一輪從 reasoning 那筆開始（session_meta、提問各佔一筆）。
          sourceLine: 2,
          blocks: [
            {
              kind: "work",
              durationMs: 4200,
              items: [
                { kind: "thinking", text: "先看檔案" },
                { kind: "text", text: "我先讀檔。" },
                { kind: "tool", name: "shell", detail: "ls -la" },
              ],
            },
            { kind: "text", text: "修好了。" },
          ],
        });
      }
    );
  });

  it("starts a new turn on the next question when the record has no task_complete", async () => {
    await withCodexFile(
      [
        item(userText("第一問")),
        item(assistantText("答一")),
        item(userText("第二問")),
        item(assistantText("答二")),
      ],
      async (file) => {
        const transcript = await readTranscript("codex", file);
        assert.deepEqual(
          transcript.messages.map((message) => [message.role, message.blocks]),
          [
            ["user", [{ kind: "text", text: "第一問" }]],
            ["assistant", [{ kind: "text", text: "答一" }]],
            ["user", [{ kind: "text", text: "第二問" }]],
            ["assistant", [{ kind: "text", text: "答二" }]],
          ]
        );
      }
    );
  });

  it("wraps a turn that never answered in text entirely into work", async () => {
    await withCodexFile(
      [item({ type: "local_shell_call", action: { command: "npm test" } })],
      async (file) => {
        const transcript = await readTranscript("codex", file);
        assert.deepEqual(transcript.messages[0].blocks, [
          {
            kind: "work",
            durationMs: undefined,
            items: [{ kind: "tool", name: "shell", detail: "npm test" }],
          },
        ]);
      }
    );
  });
});
