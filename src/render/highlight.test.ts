import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { highlightCode } from "./highlight";

/** 去掉 span 之後必須跟原文一字不差，上色不能吃掉或改寫任何字元。 */
const plain = (html: string) =>
  html
    .replace(/<span class="t[a-z]">/g, "")
    .replace(/<\/span>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

describe("highlightCode", () => {
  it("leaves an unknown language escaped but untouched", () => {
    const code = 'plain <b> & "text"';
    assert.equal(highlightCode(code, "text"), 'plain &lt;b&gt; &amp; &quot;text&quot;');
  });

  it("colours comments, strings, keywords and numbers", () => {
    const html = highlightCode('const a = 1; // 說明\nconst b = "x";', "ts");
    assert.ok(html.includes('<span class="tk">const</span>'));
    assert.ok(html.includes('<span class="tn">1</span>'));
    assert.ok(html.includes('<span class="tc">// 說明</span>'));
    assert.ok(html.includes('<span class="ts">&quot;x&quot;</span>'));
  });

  it("never loses characters", () => {
    for (const [code, lang] of [
      ['const s = "a<b>&c"; // 尾註', "ts"],
      ["def f(x):\n    return x  # 註解", "python"],
      ['echo "hi" # 說明\nls -la $HOME', "bash"],
      ['Get-ChildItem -Path $env:TEMP  # 說明', "powershell"],
      ['{"a": 1, "b": [true, null]}', "json"],
      ["key: value # 說明\nlist:\n  - 1", "yaml"],
      ["SELECT * FROM t WHERE a = 'x' -- 註解", "sql"],
    ] as const) {
      assert.equal(plain(highlightCode(code, lang)), code, `${lang} 的內容被改動了`);
    }
  });

  it("marks json keys apart from string values", () => {
    const html = highlightCode('{"name": "值"}', "json");
    assert.ok(html.includes('<span class="tp">&quot;name&quot;</span>'));
    assert.ok(html.includes('<span class="ts">&quot;值&quot;</span>'));
  });

  it("keeps python triple-quoted strings in one piece", () => {
    const html = highlightCode('x = """一\n二"""', "python");
    assert.ok(html.includes('<span class="ts">&quot;&quot;&quot;一\n二&quot;&quot;&quot;</span>'));
  });

  it("colours diff lines by their marker", () => {
    const html = highlightCode("@@ -1 +1 @@\n-舊\n+新\n 不變", "diff");
    assert.ok(html.includes('<span class="tk">@@ -1 +1 @@</span>'));
    assert.ok(html.includes('<span class="tt">-舊</span>'));
    assert.ok(html.includes('<span class="ts">+新</span>'));
    assert.ok(html.includes("\n 不變"));
  });

  it("escapes markup inside a highlighted block", () => {
    const html = highlightCode('const x = "<script>";', "js");
    assert.equal(html.includes("<script>"), false);
    assert.ok(html.includes("&lt;script&gt;"));
  });
});
