import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  classifyJsonlText,
  collectLocalSessions,
  resolveLocalTarget,
  safeSegment,
  sha256File,
  storeSessions,
} from "./sessionStore";

const line = (id: string, text: string) => JSON.stringify({ id, text });

describe("classifyJsonlText", () => {
  it("recognizes identical sessions despite the final newline", () => {
    const content = line("1", "hello");
    assert.equal(classifyJsonlText(content, content + "\n"), "same");
  });

  it("recognizes a remote continuation", () => {
    const first = line("1", "hello");
    const second = line("2", "remote reply");
    assert.equal(classifyJsonlText(first, `${first}\n${second}\n`), "remote-newer");
  });

  it("recognizes a local continuation", () => {
    const first = line("1", "hello");
    const second = line("2", "local reply");
    assert.equal(classifyJsonlText(`${first}\n${second}`, first), "local-newer");
  });

  it("marks divergent histories as a conflict", () => {
    const first = line("1", "hello");
    const local = `${first}\n${line("2", "local")}`;
    const remote = `${first}\n${line("3", "remote")}`;
    assert.equal(classifyJsonlText(local, remote), "conflict");
  });
});

describe("store path safety", () => {
  it("sanitizes session ids", () => {
    assert.equal(safeSegment("../../a:b"), ".._.._a_b");
  });

  it("rejects a target outside the tool root", () => {
    assert.equal(resolveLocalTarget("C:\\sessions", "../auth.json"), undefined);
  });
});

describe("storeSessions", () => {
  it("does not rewrite a stable manifest on every backup", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "session-store-test-"));
    const source = path.join(root, "source.jsonl");
    await fs.promises.writeFile(source, line("1", "hello") + "\n");
    const hash = await sha256File(source);
    const session = {
      tool: "claude" as const,
      id: "session-1",
      file: source,
      relativePath: "projects/test/session-1.jsonl",
      mtimeMs: 1,
      size: (await fs.promises.stat(source)).size,
      hash,
    };
    try {
      const first = await storeSessions(root, "machine-a", [session], 1024 * 1024);
      const second = await storeSessions(root, "machine-a", [session], 1024 * 1024);
      assert.deepEqual(first.copied.sort(), [
        "format.json",
        "machines/machine-a/manifest.json",
        `store/claude/session-1/${hash}.jsonl`,
      ]);
      assert.deepEqual(second.copied, []);
      assert.equal(second.manifest.updatedAt, first.manifest.updatedAt);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it("defers a session that changed between hashing and copying", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "session-store-test-"));
    const source = path.join(root, "source.jsonl");
    await fs.promises.writeFile(source, line("1", "hello") + "\n");
    const stale = {
      tool: "claude" as const,
      id: "session-1",
      file: source,
      relativePath: "projects/test/session-1.jsonl",
      mtimeMs: 1,
      size: (await fs.promises.stat(source)).size,
      hash: await sha256File(source),
    };
    try {
      const first = await storeSessions(root, "machine-a", [stale], 1024 * 1024);
      // 收集階段算到的是第二行寫完的狀態，複製時檔案已經長到第三行。
      await fs.promises.appendFile(source, line("2", "reply") + "\n");
      const collected = {
        ...stale,
        mtimeMs: 2,
        size: (await fs.promises.stat(source)).size,
        hash: await sha256File(source),
      };
      await fs.promises.appendFile(source, line("3", "still typing") + "\n");
      const second = await storeSessions(root, "machine-a", [collected], 1024 * 1024);

      assert.deepEqual(second.deferred.map((s) => s.id), ["session-1"]);
      assert.equal(
        second.copied.some((rel) => rel.startsWith("store/")),
        false
      );
      // manifest 沿用上一輪的紀錄，指向的仍是真的存在且內容相符的 revision。
      assert.deepEqual(
        second.manifest.sessions,
        JSON.parse(JSON.stringify(first.manifest.sessions))
      );
      const revisions = await fs.promises.readdir(path.join(root, "store", "claude", "session-1"));
      assert.deepEqual(revisions, [`${stale.hash}.jsonl`]);
      assert.equal(
        await sha256File(path.join(root, "store", "claude", "session-1", revisions[0])),
        stale.hash
      );
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Claude project metadata", () => {
  it("stores canonical project metadata without the source machine bucket", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "claude-project-test-"));
    const claude = path.join(root, ".claude");
    const projectDir = "C--Users-a-Work-App";
    const sessionFile = path.join(claude, "projects", projectDir, "session-1.jsonl");
    try {
      await fs.promises.mkdir(path.dirname(sessionFile), { recursive: true });
      await fs.promises.writeFile(
        sessionFile,
        JSON.stringify({ sessionId: "session-1", cwd: "C:\\Users\\a\\Work\\App" }) + "\n"
      );
      const sessions = await collectLocalSessions(
        {
          repoPath: path.join(root, "repo"),
          repoName: "test",
          machineId: "A",
          sources: [
            { name: "claude", path: claude },
            { name: "codex", path: path.join(root, ".codex") },
          ],
          autoBackupMinutes: 0,
          backupOnStartup: false,
          maxFileSizeMB: 95,
          secretScan: false,
          selectedSessions: ["tool:claude"],
        },
        async (cwd, bucket) => {
          assert.equal(cwd, "C:\\Users\\a\\Work\\App");
          assert.equal(bucket, projectDir);
          return { id: "git-project-1", displayName: "App" };
        }
      );
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].relativePath, "projects/session-1.jsonl");
      assert.equal(sessions[0].project?.id, "git-project-1");
      const repo = path.join(root, "repo");
      await fs.promises.mkdir(repo, { recursive: true });
      const stored = await storeSessions(repo, "A", sessions, 1024 * 1024);
      assert.equal(JSON.stringify(stored.manifest).includes(projectDir), false);
      assert.equal(stored.manifest.sessions[0].project?.id, "git-project-1");
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});

describe("session selection", () => {
  it("collects only selected sessions, covering resumed rollouts sharing an id", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "selection-test-"));
    const claude = path.join(root, ".claude");
    const bucket = path.join(claude, "projects", "C--proj");
    const codex = path.join(root, ".codex");
    const codexDay = path.join(codex, "sessions", "2026", "07", "14");
    try {
      await fs.promises.mkdir(bucket, { recursive: true });
      await fs.promises.mkdir(codexDay, { recursive: true });
      await fs.promises.writeFile(
        path.join(bucket, "keep.jsonl"),
        JSON.stringify({ sessionId: "keep", cwd: "C:\\proj" }) + "\n"
      );
      await fs.promises.writeFile(
        path.join(bucket, "secret.jsonl"),
        JSON.stringify({ sessionId: "secret", cwd: "C:\\proj" }) + "\n"
      );
      // 同一個 codex thread 的兩個 rollout 檔（session_meta id 相同）。
      const meta = JSON.stringify({
        type: "session_meta",
        payload: { session_id: "thread-1", cwd: "C:\\proj" },
      });
      await fs.promises.writeFile(path.join(codexDay, "rollout-a.jsonl"), meta + "\n");
      await fs.promises.writeFile(path.join(codexDay, "rollout-b.jsonl"), meta + "\n");

      const cfg = {
        repoPath: path.join(root, "repo"),
        repoName: "test",
        machineId: "A",
        sources: [
          { name: "claude", path: claude },
          { name: "codex", path: codex },
        ],
        autoBackupMinutes: 0,
        backupOnStartup: false,
        maxFileSizeMB: 95,
        secretScan: false,
        // 整個 Claude 專案，但排除其中一個對話；Codex 則只選一個 thread。
        selectedSessions: [
          "claudeProject:C--proj",
          "-session:claude:secret",
          "session:codex:thread-1",
        ],
      };
      const sessions = await collectLocalSessions(cfg);
      assert.deepEqual(
        sessions.map((s) => `${s.tool}:${s.id}`).sort(),
        ["claude:keep", "codex:thread-1", "codex:thread-1"]
      );
      assert.equal(
        sessions.find((s) => s.tool === "claude")?.claudeProjectDir,
        "C--proj"
      );

      const nothingSelected = await collectLocalSessions({ ...cfg, selectedSessions: [] });
      assert.deepEqual(nothingSelected, []);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});

describe("備份端的 codex session_meta 判讀", () => {
  /** 收集單一 codex rollout 檔，回傳備份端認定的 session id。 */
  async function collectedIds(payload: Record<string, unknown>): Promise<string[]> {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-meta-store-"));
    const codex = path.join(root, ".codex");
    const codexDay = path.join(codex, "sessions", "2026", "07", "14");
    try {
      await fs.promises.mkdir(codexDay, { recursive: true });
      await fs.promises.writeFile(
        path.join(codexDay, "rollout-2026-07-14T00-00-00-file-uuid.jsonl"),
        JSON.stringify({ type: "session_meta", payload }) + "\n"
      );
      const sessions = await collectLocalSessions({
        repoPath: path.join(root, "repo"),
        repoName: "test",
        machineId: "A",
        sources: [{ name: "codex", path: codex }],
        autoBackupMinutes: 0,
        backupOnStartup: false,
        maxFileSizeMB: 95,
        secretScan: false,
        selectedSessions: ["tool:codex"],
      });
      return sessions.map((s) => s.id);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  }

  it("新版用 session_id", async () => {
    assert.deepEqual(await collectedIds({ session_id: "thread-1", cwd: "C:\\proj" }), ["thread-1"]);
  });

  it("舊版沒有 session_id 時退回 payload.id（必須與 UI 端同一條規則）", async () => {
    assert.deepEqual(await collectedIds({ id: "legacy-thread", cwd: "C:\\proj" }), [
      "legacy-thread",
    ]);
  });

  it("子代理檔用父 thread 的 session_id，而不是自身 payload.id", async () => {
    assert.deepEqual(
      await collectedIds({ session_id: "parent-1", id: "own-1", parent_thread_id: "parent-1" }),
      ["parent-1"]
    );
  });
});

describe("isRevisionStored", () => {
  it("is true only after the revision file has been written", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "revision-test-"));
    const source = path.join(root, "source.jsonl");
    await fs.promises.writeFile(source, line("1", "hello") + "\n");
    const session = {
      tool: "codex" as const,
      id: "thread-1",
      file: source,
      relativePath: "sessions/thread-1.jsonl",
      mtimeMs: 1,
      size: (await fs.promises.stat(source)).size,
      hash: await sha256File(source),
    };
    const { isRevisionStored } = require("./sessionStore") as typeof import("./sessionStore");
    try {
      assert.equal(isRevisionStored(root, session), false);
      await storeSessions(root, "machine-a", [session], 1024 * 1024);
      assert.equal(isRevisionStored(root, session), true);
      assert.equal(isRevisionStored(root, { ...session, hash: "hash-2" }), false);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});
