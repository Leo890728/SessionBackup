import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { scanSessionsForSecrets } from "./sessionSecretScan";
import { LocalSession } from "../store/sessionStore";

describe("scanSessionsForSecrets", () => {
  it("returns only sessions containing a suspected secret", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "session-secret-"));
    const safeFile = path.join(dir, "safe.jsonl");
    const riskyFile = path.join(dir, "risky.jsonl");
    try {
      await fs.promises.writeFile(safeFile, '{"message":"safe"}\n', "utf8");
      const fakeKey = "sk-" + "proj-" + "a".repeat(24);
      await fs.promises.writeFile(
        riskyFile,
        JSON.stringify({ message: fakeKey }) + "\n",
        "utf8"
      );
      const session = (id: string, file: string): LocalSession => ({
        tool: "codex",
        id,
        file,
        relativePath: `sessions/${path.basename(file)}`,
        mtimeMs: 1,
        size: 1,
        hash: id,
      });

      const matches = await scanSessionsForSecrets([
        session("safe", safeFile),
        session("risky", riskyFile),
      ]);
      assert.equal(matches.length, 1);
      assert.equal(matches[0].session.id, "risky");
      assert.equal(matches[0].findings[0].kind, "OpenAI API key");
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("sessionDisplayName", () => {
  const { sessionDisplayName } = require("./sessionSecretScan") as typeof import("./sessionSecretScan");
  const base = {
    relativePath: "x",
    mtimeMs: 1,
    size: 1,
    hash: "h",
  };

  it("prefers the stored codex thread_name", async () => {
    const name = await sessionDisplayName({
      ...base,
      tool: "codex",
      id: "t1",
      file: "C:\\missing\\t1.jsonl",
      title: "整理備份排除範圍",
    } as LocalSession);
    assert.equal(name, "整理備份排除範圍");
  });

  it("reads aiTitle from the claude jsonl", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "display-name-"));
    const file = path.join(dir, "abc.jsonl");
    try {
      await fs.promises.writeFile(
        file,
        JSON.stringify({ sessionId: "abc", aiTitle: "規劃備份擴充功能" }) + "\n"
      );
      const name = await sessionDisplayName({
        ...base,
        tool: "claude",
        id: "abc",
        file,
      } as LocalSession);
      assert.equal(name, "規劃備份擴充功能");
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it("labels codex subagent threads by agent name", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "display-name-"));
    const file = path.join(dir, "rollout-sub.jsonl");
    try {
      await fs.promises.writeFile(
        file,
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "sub-1",
            session_id: "parent-1",
            parent_thread_id: "parent-1",
            source: { subagent: { other: "guardian" } },
            thread_source: "subagent",
          },
        }) + "\n"
      );
      const name = await sessionDisplayName({
        ...base,
        tool: "codex",
        id: "sub-1",
        file,
      } as LocalSession);
      assert.equal(name, "子代理：guardian");
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });
});
