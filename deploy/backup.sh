#!/usr/bin/env bash
# StrikeNote 備份：mariadb-dump 整個資料庫 → gzip → 保留 N 天 →（選填）rclone 到異地。
# 讀 /etc/strikenote/env 的 DB_*、BACKUP_DIR、BACKUP_KEEP_DAYS、RCLONE_REMOTE。
# 手動跑： set -a; . /etc/strikenote/env; set +a; deploy/backup.sh
# 還原：   zcat strikenote-YYYYMMDD-HHMM.sql.gz | mariadb -u strikenote -p strikenote
set -euo pipefail
umask 077

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
DB_SOCKET="${DB_SOCKET:-}"
DB_NAME="${DB_NAME:-strikenote}"
DB_USER="${DB_USER:-strikenote}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/strikenote}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
RCLONE_REMOTE="${RCLONE_REMOTE:-}"

if [ -z "${DB_PASSWORD:-}" ]; then
  echo "DB_PASSWORD 未設定" >&2
  exit 1
fi
# 密碼走環境變數，不出現在 ps 裡。
export MYSQL_PWD="$DB_PASSWORD"

conn=(--user "$DB_USER")
if [ -n "$DB_SOCKET" ]; then
  conn+=(--socket "$DB_SOCKET")
else
  conn+=(--host "$DB_HOST" --port "$DB_PORT")
fi

mkdir -p "$BACKUP_DIR"
stamp="$(date +%Y%m%d-%H%M)"
out="$BACKUP_DIR/strikenote-$stamp.sql.gz"

# --single-transaction：InnoDB 一致性快照，伺服器不用停。
# --hex-blob：圖片/PDF 以十六進位輸出，還原時不會被字元集動到。
mariadb-dump "${conn[@]}" \
  --single-transaction --quick --hex-blob --routines=false --events=false \
  --default-character-set=utf8mb4 "$DB_NAME" | gzip -1 > "$out.tmp"
mv "$out.tmp" "$out"
gzip -t "$out"

# 只留最近 N 天。
find "$BACKUP_DIR" -maxdepth 1 -name 'strikenote-*.sql.gz' -mtime +"$BACKUP_KEEP_DAYS" -delete

if [ -n "$RCLONE_REMOTE" ]; then
  rclone copy "$out" "$RCLONE_REMOTE"
fi

size="$(du -h "$out" | cut -f1)"
counts="$(mariadb "${conn[@]}" --skip-column-names --batch "$DB_NAME" -e \
  'SELECT CONCAT((SELECT COUNT(*) FROM users), " users, ", (SELECT COUNT(*) FROM notes), " notes, ", (SELECT COUNT(*) FROM images), " images")')"
echo "備份完成：$out（$size；$counts）"
