import * as path from "path";
import { scanFiles, SecretFinding } from "./secretScan";
import { readClaudeMetadata } from "../agents/claude";
import { codexSessionInfo } from "../agents/codex";
import { LocalSession } from "../store/sessionStore";

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

export async function scanSessionsForSecrets(
  sessions: LocalSession[]
): Promise<SessionSecretMatch[]> {
  const groups = new Map<
    string,
    { rels: string[]; sessions: Map<string, LocalSession> }
  >();
  for (const session of sessions) {
    const root = path.parse(session.file).root;
    const rel = path.relative(root, session.file);
    let group = groups.get(root);
    if (!group) {
      group = { rels: [], sessions: new Map<string, LocalSession>() };
      groups.set(root, group);
    }
    group.rels.push(rel);
    group.sessions.set(rel, session);
  }

  const matches = new Map<LocalSession, SecretFinding[]>();
  for (const [root, group] of groups) {
    const findings = await scanFiles(root, group.rels);
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
  for (const session of sessions) {
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
