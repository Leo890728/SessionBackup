import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { getConfig, updateSelectedSessions } from "./config";
import {
  applyRule,
  applySessionRules,
  claudeProjectKey,
  SelectionLevel,
  SelectionSet,
  SelectionTarget,
  sessionKey,
  toolKey,
} from "./selection";
import {
  ClaudeProject,
  clearSessionCache,
  codexSessionInfo,
  groupCodexThreads,
  listClaudeProjects,
  listClaudeSessions,
  listCodexFiles,
  SessionInfo,
  Tool,
} from "./sessions";
import {
  buildStatusLookup,
  SessionSyncStatus,
  sessionSyncStatus,
  STATUS_DISPLAY,
  StatusLookup,
} from "./sessionStatus";
import {
  machineIdFromConfig,
  manifestRelativePath,
  readManifest,
} from "./sessionStore";

export type TreeNode =
  | { kind: "root"; tool: Tool; label: string; dir: string }
  | { kind: "claudeProject"; project: ClaudeProject; projectDir: string }
  | { kind: "codexDate"; date: string; sessions: TreeNode[] }
  | {
      kind: "session";
      info: SessionInfo;
      status: SessionSyncStatus;
      claudeProjectDir?: string;
      subs?: TreeNode[];
    };

export class SessionTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private lookup?: Promise<StatusLookup>;
  /** getTreeItem 是同步的，選取狀態必須先備妥。 */
  private selection = new SelectionSet(getConfig().selectedSessions);

  constructor(private readonly extensionUri: vscode.Uri) {}

  refresh(): void {
    clearSessionCache();
    this.lookup = undefined;
    this.selection = new SelectionSet(getConfig().selectedSessions);
    this._onDidChangeTreeData.fire(undefined);
  }

  /** 只重讀選取設定並重畫，不清掉標題快取（勾選 checkbox 的路徑）。 */
  reloadSelection(): void {
    this.lookup = undefined;
    this.selection = new SelectionSet(getConfig().selectedSessions);
    this._onDidChangeTreeData.fire(undefined);
  }

  /** 本機 manifest + 選取規則，per-refresh 快取。 */
  private getLookup(): Promise<StatusLookup> {
    if (!this.lookup) {
      const selection = this.selection;
      this.lookup = (async () => {
        const cfg = getConfig();
        const manifest = await readManifest(
          path.join(
            cfg.repoPath,
            ...manifestRelativePath(machineIdFromConfig(cfg)).split("/")
          )
        );
        return buildStatusLookup(manifest, selection, cfg.maxFileSizeMB);
      })();
    }
    return this.lookup;
  }

  getTreeItem(n: TreeNode): vscode.TreeItem {
    switch (n.kind) {
      case "root": {
        const item = new vscode.TreeItem(
          n.label,
          vscode.TreeItemCollapsibleState.Expanded
        );
        item.id = `root:${n.tool}`;
        item.iconPath = vscode.Uri.joinPath(
          this.extensionUri,
          "media",
          n.tool === "claude" ? "claude.png" : "codex.png"
        );
        const selected = this.selection.toolSelected(n.tool);
        item.description = selected ? "全部備份" : undefined;
        item.tooltip =
          `${n.dir}\n\n` +
          (selected
            ? "已勾選整個工具：現有與之後新增的對話都會備份"
            : "勾選以備份這個工具的所有對話（含之後新增的）");
        item.contextValue = selected ? "toolSelected" : "toolUnselected";
        item.checkboxState = checkbox(selected);
        return item;
      }
      case "claudeProject": {
        const item = new vscode.TreeItem(
          n.project.label,
          vscode.TreeItemCollapsibleState.Collapsed
        );
        item.id = `project:${n.project.dir}`;
        const selected = this.selection.claudeProjectSelected(n.projectDir);
        item.description = selected
          ? `${n.project.count} · 已選取`
          : `${n.project.count}`;
        item.tooltip =
          `${n.project.decoded}\n\n` +
          (selected
            ? "已勾選整個專案：現有與之後新增的對話都會備份"
            : "勾選以備份這個專案的所有對話（含之後新增的）");
        item.iconPath = vscode.ThemeIcon.Folder;
        item.contextValue = selected ? "projectSelected" : "projectUnselected";
        item.checkboxState = checkbox(selected);
        return item;
      }
      case "codexDate": {
        const item = new vscode.TreeItem(
          n.date,
          vscode.TreeItemCollapsibleState.Collapsed
        );
        item.id = `date:${n.date}`;
        const sessions = flattenSessions(n.sessions);
        const selected =
          sessions.length > 0 &&
          sessions.every((info) => this.selection.includes(codexTarget(info)));
        item.description = `${sessions.length} sessions`;
        item.tooltip = "勾選以備份這一天的所有對話（僅目前這些，不含之後新增的）";
        item.iconPath = new vscode.ThemeIcon("calendar");
        item.contextValue = selected ? "dateSelected" : "dateUnselected";
        item.checkboxState = checkbox(selected);
        return item;
      }
      case "session": {
        const s = n.info;
        const display = STATUS_DISPLAY[n.status];
        const item = new vscode.TreeItem(
          s.title,
          n.subs?.length
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None
        );
        item.id = `session:${s.file}`;
        const selected = n.status !== "unselected";
        item.description = `${display.label} · ${s.date} ${s.time}`;
        item.tooltip =
          `${s.title}\n\n` +
          `狀態:${display.label} — ${display.detail}\n\n` +
          (s.subagent ? `子代理:${s.subagent}\n` : "") +
          (n.subs?.length ? `子 sessions:${n.subs.length} 個\n` : "") +
          `${s.file}\n` +
          (s.cwd ? `工作目錄:${s.cwd}\n` : "") +
          `${(s.size / 1024).toFixed(0)} KB，最後更新 ${s.date} ${s.time}`;
        item.contextValue = selected ? "sessionSelected" : "sessionUnselected";
        item.checkboxState = checkbox(selected);
        item.iconPath = new vscode.ThemeIcon(
          display.icon,
          display.color ? new vscode.ThemeColor(display.color) : undefined
        );
        item.command = {
          command: "sessionBackup.previewSession",
          title: "預覽",
          arguments: [n],
        };
        return item;
      }
    }
  }

  async getChildren(el?: TreeNode): Promise<TreeNode[]> {
    if (!el) {
      const dirs = toolDirs();
      const roots: TreeNode[] = [];
      if (fs.existsSync(path.join(dirs.claude, "projects"))) {
        roots.push({
          kind: "root",
          tool: "claude",
          label: "Claude Code",
          dir: dirs.claude,
        });
      }
      if (fs.existsSync(path.join(dirs.codex, "sessions"))) {
        roots.push({ kind: "root", tool: "codex", label: "Codex", dir: dirs.codex });
      }
      return roots;
    }
    if (el.kind === "root" && el.tool === "claude") {
      const projects = await listClaudeProjects(path.join(el.dir, "projects"));
      return projects.map((project) => ({
        kind: "claudeProject",
        project,
        projectDir: path.basename(project.dir),
      }));
    }
    if (el.kind === "root" && el.tool === "codex") {
      return this.buildCodexDateNodes(el.dir);
    }
    if (el.kind === "claudeProject") {
      const [sessions, lookup] = await Promise.all([
        listClaudeSessions(el.project.dir),
        this.getLookup(),
      ]);
      return sessions.map((info) => ({
        kind: "session" as const,
        info,
        claudeProjectDir: el.projectDir,
        status: sessionSyncStatus(lookup, {
          tool: info.tool,
          id: info.backupId,
          // manifest 中 Claude 的 relativePath 不含機器的 project bucket
          relativePath: "projects/" + path.basename(info.file),
          mtimeMs: info.mtime,
          size: info.size,
          claudeProjectDir: el.projectDir,
        }),
      }));
    }
    if (el.kind === "codexDate") {
      return el.sessions;
    }
    if (el.kind === "session") {
      return el.subs ?? [];
    }
    return [];
  }

  /** 勾選/取消勾選（checkbox 與右鍵指令共用）。 */
  async setSelected(node: TreeNode, selected: boolean): Promise<void> {
    if (node.kind === "codexDate") {
      // 日期只是顯示用的分組，沒有對應的範圍規則，逐一套用到當天的 sessions。
      const targets = flattenSessions(node.sessions).map(codexTarget);
      await updateSelectedSessions((current) =>
        applySessionRules(current, targets, selected)
      );
    } else {
      const { key, target, level } = ruleFor(node);
      await updateSelectedSessions((current) =>
        applyRule(
          current,
          key,
          selected,
          new SelectionSet(current).coveredByScope(target, level)
        )
      );
    }
    this.reloadSelection();
  }

  /** TreeView.onDidChangeCheckboxState 的處理：VS Code 已把新狀態算好。 */
  async handleCheckboxChange(
    items: readonly [TreeNode, vscode.TreeItemCheckboxState][]
  ): Promise<void> {
    for (const [node, state] of items) {
      await this.setSelected(node, state === vscode.TreeItemCheckboxState.Checked);
    }
  }

  /** 解析所有 codex sessions，子 thread（parent_thread_id）掛到父 thread 節點下，其餘依日期分組。 */
  private async buildCodexDateNodes(codexRoot: string): Promise<TreeNode[]> {
    const files = await listCodexFiles(path.join(codexRoot, "sessions"));
    const [infos, lookup] = await Promise.all([
      Promise.all(files.map(codexSessionInfo)),
      this.getLookup(),
    ]);
    const { topLevel, subsByHost } = groupCodexThreads(infos);

    const toNode = (info: SessionInfo, ancestors: Set<string>): TreeNode => {
      const subs = subsByHost.get(info.file);
      const nested =
        subs && !ancestors.has(info.file)
          ? subs.map((sub) =>
              toNode(sub, new Set([...ancestors, info.file]))
            )
          : undefined;
      return {
        kind: "session",
        info,
        status: sessionSyncStatus(lookup, {
          tool: info.tool,
          id: info.backupId,
          relativePath: path.relative(codexRoot, info.file).replace(/\\/g, "/"),
          mtimeMs: info.mtime,
          size: info.size,
        }),
        subs: nested?.length ? nested : undefined,
      };
    };

    const byDate = new Map<string, TreeNode[]>();
    for (const info of topLevel.slice().sort((a, b) => b.mtime - a.mtime)) {
      const arr = byDate.get(info.date) ?? [];
      arr.push(toNode(info, new Set()));
      byDate.set(info.date, arr);
    }
    return [...byDate.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([date, sessions]) => ({ kind: "codexDate" as const, date, sessions }));
  }
}

/** 節點對應的選取規則（codexDate 沒有範圍規則，不會走到這裡）。 */
export function ruleFor(node: Exclude<TreeNode, { kind: "codexDate" }>): {
  key: string;
  target: SelectionTarget;
  level: SelectionLevel;
} {
  switch (node.kind) {
    case "root":
      return {
        key: toolKey(node.tool),
        target: { tool: node.tool, id: "" },
        level: "tool",
      };
    case "claudeProject":
      return {
        key: claudeProjectKey(node.projectDir),
        target: { tool: "claude", id: "", claudeProjectDir: node.projectDir },
        level: "claudeProject",
      };
    case "session":
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
}

function codexTarget(info: SessionInfo): SelectionTarget {
  return { tool: info.tool, id: info.backupId };
}

function flattenSessions(nodes: TreeNode[]): SessionInfo[] {
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

function checkbox(selected: boolean): vscode.TreeItemCheckboxState {
  return selected
    ? vscode.TreeItemCheckboxState.Checked
    : vscode.TreeItemCheckboxState.Unchecked;
}

function toolDirs(): { claude: string; codex: string } {
  const cfg = getConfig();
  return {
    claude:
      cfg.sources.find((s) => s.name === "claude")?.path ??
      path.join(os.homedir(), ".claude"),
    codex:
      cfg.sources.find((s) => s.name === "codex")?.path ??
      path.join(os.homedir(), ".codex"),
  };
}
