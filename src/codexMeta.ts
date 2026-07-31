/**
 * Codex rollout 檔開頭 session_meta 的 schema 知識集中在這裡。
 *
 * 這裡只回傳 raw facts，不含任何 policy：各 consumer 讀多少檔案、要不要快取、
 * 以及把 thread id 當成備份 key 還是 UI 身分，都留在原本的模組裡決定。
 */

/** session_meta 的 payload。欄位型別維持 unknown，narrowing 由 consumer 自己做。 */
export interface CodexSessionMetaPayload {
  session_id?: unknown;
  id?: unknown;
  cwd?: unknown;
  parent_thread_id?: unknown;
  source?: unknown;
  model_provider?: unknown;
  [key: string]: unknown;
}

/** 這一行是不是 session_meta？是的話回傳它的 payload，否則 undefined。 */
export function codexSessionMeta(record: unknown): CodexSessionMetaPayload | undefined {
  const value = record as { type?: unknown; payload?: unknown } | null | undefined;
  return value?.type === "session_meta" && value.payload && typeof value.payload === "object"
    ? (value.payload as CodexSessionMetaPayload)
    : undefined;
}

/**
 * Codex thread 的識別碼：新版寫 session_id，舊版只有 id。
 *
 * 備份端（manifest 與選取 key）和 UI 端必須用同一條規則，否則使用者勾選的
 * session 會對不上實際備份到的檔案——尤其是子代理檔，它的 session_id 是父
 * thread，payload.id 才是自身。
 */
export function codexThreadId(payload: CodexSessionMetaPayload): string | undefined {
  const id = payload.session_id ?? payload.id;
  return typeof id === "string" ? id : undefined;
}

/**
 * session_meta 記錄的工作目錄。這是「機器本地」屬性——跨機同步時會被改寫或
 * 在比對時忽略，詳見 codexLocalize 與 sessionStore.canonicalRecord。
 */
export function codexMetaCwd(payload: CodexSessionMetaPayload): string | undefined {
  return typeof payload.cwd === "string" ? payload.cwd : undefined;
}

/** 子代理檔的父 thread；主 thread（含接續的 rollout 檔）沒有這個欄位。 */
export function codexParentThreadId(payload: CodexSessionMetaPayload): string | undefined {
  return typeof payload.parent_thread_id === "string" ? payload.parent_thread_id : undefined;
}

/**
 * 檔案自身的 id。子代理檔的 session_id 是父 thread，只有這裡才是它自己，
 * 也是其他子代理用 parent_thread_id 指回來時對得上的值。
 */
export function codexOwnId(payload: CodexSessionMetaPayload): string | undefined {
  return typeof payload.id === "string" ? payload.id : undefined;
}

/**
 * session_meta.source 描述的子代理名稱；不是子代理時回傳 undefined。
 *
 * 實際會出現三種形狀：
 *   "vscode"                                    主 thread，非子代理
 *   { subagent: { other: "guardian" } }          內建子代理
 *   { subagent: { thread_spawn: { agent_path: "/root/baseline_tests", … } } }
 *
 * thread_spawn 要取 agent_path 的最後一段（agent 本身的名字），否則每個
 * 被 spawn 的子代理都會顯示成同一個字串 "thread_spawn"。
 */
export function codexSubagentName(source: unknown): string | undefined {
  const sub = (source as { subagent?: unknown } | null | undefined)?.subagent;
  if (!sub) {
    return undefined;
  }
  if (typeof sub === "string") {
    return sub;
  }
  if (typeof sub !== "object") {
    return undefined;
  }
  for (const value of Object.values(sub as Record<string, unknown>)) {
    if (typeof value === "string") {
      return value;
    }
    const spawn = value as { agent_path?: unknown; agent_nickname?: unknown } | null;
    if (typeof spawn?.agent_path === "string" && spawn.agent_path.trim()) {
      return spawn.agent_path.split("/").filter(Boolean).pop();
    }
    if (typeof spawn?.agent_nickname === "string" && spawn.agent_nickname.trim()) {
      return spawn.agent_nickname;
    }
  }
  return Object.keys(sub as Record<string, unknown>)[0];
}
