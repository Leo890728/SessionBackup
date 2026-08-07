# 重構評估報告

評估日期：2026-07-31  
主要範圍：`b75528d..c7fb0b4` 的 `readTranscript` 重構  
次要範圍：目前工作樹的定向重構候選掃描（不等同完整架構改造計畫）

## 結論

**PASS — 接受目前重構，選定範圍已 clean enough，建議停止進一步抽象。**

這次變更先以 `b75528d test: pin readTranscript 的 Codex 解析行為` 建立可重現的綠色基線，再以 `c7fb0b4 refactor: 拆開 readTranscript 的 Claude 與 Codex 解析` 單獨提交結構調整。重構前後都通過同一套 167 個測試與 strict TypeScript 編譯，重構提交沒有修改測試，也沒有改變公開的 `readTranscript` 契約。

目前的邊界是合理的：

- `ParsedTranscript` 收斂 Claude/Codex 共同的輸出形狀。
- `userMessage` 共享兩邊完全相同、會一起變更的 user-message construction。
- `parseClaudeTranscript` 保留 Claude 的連續 assistant 合併、中斷訊息與 meta 過濾規則。
- `parseCodexTranscript` 保留 Codex 的 pending turn、`task_complete` flush、work/answer 收合與索引標題規則。

Claude 與 Codex parser 只有結構相似，背後 schema 與狀態轉移不同。再做 generic parser、strategy framework 或共用主迴圈，會把原本應獨立演進的知識綁在一起，屬 speculative refactoring。

## 範圍與 Git 基線

建立本報告前的狀態：

- 分支：`main...origin/main [ahead 2]`
- 工作樹：除本報告檔外乾淨，無 staged、unstaged 或其他 untracked 變更
- 基線提交：`b75528d`
- 重構提交：`c7fb0b4`
- 重構 diff：只修改 `src/sessions.ts`，`159 insertions / 131 deletions`
- 重構提交與 feature commit 分離，提交訊息符合 `refactor: <內容>` 格式

## 行為保留證據

| Gate | 結果 | 證據 |
|---|---|---|
| Repository-defined test gate | PASS | `npm test`：53 suites、167 tests、167 pass、0 fail、0 skipped（評估 `c7fb0b4` 當下；後續重構已提高到 55 suites / 175 tests，同樣全綠） |
| Strict compile | PASS | `tsc -p ./` 在重構前提交與目前 HEAD 都通過 |
| 重構前基線 | PASS | 將 `b75528d` 匯出到隔離暫存目錄後，以相同編譯器執行：167/167 pass |
| 聚焦行為測試 | PASS | `src/sessions.test.ts:121-346` 覆蓋 Claude/Codex 六個 transcript 契約案例 |
| 測試是否隨重構修改 | PASS | `c7fb0b4` 只修改 `src/sessions.ts` |
| Consumer-facing API | PASS | `readTranscript(tool, file): Promise<Transcript>` 維持不變；新增 helpers 均未 export |
| Mutation testing | **N/A（明確記錄）** | repo 沒有 mutation harness；替代證據為前後完整測試、strict compile、聚焦契約測試與未修改測試的獨立 refactor commit |
| VS Code Extension Host E2E | N/A for selected scope | 目前沒有 `@vscode/test-electron`；本次範圍是由 Node tests 直接行使的純 transcript parsing |

聚焦測試保護的行為包括：

- Claude：連續 assistant/tool 合併、中斷前後分輪、thinking 保留與 injected meta 過濾。
- Codex：進度內容收合成 work block、缺少 `task_complete` 時由下一個問題分輪、沒有最終回答時保留純 work turn。
- 共同結果：title、cwd、message role、block shape 與 timestamp。

## 結構改善

以下是用目前 TypeScript AST 計算的近似結構指標；它不是 repository gate，只用來比較拆分前後的責任邊界。

| Symbol | LOC | Approx. cyclomatic | Approx. max nesting |
|---|---:|---:|---:|
| 重構前 `readTranscript` | 163 | 53 | 8 |
| 目前 `readTranscript` dispatcher | 14 | 2 | 1 |
| 目前 `parseClaudeTranscript` | 62 | 24 | 7 |
| 目前 `parseCodexTranscript` | 90 | 28 | 6 |

這次重構沒有假裝消除必要的 domain complexity；它把複雜度分配到兩個各自完整、可獨立理解的 provider state machine，讓公開入口只負責讀檔、分派與建立共同輸出。這比追求單一低分數更有價值。

關鍵位置（後續重構新增 import 後，`sessions.ts` 內行號整體 +1；以下為目前 HEAD 的值）：

- `src/sessions.ts:582` — internal `ParsedTranscript`
- `src/sessions.ts:589` — shared `userMessage`
- `src/sessions.ts:609` — public dispatcher
- `src/sessions.ts:624` — Claude parser
- `src/sessions.ts:687` — Codex parser
- `src/sessionPreview.ts:25`、`:32`、`:49` — preview consumers
- `src/sessions.ts:801` — Markdown consumer
- `src/conflictView.ts:20-21` — conflict comparison consumer

## Refactoring checklist

- [x] Existing behavior tests pass；重構提交未藉由修改測試隱藏行為變更
- [x] Focused tests、affected tests 與完整 repository test gate 都通過
- [x] Mutation testing 明確記錄為 N/A，並附比例相稱的替代證據
- [x] 未新增未規劃的 consumer-facing API
- [x] `readTranscript` 的 provider 邊界比原本清楚
- [x] baseline test commit 與 refactor commit 分離
- [x] working baseline 在重構前已提交
- [x] 未加入「未來可能會用到」的 framework 或 speculative behavior
- [x] 在現有測試 fidelity 範圍內，行為保持不變

## 本次明確 Skip

1. **不要再合併 Claude/Codex parser。** 兩者是不同 schema 與狀態機，不是同一份知識。
2. **不要只為降低 metric 拆散 parser local state。** `messages`、`pending`、`cwd`、`id`、`durationMs` 目前都被限制在正確的 lexical scope。
3. **不要為 `userMessage` 改名單獨開一個 refactor。** `buildUserMessage` 可能稍微更動詞化，但 ROI 只屬 Nice。
4. **不要把全庫 Prettier sweep 混入本次重構。** `prettier@3.9.5` 有被 pin 在 devDependencies，但 repo 沒有 `.prettierrc`，`scripts` 也沒有 format gate。

   實測不符合數會隨參數在 56–60 之間浮動：`npx prettier --check .` 回報 60（含 `README.md`、`package*.json` 與本報告），只掃 `src/**/*.ts` 是 58，改用 `--print-width 100`（貼近本庫實際風格）降到 56。檔案在磁碟上是 CRLF，而 Prettier 預設 `endOfLine: "lf"`，也貢獻了一部分差異。

   換句話說，沒有 `.prettierrc` 時這個數字量的是「與 Prettier 預設值的距離」，不是程式碼品質。要先決定 config 才有意義，這是獨立的 tooling 決策，不該混進重構提交。

## 後續候選

以下只表示優先級與安全前置條件，沒有授權在本次報告中修改程式碼。

### ~~High quick win — 解除唯一 import cycle~~ ✅ 已完成（`5a7e882`）

`markdownHtml -> highlight -> markdownHtml` 曾是 production module graph 唯一的循環。

執行時另外發現報告初版漏掉的一點：`src/conflictView.ts` 自己抄了一份與 `markdownHtml.escapeHtml` **逐字相同**的實作。HTML 逸出是安全邊界，兩份會一起變更，屬 knowledge duplication 而非表面重複，因此一併收斂。

- 新增 `src/htmlEscape.ts`：不相依任何模組的 leaf
- `markdownHtml`、`highlight`、`sessionPreviewHtml`、`conflictView` 都改為單向相依
- 沒有做 re-export——只有兩個 import 點，留一條 alias 路徑反而讓「正本在哪」變模糊

驗證：以 AST 掃描 production module graph，重構前正好 1 個循環、重構後 0 個；`npm test` 167/167、`tsc` 皆通過。

### ~~Critical — Codex `session_meta` 知識重複~~ ✅ 已完成（`ba90b9e` + `ae926b8`）

同一份 Codex schema knowledge 分散在：

- `src/sessionStore.ts:461-508` — backup id / cwd
- `src/sessions.ts:372-423` — UI id、backupId、`parent_thread_id`、subagent
- `src/sessions.ts:723-726` — transcript cwd / id
- `src/codexLocalize.ts:13-38`、`:50-84` — cwd / `model_provider`
- `src/sessionStore.ts:399-420` — 比對時忽略 machine-local fields

`src/sessions.ts:391` 已用註解明示必須與 `sessionMetadata` 維持同一規則，這是 knowledge duplication，而不是表面重複。

四個步驟都已執行（`ba90b9e` 測試基線 + `ae926b8` 重構）：

1. **跨模組 characterization（`ba90b9e`，+8 tests，未動 production code）。** 先前只有「新版 `session_id`」一種情況被測到。補上：UI 端的新版 `session_id`、舊版只有 `id`、子代理檔（UI 用自身 `id`、備份用父 thread id）、`payload.id` 與父 thread 相同時退回檔名 uuid、完全沒有 `session_meta` 的退回規則；備份端則透過 `collectLocalSessions` 釘住同樣三種 id 情況。
2. **提交綠色基線。** 175/175 pass。
3. **只抽 pure decoder（`ae926b8`）。** 新增 `src/codexMeta.ts`：`codexSessionMeta` 認 record，`codexThreadId`（`session_id ?? id`）與 `codexMetaCwd` 取 raw facts。原本 `src/sessions.ts:391` 那句「必須與 `sessionMetadata` 同一條規則」的註解，現在由單一函式取代。
4. **各 consumer 保留自己的 policy。** I/O window（256 KiB/200 行、50 行、全文）、`titleCache`、子代理的 own-id 規則、`canonicalRecord` 的忽略欄位都留在原處；`backupId` 與 UI `id` 仍是兩個獨立欄位。

一個誠實的但書：decoder 帶上型別後，原本靠 `any` 略過的 `cwd` 與 thread id 現在一律要求 `string`。這與備份端本來就有的 `typeof id === "string"` 檢查一致，也符合 `backupId: string` 的宣告型別；對格式正確的 rollout 檔行為完全不變，只有 payload 欄位型別異常的畸形檔會從「悄悄塞入非字串」變成「視同缺欄位」。這一點是收斂重複的必然結果，不是無意的副作用。

`canonicalRecord`（`src/sessionStore.ts:399-422`）刻意沒有接進來：它同時處理 `session_meta` 與 `turn_context`，且需要原始 record 重新序列化，管的是「哪些欄位是機器本地」——與 schema 解讀是不同的知識。

### Critical，但目前缺 preservation baseline

| Symbol | 現況 | 現在的決定 |
|---|---|---|
| `src/sync.ts:53-257` `runSync` | 205 LOC，近似 `29 cyclomatic / 65 cognitive / nesting 4`；同時處理 pre-backup、mapping、materialization、conflict、selection adoption 與 post-backup | **暫勿重構。** `sync.test.ts` 只直接保護 file grouping helper；先建立 candidate decision matrix |
| `src/backup.ts:43-241` `doBackup` | 199 LOC，近似 `34 / 62 / 4`；混合 remote/auth、secret UI/redaction、store、commit/push 與結果訊息 | **暫勿重構。** 先釘 modal outcomes、vault/redaction、selection side effects 與 push failure |
| `src/sessions.ts:801-846` `renderSessionMarkdown` | 46 LOC，近似 `19 / 57 / 5`；message → block → work item 深層巢狀 | **暫勿重構。** 先加 golden tests 保護 header、separator、tool ordering 與 work grouping |

複雜度高不會自動授權重構。依本技能要求，沒有比例相稱的行為保留證據時，應先補基線，不應直接搬動 side effects。

### High candidates

| Symbol | 證據 | 安全前置 |
|---|---|---|
| `src/extension.ts:44-450` `activate` | 407 LOC、20 個 command registrations、composition root fan-out 高 | 先建立 Extension Host 或 command-registration smoke evidence，再按 command 群小步拆分 |
| `src/repositoryTree.ts:429-534` `detectState` | 混合自動重連、fetch/auth、repo 還原、divergence、session scan 與 UI state | 現有測試只保護 pure classifier；先 characterization coordinator paths |
| `src/sessionStore.ts:236-325` `storeSessions` | content-addressed store、copy verification、manifest reuse/write 混在一起 | 已有 stable manifest、copy race、canonical metadata、revision-exists tests；可作小步 per-session extraction |
| `src/sessionStore.ts:162-234` `collectLocalSessions` | backup、sync、repository state、rebuild 四條路徑共用 | 保留 selection-before-hash、canonical relativePath、Codex title 與 project resolver |

### 不是 behavior-preserving refactor：先做產品決策

來源 layout 已有可見分歧：

- backup collector 會掃 Claude `projects` + `sessions`，以及 Codex `sessions` + `archived_sessions`
- Sessions tree 目前只列 Claude `projects` 與 Codex `sessions`
- 因此部分可被 tool-level whitelist 備份的 session，可能無法在 UI 個別看見或選取
- `sources: []` 的 fallback 語意在 tree、collector 與 watcher 之間也不完全一致

統一 `sessionLayout`/source resolver 可能是正確方向，但會改變 user-visible behavior。必須先決定 archived sessions 與空 sources 的期望並新增測試，不能把它包裝成純重構。

## 建議順序

1. ✅ 接受 `c7fb0b4`，本次 `readTranscript` slice 不再繼續拆。
2. ✅ 解除 `escapeHtml` import cycle — `5a7e882`。
3. ✅ Codex `session_meta`：補 characterization 並提交基線（`ba90b9e`），再抽 pure decoder（`ae926b8`）。
4. ⬜ `runSync`、`doBackup`、`activate`、`detectState` 都先補 coordinator-level preservation evidence，之後一次只拆一個責任。**目前仍缺基線，維持暫勿重構。**
5. ⬜ source layout 分歧另開 behavior/產品決策，不與 refactor commit 混合。
6. ⬜ Prettier config 屬 tooling 決策，先決定 `printWidth` 與 `endOfLine` 再談 sweep。

## 執行紀錄

本報告的第 2、3 項已依序執行，每一步都維持 commit-before-refactoring 與「測試基線與重構分開提交」的紀律：

| 提交 | 類型 | 內容 | Gate |
|---|---|---|---|
| `5a7e882` | refactor | `escapeHtml` → leaf module，順帶收斂 `conflictView` 的重複實作 | 167/167、`tsc` 0、cycle 1→0 |
| `ba90b9e` | test | Codex `session_meta` id 規則的跨模組 characterization（+8） | 175/175、`tsc` 0 |
| `ae926b8` | refactor | 抽出 `codexMeta` pure decoder，四個 consumer 改用 | 175/175、`tsc` 0 |

三個提交都在本機，尚未 push。兩個 refactor 提交都沒有修改測試；唯一的測試變更（`ba90b9e`）是純新增、且未動 production code，因此不存在「改測試遮蔽行為變更」的可能。

第 4、5 項未執行——報告當時的判斷是它們缺乏比例相稱的行為保留證據，這次核對後該判斷不變。

## 工具與證據限制

- `codebase-memory-mcp` 的既有索引已過期；例如 `renderSessionMarkdown` 指到舊行號，`runSync` trace 也包含已不存在的 direct calls。
- 已嘗試 full 與 fast 重建，兩者都回覆 `Pipeline failed`。
- 因此圖譜只用於初步導航；本報告的最終行號、依賴、AST 指標與 consumers 均以目前工作樹直接核對。
- repo 沒有 coverage、mutation harness、lint gate 或 VS Code Extension Host E2E。這不否定本次 parser refactor 的比例相稱證據，但會限制大型 UI/coordinator 重構的可信度。
