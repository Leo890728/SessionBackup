import * as assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { promisify } from "node:util";
import { Git } from "./git";

const execFileAsync = promisify(execFile);
const silent = { appendLine() {} };

let tmp: string;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "git-test-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
});

async function run(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, windowsHide: true });
  return stdout.trim();
}

/** clone 不會帶身分與換行設定，CI 上的乾淨環境會讓 commit/rebase 直接失敗。 */
async function configure(repo: string): Promise<void> {
  await run(repo, ["config", "user.email", "test@example.com"]);
  await run(repo, ["config", "user.name", "Test"]);
  await run(repo, ["config", "commit.gpgsign", "false"]);
  await run(repo, ["config", "core.autocrlf", "false"]);
}

async function commit(repo: string, file: string, body: string, message: string): Promise<void> {
  await fs.promises.writeFile(path.join(repo, file), body, "utf8");
  await run(repo, ["add", "-A"]);
  await run(repo, ["commit", "-m", message]);
}

/** 一個 bare 遠端、一個用來推 r1 的 seed clone、一個扮演備份庫的 local clone。 */
async function scaffold(): Promise<{ remote: string; seed: string; local: string }> {
  const remote = path.join(tmp, "remote.git");
  await run(tmp, ["init", "--bare", "-b", "main", remote]);

  const seed = path.join(tmp, "seed");
  await run(tmp, ["clone", remote, seed]);
  await configure(seed);
  await commit(seed, "a.txt", "r1\n", "r1");
  await run(seed, ["push", "origin", "main"]);

  const local = path.join(tmp, "local");
  await run(tmp, ["clone", remote, local]);
  await configure(local);
  return { remote, seed, local };
}

async function subjects(repo: string, ref: string): Promise<string[]> {
  return (await run(repo, ["log", "--pretty=%s", ref])).split("\n").filter(Boolean);
}

describe("currentBranch", () => {
  it("returns the branch name while attached, including an unborn branch", async () => {
    const repo = path.join(tmp, "repo");
    await run(tmp, ["init", "-b", "main", repo]);
    await configure(repo);
    const git = new Git(repo, silent);

    assert.equal(await git.currentBranch(), "main");

    await commit(repo, "a.txt", "x\n", "first");
    assert.equal(await git.currentBranch(), "main");
  });

  it("returns undefined when HEAD is detached", async () => {
    const repo = path.join(tmp, "repo");
    await run(tmp, ["init", "-b", "main", repo]);
    await configure(repo);
    await commit(repo, "a.txt", "x\n", "first");
    await run(repo, ["checkout", "--detach"]);

    assert.equal(await new Git(repo, silent).currentBranch(), undefined);
  });
});

describe("syncFromRemote with a detached HEAD", () => {
  it("reattaches to the branch and rebases local commits onto the remote", async () => {
    const { seed, local } = await scaffold();
    await commit(local, "b.txt", "local\n", "local-1");
    await commit(seed, "c.txt", "r2\n", "r2");
    await run(seed, ["push", "origin", "main"]);

    // 上一輪 rebase 被中斷後的殘留狀態：不在任何分支上。
    await run(local, ["checkout", "--detach"]);

    const git = new Git(local, silent);
    await git.syncFromRemote();

    assert.equal(await git.currentBranch(), "main");
    assert.equal(await run(local, ["status", "--porcelain"]), "");
    assert.deepEqual(await subjects(local, "main"), ["local-1", "r2", "r1"]);
  });

  it("recovers even when the remote has not moved", async () => {
    const { local } = await scaffold();
    await commit(local, "b.txt", "local\n", "local-1");
    await run(local, ["checkout", "--detach"]);

    const git = new Git(local, silent);
    await git.syncFromRemote();

    assert.equal(await git.currentBranch(), "main");
    assert.deepEqual(await subjects(local, "main"), ["local-1", "r1"]);
  });

  it("leaves the repo on its branch when the rebase still conflicts", async () => {
    const { seed, local } = await scaffold();
    await commit(local, "a.txt", "local\n", "local-1");
    await commit(seed, "a.txt", "remote\n", "r2");
    await run(seed, ["push", "origin", "main"]);

    // 真正卡住的 rebase：衝突後 HEAD 脫離、留下 rebase-merge 目錄。
    await run(local, ["fetch", "origin"]);
    await assert.rejects(
      execFileAsync("git", ["-c", "core.editor=true", "rebase", "origin/main"], {
        cwd: local,
        windowsHide: true,
      })
    );
    assert.equal(await new Git(local, silent).currentBranch(), undefined);

    await assert.rejects(new Git(local, silent).syncFromRemote());

    // 沒有解決衝突，但備份庫不再卡在脫離狀態，下次備份不會撞 branch -M。
    assert.equal(await new Git(local, silent).currentBranch(), "main");
    assert.equal(await run(local, ["status", "--porcelain"]), "");
    assert.ok(!fs.existsSync(path.join(local, ".git", "rebase-merge")));
    assert.deepEqual(await subjects(local, "main"), ["local-1", "r1"]);
  });
});
