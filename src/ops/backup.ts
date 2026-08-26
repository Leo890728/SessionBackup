import * as vscode from "vscode";
import { getConfig, updateTrackedSessions } from "../config";
import { Git } from "../git/git";
import { getSessionToken, tokenHeader } from "../git/github/auth";
import { ProjectMappingRegistry } from "../store/projectMapping";
import { applySessionRules, SelectionTarget } from "../store/selection";
import {
  scanSessionsForSecrets,
  SessionSecretMatch,
  sessionDisplayName,
} from "../security/sessionSecretScan";
import {
  reviewSessionSecrets,
  SecretDecision,
  SecretReview,
} from "../ui/secretReviewView";
import {
  collectLocalSessions,
  machineIdFromConfig,
  pendingSessions,
  storeSessions,
} from "../store/sessionStore";

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
/** 開著的逐一確認面板（只有手動備份會有）。面板不是 modal，使用者可以晾著再按一次備份。 */
let pendingSecretReview: SecretReview | undefined;

export async function runBackup(
  out: vscode.OutputChannel,
  kind: BackupKind,
  projects?: ProjectMappingRegistry
): Promise<BackupOutcome> {
  while (current) {
    if (pendingSecretReview) {
      // 逐一確認的面板不會擋住 VS Code，所以使用者很容易忘了它還開著就再按一次備份。
      // 再開一個面板只會有兩份互相打架的決定，直接把原本那個帶到前景。
      pendingSecretReview.reveal();
      return {
        committed: false,
        pushed: false,
        message: "上一次備份還在等待疑似金鑰的確認（已切換到該視窗）",
      };
    }
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

function toolLabel(tool: string): string {
  return tool === "claude" ? "Claude" : "Codex";
}

/**
 * 自動備份的機密確認：右下角通知，一次對全部命中做同一個決定。
 * 背景備份不該搶走焦點，所以不開逐一確認的面板。
 * 除了使用者的選擇之外，還可能被逾時或後續的手動備份放掉，
 * 兩種情況都當成「沒有答案」，也就是取消這次備份。
 */
async function askSecretDecision(
  out: vscode.OutputChannel,
  message: string,
  detail: string,
  items: readonly string[]
): Promise<string | undefined> {
  const prompt = Promise.resolve(
    vscode.window.showWarningMessage(message, { modal: false, detail }, ...items)
  );
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

/** 自動備份：一則通知、一個決定，套用到全部命中的 session。 */
async function autoSecretDecisions(
  out: vscode.OutputChannel,
  matches: SessionSecretMatch[],
  detail: string
): Promise<Map<string, SecretDecision> | undefined> {
  const skipLabel =
    matches.length === 1 ? "跳過此次" : `跳過此次（${matches.length} 個）`;
  const deselectLabel =
    matches.length === 1
      ? "取消追蹤此 session"
      : `取消追蹤這 ${matches.length} 個 sessions`;
  // 這裡的通知沒有 VS Code 自動附加的取消鈕（那是 modal 才有），
  // 所以「取消此次備份」要自己列出來；效果與直接關掉通知、逾時完全相同。
  const pick = await askSecretDecision(
    out,
    `Session Backup: 在 ${matches.length} 個 session 偵測到疑似金鑰/憑證`,
    detail,
    [skipLabel, deselectLabel, "仍要全部備份", "取消此次備份"]
  );
  const decision: SecretDecision | undefined =
    pick === skipLabel
      ? "skip"
      : pick === deselectLabel
        ? "deselect"
        : pick === "仍要全部備份"
          ? "backup"
          : undefined;
  if (!decision) {
    return undefined;
  }
  return new Map(matches.map((match) => [match.session.file, decision]));
}

/** 手動備份：逐一確認的面板，可以個別決定，也可以勾「後續都這樣處理」。 */
async function manualSecretDecisions(
  matches: SessionSecretMatch[]
): Promise<Map<string, SecretDecision> | undefined> {
  const review = reviewSessionSecrets(
    matches.map(({ session, findings, displayName }) => ({
      key: session.file,
      toolLabel: toolLabel(session.tool),
      displayName,
      fileName: session.file,
      findings,
    }))
  );
  pendingSecretReview = review;
  try {
    return await review.decisions;
  } finally {
    pendingSecretReview = undefined;
  }
}

async function doBackup(
  out: vscode.OutputChannel,
  kind: BackupKind,
  projects?: ProjectMappingRegistry
): Promise<BackupOutcome> {
  const cfg = getConfig();
  if (!cfg.trackedSessions.length) {
    // 白名單是空的：不動 manifest，避免把先前備份過的內容從索引中抹掉。
    return {
      committed: false,
      pushed: false,
      message: "尚未追蹤任何對話（在 Sessions 側欄勾選）",
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
  const sessions = await collectLocalSessions(
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
      message: "追蹤中的對話都找不到對應檔案，沒有可備份的內容",
    };
  }
  const machineId = machineIdFromConfig(cfg);
  /** 掃到疑似金鑰、這次不上傳新內容的 session 檔案。 */
  let heldForSecrets = new Set<string>();
  if (cfg.secretScan) {
    // 只掃這次真的會新寫入 store 的內容：沒有變動的對話不會再上傳，
    // 已經備份出去的那段前綴也早就在備份庫裡了，為它們發問只是把使用者訓練成一路按過去。
    const pending = await pendingSessions(
      cfg.repoPath,
      machineId,
      sessions.filter((session) => session.size <= maxBytes)
    );
    const secretMatches = await scanSessionsForSecrets(
      pending.map(({ session, backedUpLines }) => ({
        session,
        skipLines: backedUpLines,
      }))
    );
    if (secretMatches.length) {
      const line = ({ session, findings, displayName }: SessionSecretMatch) =>
        `${toolLabel(session.tool)}「${displayName}」：` +
        findings.map((finding) => `${finding.kind}（第 ${finding.line} 行）`).join("、");
      out.appendLine("含疑似機密的 sessions：\n" + secretMatches.map(line).join("\n"));
      // 備份庫沒有刪除機制，金鑰一旦推上去就等於外流，所以每個選項的預設方向都是「先不要上傳」；
      // 「仍要備份」永遠留著，誤判時不該逼使用者去關掉整個掃描。
      const decisions =
        kind === "manual"
          ? await manualSecretDecisions(secretMatches)
          : await autoSecretDecisions(
              out,
              secretMatches,
              // 通知的內文有高度上限，列太多只會被截掉。
              secretMatches.slice(0, 10).map(line).join("\n")
            );
      if (!decisions) {
        return {
          committed: false,
          pushed: false,
          message: "偵測到疑似機密，已取消備份（詳見記錄）",
        };
      }
      const skippedFiles = new Set<string>();
      const deselected: SelectionTarget[] = [];
      for (const match of secretMatches) {
        // 沒有明確答案的一律當成跳過：預設放行等於預設外流。
        const decision = decisions.get(match.session.file) ?? "skip";
        if (decision === "backup") {
          continue;
        }
        skippedFiles.add(match.session.file);
        if (decision === "deselect") {
          deselected.push({
            tool: match.session.tool,
            id: match.session.id,
            claudeProjectDir: match.session.claudeProjectDir,
          });
        }
      }
      if (deselected.length) {
        await updateTrackedSessions((current) =>
          applySessionRules(current, deselected, false)
        );
        out.appendLine(
          `已取消追蹤 ${deselected.length} 個 session（sessionBackup.trackedSessions），` +
            "之後的備份、變更偵測與同步都會跳過"
        );
      }
      if (skippedFiles.size) {
        heldForSecrets = skippedFiles;
        out.appendLine(`已跳過 ${skippedFiles.size} 個含疑似機密的 session`);
      }
    }
  }
  const skippedSecretCount = heldForSecrets.size;
  const stored = await storeSessions(
    cfg.repoPath,
    machineId,
    sessions,
    maxBytes,
    heldForSecrets
  );
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
