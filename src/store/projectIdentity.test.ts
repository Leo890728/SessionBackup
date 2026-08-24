import * as assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import {
  detectProject,
  encodeClaudeProjectDir,
  normalizeGitRemote,
} from "./projectIdentity";

const execFileAsync = promisify(execFile);

describe("project identity", () => {
  it("normalizes SSH and HTTPS forms to the same remote", () => {
    assert.equal(
      normalizeGitRemote("git@GitHub.com:OpenAI/example.git"),
      normalizeGitRemote("https://github.com/openai/example.git")
    );
  });

  it("encodes a Windows project path like Claude Code", () => {
    if (process.platform === "win32") {
      assert.equal(encodeClaudeProjectDir("C:\\Work\\App"), "C--Work-App");
    }
  });

  it("uses git remote plus repository-relative workspace path", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "project-id-test-"));
    const child = path.join(root, "packages", "web");
    try {
      await fs.promises.mkdir(child, { recursive: true });
      await execFileAsync("git", ["init"], { cwd: root, windowsHide: true });
      await execFileAsync(
        "git",
        ["remote", "add", "origin", "git@github.com:example/product.git"],
        { cwd: root, windowsHide: true }
      );
      const rootProject = await detectProject(root);
      const childProject = await detectProject(child);
      assert.ok(rootProject);
      assert.ok(childProject);
      assert.equal(rootProject.gitRemoteHash, childProject.gitRemoteHash);
      assert.equal(rootProject.workspaceRelativePath, ".");
      assert.equal(childProject.workspaceRelativePath, "packages/web");
      assert.notEqual(rootProject.id, childProject.id);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});
