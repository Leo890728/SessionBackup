/** 兩種工具共用的 session 檔讀取與標題快取。 */

import * as fs from "fs";

import type { SessionInfo } from "./types";

const FIRST_CHUNK = 262144;

export const titleCache = new Map<string, { mtime: number; size: number; info: SessionInfo }>();

export function clearSessionCache(): void {
  titleCache.clear();
}

export function fmt(ms: number): { date: string; time: string } {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}:${p(d.getMinutes())}`,
  };
}

export function cleanTitle(s: string): string {
  const t = s.replace(/^[#\s]+/, "").replace(/\s+/g, " ").trim();
  return t.length > 60 ? t.slice(0, 60) + "…" : t || "(無標題)";
}

export async function readFirstLines(file: string): Promise<any[]> {
  let fd: fs.promises.FileHandle | undefined;
  try {
    fd = await fs.promises.open(file, "r");
    const buf = Buffer.alloc(FIRST_CHUNK);
    const { bytesRead } = await fd.read(buf, 0, FIRST_CHUNK, 0);
    const lines = buf.subarray(0, bytesRead).toString("utf8").split("\n");
    if (bytesRead === FIRST_CHUNK) {
      lines.pop(); // 最後一行可能被截斷
    }
    return lines
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return undefined;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  } finally {
    await fd?.close();
  }
}

export async function readAllLines(file: string): Promise<any[]> {
  try {
    const text = await fs.promises.readFile(file, "utf8");
    return text
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return undefined;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/* ---------- Claude ---------- */
