export interface BackupRepository {
  name: string;
  fullName: string;
  url: string;
}

export function selectAutomaticBackupRepo(
  repositories: BackupRepository[],
  preferredName: string
): BackupRepository | undefined {
  const preferred = repositories.filter((repo) => repo.name === preferredName);
  if (preferred.length === 1) {
    return preferred[0];
  }
  // 個人與組織底下可能有同名的備份庫，猜錯會接到別人的備份庫，交給使用者選。
  if (preferred.length > 1) {
    return undefined;
  }
  return repositories.length === 1 ? repositories[0] : undefined;
}

/**
 * 手動輸入的 remote：只認 git 真的接受的幾種形式，
 * 免得把打錯的字串存進 origin，之後每次備份才在 push 時失敗。
 */
export function normalizeRemoteInput(value: string): string | undefined {
  const url = value.trim();
  if (/^(https?|ssh|git):\/\/[^\s/]+\/.+/i.test(url)) {
    return url;
  }
  if (/^[^\s@:]+@[^\s:]+:.+/.test(url)) {
    return url; // git@host:owner/repo.git
  }
  if (/^([A-Za-z]:[\\/]|\\\\|\/)/.test(url)) {
    return url; // 本機路徑或 UNC 分享
  }
  return undefined;
}
