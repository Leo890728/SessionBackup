import { createHash } from "crypto";
import { execFile } from "child_process";
import * as path from "path";
import { promisify } from "util";
import type { ProjectRef } from "./sessionStore";

const execFileAsync = promisify(execFile);

export async function detectProject(localPath: string): Promise<ProjectRef | undefined> {
  const resolved = path.resolve(localPath);
  try {
    const rootResult = await execFileAsync(
      "git",
      ["-C", resolved, "rev-parse", "--show-toplevel"],
      { windowsHide: true }
    );
    const gitRoot = path.resolve(rootResult.stdout.trim());
    const remoteResult = await execFileAsync(
      "git",
      ["-C", gitRoot, "config", "--get", "remote.origin.url"],
      { windowsHide: true }
    );
    const remote = normalizeGitRemote(remoteResult.stdout.trim());
    if (!remote) {
      return undefined;
    }
    const gitRemoteHash = digest(remote);
    const workspaceRelativePath = path.relative(gitRoot, resolved).replace(/\\/g, "/") || ".";
    return {
      id: `git-${digest(`${gitRemoteHash}\n${workspaceRelativePath}`).slice(0, 32)}`,
      displayName: path.basename(resolved),
      gitRemoteHash,
      workspaceRelativePath,
    };
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

export function encodeClaudeProjectDir(localPath: string): string {
  return path.resolve(localPath).replace(/[:\\/]/g, "-");
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
