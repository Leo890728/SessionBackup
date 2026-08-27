import * as fs from "fs";
import * as path from "path";

export interface CodexIndexEntry {
  id: string;
  thread_name: string;
  updated_at?: string;
}

export async function readCodexSessionIndex(
  indexFile: string
): Promise<Map<string, CodexIndexEntry>> {
  const entries = new Map<string, CodexIndexEntry>();
  let text: string;
  try {
    text = await fs.promises.readFile(indexFile, "utf8");
  } catch {
    return entries;
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const value = JSON.parse(line);
      if (
        typeof value?.id === "string" &&
        typeof value?.thread_name === "string" &&
        value.thread_name.trim()
      ) {
        entries.set(value.id, {
          id: value.id,
          thread_name: value.thread_name.trim(),
          updated_at: typeof value.updated_at === "string" ? value.updated_at : undefined,
        });
      }
    } catch {
      // 忽略損壞的索引行，其他 session 仍可顯示。
    }
  }
  return entries;
}

export async function upsertCodexSessionTitle(
  indexFile: string,
  id: string,
  title: string,
  updatedAt?: string
): Promise<boolean> {
  const normalized = title.trim();
  if (!id || !normalized) {
    return false;
  }

  let text = "";
  try {
    text = await fs.promises.readFile(indexFile, "utf8");
  } catch {
    // 尚未建立索引時，從空索引開始。
  }
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  let found = false;
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    try {
      const value = JSON.parse(lines[i]);
      if (value?.id !== id) {
        continue;
      }
      found = true;
      if (value.thread_name !== normalized) {
        // 標題以 updated_at 新者勝：本機標題較新（或一樣新）時不覆蓋。
        const existingAt =
          typeof value.updated_at === "string" ? Date.parse(value.updated_at) : NaN;
        const incomingAt = updatedAt ? Date.parse(updatedAt) : NaN;
        if (
          !Number.isNaN(existingAt) &&
          !Number.isNaN(incomingAt) &&
          existingAt >= incomingAt
        ) {
          continue;
        }
        value.thread_name = normalized;
        value.updated_at = updatedAt ?? new Date().toISOString();
        lines[i] = JSON.stringify(value);
        changed = true;
      }
    } catch {
      // 原樣保留無法解析的行。
    }
  }
  if (!found) {
    lines.push(
      JSON.stringify({
        id,
        thread_name: normalized,
        updated_at: updatedAt ?? new Date().toISOString(),
      })
    );
    changed = true;
  }
  if (!changed) {
    return false;
  }

  await writeIndex(indexFile, lines);
  return true;
}

/**
 * 從索引移掉這些 thread 的標題。
 *
 * 對話檔被搬出 ~/.codex/sessions 之後索引還留著標題的話，Codex 自己會列出一則
 * 打不開的對話。呼叫端要確定這個 id 底下已經沒有本機檔案——同一個 thread 可能
 * 有多個 rollout 檔（resume／子代理），只搬走其中一個時標題還得留著。
 */
export async function removeCodexSessionTitles(
  indexFile: string,
  ids: ReadonlySet<string>
): Promise<number> {
  if (!ids.size) {
    return 0;
  }
  let text: string;
  try {
    text = await fs.promises.readFile(indexFile, "utf8");
  } catch {
    return 0;
  }
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  const kept = lines.filter((line) => {
    try {
      return !ids.has(JSON.parse(line)?.id);
    } catch {
      // 原樣保留無法解析的行。
      return true;
    }
  });
  const removed = lines.length - kept.length;
  if (removed) {
    await writeIndex(indexFile, kept);
  }
  return removed;
}

/** 先寫暫存檔再 rename：Codex 可能正在讀這個索引。 */
async function writeIndex(indexFile: string, lines: string[]): Promise<void> {
  await fs.promises.mkdir(path.dirname(indexFile), { recursive: true });
  const content = lines.join("\n") + "\n";
  const temporary = `${indexFile}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(temporary, content, "utf8");
  try {
    await fs.promises.rename(temporary, indexFile);
  } catch {
    await fs.promises.writeFile(indexFile, content, "utf8");
    await fs.promises.rm(temporary, { force: true });
  }
}
