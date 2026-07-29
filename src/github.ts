import * as vscode from "vscode";
import { getConfig } from "./config";
import { Git } from "./git";
import { BackupRepository, selectAutomaticBackupRepo } from "./githubState";
import { STORE_FORMAT_VERSION } from "./sessionStore";

const BACKUP_REPOSITORY_DESCRIPTION =
  "AI session backup (managed by VSCode Session Backup extension)";

export async function getSessionToken(
  createIfNone: boolean
): Promise<string | undefined> {
  try {
    const s = await vscode.authentication.getSession(
      "github",
      ["repo"],
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

export async function ensurePrivateRepo(
  token: string,
  name: string
): Promise<{ login: string; url: string }> {
  const user = await api(token, "GET", "/user");
  if (user.status !== 200) {
    throw new Error(`無法取得 GitHub 使用者資訊 (HTTP ${user.status})`);
  }
  const login: string = user.json.login;
  const existing = await api(token, "GET", `/repos/${login}/${name}`);
  if (existing.status === 200) {
    if (!existing.json.private) {
      throw new Error(`儲存庫 ${login}/${name} 已存在但不是私人的，拒絕使用。`);
    }
    return { login, url: existing.json.clone_url };
  }
  if (existing.status !== 404) {
    throw new Error(`無法檢查儲存庫 ${login}/${name} (HTTP ${existing.status})`);
  }
  const created = await api(token, "POST", "/user/repos", {
    name,
    private: true,
    description: BACKUP_REPOSITORY_DESCRIPTION,
  });
  if (created.status === 201) {
    return { login, url: created.json.clone_url };
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
    "/user/repos?visibility=private&affiliation=owner&sort=updated&per_page=100"
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

export async function setupRemote(out: vscode.OutputChannel): Promise<void> {
  const cfg = getConfig();
  const git = new Git(cfg.repoPath, out);
  await git.ensureRepo();
  const token = await getSessionToken(true);
  if (!token) {
    vscode.window.showErrorMessage(
      "Session Backup: 需要 GitHub 授權才能建立私人儲存庫。"
    );
    return;
  }
  const repositories = await findBackupRepositories(token, cfg.repoName);
  let selected = selectAutomaticBackupRepo(repositories, cfg.repoName);
  if (!selected && repositories.length > 1) {
    const createLabel = "$(add) 建立新的備份儲存庫";
    const picked = await vscode.window.showQuickPick(
      [
        ...repositories.map((repo) => ({
          label: repo.fullName,
          description: "現有 Session Backup",
          repo,
        })),
        { label: createLabel, description: "建立新的私人儲存庫", repo: undefined },
      ],
      { placeHolder: "選擇要重新連接的 Session Backup 儲存庫" }
    );
    if (!picked) {
      return;
    }
    selected = picked.repo;
  }
  if (selected) {
    await git.setRemote(selected.url);
    vscode.window.showInformationMessage(
      `Session Backup: 已找到並重新連接 ${selected.fullName}。`
    );
    return;
  }
  // 這個輸入框同時是「連結」與「建立」的入口（ensurePrivateRepo 先查再建），
  // 沒有提示的話看起來只像建立新 repo，要講清楚兩種結果。
  const name = await vscode.window.showInputBox({
    title: "連接 GitHub 備份儲存庫",
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
  const repo = await ensurePrivateRepo(token, repoName);
  await git.setRemote(repo.url);
  vscode.window.showInformationMessage(
    `Session Backup: 已設定遠端 ${repo.login}/${repoName}（私人）。之後備份會自動 push。`
  );
}
