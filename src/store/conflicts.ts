import * as fs from "fs";
import * as path from "path";
import { Tool } from "../agents/types";

/** 一筆尚未解決的分叉衝突：本機檔案與遠端 revision 從同一點分叉。 */
export interface ConflictRecord {
  /** fileKey(tool, relativePath)，同檔案只會有一筆 */
  key: string;
  tool: Tool;
  id: string;
  relativePath: string;
  localFile: string;
  localHash: string;
  remoteHash: string;
  remoteMachine: string;
  detectedAt: string;
  displayName: string;
}

/**
 * 衝突持久化（extension globalStorage，不進備份庫）。
 * 同步時整批覆寫（replaceAll），使用者解決單筆時移除（remove）。
 */
export class ConflictRegistry {
  private readonly file: string;
  private data: ConflictRecord[] | undefined;

  constructor(globalStoragePath: string) {
    this.file = path.join(globalStoragePath, "sync-conflicts.json");
  }

  private async load(): Promise<ConflictRecord[]> {
    if (!this.data) {
      try {
        const parsed = JSON.parse(await fs.promises.readFile(this.file, "utf8"));
        this.data = Array.isArray(parsed) ? parsed : [];
      } catch {
        this.data = [];
      }
    }
    return this.data;
  }

  private async save(): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    await fs.promises.writeFile(
      this.file,
      JSON.stringify(this.data ?? [], null, 2) + "\n",
      "utf8"
    );
  }

  get storagePath(): string {
    return this.file;
  }

  /** 檔案被外部刪除（除錯命令清資料）後丟掉記憶體快取，否則下次寫入會把舊資料寫回去。 */
  reset(): void {
    this.data = undefined;
  }

  async list(): Promise<ConflictRecord[]> {
    return [...(await this.load())];
  }

  /** 同步結束時以本次偵測到的完整清單取代（已消失的衝突自動清除）。 */
  async replaceAll(records: ConflictRecord[]): Promise<void> {
    await this.load();
    this.data = [...records];
    await this.save();
  }

  async remove(key: string): Promise<void> {
    const data = await this.load();
    const next = data.filter((record) => record.key !== key);
    if (next.length !== data.length) {
      this.data = next;
      await this.save();
    }
  }
}
