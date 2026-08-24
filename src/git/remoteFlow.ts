/** 與 provider 無關的 remote 流程：手動輸入 URL、歷史不相干時的重建。 */

import * as vscode from "vscode";

import { Git } from "./git";
import { normalizeRemoteInput } from "./githubState";
import { remoteLabel } from "./repositoryState";

/** 兩個 remote URL 是否指向同一個儲存庫（忽略協定、.git、大小寫）。 */
export function sameRemote(a: string, b: string): boolean {
  return remoteLabel(a).toLowerCase() === remoteLabel(b).toLowerCase();
}

/**
 * 接上一個「不是原本那個」的備份庫時，本機歷史會與它完全不相干
 * （典型情況是遠端被刪掉後重建）。這時同步一定會在 manifest 上撞 add/add 衝突，
 * 所以當場就問清楚，而不是等使用者下次按同步才炸。
 *
 * 以遠端為準重建是安全的：對話原檔在 ~/.claude、~/.codex，備份庫只是鏡像，
 * 本機獨有的內容會在下一次備份重新上傳（store 以內容雜湊定址，不會產生重複）。
 */
export async function reconcileHistory(git: Git, out: vscode.OutputChannel): Promise<void> {
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

/**
 * 手動接任何 git server。GitHub API 只用在探索與建立儲存庫，
 * 備份本身只需要 push，認證交給 git credential manager / SSH。
 */
export async function connectManualRemote(git: Git, out: vscode.OutputChannel): Promise<void> {
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
