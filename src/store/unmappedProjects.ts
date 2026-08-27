import type { Tool } from "../agents/types";
import type { SelectionSet } from "./selection";
import type { MachineManifest, ProjectRef } from "./sessionStore";

/**
 * 其他電腦備份過的一則對話。內容在本機備份庫的 store 裡（revisionRelativePath
 * 拿得到路徑），所以還沒匯入也能列出來、也能預覽。
 */
export interface RemoteSession {
  tool: Tool;
  id: string;
  /** store 裡這份 revision 的位址。 */
  hash: string;
  title?: string;
  mtimeMs: number;
  /** 備份出這一份的機器。 */
  machineId: string;
}

/** 其他電腦備份過、但本機還解不出位置的專案。 */
export interface RemoteProject {
  project: ProjectRef;
  /** 屬於這個專案的遠端 session 數（以 tool:id 去重）。 */
  count: number;
  /** 備份過它的機器，供側欄顯示來源。 */
  machines: string[];
  /**
   * 這些對話本身。同步回來的 Codex 檔本機已經有了，只有逐一比對才分得出
   * 「遠端總共幾個」與「還有幾個沒下來」；而且列得出來，待匯入的那些才能
   * 在側欄展開、直接從 store 預覽，不必先把檔案搬進本機。
   */
  sessions: RemoteSession[];
}

/** 這則對話在遠端清單裡的 key。與本機的 `tool:id` 是同一套。 */
export function remoteSessionKey(session: {
  tool: Tool;
  id: string;
}): string {
  return `${session.tool}:${session.id}`;
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
    {
      project: ProjectRef;
      sessions: Map<string, RemoteSession>;
      machines: Set<string>;
    }
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
        sessions: new Map<string, RemoteSession>(),
        machines: new Set<string>(),
      };
      const key = remoteSessionKey(session);
      const known = entry.sessions.get(key);
      // 同一則對話被兩台備份過時取比較新的那份，預覽才不會看到舊的截斷版本。
      if (!known || known.mtimeMs < session.mtimeMs) {
        entry.sessions.set(key, {
          tool: session.tool,
          id: session.id,
          hash: session.hash,
          title: session.title,
          mtimeMs: session.mtimeMs,
          machineId: manifest.machineId,
        });
      }
      entry.machines.add(manifest.machineId);
      byProject.set(session.project.id, entry);
    }
  }
  return [...byProject.values()]
    .map(({ project, sessions, machines }) => ({
      project,
      count: sessions.size,
      machines: [...machines].sort(),
      sessions: [...sessions.values()].sort((a, b) => b.mtimeMs - a.mtimeMs),
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
