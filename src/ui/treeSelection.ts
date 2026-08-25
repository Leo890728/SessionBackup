/**
 * Sessions 側欄的選取與統計邏輯。與 vscode 無關，可直接測試；
 * 真正畫成 TreeItem 的部分留在 sessionTree.ts。
 */

import * as path from "path";
import { SessionInfo } from "../agents/types";
import {
  applyProjectGroupRules,
  SelectionLevel,
  SelectionSet,
  SelectionTarget,
  sessionKey,
} from "../store/selection";
import { ClaudeProjectNode, CodexProjectNode, TreeNode } from "./treeNodes";

/** 單一 session 節點對應的選取規則。 */
export function ruleFor(node: Extract<TreeNode, { kind: "session" }>): {
  key: string;
  target: SelectionTarget;
  level: SelectionLevel;
} {
  return {
    key: sessionKey(node.info.tool, node.info.backupId),
    target: {
      tool: node.info.tool,
      id: node.info.backupId,
      claudeProjectDir: node.claudeProjectDir,
    },
    level: "session",
  };
}

export function codexTarget(info: SessionInfo): SelectionTarget {
  return { tool: info.tool, id: info.backupId };
}

export function collectCodexInfos(
  topLevel: readonly SessionInfo[],
  subsByHost: ReadonlyMap<string, SessionInfo[]>,
): SessionInfo[] {
  const out: SessionInfo[] = [];
  const seen = new Set<string>();
  const visit = (info: SessionInfo) => {
    if (seen.has(info.file)) {
      return;
    }
    seen.add(info.file);
    out.push(info);
    for (const sub of subsByHost.get(info.file) ?? []) {
      visit(sub);
    }
  };
  for (const info of topLevel) {
    visit(info);
  }
  return out;
}

export function selectionSummary(
  selection: SelectionSet,
  node: ClaudeProjectNode | CodexProjectNode,
): { total: number; chosen: number; selected: boolean } {
  if (node.kind === "claudeProject") {
    let total = 0;
    let chosen = 0;
    for (const project of node.projects) {
      const projectDir = path.basename(project.dir);
      total += project.sessionIds.length;
      chosen += project.sessionIds.filter((id) =>
        selection.includes({
          tool: "claude",
          id,
          claudeProjectDir: projectDir,
        }),
      ).length;
    }
    return {
      total,
      chosen,
      selected:
        node.projects.length > 0 &&
        node.projects.every((project) =>
          selection.claudeProjectSelected(path.basename(project.dir)),
        ),
    };
  }

  const infos = collectCodexInfos(node.topLevel, node.subsByHost);
  const chosen = infos.filter((info) =>
    selection.includes(codexTarget(info)),
  ).length;
  return {
    total: infos.length,
    chosen,
    selected: infos.length > 0 && chosen === infos.length,
  };
}

export function groupDescription(
  total: number,
  chosen: number,
  selected: boolean,
  partial: string | undefined,
): string {
  const count = `${total} 個對話`;
  if (partial) {
    return `${count} · ${partial}`;
  }
  if (selected) {
    return `${count} · 已追蹤`;
  }
  return total > 0 && chosen === total ? `${count} · 目前全選` : count;
}

export function projectSelectionTip(
  children: readonly (ClaudeProjectNode | CodexProjectNode)[],
): string {
  const hasClaude = children.some((child) => child.kind === "claudeProject");
  const hasCodex = children.some((child) => child.kind === "codexProject");
  if (hasClaude && hasCodex) {
    return (
      "勾選會套用底下兩個 AI：Claude Code 包含之後新增的對話；" +
      "Codex 只包含目前已有的對話。"
    );
  }
  return hasClaude
    ? "勾選以備份這個專案的所有 Claude Code 對話（含之後新增的）"
    : "勾選以備份這個專案目前已有的 Codex 對話（不含之後新增的）";
}

export function applyAiSelection(
  current: readonly string[],
  node: ClaudeProjectNode | CodexProjectNode,
  selected: boolean,
): string[] {
  if (node.kind === "claudeProject") {
    return applyProjectGroupRules(
      current,
      node.projects.map((project) => path.basename(project.dir)),
      [],
      selected,
    );
  }

  return applyProjectGroupRules(
    current,
    [],
    collectCodexInfos(node.topLevel, node.subsByHost).map(codexTarget),
    selected,
  );
}

export function flattenSessions(nodes: TreeNode[]): SessionInfo[] {
  const out: SessionInfo[] = [];
  for (const node of nodes) {
    if (node.kind !== "session") {
      continue;
    }
    out.push(node.info);
    if (node.subs?.length) {
      out.push(...flattenSessions(node.subs));
    }
  }
  return out;
}

export const PARTIAL_TIP = "部分追蹤：底下的對話只勾了一部分。\n\n";
