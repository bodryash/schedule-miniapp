#!/usr/bin/env bash
# Сервер сам забирает обновления из GitHub каждую минуту: то, что влили в
# main, доходит до пользователей без входа в консоль. Бот перезапускается,
# только если менялся его код (см. update.sh). Запустить один раз от root:
#   sudo bash /opt/schedule/deploy/autoupdate.sh
set -euo pipefail

cat > /etc/systemd/system/schedule-update.service <<'UNIT'
[Unit]
Description=Обновление расписания и бота из GitHub
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
# Скрипт берём из рабочей копии: так и он сам обновляется вместе с кодом.
ExecStart=/bin/bash /opt/schedule/deploy/update.sh
UNIT

cat > /etc/systemd/system/schedule-update.timer <<'UNIT'
[Unit]
Description=Обновление расписания и бота каждую минуту

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
RandomizedDelaySec=5s

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now schedule-update.timer
systemctl start schedule-update.service || true
echo "Готово: сервер сам обновляется каждую минуту."
systemctl list-timers schedule-update.timer --no-pager | head -3
