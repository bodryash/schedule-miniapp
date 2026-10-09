#!/usr/bin/env bash
# Обновление сервера до свежей версии из репозитория. Приложение — это
# файлы, они обновляются сразу; бота перезапускаем, только если менялся он.
set -euo pipefail
cd /opt/schedule
BEFORE=$(git rev-parse HEAD)
sudo -u schedule git pull --ff-only -q
AFTER=$(git rev-parse HEAD)
[ "$BEFORE" = "$AFTER" ] && { echo "Уже свежая версия."; exit 0; }
if git diff --name-only "$BEFORE" "$AFTER" | grep -qE '^(worker/|server/)'; then
  systemctl restart schedule-bot
  sleep 2
  curl -fsS http://127.0.0.1:8787/healthz >/dev/null && echo "Бот перезапущен и отвечает."
fi
echo "Обновлено: $(git log --oneline -1)"
