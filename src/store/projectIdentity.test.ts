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
  fallbackProject,
  isGitIdentity,
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

  it("falls back to the root commit when the repo has no remote", async () => {
    // 兩份沒有 remote 的 repo，路徑不同但 root commit 相同（clone 或整包複製過去），
    // 必須算成同一個專案——這正是路徑雜湊做不到、待對應節點消不掉的那個情況。
    const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), "project-id-root-"));
    const origin = path.join(base, "origin");
    const copy = path.join(base, "elsewhere", "renamed");
    try {
      await commitRepo(origin);
      await fs.promises.mkdir(path.dirname(copy), { recursive: true });
      await execFileAsync("git", ["clone", origin, copy], { windowsHide: true });
      // clone 會帶 origin remote，拿掉才測得到 root commit 那條路。
      await execFileAsync("git", ["remote", "remove", "origin"], {
        cwd: copy,
        windowsHide: true,
      });

      const a = await detectProject(origin);
      const b = await detectProject(copy);
      assert.ok(a);
      assert.ok(b);
      assert.match(a.id, /^root-/);
      assert.equal(a.id, b.id);
      assert.equal(a.gitRemoteHash, undefined);
      // displayName 仍取自本機資料夾名稱，兩邊可以不同。
      assert.equal(b.displayName, "renamed");
    } finally {
      await fs.promises.rm(base, { recursive: true, force: true });
    }
  });

  it("has no identity for a repo without commits", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "project-id-empty-"));
    try {
      await execFileAsync("git", ["init"], { cwd: root, windowsHide: true });
      assert.equal(await detectProject(root), undefined);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it("tells git-derived identities from the path fallback", () => {
    assert.equal(isGitIdentity("git-abc"), true);
    assert.equal(isGitIdentity("root-abc"), true);
    assert.equal(isGitIdentity(fallbackProject(process.cwd()).id), false);
  });
});

async function commitRepo(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
  const run = (args: string[]) =>
    execFileAsync("git", args, { cwd: dir, windowsHide: true });
  await run(["init"]);
  await run(["config", "user.email", "test@example.com"]);
  await run(["config", "user.name", "Test"]);
  await fs.promises.writeFile(path.join(dir, "README.md"), "hello\n", "utf8");
  await run(["add", "."]);
  await run(["commit", "-m", "init"]);
}
