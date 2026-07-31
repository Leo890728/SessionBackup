import * as fs from "fs";
import * as path from "path";
import { Redaction, redactText, restoreText } from "./redact";
import { ACTIVE_WINDOW_MS, LocalSession, sha256File } from "./sessionStore";

export interface VaultEntry extends Redaction {
  /** 遮蔽當下的原始檔絕對路徑。 */
  file: string;
  redactedAt: string;
}

interface VaultData {
  version: 1;
  entries: VaultEntry[];
}

/**
 * 遮蔽掉的原文只存在這台電腦的 extension globalStorage。
 *
 * 刻意不加密也不進備份庫：原文本來就以明文躺在同一台機器的 ~/.claude 裡，
 * 本機多存一份不增加任何曝露面；而放進備份庫則等於把金鑰推上 GitHub，
 * 正是遮蔽要避免的事。也不走 Settings Sync。
 */
export class SecretVault {
  private readonly file: string;
  private data: VaultData | undefined;

  constructor(globalStoragePath: string) {
    this.file = path.join(globalStoragePath, "secret-vault.json");
  }

  get storagePath(): string {
    return this.file;
  }

  /** 檔案被外部刪除（除錯命令清資料）後丟掉記憶體快取，否則下次寫入會把舊資料寫回去。 */
  reset(): void {
    this.data = undefined;
  }

  async add(file: string, redactions: readonly Redaction[]): Promise<void> {
    await this.load();
    const at = new Date().toISOString();
    for (const redaction of redactions) {
      const existing = this.data!.entries.find(
        (entry) => entry.placeholder === redaction.placeholder && entry.file === file
      );
      if (existing) {
        continue;
      }
      this.data!.entries.push({ ...redaction, file, redactedAt: at });
    }
    await this.save();
  }

  async all(): Promise<VaultEntry[]> {
    await this.load();
    return [...this.data!.entries];
  }

  async forFile(file: string): Promise<VaultEntry[]> {
    const resolved = path.resolve(file).toLowerCase();
    return (await this.all()).filter(
      (entry) => path.resolve(entry.file).toLowerCase() === resolved
    );
  }

  async removeFile(file: string): Promise<void> {
    await this.load();
    const resolved = path.resolve(file).toLowerCase();
    this.data!.entries = this.data!.entries.filter(
      (entry) => path.resolve(entry.file).toLowerCase() !== resolved
    );
    await this.save();
  }

  private async load(): Promise<void> {
    if (this.data) {
      return;
    }
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.file, "utf8")) as VaultData;
      this.data =
        parsed.version === 1 && Array.isArray(parsed.entries)
          ? parsed
          : { version: 1, entries: [] };
    } catch {
      this.data = { version: 1, entries: [] };
    }
  }

  private async save(): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    await fs.promises.writeFile(
      this.file,
      JSON.stringify(this.data, null, 2) + "\n",
      "utf8"
    );
  }
}

export type RedactSkipReason = "active" | "changed" | "no-match" | "error";

export interface RedactOutcome {
  /** 已就地遮蔽，欄位（hash/size/mtime）已更新成新檔案的值。 */
  redacted: LocalSession[];
  skipped: { session: LocalSession; reason: RedactSkipReason; error?: string }[];
  /** 總共遮掉幾個不同的憑證。 */
  count: number;
}

/**
 * 就地遮蔽並回填 LocalSession 的統計值。
 *
 * 刻意改寫原始檔而不是「只存遮蔽版進 store」：後者會讓磁碟上的位元組與 store 裡的
 * 不一致，得同時改雜湊鏈、側欄的 mtime+size 判斷、以及合併層的逐行比對——
 * 而合併層一出錯就是跨機永久假衝突。改原始檔則這三處原樣運作。
 */
export async function redactSessions(
  sessions: readonly LocalSession[],
  vault: SecretVault,
  now: number = Date.now()
): Promise<RedactOutcome> {
  const outcome: RedactOutcome = { redacted: [], skipped: [], count: 0 };
  for (const session of sessions) {
    try {
      const stat = await fs.promises.stat(session.file);
      if (stat.mtimeMs !== session.mtimeMs || stat.size !== session.size) {
        // 收集之後又被寫入：這一輪的掃描結果已經不代表現在的內容。
        outcome.skipped.push({ session, reason: "changed" });
        continue;
      }
      if (now - stat.mtimeMs < ACTIVE_WINDOW_MS) {
        outcome.skipped.push({ session, reason: "active" });
        continue;
      }
      const original = await fs.promises.readFile(session.file, "utf8");
      const { text, redactions } = redactText(original);
      if (!redactions.length) {
        outcome.skipped.push({ session, reason: "no-match" });
        continue;
      }
      // 先寫進保險庫再動檔案：反過來的話中途失敗就再也還原不了。
      await vault.add(session.file, redactions);
      await writeAtomic(session.file, text);
      const after = await fs.promises.stat(session.file);
      outcome.redacted.push({
        ...session,
        mtimeMs: after.mtimeMs,
        size: after.size,
        hash: await sha256File(session.file),
      });
      outcome.count += redactions.length;
    } catch (e: any) {
      outcome.skipped.push({ session, reason: "error", error: e?.message ?? String(e) });
    }
  }
  return outcome;
}

/** 把某個檔案裡的 placeholder 換回原文（本機手動操作）。 */
export async function restoreSessionFile(
  file: string,
  vault: SecretVault
): Promise<number> {
  const entries = await vault.forFile(file);
  if (!entries.length) {
    return 0;
  }
  const current = await fs.promises.readFile(file, "utf8");
  const { text, restored } = restoreText(current, entries);
  if (restored) {
    await writeAtomic(file, text);
  }
  return restored;
}

/**
 * 先寫暫存檔再 rename：中途斷電或失敗時原檔仍然完整，
 * 不會留下寫到一半的 JSONL。副檔名刻意不是 .jsonl，免得被 walkJsonl 掃到。
 */
async function writeAtomic(file: string, text: string): Promise<void> {
  const temp = `${file}.sb-redact.tmp`;
  await fs.promises.writeFile(temp, text, "utf8");
  try {
    await fs.promises.rename(temp, file);
  } catch (e) {
    await fs.promises.rm(temp, { force: true });
    throw e;
  }
}
