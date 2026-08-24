/** GitHub REST 呼叫。純粹的 provider 操作，不碰 VS Code UI。 */

import { STORE_FORMAT_VERSION } from "../../store/sessionStore";
import type { BackupRepository } from "../githubState";

const BACKUP_REPOSITORY_DESCRIPTION =
  "AI session backup (managed by VSCode Session Backup extension)";

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
