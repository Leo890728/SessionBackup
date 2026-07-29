import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { runBackup } from "./backup";
import { upsertCodexSessionTitle } from "./codexIndex";
import { materializeCodexRevision, readCodexMetaCwd } from "./codexLocalize";
import { ConflictRecord, ConflictRegistry } from "./conflicts";
import { getConfig, updateSelectedSessions } from "./config";
import { ProjectMappingRegistry } from "./projectMapping";
import { applySessionRules, SelectionSet, SelectionTarget } from "./selection";
import { sessionDisplayName } from "./sessionSecretScan";
import {
  classifyJsonlFiles,
  collectLocalSessions,
  LocalSession,
  machineIdFromConfig,
  ManifestSession,
  readMachineManifests,
  resolveLocalTarget,
  revisionRelativePath,
  sourceForTool,
} from "./sessionStore";
import { fileKey, newestRemoteFiles } from "./syncState";

interface ResolutionRecord {
  localHash: string;
  remoteHash: string;
  choice: "B";
  resolvedAt: string;
}

type ResolutionMap = Record<string, ResolutionRecord>;

export interface SyncSummary {
  added: number;
  updated: number;
  keptLocal: number;
  identical: number;
  conflicts: number;
  skipped: number;
  deferred: number;
}

/** 檔案在這段時間內有寫入就視為使用中，不覆寫。 */
const ACTIVE_WINDOW_MS = 2 * 60 * 1000;

/**
 * 非互動同步：新增與單邊延伸自動處理；分叉只記錄成 ConflictRecord
 * 留給使用者稍後從側欄解決，過程不會跳任何視窗。
 */
export async function runSync(
  out: vscode.OutputChannel,
  projects: ProjectMappingRegistry,
  conflicts: ConflictRegistry,
  options?: { interactive?: boolean }
): Promise<SyncSummary> {
  const interactive = options?.interactive ?? true;
  const cfg = getConfig();
  await runBackup(out, interactive ? "manual" : "auto", projects);
  const machineId = machineIdFromConfig(cfg);
  const manifests = (await readMachineManifests(cfg.repoPath)).filter(
    (manifest) => manifest.machineId !== machineId
  );
  const localSessions = await collectLocalSessions(
    cfg,
    (cwd, projectDir) => projects.identifyLocalProject(cwd, projectDir),
    (cwd) => projects.identifyByCwd(cwd)
  );
  // 比對單位是「檔案」（tool:relativePath）而非 thread id：
  // Codex resume/子代理會讓多個 rollout 檔共用同一個 thread id，
  // 以 id 為 key 會把遠端檔案拿去跟錯誤的本機檔案比對，產生假衝突。
  const localByFile = new Map(
    localSessions.map((session) => [fileKey(session.tool, session.relativePath), session])
  );
  const selection = new SelectionSet(cfg.selectedSessions);
  const candidates = newestRemoteFiles(manifests);
  const resolutions = await readResolutions(cfg.repoPath, machineId);
  const conflictRecords: ConflictRecord[] = [];
  // 從其他電腦匯入的對話一律納入選取：它本來就已經在備份裡了，
  // 不這麼做的話匯入後反而不會再被這台電腦備份。
  const adopted: SelectionTarget[] = [];
  const summary: SyncSummary = {
    added: 0,
    updated: 0,
    keptLocal: 0,
    identical: 0,
    conflicts: 0,
    skipped: 0,
    deferred: 0,
  };

  for (const candidate of candidates) {
    const candidateKey = fileKey(candidate.session.tool, candidate.session.relativePath);
    const local = localByFile.get(candidateKey);
    // 選取規則以 thread id 為單位，涵蓋該 thread 的所有檔案。使用者明確排除的不匯入。
    if (
      selection.excludes({
        tool: candidate.session.tool,
        id: candidate.session.id,
        claudeProjectDir: local?.claudeProjectDir,
      })
    ) {
      summary.skipped++;
      continue;
    }
    const source = sourceForTool(cfg, candidate.session.tool);
    if (!source) {
      summary.skipped++;
      continue;
    }
    const remoteFile = path.join(
      cfg.repoPath,
      ...revisionRelativePath(candidate.session.tool, candidate.session.id, candidate.session.hash).split("/")
    );
    if (!fs.existsSync(remoteFile)) {
      summary.skipped++;
      continue;
    }
    if (!local) {
      let relativePath = candidate.session.relativePath;
      let claudeProjectDir: string | undefined;
      if (candidate.session.tool === "claude" && candidate.session.project) {
        const mapping = await projects.locateProject(candidate.session.project, interactive);
        if (!mapping) {
          summary.skipped++;
          continue;
        }
        claudeProjectDir = mapping.claudeProjectDir;
        relativePath = path.posix.join(
          "projects",
          mapping.claudeProjectDir,
          path.basename(candidate.session.relativePath)
        );
      } else if (
        candidate.session.tool === "claude" &&
        candidate.session.relativePath.startsWith("projects/")
      ) {
        out.appendLine(`略過 Claude session ${candidate.session.id}：缺少 canonical projectId`);
        summary.skipped++;
        continue;
      }
      const target = resolveLocalTarget(source.path, relativePath);
      if (!target) {
        summary.skipped++;
        continue;
      }
      if (fs.existsSync(target)) {
        // 本機已有這個檔案卻不在 localByFile：不是使用者沒選取它（不歸同步管），
        // 就是收集之後才出現的新檔案（這一輪不動它，下次同步再比對）。
        const selected = selection.includes({
          tool: candidate.session.tool,
          id: candidate.session.id,
          claudeProjectDir,
        });
        if (selected) {
          summary.deferred++;
        } else {
          summary.skipped++;
        }
        continue;
      }
      if (candidate.session.tool === "codex") {
        // 匯入時把 session_meta.cwd 本地化成這台電腦的專案路徑（找不到映射就保持原樣）。
        const mapping = candidate.session.project
          ? await projects.locateProject(candidate.session.project, false)
          : undefined;
        await materializeCodexRevision(remoteFile, target, mapping?.localPath);
      } else {
        await copyRevision(remoteFile, target);
      }
      await adoptCodexTitle(source.path, candidate.session);
      adopted.push({
        tool: candidate.session.tool,
        id: candidate.session.id,
        claudeProjectDir,
      });
      summary.added++;
      continue;
    }
    if (local.hash === candidate.session.hash) {
      await adoptCodexTitle(source.path, candidate.session);
      summary.identical++;
      continue;
    }
    const relation = await classifyJsonlFiles(local.file, remoteFile);
    if (relation === "same") {
      // 只差機器本地欄位（cwd 等），內容等價。
      await adoptCodexTitle(source.path, candidate.session);
      summary.identical++;
      continue;
    }
    if (relation === "remote-newer") {
      if (await unsafeToOverwrite(local)) {
        out.appendLine(`延後更新 ${local.relativePath}：檔案使用中或剛被寫入`);
        summary.deferred++;
        continue;
      }
      if (candidate.session.tool === "codex") {
        // cwd 是機器本地屬性：採用遠端內容但保留本機原本的 cwd。
        await materializeCodexRevision(
          remoteFile,
          local.file,
          await readCodexMetaCwd(local.file)
        );
      } else {
        await copyRevision(remoteFile, local.file);
      }
      await adoptCodexTitle(source.path, candidate.session);
      summary.updated++;
      continue;
    }
    if (relation === "local-newer") {
      summary.keptLocal++;
      continue;
    }

    // 真正分叉：不打斷同步，記錄下來讓使用者稍後從側欄解決。
    const resolutionKey = `${candidateKey}:${candidate.session.hash}`;
    if (resolutions[resolutionKey]?.choice === "B") {
      summary.keptLocal++;
      continue;
    }
    summary.conflicts++;
    conflictRecords.push({
      key: candidateKey,
      tool: candidate.session.tool,
      id: candidate.session.id,
      relativePath: candidate.session.relativePath,
      localFile: local.file,
      localHash: local.hash,
      remoteHash: candidate.session.hash,
      remoteMachine: candidate.machineId,
      detectedAt: new Date().toISOString(),
      displayName: await sessionDisplayName(local),
    });
  }

  await conflicts.replaceAll(conflictRecords);
  if (adopted.length) {
    // 必須在下面補跑的備份之前寫回，匯入的對話才會進入本機 manifest。
    await updateSelectedSessions((current) => applySessionRules(current, adopted, true));
  }
  if (summary.added || summary.updated) {
    await runBackup(out, interactive ? "manual" : "auto", projects);
  }
  return summary;
}

/** 使用者在比較視窗選「保留本機」後記住這個決定；遠端出現新 revision 才會再次成為衝突。 */
export async function rememberKeepLocal(
  repoPath: string,
  machineId: string,
  record: ConflictRecord
): Promise<void> {
  const resolutions = await readResolutions(repoPath, machineId);
  resolutions[`${record.key}:${record.remoteHash}`] = {
    localHash: record.localHash,
    remoteHash: record.remoteHash,
    choice: "B",
    resolvedAt: new Date().toISOString(),
  };
  await writeResolutions(repoPath, machineId, resolutions);
}

async function unsafeToOverwrite(local: LocalSession): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(local.file);
    if (stat.mtimeMs !== local.mtimeMs || stat.size !== local.size) {
      return true; // 收集後又被寫入，這一輪不覆寫
    }
    return Date.now() - stat.mtimeMs < ACTIVE_WINDOW_MS;
  } catch {
    return true;
  }
}

async function adoptCodexTitle(sourcePath: string, session: ManifestSession): Promise<void> {
  if (session.tool !== "codex" || !session.title) {
    return;
  }
  await upsertCodexSessionTitle(
    path.join(sourcePath, "session_index.jsonl"),
    session.id,
    session.title,
    session.titleUpdatedAt
  );
}

async function copyRevision(source: string, target: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.copyFile(source, target);
}

function resolutionsFile(repoPath: string, machineId: string): string {
  return path.join(repoPath, "machines", machineId, "resolutions.json");
}

async function readResolutions(repoPath: string, machineId: string): Promise<ResolutionMap> {
  try {
    return JSON.parse(await fs.promises.readFile(resolutionsFile(repoPath, machineId), "utf8"));
  } catch {
    return {};
  }
}

async function writeResolutions(
  repoPath: string,
  machineId: string,
  resolutions: ResolutionMap
): Promise<void> {
  const file = resolutionsFile(repoPath, machineId);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify(resolutions, null, 2) + "\n", "utf8");
}
