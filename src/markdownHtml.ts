/**
 * 對話預覽用的極簡 Markdown 轉換器。
 *
 * 刻意不引入 Markdown 套件：這個擴充功能目前沒有任何執行期相依套件，
 * 而預覽只需要對話裡實際會出現的語法（程式碼區塊、清單、標題、行內強調）。
 * 所有輸出都先經過 escapeHtml，webview 才不會被對話內容注入標籤。
 */

import { highlightCode } from "./highlight";
import { escapeHtml } from "./htmlEscape";

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let listType: "ul" | "ol" | undefined;
  let openTag: string | undefined;
  let index = 0;

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = undefined;
    }
  };
  const openList = (type: "ul" | "ol") => {
    if (listType !== type) {
      closeList();
      out.push(`<${type}>`);
      listType = type;
    }
  };

  while (index < lines.length) {
    const line = lines[index];
    const fence = /^\s*```(\S*)\s*$/.exec(line);
    if (fence) {
      closeList();
      const body: string[] = [];
      index++;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        body.push(lines[index]);
        index++;
      }
      index++; // 收掉結尾的圍籬；沒有結尾就是讀到檔案結束
      const lang = fence[1] ? ` data-lang="${escapeHtml(fence[1])}"` : "";
      out.push(
        `<pre class="code"${lang}><code>${highlightCode(body.join("\n"), fence[1])}</code></pre>`
      );
      continue;
    }

    // Codex 有些回覆會用 <proposed_plan>…</proposed_plan> 這類自訂標籤整段包住內容
    // （來自使用者自己的 skill／prompt 慣例），單獨一行的開／收標籤原本會被當成
    // 一般段落逐字逃逸顯示。改成收合成一個有標籤的卡片，裡面照常跑 Markdown。
    if (!openTag) {
      const open = /^<([a-zA-Z][\w-]*)>\s*$/.exec(line);
      if (open) {
        closeList();
        openTag = open[1];
        out.push(`<div class="callout"><div class="callout-label">${escapeHtml(calloutLabel(openTag))}</div>`);
        index++;
        continue;
      }
    } else {
      const close = /^<\/([a-zA-Z][\w-]*)>\s*$/.exec(line);
      if (close && close[1] === openTag) {
        closeList();
        out.push("</div>");
        openTag = undefined;
        index++;
        continue;
      }
    }

    if (!line.trim()) {
      closeList();
      index++;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      closeList();
      out.push("<hr>");
      index++;
      continue;
    }

    if (isTableHeader(lines, index)) {
      closeList();
      const header = tableCells(line);
      index += 2; // 表頭與底下的分隔列
      const rows: string[][] = [];
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(tableCells(lines[index]));
        index++;
      }
      // 寬表格自己捲動，不要把整個對話撐寬。
      out.push(
        '<div class="table-wrap"><table><thead><tr>' +
          header.map((cell) => `<th>${inline(cell)}</th>`).join("") +
          "</tr></thead><tbody>" +
          rows
            .map(
              (row) =>
                "<tr>" +
                header
                  .map((_, column) => `<td>${inline(row[column] ?? "")}</td>`)
                  .join("") +
                "</tr>"
            )
            .join("") +
          "</tbody></table></div>"
      );
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      // 訊息本身已經是一個層級，內文標題再往下降兩級才不會比對話標題還大。
      const level = Math.min(heading[1].length + 2, 6);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      index++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      closeList();
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoted.push(lines[index].replace(/^\s*>\s?/, ""));
        index++;
      }
      out.push(`<blockquote>${quoted.map(inline).join("<br>")}</blockquote>`);
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      openList("ul");
      out.push(`<li>${inline(bullet[1])}</li>`);
      index++;
      continue;
    }

    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      openList("ol");
      out.push(`<li>${inline(numbered[1])}</li>`);
      index++;
      continue;
    }

    closeList();
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      isParagraphLine(lines[index]) &&
      !isTableHeader(lines, index)
    ) {
      paragraph.push(lines[index]);
      index++;
    }
    out.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
  }

  closeList();
  if (openTag) {
    // 沒有收尾標籤（訊息中途被截斷）也要把卡片關起來，不然後面全部內容都會被吞進去。
    out.push("</div>");
  }
  return out.join("\n");
}

/** <proposed_plan> → PROPOSED PLAN，給不了中文翻譯就照樣顯示英文標籤名。 */
function calloutLabel(tag: string): string {
  return tag.replace(/[_-]+/g, " ").toUpperCase();
}

/**
 * 表格要看下一列是不是分隔列（`| --- | --- |`）才認得出來，
 * 只看目前這一列的話，任何含有 | 的句子都會被誤判。
 */
function isTableHeader(lines: string[], index: number): boolean {
  const header = lines[index];
  const delimiter = lines[index + 1];
  return (
    header.includes("|") &&
    delimiter !== undefined &&
    /^[\s|:-]+$/.test(delimiter) &&
    delimiter.includes("-") &&
    delimiter.includes("|")
  );
}

function tableCells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

/** 只有這幾種 scheme 會被當成網址；其餘一律視為檔案路徑。 */
const WEB_LINK = /^https?:\/\//i;
/**
 * scheme 至少兩個字元：單一字母加冒號是 Windows 磁碟機代號（`C:\work\a.ts`），
 * 不是 scheme，當成 scheme 擋掉的話絕對路徑連結全都會失效。
 */
const UNSAFE_LINK = /^[a-z][a-z0-9+.-]+:/i;
const FILE_URL = /^file:\/\/\/?/i;

/**
 * 對話裡的連結有兩種：外部網址，以及指向專案檔案的相對／絕對路徑
 * （`[檔名.ts](src/檔名.ts#L42)`）。後者在 webview 裡不能直接導覽，
 * 改成帶資料屬性的連結，由外層轉成「在編輯器開啟」。
 * 傳入的 label／target 都已經過 escapeHtml。
 */
function link(label: string, target: string): string | undefined {
  if (WEB_LINK.test(target)) {
    return `<a href="${target}">${label}</a>`;
  }
  const local = FILE_URL.test(target) ? target.replace(FILE_URL, "") : target;
  // javascript:、data: 這類 scheme 一律不連結，維持原樣顯示。
  if (UNSAFE_LINK.test(local)) {
    return undefined;
  }
  // 兩種行號格式都要吃：GitHub 式的 `#L42`，以及 Codex 引用檔案時常用的
  // 純冒號 `path:42`（沒有 #L 前綴）。非貪婪的 `.*?` 加上 `$` 錨點會自動
  // 略過 Windows 磁碟機代號那個冒號（`C:\work\a.ts`），只在真的以
  // `:數字` 結尾時才切開。
  const anchor = /^(.*?)(?:#L(\d+)(?:-L?\d+)?|:(\d+))$/.exec(local);
  const filePath = anchor?.[1] ?? local;
  if (!filePath) {
    return undefined;
  }
  const lineNumber = anchor?.[2] ?? anchor?.[3];
  const line = lineNumber ? ` data-line="${lineNumber}"` : "";
  return `<a class="file-link" data-path="${filePath}"${line} title="${local}">${label}</a>`;
}

function isParagraphLine(line: string): boolean {
  return (
    line.trim() !== "" &&
    !/^\s*```/.test(line) &&
    !/^\s*>/.test(line) &&
    !/^#{1,6}\s/.test(line) &&
    !/^\s*[-*+]\s+/.test(line) &&
    !/^\s*\d+[.)]\s+/.test(line) &&
    !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)
  );
}

const PLACEHOLDER = "\u0000";

function inline(text: string): string {
  let html = escapeHtml(text);
  // 行內程式碼先抽走，裡面的 * 和 _ 才不會被當成強調語法。
  const codes: string[] = [];
  html = html.replace(/`([^`]+)`/g, (_, code: string) => {
    codes.push(`<code>${code}</code>`);
    return `${PLACEHOLDER}${codes.length - 1}${PLACEHOLDER}`;
  });
  html = html.replace(
    // target 允許空白：中文檔名常見「資安 SKILL 應用.md」這種帶空格的檔名，
    // 只要在下一個 `)` 前結束就視為連結目標，跟一般 Markdown 網址一樣不吃換行。
    /\[([^\]]+)\]\(([^\n)]+)\)/g,
    (whole: string, label: string, target: string) => link(label, target.trim()) ?? whole
  );
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, "$1<em>$2</em>");
  html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return html.replace(
    new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, "g"),
    (_, position: string) => codes[Number(position)]
  );
}
