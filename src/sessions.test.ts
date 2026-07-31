import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  claudeAiTitle,
  clearSessionCache,
  codexSessionInfo,
  listCodexFiles,
  extractUserContext,
  readClaudeMetadata,
  readTranscript,
} from "./sessions";

describe("claudeAiTitle", () => {
  it("uses the aiTitle property", () => {
    assert.equal(
      claudeAiTitle([
        { type: "summary", summary: "舊摘要" },
        { aiTitle: "  Claude 產生的標題  " },
      ]),
      "Claude 產生的標題"
    );
  });

  it("does not fall back to summary or user content", () => {
    assert.equal(
      claudeAiTitle([
        { type: "summary", summary: "摘要" },
        { type: "user", message: { content: "第一句" } },
      ]),
      undefined
    );
  });
});

describe("readClaudeMetadata", () => {
  it("finds aiTitle after the first 256 KiB", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "session-backup-"));
    const file = path.join(dir, "claude.jsonl");
    try {
      const filler = JSON.stringify({ type: "user", message: { content: "x".repeat(1024) } });
      const content = [
        JSON.stringify({ type: "user", sessionId: "sess-1" }),
        ...Array.from({ length: 300 }, () => filler),
        JSON.stringify({ aiTitle: "後段的 Claude 標題", cwd: "C:\\work\\project" }),
      ].join("\n");
      assert.ok(Buffer.byteLength(content, "utf8") > 262144);
      await fs.promises.writeFile(file, content, "utf8");

      assert.deepEqual(await readClaudeMetadata(file), {
        aiTitle: "後段的 Claude 標題",
        cwd: "C:\\work\\project",
        sessionId: "sess-1",
      });
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Codex titles", () => {
  it("uses thread_name from session_index.jsonl", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-sessions-"));
    const sessions = path.join(root, "sessions", "2026", "07", "14");
    const id = "019f121b-aa1f-7e52-abd5-3ad11ea8c256";
    try {
      await fs.promises.mkdir(sessions, { recursive: true });
      await fs.promises.writeFile(
        path.join(root, "session_index.jsonl"),
        JSON.stringify({ id, thread_name: "Codex 索引標題" }) + "\n",
        "utf8"
      );
      await fs.promises.writeFile(
        path.join(sessions, `rollout-2026-07-14T00-00-00-${id}.jsonl`),
        JSON.stringify({
          type: "session_meta",
          payload: { session_id: id, cwd: "C:\\work" },
        }) + "\n",
        "utf8"
      );

      const files = await listCodexFiles(path.join(root, "sessions"));
      assert.equal(files.length, 1);
      assert.equal(files[0].title, "Codex 索引標題");
      assert.equal((await codexSessionInfo(files[0])).title, "Codex 索引標題");
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});

describe("codexSessionInfo session_meta 規則", () => {
  /** 用一行 session_meta 造出 rollout 檔，回傳 codexSessionInfo 的判讀結果。 */
  async function infoFromMeta(
    payload: Record<string, unknown> | undefined,
    cf: { id: string; title?: string }
  ) {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-meta-"));
    try {
      const file = path.join(root, `rollout-${cf.id}.jsonl`);
      await fs.promises.writeFile(
        file,
        payload ? JSON.stringify({ type: "session_meta", payload }) + "\n" : "",
        "utf8"
      );
      const stat = await fs.promises.stat(file);
      clearSessionCache();
      return await codexSessionInfo({
        file,
        id: cf.id,
        title: cf.title,
        date: "2026-07-14",
        mtime: stat.mtimeMs,
        size: stat.size,
      });
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  }

  it("新版 session_meta：session_id 同時是 UI id 與備份 id", async () => {
    const info = await infoFromMeta(
      { session_id: "thread-1", id: "ignored-when-session-id-exists", cwd: "C:\\work" },
      { id: "file-uuid" }
    );
    assert.equal(info.id, "thread-1");
    assert.equal(info.backupId, "thread-1");
    assert.equal(info.cwd, "C:\\work");
    assert.equal(info.parentThreadId, undefined);
  });

  it("舊版 session_meta：沒有 session_id 時退回 payload.id", async () => {
    const info = await infoFromMeta({ id: "legacy-thread", cwd: "C:\\work" }, { id: "file-uuid" });
    assert.equal(info.id, "legacy-thread");
    assert.equal(info.backupId, "legacy-thread");
  });

  it("子代理檔：UI id 用自身 payload.id，備份 id 用父 thread 的 session_id", async () => {
    const info = await infoFromMeta(
      {
        session_id: "parent-1",
        id: "own-1",
        parent_thread_id: "parent-1",
        cwd: "C:\\work",
        source: { subagent: { other: "guardian" } },
      },
      { id: "file-uuid" }
    );
    // 兩者刻意不同：壓成同一欄位會讓子代理「勾了卻備份不到」。
    assert.equal(info.id, "own-1");
    assert.equal(info.backupId, "parent-1");
    assert.equal(info.parentThreadId, "parent-1");
    assert.equal(info.subagent, "guardian");
    assert.equal(info.title, "子代理：guardian");
  });

  it("子代理檔的 payload.id 與父 thread 相同時，UI id 退回檔名 uuid", async () => {
    const info = await infoFromMeta(
      { session_id: "parent-1", id: "parent-1", parent_thread_id: "parent-1" },
      { id: "file-uuid" }
    );
    assert.equal(info.id, "file-uuid");
    assert.equal(info.backupId, "parent-1");
  });

  it("完全沒有 session_meta 時兩個 id 都退回檔名 uuid", async () => {
    const info = await infoFromMeta(undefined, { id: "file-uuid" });
    assert.equal(info.id, "file-uuid");
    assert.equal(info.backupId, "file-uuid");
    assert.equal(info.cwd, undefined);
  });
});

describe("extractUserContext", () => {
  it("pulls the opened file out of the question", () => {
    const { contexts, rest } = extractUserContext(
      "<ide_opened_file>The user opened the file d:\\work\\App\\project.md in the IDE. " +
        "This may or may not be related to the current task.</ide_opened_file>\n" +
        "規劃討論還有一個問題"
    );
    assert.deepEqual(contexts, [{ label: "開啟檔案", detail: "d:\\work\\App\\project.md" }]);
    assert.equal(rest, "規劃討論還有一個問題");
  });

  it("drops injected system reminders anywhere in the text", () => {
    const { contexts, rest } = extractUserContext(
      "先做 A\n<system-reminder>這是注入的提醒</system-reminder>\n再做 B"
    );
    assert.deepEqual(contexts, []);
    assert.equal(rest, "先做 A\n\n再做 B");
  });

  it("reports an empty question when only IDE context was sent", () => {
    const { contexts, rest } = extractUserContext(
      "<ide_selection>selected lines in d:\\work\\a.ts</ide_selection>"
    );
    assert.equal(contexts.length, 1);
    assert.equal(rest, "");
  });
});

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

describe("groupCodexThreads", () => {
  const { groupCodexThreads } = require("./sessions") as typeof import("./sessions");
  const info = (
    id: string,
    file: string,
    mtime: number,
    parentThreadId?: string
  ) => ({
    tool: "codex" as const,
    file,
    id,
    backupId: parentThreadId ?? id,
    mtime,
    size: 1,
    title: id,
    date: "2026-07-14",
    time: "10:00",
    parentThreadId,
  });

  it("attaches sub threads to the newest rollout file of the parent thread", () => {
    const parentOld = info("p1", "C:\\s\\p1-old.jsonl", 100);
    const parentNew = info("p1", "C:\\s\\p1-new.jsonl", 200);
    const subA = info("s-a", "C:\\s\\sub-a.jsonl", 150, "p1");
    const subB = info("s-b", "C:\\s\\sub-b.jsonl", 160, "p1");
    const { topLevel, subsByHost } = groupCodexThreads([
      parentOld,
      subA,
      parentNew,
      subB,
    ]);
    assert.deepEqual(
      topLevel.map((s) => s.file),
      [parentOld.file, parentNew.file]
    );
    assert.deepEqual(
      subsByHost.get(parentNew.file)?.map((s) => s.id),
      ["s-b", "s-a"]
    );
    assert.equal(subsByHost.get(parentOld.file), undefined);
  });

  it("hides sub threads whose parent file is missing", () => {
    const orphan = info("s-x", "C:\\s\\sub-x.jsonl", 100, "missing-parent");
    const { topLevel, subsByHost, orphans } = groupCodexThreads([orphan]);
    assert.deepEqual(topLevel, []);
    assert.equal(subsByHost.size, 0);
    assert.deepEqual(orphans, [orphan]);
  });

  it("supports nested sub threads", () => {
    const parent = info("p1", "C:\\s\\p1.jsonl", 100);
    const child = info("c1", "C:\\s\\c1.jsonl", 110, "p1");
    const grandchild = info("g1", "C:\\s\\g1.jsonl", 120, "c1");
    const { topLevel, subsByHost } = groupCodexThreads([parent, child, grandchild]);
    assert.deepEqual(topLevel, [parent]);
    assert.deepEqual(subsByHost.get(parent.file)?.map((s) => s.id), ["c1"]);
    assert.deepEqual(subsByHost.get(child.file)?.map((s) => s.id), ["g1"]);
  });
});
