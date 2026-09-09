#!/usr/bin/env bash
# StrikeNote 一鍵安裝 / 更新（Raspberry Pi OS 64-bit，或任何 Debian/Ubuntu、arm64/amd64 皆可）。
#
# 全新機器，一條指令：
#   curl -fsSL https://raw.githubusercontent.com/capytuntun/StrikeNote/main/deploy/install.sh | sudo bash
#
# 已經裝過、要更新到最新版：直接對同一台機器再跑一次同一條指令即可 —— 密碼與設定
# （/etc/strikenote/env）不會被覆蓋，只會拉新程式碼、npm ci、重啟服務。
#
# 會做的事：
#   1. apt 裝 MariaDB、Node.js 22、git
#   2. 建資料庫與帳號（密碼隨機產生，只在第一次安裝時產生，之後重跑會沿用）
#   3. 把程式碼放到 /opt/strikenote（git clone，之後用 git pull 更新）
#   4. 寫 /etc/strikenote/env（chmod 640）
#   5. 建立 systemd service（開機自動啟動、掛掉自動重啟）
#   6. 排每日 03:00 資料庫備份（cron）
#   7. 健康檢查，印出網址與管理員密碼
#
# 不會做的事：不裝 TLS、不動防火牆、不設反向代理 —— 對外交給 Cloudflare Tunnel 或
# nginx/Caddy，指到 http://127.0.0.1:8080 並記得轉發 X-Forwarded-Proto: https
# （TRUST_PROXY=1 才會信任它）。這台機器本身只監聽 127.0.0.1。
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/capytuntun/StrikeNote.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/strikenote}"
ENV_FILE="/etc/strikenote/env"
SERVICE_NAME="strikenote"
APP_USER="strikenote"
DB_NAME="strikenote"
DB_USER="strikenote"

log() { echo -e "\n[install] $1"; }
die() { echo "[install] ✗ $1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "請用 root 執行：sudo bash install.sh（或用 curl | sudo bash）"

# ---------- 1. 系統套件 ----------
log "更新套件列表、安裝 MariaDB / git / openssl…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
# sudo：Raspberry Pi OS 本來就有，但純 Debian/Ubuntu 最小安裝可能沒裝，
# 後面用 sudo -u 切到 $APP_USER 跑 npm ci 需要它。
apt-get install -y curl ca-certificates gnupg git openssl sudo mariadb-server

# ---------- 2. Node.js 22 ----------
node_major() { command -v node >/dev/null 2>&1 && node -v | sed -E 's/^v([0-9]+).*/\1/' || echo 0; }
if [ "$(node_major)" -lt 22 ]; then
  log "安裝 Node.js 22（NodeSource）…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
log "Node $(node -v)、npm $(npm -v)"

# ---------- 3. MariaDB 啟動 ----------
log "啟動 MariaDB…"
systemctl enable --now mariadb

# ---------- 4. 系統使用者 + 程式碼 ----------
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"

# step 8 把 $APP_DIR 的擁有者改成 $APP_USER，所以更新時這裡是以 root 身分對一個
# 不屬於 root 的目錄跑 git —— 新版 git 預設會擋下這種「dubious ownership」，要先信任它。
git config --global --add safe.directory "$APP_DIR"

FRESH_INSTALL=1
if [ -d "$APP_DIR/.git" ]; then
  FRESH_INSTALL=0
  log "已有安裝，更新程式碼（git fetch + reset --hard origin/$BRANCH）…"
  echo "         注意：$APP_DIR 裡任何手動修改都會被蓋掉，設定只放在 $ENV_FILE。"
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  log "clone 程式碼到 $APP_DIR …"
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$APP_DIR"
fi

# ---------- 4b. MariaDB 調校設定 ----------
# 要等程式碼真的在 $APP_DIR 上才有這個檔案可用 —— curl | sudo bash 執行時腳本是從
# stdin 讀進來的，這一步之前 $0 沒有任何「旁邊的檔案」可言，放在 clone 之前找的話
# 永遠找不到、會被 [ -f ... ] 悄悄跳過而不出錯，調校就完全沒生效過。
CNF_SRC="$APP_DIR/deploy/mariadb/60-strikenote.cnf"
CNF_DST="/etc/mysql/mariadb.conf.d/60-strikenote.cnf"
mkdir -p /etc/mysql/mariadb.conf.d
if [ -f "$CNF_SRC" ] && ! cmp -s "$CNF_SRC" "$CNF_DST" 2>/dev/null; then
  log "套用 MariaDB 調校設定…"
  cp "$CNF_SRC" "$CNF_DST"
  systemctl restart mariadb
fi

# ---------- 5. 密碼：已有設定檔就沿用，沒有才產生新的 ----------
mkdir -p /etc/strikenote
if [ -f "$ENV_FILE" ]; then
  log "沿用既有的 $ENV_FILE（密碼與設定不變）"
  set -a; . "$ENV_FILE"; set +a
fi
DB_PASSWORD="${DB_PASSWORD:-$(openssl rand -base64 24)}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(openssl rand -base64 18)}"

# ---------- 6. 資料庫與帳號（可重複執行；密碼跟著上面決定的值同步）----------
log "建立/同步資料庫帳號…"
mariadb <<SQL
CREATE DATABASE IF NOT EXISTS $DB_NAME CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASSWORD';
ALTER USER '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASSWORD';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, DROP, LOCK TABLES ON $DB_NAME.* TO '$DB_USER'@'localhost';
FLUSH PRIVILEGES;
SQL

# ---------- 7. /etc/strikenote/env（只在第一次安裝時寫，之後不動）----------
if [ ! -f "$ENV_FILE" ]; then
  log "寫入 $ENV_FILE …"
  cat > "$ENV_FILE" <<ENV
HOST=127.0.0.1
PORT=8080
TRUST_PROXY=1
REQUIRE_HTTPS=1

DB_HOST=127.0.0.1
DB_PORT=3306
# unix socket，不是 TCP：跟 60-strikenote.cnf 的 skip-name-resolve=1 是必要搭配 ——
# 一旦關掉主機名稱解析，MariaDB 對 TCP 127.0.0.1 連線只會拿字面 IP 去比對帳號的
# host 欄位，'strikenote'@'localhost' 就不再匹配、直接被拒絕；改用 socket 連線一律
# 比對成 localhost，兩者才吃得起來。設了 DB_SOCKET 這裡 DB_HOST/DB_PORT 就不會用到。
DB_SOCKET=/run/mysqld/mysqld.sock
DB_NAME=$DB_NAME
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD

REGISTER_MODE=${REGISTER_MODE:-closed}
INVITE_CODE=${INVITE_CODE:-}
ADMIN_USERNAME=${ADMIN_USERNAME:-admin}
ADMIN_PASSWORD=$ADMIN_PASSWORD
SESSION_TTL_DAYS=14
MIN_PASSWORD_LENGTH=12
MAX_LOGIN_ATTEMPTS=5
LOGIN_LOCKOUT_MINUTES=15

MAX_BODY_BYTES=50331648
STORAGE_WARN_MB=1024
STORAGE_WARN_PCT=10

BACKUP_DIR=/var/backups/strikenote
BACKUP_KEEP_DAYS=14
RCLONE_REMOTE=
ENV
fi
chown root:"$APP_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"

# ---------- 8. npm 套件 ----------
log "npm ci（正式相依套件）…"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
sudo -u "$APP_USER" bash -c "cd '$APP_DIR' && npm ci --omit=dev"

# ---------- 9. systemd service ----------
log "設定 systemd service…"
NODE_BIN="$(command -v node)"
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<UNIT
[Unit]
Description=StrikeNote
After=network.target mariadb.service
Requires=mariadb.service

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN server/server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$APP_DIR
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null
systemctl restart "$SERVICE_NAME"

# ---------- 10. 每日備份 ----------
log "排每日 03:00 資料庫備份…"
chmod +x "$APP_DIR/deploy/backup.sh"
cat > /etc/cron.d/strikenote-backup <<CRON
0 3 * * * root . $ENV_FILE && $APP_DIR/deploy/backup.sh >> /var/log/strikenote-backup.log 2>&1
CRON

# ---------- 11. 健康檢查 ----------
log "等待服務啟動…"
ok=0
for _ in $(seq 1 20); do
  if curl -fs http://127.0.0.1:"${PORT:-8080}"/api/health 2>/dev/null | grep -q '"ok":true'; then ok=1; break; fi
  sleep 1
done

echo
echo "════════════════════════════════════════════════════════════"
if [ "$ok" -eq 1 ]; then
  echo " ✅ StrikeNote 已啟動：http://127.0.0.1:${PORT:-8080}/api/health"
else
  echo " ⚠ 服務沒有在時限內回應健康檢查，請看："
  echo "     journalctl -u $SERVICE_NAME -n 80 --no-pager"
fi
echo " 目錄:      $APP_DIR"
echo " 設定檔:    $ENV_FILE"
echo " service:   systemctl status $SERVICE_NAME"
echo " log:       journalctl -u $SERVICE_NAME -f"
if [ "$FRESH_INSTALL" -eq 1 ]; then
  echo " 管理員帳號: ${ADMIN_USERNAME:-admin}"
  echo " 管理員密碼: $ADMIN_PASSWORD   ← 只印這一次，請記下來，登入後可自行更改"
fi
echo " 下一步:    把 cloudflared（或 nginx/Caddy）指到 http://127.0.0.1:${PORT:-8080}，"
echo "            確認它會送 X-Forwarded-Proto: https。"
echo " 之後要更新到最新版：對這台機器重跑同一條 curl 指令即可。"
echo "════════════════════════════════════════════════════════════"
