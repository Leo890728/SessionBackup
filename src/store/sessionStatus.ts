import { SelectionSet } from "./selection";
import { hashFileCached, MachineManifest, ManifestSession } from "./sessionStore";
import { Tool } from "../agents/types";

export type SessionSyncStatus =
  | "synced"
  | "modified"
  | "unbacked"
  | "unselected"
  | "too-large";

export interface StatusLookup {
  byPath: Map<string, ManifestSession>;
  selection: SelectionSet;
  maxBytes: number;
}

export const STATUS_DISPLAY: Record<
  SessionSyncStatus,
  { label: string; icon: string; color?: string; detail: string }
> = {
  synced: {
    label: "已同步",
    icon: "check",
    color: "testing.iconPassed",
    detail: "此 session 的目前內容已在備份中",
  },
  modified: {
    label: "未同步",
    icon: "cloud-upload",
    color: "charts.yellow",
    detail: "備份後有新內容，下次備份會更新",
  },
  unbacked: {
    label: "待備份",
    icon: "circle-outline",
    color: "charts.yellow",
    detail: "已追蹤但尚未備份過，下次備份會寫入",
  },
  unselected: {
    label: "未追蹤",
    icon: "circle-slash",
    color: "disabledForeground",
    detail: "未勾選備份，備份、變更偵測與同步都會跳過",
  },
  "too-large": {
    label: "跳過（過大）",
    icon: "warning",
    color: "list.warningForeground",
    detail: "超過 sessionBackup.maxFileSizeMB 上限，備份時會略過",
  },
};

export function buildStatusLookup(
  manifest: MachineManifest | undefined,
  trackedSessions: string[] | SelectionSet,
  maxFileSizeMB: number
): StatusLookup {
  const byPath = new Map<string, ManifestSession>();
  for (const session of manifest?.sessions ?? []) {
    byPath.set(`${session.tool}:${session.relativePath}`, session);
  }
  return {
    byPath,
    selection:
      trackedSessions instanceof SelectionSet
        ? trackedSessions
        : new SelectionSet(trackedSessions),
    maxBytes: maxFileSizeMB * 1024 * 1024,
  };
}

export function sessionSyncStatus(
  lookup: StatusLookup,
  session: {
    tool: Tool;
    id: string;
    relativePath: string;
    mtimeMs: number;
    size: number;
    claudeProjectDir?: string;
  }
): SessionSyncStatus {
  if (
    !lookup.selection.includes({
      tool: session.tool,
      id: session.id,
      claudeProjectDir: session.claudeProjectDir,
    })
  ) {
    return "unselected";
  }
  if (session.size > lookup.maxBytes) {
    return "too-large";
  }
  const entry = lookup.byPath.get(`${session.tool}:${session.relativePath}`);
  if (!entry) {
    return "unbacked";
  }
  return entry.mtimeMs === session.mtimeMs && entry.size === session.size
    ? "synced"
    : "modified";
}

/**
 * 樹狀圖用：sessionSyncStatus 只比 mtime+size（stat 便宜、不用讀檔），
 * 但 Claude 開啟舊對話時會重寫檔案——有時只推進 mtime，有時還會補寫幾行連線紀錄
 * （見 sessionStore 的 CLAUDE_PLUMBING_TYPES），兩種都會被誤標成未同步。
 * 所以 mtime/size 一對不上就實際算一次雜湊，以濾掉連線紀錄的 contentHash 為準
 * （hashFileCached 有快取，同一次改動只會算一次）。
 */
export async function resolveSessionStatus(
  lookup: StatusLookup,
  session: {
    tool: Tool;
    id: string;
    file: string;
    relativePath: string;
    mtimeMs: number;
    size: number;
    claudeProjectDir?: string;
  }
): Promise<SessionSyncStatus> {
  const status = sessionSyncStatus(lookup, session);
  if (status !== "modified") {
    return status;
  }
  const entry = lookup.byPath.get(`${session.tool}:${session.relativePath}`);
  if (!entry) {
    return status;
  }
  try {
    const { hash, contentHash } = await hashFileCached(session.file, {
      mtimeMs: session.mtimeMs,
      size: session.size,
    });
    // 舊 manifest 沒有 contentHash，退回比原始位元組（就是這次改動之前的行為）。
    const unchanged = entry.contentHash
      ? entry.contentHash === contentHash
      : hash === entry.hash;
    return unchanged ? "synced" : "modified";
  } catch {
    return status;
  }
}
