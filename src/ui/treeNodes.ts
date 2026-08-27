/** Sessions 側欄的節點形狀。純型別，不相依 vscode。 */

import { ClaudeProject, SessionInfo, Tool } from "../agents/types";
import { SessionSyncStatus } from "../store/sessionStatus";
import { ProjectRef } from "../store/sessionStore";
import { RemoteSession } from "../store/unmappedProjects";

/**
 * 專案節點底下、還沒匯入的那一半（「Claude Code · 5 個待匯入」）。
 * 與 claudeProject／codexProject 並排，差別是它的對話還沒有本機檔案。
 */
export type PendingAiNode = {
  kind: "pendingAi";
  tool: Tool;
  projectLabel: string;
  machines: string[];
  sessions: RemoteSession[];
};

/** 待匯入的一則對話。file 指向本機備份庫 store 裡的 revision，可直接預覽。 */
export type PendingSessionNode = {
  kind: "pendingSession";
  session: RemoteSession;
  file: string;
};

/**
 * 這個節點畫在「未對應專案」那一層底下。整層都不給 checkbox，所以旗標要從專案
 * 一路帶到對話——getTreeItem 拿到的是單一節點，看不到父節點是誰。
 * 專案節點自己不必帶：它就是 local === false 的那些。
 */
type InUnmappedGroup = { inUnmappedGroup?: boolean };

export type ClaudeProjectNode = InUnmappedGroup & {
  kind: "claudeProject";
  projectKey: string;
  projectLabel: string;
  cwd?: string;
  projects: ClaudeProject[];
};

export type CodexProjectNode = InUnmappedGroup & {
  kind: "codexProject";
  projectKey: string;
  projectLabel: string;
  cwd?: string;
  codexRoot: string;
  topLevel: SessionInfo[];
  subsByHost: Map<string, SessionInfo[]>;
};

export type ProjectNode = {
  kind: "project";
  key: string;
  label: string;
  cwd?: string;
  latestMtime: number;
  /** 工作目錄在這台電腦上找得到；false 會顯示成「未對應」並排到最後。 */
  local: boolean;
  /**
   * 備份庫裡已經有這個專案的對話（不限哪一台電腦）。取消追蹤後本機看不出
   * 「以前備份過」，圖示上的雲章就是靠這個旗標決定要不要畫。
   */
  backedUp: boolean;
  /**
   * 這個專案的身分。來自本機 registry 或其他電腦的 manifest（見 resolveProjectRefs）。
   * 這也是「同一個專案在兩台電腦有兩個路徑」能併成一個節點的依據。
   */
  projectRef?: ProjectRef;
  /**
   * 這個節點底下、工作目錄不在本機的那些路徑分組 key。有值代表還有檔案帶著
   * 來源電腦的 cwd：側欄已經併好了，但 Codex CLI 自己仍會用那個路徑列出它們，
   * 要改寫檔案才算真的修好。有值且有 projectRef 時列尾才出現 🔗。
   */
  strayCwdKeys: string[];
  /** 這個節點底下每個對話的 `tool:id`，用來比對遠端還有哪些沒下來。 */
  sessionKeys: string[];
  /**
   * 遠端還有、但還沒進到本機的對話（多半是同步時被跳過的 Claude 對話）。
   * 全部都下來了就沒有這個欄位。
   *
   * 這些對話的內容在本機備份庫的 store 裡，所以展開得開也預覽得了——不必為了
   * 「先看看再決定對應到哪」把檔案搬進 ~/.claude。
   *
   * 只影響顯示——🔗 看的是 strayCwdKeys，因為「已經對應過、只剩 Codex 的 cwd
   * 沒改過來」的專案不會出現在待對應清單裡，卻同樣需要修。
   */
  unmapped?: { machines: string[]; sessions: RemoteSession[] };
  children: (ClaudeProjectNode | CodexProjectNode)[];
};

/**
 * 「未對應」那一層：本機解不出位置的專案都收在這裡，排在已對應的專案之前。
 * 底下混了兩種——本機有檔案但工作目錄不存在的（多半是別台同步回來的 Codex 對話），
 * 以及只存在於其他電腦備份、本機還沒有檔案的 Claude 專案。同一個專案同時符合
 * 兩者時只會出現一次，見 splitPendingProjects。
 */
export type UnmappedGroupNode = {
  kind: "unmappedGroup";
  count: number;
  children: TreeNode[];
};

export type TreeNode =
  | UnmappedGroupNode
  | ProjectNode
  | ClaudeProjectNode
  | CodexProjectNode
  | PendingAiNode
  | PendingSessionNode
  | (InUnmappedGroup & {
      kind: "session";
      info: SessionInfo;
      status: SessionSyncStatus;
      claudeProjectDir?: string;
      conversationCwd?: string;
      /** 掃到疑似金鑰；側欄用警告圖示取代對話圖示。sessionBackup.secretScan 關掉時恆為 false。 */
      hasSecret?: boolean;
      subs?: TreeNode[];
    })
  /** 遠端備份過、本機連檔案都還沒有的專案；點一下建立映射。本機已有檔案的那半
   *  併進 ProjectNode.unmapped，不會在這裡重複出現。 */
  | {
      kind: "unmappedProject";
      project: ProjectRef;
      count: number;
      machines: string[];
      /**
       * 這些對話本身，展開時依 AI 分層列出來。內容在本機備份庫的 store 裡，
       * 所以還沒對應也讀得到——未對應的 Codex 對話被搬出 ~/.codex/sessions
       * 之後，這是它們唯一的入口。
       */
      sessions: RemoteSession[];
      /** 撞名時消歧義過的標籤；沒撞名就沿用 project.displayName。 */
      label?: string;
    };
