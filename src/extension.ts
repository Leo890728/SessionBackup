import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { BackupKind, runBackup } from "./backup";
import { materializeCodexRevision, readCodexMetaCwd } from "./codexLocalize";
import { ConflictRecord, ConflictRegistry } from "./conflicts";
import { showConflictComparison } from "./conflictView";
import {
  clearLegacyIgnoredSessions,
  getConfig,
  readLegacyIgnoredSessions,
  updateSelectedSessions,
} from "./config";
import { setupRemote } from "./github";
import { Git } from "./git";
import {
  applyMachineIdentity,
  deriveMachineId,
  MachineIdentityStore,
} from "./machineIdentity";
import { ProjectMappingRegistry } from "./projectMapping";
import { RepositoryTreeProvider } from "./repositoryTree";
import { describeSelectionKey } from "./selection";
import { initialSelectionKeys } from "./selectionMigration";
import { renderSessionMarkdown, Tool } from "./sessions";
import {
  machineIdFromConfig,
  manifestRelativePath,
  readManifest,
  revisionRelativePath,
  setAutoMachineId,
} from "./sessionStore";
import { SessionTreeProvider, TreeNode } from "./sessionTree";
import { rememberKeepLocal, runSync } from "./sync";

const PREVIEW_SCHEME = "session-backup-preview";

let timer: NodeJS.Timeout | undefined;
let statusItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel("Session Backup");
  // 必須在任何備份/同步之前同步設定好，之後 machineIdFromConfig 才拿得到自動值。
  setAutoMachineId(deriveMachineId(os.hostname(), vscode.env.machineId));
  void migrateMachineIdentity(context, out);
  const tree = new SessionTreeProvider(context.extensionUri);
  void migrateToSelection(context, out, tree);
  const projects = new ProjectMappingRegistry(context.globalStorageUri.fsPath);
  const conflicts = new ConflictRegistry(context.globalStorageUri.fsPath);
  const repository = new RepositoryTreeProvider(out, projects, conflicts, () =>
    tree.refresh()
  );

  statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusItem.command = "sessionBackup.backupNow";
  updateStatus(context);
  statusItem.show();

  context.subscriptions.push(
    out,
    statusItem,
    repository,
    vscode.commands.registerCommand("sessionBackup.backupNow", () =>
      backupNow(context, out, "manual", projects, repository, tree)
    ),
    vscode.commands.registerCommand("sessionBackup.sync", async () => {
      try {
        const summary = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Session Backup: 同步並合併其他電腦紀錄...",
          },
          () => runSync(out, projects, conflicts)
        );
        tree.refresh();
        repository.refresh();
        const parts =
          `新增 ${summary.added}、更新 ${summary.updated}、保留本機 ${summary.keptLocal}、` +
          `相同 ${summary.identical}、跳過 ${summary.skipped}` +
          (summary.deferred ? `、延後 ${summary.deferred}` : "");
        if (summary.conflicts > 0) {
          const open = await vscode.window.showWarningMessage(
            `Session Backup: 同步完成（${parts}），有 ${summary.conflicts} 個衝突待處理。`,
            "開啟側欄處理"
          );
          if (open) {
            await vscode.commands.executeCommand("sessionBackup.repository.focus");
          }
        } else {
          vscode.window.showInformationMessage(`Session Backup: 同步完成（${parts}）`);
        }
      } catch (err: any) {
        vscode.window.showErrorMessage("Session Backup 同步失敗：" + err.message);
      }
    }),
    vscode.commands.registerCommand(
      "sessionBackup.resolveConflict",
      async (record?: ConflictRecord) => {
        if (!record?.key) {
          return;
        }
        try {
          const cfg = getConfig();
          const remoteFile = path.join(
            cfg.repoPath,
            ...revisionRelativePath(record.tool, record.id, record.remoteHash).split("/")
          );
          if (!fs.existsSync(remoteFile) || !fs.existsSync(record.localFile)) {
            await conflicts.remove(record.key);
            repository.refresh(false);
            vscode.window.showInformationMessage(
              "Session Backup: 此衝突已不存在，已自清單移除。"
            );
            return;
          }
          const choice = await showConflictComparison({
            tool: record.tool,
            sessionId: record.id,
            aFile: remoteFile,
            aMachine: record.remoteMachine,
            bFile: record.localFile,
            bMachine: machineIdFromConfig(cfg),
          });
          if (choice === "A") {
            if (record.tool === "codex") {
              await materializeCodexRevision(
                remoteFile,
                record.localFile,
                await readCodexMetaCwd(record.localFile)
              );
            } else {
              await fs.promises.copyFile(remoteFile, record.localFile);
            }
            await conflicts.remove(record.key);
            vscode.window.showInformationMessage(
              "Session Backup: 已採用遠端版本（本機原內容仍保存在備份庫中，隨時可反悔）。"
            );
          } else if (choice === "B") {
            await rememberKeepLocal(cfg.repoPath, machineIdFromConfig(cfg), record);
            await conflicts.remove(record.key);
            vscode.window.showInformationMessage("Session Backup: 已保留本機版本。");
          }
          repository.refresh(false);
          tree.refresh();
        } catch (err: any) {
          vscode.window.showErrorMessage("Session Backup 解決衝突失敗：" + err.message);
        }
      }
    ),
    vscode.commands.registerCommand("sessionBackup.manageProjects", () =>
      projects.manage().catch((err) =>
        vscode.window.showErrorMessage("Session Backup 管理專案對應失敗：" + err.message)
      )
    ),
    vscode.commands.registerCommand(
      "sessionBackup.includeSession",
      async (node?: TreeNode) => {
        if (!node) {
          return;
        }
        await tree.setSelected(node, true);
        repository.refresh(false);
        vscode.window.showInformationMessage(
          `Session Backup: 已加入備份 — ${nodeLabel(node)}`
        );
      }
    ),
    vscode.commands.registerCommand(
      "sessionBackup.excludeSession",
      async (node?: TreeNode) => {
        if (!node) {
          return;
        }
        await tree.setSelected(node, false);
        repository.refresh(false);
        vscode.window.showInformationMessage(
          `Session Backup: 已移出備份 — ${nodeLabel(node)}（已上傳的舊備份不會被刪除）`
        );
      }
    ),
    vscode.commands.registerCommand("sessionBackup.manageSelection", async () => {
      const selected = getConfig().selectedSessions;
      if (!selected.length) {
        vscode.window.showInformationMessage(
          "Session Backup: 尚未選取任何要備份的對話，請在 Sessions 側欄勾選。"
        );
        return;
      }
      const picks = await vscode.window.showQuickPick(
        selected.map((key) => ({ label: describeSelectionKey(key), description: key })),
        {
          canPickMany: true,
          placeHolder: "勾選要刪除的選取規則（保留不動的請勿勾選）",
        }
      );
      if (!picks?.length) {
        return;
      }
      const remove = new Set(picks.map((p) => p.description));
      await updateSelectedSessions((current) =>
        current.filter((key) => !remove.has(key))
      );
      repository.refresh(false);
      tree.reloadSelection();
      vscode.window.showInformationMessage(
        `Session Backup: 已刪除 ${picks.length} 條選取規則。`
      );
    }),
    vscode.commands.registerCommand("sessionBackup.setupRemote", async () => {
      try {
        await setupRemote(out);
        repository.refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage("Session Backup 設定遠端失敗：" + err.message);
      }
    }),
    vscode.commands.registerCommand("sessionBackup.publishGithub", async () => {
      try {
        const cfg = getConfig();
        const git = new Git(cfg.repoPath, out);
        let remote = await git.getRemote();
        if (!remote) {
          await setupRemote(out);
          remote = await git.getRemote();
          repository.refresh();
        }
        if (!remote) {
          return;
        }
        await backupNow(context, out, "manual", projects, repository, tree);
      } catch (err: any) {
        vscode.window.showErrorMessage("Session Backup 發布至 GitHub 失敗：" + err.message);
      }
    }),
    vscode.commands.registerCommand("sessionBackup.refreshRepository", () =>
      repository.refresh()
    ),
    vscode.commands.registerCommand("sessionBackup.openRepo", () => {
      vscode.env.openExternal(vscode.Uri.file(getConfig().repoPath));
    }),
    vscode.commands.registerCommand("sessionBackup.showLog", () => out.show()),
    vscode.authentication.onDidChangeSessions((event) => {
      if (event.provider.id === "github") {
        repository.refresh();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("sessionBackup.selectedSessions")) {
        tree.reloadSelection();
      }
      if (e.affectsConfiguration("sessionBackup")) {
        restartTimer(context, out, projects, repository, tree, conflicts);
        repository.reconfigure();
      }
    })
  );

  // ---- Session 瀏覽器 ----
  const previewProvider: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
      const q = new URLSearchParams(uri.query);
      const file = q.get("file") ?? "";
      const tool = (q.get("tool") ?? "claude") as Tool;
      return renderSessionMarkdown(tool, file);
    },
  };
  // Sessions 用 createTreeView 才收得到 checkbox 事件；勾選狀態由選取規則決定，
  // 不讓 VS Code 自動連動父子項目（範圍規則有自己的優先序）。
  const sessionsView = vscode.window.createTreeView("sessionBackup.sessions", {
    treeDataProvider: tree,
    showCollapseAll: true,
    manageCheckboxStateManually: true,
  });
  context.subscriptions.push(
    sessionsView,
    sessionsView.onDidChangeCheckboxState((e) => {
      void tree.handleCheckboxChange(e.items).then(() => repository.refresh(false));
    }),
    vscode.window.registerTreeDataProvider("sessionBackup.repository", repository),
    vscode.workspace.registerTextDocumentContentProvider(
      PREVIEW_SCHEME,
      previewProvider
    ),
    vscode.commands.registerCommand("sessionBackup.refreshSessions", () =>
      tree.refresh()
    ),
    vscode.commands.registerCommand(
      "sessionBackup.previewSession",
      async (node?: TreeNode) => {
        if (node?.kind !== "session") {
          return;
        }
        const s = node.info;
        const name = s.title.replace(/[\\/:*?"<>|#]/g, " ").slice(0, 40).trim();
        const uri = vscode.Uri.parse(
          `${PREVIEW_SCHEME}:/${encodeURIComponent(name || s.id)}.md?` +
            new URLSearchParams({ file: s.file, tool: s.tool }).toString()
        );
        await vscode.workspace.openTextDocument(uri);
        try {
          await vscode.commands.executeCommand("markdown.showPreview", uri);
        } catch {
          await vscode.window.showTextDocument(uri, { preview: true });
        }
      }
    ),
    vscode.commands.registerCommand(
      "sessionBackup.exportSession",
      async (node?: TreeNode) => {
        if (node?.kind !== "session") {
          return;
        }
        const s = node.info;
        const safe =
          s.title.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim() || s.id;
        const target = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(
            path.join(os.homedir(), `${s.date} ${safe.slice(0, 50)}.md`)
          ),
          filters: { Markdown: ["md"] },
        });
        if (!target) {
          return;
        }
        const md = await renderSessionMarkdown(s.tool, s.file);
        await fs.promises.writeFile(target.fsPath, md, "utf8");
        vscode.window.showInformationMessage(
          `Session Backup: 已匯出 ${path.basename(target.fsPath)}`
        );
      }
    ),
    vscode.commands.registerCommand(
      "sessionBackup.openSessionFile",
      async (node?: TreeNode) => {
        if (node?.kind !== "session") {
          return;
        }
        await vscode.window.showTextDocument(vscode.Uri.file(node.info.file));
      }
    )
  );

  restartTimer(context, out, projects, repository, tree, conflicts);
  if (getConfig().backupOnStartup) {
    void autoSync(context, out, projects, repository, tree, conflicts);
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
  out: vscode.OutputChannel
): Promise<void> {
  try {
    const cfg = getConfig();
    const machineId = machineIdFromConfig(cfg);
    const store = new MachineIdentityStore(context.globalStorageUri.fsPath);
    const { result, from } = await applyMachineIdentity(
      store,
      cfg.repoPath,
      machineId,
      os.hostname() // 0.2.1 之前留空時的預設值
    );
    if (result === "renamed") {
      out.appendLine(`machineId 已從 ${from} 改為 ${machineId}，備份庫目錄一併搬移`);
    } else if (result === "blocked") {
      out.appendLine(
        `machineId 從 ${from} 改為 ${machineId}，但 machines/${machineId}/ 已存在，` +
          "未搬移舊目錄；請確認兩者是否為同一台電腦"
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
  tree: SessionTreeProvider
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
          ...manifestRelativePath(machineIdFromConfig(cfg)).split("/")
        )
      );
      const keys = initialSelectionKeys(manifest, legacy);
      if (keys.length) {
        await updateSelectedSessions(() => keys);
        tree.reloadSelection();
        out.appendLine(
          `備份改為選擇制：已將 ${keys.length} 個先前備份過的 session 設為選取，` +
            "之後新增的對話請自行勾選"
        );
      }
      void notifySelectionChange(keys.length);
    }
    if (legacy.length) {
      await clearLegacyIgnoredSessions();
      out.appendLine(`已移除 ${legacy.length} 筆舊的 sessionBackup.ignoredSessions 設定`);
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

function nodeLabel(node: TreeNode): string {
  switch (node.kind) {
    case "root":
      return `整個 ${node.label}`;
    case "claudeProject":
      return `專案「${node.project.label}」`;
    case "codexDate":
      return `${node.date} 的對話`;
    case "session":
      return `「${node.info.title}」`;
  }
}

function restartTimer(
  context: vscode.ExtensionContext,
  out: vscode.OutputChannel,
  projects: ProjectMappingRegistry,
  repository: RepositoryTreeProvider,
  tree: SessionTreeProvider,
  conflicts: ConflictRegistry
): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
  const minutes = getConfig().autoBackupMinutes;
  if (minutes > 0) {
    // 自動排程跑「同步」而非單純備份：先拉遠端合併、再備份上傳，多機幾乎即時同步。
    timer = setInterval(
      () => void autoSync(context, out, projects, repository, tree, conflicts),
      minutes * 60 * 1000
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
  conflicts: ConflictRegistry
): Promise<void> {
  try {
    const summary = await runSync(out, projects, conflicts, { interactive: false });
    out.appendLine(
      `[${new Date().toLocaleString()}] 自動同步：新增 ${summary.added}、更新 ${summary.updated}、` +
        `保留本機 ${summary.keptLocal}、衝突 ${summary.conflicts}、延後 ${summary.deferred}`
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
  tree?: SessionTreeProvider
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
        vscode.window.showErrorMessage("Session Backup 備份失敗：" + err.message);
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
      exec
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
