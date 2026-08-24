import * as fs from "fs";
import * as path from "path";
import type { Tool } from "../agents/sessions";

const CLAUDE_HANDOFF_FILE = "pending-claude-conversation.json";
const CLAUDE_HANDOFF_MAX_AGE_MS = 2 * 60 * 1000;

interface ClaudeConversationHandoff {
  version: 1;
  sessionId: string;
  cwd: string;
  createdAt: number;
}

export type ConversationOpenTarget =
  | {
      kind: "command";
      extensionId: string;
      toolName: string;
      command: string;
      args: readonly string[];
    }
  | {
      kind: "resource";
      extensionId: string;
      toolName: string;
      scheme: string;
      authority: string;
      path: string;
      viewType: string;
      fallbackPath: string;
    };

/**
 * 回到各 AI 擴充套件原生對話畫面的入口。
 *
 * Codex 使用它註冊到 VS Code Chat Sessions 的 resource；Claude Code 的公開 editor
 * command 則把 session id 當第一個參數。集中在這裡，第三方擴充套件改路由時比較好調整。
 */
export function conversationOpenTarget(
  tool: Tool,
  sessionId: string,
): ConversationOpenTarget {
  const id = sessionId.trim();
  if (!id) {
    throw new Error("缺少 session ID");
  }

  if (tool === "claude") {
    return {
      kind: "command",
      extensionId: "anthropic.claude-code",
      toolName: "Claude Code",
      command: "claude-vscode.primaryEditor.open",
      args: [id],
    };
  }

  const path = `/local/${id}`;
  return {
    kind: "resource",
    extensionId: "openai.chatgpt",
    toolName: "Codex",
    scheme: "openai-codex",
    authority: "route",
    path,
    viewType: "chatgpt.conversationEditor",
    fallbackPath: path,
  };
}

/** Claude Code 只會在第一個 workspace folder 所屬的 project bucket 尋找 session。 */
export function sameConversationWorkspace(
  targetCwd: string | undefined,
  workspaceCwd: string | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!targetCwd?.trim() || !workspaceCwd?.trim()) {
    return false;
  }

  const flavor = platform === "win32" ? path.win32 : path.posix;
  const normalize = (value: string): string => {
    const resolved = flavor.resolve(value.trim());
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(targetCwd) === normalize(workspaceCwd);
}

/** 在開啟專案新視窗前留下交棒資料；新視窗的 extension host 啟動後再領取。 */
export async function queueClaudeConversationHandoff(
  storageRoot: string,
  sessionId: string,
  cwd: string,
): Promise<void> {
  const handoff: ClaudeConversationHandoff = {
    version: 1,
    sessionId: sessionId.trim(),
    cwd: cwd.trim(),
    createdAt: Date.now(),
  };
  if (!handoff.sessionId || !handoff.cwd) {
    throw new Error("Claude session handoff 缺少 session ID 或專案路徑");
  }
  await fs.promises.mkdir(storageRoot, { recursive: true });
  await fs.promises.writeFile(
    path.join(storageRoot, CLAUDE_HANDOFF_FILE),
    JSON.stringify(handoff),
    "utf8",
  );
}

/** 只有工作目錄相符的新視窗能領取，避免其他已開啟的 VS Code 視窗誤接 session。 */
export async function takeClaudeConversationHandoff(
  storageRoot: string,
  workspaceCwd: string | undefined,
  now = Date.now(),
): Promise<{ sessionId: string; cwd: string } | undefined> {
  const file = path.join(storageRoot, CLAUDE_HANDOFF_FILE);
  let value: unknown;
  try {
    value = JSON.parse(await fs.promises.readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    await removeHandoff(file);
    return undefined;
  }

  if (
    !isClaudeHandoff(value) ||
    now - value.createdAt > CLAUDE_HANDOFF_MAX_AGE_MS
  ) {
    await removeHandoff(file);
    return undefined;
  }
  if (!sameConversationWorkspace(value.cwd, workspaceCwd)) {
    return undefined;
  }

  await removeHandoff(file);
  return { sessionId: value.sessionId, cwd: value.cwd };
}

function isClaudeHandoff(value: unknown): value is ClaudeConversationHandoff {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<ClaudeConversationHandoff>;
  return (
    candidate.version === 1 &&
    typeof candidate.sessionId === "string" &&
    Boolean(candidate.sessionId.trim()) &&
    typeof candidate.cwd === "string" &&
    Boolean(candidate.cwd.trim()) &&
    typeof candidate.createdAt === "number" &&
    Number.isFinite(candidate.createdAt)
  );
}

async function removeHandoff(file: string): Promise<void> {
  try {
    await fs.promises.unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}
