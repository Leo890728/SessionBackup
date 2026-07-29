import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { readCodexSessionIndex, upsertCodexSessionTitle } from "./codexIndex";

describe("Codex session index", () => {
  it("reads thread_name by session id", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-index-"));
    const file = path.join(dir, "session_index.jsonl");
    try {
      await fs.promises.writeFile(
        file,
        '{"id":"session-1","thread_name":"  索引標題  ","updated_at":"2026-07-14T00:00:00Z"}\n',
        "utf8"
      );
      assert.deepEqual((await readCodexSessionIndex(file)).get("session-1"), {
        id: "session-1",
        thread_name: "索引標題",
        updated_at: "2026-07-14T00:00:00Z",
      });
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it("merges a restored title without removing other entries", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-index-"));
    const file = path.join(dir, "session_index.jsonl");
    try {
      await fs.promises.writeFile(
        file,
        '{"id":"local","thread_name":"B 的紀錄"}\n',
        "utf8"
      );
      assert.equal(
        await upsertCodexSessionTitle(
          file,
          "remote",
          "A 的紀錄",
          "2026-07-14T01:00:00Z"
        ),
        true
      );
      const entries = await readCodexSessionIndex(file);
      assert.equal(entries.get("local")?.thread_name, "B 的紀錄");
      assert.equal(entries.get("remote")?.thread_name, "A 的紀錄");
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("upsertCodexSessionTitle newer-wins", () => {
  const { upsertCodexSessionTitle, readCodexSessionIndex } =
    require("./codexIndex") as typeof import("./codexIndex");

  it("does not overwrite a locally newer title with an older remote one", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-index-"));
    const file = path.join(dir, "session_index.jsonl");
    try {
      await fs.promises.writeFile(
        file,
        JSON.stringify({ id: "t1", thread_name: "本機較新標題", updated_at: "2026-07-15T10:00:00Z" }) + "\n"
      );
      const changed = await upsertCodexSessionTitle(file, "t1", "遠端舊標題", "2026-07-10T00:00:00Z");
      assert.equal(changed, false);
      const index = await readCodexSessionIndex(file);
      assert.equal(index.get("t1")?.thread_name, "本機較新標題");
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it("adopts the remote title when it is newer", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-index-"));
    const file = path.join(dir, "session_index.jsonl");
    try {
      await fs.promises.writeFile(
        file,
        JSON.stringify({ id: "t1", thread_name: "舊標題", updated_at: "2026-07-01T00:00:00Z" }) + "\n"
      );
      const changed = await upsertCodexSessionTitle(file, "t1", "遠端新標題", "2026-07-15T00:00:00Z");
      assert.equal(changed, true);
      const index = await readCodexSessionIndex(file);
      assert.equal(index.get("t1")?.thread_name, "遠端新標題");
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });
});
