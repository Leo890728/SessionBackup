/** 專案標籤的消歧義。純資料，不相依 vscode。 */

import * as path from "path";

import type { TreeNode } from "./treeNodes";

/**
 * 把消歧義後的標籤套回根層節點；只換 label，key 與其他欄位都不動
 * （key 換掉會讓展開狀態與 TreeItem id 跟著跳）。
 */
export function relabelProjects(nodes: readonly TreeNode[]): TreeNode[] {
  const keyOf = (node: TreeNode): string | undefined =>
    node.kind === "project"
      ? `project:${node.key}`
      : node.kind === "unmappedProject"
        ? `unmapped:${node.project.id}`
        : undefined;

  const candidates: LabelCandidate[] = [];
  for (const node of nodes) {
    const key = keyOf(node);
    if (node.kind === "project" && key) {
      candidates.push({
        key,
        label: node.label,
        cwd: node.cwd,
        id: node.projectRef?.id,
        machines: node.unmapped?.machines,
      });
    } else if (node.kind === "unmappedProject" && key) {
      // 本機還沒有檔案，沒有路徑可以往上補，撞名時直接落到機器名。
      candidates.push({
        key,
        label: node.project.displayName,
        id: node.project.id,
        machines: node.machines,
      });
    }
  }

  const labels = disambiguateLabels(candidates);
  return nodes.map((node) => {
    const key = keyOf(node);
    const label = key ? labels.get(key) : undefined;
    if (!label) {
      return node;
    }
    if (node.kind === "project") {
      return label === node.label ? node : { ...node, label };
    }
    if (node.kind === "unmappedProject") {
      return label === node.project.displayName ? node : { ...node, label };
    }
    return node;
  });
}

export interface LabelCandidate {
  /** 回傳結果的 key。 */
  key: string;
  /** 沒有 cwd 時的退路（例如 Claude bucket 自成一組的情況）。 */
  label: string;
  cwd?: string;
  /** 專案身分。相同代表是同一個專案，不該被消歧義拆開。 */
  id?: string;
  /** 備份過它的機器，路徑用完仍撞名時當最後的區別。 */
  machines?: readonly string[];
}

/**
 * 讓同時顯示的專案標籤彼此可分辨：預設只顯示資料夾名，撞名才逐段往上補路徑，
 * 補到根目錄還撞才加機器名。
 *
 * 為什麼在這裡算而不是備份時就記進 manifest：撞名是「同時被顯示的那一組」的性質。
 * 備份當下這台電腦不知道另一台也有一個同名專案，算不出來；而且一旦寫進 manifest
 * 就會過期——之後多出一個同名專案時，舊紀錄還留著短名字，同一個專案反而變成
 * 兩個標籤。
 *
 * id 相同的絕不消歧義：那是同一個專案在兩台電腦的兩個路徑，把它們的標籤改得不一樣
 * 等於在畫面上宣稱它們是不同的東西。
 */
export function disambiguateLabels(
  candidates: readonly LabelCandidate[]
): Map<string, string> {
  interface State {
    candidate: LabelCandidate;
    /** 由近而遠的路徑片段：["SessionBackup", "GitHub", "Documents", …]。 */
    segments: string[];
    depth: number;
    label: string;
  }

  const states: State[] = candidates.map((candidate) => {
    const segments = tailSegments(candidate.cwd);
    return {
      candidate,
      segments,
      depth: 1,
      label: segments.length ? segments[0] : candidate.label,
    };
  });

  // 每輪把仍然撞名的那幾組各往上補一段。補完可能撞到第三個專案，所以要重新分組再來。
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let extended = false;
    for (const group of collide(states)) {
      for (const state of group) {
        if (state.depth < state.segments.length) {
          state.depth++;
          state.label = joinTail(state.segments, state.depth, state.candidate.cwd);
          extended = true;
        }
      }
    }
    if (!extended) {
      break;
    }
  }

  // 路徑補到底還是撞：只剩機器名可以分。
  for (const group of collide(states)) {
    for (const state of group) {
      const machines = state.candidate.machines;
      if (machines?.length) {
        state.label = `${state.label} (${machines.join("、")})`;
      }
    }
  }

  return new Map(states.map((state) => [state.candidate.key, state.label]));
}

const MAX_ROUNDS = 16;

/** 標籤相同、但不是同一個專案的那幾組。 */
function collide<T extends { label: string; candidate: LabelCandidate }>(
  states: readonly T[]
): T[][] {
  const byLabel = new Map<string, T[]>();
  for (const state of states) {
    const bucket = byLabel.get(state.label);
    if (bucket) {
      bucket.push(state);
    } else {
      byLabel.set(state.label, [state]);
    }
  }
  return [...byLabel.values()].filter(
    (group) =>
      group.length > 1 &&
      // 同一個專案的兩個路徑不算撞名，它們本來就該長一樣。
      !group.every(
        (state) =>
          state.candidate.id !== undefined &&
          state.candidate.id === group[0].candidate.id
      )
  );
}

/** 由近而遠的路徑片段。跨平台：同步回來的 cwd 可能來自另一種作業系統。 */
function tailSegments(cwd: string | undefined): string[] {
  const raw = cwd?.trim();
  if (!raw) {
    return [];
  }
  const flavor = isWindowsPath(raw) ? path.win32 : path.posix;
  const normalized = flavor.normalize(raw);
  const root = flavor.parse(normalized).root;
  const rest = normalized.slice(root.length);
  const segments = rest.split(/[\\/]+/).filter(Boolean).reverse();
  // 根目錄本身（C:\ 或 /）也是一段，否則兩個不同磁碟機的同名專案永遠分不開。
  return root ? [...segments, root] : segments;
}

function joinTail(segments: string[], depth: number, cwd: string | undefined): string {
  const separator = cwd && isWindowsPath(cwd) ? "\\" : "/";
  const tail = segments.slice(0, depth).reverse();
  // 根目錄那段自己帶分隔符（C:\），再接一個會變成 C:\\Users。
  return tail.reduce(
    (acc, segment, index) =>
      index === 0
        ? segment
        : acc + (acc.endsWith("\\") || acc.endsWith("/") ? "" : separator) + segment,
    ""
  );
}

function isWindowsPath(raw: string): boolean {
  return (
    /^[a-z]:[\\/]/i.test(raw) ||
    raw.startsWith("\\\\") ||
    (!raw.startsWith("/") && raw.includes("\\"))
  );
}
