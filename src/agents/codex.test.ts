import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { codexSessionInfo, listCodexFiles } from "./codex";
import { clearSessionCache } from "./sessionFile";

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

describe("groupCodexThreads", () => {
  const { groupCodexThreads } = require("./codex") as typeof import("./codex");
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
