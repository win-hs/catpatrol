# CATPatrol — 相機陷阱巡檢 PWA 製作流程

> 本文件是給 AI 開發者（Claude Opus / Sonnet）的完整實作規格與流程。
> 需求已與使用者訪談確認完畢，**不要重新開需求訪談**；若遇到本文件未涵蓋的決策點，先提出選項再實作。
> UI 已有使用者核可的原型：[`ui-mockup.html`](ui-mockup.html)，實作時以它為視覺與流程基準。

---

## 0. 專案概述

生態相機陷阱（camera trap）野外巡檢紀錄工具。巡檢人員在山區（常無網路）用手機記錄每台相機的狀態、更換記憶卡/電池、拍攝現場照片；回到有網路處後，所有資料統一上傳到**專案擁有者的 Google 雲端**（Sheets + Drive）。多專案多團隊使用，使用者本身**免登入、免 Google 帳號**。

### 已確認規格（訪談結論，勿更動）

| 項目 | 決定 |
|---|---|
| 形式 | PWA（GitHub Pages 部署、加入主畫面、離線可用） |
| 平台 | 手機優先（Android 為主），瀏覽器通用 |
| 後端 | Google Apps Script Web App 當 API；紀錄寫入擁有者的 Google Sheets、照片存擁有者的 Drive |
| 使用者驗證 | 無帳號系統；首次使用輸入巡檢人員姓名，存 localStorage，之後自動帶入 |
| 錄影 | **不做**。照片為主 |
| 照片 | 上傳前壓縮（長邊 1600px、JPEG 品質約 0.8，目標 300–500KB） |
| QR code | 設備已有現成碼；新增設備時掃一次綁定編號。App 不產碼 |
| 自訂欄位 | 依專案自訂（勾選/單選/文字/數字），該專案所有設備巡檢表單共用 |
| 設備設定 | 結構化欄位（拍攝模式/連拍張數/感度/間隔秒/備註），首次必填，之後沿用，勾「有變動」才改 |
| 經緯度 | 同上：首次定位，之後沿用，勾「位置有變動」才重新定位 |
| 電量 | 百分比數字 0–100 |
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
- 部署：GitHub 帳號 `win-hs`，建 repo `catpatrol` → Settings 開 GitHub Pages（main branch）→ `https://win-hs.github.io/catpatrol/`。git push 用 https + 使用者手動處理認證（無 gh CLI）。

---

## 2. 系統架構

```
[手機 PWA (GitHub Pages)]
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
`device_id | project_id | QR碼內容 | 經度 | 緯度 | 記憶卡編號 | 電池類型 | 電量% | 拍攝模式 | 連拍張數 | 感度 | 間隔秒 | 設定備註 | 建立人員 | 建立時間 | 最後巡檢時間 | 最後巡檢人員 | 持續運作 | 最後備註 | 狀態`

> Phase 4 補上 `電量% / 最後巡檢人員 / 持續運作 / 最後備註`：原始欄位不足以讓 App 從 bootstrap
> 還原「上次巡檢狀態」比對卡與狀態徽章（狀態徽章需 電量% 與 持續運作，比對卡需人員與備註）。

**巡檢紀錄**（只增不改的流水帳）：
`record_id | 巡檢時間 | project_id | device_id | 巡檢人員 | 持續運作 | 更換記憶卡 | 新記憶卡編號 | 取回記憶卡編號 | 更換電池 | 新電池類型 | 電量% | 設定有變動 | 新設定摘要 | 位置有變動 | 經度 | 緯度 | 照片張數 | 照片資料夾連結 | 備註 | 自訂欄位JSON | 上傳時間`

**自訂欄位定義**：`project_id | 欄位名稱 | 類型(勾選/單選/文字/數字) | 選項(逗號分隔) | 必填 | 排序 | field_id`
（`field_id` 為 Phase 4 補上：欄位定義需可更新，靠它比對是新增還是修改）

**照片索引**：`photo_id | record_id | device_id | 拍攝時間 | Drive檔案連結 | 檔名`

規則：
- `record_id` = `REC-{yyyyMMdd-HHmmss}-{3碼隨機}`，**手機離線時產生**；後端以它去重（重送不重複寫入）。
- 設定/位置「沒變動」→ 紀錄列該欄留空＝沿用；「有變動」→ 填新值並同步更新「設備」分頁。
- 「設備」分頁的`狀態`欄由後端依最新紀錄計算：`正常`（持續運作 且 電量>40）/`電量低`（電量≤40）/`異常`（未持續運作）。前端另計算`待巡檢`（>60 天未巡檢），不寫回表。
- 照片檔名：`{device_id}_{yyyyMMdd}_{HHmm}_{序號}.jpg`；Drive 路徑 `CATPatrol_照片/{專案名稱}/{device_id}/{yyyy-MM-dd}/`。

### 2.2 Apps Script API 介面

單一 Web App，用 `action` 參數分流。回傳一律 JSON `{ok:true, ...}` 或 `{ok:false, error:"..."}`。

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
- 逐筆上傳：成功 → 標 `done`（保留 7 天供查閱後清除，照片 blob 隨之刪除）；失敗 → `retries+1`，指數退避，UI 顯示「上傳失敗，可重試」
- **不做雙向即時同步**：`bootstrap` 是「拉最新」、queue 是「推本地」，衝突原則＝紀錄流水帳只增不改所以無衝突；設備現況以「巡檢時間較新者勝」（後端寫入時比對`最後巡檢時間`）

照片壓縮：`<input type="file" accept="image/*" capture="environment">` → createImageBitmap → canvas 縮至長邊 1600px → `toBlob('image/jpeg', 0.8)`。

Service Worker：
- App shell（html/css/js/lib/icons）：cache-first，版本號更新
- OSM 圖磚 `tile.openstreetmap.org`：stale-while-revalidate + 上限（如 500 磚，LRU 清除），讓巡檢前看過的區域離線可用
- API 請求：不快取，直接 network（失敗由 queue 機制處理）

### 2.4 UI 規格

以 [`ui-mockup.html`](ui-mockup.html) 為準（含配色、卡片樣式、四分頁結構）。重點行為：

1. **設備分頁**：專案下拉；OSM 地圖（狀態色標記：綠=正常、橘=電量低/待巡檢、紅=異常；點標記彈出摘要；右上角📍定位自身）；設備卡片列表（點卡片→巡檢分頁並帶入該設備）；「＋新增設備」按鈕。
2. **新增分頁**：專案、設備編號（手動輸入或「掃碼綁定」開相機掃現成 QR）、巡檢人員與時間自動帶入唯讀、GPS 一鍵定位（顯示精度）、記憶卡編號、電池類型下拉、電量、結構化設備設定、架設照片、儲存→進 queue。
3. **巡檢分頁**：「掃描 QR code」按鈕（**預設收合**，點了才開掃描視窗）或手動下拉選設備→帶出「上次巡檢狀態」綠底比對卡；本次表單：持續運作開關、更換記憶卡開關（開→展開新卡編號欄，自動顯示並記錄取回卡=上次卡號）、更換電池開關（開→展開新電池類型下拉）、電量%、「設定有變動」開關（開→展開設定欄位，預填上次值）、「位置有變動」開關（開→重新 GPS 定位）、專案自訂欄位（依 fieldDefs 動態生成）、現場照片、備註、完成→存 queue。
4. **同步分頁**：離線/在線狀態提示、上傳佇列列表（待上傳/上傳中/已上傳/失敗重試）、「立即全部上傳」、上傳規則三段切換、巡檢人員姓名編輯、專案自訂欄位管理（列表＋新增：名稱/類型/選項/必填）、API 網址設定（首次設定時貼 Apps Script 部署網址）。

必填驗證：設備編號、記憶卡編號、（首次）經緯度與設備設定、自訂欄位標必填者。掃描到未知 QR 碼時提示「查無此設備，是否新增？」→ 跳新增分頁預填碼內容。

---

## 3. 實作階段（依序執行，每階段先驗證再進下一階段）

> 遵循 goal-driven：每階段結尾列出「驗證」，全部通過才算完成。用瀏覽器面板實測，不要只靠讀 code。

### Phase 1 — 靜態 App Shell 與導覽
從 mockup 拆出正式檔案結構：
```
catpatrol/
├─ index.html          # 單頁，四個 screen
├─ css/app.css
├─ js/app.js           # 導覽與初始化
├─ js/db.js            # IndexedDB wrapper
├─ js/store.js         # 狀態管理（目前專案/設備/人員）
├─ js/api.js           # Apps Script fetch 封裝
├─ js/sync.js          # queue 與上傳規則
├─ js/camera.js        # 拍照+壓縮
├─ js/qr.js            # QR 掃描
├─ js/map.js           # Leaflet 地圖
├─ js/form.js          # 表單生成（含自訂欄位）與驗證
├─ sw.js               # Service Worker
├─ manifest.webmanifest
├─ lib/…               # leaflet、html5-qrcode 本地檔
├─ icons/              # PWA icon 192/512（簡單 SVG 轉 PNG 或手繪風格皆可）
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
push 到 `win-hs/catpatrol` → 開 Pages → 手機 Android Chrome 實測完整流程：安裝→設 API 網址→bootstrap→新增設備（掃碼+GPS+拍照）→關網路巡檢→回 WiFi 自動上傳→Sheets/Drive 核對。
**驗證**：上述全流程一次通過；把測試產生的假資料清乾淨，留一組示範專案。

---

## 4. 給實作模型的注意事項

- 每個 js 檔保持單一職責，全域用一個 `App` namespace 或 ES modules（Pages 支援，注意 `type="module"`）。
- 所有使用者可見文字用**繁體中文**。日期格式 `yyyy-MM-dd HH:mm`，時區取手機本地時間。
- 錯誤處理原則：離線/上傳失敗是**常態不是例外**，UI 永遠告訴使用者「資料存在手機很安全」；真正致命的只有 IndexedDB 寫入失敗（要 alert）。
- 不要引入本文件沒列的函式庫；不要加本文件沒有的功能（錄影、帳號系統、推播等都不做）。
- API 網址等機密不 hardcode：存 localStorage，repo 裡只放 placeholder。Apps Script 網址本身公開也無妨（它只能寫入固定試算表），但仍建議 code.gs 內加一個簡單共享 token 檢查（token 由使用者部署時自訂，App 設定頁一併填入）。
- 完成每個 Phase 後 git commit 一次，訊息寫明 Phase 編號。
