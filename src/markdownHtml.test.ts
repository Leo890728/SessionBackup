import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderMarkdown } from "./markdownHtml";

describe("renderMarkdown", () => {
  it("escapes markup before anything else", () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">');
    assert.equal(html.includes("<img"), false);
    assert.ok(html.includes("&lt;img"));
  });

  it("keeps fenced code verbatim and records the language", () => {
    const html = renderMarkdown("前言\n\n```ts\nconst a = 1 < 2;\n```");
    assert.ok(html.includes('<pre class="code" data-lang="ts">'));
    // 內容經過語法上色，但字元本身不變（上色細節由 highlight.test.ts 驗）
    const code = /<code>([\s\S]*)<\/code>/.exec(html)?.[1] ?? "";
    assert.equal(
      code.replace(/<\/?span[^>]*>/g, ""),
      "const a = 1 &lt; 2;"
    );
  });

  it("does not treat emphasis markers inside inline code as formatting", () => {
    assert.equal(renderMarkdown("用 `a * b * c` 相乘"), "<p>用 <code>a * b * c</code> 相乘</p>");
  });

  it("renders emphasis, strike-through and links", () => {
    const html = renderMarkdown("**粗** *斜* ~~刪~~ [連結](https://example.com/a)");
    assert.ok(html.includes("<strong>粗</strong>"));
    assert.ok(html.includes("<em>斜</em>"));
    assert.ok(html.includes("<del>刪</del>"));
    assert.ok(html.includes('<a href="https://example.com/a">連結</a>'));
  });

  it("turns repo-relative targets into file references", () => {
    const html = renderMarkdown("見 [markdownHtml.ts](src/markdownHtml.ts)");
    assert.ok(
      html.includes(
        '<a class="file-link" data-path="src/markdownHtml.ts" title="src/markdownHtml.ts">markdownHtml.ts</a>'
      )
    );
  });

  it("keeps the line number of a file reference", () => {
    const html = renderMarkdown("[git.ts:42](src/git.ts#L42-L51)");
    assert.ok(html.includes('data-path="src/git.ts"'));
    assert.ok(html.includes('data-line="42"'));
  });

  // 單一字母加冒號是磁碟機代號，不是 scheme
  it("links an absolute Windows path", () => {
    const html = renderMarkdown("[.gitignore](C:\\work\\SAM3_LoRa\\.gitignore)");
    assert.ok(html.includes('data-path="C:\\work\\SAM3_LoRa\\.gitignore"'));
  });

  it("links a file:// target as a path", () => {
    const html = renderMarkdown("[a.ts](file:///d:/work/a.ts)");
    assert.ok(html.includes('data-path="d:/work/a.ts"'));
  });

  it("refuses to link a scripting scheme", () => {
    const html = renderMarkdown("[點我](javascript:alert(1))");
    assert.equal(html.includes("<a "), false);
    assert.ok(html.includes("[點我]"));
  });

  it("builds lists, headings and quotes", () => {
    const html = renderMarkdown("## 標題\n\n- 一\n- 二\n\n1. 甲\n2. 乙\n\n> 引用");
    assert.ok(html.includes("<h4>標題</h4>"));
    assert.ok(html.includes("<ul>\n<li>一</li>\n<li>二</li>\n</ul>"));
    assert.ok(html.includes("<ol>\n<li>甲</li>\n<li>乙</li>\n</ol>"));
    assert.ok(html.includes("<blockquote>引用</blockquote>"));
  });

  it("renders a table with its own scroll container", () => {
    const html = renderMarkdown("說明\n\n| 狀態 | 說明 |\n| --- | --- |\n| 已同步 | 內容已在備份中 |");
    assert.ok(html.includes("<p>說明</p>"));
    assert.ok(html.includes('<div class="table-wrap"><table><thead><tr><th>狀態</th><th>說明</th>'));
    assert.ok(html.includes("<tbody><tr><td>已同步</td><td>內容已在備份中</td></tr></tbody>"));
  });

  it("pads a short row so the columns stay aligned", () => {
    const html = renderMarkdown("| a | b |\n|---|---|\n| 只有一格 |");
    assert.ok(html.includes("<tr><td>只有一格</td><td></td></tr>"));
  });

  it("does not mistake a sentence containing a pipe for a table", () => {
    const html = renderMarkdown("用 a | b 分隔\n這是下一行");
    assert.equal(html.includes("<table>"), false);
  });

  it("closes an unterminated code fence at the end of the text", () => {
    const html = renderMarkdown("```\n還在輸出");
    assert.ok(html.includes("<pre class=\"code\"><code>還在輸出</code></pre>"));
  });
});
