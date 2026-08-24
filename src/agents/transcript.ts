/** 對話讀取的共同入口：依工具分派解析，並匯出 Markdown。 */

import { parseClaudeTranscript } from "./claude";
import { parseCodexTranscript } from "./codex";
import { cleanTitle, readAllLines } from "./sessionFile";
import type { Tool, Transcript } from "./types";

/**
 * 把 JSONL 轉成訊息串，預覽與 Markdown 匯出共用同一份解析結果。
 * 連續的同角色內容會併成一則訊息：工具呼叫因此留在觸發它的那次回覆裡，
 * 而不是變成一則獨立訊息。
 */
export async function readTranscript(tool: Tool, file: string): Promise<Transcript> {
  const lines = await readAllLines(file);
  const parsed =
    tool === "claude"
      ? parseClaudeTranscript(lines)
      : await parseCodexTranscript(lines, file);
  return {
    tool,
    file,
    title: cleanTitle(parsed.title),
    cwd: parsed.cwd,
    messages: parsed.messages,
  };
}

export async function renderSessionMarkdown(tool: Tool, file: string): Promise<string> {
  const transcript = await readTranscript(tool, file);
  const parts: string[] = [];
  for (const message of transcript.messages) {
    const body: string[] = [];
    const tools: string[] = [];
    for (const block of message.blocks) {
      if (block.kind === "text") {
        body.push(block.text);
      } else if (block.kind === "thinking") {
        body.push(`> 💭 ${block.text.replace(/\n/g, "\n> ")}`);
      } else if (block.kind === "context") {
        body.push(`> 📄 ${block.label}：\`${block.detail}\``);
      } else if (block.kind === "work") {
        for (const item of block.items) {
          if (item.kind === "text" || item.kind === "thinking") {
            body.push(`> ${item.text.replace(/\n/g, "\n> ")}`);
          } else if (item.kind === "tool") {
            tools.push(item.detail ? `${item.name}：\`${item.detail}\`` : item.name);
          }
        }
      } else {
        tools.push(block.detail ? `${block.name}：\`${block.detail}\`` : block.name);
      }
    }
    if (tools.length) {
      body.push(`> 🔧 ${tools.join("、")}`);
    }
    const text = body.join("\n\n").trim();
    if (!text) {
      continue;
    }
    if (message.role === "notice") {
      parts.push(`_${text}_`);
    } else {
      parts.push(`## ${message.role === "user" ? "👤 User" : "🤖 Assistant"}\n\n${text}`);
    }
  }

  const header =
    `# ${transcript.title}\n\n` +
    `- 工具：${tool === "claude" ? "Claude Code" : "Codex"}\n` +
    (transcript.cwd ? `- 工作目錄：\`${transcript.cwd}\`\n` : "") +
    `- 原始檔：\`${file}\`\n`;
  return header + "\n---\n\n" + parts.join("\n\n---\n\n") + "\n";
}
