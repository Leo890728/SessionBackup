import { escapeHtml } from "./htmlEscape";

/**
 * 程式碼區塊的語法上色。
 *
 * 自己寫而不是引入 highlight.js／shiki：webview 的 CSP 是 default-src 'none'，
 * 外部腳本載不進來；而且這個擴充功能沒有執行期相依套件，不想為了上色破例。
 * 上色在產生 HTML 時就做完，webview 端不需要執行任何東西。
 *
 * 支援的語言以實際對話裡出現過的為準（shell、python、powershell、js/ts、
 * yaml、json、toml、css、sql、html、diff），其餘照原樣輸出。
 */

type TokenClass =
  | "c" // 註解
  | "s" // 字串
  | "k" // 關鍵字
  | "n" // 數字
  | "f" // 函式名
  | "p" // 屬性／鍵
  | "v" // 變數
  | "t"; // 標籤／型別

interface Rule {
  /** 只能用非捕獲群組 (?:...)，整條規則會被包成一個捕獲群組。 */
  pattern: string;
  cls: TokenClass | "id";
}

interface Grammar {
  rules: Rule[];
  keywords?: Set<string>;
  builtins?: Set<string>;
  /** 關鍵字比對是否忽略大小寫（SQL）。 */
  ignoreCase?: boolean;
}

const words = (list: string) => new Set(list.split(/\s+/).filter(Boolean));

const DQ = String.raw`"(?:\\.|[^"\\\n])*"?`;
const SQ = String.raw`'(?:\\.|[^'\\\n])*'?`;
const BACKTICK = "`(?:\\\\.|[^\\\\`])*`?";
const NUMBER = String.raw`\b(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)\b`;
const IDENT = String.raw`[A-Za-z_$][\w$]*`;

const JS: Grammar = {
  keywords: words(`
    async await break case catch class const continue debugger default delete do else enum export
    extends false finally for from function get if implements import in instanceof interface let new
    null of private protected public readonly return satisfies set static super switch this throw
    true try type typeof undefined var void while yield as declare namespace keyof infer never
    unknown any string number boolean object symbol bigint
  `),
  rules: [
    { pattern: String.raw`//[^\n]*`, cls: "c" },
    { pattern: String.raw`/\*[\s\S]*?\*/`, cls: "c" },
    { pattern: BACKTICK, cls: "s" },
    { pattern: DQ, cls: "s" },
    { pattern: SQ, cls: "s" },
    { pattern: NUMBER, cls: "n" },
    { pattern: IDENT, cls: "id" },
  ],
};

const PYTHON: Grammar = {
  keywords: words(`
    and as assert async await break class continue def del elif else except False finally for from
    global if import in is lambda None nonlocal not or pass raise return True try while with yield
    match case self cls
  `),
  builtins: words(`
    print len range str int float bool list dict set tuple open enumerate zip map filter sum min max
    sorted isinstance super type abs any all round
  `),
  rules: [
    { pattern: String.raw`#[^\n]*`, cls: "c" },
    { pattern: String.raw`(?:[rRbBfFuU]{0,2})"""[\s\S]*?"""`, cls: "s" },
    { pattern: String.raw`(?:[rRbBfFuU]{0,2})'''[\s\S]*?'''`, cls: "s" },
    { pattern: String.raw`(?:[rRbBfFuU]{0,2})` + DQ, cls: "s" },
    { pattern: String.raw`(?:[rRbBfFuU]{0,2})` + SQ, cls: "s" },
    { pattern: String.raw`@[\w.]+`, cls: "f" },
    { pattern: NUMBER, cls: "n" },
    { pattern: IDENT, cls: "id" },
  ],
};

const SHELL: Grammar = {
  keywords: words(`
    if then elif else fi for while until do done case esac function return break continue in select
    time coproc local export readonly declare set unset source alias
  `),
  rules: [
    { pattern: String.raw`#[^\n]*`, cls: "c" },
    { pattern: DQ, cls: "s" },
    { pattern: SQ, cls: "s" },
    { pattern: String.raw`\$(?:\{[^}]*\}|[\w@*#?$!-]+)`, cls: "v" },
    { pattern: String.raw`(?:^|\n)\s*[\w.\/-]+(?=\s)`, cls: "f" },
    { pattern: String.raw`--?[\w-]+`, cls: "p" },
    { pattern: NUMBER, cls: "n" },
    { pattern: IDENT, cls: "id" },
  ],
};

const POWERSHELL: Grammar = {
  ignoreCase: true,
  keywords: words(`
    if elseif else switch foreach for while do until break continue return function param begin
    process end try catch finally throw filter in and or not eq ne gt ge lt le like match true false
    null
  `),
  rules: [
    { pattern: String.raw`<#[\s\S]*?#>`, cls: "c" },
    { pattern: String.raw`#[^\n]*`, cls: "c" },
    { pattern: String.raw`@['"][\s\S]*?['"]@`, cls: "s" },
    { pattern: DQ, cls: "s" },
    { pattern: SQ, cls: "s" },
    { pattern: String.raw`\$(?:\{[^}]*\}|[\w:]+)`, cls: "v" },
    { pattern: String.raw`\b[A-Z][a-zA-Z]+-[A-Z]\w+`, cls: "f" },
    { pattern: String.raw`-[A-Za-z]\w*`, cls: "p" },
    { pattern: NUMBER, cls: "n" },
    { pattern: IDENT, cls: "id" },
  ],
};

const JSON_GRAMMAR: Grammar = {
  keywords: words("true false null"),
  rules: [
    { pattern: DQ + String.raw`(?=\s*:)`, cls: "p" },
    { pattern: DQ, cls: "s" },
    { pattern: NUMBER, cls: "n" },
    { pattern: IDENT, cls: "id" },
  ],
};

const YAML: Grammar = {
  keywords: words("true false null yes no on off"),
  rules: [
    { pattern: String.raw`#[^\n]*`, cls: "c" },
    { pattern: String.raw`(?:^|\n)\s*-?\s*[\w.\-\/]+(?=\s*:)`, cls: "p" },
    { pattern: DQ, cls: "s" },
    { pattern: SQ, cls: "s" },
    { pattern: String.raw`[&*][\w-]+`, cls: "v" },
    { pattern: NUMBER, cls: "n" },
    { pattern: IDENT, cls: "id" },
  ],
};

const TOML: Grammar = {
  keywords: words("true false"),
  rules: [
    { pattern: String.raw`[#;][^\n]*`, cls: "c" },
    { pattern: String.raw`(?:^|\n)\s*\[[^\]\n]*\]`, cls: "t" },
    { pattern: String.raw`(?:^|\n)\s*[\w.\-"]+(?=\s*=)`, cls: "p" },
    { pattern: DQ, cls: "s" },
    { pattern: SQ, cls: "s" },
    { pattern: NUMBER, cls: "n" },
    { pattern: IDENT, cls: "id" },
  ],
};

const CSS: Grammar = {
  rules: [
    { pattern: String.raw`/\*[\s\S]*?\*/`, cls: "c" },
    { pattern: String.raw`@[\w-]+`, cls: "k" },
    { pattern: DQ, cls: "s" },
    { pattern: SQ, cls: "s" },
    { pattern: String.raw`[\w-]+(?=\s*:)`, cls: "p" },
    { pattern: String.raw`#[0-9a-fA-F]{3,8}\b`, cls: "n" },
    { pattern: String.raw`\b\d[\d.]*(?:px|rem|em|%|vh|vw|s|ms|fr|deg)?\b`, cls: "n" },
    { pattern: String.raw`[.#][\w-]+`, cls: "t" },
    { pattern: IDENT, cls: "id" },
  ],
};

const SQL: Grammar = {
  ignoreCase: true,
  keywords: words(`
    select from where insert into values update set delete create table drop alter add column index
    join left right inner outer on group by order having limit offset union all as distinct and or
    not null is in like between case when then else end primary key foreign references default
    exists count sum avg min max
  `),
  rules: [
    { pattern: String.raw`--[^\n]*`, cls: "c" },
    { pattern: String.raw`/\*[\s\S]*?\*/`, cls: "c" },
    { pattern: SQ, cls: "s" },
    { pattern: DQ, cls: "s" },
    { pattern: NUMBER, cls: "n" },
    { pattern: IDENT, cls: "id" },
  ],
};

const HTML: Grammar = {
  rules: [
    { pattern: String.raw`<!--[\s\S]*?-->`, cls: "c" },
    { pattern: String.raw`</?[\w:-]+`, cls: "t" },
    { pattern: DQ, cls: "s" },
    { pattern: SQ, cls: "s" },
    { pattern: String.raw`[\w:-]+(?==)`, cls: "p" },
    { pattern: IDENT, cls: "id" },
  ],
};

const GRAMMARS: Record<string, Grammar> = {
  js: JS,
  javascript: JS,
  jsx: JS,
  ts: JS,
  typescript: JS,
  tsx: JS,
  json: JSON_GRAMMAR,
  jsonc: JSON_GRAMMAR,
  python: PYTHON,
  py: PYTHON,
  bash: SHELL,
  sh: SHELL,
  shell: SHELL,
  zsh: SHELL,
  console: SHELL,
  powershell: POWERSHELL,
  ps1: POWERSHELL,
  pwsh: POWERSHELL,
  yaml: YAML,
  yml: YAML,
  toml: TOML,
  ini: TOML,
  env: TOML,
  dotenv: TOML,
  css: CSS,
  scss: CSS,
  sql: SQL,
  html: HTML,
  xml: HTML,
  vue: HTML,
  svg: HTML,
};

export function highlightCode(code: string, lang: string | undefined): string {
  const key = (lang ?? "").toLowerCase();
  if (key === "diff" || key === "patch") {
    return highlightDiff(code);
  }
  const grammar = GRAMMARS[key];
  return grammar ? tokenize(code, grammar) : escapeHtml(code);
}

/** diff 是逐行判斷的，走不了共用的 token 規則。 */
function highlightDiff(code: string): string {
  return code
    .split("\n")
    .map((line) => {
      const cls = line.startsWith("+++") || line.startsWith("---")
        ? "p"
        : line.startsWith("+")
          ? "s"
          : line.startsWith("-")
            ? "t"
            : line.startsWith("@@")
              ? "k"
              : undefined;
      return cls ? span(cls, line) : escapeHtml(line);
    })
    .join("\n");
}

function tokenize(code: string, grammar: Grammar): string {
  const pattern = new RegExp(grammar.rules.map((rule) => `(${rule.pattern})`).join("|"), "g");
  let out = "";
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code))) {
    if (!match[0]) {
      pattern.lastIndex++; // 零長度比對：不推進的話會停在原地
      continue;
    }
    // 規則本身只用非捕獲群組，所以第一個非 undefined 的捕獲群組就是命中的規則。
    const hit = match.findIndex((group, index) => index > 0 && group !== undefined) - 1;
    const rule = grammar.rules[hit];
    if (!rule) {
      continue;
    }
    if (match.index > last) {
      out += escapeHtml(code.slice(last, match.index));
    }
    out += renderToken(match[0], rule, grammar, code, pattern.lastIndex);
    last = pattern.lastIndex;
  }
  return out + escapeHtml(code.slice(last));
}

function renderToken(
  text: string,
  rule: Rule,
  grammar: Grammar,
  code: string,
  end: number
): string {
  if (rule.cls !== "id") {
    // 有些規則為了定位而吃掉了前導空白／換行，那部分不要上色。
    const lead = /^\s+/.exec(text)?.[0] ?? "";
    return lead
      ? escapeHtml(lead) + span(rule.cls, text.slice(lead.length))
      : span(rule.cls, text);
  }
  const word = grammar.ignoreCase ? text.toLowerCase() : text;
  if (grammar.keywords?.has(word)) {
    return span("k", text);
  }
  if (grammar.builtins?.has(word)) {
    return span("f", text);
  }
  return /^\s*\(/.test(code.slice(end)) ? span("f", text) : escapeHtml(text);
}

function span(cls: TokenClass, text: string): string {
  return `<span class="t${cls}">${escapeHtml(text)}</span>`;
}
