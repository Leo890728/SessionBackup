import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { BackupKind, runBackup } from "./ops/backup";
import { materializeCodexRevision, readCodexMetaCwd } from "./agents/codexLocalize";
import { ConflictRecord, ConflictRegistry } from "./store/conflicts";
import { showConflictComparison } from "./ui/conflictView";
import {
  clearLegacyIgnoredSessions,
  getConfig,
  readLegacyIgnoredSessions,
  updateSelectedSessions,
} from "./config";
import { registerDebugCommands } from "./ui/debug";
import { getSessionToken } from "./git/github/auth";
import { configReaction } from "./configChange";
import { CommandDeps } from "./commands/deps";
import { registerBackupCommands } from "./commands/backup";
import { registerConflictCommands } from "./commands/conflict";
import { registerProjectsCommands } from "./commands/projects";
import { registerRepositoryCommands } from "./commands/repository";
import { registerSelectionCommands } from "./commands/selection";
import { registerSessionsCommands } from "./commands/sessions";
import { nodeLabel } from "./ui/nodeLabel";
import { setupRemote } from "./git/setupRemote";
import { Git } from "./git/git";
import {
  applyMachineIdentity,
  deriveMachineId,
  MachineIdentityStore,
} from "./store/machineIdentity";
import { ProjectMappingRegistry } from "./store/projectMapping";
import { RepositoryTreeProvider } from "./ui/repositoryTree";
import { describeSelectionKey } from "./store/selection";
import { initialSelectionKeys } from "./store/selectionMigration";
import { renderSessionMarkdown } from "./agents/transcript";
import {
  conversationOpenTarget,
  takeClaudeConversationHandoff,
} from "./render/sessionConversation";
import { showSessionPreview } from "./ui/sessionPreview";
import {
  machineIdFromConfig,
  manifestRelativePath,
  readManifest,
  revisionRelativePath,
  setAutoMachineId,
} from "./store/sessionStore";
import { SessionTreeProvider } from "./ui/sessionTree";
import { SessionDecorationProvider } from "./ui/sessionDecorations";
import { TreeNode } from "./ui/treeNodes";
import { rememberKeepLocal, runSync } from "./ops/sync";

let timer: NodeJS.Timeout | undefined;
let statusItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel("Session Backup");
  // 必須在任何備份/同步之前同步設定好，之後 machineIdFromConfig 才拿得到自動值。
  setAutoMachineId(deriveMachineId(os.hostname(), vscode.env.machineId));
  void migrateMachineIdentity(context, out);
  const projects = new ProjectMappingRegistry(context.globalStorageUri.fsPath);
  const tree = new SessionTreeProvider(context.extensionUri, projects);
  void migrateToSelection(context, out, tree);
  const conflicts = new ConflictRegistry(context.globalStorageUri.fsPath);
  const repository = new RepositoryTreeProvider(out, projects, conflicts, () =>
    tree.refresh(),
  );

  statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusItem.command = "sessionBackup.backupNow";
  updateStatus(context);
  statusItem.show();

  const commands: CommandDeps = {
    context,
    out,
    projects,
    conflicts,
    repository,
    tree,
    backupNow: () => backupNow(context, out, "manual", projects, repository, tree),
  };

  context.subscriptions.push(
    out,
    statusItem,
    repository,
    // Sessions 側欄的 U/M 狀態標記（比照檔案總管的 git 裝飾）。
    new SessionDecorationProvider(),
    ...registerBackupCommands(commands),
    ...registerConflictCommands(commands),
    ...registerProjectsCommands(commands),
    ...registerSelectionCommands(commands),
    ...registerRepositoryCommands(commands),
    ...registerDebugCommands({
      context,
      out,
      projects,
      conflicts,
      repository,
      tree,
      refreshStatus: () => updateStatus(context),
    }),
    // 剛登入 GitHub 時備份庫還沒接上，雲端專案是掃描時才會被抓下來的（見
    // RepositoryTreeProvider.detectState）；Sessions 側欄要等它抓完才有東西可讀，
    // 所以這裡只負責觸發掃描，重讀交給 onDidChangeLocalRepository。
    vscode.authentication.onDidChangeSessions((event) => {
      if (event.provider.id === "github") {
        repository.refresh();
      }
    }),
    repository.onDidChangeLocalRepository(() => {
      tree.refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      const reaction = configReaction((key) => e.affectsConfiguration(key));
      if (reaction.reloadSelection) {
        tree.reloadSelection();
        // 這裡是唯一保證 getConfiguration() 讀得到新選取的時機：await update() 回來
        // 之後設定模型不一定已經發布，搶先掃描會算出舊的「有變動的 sessions」。
        // 所以勾選造成的重掃一律由這個事件驅動，呼叫端不要自己 refresh。
        repository.refresh(false);
      }
      if (reaction.reconfigure) {
        repository.reconfigure();
      }
      if (reaction.restartTimer) {
        restartTimer(context, out, projects, repository, tree, conflicts);
      }
    }),
  );

  // ---- Session 瀏覽器 ----
  // Sessions 用 createTreeView 才收得到 checkbox 事件；勾選狀態由選取規則決定，
  // 不讓 VS Code 自動連動父子項目（範圍規則有自己的優先序）。
  const sessionsView = vscode.window.createTreeView("sessionBackup.sessions", {
    treeDataProvider: tree,
    showCollapseAll: true,
    manageCheckboxStateManually: true,
  });
  context.subscriptions.push(
    sessionsView,
    // 重掃由 onDidChangeConfiguration 驅動（見上），這裡只負責寫入選取規則。
    sessionsView.onDidChangeCheckboxState((e) => {
      void tree.handleCheckboxChange(e.items);
    }),
    vscode.window.registerTreeDataProvider(
      "sessionBackup.repository",
      repository,
    ),
    ...registerSessionsCommands(commands),
  );

  restartTimer(context, out, projects, repository, tree, conflicts);
  void resumeClaudeConversationHandoff(context);
  if (getConfig().backupOnStartup) {
    void autoSync(context, out, projects, repository, tree, conflicts);
  }
}

async function resumeClaudeConversationHandoff(
  context: vscode.ExtensionContext,
): Promise<void> {
  const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const handoff = await takeClaudeConversationHandoff(
    context.globalStorageUri.fsPath,
    workspaceCwd,
  );
  if (!handoff) {
    return;
  }

  const target = conversationOpenTarget("claude", handoff.sessionId);
  if (target.kind !== "command") {
    return;
  }
  try {
    const extension = vscode.extensions.getExtension(target.extensionId);
    if (!extension) {
      vscode.window.showWarningMessage(
        "Session Backup: 尚未安裝 Claude Code 擴充套件，無法開啟這份對話。",
      );
      return;
    }
    await extension.activate();
    await vscode.commands.executeCommand(target.command, ...target.args);
  } catch (error) {
    const detail = error instanceof Error ? `：${error.message}` : "";
    vscode.window.showErrorMessage(
      `Session Backup: 無法在 Claude Code 開啟這份對話${detail}`,
    );
  }
}

export function deactivate(): void {
  if (timer) {
    clearInterval(timer);
  }
}

/**
 * machineId 換名（改主機名稱、重裝 VS Code、手動設定 sessionBackup.machineId）時
 * 把備份庫裡的 machines/<舊>/ 改名過來，避免留下孤兒 manifest 被當成另一台電腦。
 */
async function migrateMachineIdentity(
  context: vscode.ExtensionContext,
  out: vscode.OutputChannel,
): Promise<void> {
  try {
    const cfg = getConfig();
    const machineId = machineIdFromConfig(cfg);
    const store = new MachineIdentityStore(context.globalStorageUri.fsPath);
    const { result, from } = await applyMachineIdentity(
      store,
      cfg.repoPath,
      machineId,
      os.hostname(), // 0.2.1 之前留空時的預設值
    );
    if (result === "renamed") {
      out.appendLine(
        `machineId 已從 ${from} 改為 ${machineId}，備份庫目錄一併搬移`,
      );
    } else if (result === "blocked") {
      out.appendLine(
        `machineId 從 ${from} 改為 ${machineId}，但 machines/${machineId}/ 已存在，` +
          "未搬移舊目錄；請確認兩者是否為同一台電腦",
      );
    }
  } catch (e: any) {
    out.appendLine("machineId 遷移失敗：" + e.message);
  }
}

/**
 * 0.3.0 起備份改為「選擇制」：只備份使用者勾選的對話。
 * 升級時把本機 manifest 中已備份過的 session 直接設為選取，
 * 避免既有備份在使用者不知情的情況下停止更新；舊的忽略清單轉成排除規則。
 */
async function migrateToSelection(
  context: vscode.ExtensionContext,
  out: vscode.OutputChannel,
  tree: SessionTreeProvider,
): Promise<void> {
  if (context.globalState.get<boolean>("selectionMigrated")) {
    return;
  }
  try {
    const cfg = getConfig();
    const legacy = readLegacyIgnoredSessions();
    if (!cfg.selectedSessions.length) {
      const manifest = await readManifest(
        path.join(
          cfg.repoPath,
          ...manifestRelativePath(machineIdFromConfig(cfg)).split("/"),
        ),
      );
      const keys = initialSelectionKeys(manifest, legacy);
      if (keys.length) {
        await updateSelectedSessions(() => keys);
        tree.reloadSelection();
        out.appendLine(
          `備份改為選擇制：已將 ${keys.length} 個先前備份過的 session 設為選取，` +
            "之後新增的對話請自行勾選",
        );
      }
      void notifySelectionChange(keys.length);
    }
    if (legacy.length) {
      await clearLegacyIgnoredSessions();
      out.appendLine(
        `已移除 ${legacy.length} 筆舊的 sessionBackup.ignoredSessions 設定`,
      );
    }
    await context.globalState.update("selectionMigrated", true);
  } catch (e: any) {
    out.appendLine("備份選取遷移失敗：" + e.message);
  }
}

async function notifySelectionChange(migrated: number): Promise<void> {
  const open = "開啟 Sessions 側欄";
  const message = migrated
    ? `Session Backup: 備份改為選擇制，已保留 ${migrated} 個先前備份過的對話；` +
      "新的對話要自行勾選才會備份。"
    : "Session Backup: 備份改為選擇制，請先在 Sessions 側欄勾選要備份的對話。";
  const pick = await vscode.window.showInformationMessage(message, open);
  if (pick === open) {
    await vscode.commands.executeCommand("sessionBackup.sessions.focus");
  }
}

function restartTimer(
  context: vscode.ExtensionContext,
  out: vscode.OutputChannel,
  projects: ProjectMappingRegistry,
  repository: RepositoryTreeProvider,
  tree: SessionTreeProvider,
  conflicts: ConflictRegistry,
): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
  const minutes = getConfig().autoBackupMinutes;
  if (minutes > 0) {
    // 自動排程跑「同步」而非單純備份：先拉遠端合併、再備份上傳，多機幾乎即時同步。
    timer = setInterval(
      () =>
        void autoSync(context, out, projects, repository, tree, conflicts),
      minutes * 60 * 1000,
    );
  }
}

/** 非互動自動同步：不跳任何視窗，衝突累積在側欄，失敗只記錄不打擾。 */
async function autoSync(
  context: vscode.ExtensionContext,
  out: vscode.OutputChannel,
  projects: ProjectMappingRegistry,
  repository: RepositoryTreeProvider,
  tree: SessionTreeProvider,
  conflicts: ConflictRegistry,
): Promise<void> {
  try {
    const summary = await runSync(out, projects, conflicts, {
      interactive: false,
    });
    out.appendLine(
      `[${new Date().toLocaleString()}] 自動同步：新增 ${summary.added}、更新 ${summary.updated}、` +
        `保留本機 ${summary.keptLocal}、衝突 ${summary.conflicts}、延後 ${summary.deferred}` +
        (summary.unmappedProjects.length
          ? `、待對應專案 ${summary.unmappedProjects.length}（` +
            summary.unmappedProjects
              .map((project) => project.displayName)
              .join("、") +
            "，見 Sessions 側欄)"
          : ""),
    );
    await context.globalState.update("lastBackup", Date.now());
    updateStatus(context);
    repository.refresh();
    tree.refresh();
  } catch (err: any) {
    out.appendLine("自動同步失敗：" + (err.stack ?? err.message));
  }
}

async function backupNow(
  context: vscode.ExtensionContext,
  out: vscode.OutputChannel,
  kind: BackupKind,
  projects: ProjectMappingRegistry,
  repository: RepositoryTreeProvider,
  tree?: SessionTreeProvider,
): Promise<void> {
  const exec = async () => {
    try {
      const r = await runBackup(out, kind, projects);
      out.appendLine(`[${new Date().toLocaleString()}] ${kind}: ${r.message}`);
      if (r.committed) {
        await context.globalState.update("lastBackup", Date.now());
      }
      updateStatus(context);
      repository.refresh();
      tree?.refresh();
      return r;
    } catch (err: any) {
      out.appendLine("備份失敗：" + (err.stack ?? err.message));
      if (kind === "manual") {
        vscode.window.showErrorMessage(
          "Session Backup 備份失敗：" + err.message,
        );
      }
      return undefined;
    }
  };

  if (kind === "manual") {
    const r = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Session Backup: 備份中...",
      },
      exec,
    );
    if (r) {
      vscode.window.showInformationMessage("Session Backup: " + r.message);
    }
  } else {
    await exec();
  }
}

function updateStatus(context: vscode.ExtensionContext): void {
  const last = context.globalState.get<number>("lastBackup");
  statusItem.text = "$(cloud-upload) Session";
  statusItem.tooltip = last
    ? `上次備份：${new Date(last).toLocaleString()}\n點擊立即備份`
    : "尚未備份，點擊立即備份";
}
