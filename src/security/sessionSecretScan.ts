import * as path from "path";
import { scanFiles, ScanTarget, SecretFinding } from "./secretScan";
import { readClaudeMetadata } from "../agents/claude";
import { codexSessionInfo } from "../agents/codex";
import { LocalSession } from "../store/sessionStore";

export interface SessionScanTarget {
  session: LocalSession;
  /**
   * 跳過開頭這幾行（已經備份出去的內容）。session 檔是 append-only 的，
   * 舊內容再掃一次只會為同一段東西重複發問；預設 0 代表整份掃。
   */
  skipLines?: number;
}

export interface SessionSecretMatch {
  session: LocalSession;
  findings: SecretFinding[];
  /** 給使用者看的標題（aiTitle / thread_name / 子代理名稱），非 session id */
  displayName: string;
}

/** 解析 session 的人類可讀標題；只對少量檔案呼叫（警告訊息、略過記錄）。 */
export async function sessionDisplayName(session: LocalSession): Promise<string> {
  if (session.title?.trim()) {
    return session.title.trim();
  }
  if (session.tool === "claude") {
    const { aiTitle } = await readClaudeMetadata(session.file);
    return aiTitle ?? path.basename(session.file, ".jsonl");
  }
  try {
    const info = await codexSessionInfo({
      file: session.file,
      id: session.id,
      date: "",
      mtime: session.mtimeMs,
      size: session.size,
    });
    return info.title;
  } catch {
    return session.id;
  }
}

/**
 * 只回答「這些檔案有沒有掃到疑似金鑰」。側欄用得到金鑰旗標，但不需要 LocalSession
 * 那一整包中繼資料，也不必解析標題；掃描本身仍走同一組樣式。
 */
export async function filesWithSecrets(
  files: readonly string[]
): Promise<Set<string>> {
  const groups = new Map<string, Map<string, string>>();
  for (const file of files) {
    const root = path.parse(file).root;
    let group = groups.get(root);
    if (!group) {
      group = new Map<string, string>();
      groups.set(root, group);
    }
    // 以 rel 回查原本的路徑，免得 join 回去時大小寫或分隔符跟來源對不上。
    group.set(path.relative(root, file), file);
  }

  const hits = new Set<string>();
  for (const [root, byRel] of groups) {
    for (const finding of await scanFiles(root, [...byRel.keys()])) {
      const file = byRel.get(finding.rel);
      if (file) {
        hits.add(file);
      }
    }
  }
  return hits;
}

export async function scanSessionsForSecrets(
  targets: readonly SessionScanTarget[]
): Promise<SessionSecretMatch[]> {
  const groups = new Map<
    string,
    { targets: ScanTarget[]; sessions: Map<string, LocalSession> }
  >();
  for (const { session, skipLines } of targets) {
    const root = path.parse(session.file).root;
    const rel = path.relative(root, session.file);
    let group = groups.get(root);
    if (!group) {
      group = { targets: [], sessions: new Map<string, LocalSession>() };
      groups.set(root, group);
    }
    group.targets.push({ rel, skipLines });
    group.sessions.set(rel, session);
  }

  const matches = new Map<LocalSession, SecretFinding[]>();
  for (const [root, group] of groups) {
    const findings = await scanFiles(root, group.targets);
    for (const finding of findings) {
      const session = group.sessions.get(finding.rel);
      if (!session) {
        continue;
      }
      const current = matches.get(session) ?? [];
      current.push(finding);
      matches.set(session, current);
    }
  }
  const out: SessionSecretMatch[] = [];
  for (const { session } of targets) {
    const findings = matches.get(session);
    if (findings) {
      out.push({
        session,
        findings,
        displayName: await sessionDisplayName(session),
      });
    }
  }
  return out;
}
