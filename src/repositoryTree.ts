import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { ConflictRecord, ConflictRegistry } from "./conflicts";
import { getConfig } from "./config";
import { Git } from "./git";
import {
  findBackupRepositories,
  getSessionToken,
  tokenHeader,
} from "./github";
import { selectAutomaticBackupRepo } from "./githubState";
import { ProjectMappingRegistry } from "./projectMapping";
import {
  ChangedGroup,
  ChangedNode,
  ChangedSession,
  classifyRemoteError,
  classifyRepositoryChanges,
  groupChangedSessions,
  listChangedSessions,
  localSessionsChanged,
  remoteLabel,
  RemoteErrorKind,
  RepositoryChangeState,
  SessionChangeKind,
} from "./repositoryState";
import { sessionDisplayName } from "./sessionSecretScan";
import {
  collectLocalSessions,
  LocalSession,
  machineIdFromConfig,
  manifestRelativePath,
  readManifest,
} from "./sessionStore";

type RepositoryNode =
  | { kind: "checking" }
  | { kind: "connect" }
  | { kind: "publish"; remote: string }
  | { kind: "error"; message: string; cause: RemoteErrorKind }
  | {
      kind: "action";
      state: Exclude<RepositoryChangeState, "synced">;
      remote: string;
    }
  | {
      kind: "connected";
      remote: string;
      date?: string;
      subject?: string;
    }
  | { kind: "changes"; count: number; files: number }
  | {
      kind: "changedSession";
      displayName: string;
      change: SessionChangeKind;
      session: LocalSession;
      /** 掛在這個檔案底下的 Codex 子代理檔 */
      children: RepositoryNode[];
      /** 含自己與所有子代理的檔案數；1 表示不需要顯示成一個 thread */
      total: number;
    }
  | {
      kind: "changedThread";
      displayName: string;
      total: number;
      children: RepositoryNode[];
    }
  | { kind: "overflow"; rest: number }
  | { kind: "conflicts"; count: number }
  | { kind: "conflictItem"; record: ConflictRecord };

const LOCAL_SCAN_DELAY_MS = 1200;
const REMOTE_SCAN_INTERVAL_MS = 60_000;
const MAX_CHANGED_SHOWN = 30;

export class RepositoryTreeProvider
  implements vscode.TreeDataProvider<RepositoryNode>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<RepositoryNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly localRepoChanged = new vscode.EventEmitter<void>();
  /**
   * 掃描時動到本地備份庫（自動接上遠端、或從遠端還原）就會觸發。
   * 這時 Sessions 側欄看得到的東西才剛出現（例如剛登入 GitHub 之後的雲端專案），
   * 但它自己不知道，要靠這個事件去重讀。
   */
  readonly onDidChangeLocalRepository = this.localRepoChanged.event;
  private node: RepositoryNode = { kind: "checking" };
  /** 變動清單的頂層列（每個 thread 一列，單檔 session 就是它自己）。 */
  private changed: RepositoryNode[] = [];
  /** 變動檔案總數（不是列數）。 */
  private changedTotal = 0;
  /** 已經建成節點的檔案數，用來算 overflow。 */
  private changedShown = 0;
  private watchers: vscode.FileSystemWatcher[] = [];
  private scanTimer: NodeJS.Timeout | undefined;
  private readonly remoteTimer: NodeJS.Timeout;
  private scanning = false;
  private rescanRequested = false;
  private requestRemoteCheck = false;
  /** 這次掃描動過本地備份庫，掃完要通知外面。 */
  private localRepoTouched = false;

  constructor(
    private readonly out: vscode.OutputChannel,
    private readonly projects: ProjectMappingRegistry,
    private readonly conflicts: ConflictRegistry,
    private readonly onSourcesChanged: () => void
  ) {
    this.rebuildWatchers();
    this.remoteTimer = setInterval(
      () => this.scheduleScan(true, 0),
      REMOTE_SCAN_INTERVAL_MS
    );
    this.scheduleScan(true, 0);
  }

  refresh(checkRemote = true): void {
    this.scheduleScan(checkRemote, 0);
  }

  reconfigure(): void {
    this.rebuildWatchers();
    this.node = { kind: "checking" };
    this.emitter.fire(undefined);
    this.scheduleScan(true, 0);
  }

  dispose(): void {
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
    }
    clearInterval(this.remoteTimer);
    this.disposeWatchers();
    this.emitter.dispose();
    this.localRepoChanged.dispose();
  }

  getTreeItem(node: RepositoryNode): vscode.TreeItem {
    if (node.kind === "checking") {
      const item = new vscode.TreeItem("正在檢查備份狀態…");
      item.iconPath = new vscode.ThemeIcon("loading~spin");
      return item;
    }
    if (node.kind === "connect") {
      const item = new vscode.TreeItem("連接備份儲存庫");
      item.description = "GitHub 個人/組織，或手動 remote URL";
      item.tooltip =
        "用 VS Code 的 GitHub 登入建立或連結私人儲存庫；其他 git server 可手動輸入 remote URL";
      item.iconPath = new vscode.ThemeIcon("repo");
      item.command = {
        command: "sessionBackup.setupRemote",
        title: "連接備份儲存庫",
      };
      return item;
    }
    if (node.kind === "publish") {
      const item = new vscode.TreeItem("備份至遠端儲存庫");
      item.description = remoteLabel(node.remote);
      item.tooltip = "遠端儲存庫尚未有 Session Backup，建立第一份備份並 push";
      item.iconPath = new vscode.ThemeIcon("cloud-upload");
      item.command = {
        command: "sessionBackup.publishGithub",
        title: "備份至遠端儲存庫",
      };
      return item;
    }
    if (node.kind === "error") {
      // 只有連線問題重試才有意義；遠端不見或授權失效時要給對應的出口，
      // 否則使用者只能一直按一個永遠不會成功的「重試」。
      const action = {
        "not-found": {
          label: "找不到遠端備份儲存庫",
          description: "按一下重新連接",
          hint:
            "遠端儲存庫可能已被刪除或改名，也可能是這個帳號沒有存取權。\n" +
            "按一下選擇要連接的備份儲存庫。",
          command: "sessionBackup.setupRemote",
          icon: "repo",
        },
        auth: {
          label: "GitHub 授權已失效",
          description: "按一下重新登入",
          hint: "登入過期、被移出組織，或組織啟用了 SAML SSO 需要重新授權。",
          command: "sessionBackup.signInGithub",
          icon: "key",
        },
        network: {
          label: "無法連線到遠端",
          description: "按一下重試",
          hint: "看起來是網路或代理伺服器問題，稍後會自動再試一次。",
          command: "sessionBackup.refreshRepository",
          icon: "cloud-offline",
        },
        unknown: {
          label: "無法檢查備份狀態",
          description: "按一下重試",
          hint: "",
          command: "sessionBackup.refreshRepository",
          icon: "warning",
        },
      }[node.cause];
      const item = new vscode.TreeItem(action.label);
      item.description = action.description;
      item.tooltip = (action.hint ? action.hint + "\n\n" : "") + node.message;
      item.iconPath = new vscode.ThemeIcon(
        action.icon,
        new vscode.ThemeColor("list.warningForeground")
      );
      item.command = { command: action.command, title: action.label };
      return item;
    }
    if (node.kind === "action") {
      const action = {
        backup: {
          label: "備份至遠端儲存庫",
          description: "偵測到本機變更",
          tooltip: "本機對話有新內容或標題變更，按一下建立備份並上傳",
          icon: "cloud-upload",
          command: "sessionBackup.backupNow",
        },
        sync: {
          label: "同步",
          description: "偵測到其他電腦的備份",
          tooltip: "GitHub 有尚未合併至本機的對話，按一下同步",
          icon: "cloud-download",
          command: "sessionBackup.sync",
        },
        merge: {
          label: "合併並同步",
          description: "本機與遠端皆有變更",
          tooltip: "本機和 GitHub 都有新內容；按一下備份本機並合併遠端紀錄",
          icon: "sync",
          command: "sessionBackup.sync",
        },
      }[node.state];
      const item = new vscode.TreeItem(action.label);
      item.description = action.description;
      item.tooltip = `${action.tooltip}\nGitHub：${remoteLabel(node.remote)}`;
      item.iconPath = new vscode.ThemeIcon(action.icon);
      item.contextValue = "connected";
      item.command = { command: action.command, title: action.label };
      return item;
    }

    if (node.kind === "changes") {
      const item = new vscode.TreeItem(
        "有變動的 sessions",
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.description =
        node.files === node.count ? String(node.count) : `${node.count}（${node.files} 個檔案）`;
      item.tooltip = "下次備份會寫入這些 sessions";
      item.iconPath = new vscode.ThemeIcon("request-changes");
      return item;
    }
    if (node.kind === "changedThread") {
      const item = new vscode.TreeItem(
        node.displayName,
        vscode.TreeItemCollapsibleState.Collapsed
      );
      item.description = `${node.total} 個檔案`;
      item.tooltip = `${node.displayName}\n同一個 thread 的 ${node.total} 個 rollout 檔`;
      item.iconPath = new vscode.ThemeIcon("comment-discussion");
      return item;
    }
    if (node.kind === "changedSession") {
      const added = node.change === "added";
      const item = new vscode.TreeItem(
        node.displayName,
        node.children.length
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None
      );
      // 子代理是跟著主 thread 一起備份的，所以檔案數掛在 thread 這一列上。
      item.description = node.total > 1 ? `${node.total} 個檔案` : added ? "新增" : "已變更";
      item.tooltip =
        `${node.displayName}\n` +
        (added ? "尚未備份過" : "備份後有新內容") +
        (node.total > 1 ? `\n含子代理共 ${node.total} 個檔案` : "") +
        `\n${node.session.file}`;
      item.iconPath = new vscode.ThemeIcon(
        added ? "diff-added" : "diff-modified",
        new vscode.ThemeColor(
          added
            ? "gitDecoration.untrackedResourceForeground"
            : "gitDecoration.modifiedResourceForeground"
        )
      );
      item.command = {
        command: "sessionBackup.previewSession",
        title: "預覽",
        arguments: [
          {
            kind: "session",
            status: added ? "unbacked" : "modified",
            info: {
              tool: node.session.tool,
              file: node.session.file,
              id: node.session.ownId ?? node.session.id,
              backupId: node.session.id,
              mtime: node.session.mtimeMs,
              size: node.session.size,
              title: node.displayName,
              date: "",
              time: "",
            },
          },
        ],
      };
      return item;
    }
    if (node.kind === "overflow") {
      const item = new vscode.TreeItem(`…還有 ${node.rest} 個`);
      item.iconPath = new vscode.ThemeIcon("ellipsis");
      return item;
    }
    if (node.kind === "conflicts") {
      const item = new vscode.TreeItem(
        "衝突",
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.description = String(node.count);
      item.tooltip = "兩台電腦從同一點各自接續的 sessions，點擊項目開啟比較視窗解決";
      item.iconPath = new vscode.ThemeIcon(
        "git-pull-request-closed",
        new vscode.ThemeColor("list.errorForeground")
      );
      return item;
    }
    if (node.kind === "conflictItem") {
      const r = node.record;
      const item = new vscode.TreeItem(r.displayName || r.id);
      item.description = `與 ${r.remoteMachine} 分叉`;
      item.tooltip =
        `${r.displayName}\n\n` +
        `本機與 ${r.remoteMachine} 從同一點各自接續了這個 session。\n` +
        `點擊開啟左右比較視窗；兩邊內容都已保存在備份庫中，選擇可反悔。\n\n` +
        r.localFile;
      item.iconPath = new vscode.ThemeIcon(
        "git-merge",
        new vscode.ThemeColor("list.errorForeground")
      );
      item.command = {
        command: "sessionBackup.resolveConflict",
        title: "解決衝突",
        arguments: [r],
      };
      return item;
    }

    const item = new vscode.TreeItem("已同步");
    item.description = remoteLabel(node.remote);
    // 「換一個備份儲存庫」只有在這裡找得到入口：設定裡的 repoName 改了不會動到 origin。
    item.contextValue = "connected";
    item.tooltip =
      `GitHub：${node.remote}` +
      (node.date ? `\n最近備份：${node.date}` : "") +
      (node.subject ? `\n${node.subject}` : "") +
      "\n\n要改連到其他備份儲存庫，請用右側的「重新連接儲存庫」。";
    item.iconPath = new vscode.ThemeIcon(
      "pass-filled",
      new vscode.ThemeColor("testing.iconPassed")
    );
    item.command = {
      command: "sessionBackup.backupNow",
      title: "立即備份",
    };
    return item;
  }

  async getChildren(node?: RepositoryNode): Promise<RepositoryNode[]> {
    if (node) {
      if (node.kind === "changes") {
        const items: RepositoryNode[] = [...this.changed];
        if (this.changedTotal > this.changedShown) {
          items.push({
            kind: "overflow",
            rest: this.changedTotal - this.changedShown,
          });
        }
        return items;
      }
      if (node.kind === "changedThread") {
        return node.children;
      }
      if (node.kind === "changedSession") {
        return node.children;
      }
      if (node.kind === "conflicts") {
        const records = await this.conflicts.list();
        return records.map((record) => ({ kind: "conflictItem" as const, record }));
      }
      return [];
    }
    const roots: RepositoryNode[] = [this.node];
    if (this.changedTotal > 0 && this.node.kind === "action") {
      roots.push({
        kind: "changes",
        count: this.changed.length,
        files: this.changedTotal,
      });
    }
    const conflictCount = (await this.conflicts.list()).length;
    if (conflictCount > 0 && this.node.kind !== "checking") {
      roots.push({ kind: "conflicts", count: conflictCount });
    }
    return roots;
  }

  private rebuildWatchers(): void {
    this.disposeWatchers();
    for (const source of getConfig().sources) {
      if (!source.path || !fs.existsSync(source.path)) {
        continue;
      }
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(source.path, "**/*.jsonl")
      );
      const changed = () => {
        this.onSourcesChanged();
        this.scheduleScan(false, LOCAL_SCAN_DELAY_MS);
      };
      watcher.onDidCreate(changed);
      watcher.onDidChange(changed);
      watcher.onDidDelete(changed);
      this.watchers.push(watcher);
    }
  }

  private disposeWatchers(): void {
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.watchers = [];
  }

  private scheduleScan(checkRemote: boolean, delay: number): void {
    this.requestRemoteCheck ||= checkRemote;
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
    }
    this.scanTimer = setTimeout(() => {
      this.scanTimer = undefined;
      const shouldCheckRemote = this.requestRemoteCheck;
      this.requestRemoteCheck = false;
      void this.scan(shouldCheckRemote);
    }, delay);
  }

  private async scan(checkRemote: boolean): Promise<void> {
    if (this.scanning) {
      this.rescanRequested = true;
      this.requestRemoteCheck ||= checkRemote;
      return;
    }
    this.scanning = true;
    try {
      this.node = await this.detectState(checkRemote);
    } catch (error: any) {
      const message = error?.message ?? String(error);
      this.out.appendLine("檢查備份狀態失敗：" + message);
      this.node = { kind: "error", message, cause: classifyRemoteError(message) };
      await this.setChanged([]);
    } finally {
      this.scanning = false;
      this.emitter.fire(undefined);
      if (this.localRepoTouched) {
        this.localRepoTouched = false;
        this.localRepoChanged.fire();
      }
      if (this.rescanRequested || this.requestRemoteCheck) {
        this.rescanRequested = false;
        this.scheduleScan(this.requestRemoteCheck, LOCAL_SCAN_DELAY_MS);
      }
    }
  }

  private async detectState(checkRemote: boolean): Promise<RepositoryNode> {
    const cfg = getConfig();
    const git = new Git(cfg.repoPath, this.out);
    let remote = fs.existsSync(path.join(cfg.repoPath, ".git"))
      ? await git.getRemote()
      : undefined;
    if (!remote) {
      const token = await getSessionToken(false);
      if (token) {
        const repositories = await findBackupRepositories(token, cfg.repoName);
        const recovered = selectAutomaticBackupRepo(repositories, cfg.repoName);
        if (recovered) {
          await git.ensureRepo();
          await git.setRemote(recovered.url);
          remote = recovered.url;
          this.localRepoTouched = true;
          this.out.appendLine(`已自動重新連接 GitHub：${recovered.fullName}`);
        }
      }
      if (!remote) {
        await this.setChanged([]);
        return { kind: "connect" };
      }
    }

    const localBranch = await git.currentBranch();
    let authHeader: string | undefined;
    if (checkRemote) {
      const token = remote.includes("github.com") ? await getSessionToken(false) : undefined;
      authHeader = token ? tokenHeader(token) : undefined;
      const fetch = await git.fetchOrigin(authHeader);
      if (fetch.code !== 0) {
        const message = (fetch.stderr || fetch.stdout).trim();
        throw new Error(message || "git fetch 失敗");
      }
    }
    const remoteBranch = await git.resolveRemoteBranch(
      localBranch,
      authHeader,
      checkRemote
    );
    if (!remoteBranch) {
      await this.setChanged([]);
      return { kind: "publish", remote };
    }
    const remoteRef = `origin/${remoteBranch}`;

    // 本地備份庫遺失後重建（例如整個資料夾被刪掉）：有遠端分支但本地沒有任何
    // commit 時，先從雲端還原 manifest 與 store 再比對，否則所有本機 session
    // 都會被誤判成未備份。
    const headCheck = await git.run(["rev-parse", "--verify", "HEAD"], true);
    if (headCheck.code !== 0) {
      const restore = await git.run(["checkout", "-B", remoteBranch, remoteRef], true);
      if (restore.code === 0) {
        this.localRepoTouched = true;
        this.out.appendLine(`已自動從 ${remoteRef} 還原本地備份庫`);
      } else {
        this.out.appendLine(
          `無法自動還原本地備份庫：${(restore.stderr || restore.stdout).trim()}`
        );
      }
    }

    const manifestFile = path.join(
      cfg.repoPath,
      ...manifestRelativePath(machineIdFromConfig(cfg)).split("/")
    );
    const [sessions, manifest, head, status, commits] = await Promise.all([
      collectLocalSessions(
        cfg,
        (cwd, projectDir) => this.projects.identifyLocalProject(cwd, projectDir),
        (cwd) => this.projects.identifyByCwd(cwd)
      ),
      readManifest(manifestFile),
      git.run(["rev-parse", "--verify", "HEAD"], true),
      git.run(["status", "--porcelain"], true),
      git.log(1),
    ]);

    let localAhead = false;
    let remoteAhead = head.code !== 0;
    if (head.code === 0) {
      const divergence = await git.run(
        ["rev-list", "--left-right", "--count", `HEAD...${remoteRef}`],
        true
      );
      if (divergence.code === 0) {
        const [left = "0", right = "0"] = divergence.stdout.trim().split(/\s+/);
        localAhead = Number(left) > 0;
        remoteAhead = Number(right) > 0;
      }
    }

    await this.setChanged(listChangedSessions(sessions, manifest));

    const localChanged =
      localAhead || Boolean(status.stdout.trim()) || localSessionsChanged(sessions, manifest);
    const state = classifyRepositoryChanges(localChanged, remoteAhead);
    if (state !== "synced") {
      return { kind: "action", state, remote };
    }
    return {
      kind: "connected",
      remote,
      date: commits[0]?.date,
      subject: commits[0]?.subject,
    };
  }

  /**
   * 收合成 thread 樹並解析顯示標題。
   *
   * 只建到 MAX_CHANGED_SHOWN 個檔案為止（標題要讀檔），但一律以 thread 為單位
   * 取整組，不會把一個 thread 切一半。
   */
  private async setChanged(changed: ChangedSession[]): Promise<void> {
    this.changedTotal = changed.length;
    const rows: RepositoryNode[] = [];
    let shown = 0;
    for (const group of groupChangedSessions(changed)) {
      if (shown >= MAX_CHANGED_SHOWN) {
        break;
      }
      rows.push(await this.buildGroupNode(group));
      shown += group.total;
    }
    this.changed = rows;
    this.changedShown = shown;
  }

  private async buildChangedNode(node: ChangedNode, total: number): Promise<RepositoryNode> {
    const children = await Promise.all(
      node.children.map((child) => this.buildChangedNode(child, 1))
    );
    return {
      kind: "changedSession",
      change: node.entry.change,
      session: node.entry.session,
      displayName: await sessionDisplayName(node.entry.session),
      children,
      total,
    };
  }

  private async buildGroupNode(group: ChangedGroup): Promise<RepositoryNode> {
    const roots = await Promise.all(
      group.roots.map((root) => this.buildChangedNode(root, group.total))
    );
    // 常見情形：一個主 thread 檔，子代理掛在它底下——直接用它當這一列，
    // 點擊仍然預覽得到主 thread。接續的 rollout 檔會有多個 root，
    // 這時才需要一個純分組列把它們收在一起。
    if (roots.length === 1) {
      return roots[0];
    }
    const first = roots[0];
    return {
      kind: "changedThread",
      displayName: first?.kind === "changedSession" ? first.displayName : group.id,
      total: group.total,
      children: roots,
    };
  }
}
