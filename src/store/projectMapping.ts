import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  detectProject,
  encodeClaudeProjectDir,
  fallbackProject,
  isGitIdentity,
} from "./projectIdentity";
import type { ProjectRef } from "./sessionStore";

export interface LocalProjectMapping extends ProjectRef {
  localPath: string;
  claudeProjectDir: string;
  updatedAt: string;
}

interface MappingData {
  version: 1;
  mappings: LocalProjectMapping[];
}

export class ProjectMappingRegistry {
  private readonly file: string;
  private data: MappingData | undefined;
  /**
   * 這次執行已經試過升級的路徑。身分是逐 session 查的，沒有這層擋著，
   * 每個還沒有 git 身分的專案都會在每次備份多開幾十次 git 子程序。
   */
  private readonly upgradeTried = new Set<string>();

  constructor(globalStoragePath: string) {
    this.file = path.join(globalStoragePath, "project-mappings.json");
  }

  get storagePath(): string {
    return this.file;
  }

  /** 只讀既有 bucket 對應，供 Sessions 側欄顯示本機專案；不做 git 偵測或寫入。 */
  async mappedPathForClaudeProject(
    claudeProjectDir: string
  ): Promise<string | undefined> {
    await this.load();
    return this.data!.mappings.find(
      (mapping) => mapping.claudeProjectDir.toLowerCase() === claudeProjectDir.toLowerCase()
    )?.localPath;
  }

  /** 檔案被外部刪除（除錯命令清資料）後丟掉記憶體快取，否則下次寫入會把舊資料寫回去。 */
  reset(): void {
    this.data = undefined;
    this.upgradeTried.clear();
  }

  async identifyLocalProject(
    cwd: string | undefined,
    claudeProjectDir: string
  ): Promise<ProjectRef | undefined> {
    await this.load();
    const byBucket = this.data!.mappings.find(
      (mapping) => mapping.claudeProjectDir.toLowerCase() === claudeProjectDir.toLowerCase()
    );
    if (byBucket) {
      return (await this.upgradeIdentity(byBucket)) ?? publicRef(byBucket);
    }
    const candidatePath = cwd && path.isAbsolute(cwd) ? path.resolve(cwd) : undefined;
    if (!candidatePath) {
      return undefined;
    }
    const detected = await detectProject(candidatePath);
    const project = detected ?? fallbackProject(candidatePath);
    await this.remember(project, candidatePath, claudeProjectDir);
    return project;
  }

  /**
   * 以工作目錄辨識專案（codex 用）：路徑已有映射就直接回傳，
   * 否則對「存在的本機路徑」做 git 偵測並記住。其他電腦的路徑回傳 undefined。
   */
  async identifyByCwd(cwd: string | undefined): Promise<ProjectRef | undefined> {
    if (!cwd || !path.isAbsolute(cwd)) {
      return undefined;
    }
    const resolved = path.resolve(cwd);
    await this.load();
    const byPath = this.data!.mappings.find(
      (mapping) => path.resolve(mapping.localPath).toLowerCase() === resolved.toLowerCase()
    );
    if (byPath) {
      return (await this.upgradeIdentity(byPath)) ?? publicRef(byPath);
    }
    if (!fs.existsSync(resolved)) {
      return undefined;
    }
    const detected = await detectProject(resolved);
    const project = detected ?? fallbackProject(resolved);
    await this.remember(project, resolved, encodeClaudeProjectDir(resolved));
    return project;
  }

  /**
   * 已記住的專案若還是路徑雜湊身分，再偵測一次 git。
   *
   * 身分是第一次見到專案時定下來的，之後每次備份都直接沿用；所以「當時還沒 git init
   * 或還沒加 remote」的專案會永遠停在只有這台電腦認得的 local- 身分，換一台電腦
   * 必然對不上，只能手動對應。資料夾還在就重試，成功即改寫成 git 身分。
   */
  private async upgradeIdentity(
    mapping: LocalProjectMapping
  ): Promise<ProjectRef | undefined> {
    const key = path.resolve(mapping.localPath).toLowerCase();
    if (isGitIdentity(mapping.id) || this.upgradeTried.has(key)) {
      return undefined;
    }
    this.upgradeTried.add(key);
    if (!fs.existsSync(mapping.localPath)) {
      return undefined;
    }
    const detected = await detectProject(mapping.localPath);
    if (!detected) {
      return undefined;
    }
    await this.remember(detected, mapping.localPath, mapping.claudeProjectDir);
    return detected;
  }

  /**
   * 本機解不解得出這個專案的位置。刻意走 locateProject 的非互動路徑，
   * 側欄標成「待對應」的才會剛好是同步會跳過的那些。
   */
  async isMapped(project: ProjectRef): Promise<boolean> {
    return (await this.locateProject(project, false)) !== undefined;
  }

  async locateProject(
    project: ProjectRef,
    interactive = true
  ): Promise<LocalProjectMapping | undefined> {
    await this.load();
    const saved = this.data!.mappings.find((mapping) => mapping.id === project.id);
    if (saved && fs.existsSync(saved.localPath)) {
      return saved;
    }

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const detected = await detectProject(folder.uri.fsPath);
      if (detected?.id === project.id) {
        return this.remember(project, folder.uri.fsPath, encodeClaudeProjectDir(folder.uri.fsPath));
      }
      if (
        detected?.gitRemoteHash &&
        project.gitRemoteHash === detected.gitRemoteHash &&
        project.workspaceRelativePath
      ) {
        const currentParts =
          detected.workspaceRelativePath && detected.workspaceRelativePath !== "."
            ? detected.workspaceRelativePath.split("/")
            : [];
        const gitRoot = path.resolve(
          folder.uri.fsPath,
          ...currentParts.map(() => "..")
        );
        const candidatePath =
          project.workspaceRelativePath === "."
            ? gitRoot
            : path.join(gitRoot, ...project.workspaceRelativePath.split("/"));
        const candidate = await detectProject(candidatePath);
        if (candidate?.id === project.id) {
          return this.remember(project, candidatePath, encodeClaudeProjectDir(candidatePath));
        }
      }
    }

    if (!interactive) {
      // 自動同步時不打擾使用者；下次手動同步再詢問。
      return undefined;
    }
    const choice = await vscode.window.showWarningMessage(
      `找不到 Claude 專案「${project.displayName}」在此電腦的位置。`,
      { modal: true, detail: "請重新定位本機專案；絕對路徑只會保存在這台電腦。" },
      "使用目前工作區",
      "選擇本機資料夾",
      "跳過"
    );
    if (!choice || choice === "跳過") {
      return undefined;
    }
    let selected: string | undefined;
    if (choice === "使用目前工作區") {
      selected = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!selected) {
        vscode.window.showWarningMessage("目前沒有開啟的工作區，請改用「選擇本機資料夾」。");
        return undefined;
      }
    } else {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        title: `重新定位 ${project.displayName}`,
        openLabel: "使用此專案資料夾",
      });
      selected = picked?.[0]?.fsPath;
    }
    if (!selected) {
      return undefined;
    }
    const detected = await detectProject(selected);
    if (
      project.gitRemoteHash &&
      (project.gitRemoteHash !== detected?.gitRemoteHash ||
        (project.workspaceRelativePath &&
          detected?.workspaceRelativePath !== project.workspaceRelativePath))
    ) {
      const confirm = await vscode.window.showWarningMessage(
        "選取資料夾的 Git remote 與來源專案不同。",
        { modal: true, detail: `來源：${project.displayName}\n選擇：${selected}` },
        "仍然使用",
        "取消"
      );
      if (confirm !== "仍然使用") {
        return undefined;
      }
    }
    return this.remember(project, selected, encodeClaudeProjectDir(selected));
  }

  async manage(): Promise<void> {
    await this.load();
    if (!this.data!.mappings.length) {
      vscode.window.showInformationMessage("Session Backup: 尚未記錄 Claude 專案對應。");
      return;
    }
    const picked = await vscode.window.showQuickPick(
      this.data!.mappings.map((mapping) => ({
        label: mapping.displayName,
        description: mapping.localPath,
        detail: mapping.id,
        mapping,
      })),
      { placeHolder: "選擇要管理的 Claude 專案對應" }
    );
    if (!picked) {
      return;
    }
    const action = await vscode.window.showQuickPick(
      ["重新定位", "在檔案總管開啟", "移除對應"],
      { placeHolder: `${picked.label}：選擇操作` }
    );
    if (action === "在檔案總管開啟") {
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(picked.mapping.localPath));
    } else if (action === "移除對應") {
      this.data!.mappings = this.data!.mappings.filter(
        (mapping) => mapping.id !== picked.mapping.id
      );
      await this.save();
    } else if (action === "重新定位") {
      const selected = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        defaultUri: vscode.Uri.file(picked.mapping.localPath),
        title: `重新定位 ${picked.label}`,
        openLabel: "使用此專案資料夾",
      });
      const localPath = selected?.[0]?.fsPath;
      if (localPath) {
        await this.remember(publicRef(picked.mapping), localPath, encodeClaudeProjectDir(localPath));
      }
    }
  }

  private async remember(
    project: ProjectRef,
    localPath: string,
    claudeProjectDir: string
  ): Promise<LocalProjectMapping> {
    await this.load();
    const mapping: LocalProjectMapping = {
      ...project,
      localPath: path.resolve(localPath),
      claudeProjectDir,
      updatedAt: new Date().toISOString(),
    };
    this.data!.mappings = this.data!.mappings.filter(
      (item) => item.id !== project.id && item.claudeProjectDir !== claudeProjectDir
    );
    this.data!.mappings.push(mapping);
    await this.save();
    return mapping;
  }

  private async load(): Promise<void> {
    if (this.data) {
      return;
    }
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.file, "utf8")) as MappingData;
      this.data = parsed.version === 1 && Array.isArray(parsed.mappings)
        ? parsed
        : { version: 1, mappings: [] };
    } catch {
      this.data = { version: 1, mappings: [] };
    }
  }

  private async save(): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    await fs.promises.writeFile(this.file, JSON.stringify(this.data, null, 2) + "\n", "utf8");
  }
}

function publicRef(mapping: LocalProjectMapping): ProjectRef {
  return {
    id: mapping.id,
    displayName: mapping.displayName,
    gitRemoteHash: mapping.gitRemoteHash,
    workspaceRelativePath: mapping.workspaceRelativePath,
  };
}
