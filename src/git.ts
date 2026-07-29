import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { selectFetchedRemoteBranch } from "./gitState";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommitInfo {
  sha: string;
  date: string;
  subject: string;
}

export class Git {
  constructor(
    readonly repoPath: string,
    private out: vscode.OutputChannel
  ) {}

  run(args: string[], allowFail = false): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      const child = spawn("git", args, { cwd: this.repoPath, windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (err) =>
        reject(new Error("無法執行 git，請確認已安裝並在 PATH 中：" + err.message))
      );
      child.on("close", (code) => {
        const shown = args.map((a) =>
          a.startsWith("http.extraHeader=") ? "http.extraHeader=***" : a
        );
        this.out.appendLine(`$ git ${shown.join(" ")}  (exit ${code})`);
        if (code !== 0 && !allowFail) {
          reject(new Error(`git ${args[0]} 失敗：${(stderr || stdout).trim()}`));
        } else {
          resolve({ code: code ?? -1, stdout, stderr });
        }
      });
    });
  }

  async ensureRepo(): Promise<void> {
    await fs.promises.mkdir(this.repoPath, { recursive: true });
    if (!fs.existsSync(path.join(this.repoPath, ".git"))) {
      const init = await this.run(["init", "-b", "main"], true);
      if (init.code !== 0) {
        await this.run(["init"]);
        await this.run(["symbolic-ref", "HEAD", "refs/heads/main"], true);
      }
    }
    const email = await this.run(["config", "user.email"], true);
    if (!email.stdout.trim()) {
      await this.run(["config", "user.name", "Session Backup"]);
      await this.run(["config", "user.email", "session-backup@" + os.hostname()]);
    }
  }

  async commitAll(message: string): Promise<boolean> {
    await this.run(["add", "-A"]);
    const status = await this.run(["status", "--porcelain"]);
    if (!status.stdout.trim()) {
      return false;
    }
    await this.run(["commit", "-m", message]);
    return true;
  }

  async getRemote(): Promise<string | undefined> {
    const r = await this.run(["remote", "get-url", "origin"], true);
    return r.code === 0 ? r.stdout.trim() : undefined;
  }

  async setRemote(url: string): Promise<void> {
    if (await this.getRemote()) {
      await this.run(["remote", "set-url", "origin", url]);
    } else {
      await this.run(["remote", "add", "origin", url]);
    }
  }

  async currentBranch(): Promise<string> {
    const r = await this.run(["rev-parse", "--abbrev-ref", "HEAD"], true);
    return r.stdout.trim() || "main";
  }

  async fetchOrigin(authHeader?: string): Promise<GitResult> {
    const extra = authHeader ? ["-c", "http.extraHeader=" + authHeader] : [];
    return this.run([...extra, "fetch", "--prune", "origin"], true);
  }

  async resolveRemoteBranch(
    preferredBranch: string,
    authHeader?: string,
    refreshRemoteHead = true
  ): Promise<string | undefined> {
    const extra = authHeader ? ["-c", "http.extraHeader=" + authHeader] : [];
    if (refreshRemoteHead) {
      await this.run([...extra, "remote", "set-head", "origin", "--auto"], true);
    }
    const symbolic = await this.run(
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      true
    );
    if (symbolic.code === 0) {
      return symbolic.stdout.trim().replace(/^origin\//, "") || undefined;
    }
    const refs = await this.run(
      ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"],
      true
    );
    return selectFetchedRemoteBranch(refs.stdout.split(/\r?\n/), preferredBranch);
  }

  /** push；失敗時嘗試先 pull --rebase（多機同步情境）再 push 一次。 */
  async pushWithRetry(authHeader?: string): Promise<void> {
    const extra = authHeader ? ["-c", "http.extraHeader=" + authHeader] : [];
    const branch = await this.currentBranch();
    const first = await this.run([...extra, "push", "-u", "origin", branch], true);
    if (first.code === 0) {
      return;
    }
    const pull = await this.run([...extra, "pull", "--rebase", "origin", branch], true);
    if (pull.code !== 0) {
      await this.run(["rebase", "--abort"], true);
      throw new Error((pull.stderr || first.stderr).trim() || "pull --rebase 失敗");
    }
    const second = await this.run([...extra, "push", "-u", "origin", branch], true);
    if (second.code !== 0) {
      throw new Error((second.stderr || first.stderr).trim() || "push 失敗");
    }
  }

  /** 在寫入本機 snapshot 前取得遠端 append-only revisions。遠端分支尚不存在時視為空庫。 */
  async syncFromRemote(authHeader?: string): Promise<void> {
    const localBranch = await this.currentBranch();
    const fetch = await this.fetchOrigin(authHeader);
    if (fetch.code !== 0) {
      const message = (fetch.stderr || fetch.stdout).trim();
      throw new Error(message || "fetch 失敗");
    }
    const branch = await this.resolveRemoteBranch(localBranch, authHeader);
    if (!branch) {
      return;
    }
    const remoteRef = `origin/${branch}`;
    const localHead = await this.run(["rev-parse", "--verify", "HEAD"], true);
    if (localHead.code !== 0) {
      const checkout = await this.run(["checkout", "-B", branch, remoteRef], true);
      if (checkout.code !== 0) {
        throw new Error((checkout.stderr || checkout.stdout).trim() || "建立本地同步分支失敗");
      }
      return;
    }
    if (localBranch !== branch) {
      await this.run(["branch", "-M", branch]);
    }
    const rebase = await this.run(["rebase", remoteRef], true);
    if (rebase.code !== 0) {
      await this.run(["rebase", "--abort"], true);
      throw new Error((rebase.stderr || rebase.stdout).trim() || "同步遠端失敗");
    }
  }

  async log(n: number): Promise<CommitInfo[]> {
    const r = await this.run(
      [
        "log",
        "-n",
        String(n),
        "--date=format:%Y-%m-%d %H:%M",
        "--pretty=format:%H%x1f%ad%x1f%s",
      ],
      true
    );
    if (r.code !== 0) {
      return [];
    }
    return r.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [sha, date, subject] = l.split("\x1f");
        return { sha, date, subject };
      });
  }

  async resetHard(): Promise<void> {
    await this.run(["reset", "--hard", "HEAD"], true);
  }
}
