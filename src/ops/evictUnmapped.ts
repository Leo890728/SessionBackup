/**
 * 把「專案還沒對應」的 Codex 對話搬出 ~/.codex/sessions。
 *
 * 這道關卡加到同步之前，未對應的 Codex 檔是照樣匯入的（見 runSync），所以本機
 * 現在還躺著一批工作目錄指著別台電腦的對話——Codex CLI 自己會用那個路徑把它們
 * 列出來，側欄也只能把它們歸到「未對應」那一層。內容本來就在備份庫的 store 裡，
 * 檔案留在本機沒有意義：搬走之後它們變回「待匯入」，對應完同步會帶回來，
 * 那時 cwd 才是對的。
 *
 * 只刪確定救得回來的：這一份 hash 必須已經在 store 裡。掃到還沒備份的內容
 * （或剛被寫過的檔案）就留著，下一輪備份完再處理。
 */

import * as fs from "fs";
import * as path from "path";
import { removeCodexSessionTitles } from "../agents/codexIndex";
import type { LocalSession, ProjectRef } from "../store/sessionStore";
import { ACTIVE_WINDOW_MS } from "../store/sessionStore";

export interface EvictionScope {
  /** 這一輪收集到的本機對話（只含使用者選取的那些）。 */
  localSessions: readonly LocalSession[];
  /** 其他電腦的 manifest 說這則對話屬於哪個專案，key 是 `${tool}:${id}`。 */
  remoteBySession: ReadonlyMap<string, ProjectRef>;
  /** 本機解不出位置的專案 id。必須與同步跳過的判斷同一套（isMapped）。 */
  unmappedProjectIds: ReadonlySet<string>;
  /** 這一份內容已經在備份庫的 store 裡。 */
  isStored: (session: LocalSession) => boolean;
  now: number;
}

/**
 * 這批本機檔案卡在哪些專案底下。
 *
 * 給呼叫端先問出「該不該問 isMapped」用：isMapped 對還沒記住的專案會做 git 偵測，
 * 拿其他電腦備份過的所有專案去問，等於每次同步都多開一堆子程序。真的有檔案
 * 卡著的專案通常是零個。
 */
export function candidateProjects(
  localSessions: readonly LocalSession[],
  remoteBySession: ReadonlyMap<string, ProjectRef>
): Map<string, ProjectRef> {
  const candidates = new Map<string, ProjectRef>();
  for (const session of localSessions) {
    if (session.tool !== "codex" || session.project) {
      continue;
    }
    const remote = remoteBySession.get(`${session.tool}:${session.id}`);
    if (remote) {
      candidates.set(remote.id, remote);
    }
  }
  return candidates;
}

/**
 * 哪些本機 Codex 檔已經不該留在 ~/.codex/sessions。
 *
 * 四個條件缺一不可：
 * - 本機解不出這個檔案的專案身分（identifyByCwd 對不存在的路徑回 undefined）
 * - 其他電腦的 manifest 認得它屬於哪個專案——這也是「它是同步回來的」的證據，
 *   純本機產生的對話不會出現在別台的 manifest 裡
 * - 那個專案本機還沒對應，也就是同步現在會跳過它
 * - 這一份內容已經在 store 裡，刪掉救得回來
 */
export function pickEvictable(scope: EvictionScope): LocalSession[] {
  return scope.localSessions.filter((session) => {
    if (session.tool !== "codex" || session.project) {
      return false;
    }
    const remote = scope.remoteBySession.get(`${session.tool}:${session.id}`);
    if (!remote || !scope.unmappedProjectIds.has(remote.id)) {
      return false;
    }
    // 剛被寫過的檔案不動：可能是使用者正在這台電腦上接續這則對話。
    if (scope.now - session.mtimeMs < ACTIVE_WINDOW_MS) {
      return false;
    }
    return scope.isStored(session);
  });
}

/**
 * 搬走之後已經沒有本機檔案的 thread id。
 *
 * 同一個 thread 可能有多個 rollout 檔（resume／子代理），只搬走其中一個時
 * 索引標題與選取規則都還得留著——它們是以 thread 為單位的。
 */
export function orphanedThreadIds(
  localSessions: readonly LocalSession[],
  removed: readonly LocalSession[]
): Set<string> {
  const removedFiles = new Set(removed.map((session) => session.file));
  const stillLocal = new Set(
    localSessions
      .filter((session) => session.tool === "codex" && !removedFiles.has(session.file))
      .map((session) => session.id)
  );
  return new Set(
    removed.map((session) => session.id).filter((id) => !stillLocal.has(id))
  );
}

export interface EvictionResult {
  /** 真的刪掉的檔案。 */
  removed: LocalSession[];
  /** 底下已經沒有本機檔案、索引標題也清掉了的 thread id。 */
  orphanedIds: string[];
}

/** 刪檔並清掉 session_index.jsonl 裡對應的標題。選取規則由呼叫端處理。 */
export async function evictUnmappedCodexSessions(
  codexPath: string,
  scope: EvictionScope,
  log: (line: string) => void
): Promise<EvictionResult> {
  const removed: LocalSession[] = [];
  for (const session of pickEvictable(scope)) {
    try {
      // 收集之後又被寫入就跳過：手上的 hash 已經不是磁碟上這一份，
      // store 裡那份救不回它。
      const stat = await fs.promises.stat(session.file);
      if (stat.mtimeMs !== session.mtimeMs || stat.size !== session.size) {
        continue;
      }
      await fs.promises.rm(session.file);
      removed.push(session);
    } catch (err: any) {
      log(`未能移出 ${session.file}：${err.message}`);
    }
  }
  if (!removed.length) {
    return { removed, orphanedIds: [] };
  }
  const orphaned = orphanedThreadIds(scope.localSessions, removed);
  await removeCodexSessionTitles(
    path.join(codexPath, "session_index.jsonl"),
    orphaned
  );
  log(
    `已把 ${removed.length} 個未對應專案的 Codex 對話移出本機（內容仍在備份庫，對應後會同步回來）`
  );
  return { removed, orphanedIds: [...orphaned] };
}
