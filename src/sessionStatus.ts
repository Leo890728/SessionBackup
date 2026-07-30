import { SelectionSet } from "./selection";
import { hashFileCached, MachineManifest, ManifestSession } from "./sessionStore";
import { Tool } from "./sessions";

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
    detail: "已選取但尚未備份過，下次備份會寫入",
  },
  unselected: {
    label: "未選取",
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
  selectedSessions: string[] | SelectionSet,
  maxFileSizeMB: number
): StatusLookup {
  const byPath = new Map<string, ManifestSession>();
  for (const session of manifest?.sessions ?? []) {
    byPath.set(`${session.tool}:${session.relativePath}`, session);
  }
  return {
    byPath,
    selection:
      selectedSessions instanceof SelectionSet
        ? selectedSessions
        : new SelectionSet(selectedSessions),
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
 * 但 Claude 讀歷史會把同樣的內容重寫一次、只推進 mtime，那樣會誤標成未同步。
 * 只有在 size 相同而 mtime 不同這個可疑情況下才實際算 hash（hashFileCached 有快取，
 * 同一次改動只會算一次）。
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
  if (!entry || entry.size !== session.size) {
    return status;
  }
  try {
    const hash = await hashFileCached(session.file, {
      mtimeMs: session.mtimeMs,
      size: session.size,
    });
    return hash === entry.hash ? "synced" : "modified";
  } catch {
    return status;
  }
}
