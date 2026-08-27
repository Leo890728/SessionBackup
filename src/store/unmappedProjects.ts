import type { SelectionSet } from "./selection";
import type { MachineManifest, ProjectRef } from "./sessionStore";

/** 其他電腦備份過、但本機還解不出位置的專案。 */
export interface RemoteProject {
  project: ProjectRef;
  /** 屬於這個專案的遠端 session 數（以 session id 去重）。 */
  count: number;
  /** 備份過它的機器，供側欄顯示來源。 */
  machines: string[];
  /**
   * 這些 session 的 `tool:id`。同步回來的 Codex 檔本機已經有了，只有逐一比對
   * 才分得出「遠端總共幾個」與「還有幾個沒下來」——兩個數字差很多時直接寫總數
   * 會和節點自己標的對話數對不起來。
   */
  sessionKeys: string[];
}

/**
 * 聚合其他電腦 manifest 中出現過的專案。
 *
 * 兩種工具都要收。它們同步時的下場不同——Claude 解不出映射會被跳過（本機沒有檔案），
 * Codex 則照樣匯入、只是保留來源電腦的 cwd——但那是同一個專案的兩半。只收 Claude 的話，
 * 側欄會同時長出「待對應的 Claude 專案」和「cwd 不在本機的 Codex 專案」兩個節點；
 * 兩邊都收進來，呼叫端才有辦法用 project.id 把它們併回一個。
 */
export function aggregateRemoteProjects(
  manifests: readonly MachineManifest[],
  selfMachineId: string,
  selection?: Pick<SelectionSet, "excludes">
): RemoteProject[] {
  const byProject = new Map<
    string,
    { project: ProjectRef; ids: Set<string>; machines: Set<string> }
  >();
  for (const manifest of manifests) {
    if (manifest.machineId === selfMachineId) {
      continue;
    }
    for (const session of manifest.sessions) {
      if (!session.project) {
        continue;
      }
      // 使用者明確排除的對話同步時本來就不會匯入，不該讓它撐出一個待對應節點。
      if (selection?.excludes({ tool: session.tool, id: session.id })) {
        continue;
      }
      const entry = byProject.get(session.project.id) ?? {
        project: session.project,
        ids: new Set<string>(),
        machines: new Set<string>(),
      };
      entry.ids.add(`${session.tool}:${session.id}`);
      entry.machines.add(manifest.machineId);
      byProject.set(session.project.id, entry);
    }
  }
  return [...byProject.values()]
    .map(({ project, ids, machines }) => ({
      project,
      count: ids.size,
      machines: [...machines].sort(),
      sessionKeys: [...ids],
    }))
    .sort((a, b) => a.project.displayName.localeCompare(b.project.displayName));
}

/**
 * 濾掉本機已經解得出位置的專案。
 * isMapped 必須與同步時的非互動判斷一致，側欄顯示的才會剛好是同步會跳過的那些。
 */
export async function filterUnmapped(
  projects: readonly RemoteProject[],
  isMapped: (project: ProjectRef) => Promise<boolean>
): Promise<RemoteProject[]> {
  const unmapped: RemoteProject[] = [];
  for (const entry of projects) {
    if (!(await isMapped(entry.project))) {
      unmapped.push(entry);
    }
  }
  return unmapped;
}

/**
 * 其他電腦的每個 session 屬於哪個專案，key 是 `${tool}:${id}`。
 *
 * 匯入回來的 Codex 檔在本機自己的 manifest 裡沒有 project：identifyByCwd 碰到
 * 不存在的路徑就回 undefined。要認出這些檔案屬於哪個專案，只能拿 session id
 * 回頭對來源電腦的 manifest。
 */
export function remoteProjectsBySession(
  manifests: readonly MachineManifest[],
  selfMachineId: string
): Map<string, ProjectRef> {
  const bySession = new Map<string, ProjectRef>();
  for (const manifest of manifests) {
    if (manifest.machineId === selfMachineId) {
      continue;
    }
    for (const session of manifest.sessions) {
      // 先寫入的優先：同一個 session 被多台備份過時，取哪一台的身分都一樣。
      if (session.project && !bySession.has(`${session.tool}:${session.id}`)) {
        bySession.set(`${session.tool}:${session.id}`, session.project);
      }
    }
  }
  return bySession;
}
