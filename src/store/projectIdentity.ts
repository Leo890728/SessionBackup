import { createHash } from "crypto";
import { execFile } from "child_process";
import * as path from "path";
import { promisify } from "util";
import type { ProjectRef } from "./sessionStore";

const execFileAsync = promisify(execFile);

/**
 * 專案身分：先看 origin remote，沒有 remote 才退到 root commit。
 *
 * 兩者都與磁碟路徑無關，換一台電腦仍算同一個專案——這正是 fallbackProject
 * 的路徑雜湊做不到的事。remote 排第一是因為它分得開「同一個上游的兩個 fork」；
 * 但還沒 push、或只是把資料夾複製過去的 repo 沒有 remote，那時 root commit
 * 是唯一跨機認得出來的東西。
 */
export async function detectProject(localPath: string): Promise<ProjectRef | undefined> {
  const resolved = path.resolve(localPath);
  const toplevel = await git(resolved, ["rev-parse", "--show-toplevel"]);
  if (!toplevel) {
    return undefined;
  }
  const gitRoot = path.resolve(toplevel);
  const workspaceRelativePath = path.relative(gitRoot, resolved).replace(/\\/g, "/") || ".";
  const displayName = path.basename(resolved);

  const remote = normalizeGitRemote(
    (await git(gitRoot, ["config", "--get", "remote.origin.url"])) ?? ""
  );
  if (remote) {
    const gitRemoteHash = digest(remote);
    return {
      id: `git-${digest(`${gitRemoteHash}\n${workspaceRelativePath}`).slice(0, 32)}`,
      displayName,
      gitRemoteHash,
      workspaceRelativePath,
    };
  }

  // 歷史被合併過的 repo 會有多個 root commit：排序後全取，兩台電腦才不會因為
  // rev-list 的走訪順序不同而算出不同的身分。還沒有任何 commit 就沒有身分可用。
  const roots = (await git(gitRoot, ["rev-list", "--max-parents=0", "HEAD"]))
    ?.split(/\s+/)
    .filter(Boolean)
    .sort();
  if (!roots?.length) {
    return undefined;
  }
  return {
    id: `root-${digest(`${roots.join(",")}\n${workspaceRelativePath}`).slice(0, 32)}`,
    displayName,
    workspaceRelativePath,
  };
}

/** 專案身分是不是靠 git 認出來的；path 雜湊換一台電腦必然對不上，值得再試一次偵測。 */
export function isGitIdentity(id: string): boolean {
  return id.startsWith("git-") || id.startsWith("root-");
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      windowsHide: true,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function normalizeGitRemote(remote: string): string {
  let value = remote.trim();
  if (!value) {
    return "";
  }
  const scp = /^(?:[^@]+@)?([^:]+):(.+)$/.exec(value);
  if (scp && !value.includes("://") && !/^[A-Za-z]:[\\/]/.test(value)) {
    value = `https://${scp[1]}/${scp[2]}`;
  }
  try {
    const url = new URL(value);
    const pathname = url.pathname.replace(/\.git$/i, "").replace(/\/+$/, "");
    return `${url.hostname.toLowerCase()}${pathname}`.toLowerCase();
  } catch {
    return value.replace(/\.git$/i, "").replace(/\\/g, "/").toLowerCase();
  }
}

/**
 * 路徑編成 Claude Code 的 projects bucket 名稱。
 *
 * 底線也算分隔符：Claude Code 自己就是這樣編的（`secure_CI_pipeline` 的 bucket 是
 * `c--Users-…-secure-CI-pipeline`）。少換這一個字元的後果不只是側欄多一列——
 * 同步匯入時會照這個名字建資料夾，Claude Code 永遠不會去讀它，那些對話等於匯了
 * 也看不到。比對一律 case-insensitive，磁碟機代號大小寫不影響。
 */
export function encodeClaudeProjectDir(localPath: string): string {
  return path.resolve(localPath).replace(/[:\\/_]/g, "-");
}

export function fallbackProject(localPath: string): ProjectRef {
  return {
    id: `local-${digest(path.resolve(localPath).toLowerCase()).slice(0, 32)}`,
    displayName: path.basename(localPath),
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
