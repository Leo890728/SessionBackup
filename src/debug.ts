import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { getConfig, updateSelectedSessions } from "./config";
import { ConflictRegistry } from "./conflicts";
import { Git } from "./git";
import { deleteRepository, getSessionToken } from "./github";
import { parseGithubRepo } from "./githubState";
import { MachineIdentityStore } from "./machineIdentity";
import { ProjectMappingRegistry } from "./projectMapping";
import { RepositoryTreeProvider } from "./repositoryTree";
import { SessionTreeProvider } from "./sessionTree";

/**
 * 除錯／重置命令。全部具破壞性，所以共同的規矩是：
 * 先講清楚會刪掉什麼、不會刪掉什麼，再以強制回應的對話框確認。
 * 一律不碰 ~/.claude、~/.codex 裡的原始對話檔。
 */
export interface DebugDeps {
  context: vscode.ExtensionContext;
  out: vscode.OutputChannel;
  projects: ProjectMappingRegistry;
  conflicts: ConflictRegistry;
  repository: RepositoryTreeProvider;
  tree: SessionTreeProvider;
  /** 清掉 lastBackup 之後重畫狀態列 */
  refreshStatus: () => void;
}

export function registerDebugCommands(deps: DebugDeps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("sessionBackup.debug.deleteRemoteRepository", () =>
      guard(deps, "刪除遠端備份儲存庫", () => deleteRemoteRepository(deps))
    ),
    vscode.commands.registerCommand("sessionBackup.debug.signOutGithub", () =>
      guard(deps, "登出 GitHub", () => signOutGithub(deps))
    ),
    vscode.commands.registerCommand("sessionBackup.debug.deleteLocalData", () =>
      guard(deps, "刪除本機備份資料", () => deleteLocalData(deps))
    ),
  ];
}

async function guard(
  deps: DebugDeps,
  what: string,
  run: () => Promise<void>
): Promise<void> {
  try {
    await run();
  } catch (err: any) {
    deps.out.appendLine(`${what}失敗：${err?.stack ?? err?.message ?? err}`);
    vscode.window.showErrorMessage(
      `Session Backup ${what}失敗：${err?.message ?? err}`
    );
  }
}

// ---- 刪除遠端備份儲存庫 ----

async function deleteRemoteRepository(deps: DebugDeps): Promise<void> {
  const cfg = getConfig();
  const git = new Git(cfg.repoPath, deps.out);
  const remote = fs.existsSync(path.join(cfg.repoPath, ".git"))
    ? await git.getRemote()
    : undefined;
  if (!remote) {
    vscode.window.showInformationMessage(
      "Session Backup: 目前沒有連接任何遠端備份儲存庫。"
    );
    return;
  }

  const github = parseGithubRepo(remote);
  if (!github) {
    // 非 GitHub 的 remote 沒有共通的刪除 API，能做的只有解除連結。
    const disconnect = "解除連結";
    const pick = await vscode.window.showWarningMessage(
      "這個備份儲存庫不在 GitHub 上，無法由擴充功能刪除。",
      {
        modal: true,
        detail:
          `${remote}\n\n` +
          "可以先解除本機與它的連結（origin），再自行到該服務刪除儲存庫。\n" +
          "解除連結不會刪除任何資料。",
      },
      disconnect
    );
    if (pick !== disconnect) {
      return;
    }
    await git.run(["remote", "remove", "origin"], true);
    deps.out.appendLine(`已解除遠端連結：${remote}`);
    deps.repository.refresh();
    vscode.window.showInformationMessage("Session Backup: 已解除遠端連結。");
    return;
  }

  // 這是不可逆且會影響其他電腦的操作，只按一次按鈕太輕率，要求打出完整名稱。
  const typed = await vscode.window.showInputBox({
    title: `永久刪除 GitHub 儲存庫 ${github.fullName}`,
    prompt:
      "這會刪除雲端上所有電腦的備份歷史，且無法復原（本機的對話檔與備份庫不受影響）。" +
      "請輸入完整名稱以確認",
    placeHolder: github.fullName,
    ignoreFocusOut: true,
    validateInput: (v) =>
      v.trim() === github.fullName ? undefined : `請輸入 ${github.fullName}`,
  });
  if (typed?.trim() !== github.fullName) {
    return;
  }

  // 一般備份用的 repo scope 不含刪除權限，這裡要另外要一次授權。
  const token = await getSessionToken(true, ["repo", "delete_repo"]);
  if (!token) {
    vscode.window.showErrorMessage(
      "Session Backup: 需要 GitHub 授權（delete_repo）才能刪除儲存庫。"
    );
    return;
  }
  await deleteRepository(token, github.fullName);
  await git.run(["remote", "remove", "origin"], true);
  deps.out.appendLine(`已刪除 GitHub 儲存庫 ${github.fullName} 並解除本機 origin`);
  deps.repository.refresh();
  vscode.window.showInformationMessage(
    `Session Backup: 已刪除 ${github.fullName}，並解除本機連結。`
  );
}

// ---- 登出 GitHub ----

async function signOutGithub(deps: DebugDeps): Promise<void> {
  const accounts = await vscode.authentication.getAccounts("github");
  const signOut = "登出";
  const pick = await vscode.window.showWarningMessage(
    "讓 Session Backup 忘記目前使用的 GitHub 帳號？",
    {
      modal: true,
      detail:
        (accounts.length
          ? `目前的帳號：${accounts.map((a) => a.label).join("、")}\n\n`
          : "") +
        "之後備份或同步時會重新詢問要用哪個 GitHub 帳號。\n" +
        "本機與遠端的備份內容都不會被刪除。\n\n" +
        "注意：VS Code 本身仍會保留這個帳號的登入狀態（其他擴充功能還是用得到）。" +
        "要完整登出，請用下一步的「管理帳戶存取權」或左下角的「帳戶」圖示。",
    },
    signOut
  );
  if (pick !== signOut) {
    return;
  }
  // VS Code 沒有讓擴充功能登出帳號的 API；能做的是清掉「這個擴充功能用哪個帳號」
  // 的偏好，下次取用時會重新詢問。
  await vscode.authentication.getSession("github", ["repo"], {
    clearSessionPreference: true,
  });
  deps.out.appendLine("已清除 GitHub 帳號偏好設定");
  deps.repository.refresh();

  const manage = "管理帳戶存取權";
  const next = await vscode.window.showInformationMessage(
    "Session Backup: 已清除 GitHub 帳號偏好，下次備份會重新詢問帳號。",
    manage
  );
  if (next !== manage) {
    return;
  }
  try {
    // 未列在 API 文件中的內建命令，開啟「管理受信任的擴充功能」讓使用者撤銷授權。
    await vscode.commands.executeCommand(
      "workbench.actions.manageTrustedExtensionsForAccount",
      { providerId: "github", accountLabel: accounts[0]?.label }
    );
  } catch {
    vscode.window.showInformationMessage(
      "請點選左下角的「帳戶」圖示，選擇 GitHub 帳號後即可管理存取權或登出。"
    );
  }
}

// ---- 刪除本機備份資料 ----

interface LocalTarget extends vscode.QuickPickItem {
  id: "repo" | "state" | "selection";
}

async function deleteLocalData(deps: DebugDeps): Promise<void> {
  const cfg = getConfig();
  const selectionCount = cfg.selectedSessions.length;
  const targets: LocalTarget[] = [
    {
      id: "repo",
      label: "本機備份儲存庫",
      description: cfg.repoPath,
      detail: "所有 revision、manifest 與 git 歷史；遠端儲存庫上的備份不受影響",
      picked: true,
    },
    {
      id: "state",
      label: "擴充功能狀態",
      description: "專案對應、衝突紀錄、machineId、上次備份時間",
      detail: "刪除後專案對應要重新指定，machineId 會重新產生",
      picked: true,
    },
    {
      id: "selection",
      label: "備份選取規則",
      description: `sessionBackup.selectedSessions（${selectionCount} 條）`,
      detail: "刪除後所有對話都不會備份，要重新在 Sessions 側欄勾選",
    },
  ];
  const picked = await vscode.window.showQuickPick(targets, {
    canPickMany: true,
    title: "刪除本機備份資料",
    placeHolder: "選擇要刪除的項目（不會刪除 ~/.claude、~/.codex 裡的原始對話）",
  });
  if (!picked?.length) {
    return;
  }

  const remove = "永久刪除";
  const confirm = await vscode.window.showWarningMessage(
    "永久刪除以下本機資料？",
    {
      modal: true,
      detail:
        picked.map((t) => `• ${t.label}（${t.description}）`).join("\n") +
        "\n\n無法復原。原始對話檔（~/.claude、~/.codex）與遠端備份儲存庫都不會被刪除。",
    },
    remove
  );
  if (confirm !== remove) {
    return;
  }

  const ids = new Set(picked.map((t) => t.id));
  const done: string[] = [];

  if (ids.has("repo")) {
    await fs.promises.rm(cfg.repoPath, { recursive: true, force: true });
    deps.out.appendLine(`已刪除本機備份儲存庫：${cfg.repoPath}`);
    done.push("本機備份儲存庫");
  }
  if (ids.has("state")) {
    const storage = deps.context.globalStorageUri.fsPath;
    for (const file of [
      deps.projects.storagePath,
      deps.conflicts.storagePath,
      new MachineIdentityStore(storage).storagePath,
    ]) {
      await fs.promises.rm(file, { force: true });
    }
    // 檔案沒了，記憶體快取也要丟掉，否則下次寫入會把舊資料寫回去。
    deps.projects.reset();
    deps.conflicts.reset();
    await deps.context.globalState.update("lastBackup", undefined);
    deps.refreshStatus();
    deps.out.appendLine("已刪除擴充功能狀態（專案對應、衝突紀錄、machineId）");
    done.push("擴充功能狀態");
  }
  if (ids.has("selection")) {
    await updateSelectedSessions(() => []);
    deps.out.appendLine("已清除備份選取規則");
    done.push("備份選取規則");
  }

  deps.tree.reloadSelection();
  deps.tree.refresh();
  deps.repository.reconfigure();
  vscode.window.showInformationMessage(
    `Session Backup: 已刪除 ${done.join("、")}。`
  );
}
