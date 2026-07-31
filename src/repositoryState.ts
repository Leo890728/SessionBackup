import type { LocalSession, MachineManifest } from "./sessionStore";
import { STORE_FORMAT_VERSION } from "./sessionStore";

export type RepositoryChangeState = "backup" | "sync" | "merge" | "synced";

export function remoteLabel(remote: string): string {
  const normalized = remote
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/^https?:\/\/(?:[^@/]+@)?/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/") : normalized;
}

/**
 * 檢查備份狀態失敗的原因。分類的意義在於「重試」只對其中一種有用：
 * 遠端被刪或 URL 打錯時再按幾次都一樣，要的是重新連接。
 */
export type RemoteErrorKind = "not-found" | "auth" | "network" | "unknown";

export function classifyRemoteError(message: string): RemoteErrorKind {
  const text = message.toLowerCase();
  // 授權要排在最前面：私人儲存庫在權限不足時，GitHub 也會回 "Repository not found"，
  // 但只要訊息裡出現明確的授權字樣，那就是授權問題而不是儲存庫不見了。
  if (
    /authentication failed|could not read username|could not read password|invalid username or password|permission denied \(publickey\)|terminal prompts disabled|support for password authentication was removed|saml|single sign-on|sso|403 forbidden/.test(
      text
    )
  ) {
    return "auth";
  }
  if (
    /repository not found|not found|does not appear to be a git repository|404/.test(text)
  ) {
    return "not-found";
  }
  if (
    /could not resolve host|failed to connect|connection timed out|operation timed out|timed out|network is unreachable|temporary failure in name resolution|proxy/.test(
      text
    )
  ) {
    return "network";
  }
  return "unknown";
}

export function classifyRepositoryChanges(
  localChanged: boolean,
  remoteChanged: boolean
): RepositoryChangeState {
  if (localChanged && remoteChanged) {
    return "merge";
  }
  if (localChanged) {
    return "backup";
  }
  if (remoteChanged) {
    return "sync";
  }
  return "synced";
}

export type SessionChangeKind = "added" | "modified";

export interface ChangedSession {
  session: LocalSession;
  change: SessionChangeKind;
}

// Codex 接續 session 會產生多個 rollout 檔共用同一個 session id，
// 因此必須以「檔案」為比對單位（key 含 relativePath），否則重複 id 在
// Map 中互相覆蓋，同 thread 的其他檔案永遠比對失敗。
const keyOf = (s: { tool: string; id: string; relativePath: string }) =>
  `${s.tool}:${s.id}:${s.relativePath}`;

/**
 * hash 是內容的權威身分：相同就代表這次備份不會寫出新的 revision。
 *
 * 刻意不比 mtime 與 size。Claude Code 載入舊對話時會把檔案原封不動重寫一次、
 * 只推進 mtime，比 mtime 會讓「只是打開來看」的對話全部列進「有變動的 sessions」；
 * size 則是內容的函數，hash 已經涵蓋。
 *
 * title/titleUpdatedAt/project 是 manifest 自己的中繼資料，不在檔案 hash 裡，仍要比。
 */
function entryDiffers(
  previous: { hash: string; title?: string; titleUpdatedAt?: string; project?: unknown },
  session: LocalSession
): boolean {
  return (
    previous.hash !== session.hash ||
    previous.title !== session.title ||
    previous.titleUpdatedAt !== session.titleUpdatedAt ||
    JSON.stringify(previous.project) !== JSON.stringify(session.project)
  );
}

/** 變動清單的一個節點；children 是掛在它底下的 Codex 子代理檔。 */
export interface ChangedNode {
  entry: ChangedSession;
  children: ChangedNode[];
}

/** 同一個 thread 的所有變動檔案（主 thread + 子代理 + 接續的 rollout）。 */
export interface ChangedGroup {
  tool: string;
  id: string;
  /** 這個 thread 底下的變動檔案總數 */
  total: number;
  /** 通常只有一個 root；接續的 rollout 檔或找不到父節點的孤兒會並列 */
  roots: ChangedNode[];
}

/**
 * 把變動清單依 thread 收合成樹。
 *
 * Codex 的子代理檔與主 thread 共用同一個 session_id，攤平列出會讓一次
 * 「3 個子代理」的對話變成 8 列看起來一樣的項目。改以 ownId/parentThreadId
 * 還原親子關係，同一個 thread 只佔一列。
 */
export function groupChangedSessions(changed: ChangedSession[]): ChangedGroup[] {
  const groups = new Map<string, ChangedSession[]>();
  for (const entry of changed) {
    const key = `${entry.session.tool}:${entry.session.id}`;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(entry);
    } else {
      groups.set(key, [entry]);
    }
  }
  return [...groups.values()].map((entries) => {
    const nodes = entries.map((entry) => ({ entry, children: [] as ChangedNode[] }));
    const byOwnId = new Map<string, ChangedNode>();
    for (const node of nodes) {
      const ownId = node.entry.session.ownId;
      // 同一個 ownId 只認第一個，避免形狀異常的資料互相指來指去。
      if (ownId && !byOwnId.has(ownId)) {
        byOwnId.set(ownId, node);
      }
    }
    const roots: ChangedNode[] = [];
    const parentOf = new Map<ChangedNode, ChangedNode>();
    /** parent 掛到 node 底下會不會繞回自己（資料異常時的環）。 */
    const wouldCycle = (node: ChangedNode, parent: ChangedNode): boolean => {
      for (let up: ChangedNode | undefined = parent; up; up = parentOf.get(up)) {
        if (up === node) {
          return true;
        }
      }
      return false;
    };
    for (const node of nodes) {
      const parentId = node.entry.session.parentThreadId;
      const parent = parentId ? byOwnId.get(parentId) : undefined;
      // 找不到父檔的孤兒與會成環的節點都升成 root，才不會整串從清單消失。
      if (parent && parent !== node && !wouldCycle(node, parent)) {
        parent.children.push(node);
        parentOf.set(node, parent);
      } else {
        roots.push(node);
      }
    }
    return {
      tool: entries[0].session.tool,
      id: entries[0].session.id,
      total: entries.length,
      roots,
    };
  });
}

/** 下次備份會寫入的 sessions（新增或已變更），供 GitHub Backup 檢視顯示。 */
export function listChangedSessions(
  sessions: LocalSession[],
  manifest: MachineManifest | undefined
): ChangedSession[] {
  if (!manifest || manifest.formatVersion !== STORE_FORMAT_VERSION) {
    return sessions.map((session) => ({ session, change: "added" as const }));
  }
  const stored = new Map(
    manifest.sessions.map((session) => [keyOf(session), session])
  );
  const out: ChangedSession[] = [];
  for (const session of sessions) {
    const previous = stored.get(keyOf(session));
    if (!previous) {
      out.push({ session, change: "added" });
    } else if (entryDiffers(previous, session)) {
      out.push({ session, change: "modified" });
    }
  }
  return out;
}

export function localSessionsChanged(
  sessions: LocalSession[],
  manifest: MachineManifest | undefined
): boolean {
  if (
    !manifest ||
    manifest.formatVersion !== STORE_FORMAT_VERSION ||
    manifest.sessions.length !== sessions.length
  ) {
    return sessions.length > 0 || Boolean(manifest?.sessions.length);
  }
  return listChangedSessions(sessions, manifest).length > 0;
}
