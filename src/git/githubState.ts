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

export interface GithubRepoRef {
  owner: string;
  repo: string;
  fullName: string;
}

/**
 * 從 remote URL 取出 GitHub 的 owner/repo。
 * 只認 github.com；GitLab、Gitea、自架 GHE 沒有相同的刪除 API，回傳 undefined
 * 讓呼叫端改走「只解除連結」那條路。
 */
export function parseGithubRepo(remote: string): GithubRepoRef | undefined {
  const url = remote.trim();
  const match =
    /^(?:https?:\/\/)?(?:[^@/]+@)?github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
      url
    ) ??
    /^ssh:\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
      url
    );
  if (!match) {
    return undefined;
  }
  const [, owner, repo] = match;
  return { owner, repo, fullName: `${owner}/${repo}` };
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
