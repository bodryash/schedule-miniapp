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
echo "Копия готова: schedule-$STAMP.sqlite.gz"
