/**
 * 設定變更時該做哪些反應。與 vscode 無關的判斷，effect 留在 activate()。
 */

/**
 * 只有這些設定會換掉監看目標或遠端，需要重建 watcher 並重新 fetch。
 * 選取規則不在其中——它只縮放本機掃描範圍，走輕量的 refresh 就好。
 */
export const RECONFIGURE_KEYS = [
  "sessionBackup.sources",
  "sessionBackup.repoPath",
  "sessionBackup.repoName",
  "sessionBackup.machineId",
];

export interface ConfigReaction {
  /** 重讀選取規則並重掃有變動的 sessions。 */
  reloadSelection: boolean;
  /** 監看目標或遠端換了，重建 watcher 並重新 fetch。 */
  reconfigure: boolean;
  /** 自動備份間隔可能變了，重設計時器。 */
  restartTimer: boolean;
}

export function configReaction(affects: (key: string) => boolean): ConfigReaction {
  return {
    reloadSelection: affects("sessionBackup.selectedSessions"),
    reconfigure: RECONFIGURE_KEYS.some((key) => affects(key)),
    restartTimer: affects("sessionBackup"),
  };
}
