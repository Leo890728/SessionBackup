/** Claude 與 Codex session 的共用資料形狀。 */

export type Tool = "claude" | "codex";

export interface SessionInfo {
  tool: Tool;
  file: string;
  id: string;
  /**
   * 備份端辨識這個 session 的 id（規則見 codexMeta.codexThreadId）。
   * 選取規則一律用這個值，否則 Codex 子代理檔（id 是自身、備份端用父 thread id）
   * 會勾了卻備份不到。
   */
  backupId: string;
  mtime: number;
  size: number;
  title: string;
  cwd?: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
  /** Codex 子 thread：session_meta 的 parent_thread_id */
  parentThreadId?: string;
  /** Codex 子代理名稱（thread_source=subagent 時，如 guardian） */
  subagent?: string;
}

export interface ClaudeProject {
  dir: string;
  label: string;
  /** 從 session 內容讀出的實際工作目錄；讀不到時使用 decoded 的近似路徑。 */
  cwd?: string;
  decoded: string;
  mtime: number;
  count: number;
  /**
   * 專案底下每個 session 的 id（= 去掉副檔名的檔名）。樹狀圖用它算「部分追蹤」，
   * 不必先把整個專案的 session 讀出來。備份用的 backupId 取自檔案裡的 sessionId，
   * Claude 兩者一致；萬一不一致也只影響這個提示，不影響備份範圍。
   */
  sessionIds: string[];
}

export interface CodexFile {
  file: string;
  id: string;
  title?: string;
  date: string;
  mtime: number;
  size: number;
}

export interface CodexThreadGroup {
  /** 頂層 sessions（沒有 parent_thread_id 的） */
  topLevel: SessionInfo[];
  /** 子 thread 掛載點：key 是父 thread「最新 rollout 檔」的路徑 */
  subsByHost: Map<string, SessionInfo[]>;
  /** 有 parent_thread_id 但父檔案已不在本機的子 thread（不顯示於樹上，仍會備份） */
  orphans: SessionInfo[];
}

export interface CodexProjectGroup {
  /** 跨平台正規化後的工作目錄；供樹節點 id 與分組使用。 */
  key: string;
  /** 工作目錄的最後一段；側欄以此作為專案名稱。 */
  label: string;
  /** 正規化後、供使用者辨識的完整工作目錄。 */
  cwd?: string;
  sessions: SessionInfo[];
  /** 專案中最新 session 的修改時間；用來排列專案。 */
  latestMtime: number;
}

export interface SessionProjectIdentity {
  key: string;
  label: string;
  cwd?: string;
}

export interface ClaudeProjectAiGroup {
  tool: "claude";
  projects: ClaudeProject[];
  latestMtime: number;
}

export interface CodexProjectAiGroup {
  tool: "codex";
  sessions: SessionInfo[];
  latestMtime: number;
}

export type SessionProjectAiGroup = ClaudeProjectAiGroup | CodexProjectAiGroup;

export interface SessionProjectGroup extends SessionProjectIdentity {
  ai: SessionProjectAiGroup[];
  latestMtime: number;
  /**
   * 工作目錄在這台電腦上找得到。false 的典型情況是從別台電腦同步回來的 Codex
   * 對話：檔案在本機，cwd 卻是那台電腦的路徑，本機沒有對應的專案資料夾。
   */
  local: boolean;
}

export type TranscriptBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; name: string; detail?: string }
  /** IDE 附加在提問前面的上下文（開啟中的檔案、選取範圍），不是使用者打的字。 */
  | { kind: "context"; label: string; detail: string }
  /** 一輪回覆中途的過程（進度說明與工具呼叫），預覽收合起來只留最後的答案。 */
  | { kind: "work"; durationMs?: number; items: TranscriptBlock[] };

export interface TranscriptMessage {
  /** notice 是對話流程本身的事件（例如使用者中斷），不屬於任何一方的發言。 */
  role: "user" | "assistant" | "notice";
  blocks: TranscriptBlock[];
  /** 這則訊息第一段內容的時間（Codex 的部分紀錄沒有時間欄位）。 */
  timestamp?: string;
  /**
   * 產生這則訊息的第一筆 JSONL 紀錄在檔案中的序號（以 readAllLines 的陣列為準）。
   * 預覽靠它把「已備份到哪裡」的橫桿放在對的位置。
   */
  sourceLine?: number;
}

export interface Transcript {
  tool: Tool;
  file: string;
  title: string;
  cwd?: string;
  messages: TranscriptMessage[];
}

/** 兩種工具各自解析出來的結果，差別只在怎麼讀，讀完的形狀是一樣的。 */
export interface ParsedTranscript {
  title: string;
  cwd?: string;
  messages: TranscriptMessage[];
}
