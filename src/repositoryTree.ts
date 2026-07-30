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
  ChangedSession,
  classifyRepositoryChanges,
  listChangedSessions,
  localSessionsChanged,
  remoteLabel,
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
  | { kind: "error"; message: string }
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
  | { kind: "changes"; count: number }
  | {
      kind: "changedSession";
      displayName: string;
      change: SessionChangeKind;
      session: LocalSession;
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
  private node: RepositoryNode = { kind: "checking" };
  private changed: {
    displayName: string;
    change: SessionChangeKind;
    session: LocalSession;
  }[] = [];
  private changedTotal = 0;
  private watchers: vscode.FileSystemWatcher[] = [];
  private scanTimer: NodeJS.Timeout | undefined;
  private readonly remoteTimer: NodeJS.Timeout;
  private scanning = false;
  private rescanRequested = false;
  private requestRemoteCheck = false;

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
      const item = new vscode.TreeItem("無法檢查備份狀態");
      item.description = "按一下重試";
      item.tooltip = node.message;
      item.iconPath = new vscode.ThemeIcon(
        "warning",
        new vscode.ThemeColor("list.warningForeground")
      );
      item.command = {
        command: "sessionBackup.refreshRepository",
        title: "重新檢查",
      };
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
      item.command = { command: action.command, title: action.label };
      return item;
    }

    if (node.kind === "changes") {
      const item = new vscode.TreeItem(
        "有變動的 sessions",
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.description = String(node.count);
      item.tooltip = "下次備份會寫入這些 sessions";
      item.iconPath = new vscode.ThemeIcon("request-changes");
      return item;
    }
    if (node.kind === "changedSession") {
      const added = node.change === "added";
      const item = new vscode.TreeItem(node.displayName);
      item.description = added ? "新增" : "已變更";
      item.tooltip =
        `${node.displayName}\n` +
        (added ? "尚未備份過" : "備份後有新內容") +
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
              id: node.session.id,
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
    item.tooltip =
      `GitHub：${node.remote}` +
      (node.date ? `\n最近備份：${node.date}` : "") +
      (node.subject ? `\n${node.subject}` : "");
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
        const items: RepositoryNode[] = this.changed.map((c) => ({
          kind: "changedSession" as const,
          ...c,
        }));
        if (this.changedTotal > this.changed.length) {
          items.push({
            kind: "overflow",
            rest: this.changedTotal - this.changed.length,
          });
        }
        return items;
      }
      if (node.kind === "conflicts") {
        const records = await this.conflicts.list();
        return records.map((record) => ({ kind: "conflictItem" as const, record }));
      }
      return [];
    }
    const roots: RepositoryNode[] = [this.node];
    if (this.changedTotal > 0 && this.node.kind === "action") {
      roots.push({ kind: "changes", count: this.changedTotal });
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
      this.node = { kind: "error", message };
      await this.setChanged([]);
    } finally {
      this.scanning = false;
      this.emitter.fire(undefined);
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

  /** 解析顯示標題（僅前 MAX_CHANGED_SHOWN 筆，避免大量檔案讀取）。 */
  private async setChanged(changed: ChangedSession[]): Promise<void> {
    this.changedTotal = changed.length;
    this.changed = await Promise.all(
      changed.slice(0, MAX_CHANGED_SHOWN).map(async (c) => ({
        change: c.change,
        session: c.session,
        displayName: await sessionDisplayName(c.session),
      }))
    );
  }
}
