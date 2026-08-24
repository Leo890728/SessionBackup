import * as vscode from "vscode";
import { getConfig, updateSelectedSessions } from "./config";
import { Git } from "./git";
import { getSessionToken, tokenHeader } from "./github";
import { ProjectMappingRegistry } from "./projectMapping";
import { applySessionRules } from "./selection";
import { scanSessionsForSecrets, sessionDisplayName } from "./sessionSecretScan";
import {
  collectLocalSessions,
  isRevisionStored,
  machineIdFromConfig,
  storeSessions,
} from "./sessionStore";

export type BackupKind = "manual" | "auto";

export interface BackupOutcome {
  committed: boolean;
  pushed: boolean;
  message: string;
}

/**
 * 自動備份的機密確認是右下角的通知，使用者可以完全不理它，而通知不會自己消失。
 * 時間到就先放掉這次備份：不然這個 runBackup 會一直沒有結束，
 * 之後的備份與自動同步全部卡在「另一個備份正在進行中」。
 */
const AUTO_SECRET_PROMPT_TIMEOUT_MS = 5 * 60_000;

/** 進行中的備份；沒有備份在跑時是 undefined。 */
let current: Promise<BackupOutcome> | undefined;
/** 正在等待回應、而且可以被放掉的機密確認通知（只有自動備份的非強制通知會有）。 */
let pendingSecretPrompt: { dismiss: () => void } | undefined;

export async function runBackup(
  out: vscode.OutputChannel,
  kind: BackupKind,
  projects?: ProjectMappingRegistry
): Promise<BackupOutcome> {
  while (current) {
    // 使用者沒理自動備份的機密確認通知，卻自己按了備份：手動這次才是他現在的意圖，
    // 先放掉卡住的那次再接手，否則在通知逾時之前手動備份都只會被擋掉。
    if (kind !== "manual" || !pendingSecretPrompt) {
      return {
        committed: false,
        pushed: false,
        message: pendingSecretPrompt
          ? "上一次備份還在等待機密確認的回覆"
          : "另一個備份正在進行中",
      };
    }
    out.appendLine("上一次備份還在等待機密確認，改由這次手動備份接手");
    pendingSecretPrompt.dismiss();
    await current.catch(() => undefined);
  }
  const run = doBackup(out, kind, projects);
  current = run;
  try {
    return await run;
  } finally {
    if (current === run) {
      current = undefined;
    }
  }
}

/**
 * 機密確認的提問。手動備份用強制回應的對話框（一定會有答案）；
 * 自動備份用右下角通知，除了使用者的選擇之外，還可能被逾時或後續的手動備份放掉，
 * 兩種情況都當成「沒有答案」，也就是取消這次備份。
 */
async function askSecretDecision(
  out: vscode.OutputChannel,
  modal: boolean,
  message: string,
  detail: string,
  items: readonly string[]
): Promise<string | undefined> {
  const prompt = Promise.resolve(
    vscode.window.showWarningMessage(message, { modal, detail }, ...items)
  );
  if (modal) {
    return prompt;
  }
  return new Promise<string | undefined>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (pick: string | undefined, note?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      pendingSecretPrompt = undefined;
      if (note) {
        out.appendLine(note);
      }
      resolve(pick);
    };
    timer = setTimeout(
      () =>
        finish(
          undefined,
          "機密確認通知逾時未回應，這次備份先取消（下次備份會再問一次）"
        ),
      AUTO_SECRET_PROMPT_TIMEOUT_MS
    );
    pendingSecretPrompt = {
      dismiss: () => finish(undefined, "機密確認通知未回應，已由新的備份接手"),
    };
    void prompt.then((pick) => {
      if (settled) {
        // 通知不會自己消失，所以放掉之後還是點得下去；那次備份已經結束了，
        // 這裡只能記錄，實際的決定要等下一次備份重新詢問。
        out.appendLine(
          `機密確認在這次備份結束後才被點選（${pick ?? "關閉"}），已忽略；請重新備份`
        );
        return;
      }
      finish(pick);
    });
  });
}

async function doBackup(
  out: vscode.OutputChannel,
  kind: BackupKind,
  projects?: ProjectMappingRegistry
): Promise<BackupOutcome> {
  const cfg = getConfig();
  if (!cfg.selectedSessions.length) {
    // 白名單是空的：不動 manifest，避免把先前備份過的內容從索引中抹掉。
    return {
      committed: false,
      pushed: false,
      message: "尚未選取任何要備份的對話（在 Sessions 側欄勾選）",
    };
  }
  const git = new Git(cfg.repoPath, out);
  await git.ensureRepo();

  const remote = await git.getRemote();
  const token = remote?.includes("github.com")
    ? await getSessionToken(false)
    : undefined;
  if (remote) {
    await git.syncFromRemote(token ? tokenHeader(token) : undefined);
  }

  const maxBytes = cfg.maxFileSizeMB * 1024 * 1024;
  let sessions = await collectLocalSessions(
    cfg,
    projects
      ? (cwd, projectDir) => projects.identifyLocalProject(cwd, projectDir)
      : undefined,
    projects ? (cwd) => projects.identifyByCwd(cwd) : undefined
  );
  if (!sessions.length) {
    return {
      committed: false,
      pushed: false,
      message: "選取的對話都找不到對應檔案，沒有可備份的內容",
    };
  }
  let skippedSecretCount = 0;
  if (cfg.secretScan) {
    // 只掃這次會新寫入 store 的內容；已存在的 revision 不會再上傳，重掃只是噪音。
    const pending = sessions.filter(
      (session) =>
        session.size <= maxBytes && !isRevisionStored(cfg.repoPath, session)
    );
    const secretMatches = await scanSessionsForSecrets(pending);
    if (secretMatches.length) {
      const detail = secretMatches
        .slice(0, 10)
        .map(
          ({ session, findings, displayName }) =>
            `${session.tool === "claude" ? "Claude" : "Codex"}「${displayName}」：` +
            findings.map((finding) => `${finding.kind}（第 ${finding.line} 行）`).join("、")
        )
        .join("\n");
      const skipLabel =
        secretMatches.length === 1
          ? "跳過此次"
          : `跳過此次（${secretMatches.length} 個）`;
      const deselectLabel =
        secretMatches.length === 1
          ? "取消選取此 session"
          : `取消選取這 ${secretMatches.length} 個 sessions`;
      out.appendLine("含疑似機密的 sessions：\n" + detail);
      // 備份庫沒有刪除機制，金鑰一旦推上去就等於外流，所以其餘選項都是「先不要上傳」；
      // 「仍要全部備份」永遠留著，誤判時不該逼使用者去關掉整個掃描。
      const pick = await askSecretDecision(
        out,
        kind === "manual",
        `Session Backup: 在 ${secretMatches.length} 個 session 偵測到疑似金鑰/憑證`,
        detail,
        [skipLabel, deselectLabel, "仍要全部備份", "取消此次備份"]
      );
      if (pick === skipLabel) {
        const skippedFiles = new Set(secretMatches.map((match) => match.session.file));
        sessions = sessions.filter((session) => !skippedFiles.has(session.file));
        skippedSecretCount = secretMatches.length;
        out.appendLine(`已跳過 ${skippedSecretCount} 個含疑似機密的 session`);
      } else if (pick === deselectLabel) {
        const targets = secretMatches.map((match) => ({
          tool: match.session.tool,
          id: match.session.id,
          claudeProjectDir: match.session.claudeProjectDir,
        }));
        await updateSelectedSessions((current) =>
          applySessionRules(current, targets, false)
        );
        const keys = new Set(targets.map((t) => `${t.tool}:${t.id}`));
        sessions = sessions.filter(
          (session) => !keys.has(`${session.tool}:${session.id}`)
        );
        skippedSecretCount = secretMatches.length;
        out.appendLine(
          `已取消選取 ${keys.size} 個 session（sessionBackup.selectedSessions），` +
            "之後的備份、變更偵測與同步都會跳過"
        );
      } else if (pick !== "仍要全部備份") {
        return {
          committed: false,
          pushed: false,
          message: "偵測到疑似機密，已取消備份（詳見記錄）",
        };
      }
    }
  }
  const machineId = machineIdFromConfig(cfg);
  const stored = await storeSessions(cfg.repoPath, machineId, sessions, maxBytes);
  for (const session of stored.skipped) {
    out.appendLine(
      `略過「${await sessionDisplayName(session)}」` +
        `（檔案過大 ${(session.size / 1048576).toFixed(1)} MB，${session.file}）`
    );
  }
  for (const session of stored.deferred) {
    out.appendLine(
      `延後備份「${await sessionDisplayName(session)}」` +
        `（複製期間檔案又被寫入，下次備份會重收，${session.file}）`
    );
  }

  // 只有 store/ 底下的檔案是真正新寫入的 session 內容（其餘是 manifest/format 中繼資料）
  const revisionCount = stored.copied.filter((rel) => rel.startsWith("store/")).length;
  const msg =
    `backup: ${machineId}` +
    ` (${revisionCount} changed, ${stored.manifest.sessions.length} total)`;
  const committed = await git.commitAll(msg);
  if (!committed) {
    return {
      committed: false,
      pushed: false,
      message: skippedSecretCount
        ? `已跳過 ${skippedSecretCount} 個含機密 session，沒有其他變更`
        : "沒有變更，不需備份",
    };
  }

  let pushed = false;
  if (remote) {
    try {
      await git.pushWithRetry(token ? tokenHeader(token) : undefined);
      pushed = true;
    } catch (e: any) {
      out.appendLine("push 失敗：" + e.message);
      return {
        committed: true,
        pushed: false,
        message: "已建立本地備份，但 push 失敗：" + e.message,
      };
    }
  }
  const detail =
    (revisionCount
      ? `${revisionCount} 個 session 變更`
      : "僅中繼資料變更") +
    `，共 ${stored.manifest.sessions.length} 個 sessions` +
    (skippedSecretCount ? `，跳過 ${skippedSecretCount} 個含機密 session` : "");
  return {
    committed: true,
    pushed,
    message: pushed
      ? `已備份並上傳（${detail}）`
      : `已建立本地備份（${detail}）` + (remote ? "" : "，尚未設定遠端"),
  };
}
