/** Sessions 側欄的節點形狀。純型別，不相依 vscode。 */

import { ClaudeProject, SessionInfo } from "../agents/types";
import { SessionSyncStatus } from "../store/sessionStatus";
import { ProjectRef } from "../store/sessionStore";

export type ClaudeProjectNode = {
  kind: "claudeProject";
  projectKey: string;
  projectLabel: string;
  cwd?: string;
  projects: ClaudeProject[];
};

export type CodexProjectNode = {
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
  children: (ClaudeProjectNode | CodexProjectNode)[];
};

export type TreeNode =
  | ProjectNode
  | ClaudeProjectNode
  | CodexProjectNode
  | {
      kind: "session";
      info: SessionInfo;
      status: SessionSyncStatus;
      claudeProjectDir?: string;
      conversationCwd?: string;
      subs?: TreeNode[];
    }
  /** 遠端備份過、本機還沒有對應資料夾的 Claude 專案；點一下建立映射。 */
  | {
      kind: "unmappedProject";
      project: ProjectRef;
      count: number;
      machines: string[];
    };
