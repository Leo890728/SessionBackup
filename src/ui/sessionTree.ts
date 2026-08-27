import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { getConfig, toolDirs, updateTrackedSessions } from "../config";
import { applyRule, partialHint, SelectionSet } from "../store/selection";
import { SessionInfo, Tool } from "../agents/types";
import { cleanTitle, clearSessionCache, fmt, readFirstLines } from "../agents/sessionFile";
import { groupSessionProjects, sessionProjectIdentity } from "../agents/grouping";
import { claudeAiTitle, listClaudeProjects, listClaudeSessions } from "../agents/claude";
import { codexSessionInfo, groupCodexThreads, listCodexFiles } from "../agents/codex";
import {
  buildStatusLookup,
  resolveSessionStatus,
  STATUS_DISPLAY,
  StatusLookup,
} from "../store/sessionStatus";
import { ProjectMappingRegistry } from "../store/projectMapping";
import { filesWithSecrets } from "../security/sessionSecretScan";
import {
  machineIdFromConfig,
  MachineManifest,
  manifestRelativePath,
  ProjectRef,
  readManifest,
  readMachineManifests,
  revisionRelativePath,
} from "../store/sessionStore";
import {
  aggregateRemoteProjects,
  filterUnmapped,
  RemoteProject,
  RemoteSession,
  remoteProjectsBySession,
} from "../store/unmappedProjects";
import { splitPendingProjects } from "./pendingProjects";
import { relabelProjects } from "./projectLabels";
import { sessionStatusUri } from "./sessionDecorations";
import {
  ClaudeProjectNode,
  PendingAiNode,
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
  inUnmappedGroup,
  PARTIAL_TIP,
  projectSelectionTip,
  ruleFor,
  selectionSummary,
  UNMAPPED_TIP,
} from "./treeSelection";

export class SessionTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    TreeNode | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private lookup?: Promise<StatusLookup>;
  private unmapped?: Promise<RemoteProject[]>;
  /** 所有機器的 manifest，per-refresh 快取（待對應清單與雲章共用）。 */
  private manifests?: Promise<MachineManifest[]>;
  private localProjects?: Promise<ProjectNode[]>;
  /** getTreeItem 是同步的，選取狀態必須先備妥。 */
  private selection = new SelectionSet(getConfig().trackedSessions);
  /**
   * 展開中的專案 key。VS Code 不會因為展開就重新要一次 TreeItem，而未追蹤的專案
   * 用的是自帶 SVG——不像 ThemeIcon.Folder 有檔案圖示佈景主題幫忙換開合那兩張，
   * 所以要自己記住開合狀態，並在展開／收合時重畫那一列。
   */
  private readonly expandedProjects = new Set<string>();
  /**
   * 「路徑:mtime:大小」→ 有沒有疑似金鑰。掃描要把整份檔案讀過，所以只在展開專案時
   * 掃當層的 sessions，並記住結果；檔案沒動過就不重掃，refresh 也沿用。
   */
  private readonly secretScanCache = new Map<string, boolean>();
  /**
   * 待匯入對話的標題（store 檔案路徑 → 標題，空字串代表讀不到）。
   * store 的路徑含內容雜湊，同一個路徑的內容不會變，所以 refresh 也能沿用。
   */
  private readonly pendingTitles = new Map<string, string>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly projects: ProjectMappingRegistry,
  ) {}

  refresh(): void {
    clearSessionCache();
    this.lookup = undefined;
    this.unmapped = undefined;
    this.manifests = undefined;
    this.localProjects = undefined;
    this.selection = new SelectionSet(getConfig().trackedSessions);
    this._onDidChangeTreeData.fire(undefined);
  }

  /** 只重讀選取設定並重畫，不清掉標題快取（勾選 checkbox 的路徑）。 */
  reloadSelection(): void {
    this.lookup = undefined;
    this.unmapped = undefined;
    this.selection = new SelectionSet(getConfig().trackedSessions);
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
          const manifests = await this.getMachineManifests();
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

  /** 備份庫讀不到（還沒建立、磁碟壞掉）就當成沒有備份，側欄照常顯示本機內容。 */
  private getMachineManifests(): Promise<MachineManifest[]> {
    if (!this.manifests) {
      this.manifests = readMachineManifests(getConfig().repoPath).catch(() => []);
    }
    return this.manifests;
  }

  /**
   * TreeView 的 onDidExpandElement / onDidCollapseElement 轉進來，只為了換資料夾開合圖。
   * 狀態沒變就不重畫：重畫會讓 collapsibleState 改成 Expanded，VS Code 可能再回報一次
   * 展開，沒有這道防線就會來回打轉。
   */
  setProjectExpanded(node: TreeNode, expanded: boolean): void {
    if (node.kind !== "project") {
      return;
    }
    if (this.expandedProjects.has(node.key) === expanded) {
      return;
    }
    if (expanded) {
      this.expandedProjects.add(node.key);
    } else {
      this.expandedProjects.delete(node.key);
    }
    this._onDidChangeTreeData.fire(node);
  }

  /**
   * 未追蹤專案的資料夾圖示：開合 × 雲端有沒有備份，共四張。
   * SVG 的顏色是寫死的（背景圖片吃不到 currentColor），所以 light／dark 各備一套。
   */
  private untrackedFolderIcon(
    expanded: boolean,
    backedUp: boolean,
  ): { light: vscode.Uri; dark: vscode.Uri } {
    const name = `folder-untracked${expanded ? "-opened" : ""}${
      backedUp ? "-cloud" : ""
    }.svg`;
    return {
      light: vscode.Uri.joinPath(this.extensionUri, "media", "light", name),
      dark: vscode.Uri.joinPath(this.extensionUri, "media", "dark", name),
    };
  }

  /**
   * 待匯入對話的標題。manifest 只保存 Codex 的標題（來自 session index），
   * Claude 的一直是空的——它的標題寫在對話檔自己的 aiTitle 欄位裡。
   * 所以 Claude 要翻備份庫裡那份 revision 的開頭才拿得到。
   *
   * 快取以檔案路徑為 key 就夠了：store 的路徑含內容雜湊，同一個路徑的內容
   * 永遠不會變。
   */
  private async pendingTitle(
    session: RemoteSession,
    file: string,
  ): Promise<string | undefined> {
    if (session.tool !== "claude") {
      return session.title;
    }
    const cached = this.pendingTitles.get(file);
    if (cached !== undefined) {
      return cached || undefined;
    }
    const title = claudeAiTitle(await readFirstLines(file));
    this.pendingTitles.set(file, title ? cleanTitle(title) : "");
    return this.pendingTitles.get(file) || undefined;
  }

  /** 展開某一層時才掃那層的 sessions；回傳掃到金鑰的檔案路徑。 */
  private async scanSecrets(
    sessions: readonly SessionInfo[],
  ): Promise<Set<string>> {
    const flagged = new Set<string>();
    if (!getConfig().secretScan) {
      return flagged;
    }
    const key = (info: SessionInfo): string =>
      `${info.file}:${info.mtime}:${info.size}`;
    const pending = sessions.filter(
      (info) => !this.secretScanCache.has(key(info)),
    );
    if (pending.length) {
      const hits = await filesWithSecrets(pending.map((info) => info.file));
      for (const info of pending) {
        this.secretScanCache.set(key(info), hits.has(info.file));
      }
    }
    for (const info of sessions) {
      if (this.secretScanCache.get(key(info))) {
        flagged.add(info.file);
      }
    }
    return flagged;
  }

  getTreeItem(n: TreeNode): vscode.TreeItem {
    switch (n.kind) {
      case "unmappedGroup": {
        // 預設收合：這是一份待辦清單，不該把每天在用的專案擠到看不見的地方。
        const item = new vscode.TreeItem(
          "未對應專案",
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.id = "unmapped-group";
        item.description = String(n.count);
        item.tooltip =
          `${n.count} 個專案在這台電腦上找不到位置。\n\n` +
          "有連結圖示的可以指定它在本機的資料夾：還沒匯入的對話會同步回來，" +
          "已經在本機、但工作目錄還指著別台電腦的對話也會一併改成本機路徑。\n\n" +
          "其餘的是工作目錄已被移動或刪除的專案，對話仍可瀏覽與勾選。";
        item.iconPath = new vscode.ThemeIcon(
          "cloud",
          new vscode.ThemeColor("descriptionForeground"),
        );
        item.contextValue = "unmappedGroup";
        return item;
      }
      case "project": {
        const expanded = this.expandedProjects.has(n.key);
        const item = new vscode.TreeItem(
          n.label,
          expanded
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed,
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
        const summary = groupDescription(total, chosen, selected, partial);
        // 工作目錄不在這台電腦上時要一眼看得出來，否則它混在本機專案裡
        // 看起來就像已經對應好了。還有對話沒下來也要寫在標籤上——只放在 tooltip
        // 的話，使用者看到的就是「這個專案只剩 Codex，Claude 的對話不見了」。
        item.description =
          (n.local ? summary : `未對應 · ${summary}`) +
          (n.unmapped
            ? ` · 另有 ${n.unmapped.sessions.length} 個${toolNames(pendingTools(n.unmapped.sessions))}對話待匯入`
            : "");
        item.tooltip =
          (n.cwd
            ? `工作目錄:${n.cwd}\n\n`
            : "這個專案沒有可用的工作目錄。\n\n") +
          (n.local
            ? ""
            : n.unmapped
              ? `其他電腦（${n.unmapped.machines.join("、")}）還有這個專案的 ` +
                `${n.unmapped.sessions.length} 個${toolNames(pendingTools(n.unmapped.sessions))}對話沒有` +
                "進到本機——同步時解不出這個專案在這台電腦的位置就跳過了。\n\n" +
                "指定它在本機的位置後，那些對話會自動同步回來，" +
                "已經在本機的對話也會把工作目錄改成本機路徑。\n\n" +
                "展開這個專案可以先讀它們——內容已經在本機備份庫裡了。\n\n"
              : n.projectRef
                ? "這些對話是從其他電腦同步回來的，工作目錄還指著來源電腦——" +
                  "Codex 自己那邊也會用那個路徑列出它們。\n\n" +
                  "指定它在本機的位置，就會一併改成本機路徑。\n\n"
                : "這個工作目錄在本機不存在——多半是從其他電腦同步回來的對話，" +
                  "也可能是資料夾已被移動或刪除。對話仍可瀏覽。\n\n") +
          (chosen === 0 && n.backedUp
            ? "雲端備份庫裡已經有這個專案的對話（圖示右下角的雲）；" +
              "取消追蹤只是不再更新，既有備份不會被刪除。\n\n"
            : "") +
          // 未對應那一層不給勾，講勾選規則只會誤導；改講為什麼不能勾。
          (n.local
            ? (partial ? PARTIAL_TIP : "") + projectSelectionTip(n.children)
            : UNMAPPED_TIP);
        // 已追蹤走 ThemeIcon.Folder：它屬於 file-kind，VS Code 會交給使用者的檔案圖示
        // 佈景主題畫，也就是實心那顆。未追蹤要「線框且變暗」——單靠 ThemeIcon 做不到
        // （拿掉 resourceUri 才會退回線框 codicon，但變暗也是 resourceUri 帶來的），
        // 所以自己帶一張 SVG：iconPath 是 Uri 時圖示固定用它，resourceUri 就只剩調暗。
        item.iconPath = !n.local
          ? new vscode.ThemeIcon(
              "cloud",
              new vscode.ThemeColor("descriptionForeground"),
            )
          : chosen > 0
            ? vscode.ThemeIcon.Folder
            : this.untrackedFolderIcon(expanded, n.backedUp);
        // 底下一則都沒勾就整層調暗，跟未追蹤的對話同一個訊號；已追蹤的也要有 URI，
        // 檔案圖示佈景主題才會接手（synced 沒有對應的裝飾，不會多畫任何東西）。
        item.resourceUri = sessionStatusUri(
          chosen === 0 ? "unselected" : "synced",
          `project:${n.key}`,
        );
        // 前綴決定 menus 掛不掛得上「對應到本機資料夾」；尾綴 Selected/Unselected
        // 則是右鍵那組勾選指令的 when 條件——未對應時連同 checkbox 一起拿掉，
        // 否則只是把方塊藏起來、右鍵仍然繞得過去。
        item.contextValue =
          n.projectRef && n.strayCwdKeys.length ? "projectUnmapped" : "project";
        if (n.local) {
          item.contextValue += selected ? "Selected" : "Unselected";
          item.checkboxState = checkbox(selected);
        }
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
          (inUnmappedGroup(n)
            ? UNMAPPED_TIP
            : partial
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
        item.resourceUri = dimmedUri(chosen === 0, `${n.projectKey}:claude`);
        item.contextValue = aiContextValue(n, selected);
        if (!inUnmappedGroup(n)) {
          item.checkboxState = checkbox(selected);
        }
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
          (inUnmappedGroup(n)
            ? UNMAPPED_TIP
            : (partial ? PARTIAL_TIP : "") +
              "勾選以備份這個專案目前的所有 Codex 對話（不含之後新增的）");
        item.iconPath = vscode.Uri.joinPath(
          this.extensionUri,
          "media",
          "codex.png",
        );
        item.resourceUri = dimmedUri(chosen === 0, `${n.projectKey}:codex`);
        item.contextValue = aiContextValue(n, selected);
        if (!inUnmappedGroup(n)) {
          item.checkboxState = checkbox(selected);
        }
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
          (n.hasSecret
            ? "⚠ 掃到疑似金鑰：備份時若還沒送出去的新內容含金鑰，會逐一跟你確認。\n\n"
            : "") +
          (inUnmappedGroup(n) ? UNMAPPED_TIP : "") +
          `狀態:${display.label} — ${display.detail}\n\n` +
          (partial ? `子 sessions ${PARTIAL_TIP}` : "") +
          (s.subagent ? `子代理:${s.subagent}\n` : "") +
          (n.subs?.length ? `子 sessions:${n.subs.length} 個\n` : "") +
          `${s.file}\n` +
          (s.cwd ? `工作目錄:${s.cwd}\n` : "") +
          `${(s.size / 1024).toFixed(0)} KB，最後更新 ${s.date} ${s.time}`;
        // 未對應時只留 "session" 前綴：開啟/匯出那組選單看的是前綴，照常可用；
        // 勾選那組看的是 Selected/Unselected 尾綴，跟著 checkbox 一起消失。
        item.contextValue = inUnmappedGroup(n)
          ? "session"
          : selected
            ? "sessionSelected"
            : "sessionUnselected";
        if (!inUnmappedGroup(n)) {
          item.checkboxState = checkbox(selected);
        }
        // 狀態走 FileDecorationProvider（列尾的 U/M 字母），圖示就退回中性的對話符號，
        // 兩邊都畫狀態只會互相打架。
        item.resourceUri = sessionStatusUri(n.status, s.file);
        // 掃到疑似金鑰時整顆圖示換掉：這比列尾多一個字母更難忽略，而備份與否
        // 仍然由 checkbox 與 U/M 標記各自表達，不會被蓋掉。
        item.iconPath = n.hasSecret
          ? {
              light: vscode.Uri.joinPath(
                this.extensionUri,
                "media",
                "light",
                "secret-warn.svg",
              ),
              dark: vscode.Uri.joinPath(
                this.extensionUri,
                "media",
                "dark",
                "secret-warn.svg",
              ),
            }
          : new vscode.ThemeIcon("comment-discussion");
        item.command = {
          command: "sessionBackup.previewSession",
          title: "預覽",
          arguments: [n],
        };
        return item;
      }
      case "pendingAi": {
        const item = new vscode.TreeItem(
          TOOL_LABEL[n.tool],
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.id = `pending:${n.projectLabel}:${n.tool}`;
        item.description = `${n.sessions.length} 個待匯入`;
        item.tooltip =
          `這些對話已經備份在 ${n.machines.join("、")}，但還沒進到這台電腦——\n` +
          "同步時解不出這個專案在本機的位置就跳過了。\n\n" +
          "可以先點開來讀（內容取自本機備份庫）。對應資料夾之後它們才會落地成\n" +
          "一般的對話，屆時才有核取方塊可以決定要不要繼續備份。";
        // 與本機的 AI 節點用同一張圖：這一層代表的是同一件事，只差還沒落地。
        // 「還沒下來」由列尾的描述與整層調暗表示，不必換成別的圖示。
        item.iconPath = vscode.Uri.joinPath(
          this.extensionUri,
          "media",
          `${n.tool}.png`,
        );
        item.contextValue = "pendingAi";
        // 沒有 checkboxState：本機還沒有檔案，沒有可套用的選取規則。
        item.resourceUri = sessionStatusUri(
          "unselected",
          `pending:${n.projectLabel}:${n.tool}`,
        );
        return item;
      }
      case "pendingSession": {
        const item = new vscode.TreeItem(
          n.session.title || "(無標題)",
          vscode.TreeItemCollapsibleState.None,
        );
        item.id = `pendingSession:${n.session.tool}:${n.session.id}`;
        const { date, time } = fmt(n.session.mtimeMs);
        item.description = `${date} ${time} · 待匯入`;
        item.tooltip =
          `${n.session.title || "(無標題)"}\n\n` +
          `備份自 ${n.session.machineId}，本機還沒有這個檔案。\n` +
          "點一下可以直接讀備份庫裡的內容。";
        item.iconPath = new vscode.ThemeIcon(
          "cloud",
          new vscode.ThemeColor("descriptionForeground"),
        );
        item.contextValue = "pendingSession";
        item.resourceUri = sessionStatusUri(
          "unselected",
          `pendingSession:${n.session.id}`,
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
          n.label ?? n.project.displayName,
          n.sessions.length
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None,
        );
        item.id = `unmapped:${n.project.id}`;
        item.description = `${n.count} 個對話 · 待對應`;
        item.tooltip =
          `${n.project.displayName}\n\n` +
          `其他電腦（${n.machines.join("、")}）備份過這個專案的 ${n.count} 個對話，` +
          "但本機找不到對應的資料夾。\n\n" +
          "點一下選擇這個專案在本機的位置，之後就會自動同步。\n\n" +
          "展開可以先讀它們——內容已經在本機備份庫裡了。";
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
      // 待處理的東西擺前面：解不出本機位置的專案（本機有檔案但工作目錄不在）
      // 與只在其他電腦備份過的專案，都收進同一層，不跟已對應的專案混在一起。
      // 同一個專案的這兩半在 splitPendingProjects 併成一個節點。
      const split = splitPendingProjects(projects, unmapped);
      // 標籤在這裡才決定：撞名是「同時被顯示的這一組」的性質，備份時算不出來。
      const relabelled = relabelProjects([...split.pending, ...split.mapped]);
      const pending = relabelled.slice(0, split.pending.length);
      const mapped = relabelled.slice(split.pending.length);
      return pending.length
        ? [{ kind: "unmappedGroup", count: pending.length, children: pending }, ...mapped]
        : mapped;
    }
    if (el.kind === "unmappedGroup") {
      return el.children;
    }
    if (el.kind === "project") {
      // 還沒匯入的那一半排在本機的後面：它們沒有 checkbox，混在前面會讓
      // 整個專案看起來像是不能勾。
      return [...el.children, ...pendingAiNodes(el.label, el.unmapped)];
    }
    if (el.kind === "unmappedProject") {
      // 本機一個檔案都沒有，底下全是待匯入的——包括被搬出 ~/.codex/sessions
      // 的那些。內容在備份庫裡，對應之前就讀得到。
      return pendingAiNodes(el.label ?? el.project.displayName, {
        machines: el.machines,
        sessions: el.sessions,
      });
    }
    if (el.kind === "pendingAi") {
      const repoPath = getConfig().repoPath;
      return Promise.all(
        el.sessions.map(async (session): Promise<TreeNode> => {
          const file = path.join(
            repoPath,
            ...revisionRelativePath(session.tool, session.id, session.hash).split("/"),
          );
          return {
            kind: "pendingSession",
            session: { ...session, title: await this.pendingTitle(session, file) },
            file,
          };
        }),
      );
    }
    if (el.kind === "pendingSession") {
      return [];
    }
    if (el.kind === "claudeProject") {
      const lookup = await this.getLookup();
      const batches = await Promise.all(
        el.projects.map(async (project) => {
          const projectDir = path.basename(project.dir);
          const sessions = await listClaudeSessions(project.dir);
          return sessions.map((info) => ({ info, projectDir }));
        }),
      );
      const entries = batches.flat();
      // 整層一次掃完：filesWithSecrets 會依磁碟根目錄分組，逐一呼叫只是白開檔。
      const secrets = await this.scanSecrets(entries.map((e) => e.info));
      const nodes = await Promise.all(
        entries.map(async ({ info, projectDir }) => ({
          kind: "session" as const,
          info,
          claudeProjectDir: projectDir,
          conversationCwd: el.cwd,
          inUnmappedGroup: el.inUnmappedGroup,
          hasSecret: secrets.has(info.file),
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
      return nodes.sort((a, b) => b.info.mtime - a.info.mtime);
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
    if (node.kind === "unmappedGroup") {
      // 分層用的節點，本身沒有可勾選的東西。
      return;
    }
    if (node.kind === "unmappedProject") {
      // 本機還沒有檔案，沒有可套用的選取規則；對應完成後才會出現一般的專案節點。
      return;
    }
    if (inUnmappedGroup(node)) {
      // 未對應專案底下整層都不給勾。這裡是 checkbox 與右鍵指令共用的入口，
      // 擋在這一層，畫面上少掉的方塊才不會被別的路徑繞過去。
      return;
    }
    if (node.kind === "project") {
      // 外層專案等同逐一操作底下的 AI：Claude 保留 project scope，Codex 套目前 sessions。
      await updateTrackedSessions((current) =>
        node.children.reduce(
          (next, child) => applyAiSelection(next, child, selected),
          [...current],
        ),
      );
    } else if (node.kind === "claudeProject" || node.kind === "codexProject") {
      await updateTrackedSessions((current) =>
        applyAiSelection(current, node, selected),
      );
    } else if (node.kind === "pendingAi" || node.kind === "pendingSession") {
      // 本機還沒有檔案，沒有可套用的選取規則；對應完落地後才有核取方塊。
      return;
    } else {
      const { key, target, level } = ruleFor(node);
      await updateTrackedSessions((current) =>
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

  /**
   * 每個工作目錄分組屬於哪個專案。兩個來源缺一不可：
   *
   * - 本機 registry：認得這台電腦自己的路徑（唯讀查，不做 git 偵測也不寫檔）。
   * - 其他電腦的 manifest：認得同步回來、cwd 還指著來源電腦的那些檔案——它們在
   *   本機 registry 裡查不到，因為那個路徑在這台電腦上根本不存在。
   *
   * 兩邊都指向同一個 projectId 時，groupSessionProjects 就會把兩個路徑併成一組。
   */
  private async resolveProjectRefs(
    claudeProjects: readonly { dir: string; cwd?: string; decoded: string; sessionIds: string[] }[],
    codexInfos: readonly SessionInfo[],
    remoteBySession: Map<string, ProjectRef>,
  ): Promise<Map<string, ProjectRef>> {
    const refByKey = new Map<string, ProjectRef>();
    const remember = (
      identityKey: string,
      fallback: () => ProjectRef | undefined,
    ): void => {
      if (refByKey.has(identityKey)) {
        return;
      }
      const ref = fallback();
      if (ref) {
        refByKey.set(identityKey, ref);
      }
    };

    // 1. 本機 registry。先查它，本機路徑的身分才是權威來源。
    const localCwds = new Map<string, string>();
    for (const info of codexInfos) {
      const identity = sessionProjectIdentity(info.cwd);
      if (identity.cwd) {
        localCwds.set(identity.key, identity.cwd);
      }
    }
    for (const project of claudeProjects) {
      const identity = sessionProjectIdentity(project.cwd ?? project.decoded);
      if (project.cwd && identity.cwd) {
        localCwds.set(identity.key, identity.cwd);
      }
    }
    for (const [key, cwd] of localCwds) {
      const ref = await this.projects.projectForLocalPath(cwd);
      if (ref) {
        refByKey.set(key, ref);
      }
    }

    // 2. 其他電腦的 manifest，用 session id 反查。
    for (const info of codexInfos) {
      remember(sessionProjectIdentity(info.cwd).key, () =>
        remoteBySession.get(`codex:${info.backupId}`),
      );
    }
    for (const project of claudeProjects) {
      const identityKey = project.cwd
        ? sessionProjectIdentity(project.cwd).key
        : `claudeBucket:${path.basename(project.dir).toLowerCase()}`;
      remember(identityKey, () =>
        project.sessionIds
          .map((id) => remoteBySession.get(`claude:${id}`))
          .find((ref): ref is ProjectRef => Boolean(ref)),
      );
    }
    return refByKey;
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
    // manifest 的 id 就是 Claude 的檔名 id 與 Codex 的 backupId，兩邊可以直接比對。
    const manifests = await this.getMachineManifests();
    const backedUpIds = new Set(
      manifests.flatMap((manifest) =>
        manifest.sessions.map((session) => `${session.tool}:${session.id}`),
      ),
    );
    const remoteBySession = remoteProjectsBySession(
      manifests,
      machineIdFromConfig(getConfig()),
    );
    const refByCwdKey = await this.resolveProjectRefs(
      claudeProjects,
      codexInfos,
      remoteBySession,
    );

    // 沒有 cwd 的舊紀錄（未識別專案）不算「別台電腦的」，維持在本機那一組。
    const isLocalPath = (cwd: string | undefined): boolean =>
      !cwd || fs.existsSync(cwd);

    return groupSessionProjects(
      claudeProjects,
      topLevel,
      isLocalPath,
      (key) => refByCwdKey.get(key)?.id,
    ).map(
      (project) => {
        const children: (ClaudeProjectNode | CodexProjectNode)[] =
          project.ai.map((ai) =>
            ai.tool === "claude"
              ? {
                  kind: "claudeProject" as const,
                  projectKey: project.key,
                  projectLabel: project.label,
                  cwd: project.cwd,
                  // 專案排進「未對應」那一層時，整層都不給勾——旗標得跟著子節點走。
                  inUnmappedGroup: !project.local,
                  projects: ai.projects,
                }
              : {
                  kind: "codexProject" as const,
                  projectKey: project.key,
                  projectLabel: project.label,
                  cwd: project.cwd,
                  inUnmappedGroup: !project.local,
                  codexRoot: dirs.codex,
                  topLevel: ai.sessions,
                  subsByHost,
                },
          );
        const sessionKeys = project.ai.flatMap((ai) =>
          ai.tool === "claude"
            ? ai.projects.flatMap((claudeProject) =>
                claudeProject.sessionIds.map((id) => `claude:${id}`),
              )
            : collectCodexInfos(ai.sessions, subsByHost).map(
                (info) => `codex:${info.backupId}`,
              ),
        );
        return {
          kind: "project",
          key: project.key,
          label: project.label,
          cwd: project.cwd,
          latestMtime: project.latestMtime,
          local: project.local,
          backedUp: sessionKeys.some((key) => backedUpIds.has(key)),
          projectRef: refByCwdKey.get(project.key),
          strayCwdKeys: project.strayCwdKeys,
          sessionKeys,
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
    const secrets = await this.scanSecrets(infos);
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
        hasSecret: secrets.has(info.file),
        inUnmappedGroup: node.inUnmappedGroup,
        subs: nested?.length ? nested : undefined,
      };
    };

    return node.topLevel.map((info) => toNode(info, new Set()));
  }
}

/** 整層都沒勾時才給裝飾；有勾到一部分就維持正常顏色，不然會蓋掉「部分追蹤」的資訊。 */
function dimmedUri(dim: boolean, key: string): vscode.Uri | undefined {
  return dim ? sessionStatusUri("unselected", key) : undefined;
}

/**
 * 待匯入對話的 AI 名稱，接在數量後面（「5 個 Claude Code 對話」）。
 * 兩種都有就不點名，句子會太長而且也沒幫助。
 */
function toolNames(tools: readonly Tool[]): string {
  if (tools.length !== 1) {
    return "";
  }
  return tools[0] === "claude" ? "Claude Code " : "Codex ";
}

const TOOL_LABEL: Record<Tool, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

/**
 * 還沒匯入的那些對話依 AI 分層。本機有檔案的專案底下與 claudeProject／
 * codexProject 並排；本機一個檔案都沒有的專案（待對應節點）則是全部。
 */
function pendingAiNodes(
  projectLabel: string,
  pending:
    | { machines: string[]; sessions: readonly RemoteSession[] }
    | undefined,
): PendingAiNode[] {
  if (!pending) {
    return [];
  }
  return (["claude", "codex"] as const)
    .map((tool) => ({
      kind: "pendingAi" as const,
      tool,
      projectLabel,
      machines: pending.machines,
      sessions: pending.sessions.filter((session) => session.tool === tool),
    }))
    .filter((ai) => ai.sessions.length > 0);
}

/** 待匯入對話的 AI 名稱，供 unmapped 的數量描述使用。 */
function pendingTools(sessions: readonly { tool: Tool }[]): Tool[] {
  const tools = new Set(sessions.map((session) => session.tool));
  return (["claude", "codex"] as const).filter((tool) => tools.has(tool));
}

/** AI 節點的 contextValue。未對應時不掛尾綴，右鍵那組勾選指令就不會出現。 */
function aiContextValue(
  node: ClaudeProjectNode | CodexProjectNode,
  selected: boolean,
): string {
  if (inUnmappedGroup(node)) {
    return "ai";
  }
  return selected ? "aiSelected" : "aiUnselected";
}

function checkbox(selected: boolean): vscode.TreeItemCheckboxState {
  return selected
    ? vscode.TreeItemCheckboxState.Checked
    : vscode.TreeItemCheckboxState.Unchecked;
}
