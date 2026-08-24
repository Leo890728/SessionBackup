import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import { fallbackProject, detectProject } from "../store/projectIdentity";
import { scanFiles } from "../security/secretScan";
import {
  collectLocalSessions,
  machineIdFromConfig,
  ProjectRef,
  storeSessions,
} from "../store/sessionStore";

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const home = os.homedir();
  const repoPath = path.join(home, ".session-backup-v2");
  const cfg = {
    repoPath,
    repoName: "agent-session-backup",
    machineId: os.hostname(),
    sources: [
      { name: "claude", path: path.join(home, ".claude") },
      { name: "codex", path: path.join(home, ".codex") },
    ],
    autoBackupMinutes: 0,
    backupOnStartup: false,
    maxFileSizeMB: 95,
    secretScan: true,
    // CLI 一次性重建：不走側欄勾選，直接選取兩個工具的全部內容。
    selectedSessions: ["tool:claude", "tool:codex"],
  };
  const projects = new Map<string, ProjectRef | undefined>();
  const sessions = await collectLocalSessions(cfg, async (cwd, bucket) => {
    if (projects.has(bucket)) {
      return projects.get(bucket);
    }
    const project = cwd && path.isAbsolute(cwd)
      ? (await detectProject(cwd)) ?? fallbackProject(cwd)
      : undefined;
    projects.set(bucket, project);
    return project;
  });
  if (!sessions.length) {
    throw new Error("找不到可備份的 Claude/Codex JSONL session");
  }

  await fs.promises.mkdir(repoPath, { recursive: true });
  const stored = await storeSessions(
    repoPath,
    machineIdFromConfig(cfg),
    sessions,
    cfg.maxFileSizeMB * 1024 * 1024
  );
  const findings = await scanFiles(
    repoPath,
    stored.copied.filter((relativePath) => relativePath.endsWith(".jsonl"))
  );
  if (findings.length) {
    for (const finding of findings.slice(0, 20)) {
      console.error(`${finding.kind} @ ${finding.rel}:${finding.line}`);
    }
    throw new Error(`偵測到 ${findings.length} 個疑似機密，尚未建立 Git commit`);
  }

  await runGit(repoPath, ["init", "-b", "main"]);
  await runGit(repoPath, ["config", "user.name", "Session Backup"]);
  await runGit(repoPath, ["config", "user.email", `session-backup@${os.hostname()}`]);
  await runGit(repoPath, ["add", "-A"]);
  await runGit(repoPath, ["commit", "-m", `backup: ${cfg.machineId} (${sessions.length} sessions)`]);
  console.log(
    `已建立 ${repoPath}：${sessions.length} sessions，${stored.copied.length} store files，` +
      `${stored.skipped.length} skipped`
  );
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  if (result.stdout.trim()) {
    console.log(result.stdout.trim());
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
