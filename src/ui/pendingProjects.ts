/** 根層的分堆：哪些專案進「未對應」那一層，哪些照常列出來。純資料，不相依 vscode。 */

import type { RemoteProject } from "../store/unmappedProjects";
import { remoteSessionKey } from "../store/unmappedProjects";
import type { ProjectNode, TreeNode } from "./treeNodes";

export interface PendingSplit {
  /** 收進「未對應專案」那一層的節點，排在已對應的專案之前。 */
  pending: TreeNode[];
  /** 位置解得出來、照常列在根層的專案。 */
  mapped: ProjectNode[];
}

/**
 * 同一個專案不能在側欄出現兩次。
 *
 * 專案還沒對應時，兩種工具現在都只留在遠端 manifest 裡；但這道關卡加上去之前匯入的
 * Codex 檔還在本機，cwd 指著來源電腦。於是同一個專案可能生出兩個節點——一個來自
 * unmapped 清單、一個來自本機檔案。
 * 這裡用 remoteProject.id 把兩邊對起來：對得上就把待對應資訊掛回本機那個節點
 * （使用者才有得點），遠端那筆不再另外長節點。
 */
export function splitPendingProjects(
  projects: readonly ProjectNode[],
  unmapped: readonly RemoteProject[]
): PendingSplit {
  const byId = new Map(unmapped.map((entry) => [entry.project.id, entry]));
  // 全部專案一起算：同步回來的對話可能被歸到別的節點底下，仍然算「已經在本機」。
  const localKeys = new Set(projects.flatMap((project) => project.sessionKeys));
  const claimed = new Set<string>();
  const pending: TreeNode[] = [];
  const mapped: ProjectNode[] = [];

  for (const project of projects) {
    if (project.local) {
      mapped.push(project);
      continue;
    }
    const match = project.projectRef && byId.get(project.projectRef.id);
    if (!match) {
      // 遠端沒有待匯入的部分。可能是資料夾被移走（沒事可做），也可能是已經對應過、
      // 只剩本機這些 Codex 檔的 cwd 沒改過來——後者的 🔗 由 strayCwdKeys 決定，
      // 這裡不必多做什麼。
      pending.push(project);
      continue;
    }
    claimed.add(match.project.id);
    // 只有還沒下來的那些值得提。一個都不缺（舊版就已經匯入的 Codex 檔）時不設這個
    // 欄位，提示改講「工作目錄還指著來源電腦」。
    const missing = match.sessions.filter(
      (session) => !localKeys.has(remoteSessionKey(session))
    );
    pending.push(
      missing.length
        ? { ...project, unmapped: { machines: match.machines, sessions: missing } }
        : project
    );
  }

  for (const entry of unmapped) {
    if (claimed.has(entry.project.id)) {
      continue;
    }
    pending.push({
      kind: "unmappedProject",
      project: entry.project,
      count: entry.count,
      machines: entry.machines,
      sessions: [...entry.sessions],
    });
  }

  return { pending, mapped };
}
