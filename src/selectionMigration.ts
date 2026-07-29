import { applySessionRules, SelectionTarget } from "./selection";
import { MachineManifest } from "./sessionStore";
import { Tool } from "./sessions";

const TOOLS: Tool[] = ["claude", "codex"];

/** 0.2.x 的忽略清單 key（"tool:sessionId"）。 */
export function parseLegacyIgnoreKey(key: string): SelectionTarget | undefined {
  const index = key.indexOf(":");
  if (index <= 0) {
    return undefined;
  }
  const tool = key.slice(0, index) as Tool;
  const id = key.slice(index + 1).trim();
  return TOOLS.includes(tool) && id ? { tool, id } : undefined;
}

/**
 * 從「全部備份 + 忽略清單」升級到白名單時的初始選取：
 * 已經備份過（存在於本機 manifest）的 session 維持選取，之後新增的對話則要自己勾。
 * 舊的忽略項目本來就不在 manifest 裡，這裡再排除一次只是保險。
 */
export function initialSelectionKeys(
  manifest: MachineManifest | undefined,
  legacyIgnored: readonly string[] = []
): string[] {
  const backedUp: SelectionTarget[] = (manifest?.sessions ?? []).map((session) => ({
    tool: session.tool,
    id: session.id,
  }));
  const ignored = legacyIgnored
    .map(parseLegacyIgnoreKey)
    .filter((target): target is SelectionTarget => Boolean(target));
  return applySessionRules(applySessionRules([], backedUp, true), ignored, false);
}
