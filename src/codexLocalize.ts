import * as fs from "fs";
import * as path from "path";

/**
 * Codex 的 session_meta.payload.cwd 是「機器本地」屬性：
 * 匯入其他電腦的 rollout 檔時改寫成本機專案路徑，更新既有檔案時保留本機原值，
 * 讓 Codex 在不同槽/路徑的電腦上仍能以工作目錄列出這個 session。
 */

const HEAD_LINES = 50;

/** 讀取 rollout 檔開頭 session_meta 的 cwd（找不到回傳 undefined）。 */
export async function readCodexMetaCwd(file: string): Promise<string | undefined> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(file, "r");
    const buffer = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/);
    for (const line of lines.slice(0, HEAD_LINES)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const value = JSON.parse(line);
        if (value?.type === "session_meta" && typeof value.payload?.cwd === "string") {
          return value.payload.cwd;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
  return undefined;
}

/** 舊版 Codex（約 cli 0.4x 以前）的 session_meta 沒有 model_provider，
 *  新版恢復對話時會報「Model provider `` not found」。當年只有 openai，補上即可。 */
export const DEFAULT_MODEL_PROVIDER = "openai";

/**
 * 正規化 rollout 檔開頭的 session_meta：
 * - localCwd 有值時改寫 cwd（跨機本地化）
 * - model_provider 缺失/空字串時補上預設值（舊格式修復）
 */
export function normalizeCodexMeta(
  text: string,
  localCwd?: string
): { text: string; changed: boolean } {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length && i < HEAD_LINES; i++) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }
    try {
      const value = JSON.parse(line);
      if (value?.type === "session_meta" && value.payload && typeof value.payload === "object") {
        const payload: Record<string, unknown> = { ...value.payload };
        let changed = false;
        if (localCwd && payload.cwd !== localCwd) {
          payload.cwd = localCwd;
          changed = true;
        }
        if (typeof payload.model_provider !== "string" || !payload.model_provider) {
          payload.model_provider = DEFAULT_MODEL_PROVIDER;
          changed = true;
        }
        if (!changed) {
          return { text, changed: false };
        }
        lines[i] = JSON.stringify({ ...value, payload });
        return { text: lines.join("\n"), changed: true };
      }
    } catch {
      continue;
    }
  }
  return { text, changed: false };
}

/** 相容舊名稱：只做 cwd 本地化。 */
export function localizeCodexText(
  text: string,
  localCwd: string
): { text: string; changed: boolean } {
  return normalizeCodexMeta(text, localCwd);
}

/** 把 store 的 revision 寫到本機位置：本地化 cwd（可選）並修復舊格式 meta。 */
export async function materializeCodexRevision(
  sourceFile: string,
  targetFile: string,
  localCwd: string | undefined
): Promise<void> {
  await fs.promises.mkdir(path.dirname(targetFile), { recursive: true });
  const text = await fs.promises.readFile(sourceFile, "utf8");
  const { text: normalized } = normalizeCodexMeta(text, localCwd);
  await fs.promises.writeFile(targetFile, normalized, "utf8");
}
