/** 連接備份儲存庫的 UI 流程（GitHub 探索／建立，或轉手動輸入）。 */

import * as vscode from "vscode";

import { getConfig } from "../config";
import { Git } from "./git";
import {
  RepoOwner,
  ensurePrivateRepo,
  findBackupRepositories,
  listRepoOwners,
} from "./github/api";
import { getSessionToken } from "./github/auth";
import { selectAutomaticBackupRepo } from "./githubState";
import { connectManualRemote, reconcileHistory, sameRemote } from "./remoteFlow";
import { remoteLabel } from "./repositoryState";

export interface SetupRemoteOptions {
  /**
   * 一律讓使用者自己選，不自動沿用猜到的儲存庫。
   * 從「已連接」狀態主動要求重新連接時用，因為此時的意圖多半是換一個儲存庫，
   * 自動挑選只會挑回原本那個。
   */
  forcePick?: boolean;
}

export async function setupRemote(
  out: vscode.OutputChannel,
  options: SetupRemoteOptions = {}
): Promise<void> {
  const cfg = getConfig();
  const git = new Git(cfg.repoPath, out);
  await git.ensureRepo();
  const current = await git.getRemote();
  const token = await getSessionToken(true);
  if (!token) {
    // 沒有 GitHub 授權不代表不能備份：自架或其他 git server 只需要一個 remote。
    await connectManualRemote(git, out);
    return;
  }
  const repositories = await findBackupRepositories(token, cfg.repoName);
  let selected = options.forcePick
    ? undefined
    : selectAutomaticBackupRepo(repositories, cfg.repoName);
  if (!selected) {
    const create = { label: "$(add) 建立或連結 GitHub 儲存庫", detail: "可選擇個人帳號或所屬組織" };
    const manual = {
      label: "$(link) 手動輸入 remote URL",
      detail: "GitLab、Gitea、自架 GitHub Enterprise，或別人分享的組織儲存庫",
    };
    const picked = await vscode.window.showQuickPick(
      [
        ...repositories.map((repo) => ({
          label: repo.fullName,
          description:
            current && sameRemote(current, repo.url) ? "目前連接中" : "現有 Session Backup",
          repo,
        })),
        create,
        manual,
      ],
      {
        placeHolder: current
          ? `目前連接 ${remoteLabel(current)}，選擇要改連到哪個備份儲存庫`
          : "選擇要連接的備份儲存庫",
      }
    );
    if (!picked) {
      return;
    }
    if (picked === manual) {
      await connectManualRemote(git, out);
      return;
    }
    selected = "repo" in picked ? picked.repo : undefined;
  }
  if (selected) {
    await git.setRemote(selected.url);
    vscode.window.showInformationMessage(
      `Session Backup: 已連接 ${selected.fullName}。`
    );
    await reconcileHistory(git, out);
    return;
  }
  const owner = await pickRepoOwner(token);
  if (!owner) {
    return;
  }
  // 這個輸入框同時是「連結」與「建立」的入口（ensurePrivateRepo 先查再建），
  // 沒有提示的話看起來只像建立新 repo，要講清楚兩種結果。
  const name = await vscode.window.showInputBox({
    title: `連接 ${owner.login} 底下的備份儲存庫`,
    prompt:
      "同名的私人儲存庫已存在時直接連結，不存在才建立新的（公開儲存庫會被拒絕）",
    placeHolder: cfg.repoName,
    value: cfg.repoName,
    ignoreFocusOut: true,
    validateInput: (v) => {
      const name = v.trim();
      if (!name) {
        return "請輸入儲存庫名稱";
      }
      return /^[A-Za-z0-9._-]+$/.test(name)
        ? undefined
        : "名稱只能含英數字、.、_、-";
    },
  });
  const repoName = name?.trim();
  if (!repoName) {
    return;
  }
  const repo = await ensurePrivateRepo(token, owner, repoName);
  await git.setRemote(repo.url);
  vscode.window.showInformationMessage(
    `Session Backup: 已設定遠端 ${repo.fullName}（私人）。之後備份會自動 push。`
  );
  await reconcileHistory(git, out);
}

/** 只有一個可用位置（沒有組織）時不打擾使用者。 */
async function pickRepoOwner(token: string): Promise<RepoOwner | undefined> {
  const owners = await listRepoOwners(token);
  if (owners.length <= 1) {
    return owners[0];
  }
  const picked = await vscode.window.showQuickPick(
    owners.map((owner) => ({
      label: owner.login,
      description: owner.kind === "org" ? "組織" : "個人帳號",
      owner,
    })),
    { placeHolder: "備份儲存庫要建立在哪裡？" }
  );
  return picked?.owner;
}
