import type { Tool } from "../agents/types";

/**
 * 備份選取是「白名單」：沒有任何規則涵蓋的 session 不會被備份。
 *
 * 規則以字串 key 存在 sessionBackup.selectedSessions，分三層：
 *   tool:<tool>                 整個工具（之後新增的 session 也自動涵蓋）
 *   claudeProject:<projectDir>  單一 Claude 專案 bucket（同上）
 *   session:<tool>:<id>         單一 session（Codex 接續 thread 的多個 rollout 檔共用同一個 id）
 *
 * 前綴 "-" 代表排除，例如 -session:claude:abc。
 * 判定時「越具體的規則越優先」：session > claudeProject > tool，
 * 所以勾選整個專案後仍可單獨取消其中一個對話。
 */
export type SelectionLevel = "session" | "claudeProject" | "tool";

/**
 * 「部分選取」提示。VS Code 的 TreeItem checkbox 只有 Checked / Unchecked
 * （TreeItemCheckboxState 沒有 indeterminate，樹狀圖也不能套 CSS），
 * 所以子項目勾一半時只能寫在 description 與 tooltip 上，勾選框本身維持兩態。
 */
export function partialHint(selected: number, total: number): string | undefined {
  return selected > 0 && selected < total ? `部分選取 ${selected}/${total}` : undefined;
}

const LEVEL_ORDER: SelectionLevel[] = ["session", "claudeProject", "tool"];

export interface SelectionTarget {
  tool: Tool;
  /** 備份端使用的 session id（sessionStore 的 sessionMetadata 規則）。 */
  id: string;
  /** Claude 的 projects/<dir> bucket 名稱；Codex 與非 projects 來源為 undefined。 */
  claudeProjectDir?: string;
}

export function toolKey(tool: Tool): string {
  return `tool:${tool}`;
}

export function claudeProjectKey(projectDir: string): string {
  return `claudeProject:${projectDir}`;
}

export function sessionKey(tool: Tool, id: string): string {
  return `session:${tool}:${id}`;
}

export function excludeKey(key: string): string {
  return `-${key}`;
}

/** 把規則 key 轉成人類看得懂的描述（管理清單用）。 */
export function describeSelectionKey(key: string): string {
  const excluded = key.startsWith("-");
  const body = excluded ? key.slice(1) : key;
  const prefix = excluded ? "排除" : "備份";
  if (body.startsWith("tool:")) {
    const tool = body.slice("tool:".length);
    return `${prefix}：整個 ${tool === "claude" ? "Claude Code" : "Codex"}`;
  }
  if (body.startsWith("claudeProject:")) {
    return `${prefix}：Claude 專案 ${body.slice("claudeProject:".length)}`;
  }
  if (body.startsWith("session:")) {
    return `${prefix}：session ${body.slice("session:".length)}`;
  }
  return `${prefix}：${body}`;
}

function keyChain(target: SelectionTarget): { level: SelectionLevel; key: string }[] {
  const chain: { level: SelectionLevel; key: string }[] = [
    { level: "session", key: sessionKey(target.tool, target.id) },
  ];
  if (target.claudeProjectDir) {
    chain.push({
      level: "claudeProject",
      key: claudeProjectKey(target.claudeProjectDir),
    });
  }
  chain.push({ level: "tool", key: toolKey(target.tool) });
  return chain;
}

export class SelectionSet {
  private readonly keys: Set<string>;

  constructor(keys: Iterable<string> = []) {
    this.keys = new Set([...keys].map((key) => key.trim()).filter(Boolean));
  }

  get size(): number {
    return this.keys.size;
  }

  get isEmpty(): boolean {
    return this.keys.size === 0;
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  toArray(): string[] {
    return [...this.keys].sort();
  }

  /** 由具體到概括找出第一條符合的規則；undefined 代表沒有規則涵蓋（=不備份）。 */
  private resolve(
    target: SelectionTarget,
    from: SelectionLevel = "session"
  ): boolean | undefined {
    const start = LEVEL_ORDER.indexOf(from);
    for (const { level, key } of keyChain(target)) {
      if (LEVEL_ORDER.indexOf(level) < start) {
        continue;
      }
      if (this.keys.has(key)) {
        return true;
      }
      if (this.keys.has(excludeKey(key))) {
        return false;
      }
    }
    return undefined;
  }

  /** 這個 session 要不要備份。 */
  includes(target: SelectionTarget): boolean {
    return this.resolve(target) === true;
  }

  /** 使用者明確把它排除掉（同步時據此拒絕匯入遠端版本）。 */
  excludes(target: SelectionTarget): boolean {
    return this.resolve(target) === false;
  }

  /** 移除自身層級的規則後，是否仍被上層範圍涵蓋。 */
  coveredByScope(target: SelectionTarget, level: SelectionLevel): boolean {
    const next = LEVEL_ORDER[LEVEL_ORDER.indexOf(level) + 1];
    return next ? this.resolve(target, next) === true : false;
  }

  toolSelected(tool: Tool): boolean {
    return this.keys.has(toolKey(tool));
  }

  /**
   * 這個工具底下是否有比 tool 更細的規則。樹狀圖用來判斷「部分選取」：
   * 勾了整個工具時看有沒有排除規則，沒勾時看有沒有個別加選的規則。
   */
  hasNarrowerRule(tool: Tool, excluded: boolean): boolean {
    const prefixes = [`session:${tool}:`];
    if (tool === "claude") {
      prefixes.push("claudeProject:");
    }
    for (const key of this.keys) {
      if (key.startsWith("-") !== excluded) {
        continue;
      }
      const body = excluded ? key.slice(1) : key;
      if (prefixes.some((prefix) => body.startsWith(prefix))) {
        return true;
      }
    }
    return false;
  }

  claudeProjectSelected(projectDir: string): boolean {
    return (
      this.resolve({ tool: "claude", id: "", claudeProjectDir: projectDir }, "claudeProject") ===
      true
    );
  }
}

/**
 * 設定單一 key 的規則。selected=true 時，若上層範圍已涵蓋就不重複寫入；
 * selected=false 時，只有被上層範圍涵蓋才需要寫入排除規則，否則移掉自己的規則即可。
 */
export function applyRule(
  current: readonly string[],
  key: string,
  selected: boolean,
  coveredByScope: boolean
): string[] {
  const next = new Set(current);
  next.delete(key);
  next.delete(excludeKey(key));
  if (selected && !coveredByScope) {
    next.add(key);
  } else if (!selected && coveredByScope) {
    next.add(excludeKey(key));
  }
  return [...next].sort();
}

/** 套用一批 session 層級的變更（同步匯入、機密掃描批次取消選取用）。 */
export function applySessionRules(
  current: readonly string[],
  targets: readonly SelectionTarget[],
  selected: boolean
): string[] {
  let keys = [...current];
  for (const target of targets) {
    const selection = new SelectionSet(keys);
    keys = applyRule(
      keys,
      sessionKey(target.tool, target.id),
      selected,
      selection.coveredByScope(target, "session")
    );
  }
  return keys;
}

/**
 * 套用一個 UI 專案底下的複合規則：Claude 使用可涵蓋未來對話的 project scope，
 * Codex 則只能逐一套用目前已知 sessions。此函式不會建立 tool:* 全域規則。
 */
export function applyProjectGroupRules(
  current: readonly string[],
  claudeProjectDirs: readonly string[],
  sessionTargets: readonly SelectionTarget[],
  selected: boolean
): string[] {
  let next = [...current];
  for (const projectDir of new Set(claudeProjectDirs)) {
    const target: SelectionTarget = {
      tool: "claude",
      id: "",
      claudeProjectDir: projectDir,
    };
    next = applyRule(
      next,
      claudeProjectKey(projectDir),
      selected,
      new SelectionSet(next).coveredByScope(target, "claudeProject")
    );
  }

  const uniqueTargets = new Map<string, SelectionTarget>();
  for (const target of sessionTargets) {
    uniqueTargets.set(
      `${target.tool}:${target.id}:${target.claudeProjectDir ?? ""}`,
      target
    );
  }
  return applySessionRules(next, [...uniqueTargets.values()], selected);
}
