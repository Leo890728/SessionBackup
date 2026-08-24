import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  conversationOpenTarget,
  queueClaudeConversationHandoff,
  sameConversationWorkspace,
  takeClaudeConversationHandoff,
} from "./sessionConversation";

describe("conversationOpenTarget", () => {
  it("opens Claude Code with the session id command argument", () => {
    assert.deepEqual(conversationOpenTarget("claude", " claude-session "), {
      kind: "command",
      extensionId: "anthropic.claude-code",
      toolName: "Claude Code",
      command: "claude-vscode.primaryEditor.open",
      args: ["claude-session"],
    });
  });

  it("uses the Codex Chat Sessions resource for a local thread", () => {
    assert.deepEqual(conversationOpenTarget("codex", "codex-thread"), {
      kind: "resource",
      extensionId: "openai.chatgpt",
      toolName: "Codex",
      scheme: "openai-codex",
      authority: "route",
      path: "/local/codex-thread",
      viewType: "chatgpt.conversationEditor",
      fallbackPath: "/local/codex-thread",
    });
  });

  it("rejects a blank session id", () => {
    assert.throws(() => conversationOpenTarget("codex", "  "), /session ID/);
  });
});

describe("sameConversationWorkspace", () => {
  it("compares Windows paths case-insensitively", () => {
    assert.equal(
      sameConversationWorkspace(
        "C:\\Users\\User\\Project\\",
        "c:\\users\\user\\project",
        "win32",
      ),
      true,
    );
  });

  it("does not treat a different project as the same workspace", () => {
    assert.equal(
      sameConversationWorkspace("C:\\work\\one", "C:\\work\\two", "win32"),
      false,
    );
  });

  it("requires both project paths", () => {
    assert.equal(
      sameConversationWorkspace(undefined, "/work/project", "linux"),
      false,
    );
  });
});

describe("Claude conversation window handoff", () => {
  it("is claimed only by the matching project window", async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "session-handoff-"),
    );
    try {
      await queueClaudeConversationHandoff(
        root,
        " session-id ",
        "C:\\work\\project",
      );
      assert.equal(
        await takeClaudeConversationHandoff(root, "C:\\work\\other"),
        undefined,
      );
      assert.deepEqual(
        await takeClaudeConversationHandoff(root, "c:\\WORK\\project"),
        { sessionId: "session-id", cwd: "C:\\work\\project" },
      );
      assert.equal(
        await takeClaudeConversationHandoff(root, "C:\\work\\project"),
        undefined,
      );
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it("discards an expired handoff", async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "session-handoff-"),
    );
    try {
      await queueClaudeConversationHandoff(root, "session-id", "/work/project");
      assert.equal(
        await takeClaudeConversationHandoff(
          root,
          "/work/project",
          Date.now() + 3 * 60 * 1000,
        ),
        undefined,
      );
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});
