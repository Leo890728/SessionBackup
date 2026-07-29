export interface BackupRepository {
  name: string;
  fullName: string;
  url: string;
}

export function selectAutomaticBackupRepo(
  repositories: BackupRepository[],
  preferredName: string
): BackupRepository | undefined {
  const preferred = repositories.find((repo) => repo.name === preferredName);
  if (preferred) {
    return preferred;
  }
  return repositories.length === 1 ? repositories[0] : undefined;
}
