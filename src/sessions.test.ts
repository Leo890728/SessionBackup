import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  claudeAiTitle,
  codexSessionInfo,
  listCodexFiles,
  readClaudeMetadata,
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
