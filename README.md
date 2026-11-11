# 影片下載器（GitHub Actions 版）

一個**沒有後端**的影片下載器：純靜態網頁放在 GitHub Pages，按下下載後由 GitHub Actions 的機器執行 `yt-dlp`，完成後把檔案打包成 zip artifact 讓你下載。

```
瀏覽器 (GitHub Pages)
   │  1. 貼上網址 → REST API 觸發
   ▼
GitHub Actions（ubuntu-latest）
   │  2. yt-dlp + ffmpeg 下載、轉檔
   ▼
Artifact zip（保留 1 天）──► 3. 瀏覽器下載
```

## 為什麼不能純前端下載

YouTube、B站、TikTok 的串流位址有簽名與 CORS 限制，瀏覽器直接抓不到、也不能解密。下載一定要在擁有完整網路權限的機器上跑，所以這裡用 Actions 當那個「機器」。

## 部署（約 5 分鐘）

1. **Fork / 推上 GitHub** 這個 repo。
2. **啟用 Pages**：Settings → Pages → Source 選 `Deploy from a branch`，Branch `main`、資料夾 `/docs`。
3. **允許 Actions**：Settings → Actions → General → 選 `Allow all actions and reusable workflows`。
4. **建 token**：頭像 → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token
   - Repository access：只選這一個 repo
   - Permissions：**Actions: Read and write**（這是唯一需要的權限）
5. 打開 Pages 網址（`https://<你>.github.io/<repo>/`），在「連線設定」填入 owner / repo / token，按「測試連線」。

> Token 存在瀏覽器 localStorage，頁面不會把它送到任何第三方。風險是：拿到 token 的人可以觸發這個 repo 的 workflow。建議用完就撤銷，或按「清除 token」。

## 本機使用

```bash
# 1. 起一個靜態伺服器（本機測試用，不影響 Pages）
python3 -m http.server 8000 -d docs
# 打開 http://127.0.0.1:8000

# 2. 也可以不用網頁，直接在本機跑
pip install "yt-dlp[default]"
INPUT_URL='https://www.youtube.com/watch?v=…' INPUT_MODE=video INPUT_QUALITY=1080 \
  bash scripts/download.sh
```

先在 Actions 頁面手動 Run workflow 試一次，能跑通再接網頁。

## 參數

| 參數 | 值 | 說明 |
| --- | --- | --- |
| `mode` | `video` / `audio` | `audio` 用 ffmpeg 轉成 mp3 |
| `quality` | `best` `2160` `1440` `1080` `720` `480` `360` | 找 ≤ 指定高度的最佳影片軌；該高度不存在時自動往下找 |
| `subtitles` | `no` / `yes` | 只抓人工字幕，轉成 srt |
| `playlist` | `no` / `yes` | 預設只下單片，避免誤抓整份播放清單 |
| `YTDLP_COOKIES` | repo secret（選用） | Netscape 格式 cookies.txt，給需要登入的內容（抖音、IG、私人播放清單）用 |
| `ALLOWED_HOSTS` | repo variable（選用） | 例如 `youtube.com,bilibili.com`，只允許清單內的網域，避免有人拿你的 repo 跑別的站 |

## 限制與風險（先看清楚）

- **速度**：每次都要排隊＋啟動 runner＋安裝環境，通常 **1–3 分鐘**，不是即時下載。
- **進度**：Actions 拿不到逐位元組進度，網頁上的進度條是「排隊 / 執行中（計時）/ 完成」的真實階段。詳細日誌在 Actions 頁面。
- **保存期限**：artifact 只保留 **1 天**（workflow 裡設定，可改成 `retention-days: 7`）。
- **大小**：單一 artifact 上限 2 GB；約 15 分鐘以上的 4K 影片可能超過 runner 磁碟。
- **時長**：`timeout-minutes: 40`，超過就失敗。
- **隱私**：公開 repo 的話，你的下載網址會出現在 Actions run 名稱裡（任何人可見）。要低調就把 repo 設為 private（private repo 的 Actions 會吃免費額度，公開 repo 不限）。
- **額度**：公開 repo 的 Actions 免費；private repo 每月 2000 分鐘（免費方案）。
- **特定網站**：YouTube 偶爾會擋資料中心的 IP，失敗時看日誌；抖音/IG 幾乎一定需要 cookies。
- **合規**：只下載你有權取得的內容，遵守平台條款與當地著作權法。

## 檔案結構

```
docs/                     # GitHub Pages 靜態前端
  index.html
  app.js                  # 觸發、輪詢、下載 artifact
  styles.css
.github/workflows/download.yml   # 真正的下載工作
scripts/download.sh       # yt-dlp 參數組裝
```

## 授權

MIT

## 疑難排解

- **`This video is unavailable`**：先確認影片本身還在。若影片正常，多半是缺 JS runtime —— yt-dlp 2025+ 解 YouTube 的 JS challenge 需要 deno 或 node，本機請 `apt install nodejs` 或裝 deno，Actions 上 runner 內建 node 沒問題。
- **`Sign in to confirm you're not a bot`**：YouTube 擋資料中心 IP。實測 8 種 `player_client`（default / android_vr / mweb / ios / tv_embedded / web_embedded / tv_simply / web）全部被擋，**只能靠 cookies**。見下方〈YouTube 需要 cookies〉。
- **下載到一半失敗**：看 Actions 的 run 日誌，通常是單一格式無法取得，換個畫質再試。

## YouTube 需要 cookies（實測結論）

GitHub 的 runner IP 會被 YouTube 當成 bot，沒有登入 cookie 一律失敗。做法：

1. 手機裝 **Kiwi Browser**（支援 Chrome 擴充）。
2. 裝擴充 **Get cookies.txt LOCALLY**。
3. 在 Kiwi 登入 `youtube.com`，在 youtube.com 頁面按擴充 → Export，得到 Netscape 格式內容。
4. GitHub repo → Settings → Secrets and variables → Actions → **New repository secret**，名稱 `YTDLP_COOKIES`，值貼上整份內容。
5. 重新按一次下載。cookies 幾週到幾個月會過期，失效就重匯。

⚠️ cookies 等於你 YouTube 帳號的登入憑證，只放在 repo secret 裡，別貼進 issue 或截圖。
