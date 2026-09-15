# deploy/

上線用的範本。app 本身只講 HTTP（`HOST=127.0.0.1`），TLS／對外由你的反向代理或 Cloudflare Tunnel 負責。

## 一鍵安裝（Raspberry Pi OS 64-bit，或任何 Debian/Ubuntu）

全新機器，一條指令裝好 MariaDB、Node 22、程式碼、資料庫帳號、systemd service、每日備份：

```
curl -fsSL https://raw.githubusercontent.com/capytuntun/StrikeNote/main/deploy/install.sh | sudo bash
```

跑完會印出健康檢查結果、管理員帳密（隨機產生，只印這一次）。之後要更新到最新版，
對同一台機器**重跑同一條指令**即可——`/etc/strikenote/env` 的密碼與設定不會被覆蓋，
只會拉新程式碼、`npm ci`、重啟服務。細節、每一步在做什麼看 `install.sh` 本身的註解。

裝完後還要做的兩件事（腳本不碰）：
- 把 cloudflared／nginx／Caddy 指到 `http://127.0.0.1:8080`，確認有轉發 `X-Forwarded-Proto: https`。
- 如果是從舊機器搬資料過來，看下面「手動安裝」第 4 步的搬遷流程。

## 各檔案用途（`install.sh` 內部就是在跑這些）

| 檔案 | 用途 |
|---|---|
| `install.sh` | 一鍵安裝／更新腳本，見上 |
| `env.example` | 全部環境變數與建議值；`install.sh` 會依此產生 `/etc/strikenote/env`（`chmod 640`） |
| `mariadb/init.sql` | 建資料庫與帳號的手動版本（先改密碼）：`sudo mariadb < deploy/mariadb/init.sql` |
| `mariadb/60-strikenote.cnf` | MariaDB 設定（utf8mb4、`max_allowed_packet=64M`、InnoDB 參數）→ `/etc/mysql/mariadb.conf.d/` |
| `backup.sh` | `mariadb-dump` 每日備份 + 保留天數 + 選填 rclone；`install.sh` 已排進 cron，`/etc/cron.d/strikenote-backup` |

## 手動安裝步驟（想自己控制每一步，或不想跑腳本時）

1. `sudo apt install mariadb-server && sudo mariadb-secure-installation`；放 `60-strikenote.cnf`、`systemctl restart mariadb`；改密碼後 `sudo mariadb < deploy/mariadb/init.sql`。
2. Node 22（NodeSource arm64）；專案放 `/opt/strikenote`，`npm ci --omit=dev`。
3. `cp deploy/env.example /etc/strikenote/env`，填 `DB_PASSWORD`、`ADMIN_PASSWORD`、`REGISTER_MODE`（只是初始值，之後可以在「帳號管理」切換註冊方式、查看邀請碼）。
4. 搬資料：在舊機器**正常關閉**舊版伺服器（讓 WAL 寫回），把 `server/data/data.db` 複製到 Pi，
   `set -a; . /etc/strikenote/env; set +a; node server/tools/migrate-sqlite-to-mariadb.js --sqlite ~/data.db --dry-run`，
   看過報告再去掉 `--dry-run` 正式跑；完成後 `shred -u ~/data.db`。
5. 以 systemd（或你偏好的方式）跑 `node server/server.js`，`EnvironmentFile=/etc/strikenote/env`；`curl 127.0.0.1:8080/api/health` 應回 `{"ok":true}`。
6. 反向代理／cloudflared 指向 `http://127.0.0.1:8080`，並確認它有送 `X-Forwarded-Proto: https`（cloudflared 會）。
7. `backup.sh` 排進每日；第一次手動跑一次並試還原到另一個資料庫。

## 從外網（Cloudflare Tunnel）連線：按了沒反應，隔半分鐘一起冒出來

app 這一側已經處理掉兩件事：建立資料夾／筆記的請求還在路上時不會再送第二個（所以不會再一次冒出一堆），
Node 的 keep-alive 也拉長到比 cloudflared 重用閒置連線的 90 秒還久（不然 POST 偶爾會直接回 502）。
剩下「要等很久」的部分通常在 tunnel 本身，照順序查：

1. **先分清楚哪一段慢。** 在 Pi 上跑 `curl -s -o /dev/null -w '%{time_total}\n' http://127.0.0.1:8080/api/health`，
   應該是幾毫秒；再從外面的電腦對公開網址跑同一條（`https://你的網域/api/health`），多跑幾次。
   本機一直很快、外面偶爾卡十幾二十秒 → 是 tunnel；兩邊都慢才是 Pi／MariaDB（看第 5 步）。
2. **看 cloudflared 的紀錄：** `journalctl -u cloudflared --since "1 hour ago" | grep -iE "error|timeout|retry|buffer|quic"`。
   常見的兩種：`failed to sufficiently increase receive buffer size`（Pi 的 UDP 緩衝太小，QUIC 會卡），
   `timeout: no recent network activity`（路由器把閒置的 UDP 連線默默斷掉，cloudflared 要等約 30 秒才發現、重連）。
3. **改用 HTTP/2（走 TCP）連 Cloudflare**，對家用路由器最穩：cloudflared 的 `config.yml` 加一行 `protocol: http2`
   （或服務啟動參數加 `--protocol http2`），`sudo systemctl restart cloudflared`；紀錄裡應該看到 `protocol=http2`。
   想留在 QUIC，至少把緩衝加大：
   `echo 'net.core.rmem_max=2500000' | sudo tee /etc/sysctl.d/90-cloudflared.conf && sudo sysctl --system`。
4. **瀏覽器那一段也可能是 QUIC（HTTP/3）。** DevTools → Network 打開「Protocol」欄，卡住的請求若是 `h3`，
   換個網路（手機熱點、另一個 Wi-Fi）看是否就不卡；公司／學校網路常會擋或限速 UDP。
5. **兩邊都慢才看 Pi：** `journalctl -u strikenote | grep '\[db\]'` 出現很多「遇到鎖」表示存檔在搶同一列；
   `dmesg | grep -i mmc` 有錯誤表示 SD 卡出問題（MariaDB 每次 commit 都 fsync，SD 卡一卡住就拖住所有請求，
   長期建議把系統放 USB SSD）。
