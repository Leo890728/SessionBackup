import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { safeSegment } from "./sessionStore";

/**
 * machineId 是共享備份庫的目錄名（machines/<id>/），必須跨機唯一且跨重啟穩定。
 * 主機名稱可能撞名（家裡與公司都叫 DESKTOP-PC），所以補上 VS Code 安裝識別碼
 * 的短雜湊；hostname 留在前面是為了讓人看得出是哪台。
 *
 * 刻意不用 MAC：虛擬網卡與 Wi-Fi 隨機硬體位址讓「挑哪張網卡」沒有穩定答案，
 * 而且 machineId 會進 commit message 與 git 歷史，硬體識別碼放進去拿不掉。
 */
export function deriveMachineId(hostname: string, installationId: string): string {
  const base = safeSegment(hostname);
  if (!installationId) {
    return base;
  }
  const suffix = createHash("sha256")
    .update(installationId, "utf8")
    .digest("hex")
    .slice(0, 6);
  return `${base}-${suffix}`;
}

export type MigrationResult = "none" | "renamed" | "blocked";

/**
 * machineId 換了以後把舊的 machines/<old>/ 改名成 machines/<new>/。
 * 不搬的話備份庫是 no-delete 政策，舊 manifest 會永久留著，而且下次同步會把
 * 「過去的自己」當成另一台電腦，那些 session 全部變成同步候選。
 *
 * 目標目錄已存在時不動作（回傳 blocked）：那代表新 id 已經有資料，
 * 覆寫會弄掉另一台電腦或先前遷移的結果。
 */
export async function migrateMachineDirectory(
  repoPath: string,
  oldId: string | undefined,
  newId: string
): Promise<MigrationResult> {
  if (!oldId || oldId === newId) {
    return "none";
  }
  const machines = path.join(repoPath, "machines");
  const oldDir = path.join(machines, safeSegment(oldId));
  const newDir = path.join(machines, safeSegment(newId));
  if (!fs.existsSync(oldDir)) {
    return "none";
  }
  if (fs.existsSync(newDir)) {
    return "blocked";
  }
  await fs.promises.mkdir(machines, { recursive: true });
  await fs.promises.rename(oldDir, newDir);
  // manifest 內的 machineId 欄位是 runSync 過濾「自己」的依據，一併更新，
  // 否則下次同步前這份 manifest 會被當成別台電腦的。
  await rewriteManifestMachineId(path.join(newDir, "manifest.json"), newId);
  return "renamed";
}

async function rewriteManifestMachineId(file: string, machineId: string): Promise<void> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || parsed.machineId === machineId) {
      return;
    }
    parsed.machineId = machineId;
    await fs.promises.writeFile(file, JSON.stringify(parsed, null, 2) + "\n", "utf8");
  } catch {
    /* manifest 缺失或壞掉：下次備份會重新寫出正確內容 */
  }
}

interface IdentityRecord {
  /** 最後一次實際用來備份的 id，用來偵測換名並觸發遷移。 */
  lastUsed?: string;
}

/**
 * 記住上次使用的 machineId（extension globalStorage，不進備份庫）。
 * 刻意不存在 settings：sessionBackup.machineId 是 machine-scoped 設定，
 * 存進 settings 會被 Settings Sync 帶到另一台電腦，反而保證撞名。
 */
export class MachineIdentityStore {
  private readonly file: string;

  constructor(globalStoragePath: string) {
    this.file = path.join(globalStoragePath, "machine-id.json");
  }

  async lastUsed(): Promise<string | undefined> {
    try {
      const parsed: IdentityRecord = JSON.parse(await fs.promises.readFile(this.file, "utf8"));
      return typeof parsed?.lastUsed === "string" && parsed.lastUsed
        ? parsed.lastUsed
        : undefined;
    } catch {
      return undefined;
    }
  }

  async remember(machineId: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    const record: IdentityRecord = { lastUsed: machineId };
    await fs.promises.writeFile(this.file, JSON.stringify(record, null, 2) + "\n", "utf8");
  }
}

/**
 * 從還沒有 machine-id.json 的舊版升級時，globalStorage 沒有 lastUsed 可比，
 * 舊的 machines/<主機名稱>/ 會變成孤兒。這裡用「舊版預設值」（純主機名稱）
 * 回推一次，讓第一次升級也搬得動。
 */
export function detectLegacyMachineId(
  repoPath: string,
  legacyId: string | undefined,
  machineId: string
): string | undefined {
  if (!legacyId || legacyId === machineId) {
    return undefined;
  }
  const dir = path.join(repoPath, "machines", safeSegment(legacyId));
  return fs.existsSync(dir) ? legacyId : undefined;
}

/** 遷移舊目錄並記下目前的 id；回傳結果供記錄輸出。 */
export async function applyMachineIdentity(
  store: MachineIdentityStore,
  repoPath: string,
  machineId: string,
  legacyId?: string
): Promise<{ result: MigrationResult; from?: string }> {
  const previous =
    (await store.lastUsed()) ?? detectLegacyMachineId(repoPath, legacyId, machineId);
  const result = await migrateMachineDirectory(repoPath, previous, machineId);
  if (result !== "blocked") {
    await store.remember(machineId);
  }
  return { result, from: previous };
}
