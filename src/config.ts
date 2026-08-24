import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export interface SourceConfig {
  name: string;
  path: string;
}

export interface BackupConfig {
  repoPath: string;
  repoName: string;
  machineId: string;
  sources: SourceConfig[];
  autoBackupMinutes: number;
  backupOnStartup: boolean;
  maxFileSizeMB: number;
  secretScan: boolean;
  /** 備份白名單規則，見 selection.ts。沒有規則涵蓋的 session 不會備份。 */
  selectedSessions: string[];
}

export function expandHome(p: string): string {
  if (!p) {
    return p;
  }
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p.replace(/^%USERPROFILE%/i, os.homedir());
}

export function getConfig(): BackupConfig {
  const c = vscode.workspace.getConfiguration("sessionBackup");
  const repoPath =
    expandHome(c.get<string>("repoPath", "")) ||
    path.join(os.homedir(), ".session-backup");
  const sources = c.get<SourceConfig[]>("sources", []).map((s) => ({
    name: s.name,
    path: expandHome(s.path),
  }));
  return {
    repoPath,
    // 使用者在設定 UI 清空欄位時拿到的是空字串而不是 undefined，
    // c.get 的預設值救不到；空名稱會讓自動探索永遠比對不到儲存庫。
    repoName: c.get<string>("repoName", "").trim() || "agent-session-backup",
    // 留空代表交給 machineIdFromConfig 用自動產生的值（hostname + 安裝識別碼雜湊）。
    machineId: c.get<string>("machineId", "").trim(),
    sources,
    autoBackupMinutes: c.get("autoBackupMinutes", 30),
    backupOnStartup: c.get("backupOnStartup", false),
    maxFileSizeMB: c.get("maxFileSizeMB", 95),
    secretScan: c.get("secretScan", true),
    selectedSessions: c
      .get<string[]>("selectedSessions", [])
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/** 以 mutate 函式更新備份選取（去重、排序後寫回使用者設定）。 */
export async function updateSelectedSessions(
  mutate: (current: string[]) => string[]
): Promise<string[]> {
  const c = vscode.workspace.getConfiguration("sessionBackup");
  const current = c.get<string[]>("selectedSessions", []);
  const next = [...new Set(mutate([...current]).map((s) => s.trim()).filter(Boolean))].sort();
  await c.update("selectedSessions", next, vscode.ConfigurationTarget.Global);
  return next;
}

/** 讀取 0.2.x 的黑名單設定（僅供一次性遷移使用）。 */
export function readLegacyIgnoredSessions(): string[] {
  return (
    vscode.workspace.getConfiguration("sessionBackup").get<string[]>("ignoredSessions", []) ?? []
  )
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function clearLegacyIgnoredSessions(): Promise<void> {
  await vscode.workspace
    .getConfiguration("sessionBackup")
    .update("ignoredSessions", undefined, vscode.ConfigurationTarget.Global);
}
