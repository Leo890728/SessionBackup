import type { SelectionSet } from "./selection";
import type { MachineManifest, ProjectRef } from "./sessionStore";

/** 其他電腦備份過、但本機還解不出位置的 Claude 專案。 */
export interface RemoteProject {
  project: ProjectRef;
  /** 屬於這個專案的遠端 session 數（以 session id 去重）。 */
  count: number;
  /** 備份過它的機器，供側欄顯示來源。 */
  machines: string[];
}

/**
 * 聚合其他電腦 manifest 中出現過的 Claude 專案。
 *
 * 只看 claude：Codex 沒有專案 bucket，匯入時解不出映射也只是保持原本的 cwd，
 * 不會被跳過，沒有需要使用者處理的事。
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
      if (session.tool !== "claude" || !session.project) {
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
      entry.ids.add(session.id);
      entry.machines.add(manifest.machineId);
      byProject.set(session.project.id, entry);
    }
  }
  return [...byProject.values()]
    .map(({ project, ids, machines }) => ({
      project,
      count: ids.size,
      machines: [...machines].sort(),
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
