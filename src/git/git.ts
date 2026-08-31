import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { selectFetchedRemoteBranch } from "./gitState";

/** vscode.OutputChannel 需要的最小子集：讓 git.ts 不必相依 vscode，才測得起來。 */
export interface Logger {
  appendLine(line: string): void;
}

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
    private out: Logger
  ) {}

  run(args: string[], allowFail = false): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      const child = spawn("git", args, {
        cwd: this.repoPath,
        windowsHide: true,
        // 子行程沒有 terminal，git 若試著在終端機問帳密只會卡住直到逾時。
        // 這不影響 credential manager／SSH agent 那類非終端機的認證方式。
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
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

  /** 連線測試：不動 .git/config，所以打錯的 URL 不會留下痕跡。 */
  async testRemote(url: string, authHeader?: string): Promise<GitResult> {
    const extra = authHeader ? ["-c", "http.extraHeader=" + authHeader] : [];
    return this.run([...extra, "ls-remote", "--heads", url], true);
  }

  /**
   * 本機與遠端是否同源。備份庫重建後兩邊會是完全不相干的歷史，
   * 此時 rebase 一定會在各機器的 manifest.json 撞 add/add 衝突，
   * 必須先問過使用者改用遠端重建，而不是讓同步在半路炸掉。
   */
  async hasCommonHistory(remoteRef: string): Promise<boolean> {
    const head = await this.run(["rev-parse", "--verify", "HEAD"], true);
    if (head.code !== 0) {
      return true; // 本機還沒有 commit，直接採用遠端即可，不算分叉
    }
    const base = await this.run(["merge-base", "HEAD", remoteRef], true);
    return base.code === 0;
  }

  /** 丟掉本機歷史，改以遠端分支為準（本機 session 原檔不受影響）。 */
  async resetToRemote(branch: string): Promise<void> {
    const checkout = await this.run(["checkout", "-B", branch, `origin/${branch}`], true);
    if (checkout.code !== 0) {
      throw new Error(
        (checkout.stderr || checkout.stdout).trim() || "以遠端重建本機備份庫失敗"
      );
    }
  }

  /** 目前所在的分支名稱；HEAD 脫離（detached，例如 rebase 中斷後）時回傳 undefined。 */
  async currentBranch(): Promise<string | undefined> {
    const r = await this.run(["symbolic-ref", "--quiet", "--short", "HEAD"], true);
    return r.code === 0 ? r.stdout.trim() || undefined : undefined;
  }

  async fetchOrigin(authHeader?: string): Promise<GitResult> {
    const extra = authHeader ? ["-c", "http.extraHeader=" + authHeader] : [];
    return this.run([...extra, "fetch", "--prune", "origin"], true);
  }

  async resolveRemoteBranch(
    preferredBranch: string | undefined,
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
    const branch = (await this.currentBranch()) ?? "main";
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
    const branch = await this.resolveRemoteBranch(localBranch ?? "main", authHeader);
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
    if (!localBranch) {
      // HEAD 脫離：上一次同步的 rebase 被中斷（VSCode 關閉、當機）會留下未完成的
      // rebase 狀態，之後每次備份都卡在「git branch -M」──不在任何分支上無法改名。
      // 先收掉殘留的 rebase，再把目前 HEAD 接回目標分支，本機提交都還在。
      await this.run(["rebase", "--abort"], true);
      const reattach = await this.run(["checkout", "-B", branch], true);
      if (reattach.code !== 0) {
        throw new Error(
          (reattach.stderr || reattach.stdout).trim() || "重新接回備份分支失敗"
        );
      }
    } else if (localBranch !== branch) {
      await this.run(["branch", "-M", branch]);
    }
    // 先講清楚，否則使用者只會看到 rebase 在 manifest 上的衝突訊息，看不出真正的原因。
    if (!(await this.hasCommonHistory(remoteRef))) {
      throw new Error(
        "本機備份庫與遠端的歷史不相干（遠端儲存庫可能被刪除後重建）。" +
          "請執行「Session Backup: 連接備份儲存庫」重新連接，並選擇以遠端為準重建本機備份庫。"
      );
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
