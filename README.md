# AI Session Backup

VS Code 擴充功能：以 append-only 格式備份 Claude Code 與 Codex 的 JSONL session，並在多台電腦之間安全合併。預設備份庫是 `~/.session-backup-v2`。

> 0.2 採綠地格式，不讀取或遷移舊版鏡像備份。請使用新的本地路徑與 GitHub 私人儲存庫。

## 備份內容

備份是**選擇制**：只備份你在 Sessions 側欄勾選的對話，沒勾的不備份、不觸發變更偵測，
同步時也不會從其他電腦匯入。詳見 [選擇要備份的對話](#選擇要備份的對話)。

勾選的對話只取聊天紀錄，不鏡像整個 `.claude` 或 `.codex`：

- Claude Code：`projects/**/*.jsonl`、`sessions/**/*.jsonl`
- Codex：`sessions/**/*.jsonl`、`archived_sessions/**/*.jsonl`

憑證、設定、skills、plugins、SQLite、cache、sandbox 與暫存檔不會進入 store。

每份內容以 SHA-256 建立不可變 revision：

```text
format.json
store/<tool>/<session-id>/<sha256>.jsonl
machines/<machine-id>/manifest.json
machines/<machine-id>/resolutions.json
```

其他電腦不存在的 session 不會被刪除。

## 使用方式

逐步操作、側邊欄說明與常見問題請看 [使用說明](USAGE.md)。

1. 按 **F5** 以開發模式啟動，或用 `npm run package` 建立 VSIX。
2. 執行 **Session Backup: 設定 GitHub 私人儲存庫**。
3. `sessionBackup.machineId` 留空即可；自動使用「主機名稱 + VS Code 安裝識別碼短雜湊」，
   同名主機也不會撞。此設定為 machine-scoped，不會被 Settings Sync 帶到其他電腦。
4. 在活動列的 **Session Backup → Sessions** 勾選要備份的對話（可勾單一對話、
   整個 Claude 專案或整個工具）。
5. 執行 **Session Backup: 立即備份**。
6. 在另一台電腦執行 **Session Backup: 同步並合併其他電腦紀錄...**。

側邊欄頂端的 **GitHub Backup** 會依狀態顯示操作：

- 尚未設定遠端：**連接 GitHub**，使用 VS Code GitHub 登入建立或連結私人 repo。
- 已連接但 GitHub 尚無備份分支：**備份至 GitHub**，像 Source Control 的 Publish 動作一樣建立第一個 commit 並 push。
- 已有備份：顯示 `owner/repo` 與最近備份時間；點擊可立即再次備份。
- 偵測到本機變更時，狀態磚下方會展開「**有變動的 sessions**」清單
  （類似 Source Control 的 Changes）：標示 **新增** 或 **已變更**、
  顯示可讀標題，點擊可預覽對話；最多列 30 筆，其餘以「…還有 N 個」摘要。

同步是**完全非互動**的（自動排程也會執行：每次定時備份前先拉遠端合併）：

- 內容相同：略過。
- 遠端是本機的完整延伸：自動採用較長版本。
- 本機是遠端的完整延伸：保留本機。
- 目標檔案使用中（兩分鐘內有寫入）：延後到下次同步，不覆寫進行中的對話。
- 兩邊從同一 session 分叉：**不會跳視窗**，記錄為衝突顯示在側欄
  GitHub Backup 的「衝突」區塊，之後有空再逐一處理。

點擊衝突項目開啟左右比較視窗（可獨立或同步捲動 A/B 對話）：

- **保留 A**：把遠端版本寫入本機；本機原內容仍保存在 store，可反悔。
- **保留 B**：維持本機並記住此選擇；遠端出現新 revision 時才會再次成為衝突。
- **跳過這次**（或關閉視窗）：衝突留在清單中，之後再處理。

Codex 標題（`session_index.jsonl`）以 `updated_at` 新者勝，不會被其他電腦的
舊標題覆蓋。

## Claude 專案重新定位

Claude Code 以本機專案路徑區分 session。擴充功能不把 A 電腦的 project bucket 直接複製到 B，而是使用跨機 `projectId`：

- Git 專案：由正規化 Git remote 的 hash 加上 repository-relative workspace path 產生，可自動對應不同 checkout 路徑與 monorepo 子目錄。
- 非 Git 專案：第一次在另一台電腦同步時要求選擇本機資料夾。
- 本機對應保存於 VS Code extension global storage 的 `project-mappings.json`，不會 commit 到共享備份庫。
- 共享 manifest 只保存 `projectId`、顯示名稱、remote hash 與 repository-relative path，不保存本機絕對路徑或 Claude 的路徑 bucket。

找不到對應時可選擇「使用目前工作區」、「選擇本機資料夾」或「跳過」。之後可執行 **Session Backup: 管理 Claude 專案對應...** 重新定位或移除對應。

共享 store 仍保存未修改的原始 JSONL；JSONL 本身可能含來源電腦的 `cwd`。匯入 B 時只改變 materialize 位置，不全文取代對話或工具輸出中的路徑。

## Codex 工作目錄本地化

Codex 以 `session_meta.payload.cwd` 決定 session 屬於哪個工作目錄——A 電腦在
`C:\`、B 電腦在 `D:\` 時，這個欄位視為**機器本地屬性**處理：

- manifest 對 codex session 也記錄跨機 `projectId`（git remote hash 推導，
  與 Claude 共用同一套專案映射）。
- **匯入**其他電腦的 session 時，若本機已有對應專案，`session_meta.cwd`
  會改寫成本機路徑，Codex 才能在本機工作目錄列出它；找不到映射就保持原樣。
- **更新**既有檔案時保留本機原本的 cwd，不會被其他電腦的路徑覆蓋。
- 同步比對會忽略 `session_meta.cwd` 與 `turn_context` 的
  `cwd`/`workspace_roots`——兩台電腦只差路徑的檔案視為相同，不會誤判分叉。
- 非 git 專案的 projectId 依路徑推導、跨機不穩定，這類 codex session
  匯入時不做 cwd 本地化（內容仍完整同步）。

## Session 瀏覽器

活動列的 **Session Backup** 圖示會顯示本機 session：

- Claude Code 依專案分組，Codex 依日期分組。
- Codex 子代理 thread（session_meta 含 `parent_thread_id`，如 guardian）不會當
  獨立 session 顯示，而是掛在父 thread 最新 rollout 檔的節點下展開；
  父檔案已被 Codex 清除的子 thread 不顯示（仍會照常備份）。
- 每個節點左側都有核取方塊，用來決定備份哪些對話。
- 每個 session 顯示備份狀態（比對本機 manifest，不需連網）：
  - ✓ **已同步** — 目前內容已在備份中
  - ☁ **未同步** — 備份後有新內容，下次備份會更新
  - ○ **待備份** — 已勾選但尚未備份過（包含之前因金鑰跳過的）
  - ⃠ **未選取** — 沒有勾選，備份與同步都會跳過
  - ⚠ **跳過（過大）** — 超過 `maxFileSizeMB` 上限
- 點擊 session 可預覽 Markdown。
- 右鍵可匯出 Markdown、開啟原始 JSONL、加入或移出備份。

## 選擇要備份的對話

在 **Sessions** 側欄用核取方塊勾選，選取結果存在 `sessionBackup.selectedSessions`：

| 勾選位置 | 規則 | 涵蓋範圍 |
| --- | --- | --- |
| 工具節點（Claude Code / Codex） | `tool:claude`、`tool:codex` | 該工具全部對話，**含之後新增的** |
| Claude 專案節點 | `claudeProject:<projects 目錄名>` | 該專案全部對話，**含之後新增的** |
| 單一對話 | `session:<tool>:<sessionId>` | 該 thread 的所有 rollout 檔 |
| Codex 日期節點 | （逐一套用到當天的對話） | 只有當下那些對話，不含之後新增的 |

- 前綴 `-` 代表排除（如 `-session:codex:019f44…`）。
- 判定時**越具體的規則越優先**：session > claudeProject > tool。
  所以可以勾整個專案，再單獨取消其中一個對話；也可以在沒勾整個工具的情況下只勾幾個對話。
- 沒有任何規則涵蓋的對話完全不參與備份流程：不上傳、不列入「有變動的 sessions」、
  同步時也不會被其他電腦的版本覆寫。
- 取消勾選只影響之後的備份，**已上傳到 GitHub 的舊備份不會被刪除**。
- 從其他電腦同步匯入的對話會自動納入選取——它本來就在備份裡，否則匯入後反而不會再被備份。
- 也可用 **Session Backup: 管理要備份的對話...** 檢視並刪除選取規則。

> 從 0.2.x 升級：首次啟動會把本機 manifest 中**已經備份過**的對話設為選取，
> 既有備份不會突然停止更新；之後新增的對話則要自己勾選。
> 舊的 `sessionBackup.ignoredSessions` 會自動移除。

## 命令

| 命令 | 說明 |
| --- | --- |
| `Session Backup: 立即備份` | 收集 session → 建立 revision → secret 掃描 → commit → push |
| `Session Backup: 連接 GitHub` | 使用 VS Code GitHub 登入建立或連結私人 repo |
| `Session Backup: 備份至 GitHub` | 建立第一份安全掃描過的備份並 push |
| `Session Backup: 同步並合併其他電腦紀錄...` | 備份本機、取得遠端並以 no-delete 規則合併 |
| `Session Backup: 管理 Claude 專案對應...` | 重新定位、開啟或移除本機 projectId 對應 |
| `Session Backup: 管理要備份的對話...` | 檢視選取規則，勾選即可刪除 |
| `Session Backup: 設定 GitHub 私人儲存庫` | 自動建立或連結私人 repo |
| `Session Backup: 開啟本地備份儲存庫資料夾` | 開啟 `~/.session-backup-v2` |
| `Session Backup: 顯示記錄` | 顯示輸出面板 |

## 安全說明

- Session 本身可能包含提示詞、原始碼、工具輸出、路徑或金鑰，遠端必須使用私人儲存庫。
- commit 前會掃描常見 Anthropic、OpenAI、GitHub、AWS、Slack、Google 金鑰與私鑰標頭。
- 掃描命中時可選「跳過此次」或「取消選取」。取消選取會寫入 `sessionBackup.selectedSessions`
  的排除規則：該 session 之後不備份、不觸發變更偵測，多機同步時也不會從其他電腦匯入回本機；
  已上傳的舊備份不會被刪除。也可在 Session 瀏覽器取消勾選，或用
  「管理要備份的對話...」刪除規則。
- GitHub token 只透過 `http.extraHeader` 傳給 Git，不寫入 `.git/config`。
- 單檔超過 `sessionBackup.maxFileSizeMB` 時略過，預設 95 MB。

## 開發

```bash
npm install
npm test
npm run compile
```
