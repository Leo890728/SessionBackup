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

function entryDiffers(
  previous: { hash: string; mtimeMs: number; size: number; title?: string; titleUpdatedAt?: string; project?: unknown },
  session: LocalSession
): boolean {
  return (
    previous.hash !== session.hash ||
    previous.mtimeMs !== session.mtimeMs ||
    previous.size !== session.size ||
    previous.title !== session.title ||
    previous.titleUpdatedAt !== session.titleUpdatedAt ||
    JSON.stringify(previous.project) !== JSON.stringify(session.project)
  );
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
