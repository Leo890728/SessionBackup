import * as vscode from "vscode";
import { getConfig } from "./config";
import { Git } from "./git";
import {
  BackupRepository,
  normalizeRemoteInput,
  selectAutomaticBackupRepo,
} from "./githubState";
import { remoteLabel } from "./repositoryState";
import { STORE_FORMAT_VERSION } from "./sessionStore";

/** 兩個 remote URL 是否指向同一個儲存庫（忽略協定、.git、大小寫）。 */
function sameRemote(a: string, b: string): boolean {
  return remoteLabel(a).toLowerCase() === remoteLabel(b).toLowerCase();
}

const BACKUP_REPOSITORY_DESCRIPTION =
  "AI session backup (managed by VSCode Session Backup extension)";

export async function getSessionToken(
  createIfNone: boolean,
  scopes: readonly string[] = ["repo"]
): Promise<string | undefined> {
  try {
    const s = await vscode.authentication.getSession(
      "github",
      [...scopes],
      createIfNone ? { createIfNone: true } : { silent: true }
    );
    return s?.accessToken;
  } catch {
    return undefined;
  }
}

/** git over HTTPS 用的認證 header（token 不會寫進 .git/config）。 */
export function tokenHeader(token: string): string {
  return (
    "AUTHORIZATION: basic " +
    Buffer.from("x-access-token:" + token, "utf8").toString("base64")
  );
}

async function api(
  token: string,
  method: string,
  url: string,
  body?: unknown
): Promise<{ status: number; json: any }> {
  const res: any = await (globalThis as any).fetch("https://api.github.com" + url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "vscode-session-backup",
      Accept: "application/vnd.github+json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: any;
  try {
    json = await res.json();
  } catch {
    /* 無 body */
  }
  return { status: res.status, json };
}

/** 可以放備份庫的位置：自己的帳號，或使用者所屬的組織。 */
export interface RepoOwner {
  login: string;
  kind: "user" | "org";
}

export async function listRepoOwners(token: string): Promise<RepoOwner[]> {
  const user = await api(token, "GET", "/user");
  if (user.status !== 200) {
    throw new Error(`無法取得 GitHub 使用者資訊 (HTTP ${user.status})`);
  }
  const owners: RepoOwner[] = [{ login: user.json.login, kind: "user" }];
  const orgs = await api(token, "GET", "/user/orgs?per_page=100");
  if (orgs.status === 200 && Array.isArray(orgs.json)) {
    for (const org of orgs.json) {
      if (typeof org?.login === "string") {
        owners.push({ login: org.login, kind: "org" });
      }
    }
  }
  // 組織列表拿不到（token 未對該組織授權 SSO 等）不算失敗：至少還能用自己的帳號。
  return owners;
}

export async function ensurePrivateRepo(
  token: string,
  owner: RepoOwner,
  name: string
): Promise<{ fullName: string; url: string }> {
  const fullName = `${owner.login}/${name}`;
  const existing = await api(token, "GET", `/repos/${fullName}`);
  if (existing.status === 200) {
    if (!existing.json.private) {
      throw new Error(`儲存庫 ${fullName} 已存在但不是私人的，拒絕使用。`);
    }
    return { fullName, url: existing.json.clone_url };
  }
  if (existing.status !== 404) {
    throw new Error(`無法檢查儲存庫 ${fullName} (HTTP ${existing.status})`);
  }
  const created = await api(
    token,
    "POST",
    owner.kind === "org" ? `/orgs/${owner.login}/repos` : "/user/repos",
    { name, private: true, description: BACKUP_REPOSITORY_DESCRIPTION }
  );
  if (created.status === 201) {
    return { fullName, url: created.json.clone_url };
  }
  throw new Error(
    `建立儲存庫失敗 (HTTP ${created.status})：` +
      JSON.stringify(created.json?.errors ?? created.json?.message ?? created.json)
  );
}

export async function findBackupRepositories(
  token: string,
  preferredName: string
): Promise<BackupRepository[]> {
  const response = await api(
    token,
    "GET",
    "/user/repos?visibility=private&affiliation=owner,organization_member" +
      "&sort=updated&per_page=100"
  );
  if (response.status !== 200 || !Array.isArray(response.json)) {
    throw new Error(`無法列出 GitHub 私人儲存庫 (HTTP ${response.status})`);
  }
  const likely = response.json.filter(
    (repo: any) =>
      repo?.private === true &&
      typeof repo?.name === "string" &&
      typeof repo?.full_name === "string" &&
      typeof repo?.clone_url === "string" &&
      (repo.description === BACKUP_REPOSITORY_DESCRIPTION || repo.name === preferredName)
  );
  const found: BackupRepository[] = [];
  for (const repo of likely) {
    const format = await api(token, "GET", `/repos/${repo.full_name}/contents/format.json`);
    if (format.status === 200 && format.json?.encoding === "base64") {
      try {
        const value = JSON.parse(Buffer.from(format.json.content, "base64").toString("utf8"));
        if (value?.format !== "ai-session-store" || value?.version !== STORE_FORMAT_VERSION) {
          continue;
        }
      } catch {
        continue;
      }
    } else if (
      format.status !== 404 ||
      repo.description !== BACKUP_REPOSITORY_DESCRIPTION
    ) {
      continue;
    }
    found.push({ name: repo.name, fullName: repo.full_name, url: repo.clone_url });
  }
  return found;
}

/**
 * 永久刪除 GitHub 上的儲存庫。需要 delete_repo scope，
 * 呼叫端要自己先取得帶該 scope 的 token（一般備份用的 repo scope 不夠）。
 */
export async function deleteRepository(token: string, fullName: string): Promise<void> {
  const res = await api(token, "DELETE", `/repos/${fullName}`);
  if (res.status === 204) {
    return;
  }
  if (res.status === 403) {
    throw new Error(
      `GitHub 拒絕刪除 ${fullName} (HTTP 403)：授權缺少 delete_repo 權限，` +
        "或這個帳號不是儲存庫的管理者。"
    );
  }
  if (res.status === 404) {
    throw new Error(
      `找不到儲存庫 ${fullName} (HTTP 404)：可能已被刪除，或目前的 GitHub 帳號看不到它。`
    );
  }
  throw new Error(
    `刪除儲存庫失敗 (HTTP ${res.status})：` +
      JSON.stringify(res.json?.message ?? res.json ?? "")
  );
}

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

/**
 * 接上一個「不是原本那個」的備份庫時，本機歷史會與它完全不相干
 * （典型情況是遠端被刪掉後重建）。這時同步一定會在 manifest 上撞 add/add 衝突，
 * 所以當場就問清楚，而不是等使用者下次按同步才炸。
 *
 * 以遠端為準重建是安全的：對話原檔在 ~/.claude、~/.codex，備份庫只是鏡像，
 * 本機獨有的內容會在下一次備份重新上傳（store 以內容雜湊定址，不會產生重複）。
 */
async function reconcileHistory(git: Git, out: vscode.OutputChannel): Promise<void> {
  const fetch = await git.fetchOrigin();
  if (fetch.code !== 0) {
    return; // 連線問題交給側欄的狀態檢查回報，這裡不重複打擾
  }
  const branch = await git.resolveRemoteBranch(await git.currentBranch());
  if (!branch || (await git.hasCommonHistory(`origin/${branch}`))) {
    return;
  }
  const rebuild = "以遠端為準重建";
  const pick = await vscode.window.showWarningMessage(
    "本機備份庫與這個儲存庫的歷史不相干。",
    {
      modal: true,
      detail:
        "本機備份庫是從另一個（或被重建前的）儲存庫來的，直接同步會在 manifest 上發生衝突。\n\n" +
        "建議以遠端為準重建本機備份庫：本機的對話原檔（~/.claude、~/.codex）不受影響，" +
        "這台電腦獨有的內容會在下一次備份重新上傳。\n\n" +
        "選擇「稍後處理」則維持現狀，但同步會持續失敗。",
    },
    rebuild
  );
  if (pick !== rebuild) {
    return;
  }
  await git.resetToRemote(branch);
  out.appendLine(`已以 origin/${branch} 重建本機備份庫`);
  vscode.window.showInformationMessage(
    "Session Backup: 已以遠端重建本機備份庫，下次備份會重新上傳這台電腦的對話。"
  );
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

/**
 * 手動接任何 git server。GitHub API 只用在探索與建立儲存庫，
 * 備份本身只需要 push，認證交給 git credential manager / SSH。
 */
async function connectManualRemote(git: Git, out: vscode.OutputChannel): Promise<void> {
  let value = (await git.getRemote()) ?? "";
  for (;;) {
    const input = await vscode.window.showInputBox({
      title: "手動設定備份儲存庫的 remote URL",
      prompt: "https://、ssh:// 或 git@host:owner/repo.git；認證沿用 git 既有的憑證設定",
      placeHolder: "https://gitlab.example.com/team/agent-session-backup.git",
      value,
      ignoreFocusOut: true,
      validateInput: (v) =>
        !v.trim() || normalizeRemoteInput(v) ? undefined : "看起來不是有效的 git remote URL",
    });
    const url = input ? normalizeRemoteInput(input) : undefined;
    if (!url) {
      return;
    }
    // 先試連再寫入 .git/config：打錯一個字的 URL 不該留在設定裡，
    // 否則之後每次備份都失敗，而且 repoName 之類的設定再怎麼改都救不回來。
    const test = await git.testRemote(url);
    if (test.code !== 0) {
      const message = (test.stderr || test.stdout).trim();
      out.appendLine(`remote 連線測試失敗：${message}`);
      const retry = "重新輸入";
      const save = "仍要儲存";
      const pick = await vscode.window.showWarningMessage(
        `連線測試失敗，未儲存 ${url}。`,
        {
          modal: true,
          detail:
            `${message}\n\n` +
            "網址可能打錯，或這台電腦還沒有這個 server 的憑證。\n" +
            "「仍要儲存」適用於確定網址正確、只是暫時連不上的情況。",
        },
        retry,
        save
      );
      if (pick === retry) {
        value = url;
        continue;
      }
      if (pick !== save) {
        return;
      }
      await git.setRemote(url);
      vscode.window.showWarningMessage(
        `Session Backup: 已記下遠端 ${url}，但連線測試失敗（詳見記錄）。`
      );
      return;
    }
    await git.setRemote(url);
    vscode.window.showInformationMessage(
      `Session Backup: 已設定遠端 ${url}。之後備份會自動 push。`
    );
    await reconcileHistory(git, out);
    return;
  }
}
