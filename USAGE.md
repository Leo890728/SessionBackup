# 使用說明

AI Session Backup 的操作指南。設計理念與儲存格式請看 [README](README.md)。

## 安裝

```bash
npm install
npm test
npm run package
code --install-extension session-backup-0.3.0.vsix --force
```

安裝後**必須 Reload Window**,否則執行的仍是舊版程式碼。開發時直接按 **F5** 啟動除錯實例即可,不需打包。

## 第一次設定

### 1. 連接 GitHub

執行 **Session Backup: 連接 GitHub**。擴充功能會先找出你帳號下既有的備份庫,條件是「私人 + 你本人擁有 + 描述吻合或名稱吻合 + 根目錄有合法 `format.json`」。

- 找到 2 個以上且沒有一個名稱剛好吻合 → 出現選單讓你挑
- 只找到 1 個,或有一個名稱剛好等於 `sessionBackup.repoName` → 直接連接,不詢問
- 一個都沒找到 → 跳出名稱輸入框

輸入框**同時是連結與建立的入口**:

| 你輸入的名稱 | 結果 |
| --- | --- |
| 已存在的**私人** repo | 直接連結,不建立 |
| 已存在的**公開** repo | 拒絕並報錯(對話紀錄不可放在公開 repo) |
| 不存在 | 建立新的私人 repo |

預設名稱是 `agent-session-backup`。第一次使用直接接受預設值即可。

### 2. 機器名稱(通常不用管)

`sessionBackup.machineId` 決定 `machines/<machine-id>/` 這個目錄,每台電腦必須不同。**留空即可** —— 會自動產生「主機名稱 + VS Code 安裝識別碼短雜湊」,例如 `ST-LZY-3f9a2c`,兩台同名主機也不會撞。

這個設定是 machine-scoped,**不會被 Settings Sync 同步到其他電腦**。想自訂就直接填,填了以自訂值為準。

⚠️ 兩台撞名的後果不是「合併在一起」而是**完全不同步**:同步時會把 machineId 與自己相同的 manifest 過濾掉,所以兩台都會忽略對方,同時互相覆寫同一份 manifest,產生無止盡的 commit 來回。

### 3. 選擇要備份的對話

備份是**選擇制**:沒勾選的對話一律不備份。打開活動列的 **Session Backup → Sessions**,用左側核取方塊勾選。

| 勾選位置 | 涵蓋範圍 |
| --- | --- |
| **Claude Code / Codex**(工具節點) | 該工具全部對話,**含之後新增的** |
| **Claude 專案**節點 | 該專案全部對話,**含之後新增的** |
| **單一對話** | 該 thread 的所有 rollout 檔 |
| Codex **日期**節點 | 只有當下那幾個對話,不含之後新增的 |

規則**越具體越優先**(對話 > 專案 > 工具),所以可以「勾整個專案,再單獨取消其中一個對話」;取消後專案仍維持勾選,新對話照樣會備份。

沒勾選的對話顯示為 ⃠ **未選取**,完全不參與備份流程 —— 不上傳、不列入「有變動的 sessions」、同步時也不會被其他電腦的版本覆寫。取消勾選只影響之後的備份,**已上傳到 GitHub 的舊備份不會被刪除**。

從其他電腦同步匯入的對話會自動變成已勾選 —— 它本來就在備份裡,不這麼做的話匯入後反而不會再被這台電腦備份。

> **從 0.2.x 升級**:首次啟動會把本機 manifest 中已經備份過的對話設為勾選,既有備份不會突然停止更新;之後新增的對話要自己勾。舊的 `sessionBackup.ignoredSessions` 會轉換後移除。

### 4. 首次備份

執行 **Session Backup: 立即備份**,或點側邊欄的 **備份至 GitHub**。流程是:

```
收集勾選的 session → 金鑰掃描 → 寫入 revision → commit → push
```

一個都沒勾時會直接停下並提示「尚未選取任何要備份的對話」,不會動到既有的 manifest。

## 加入第二台電腦

1. 安裝擴充功能,設定**不同的** `machineId`
2. 執行 **Session Backup: 連接 GitHub**,選擇同一個備份庫
3. 執行 **Session Backup: 同步並合併其他電腦紀錄...**
4. 在 **Sessions** 側邊欄勾選這台電腦本機**自己產生**的對話

第 4 步不影響第 3 步:從備份庫匯入的對話會自動變成已勾選,所以第一台電腦備份過的內容在這台不用重勾。要勾的只有這台電腦自己新開、還沒上傳過的對話。

⚠️ 選取規則存在**使用者設定**(`sessionBackup.selectedSessions`),不進備份庫,但**會被 Settings Sync 同步到其他電腦** —— 這點和 machine-scoped 的 `machineId` 不同。影響最大的是 `tool:claude` / `tool:codex` 這種整個工具的規則:它一旦同步過去,新電腦裝好擴充功能就會直接開始備份該工具的全部對話,不會再問你。要讓每台電腦各自決定,在 `settingsSync.ignoredSettings` 加入 `sessionBackup.selectedSessions`,或改用專案、單一對話層級的規則。

Claude Code 以本機專案路徑區分 session,兩台電腦的 checkout 路徑通常不同(A 在 `C:\`、B 在 `D:\`)。Git 專案靠正規化的 remote hash 自動配對,通常不用管。

配不上的專案**不會跳視窗打斷同步**,而是在 **Sessions** 側邊欄的 Claude Code 底下顯示成 ☁ **待對應**節點,標示「N 個對話 · 待對應」與來源電腦。點它選擇這個專案在本機的位置(**使用目前工作區** 或 **選擇本機資料夾**),對應完成後會自動再同步一次,那些對話就會落地成一般的專案節點。之後想改用 **Session Backup: 管理 Claude 專案對應...** 重新定位。

> 什麼情況會配不上?最常見的是備份當下那個 checkout **還沒有 `remote.origin.url`**(先本地 `git init`、之後才推上 GitHub)。這時專案身分會退回以絕對路徑計算的 `local-<hash>`,換一台電腦既對不上 id 也沒有 remote hash 可比,只能手動指一次。

## 日常運作

`sessionBackup.autoBackupMinutes` 預設 30 分鐘,設 `0` 停用。注意排程跑的是**同步**而非單純備份 —— 先拉遠端合併再備份上傳,所以多機幾乎即時同步,平常不需要手動執行任何命令。

`sessionBackup.backupOnStartup` 預設 `false`;設為 `true` 時 VS Code 啟動後也會跑一次同步。

沒勾選的對話不會觸發自動備份 —— 只寫這類對話時側邊欄維持「已同步」,排程也不會產生 commit。

同步規則**完全非互動**,不會跳視窗打斷你:

| 情況 | 動作 |
| --- | --- |
| 內容相同(忽略路徑類欄位) | 略過 |
| 遠端是本機的完整延伸 | 自動採用遠端 |
| 本機是遠端的完整延伸 | 保留本機 |
| 目標檔案使用中(兩分鐘內有寫入) | 延後到下次同步 |
| 兩邊從同一點分叉 | 記為衝突,顯示在側邊欄 |
| 本機沒有這個對話 | 匯入,並自動納入選取 |
| 本機有但**未勾選** | 略過,不覆寫也不匯入 |
| Claude 專案在本機解不出位置 | 略過,在 Sessions 側邊欄顯示成 ☁ 待對應 |

## 讀懂側邊欄

### GitHub Backup

依狀態顯示不同動作:尚未設定遠端顯示**連接 GitHub**;已連接但遠端還沒有備份顯示**備份至 GitHub**;已有備份則顯示 `owner/repo` 與最近備份時間,點擊立即再備份一次。

偵測到本機變更時下方展開**有變動的 sessions**,標示「新增」或「已變更」,點擊可預覽對話。最多列 30 筆。這裡只列**已勾選**的對話 —— 沒勾的不算變更。

### Sessions

Claude Code 依專案分組,Codex 依日期分組。Codex 子代理 thread 不會獨立顯示,而是掛在父 thread 最新 rollout 檔的節點下(子代理與父 thread 在備份端是同一個單位,勾選會一起連動)。

每個節點左側的核取方塊決定要不要備份,見[選擇要備份的對話](#3-選擇要備份的對話)。

狀態不需連網,是拿本機檔案的 **mtime + size** 跟本機 manifest 比對得出的:

| 圖示 | 狀態 | 含意 |
| --- | --- | --- |
| ✓ | 已同步 | 目前內容已在備份中 |
| ☁ | 未同步 | 備份後有新內容,下次備份會更新 |
| ○ | 待備份 | 已勾選但尚未備份過 |
| ⃠ | 未選取 | 沒有勾選,備份與同步都會跳過 |
| ⚠ | 跳過(過大) | 超過 `maxFileSizeMB` |

Claude Code 底下另有 ☁ **待對應**節點:其他電腦備份過、但本機找不到位置的專案。它沒有核取方塊(還沒有本機檔案可勾),點一下指定資料夾即可,見[加入第二台電腦](#加入第二台電腦)。

右鍵可匯出 Markdown、開啟原始 JSONL、加入或移出備份。

## 處理衝突

點側邊欄衝突項目開啟左右比較視窗,可獨立或同步捲動 A/B 對話:

- **保留 A** — 把遠端版本寫入本機。本機原內容仍保存在 store,可反悔
- **保留 B** — 維持本機並記住這個決定。只有遠端出現**新的** revision 才會再次成為衝突
- **跳過這次**(或關閉視窗)— 衝突留在清單中

衝突清單存在擴充功能的 globalStorage,不會進備份庫;每次同步會用當次偵測結果整批覆寫,已消失的衝突自動清除。

## 金鑰掃描

`sessionBackup.secretScan` 預設開啟,commit 前掃描 Anthropic、OpenAI、GitHub、GitLab、AWS、Slack、Google、Stripe、npm、PyPI、Hugging Face、Groq、Notion、SendGrid、JWT、連線字串密碼與私鑰標頭。只掃這次會**新寫入** store 的內容。

規則一律是**前綴錨定**的高精確度樣式,不做熵值啟發式 —— 對話裡高熵字串(檔案 sha、base64、UUID)滿地都是,而遮蔽會改寫你的原始檔,誤判的代價是毀掉內容。寧可漏抓自訂格式也不錯抓。

命中時可選:

- **遮蔽後備份** — 把金鑰就地換成 `<SECRET:openai:5e70266c>` 這樣的標籤後照常備份。**會改寫本機原始檔**
- **跳過此次** — 這次不備份這些 session
- **取消選取** — 在 `sessionBackup.selectedSessions` 寫入排除規則。之後不備份、不觸發變更偵測,多機同步時也不會從其他電腦匯入回本機。已上傳的舊備份不會被刪除
- **仍要全部備份**
- **取消此次備份**

想恢復就在 Sessions 側邊欄重新勾選,或用 **Session Backup: 管理要備份的對話...** 刪掉那條排除規則。

### 遮蔽

標籤是**原文的雜湊**(`<SECRET:<類別>:<sha256 前 8 碼>>`),不是流水號。這是硬需求:流水號會讓兩台電腦依各自的掃描順序編出不同號碼,同一段對話遮出來的位元組就不同,而備份庫是 content-addressed 又靠逐行比對合併 —— 結果是每個含金鑰的 session 都變成**永久假衝突**。內容衍生的標籤則到處都一樣,兩台各自遮完會收斂成同一份。

遮蔽是**就地改寫原始檔**,不是「只存遮蔽版進備份庫」。後者會讓磁碟與 store 的位元組不一致,得同時改雜湊鏈、側邊欄的 mtime+size 判斷、與合併層的逐行比對;改原始檔則這三處原樣運作。語意上也更誠實 —— 那把金鑰本來就不該留在對話紀錄裡。

安全措施:

- 只在你**明確點下去**時執行,自動備份不會自己遮
- 兩分鐘內有寫入的檔案跳過(agent 可能還在 append,中途重寫會壞資料),下次備份再處理
- 先寫暫存檔再 rename,中途失敗原檔完整
- 原文先存進保險庫才動檔案

原文存在擴充功能 globalStorage 的 `secret-vault.json`,**不進備份庫、不進 Settings Sync**。刻意不加密:原文本來就以明文躺在同一台機器的 `~/.claude` 裡,本機多存一份不增加曝露面;放進備份庫則等於把金鑰推上 GitHub,正是遮蔽要避免的事。所以**其他電腦看到的永遠是標籤** —— 一把 API key 不該因為你換台電腦就自動複製過去。

要拿回原文,執行 **Session Backup: 還原遮蔽的金鑰...**,選檔案後確認即可。但先想清楚:金鑰一旦進過紀錄就該撤銷換發,還原它通常不是你要的。

## 命令

| 命令 | 說明 |
| --- | --- |
| `Session Backup: 立即備份` | 收集勾選的對話 → 掃描 → commit → push |
| `Session Backup: 連接 GitHub` | 建立或連結私人 repo |
| `Session Backup: 備份至 GitHub` | 建立第一份掃描過的備份並 push |
| `Session Backup: 同步並合併其他電腦紀錄...` | 備份本機、拉遠端並以 no-delete 規則合併 |
| `Session Backup: 管理 Claude 專案對應...` | 重新定位、開啟或移除專案對應 |
| `Session Backup: 管理要備份的對話...` | 檢視選取規則,勾選即可刪除 |
| `Session Backup: 還原遮蔽的金鑰...` | 把遮蔽的原文寫回本機對話紀錄 |
| `Session Backup: 開啟本地備份儲存庫資料夾` | 開啟備份庫 |
| `Session Backup: 顯示記錄` | 顯示輸出面板 |

## 設定

| 設定 | 預設 | 說明 |
| --- | --- | --- |
| `sessionBackup.repoPath` | `~/.session-backup-v2` | 本地備份庫路徑 |
| `sessionBackup.repoName` | `agent-session-backup` | 在 GitHub 建立的私人 repo 名稱 |
| `sessionBackup.machineId` | 自動(`主機名稱-短雜湊`) | 此電腦在備份庫中的識別名稱。machine-scoped,不被 Settings Sync 同步 |
| `sessionBackup.autoBackupMinutes` | `30` | 自動同步間隔,`0` 停用 |
| `sessionBackup.backupOnStartup` | `false` | 啟動時同步一次 |
| `sessionBackup.maxFileSizeMB` | `95` | 單檔上限(GitHub 硬限制 100 MB) |
| `sessionBackup.secretScan` | `true` | commit 前掃描疑似金鑰 |
| `sessionBackup.selectedSessions` | `[]` | 要備份的對話(白名單),建議從側邊欄核取方塊管理。規則:`tool:<tool>`、`claudeProject:<目錄名>`、`session:<tool>:<id>`,前綴 `-` 為排除。**會被 Settings Sync 同步** |
| `sessionBackup.sources` | `~/.claude`、`~/.codex` | 掃描根目錄 |

## 常見問題

### 勾了整個專案,為什麼裡面某個對話還是「未選取」?

因為那個對話上有一條**更具體**的排除規則,而它贏過專案層級的勾選。通常是先前在它身上取消過勾選,或金鑰掃描時選了「取消選取」,寫進了 `-session:<tool>:<id>`。

直接在側邊欄重新勾選那個對話即可,或執行 **Session Backup: 管理要備份的對話...**,找到開頭是「排除:」的那條規則刪掉。

### 取消勾選會刪掉 GitHub 上已經備份的內容嗎?

不會。備份庫是 no-delete 政策,`store/` 裡的舊 revision 一律保留,只是這個對話不再產生新的 revision。

但下次備份後它會從這台電腦的 `machines/<machine-id>/manifest.json` 中消失,所以**其他電腦不會再從這台電腦匯入它的新版本**(若那台電腦自己也備份過同一個對話,仍以它自己的 manifest 為準)。要真的清掉內容,得自己動手刪檔案並 commit。

### 勾一個 Codex 對話,底下的子代理 thread 也跟著勾走?

是的,而且是刻意的。Codex 子代理(`session_meta` 含 `parent_thread_id`)在備份端與父 thread 共用同一個 session id,是同一個備份單位,沒辦法只備份其中一邊。同理,同一個 thread 因 resume 產生的多個 rollout 檔也一起勾選。

### 「N 個 session 變更,共 M 個 sessions」為什麼不相等?

兩個數字算的是不同東西:前者是這次實際寫進 `store/` 的 **revision 檔案數**,後者是 manifest 的**條目數**(以本機檔案為單位)。

revision 路徑是 `store/<tool>/<session-id>/<sha256>.jsonl`。若同一份內容出現在兩個檔案位置 —— 最典型的是 Codex 把同一個 rollout 同時放在 `sessions/` 與 `archived_sessions/` —— 兩筆的 tool、id、hash 全同,指向同一個 revision,所以**只寫一次檔案但記兩筆 manifest**,數字就會差 1。

這是 content-addressed 去重的正常結果,不是漏備份,兩個路徑都能還原回來。

### 「連接 GitHub」沒讓我選 repo,直接叫我命名?

因為一個候選都沒找到。選單只在「候選 ≥ 2 個且沒有名稱剛好吻合」時才出現。備份庫是全新的、或 GitHub 上還沒有任何符合條件的 repo,就會直接進入命名步驟。

想連到既有的私人 repo,在輸入框打它的名字即可(見上方對照表);或先把 `sessionBackup.repoName` 設成目標名稱,再執行命令,那樣連問都不會問。

### 標成分叉衝突,但左右兩邊看起來一模一樣?

預覽只渲染對話內容,差異可能在沒有顯示的中繼欄位。比對時會忽略機器本地欄位(`session_meta.cwd`、`turn_context` 的 `cwd`/`workspace_roots`,以及匯入時補上的 `model_provider`),但其他任何欄位差一個字元都會判為分叉。

若確定兩邊等價,選**保留 B** 即可。另外請確認兩台電腦的擴充功能版本一致 —— 舊版少了某些欄位的忽略規則,會產生假衝突。

### 對話內部有分支(編輯訊息、回退)怎麼處理?

備份層面沒問題,原始 JSONL 原封不動存進 store。但 Markdown 預覽是線性掃過所有訊息,不解析 Claude Code 的 `parentUuid` 樹狀結構,所以被放棄的分支與最終分支會混在一起顯示。

### machineId 變了怎麼辦?

改主機名稱、重裝 VS Code、或手動設定 `sessionBackup.machineId`,都會讓 id 改變。擴充功能啟動時會偵測並把 `machines/<舊>/` 改名成 `machines/<新>/`,連 `resolutions.json`(保留本機的決定)一起搬,並更新 manifest 內的 `machineId` 欄位。結果寫在輸出面板。

只有一種情況不會自動處理:`machines/<新 id>/` 已經存在。那代表新 id 已有資料,搬過去會蓋掉別台電腦或先前的遷移結果,所以兩個目錄都留著,記錄裡會提示你自己確認是不是同一台電腦。

備份庫是 no-delete 政策,孤兒目錄不會自動消失 —— 若確定某個 `machines/<id>/` 已經沒用,要手動刪除並 commit。

### 刪掉本地備份庫會怎樣?

`~/.claude` 與 `~/.codex` 的原始檔不受影響。下次備份時 `ensureRepo` 會重建目錄並 `git init`,把本機 session 重新備份一遍;但 remote 設定存在 `.git/config`,一併刪掉後會變成沒有遠端的本地備份,需要重新執行**連接 GitHub**。

真正的風險是**只存在於備份庫、本機沒有原始檔的 session**(例如另一台電腦備份上來、這台從未匯入的對話),刪掉就沒了。動手前先確認。
