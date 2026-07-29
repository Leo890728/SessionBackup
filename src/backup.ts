import * as vscode from "vscode";
import { getConfig, updateSelectedSessions } from "./config";
import { Git } from "./git";
import { getSessionToken, tokenHeader } from "./github";
import { ProjectMappingRegistry } from "./projectMapping";
import { applySessionRules } from "./selection";
import { redactSessions, SecretVault } from "./sessionRedact";
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

let running = false;

export async function runBackup(
  out: vscode.OutputChannel,
  kind: BackupKind,
  projects?: ProjectMappingRegistry,
  vault?: SecretVault
): Promise<BackupOutcome> {
  if (running) {
    return { committed: false, pushed: false, message: "另一個備份正在進行中" };
  }
  running = true;
  try {
    return await doBackup(out, kind, projects, vault);
  } finally {
    running = false;
  }
}

async function doBackup(
  out: vscode.OutputChannel,
  kind: BackupKind,
  projects?: ProjectMappingRegistry,
  vault?: SecretVault
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
      const redactLabel =
        secretMatches.length === 1 ? "遮蔽後備份" : `遮蔽後備份（${secretMatches.length} 個）`;
      const skipLabel =
        secretMatches.length === 1
          ? "跳過此次"
          : `跳過此次（${secretMatches.length} 個）`;
      const deselectLabel =
        secretMatches.length === 1
          ? "取消選取此 session"
          : `取消選取這 ${secretMatches.length} 個 sessions`;
      out.appendLine("含疑似機密的 sessions：\n" + detail);
      // 遮蔽排第一是預設建議；但它會改寫原始檔，所以只在使用者明確點下去時才做，
      // 其餘選項（跳過／取消選取／仍要全部備份）維持原樣，不遮蔽永遠是可選的。
      const pick = await vscode.window.showWarningMessage(
        `Session Backup: 在 ${secretMatches.length} 個 session 偵測到疑似金鑰/憑證`,
        { modal: kind === "manual", detail },
        ...(vault ? [redactLabel] : []),
        skipLabel,
        deselectLabel,
        "仍要全部備份",
        "取消此次備份"
      );
      if (pick === redactLabel && vault) {
        const outcome = await redactSessions(
          secretMatches.map((match) => match.session),
          vault
        );
        const updated = new Map(
          outcome.redacted.map((session) => [session.file, session])
        );
        // 使用中或收集後又變動的檔案這輪不動，也不備份——內容還沒遮就上傳等於沒遮。
        const held = new Set(
          outcome.skipped.map((entry) => entry.session.file)
        );
        sessions = sessions
          .map((session) => updated.get(session.file) ?? session)
          .filter((session) => !held.has(session.file));
        skippedSecretCount = outcome.skipped.length;
        out.appendLine(
          `已就地遮蔽 ${outcome.redacted.length} 個 session、共 ${outcome.count} 個憑證；` +
            `原文保存在 ${vault.storagePath}（不會進備份庫）`
        );
        for (const entry of outcome.skipped) {
          out.appendLine(
            `未遮蔽 ${entry.session.file}：` +
              { active: "檔案使用中，下次備份再處理", changed: "掃描後檔案又有變動", "no-match": "重新讀取時已無命中", error: `失敗 — ${entry.error}` }[
                entry.reason
              ]
          );
        }
      } else if (pick === skipLabel) {
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
