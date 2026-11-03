#!/usr/bin/env bash
# Обновление сервера до свежей версии из репозитория. Приложение — это
# файлы, они обновляются сразу; бота перезапускаем, только если менялся он.
set -euo pipefail
# Таймер обновления — раз в минуту (раньше 5): изменения в бете и основной
# версии должны появляться почти сразу. Правим его отсюда же, чтобы не
# заходить ради этого в консоль: скрипт запускается от root.
TIMER=/etc/systemd/system/schedule-update.timer
if [ -f "$TIMER" ] && grep -q "OnUnitActiveSec=5min" "$TIMER"; then
  sed -i 's/OnUnitActiveSec=5min/OnUnitActiveSec=1min/; s/RandomizedDelaySec=30s/RandomizedDelaySec=5s/' "$TIMER"
  systemctl daemon-reload
  systemctl restart schedule-update.timer || true
fi
# Бета (beta.bodryash.ru) — вторая копия из ветки beta. Только файлы
# приложения, бот у беты общий с основным. Обновляем первой: основная
# копия ниже может выйти раньше, если в ней ничего нового.
if [ -d /opt/schedule-beta/.git ]; then
  sudo -u schedule git -C /opt/schedule-beta fetch -q origin beta \
    && sudo -u schedule git -C /opt/schedule-beta reset -q --hard origin/beta \
    || echo "Бету обновить не вышло." >&2
fi
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
