# SSA Match Alerts (Sgameschedule)

iPhone 主畫面 PWA：SSA MAG2 賽程表，開賽前 **20 分鐘** 推送通知（App 關咗都收到）。

- 前端：`public/`（HTML + Service Worker + manifest）
- 後端：Cloudflare Worker（`src/`），每分鐘 cron 檢查有冇提醒要發
- 資料：Durable Object（SQLite），儲賽程、已登記裝置、已發記錄、發送 log
- 推送：Web Push（VAPID + aes128gcm），純 WebCrypto 實作（`src/webpush.js`），冇外部依賴

## 部署（Cloudflare dashboard，連 GitHub 自動部署）

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Import a repository** → 揀 `kinfaicheungai/Sgameschedule`
2. Build 設定用預設（Deploy command：`npx wrangler deploy`）→ Deploy
3. 部署完：Worker → **Settings → Variables and Secrets** → 加兩個 **Secret**：
   - `APP_TOKEN` — 你嘅管理密碼
   - `VAPID_PRIVATE_KEY` — VAPID 私鑰（對應 `wrangler.toml` 入面嘅 `VAPID_PUBLIC_KEY`）
4. 之後每次 push 去 `main` 都會自動重新部署；Secrets 會保留。

> **唔好將 `APP_TOKEN` 或 `VAPID_PRIVATE_KEY` commit 落 GitHub。**
> 換 VAPID key 要同時改 `wrangler.toml` 嘅公鑰同 Secret 私鑰，之後 iPhone 要再按一次「啟用通知」。

## iPhone 安裝

1. 用 **Safari** 開 Worker 網址（`https://sgameschedule.<你的帳戶>.workers.dev`）
2. 分享 → **加入主畫面**
3. 由主畫面打開 App（唔係 Safari 分頁）
4. 輸入 APP_TOKEN → **載入賽程**
5. **啟用通知** → 允許 → **發送測試通知**
6. 「已登記裝置」應該顯示 1；Focus / 勿擾模式可能會收埋通知

## 賽程（通用，任何比賽都用得）

右上角「管理」：

- **匯入**：上載 CSV / Excel（.xlsx/.xls），貼上表格，或者連 Google Sheet（可每 15 分鐘自動同步）。匯入前會先預覽，讀唔到嘅行會列出嚟。
- **編輯**：逐場改時間、隊伍、Channel、備註、提醒開關。
- **通知**：開啟通知、即時測試、2 分鐘後背景測試、最近發送紀錄。
- **設定**：賽事名稱、App 標題、提前幾多分鐘、第三欄名稱（Channel / Court / 場地）、通知 emoji、時區。

格式說明喺 App 右上角「?」。解析邏輯喺 `public/parse.js`（瀏覽器同 Worker 共用）。
時間以設定嘅時區計，夏令時間自動處理。改咗開賽時間嘅場次會重新觸發提醒。Google Sheet 讀唔到嗰陣唔會清走現有賽程。

## 提醒規則

- 開賽前 N 分鐘（設定，預設 20）起 5 分鐘內發送（cron 每分鐘檢查）；過咗呢個時段唔會補發舊提醒
- 每場只發一次；如果全部裝置都發唔到，下一分鐘會再試（直至時段結束）
- 已失效嘅裝置（404/410）會自動移除
- App 內會顯示伺服器上次檢查時間、已登記裝置數、下一個提醒

## 本地開發

```
npm install
cp .dev.vars.example .dev.vars   # 填 APP_TOKEN / VAPID_PRIVATE_KEY
npm run dev                      # http://localhost:8787
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"   # 手動觸發 cron
```
