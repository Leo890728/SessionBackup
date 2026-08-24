import * as vscode from "vscode";
import { ConflictRegistry } from "../store/conflicts";
import { ProjectMappingRegistry } from "../store/projectMapping";
import { RepositoryTreeProvider } from "../ui/repositoryTree";
import { SessionTreeProvider } from "../ui/sessionTree";

/**
 * 命令處理器共用的相依，沿用 DebugDeps 既有的慣例：
 * 每組命令匯出一個 register 函式，回傳 disposables 由 activate() 收集。
 */
export interface CommandDeps {
  context: vscode.ExtensionContext;
  out: vscode.OutputChannel;
  projects: ProjectMappingRegistry;
  conflicts: ConflictRegistry;
  repository: RepositoryTreeProvider;
  tree: SessionTreeProvider;
  /** 手動備份：含進度視窗、狀態列與側欄更新。 */
  backupNow: () => Promise<void>;
}
