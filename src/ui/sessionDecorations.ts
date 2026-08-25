/**
 * Sessions 側欄的狀態標記，比照 VS Code 檔案總管的 git 裝飾：
 * 右側一個字母 + 顏色，乾淨的項目什麼都不顯示。
 *
 * 走 FileDecorationProvider 而不是自己畫 icon，是因為只有這條路徑能在列尾放字母，
 * 而且顏色直接沿用主題的 gitDecoration.*，跟編輯器其他地方一致。
 *
 * 狀態編在 URI 裡（scheme:/<status>/<檔案路徑>）：狀態變了就是另一個 URI，
 * VS Code 會自然重新查一次裝飾，不必自己維護失效通知。
 */

import * as vscode from "vscode";
import { SessionSyncStatus } from "../store/sessionStatus";

const SCHEME = "session-backup";

/** U 沿用 git 的 untracked：這個對話備份庫裡還沒有。M 則同 modified。 */
const DECORATIONS: Partial<
  Record<SessionSyncStatus, { badge?: string; color: string; tooltip: string }>
> = {
  unbacked: {
    badge: "U",
    color: "gitDecoration.untrackedResourceForeground",
    tooltip: "待備份：備份庫裡還沒有這個對話",
  },
  modified: {
    badge: "M",
    color: "gitDecoration.modifiedResourceForeground",
    tooltip: "未同步：備份後有新內容",
  },
  "too-large": {
    badge: "!",
    color: "gitDecoration.conflictingResourceForeground",
    tooltip: "超過大小上限，備份時會略過",
  },
  // 未追蹤只變暗、不給字母，和 VS Code 對 gitignore 掉的檔案一樣：
  // 它不是一種「變更」，只是不在管轄範圍內。
  unselected: {
    color: "gitDecoration.ignoredResourceForeground",
    tooltip: "未追蹤：備份、變更偵測與同步都會跳過",
  },
  // synced 刻意沒有標記：乾淨的項目不出聲。
};

export function sessionStatusUri(
  status: SessionSyncStatus,
  file: string
): vscode.Uri {
  return vscode.Uri.from({
    scheme: SCHEME,
    path: `/${status}/${file.replace(/\\/g, "/")}`,
  });
}

export class SessionDecorationProvider
  implements vscode.FileDecorationProvider, vscode.Disposable
{
  private readonly disposable: vscode.Disposable;

  constructor() {
    this.disposable = vscode.window.registerFileDecorationProvider(this);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== SCHEME) {
      return undefined;
    }
    const status = uri.path.split("/")[1] as SessionSyncStatus;
    const decoration = DECORATIONS[status];
    return decoration
      ? {
          badge: decoration.badge,
          color: new vscode.ThemeColor(decoration.color),
          tooltip: decoration.tooltip,
        }
      : undefined;
  }

  dispose(): void {
    this.disposable.dispose();
  }
}
