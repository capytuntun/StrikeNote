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
3. `cp deploy/env.example /etc/strikenote/env`，填 `DB_PASSWORD`、`ADMIN_PASSWORD`、`REGISTER_MODE`。
4. 搬資料：在舊機器**正常關閉**舊版伺服器（讓 WAL 寫回），把 `server/data/data.db` 複製到 Pi，
   `set -a; . /etc/strikenote/env; set +a; node server/tools/migrate-sqlite-to-mariadb.js --sqlite ~/data.db --dry-run`，
   看過報告再去掉 `--dry-run` 正式跑；完成後 `shred -u ~/data.db`。
5. 以 systemd（或你偏好的方式）跑 `node server/server.js`，`EnvironmentFile=/etc/strikenote/env`；`curl 127.0.0.1:8080/api/health` 應回 `{"ok":true}`。
6. 反向代理／cloudflared 指向 `http://127.0.0.1:8080`，並確認它有送 `X-Forwarded-Proto: https`（cloudflared 會）。
7. `backup.sh` 排進每日；第一次手動跑一次並試還原到另一個資料庫。
