import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { localizeCodexText, materializeCodexRevision, readCodexMetaCwd } from "./codexLocalize";
import { classifyJsonlText } from "./sessionStore";

const meta = (cwd: string) =>
  JSON.stringify({
    timestamp: "2026-07-15T00:00:00Z",
    type: "session_meta",
    payload: {
      session_id: "t1",
      id: "t1",
      cwd,
      originator: "codex_vscode",
      model_provider: "openai",
    },
  });
const turn = (cwd: string, id: string) =>
  JSON.stringify({
    type: "turn_context",
    payload: { turn_id: id, cwd, workspace_roots: [cwd], approval_policy: "on-request" },
  });
const msg = (text: string) =>
  JSON.stringify({ type: "response_item", payload: { type: "message", content: [{ text }] } });

describe("跨機 cwd 正規化比對", () => {
  it("只差 cwd 的兩份內容視為相同", () => {
    const a = [meta("C:\\Users\\a\\GIS"), turn("C:\\Users\\a\\GIS", "1"), msg("hi")].join("\n");
    const b = [meta("D:\\work\\GIS"), turn("D:\\work\\GIS", "1"), msg("hi")].join("\n");
    assert.equal(classifyJsonlText(a, b), "same");
  });

  it("另一台機器的接續（cwd 不同）判為延伸而非分叉", () => {
    const a = [meta("C:\\p"), msg("hi")].join("\n");
    const b = [meta("D:\\p"), msg("hi"), turn("D:\\p", "2"), msg("more")].join("\n");
    assert.equal(classifyJsonlText(a, b), "remote-newer");
  });

  it("內容真的分歧仍是衝突", () => {
    const a = [meta("C:\\p"), msg("hi"), msg("local")].join("\n");
    const b = [meta("D:\\p"), msg("hi"), msg("remote")].join("\n");
    assert.equal(classifyJsonlText(a, b), "conflict");
  });
});

describe("localizeCodexText", () => {
  it("改寫 session_meta 的 cwd 並保留其他內容", () => {
    const original = [meta("C:\\Users\\a\\GIS"), msg("hi")].join("\n");
    const { text, changed } = localizeCodexText(original, "D:\\work\\GIS");
    assert.equal(changed, true);
    const first = JSON.parse(text.split("\n")[0]);
    assert.equal(first.payload.cwd, "D:\\work\\GIS");
    assert.equal(first.payload.session_id, "t1");
    assert.equal(text.split("\n")[1], msg("hi"));
  });

  it("cwd 已一致時不動檔案", () => {
    const original = meta("D:\\work\\GIS");
    assert.equal(localizeCodexText(original, "D:\\work\\GIS").changed, false);
  });
});

describe("materializeCodexRevision + readCodexMetaCwd", () => {
  it("匯入時本地化、之後可讀回本機 cwd", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "localize-"));
    const source = path.join(dir, "store.jsonl");
    const target = path.join(dir, "sessions", "rollout.jsonl");
    try {
      await fs.promises.writeFile(source, [meta("C:\\other\\pc"), msg("hi")].join("\n") + "\n");
      await materializeCodexRevision(source, target, "D:\\local\\proj");
      assert.equal(await readCodexMetaCwd(target), "D:\\local\\proj");
      // 不給 cwd 時為單純複製
      const plain = path.join(dir, "plain.jsonl");
      await materializeCodexRevision(source, plain, undefined);
      assert.equal(await readCodexMetaCwd(plain), "C:\\other\\pc");
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("舊格式 model_provider 修復", () => {
  const { normalizeCodexMeta } = require("./codexLocalize") as typeof import("./codexLocalize");
  const oldMeta = JSON.stringify({
    type: "session_meta",
    payload: { id: "t1", cwd: "C:\\p", cli_version: "0.35.0" },
  });

  it("補上缺失的 model_provider", () => {
    const { text, changed } = normalizeCodexMeta(oldMeta);
    assert.equal(changed, true);
    assert.equal(JSON.parse(text).payload.model_provider, "openai");
  });

  it("空字串也視為缺失", () => {
    const empty = JSON.stringify({ type: "session_meta", payload: { id: "t1", model_provider: "" } });
    const { text } = normalizeCodexMeta(empty);
    assert.equal(JSON.parse(text).payload.model_provider, "openai");
  });

  it("已有 provider 且 cwd 一致時不動檔案", () => {
    const modern = JSON.stringify({ type: "session_meta", payload: { id: "t1", cwd: "C:\\p", model_provider: "openai" } });
    assert.equal(normalizeCodexMeta(modern, "C:\\p").changed, false);
  });

  it("修復前後的內容在同步比對中視為相同", () => {
    const repaired = normalizeCodexMeta(oldMeta).text;
    assert.equal(classifyJsonlText(oldMeta, repaired), "same");
  });
});
