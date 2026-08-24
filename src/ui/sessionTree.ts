import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { getConfig, updateSelectedSessions } from "../config";
import { applyRule, partialHint, SelectionSet } from "../store/selection";
import { SessionInfo } from "../agents/types";
import { clearSessionCache } from "../agents/sessionFile";
import { groupSessionProjects, sessionProjectIdentity } from "../agents/grouping";
import { listClaudeProjects, listClaudeSessions } from "../agents/claude";
import { codexSessionInfo, groupCodexThreads, listCodexFiles } from "../agents/codex";
import {
  buildStatusLookup,
  resolveSessionStatus,
  STATUS_DISPLAY,
  StatusLookup,
} from "../store/sessionStatus";
import { ProjectMappingRegistry } from "../store/projectMapping";
import {
  machineIdFromConfig,
  manifestRelativePath,
  readManifest,
  readMachineManifests,
} from "../store/sessionStore";
import {
  aggregateRemoteProjects,
  filterUnmapped,
  RemoteProject,
} from "../store/unmappedProjects";
import {
  ClaudeProjectNode,
  CodexProjectNode,
  ProjectNode,
  TreeNode,
} from "./treeNodes";
import {
  applyAiSelection,
  codexTarget,
  collectCodexInfos,
  flattenSessions,
  groupDescription,
  PARTIAL_TIP,
  projectSelectionTip,
  ruleFor,
  selectionSummary,
} from "./treeSelection";

export class SessionTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    TreeNode | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private lookup?: Promise<StatusLookup>;
  private unmapped?: Promise<RemoteProject[]>;
  private localProjects?: Promise<ProjectNode[]>;
  /** getTreeItem 是同步的，選取狀態必須先備妥。 */
  private selection = new SelectionSet(getConfig().selectedSessions);

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly projects: ProjectMappingRegistry,
  ) {}

  refresh(): void {
    clearSessionCache();
    this.lookup = undefined;
    this.unmapped = undefined;
    this.localProjects = undefined;
    this.selection = new SelectionSet(getConfig().selectedSessions);
    this._onDidChangeTreeData.fire(undefined);
  }

  /** 只重讀選取設定並重畫，不清掉標題快取（勾選 checkbox 的路徑）。 */
  reloadSelection(): void {
    this.lookup = undefined;
    this.unmapped = undefined;
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
            ...manifestRelativePath(machineIdFromConfig(cfg)).split("/"),
          ),
        );
        return buildStatusLookup(manifest, selection, cfg.maxFileSizeMB);
      })();
    }
    return this.lookup;
  }

  /**
   * 遠端 manifest 提到、本機解不出位置的 Claude 專案，per-refresh 快取。
   * 判斷交給 ProjectMappingRegistry.isMapped，與同步時的行為保持一致。
   */
  private getUnmappedProjects(): Promise<RemoteProject[]> {
    if (!this.unmapped) {
      const selection = this.selection;
      this.unmapped = (async () => {
        try {
          const cfg = getConfig();
          const manifests = await readMachineManifests(cfg.repoPath);
          const remote = aggregateRemoteProjects(
            manifests,
            machineIdFromConfig(cfg),
            selection,
          );
          return await filterUnmapped(remote, (project) =>
            this.projects.isMapped(project),
          );
        } catch {
          // 備份庫還沒建立或讀不到：側欄照常顯示本機內容即可。
          return [];
        }
      })();
    }
    return this.unmapped;
  }

  getTreeItem(n: TreeNode): vscode.TreeItem {
    switch (n.kind) {
      case "project": {
        const item = new vscode.TreeItem(
          n.label,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.id = `project:${n.key}`;
        const summaries = n.children.map((child) =>
          selectionSummary(this.selection, child),
        );
        const total = summaries.reduce(
          (sum, summary) => sum + summary.total,
          0,
        );
        const chosen = summaries.reduce(
          (sum, summary) => sum + summary.chosen,
          0,
        );
        const selected =
          summaries.length > 0 &&
          summaries.every((summary) => summary.selected);
        const partial = partialHint(chosen, total);
        const summary = `${n.children.length} AI · ${groupDescription(
          total,
          chosen,
          selected,
          partial,
        )}`;
        // 工作目錄不在這台電腦上時要一眼看得出來，否則它混在本機專案裡
        // 看起來就像已經對應好了。
        item.description = n.local ? summary : `未對應 · ${summary}`;
        item.tooltip =
          (n.cwd
            ? `工作目錄:${n.cwd}\n\n`
            : "這個專案沒有可用的工作目錄。\n\n") +
          (n.local
            ? ""
            : "這個工作目錄在本機不存在——多半是從其他電腦同步回來的對話，" +
              "也可能是資料夾已被移動或刪除。對話仍可瀏覽與勾選。\n\n") +
          (partial ? PARTIAL_TIP : "") +
          projectSelectionTip(n.children);
        item.iconPath = n.local
          ? vscode.ThemeIcon.Folder
          : new vscode.ThemeIcon(
              "cloud",
              new vscode.ThemeColor("descriptionForeground"),
            );
        item.contextValue = selected ? "projectSelected" : "projectUnselected";
        item.checkboxState = checkbox(selected);
        return item;
      }
      case "claudeProject": {
        const item = new vscode.TreeItem(
          "Claude Code",
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.id = `ai:${n.projectKey}:claude`;
        const { total, chosen, selected } = selectionSummary(this.selection, n);
        const partial = partialHint(chosen, total);
        item.description = groupDescription(total, chosen, selected, partial);
        item.tooltip =
          (n.cwd ? `工作目錄:${n.cwd}\n\n` : "") +
          (partial
            ? PARTIAL_TIP +
              "勾選以備份這個專案的所有 Claude Code 對話（含之後新增的）"
            : selected
              ? "已勾選這個專案的 Claude Code：現有與之後新增的對話都會備份"
              : "勾選以備份這個專案的所有 Claude Code 對話（含之後新增的）");
        item.iconPath = vscode.Uri.joinPath(
          this.extensionUri,
          "media",
          "claude.png",
        );
        item.contextValue = selected ? "aiSelected" : "aiUnselected";
        item.checkboxState = checkbox(selected);
        return item;
      }
      case "codexProject": {
        const item = new vscode.TreeItem(
          "Codex",
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.id = `ai:${n.projectKey}:codex`;
        const { total, chosen, selected } = selectionSummary(this.selection, n);
        const partial = partialHint(chosen, total);
        item.description = groupDescription(total, chosen, selected, partial);
        item.tooltip =
          (n.cwd ? `工作目錄:${n.cwd}\n\n` : "這些對話沒有記錄工作目錄。\n\n") +
          (partial ? PARTIAL_TIP : "") +
          "勾選以備份這個專案目前的所有 Codex 對話（不含之後新增的）";
        item.iconPath = vscode.Uri.joinPath(
          this.extensionUri,
          "media",
          "codex.png",
        );
        item.contextValue = selected ? "aiSelected" : "aiUnselected";
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
            : vscode.TreeItemCollapsibleState.None,
        );
        item.id = `session:${s.file}`;
        const selected = n.status !== "unselected";
        // 子 sessions（Codex 接續／子代理）各有自己的規則，可能跟父節點不一致。
        const subs = n.subs?.length ? flattenSessions(n.subs) : [];
        const chosenSubs = subs.filter((info) =>
          this.selection.includes(codexTarget(info)),
        ).length;
        const partial = partialHint(chosenSubs, subs.length);
        item.description =
          `${display.label} · ${s.date} ${s.time}` +
          (partial ? ` · ${partial}` : "");
        item.tooltip =
          `${s.title}\n\n` +
          `狀態:${display.label} — ${display.detail}\n\n` +
          (partial ? `子 sessions ${PARTIAL_TIP}` : "") +
          (s.subagent ? `子代理:${s.subagent}\n` : "") +
          (n.subs?.length ? `子 sessions:${n.subs.length} 個\n` : "") +
          `${s.file}\n` +
          (s.cwd ? `工作目錄:${s.cwd}\n` : "") +
          `${(s.size / 1024).toFixed(0)} KB，最後更新 ${s.date} ${s.time}`;
        item.contextValue = selected ? "sessionSelected" : "sessionUnselected";
        item.checkboxState = checkbox(selected);
        item.iconPath = new vscode.ThemeIcon(
          display.icon,
          display.color ? new vscode.ThemeColor(display.color) : undefined,
        );
        item.command = {
          command: "sessionBackup.previewSession",
          title: "預覽",
          arguments: [n],
        };
        return item;
      }
      case "unmappedProject": {
        const item = new vscode.TreeItem(
          n.project.displayName,
          vscode.TreeItemCollapsibleState.None,
        );
        item.id = `unmapped:${n.project.id}`;
        item.description = `${n.count} 個對話 · 待對應`;
        item.tooltip =
          `${n.project.displayName}\n\n` +
          `其他電腦（${n.machines.join("、")}）備份過這個專案的 ${n.count} 個對話，` +
          "但本機找不到對應的資料夾。\n\n" +
          "點一下選擇這個專案在本機的位置，之後就會自動同步。";
        // 沒有 checkboxState：還沒有本機檔案可勾，對應完才會長成一般的專案節點。
        item.iconPath = new vscode.ThemeIcon(
          "cloud",
          new vscode.ThemeColor("descriptionForeground"),
        );
        item.contextValue = "unmappedProject";
        item.command = {
          command: "sessionBackup.mapProject",
          title: "對應到本機資料夾",
          arguments: [n],
        };
        return item;
      }
    }
  }

  async getChildren(el?: TreeNode): Promise<TreeNode[]> {
    if (!el) {
      const [projects, unmapped] = await Promise.all([
        this.getLocalProjectNodes(),
        this.getUnmappedProjects(),
      ]);
      return [
        ...projects,
        ...unmapped.map((entry): TreeNode => ({
          kind: "unmappedProject",
          project: entry.project,
          count: entry.count,
          machines: entry.machines,
        })),
      ];
    }
    if (el.kind === "project") {
      return el.children;
    }
    if (el.kind === "claudeProject") {
      const lookup = await this.getLookup();
      const batches = await Promise.all(
        el.projects.map(async (project) => {
          const projectDir = path.basename(project.dir);
          const sessions = await listClaudeSessions(project.dir);
          return await Promise.all(
            sessions.map(async (info) => ({
              kind: "session" as const,
              info,
              claudeProjectDir: projectDir,
              conversationCwd: el.cwd,
              status: await resolveSessionStatus(lookup, {
                tool: info.tool,
                id: info.backupId,
                file: info.file,
                // manifest 中 Claude 的 relativePath 不含機器的 project bucket
                relativePath: "projects/" + path.basename(info.file),
                mtimeMs: info.mtime,
                size: info.size,
                claudeProjectDir: projectDir,
              }),
            })),
          );
        }),
      );
      return batches.flat().sort((a, b) => b.info.mtime - a.info.mtime);
    }
    if (el.kind === "codexProject") {
      return this.buildCodexSessionNodes(el);
    }
    if (el.kind === "session") {
      return el.subs ?? [];
    }
    return [];
  }

  /** 勾選/取消勾選（checkbox 與右鍵指令共用）。 */
  async setSelected(node: TreeNode, selected: boolean): Promise<void> {
    if (node.kind === "unmappedProject") {
      // 本機還沒有檔案，沒有可套用的選取規則；對應完成後才會出現一般的專案節點。
      return;
    }
    if (node.kind === "project") {
      // 外層專案等同逐一操作底下的 AI：Claude 保留 project scope，Codex 套目前 sessions。
      await updateSelectedSessions((current) =>
        node.children.reduce(
          (next, child) => applyAiSelection(next, child, selected),
          [...current],
        ),
      );
    } else if (node.kind === "claudeProject" || node.kind === "codexProject") {
      await updateSelectedSessions((current) =>
        applyAiSelection(current, node, selected),
      );
    } else {
      const { key, target, level } = ruleFor(node);
      await updateSelectedSessions((current) =>
        applyRule(
          current,
          key,
          selected,
          new SelectionSet(current).coveredByScope(target, level),
        ),
      );
    }
    this.reloadSelection();
  }

  /** TreeView.onDidChangeCheckboxState 的處理：VS Code 已把新狀態算好。 */
  async handleCheckboxChange(
    items: readonly [TreeNode, vscode.TreeItemCheckboxState][],
  ): Promise<void> {
    for (const [node, state] of items) {
      await this.setSelected(
        node,
        state === vscode.TreeItemCheckboxState.Checked,
      );
    }
  }

  private getLocalProjectNodes(): Promise<ProjectNode[]> {
    if (!this.localProjects) {
      this.localProjects = this.buildLocalProjectNodes();
    }
    return this.localProjects;
  }

  /** 建立與選取狀態無關的「專案 → AI」索引；只有完整 refresh 才重讀 metadata。 */
  private async buildLocalProjectNodes(): Promise<ProjectNode[]> {
    const dirs = toolDirs();
    const [rawClaudeProjects, codexInfos] = await Promise.all([
      fs.existsSync(path.join(dirs.claude, "projects"))
        ? listClaudeProjects(path.join(dirs.claude, "projects"))
        : Promise.resolve([]),
      fs.existsSync(path.join(dirs.codex, "sessions"))
        ? listCodexFiles(path.join(dirs.codex, "sessions")).then((files) =>
            Promise.all(files.map(codexSessionInfo)),
          )
        : Promise.resolve([]),
    ]);
    const claudeProjects = await Promise.all(
      rawClaudeProjects.map(async (project) => {
        const projectDir = path.basename(project.dir);
        const mapped =
          await this.projects.mappedPathForClaudeProject(projectDir);
        if (!mapped) {
          return project;
        }
        const identity = sessionProjectIdentity(mapped);
        return {
          ...project,
          label: identity.label,
          cwd: identity.cwd,
          decoded: identity.cwd ?? mapped,
        };
      }),
    );
    const { topLevel, subsByHost } = groupCodexThreads(codexInfos);

    // 沒有 cwd 的舊紀錄（未識別專案）不算「別台電腦的」，維持在本機那一組。
    const isLocalPath = (cwd: string | undefined): boolean =>
      !cwd || fs.existsSync(cwd);

    return groupSessionProjects(claudeProjects, topLevel, isLocalPath).map(
      (project) => {
        const children: (ClaudeProjectNode | CodexProjectNode)[] =
          project.ai.map((ai) =>
            ai.tool === "claude"
              ? {
                  kind: "claudeProject" as const,
                  projectKey: project.key,
                  projectLabel: project.label,
                  cwd: project.cwd,
                  projects: ai.projects,
                }
              : {
                  kind: "codexProject" as const,
                  projectKey: project.key,
                  projectLabel: project.label,
                  cwd: project.cwd,
                  codexRoot: dirs.codex,
                  topLevel: ai.sessions,
                  subsByHost,
                },
          );
        return {
          kind: "project",
          key: project.key,
          label: project.label,
          cwd: project.cwd,
          latestMtime: project.latestMtime,
          local: project.local,
          children,
        };
      },
    );
  }

  /** 展開 Codex AI 節點時才計算該專案的狀態與子 thread，避免根節點全量 hash。 */
  private async buildCodexSessionNodes(
    node: CodexProjectNode,
  ): Promise<TreeNode[]> {
    const infos = collectCodexInfos(node.topLevel, node.subsByHost);
    const lookup = await this.getLookup();
    const statusByFile = new Map(
      await Promise.all(
        infos.map(
          async (info) =>
            [
              info.file,
              await resolveSessionStatus(lookup, {
                tool: info.tool,
                id: info.backupId,
                file: info.file,
                relativePath: path
                  .relative(node.codexRoot, info.file)
                  .replace(/\\/g, "/"),
                mtimeMs: info.mtime,
                size: info.size,
              }),
            ] as const,
        ),
      ),
    );

    const toNode = (info: SessionInfo, ancestors: Set<string>): TreeNode => {
      const subs = node.subsByHost.get(info.file);
      const nested =
        subs && !ancestors.has(info.file)
          ? subs.map((sub) => toNode(sub, new Set([...ancestors, info.file])))
          : undefined;
      return {
        kind: "session",
        info,
        status: statusByFile.get(info.file) ?? "unbacked",
        subs: nested?.length ? nested : undefined,
      };
    };

    return node.topLevel.map((info) => toNode(info, new Set()));
  }
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
