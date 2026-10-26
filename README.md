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

## 賽程

預載咗 5 場已確認賽事。其餘場次請用「編輯排期 → 批量匯入 CSV」（會取代現有排期，之後要按「儲存排期」）：

```
2026-10-27 11:45,NT,QLD,4
2026-10-29 10:45,SA,QLD,2
```

時間係 Sydney 當地時間，夏令時間（AEDT/AEST）自動處理。改咗開賽時間嘅場次會重新觸發提醒。

## 提醒規則

- 開賽前 20 分鐘至前 15 分鐘之間發送（cron 每分鐘檢查）；過咗呢個時段唔會補發舊提醒
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
