import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { claudeAiTitle, listClaudeProjects, readClaudeMetadata } from "./claude";

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

describe("listClaudeProjects", () => {
  it("uses the recorded cwd so Claude and Codex can share a project group", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "claude-projects-"));
    const projectDir = path.join(root, "C--work-my-project");
    try {
      await fs.promises.mkdir(projectDir);
      await fs.promises.writeFile(
        path.join(projectDir, "session-1.jsonl"),
        JSON.stringify({ cwd: "C:\\work\\my-project", sessionId: "session-1" }) + "\n",
        "utf8"
      );

      const projects = await listClaudeProjects(root);

      assert.equal(projects.length, 1);
      assert.equal(projects[0].cwd, "C:\\work\\my-project");
      assert.equal(projects[0].decoded, "C:\\work\\my-project");
      assert.equal(projects[0].label, "my-project");
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a recorded cwd that belongs to a different Claude bucket", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "claude-projects-"));
    const projectDir = path.join(root, "C--work-my-project");
    try {
      await fs.promises.mkdir(projectDir);
      await fs.promises.writeFile(
        path.join(projectDir, "session-1.jsonl"),
        JSON.stringify({ cwd: "D:\\remote\\other-project", sessionId: "session-1" }) +
          "\n",
        "utf8"
      );

      const projects = await listClaudeProjects(root);

      assert.equal(projects.length, 1);
      assert.equal(projects[0].cwd, undefined);
      assert.equal(projects[0].decoded, "C:\\work\\my\\project");
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});
