# CATPatrol — 相機陷阱巡檢 PWA 製作流程

> 本文件是給 AI 開發者（Claude Opus / Sonnet）的完整實作規格與流程。
> 需求已與使用者訪談確認完畢，**不要重新開需求訪談**；若遇到本文件未涵蓋的決策點，先提出選項再實作。
> UI 已有使用者核可的原型：[`ui-mockup.html`](ui-mockup.html)，實作時以它為視覺與流程基準。

---

## 0. 專案概述

生態相機陷阱（camera trap）野外巡檢紀錄工具。巡檢人員在山區（常無網路）用手機記錄每台相機的狀態、更換記憶卡/電池、拍攝現場照片；回到有網路處後，所有資料統一上傳到**專案擁有者的 Google 雲端**（Sheets + Drive）。多專案多團隊使用，使用者本身**免 Google 帳號**；網站僅限內部，名單內的人以 email 驗證碼登入（Cloudflare Access，2026-10-25 改）。

### 已確認規格（訪談結論，勿更動）

| 項目 | 決定 |
|---|---|
| 形式 | 手機瀏覽器直接開網頁使用，不安裝成 App；保留 Service Worker 讓離線可用（2026-10-25 改：原為 GitHub Pages + 加入主畫面） |
| 存取控管 | Cloudflare Workers（靜態網站）部署於 `https://catpatrol.a-wen90.workers.dev/`，前面加 Cloudflare Access（email 白名單＋驗證碼登入），外人看不到網頁；repo 改私人 |
| 平台 | 手機優先（Android 為主），瀏覽器通用 |
| 後端 | Google Apps Script Web App 當 API；紀錄寫入擁有者的 Google Sheets、照片存擁有者的 Drive |
| 使用者驗證 | ~~首次使用輸入巡檢人員姓名，存 localStorage~~ → 2026-10-31 改用 Cloudflare 登入 email 當身分（Worker 驗證後帶給 Apps Script），姓名查試算表「白名單」分頁，沒設定就用 email；同一帳號在電腦與手機都一樣，不再詢問姓名 |
| 樣點編號 | 2026-10-31 加：新增設備必填；地圖點位旁常駐顯示樣點編號，清單與巡檢選單也以它為主。原「設備編號」改稱**設備序號**（仍是 device_id）。更換相機時新相機沿用同一個樣點編號 |
| 錄影 | **不做**。照片為主 |
| 照片 | 上傳前壓縮（長邊 1600px、JPEG 品質約 0.8，目標 300–500KB） |
| QR code | ~~設備已有現成碼；新增設備時掃一次綁定編號~~ → 2026-10-25 **先拿掉**，設備編號一律手動輸入（`js/qr.js`、`lib/html5-qrcode.min.js` 與 scanbox/divider 樣式保留以便加回） |
| 相機型號 | 下拉：Meidase P70 / Meidase P60（2026-10-31 加，只查到 32MP、1296p/1080p）/ Meidase P60 Pro / Browning Spec Ops Elite HP5 Ultra（2026-10-25 加，選項與各型號畫質定義在 `js/cam-config.js`） |
| 座標 | 2026-10-31 改：一格輸入「緯度, 經度」（Google 地圖複製出來的格式，可直接貼 Google 搜尋），全形逗號或空白也可；經度寫在前面會提示。畫面上顯示也一律「緯度, 經度」。試算表仍是「經度｜緯度」兩欄（欄位不能搬） |
| 大字樣點編號 | 巡檢比對卡左邊顯示醒目的大字樣點編號（v0.2）。v0.1 曾顯示上次的照片，使用者要求**先不顯示照片**：前端已拿掉，後端保留 bootstrap 的 `lastPhotoId` 與 `GET /api/photo?id=`（只給照片索引裡登記過的檔案），之後要加回只需改前端 |
| 比對卡內容 | 上次巡檢的日期＋時間；記憶卡顯示「目前那張（上一張 X）」，上一張＝最近一次換卡取回的卡（bootstrap 由巡檢紀錄推出 `prevSdCard`，換機時新相機沿用）（v0.2） |
| 更換相機 | 巡檢時可「更換相機」：填新設備序號＋型號＋**更換原因（必填，2026-10-31 加）**，舊相機標「已撤下」並從清單隱藏，新相機接手位置、耗材與設定（2026-10-25 加）。已撤下的序號目前不能再用（重新部署同一台相機要等 CATBase 生命週期） |
| 記憶卡編號 | 2026-10-31 改：前綴下拉「野」或「Wv」＋號碼，存成一個字串（例 `野032`、`Wv12`）；巡檢換卡時前綴預設沿用目前那張卡 |
| 巡檢自動選樣點 | 2026-10-31 加：進巡檢分頁時依 GPS 選最近的樣點並以黃底醒目提示距離，選單依距離排序；使用者已動過表單就只提示不切換。從設備清單點進來的不自動選 |
| 未上傳紀錄可改可刪 | 2026-10-31 加：同步分頁中還沒上傳的巡檢紀錄有「修改／刪除」。佇列項目存 `undo`（巡檢前的設備現況）用來還原；同一台之後還有紀錄時，前一筆不能改。修改沿用原 record_id、巡檢時間與佇列位置；修改時按掉的照片存檔才刪 |
| 已上傳紀錄可改 | 2026-10-31 加：佇列裡還留著的已上傳紀錄（保留 7 天）也能「修改」（不能刪），送 `updateRecord` 覆蓋雲端該列；App 把算好的設備現況放在 `deviceState`，雲端在這筆仍是該設備最新巡檢時才覆蓋設備列。原本的照片已在雲端、本機沒有，修改時只能補拍；換機紀錄上傳後不能改，修改已上傳紀錄時也不能新加換機 |
| 自訂欄位 | 依專案自訂（勾選/單選/文字/數字），該專案所有設備巡檢表單共用 |
| 設備設定 | 結構化欄位（拍攝模式/照片畫質/連拍張數/影片畫質/影片秒數/感度/間隔秒（預設 0，2026-10-31 改）/工作時段/備註），首次必填，之後沿用，勾「有變動」才改。畫質選項隨型號；照片欄位只在照片模式顯示、影片欄位只在影片模式顯示；工作時段預設全天，可跨夜（2026-10-25 加畫質/秒數/工作時段） |
| 經緯度 | 同上：首次定位，之後沿用，勾「位置有變動」才重新定位 |
| 電量 | 下拉 100% / 75% / 50% / 25%（2026-10-25 改；原為數字 0–100），25% 算電量低。巡檢時預設沿用上次的電量（2026-10-31 改） |
| 運作狀態 | 巡檢開關「相機故障或沒電（現場無相機）」預設關（2026-10-31 改名；原「相機中斷（故障或沒電）」、更早是「設備持續運作中」）。試算表仍用「持續運作」欄，故障時寫 FALSE |
| 地圖顏色 | 2026-10-31 改：依多久沒巡——綠＝2 個月內、黃＝超過 2 個月、橘＝超過 3 個月、紅＝超過 4 個月（一個月以 30 天計），紫＝相機故障或沒電；電量低不另上色（清單徽章與點位說明看得到）。點位有備註時標籤加 📝，點開顯示最後一次巡檢的備註 |
| 版面 | 2026-10-31 加：寬度 ≥ 900px（電腦）時設備清單頁放寬到 1100px、地圖高 460px、卡片多欄；表單頁 760px；手機版不變。設備卡片與地圖點位說明都顯示序號、相機型號與最後備註。標題旁顯示網頁版本（`app.js` 的 APP_VERSION，與 `sw.js` VERSION 一起改；2026-10-31 起從 v0.1 開始編號） |
| 同步狀態 | 2026-10-31 加：首頁顯示「已與雲端同步（時間）」或登入過期／無法取得的警告；切回分頁（超過 1 分鐘）與重新連網時自動重拉 |
| 雲端版本檢查 | v0.2 加：code.gs 的 `VERSION` 由 bootstrap 回傳，前端 `BACKEND_NEEDED` 是這版網頁需要的最低版本；雲端較舊（或沒回版本＝v0.1 以前）時首頁紅字提醒到「管理部署作業」部署新版本。同步分頁顯示「網頁 vX · 雲端程式 vY」。只改前端時不用動 BACKEND_NEEDED |
| 電池類型 | 下拉選項：鹼性 / 鎳氫 / 鋰電 / 外接電源 |
| 離線 | 紀錄與照片存 IndexedDB；上傳規則三選一：任何網路 / 僅 WiFi / 手動 |
| 上次狀態比對 | 選擇設備後顯示上次巡檢摘要卡片 |
| 地圖 | 首頁 OSM（Leaflet）顯示該專案所有設備位置，狀態色標記＋定位自身位置按鈕 |

---

## 1. 開發環境限制（重要）

- **本機沒有 Node.js、沒有可用的 Python、沒有 gh CLI**。
- 因此：**純 vanilla HTML/CSS/JS，零建置步驟**。不用 framework、不用 bundler、不用 npm。
- 第三方函式庫下載成**本地檔案**放進 repo（離線 PWA 不能依賴 CDN）：
  - `lib/leaflet/`（leaflet.js + leaflet.css + images/，v1.9.x）
  - `lib/html5-qrcode.min.js`（QR 掃描，或 jsQR + 自寫 getUserMedia 迴圈，擇一）
- 本機預覽：Service Worker 需要 http(s)，`file://` 不行。用 PowerShell HttpListener 起簡易靜態伺服器（此環境慣用做法），或先以 `file://` 測非 SW 功能。
- 部署：GitHub 帳號 `win-hs`，repo `catpatrol`。git push 用 https + 使用者手動處理認證（無 gh CLI）。
  ~~GitHub Pages `https://win-hs.github.io/catpatrol/`~~ → 2026-10-25 改為 Cloudflare Workers 靜態網站（無建置步驟）＋ Cloudflare Access 擋外人，網址 `https://catpatrol.a-wen90.workers.dev/`。路徑全為相對路徑，從網站根目錄跑不用改程式。Worker 的 Preview URLs 要關掉或另外加 Access，否則預覽網址不受保護。

---

## 2. 系統架構

```
[手機瀏覽器網頁 (Cloudflare Workers + Access 登入)]
  ├─ UI（四分頁：設備/新增/巡檢/同步）
  ├─ IndexedDB：devices, records, photos, queue, fieldDefs, projects
  ├─ localStorage：巡檢人員姓名、上傳規則、API URL
  └─ Service Worker：App shell 快取 + OSM 圖磚快取
        │  fetch(POST JSON, 照片=base64)
        ▼
[Google Apps Script Web App]  ← 部署設定：以我(擁有者)身分執行、任何人可存取
  ├─ doGet：下發 projects / fieldDefs / devices（含最新狀態）
  └─ doPost：收 device 新增/更新、巡檢 record、照片
        │
        ├──> [Google Sheets「CATPatrol_資料庫」] 5 個分頁
        └──> [Google Drive「CATPatrol_照片」] 專案/設備/日期 資料夾
```

### 2.1 Google Sheets 結構（使用者已核可，勿改欄位名）

試算表名稱 `CATPatrol_資料庫`，5 個分頁：

**專案**：`project_id | 專案名稱 | 建立日期 | 狀態`

**設備**（每台一列＝目前最新狀態，巡檢上傳後更新）：
`device_id | project_id | QR碼內容 | 經度 | 緯度 | 記憶卡編號 | 電池類型 | 電量% | 拍攝模式 | 連拍張數 | 感度 | 間隔秒 | 設定備註 | 建立人員 | 建立時間 | 最後巡檢時間 | 最後巡檢人員 | 持續運作 | 最後備註 | 狀態 | 相機型號 | 照片畫質 | 影片畫質 | 影片秒數 | 工作時間`

> 2026-10-25 在最右邊追加 `相機型號 | 照片畫質 | 影片畫質 | 影片秒數 | 工作時間`（第 21–25 欄）；2026-10-31 再加 `樣點編號`（第 26 欄）。CATBase 的主檔欄因此順延到第 27 欄起（見 CATSpec\PLAN.md）。
>
> **白名單**（2026-10-31 新增分頁，人工維護）：`email | 姓名 | 加入日期 | 備註`。App 依登入 email 查姓名；CATBase 規劃的白名單即此表。`clearAllData()` 不清它。

> Phase 4 補上 `電量% / 最後巡檢人員 / 持續運作 / 最後備註`：原始欄位不足以讓 App 從 bootstrap
> 還原「上次巡檢狀態」比對卡與狀態徽章（狀態徽章需 電量% 與 持續運作，比對卡需人員與備註）。

**巡檢紀錄**（只增不改的流水帳）：
`record_id | 巡檢時間 | project_id | device_id | 巡檢人員 | 持續運作 | 更換記憶卡 | 新記憶卡編號 | 取回記憶卡編號 | 更換電池 | 新電池類型 | 電量% | 設定有變動 | 新設定摘要 | 位置有變動 | 經度 | 緯度 | 照片張數 | 照片資料夾連結 | 備註 | 自訂欄位JSON | 上傳時間 | 更換相機 | 新設備編號 | 新相機型號 | 更換原因 | 樣點編號`（更換相機～新相機型號 2026-10-25 加；更換原因、樣點編號 2026-10-31 加）

**自訂欄位定義**：`project_id | 欄位名稱 | 類型(勾選/單選/文字/數字) | 選項(逗號分隔) | 必填 | 排序 | field_id`
（`field_id` 為 Phase 4 補上：欄位定義需可更新，靠它比對是新增還是修改）

**照片索引**：`photo_id | record_id | device_id | 拍攝時間 | Drive檔案連結 | 檔名`

規則：
- `record_id` = `REC-{yyyyMMdd-HHmmss}-{3碼隨機}`，**手機離線時產生**；後端以它去重（重送不重複寫入）。
- 設定/位置「沒變動」→ 紀錄列該欄留空＝沿用；「有變動」→ 填新值並同步更新「設備」分頁。
- 「設備」分頁的`狀態`欄由後端依最新紀錄計算：`正常`（持續運作 且 電量>25）/`電量低`（電量≤25）/`異常`（未持續運作）/`已撤下`（被更換掉的相機，bootstrap 回傳 `retired:true`，App 不再顯示）。前端另計算`待巡檢`（>60 天未巡檢），不寫回表。
- 更換相機的紀錄：該筆紀錄的 device_id 是舊相機；後端把舊相機列標`已撤下`，另起一列給新相機（複製舊列的位置/耗材/設定，再套用本次變動）。
- 照片檔名：`{device_id}_{yyyyMMdd}_{HHmm}_{序號}.jpg`；Drive 路徑 `CATPatrol_照片/{專案名稱}/{device_id}/{yyyy-MM-dd}/`。

### 2.2 Apps Script API 介面

單一 Web App，用 `action` 參數分流。回傳一律 JSON `{ok:true, ...}` 或 `{ok:false, error:"..."}`。

> 2026-10-25 起 App 不直接呼叫 Apps Script：手機打同網域的 `GET /api/bootstrap`、`POST /api/write`，
> 由 Cloudflare Worker（`worker/index.js`）驗證 Access 登入憑證後，把 token 放進網址參數代轉
> （body 不解析、原封轉送）。Apps Script 網址與 token 只存在 Worker secrets（`APPS_SCRIPT_URL`、`API_TOKEN`）。
> 登入過期時 Worker 回 401 或 Access 302，App 顯示「重新登入」，資料留在佇列。

- `GET ?action=bootstrap` → `{projects:[...], fieldDefs:[...], devices:[...]}`（App 啟動/手動重新整理時同步下來，存 IndexedDB 供離線用）
- `POST {action:"addDevice", device:{...}, photos:[{name, dataBase64}...]}`
- `POST {action:"addRecord", record:{...}, photos:[...]}` → 寫巡檢紀錄＋更新設備分頁＋存照片＋寫照片索引
- `POST {action:"addProject", name}`、`POST {action:"saveFieldDefs", projectId, defs:[...]}`

實作注意：
- Apps Script 免費配額：URL Fetch 無關（是別人打進來）；重點是**單次執行 6 分鐘上限**與 POST body ~50MB。照片一張約 400KB base64 後 ~550KB，**一筆紀錄連照片一起送沒問題**，但佇列上傳要「一筆一請求」，不要合批。
- `doPost` 用 `LockService` 防止並發寫入撞列。
- 去重：寫入前用 `record_id` 在「巡檢紀錄」分頁查重（可用 TextFinder），已存在則回 `{ok:true, dedup:true}`。
- CORS：Apps Script 不能自訂 header。前端 fetch 用 `Content-Type: text/plain` 送 JSON 字串（避免 preflight），Apps Script 端 `JSON.parse(e.postData.contents)`。回應用 `ContentService` + `MimeType.JSON`。
- 部署方式（需使用者手動操作的部分，寫清楚步驟給使用者照做）：script.google.com 新專案 → 貼 code.gs → 部署 → 新增部署作業 → 類型「網頁應用程式」→ 執行身分「我」→ 存取權「任何人」→ 複製網址填入前端設定頁。

### 2.3 前端離線與同步

IndexedDB（自寫 ~80 行 promise wrapper 即可，不引函式庫）：
- `projects`, `devices`, `fieldDefs`：bootstrap 下來的快取（供離線瀏覽與「上次狀態」比對）
- `queue`：待上傳項目 `{id, type:'addDevice'|'addRecord', payload, photoIds:[], createdAt, status:'pending'|'uploading'|'done'|'error', retries}`
- `photos`：`{photoId, blob(壓縮後), name}` — Blob 直接存 IndexedDB，上傳時才轉 base64

同步邏輯：
- 上傳規則存 localStorage：`any` / `wifi` / `manual`
- WiFi 判定：`navigator.connection.type === 'wifi'`（Android Chrome 可用）；API 不存在時退化為「有網路就算」，並在設定頁顯示提示
- 觸發時機：App 開啟時、`online` 事件、完成巡檢後、設定頁「立即全部上傳」按鈕
- 逐筆上傳：成功 → 標 `done`（保留 7 天後自動清除，照片 blob 立即刪除；同步分頁另有「清除已上傳的項目」按鈕可手動清空，2026-10-25 加）；失敗 → `retries+1`，指數退避，UI 顯示「上傳失敗，可重試」
- **不做雙向即時同步**：`bootstrap` 是「拉最新」、queue 是「推本地」，衝突原則＝紀錄流水帳只增不改所以無衝突；設備現況以「巡檢時間較新者勝」（後端寫入時比對`最後巡檢時間`）
- `bootstrap` 時雲端已沒有的專案、自訂欄位、設備，本機也刪除（2026-10-25 加：擁有者 clearAllData 後各手機要跟著清空）；佇列中待上傳的項目與其專案不刪
- `bootstrap` 時設備一律以雲端為準，只有該設備還有待上傳紀錄時才保留本機版本（2026-10-31 改：原本「本機巡檢時間較新就不覆蓋」會讓試算表上手動改的樣點編號傳不下來）

照片壓縮：`<input type="file" accept="image/*" capture="environment">` → createImageBitmap → canvas 縮至長邊 1600px → `toBlob('image/jpeg', 0.8)`。

Service Worker：
- App shell（html/css/js/lib/icons）：cache-first，版本號更新
- OSM 圖磚 `tile.openstreetmap.org`：stale-while-revalidate + 上限（如 500 磚，LRU 清除），讓巡檢前看過的區域離線可用
- API 請求：不快取，直接 network（失敗由 queue 機制處理）

### 2.4 UI 規格

以 [`ui-mockup.html`](ui-mockup.html) 為準（含配色、卡片樣式、四分頁結構）。重點行為：

1. **設備分頁**：專案下拉；雲端同步狀態；OSM 地圖（顏色見上表「地圖顏色」、樣點編號常駐標籤；點標記彈出摘要與備註；右上角📍定位自身）；設備卡片列表（點卡片→巡檢分頁並帶入該設備）；「＋新增設備」按鈕。
2. **新增分頁**：專案、樣點編號、設備序號（手動輸入）、相機型號、巡檢人員與時間自動帶入唯讀、GPS 一鍵定位（顯示精度）、記憶卡編號、電池類型下拉、電量、結構化設備設定、架設照片、儲存→進 queue。
3. **巡檢分頁**：GPS 自動選最近樣點（或下拉選）→帶出「上次巡檢狀態」綠底比對卡；本次表單：相機故障或沒電開關、更換相機開關（開→新設備序號＋型號＋原因；換成不同型號時自動打開「設定有變動」）、更換記憶卡開關（開→展開新卡編號欄，自動顯示並記錄取回卡=上次卡號）、更換電池開關（開→展開新電池類型下拉）、電量%、「設定有變動」開關（開→展開設定欄位，預填上次值）、「位置有變動」開關（開→重新 GPS 定位）、專案自訂欄位（依 fieldDefs 動態生成）、現場照片、備註、完成→存 queue。
4. **同步分頁**：離線/在線狀態提示、上傳佇列列表（待上傳/上傳中/已上傳/失敗重試；未上傳的巡檢紀錄可修改／刪除）、「立即全部上傳」、上傳規則三段切換、登入帳號顯示（~~巡檢人員姓名編輯~~ 2026-10-31 移除）、專案自訂欄位管理（列表＋新增：名稱/類型/選項/必填）、登入過期時的「重新登入」按鈕（~~API 網址設定~~ 2026-10-25 移除，改由 Cloudflare 代轉）。

必填驗證：樣點編號、設備序號、相機型號、記憶卡號碼、（首次）經緯度與設備設定（含顯示中的畫質、影片秒數、指定工作時段的起訖）、自訂欄位標必填者。

---

## 3. 實作階段（依序執行，每階段先驗證再進下一階段）

> 遵循 goal-driven：每階段結尾列出「驗證」，全部通過才算完成。用瀏覽器面板實測，不要只靠讀 code。

### Phase 1 — 靜態 App Shell 與導覽
從 mockup 拆出正式檔案結構：
```
catpatrol/
├─ public/             # 網站本身（2026-10-25 從 repo 根目錄搬進來，Cloudflare 只公開這個資料夾）
│  ├─ index.html       # 單頁，四個 screen
│  ├─ css/app.css
│  ├─ js/app.js        # 導覽與初始化
│  ├─ js/db.js         # IndexedDB wrapper
│  ├─ js/store.js      # 狀態管理（目前專案/設備/人員）
│  ├─ js/api.js        # /api fetch 封裝（經 Worker 代轉）
│  ├─ js/sync.js       # queue 與上傳規則
│  ├─ js/camera.js     # 拍照+壓縮
│  ├─ js/cam-config.js # 相機型號與設備設定欄位（畫質/秒數/工作時段）
│  ├─ js/qr.js         # QR 掃描（目前未使用）
│  ├─ js/map.js        # Leaflet 地圖
│  ├─ js/form.js       # 表單生成（含自訂欄位）與驗證
│  ├─ sw.js            # Service Worker
│  ├─ manifest.webmanifest
│  ├─ lib/…            # leaflet、html5-qrcode 本地檔
│  └─ icons/           # icon 192/512
├─ worker/index.js     # Cloudflare Worker：驗證 Access 登入後代轉 /api 到 Apps Script
├─ wrangler.jsonc      # Worker 設定（Workers Builds 依此部署）
├─ tests/              # node tests/worker.test.mjs、node tests/codegs.test.mjs；mock-server.mjs 供本機畫面測試（不會部署）
└─ apps-script/code.gs # 後端原始碼（放 repo 存查，部署時貼到 script.google.com）
```
**驗證**：本機 http 伺服器開啟，四分頁切換正常、mockup 視覺還原、手機寬度 RWD 正常、無 console 錯誤。

### Phase 2 — 本地資料層（先做到完全離線可用）
db.js + store.js + form.js：專案/設備 CRUD 全部先寫 IndexedDB；新增設備、巡檢表單（含上次狀態比對、開關展開邏輯、自訂欄位動態生成、驗證）、巡檢人員 localStorage、queue 寫入。此階段不碰網路。
**驗證**：關閉網路，新增專案→自訂欄位→新增設備→巡檢該設備（看得到上次狀態）→ queue 出現待上傳項目；重新整理頁面資料仍在；自訂欄位必填擋得住空值。

### Phase 3 — 拍照壓縮與 QR 掃描
camera.js（拍照→壓縮→blob 存 IndexedDB→縮圖顯示/刪除）、qr.js（掃碼綁定＋巡檢選機，掃到未知碼提示新增）。
**驗證**：手機實測（Pages 或區網 https）拍照後檢查 blob 尺寸 <600KB、長邊 1600px；掃實體 QR 碼能帶出設備。桌機至少驗證檔案選取路徑與壓縮數值。

### Phase 4 — Apps Script 後端
apps-script/code.gs：bootstrap/addDevice/addRecord/addProject/saveFieldDefs、Sheets 初始化（首次執行自動建 5 分頁與表頭）、Drive 資料夾建立、照片寫入、record_id 去重、LockService、設備現況更新與狀態計算。
同時寫一份 `apps-script/DEPLOY.md`：給使用者的部署步驟（建 script → 貼 code → 部署設定 → 拿網址 → 填入 App 設定頁），一步一截圖說明等級的細緻度。
**驗證**：用 PowerShell `Invoke-RestMethod` 直接打部署網址：bootstrap 回 JSON；addRecord 兩次同 record_id 只寫一列；Sheets 出現正確資料、Drive 出現資料夾與照片。

### Phase 5 — 同步串接
sync.js：上傳規則、觸發時機、逐筆上傳、重試退避、佇列 UI 狀態、bootstrap 下拉合併到 IndexedDB。
**驗證**：離線建 2 筆紀錄→恢復網路→自動上傳→Sheets/Drive 檢查內容正確、設備分頁現況已更新；「僅 WiFi」模式下用行動網路模擬（DevTools 或實機）不上傳；手動模式只有按按鈕才傳。

### Phase 6 — 地圖與 PWA 完成度
map.js（bootstrap 的設備座標上圖、狀態色、定位按鈕）、sw.js（shell 快取、圖磚快取、版本更新提示）、manifest（名稱 CATPatrol、主題色 #1b4332、standalone）。
**驗證**：Lighthouse PWA 檢查通過（可安裝）；離線重新整理 App 照常開；離線時地圖顯示已快取圖磚與所有標記；「加入主畫面」後全螢幕開啟。

### Phase 7 — 部署與實機驗收
~~push 到 `win-hs/catpatrol` → 開 Pages~~（已完成，2026-10-25 改為搬到 Cloudflare Workers + Access，搬完關閉 GitHub Pages、repo 改私人）→ 手機 Android Chrome 實測完整流程：無痕視窗確認外人只看到登入頁→名單內 email 收碼登入→設 API 網址→bootstrap→新增設備（掃碼+GPS+拍照）→關網路巡檢（瀏覽器分頁內，離線重新整理仍可開）→回 WiFi 自動上傳→Sheets/Drive 核對。
**驗證**：上述全流程一次通過；把測試產生的假資料清乾淨，留一組示範專案。

---

## 4. 給實作模型的注意事項

- 每個 js 檔保持單一職責，全域用一個 `App` namespace 或 ES modules（Pages 支援，注意 `type="module"`）。
- 所有使用者可見文字用**繁體中文**。日期格式 `yyyy-MM-dd HH:mm`，時區取手機本地時間。
- 錯誤處理原則：離線/上傳失敗是**常態不是例外**，UI 永遠告訴使用者「資料存在手機很安全」；真正致命的只有 IndexedDB 寫入失敗（要 alert）。
- 不要引入本文件沒列的函式庫；不要加本文件沒有的功能（錄影、帳號系統、推播等都不做）。
- API 網址等機密不 hardcode：存 localStorage，repo 裡只放 placeholder。Apps Script 網址本身公開也無妨（它只能寫入固定試算表），但仍建議 code.gs 內加一個簡單共享 token 檢查（token 由使用者部署時自訂，App 設定頁一併填入）。
- 完成每個 Phase 後 git commit 一次，訊息寫明 Phase 編號。
- **改動任何 shell 檔案（html/css/js）後，務必同時把 `sw.js` 的 `VERSION` 加一版**。
  Service Worker 是 cache-first，不改版號的話已安裝的手機會永遠吃舊快取，更新送不出去。
- **CSS 的 `*{margin:0}` 會蓋掉瀏覽器用來置中 `<dialog>` 的 `margin:auto`**，dialog 會卡在左上角。
  `dialog{margin:auto}` 已修好，勿再移除。純用 JS 驗證（`dialog.open === true`）看不出這個問題，
  版面相關的改動要實際看畫面。
