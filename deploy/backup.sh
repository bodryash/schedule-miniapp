#!/usr/bin/env bash
# Ночная копия базы: снимок без остановки бота, сжатие, выгрузка в хранилище.
# На сервере лежат последние 7 копий, в хранилище — всё, что туда ушло.
set -euo pipefail
DB=/var/lib/schedule/schedule.sqlite
DIR=/var/lib/schedule/backups
STAMP=$(date +%F-%H%M)
mkdir -p "$DIR"
sqlite3 "$DB" ".backup '$DIR/schedule-$STAMP.sqlite'"
sqlite3 "$DIR/schedule-$STAMP.sqlite" "PRAGMA integrity_check" | grep -qx ok
gzip -f "$DIR/schedule-$STAMP.sqlite"
ls -1t "$DIR"/schedule-*.sqlite.gz | tail -n +8 | xargs -r rm -f
# Хранилище подключено, если его настроили: rclone config, имя «backup».
if rclone listremotes 2>/dev/null | grep -qx 'backup:'; then
  rclone copy "$DIR/schedule-$STAMP.sqlite.gz" "backup:${BACKUP_BUCKET:-schedule-backups}/"
fi
# Копия вне сервера: зашифрованный архив владельцу в Telegram. Ключ лежит
# только на сервере и у владельца — без него файл в чате бесполезен.
# В чате живёт одна, последняя копия: прошлую бот удаляет, чтобы стёртое
# по /forget не оставалось в старых архивах.
KEY=/etc/schedule/backup.key
if [ -s "$KEY" ]; then
  set -a; . /etc/schedule/env; set +a
  ENC="$DIR/schedule-$STAMP.sqlite.gz.enc"
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$KEY" -in "$DIR/schedule-$STAMP.sqlite.gz" -out "$ENC"
  API="https://api.telegram.org/bot$BOT_TOKEN"
  REPLY=$(curl -fsS --max-time 120 "$API/sendDocument" -F "chat_id=$OWNER_ID" -F "disable_notification=true"     -F "caption=Копия базы $STAMP (зашифрована)" -F "document=@$ENC") || REPLY=""
  rm -f "$ENC"
  NEW=$(printf '%s' "$REPLY" | grep -o '"message_id":[0-9]*' | head -1 | cut -d: -f2)
  LAST=/var/lib/schedule/backups/.telegram-last
  if [ -n "$NEW" ]; then
    [ -s "$LAST" ] && curl -fsS --max-time 30 "$API/deleteMessage" -d "chat_id=$OWNER_ID" -d "message_id=$(cat "$LAST")" >/dev/null || true
    echo "$NEW" > "$LAST"
    echo "Копия отправлена владельцу."
  else
    echo "Копия владельцу НЕ отправлена." >&2
  fi
fi
echo "Копия готова: schedule-$STAMP.sqlite.gz"
