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
# Сторож: бот завис (процесс жив, но не отвечает) — systemd этого не видит
# и сам не перезапускает. Проверяем каждую минуту: две неудачи подряд —
# сохраняем журнал, перезапускаем бота и пишем владельцу с журналом.
if systemctl is-active -q schedule-bot; then
  if ! curl -fsS -m 10 http://127.0.0.1:8787/healthz >/dev/null 2>&1; then
    sleep 5
    if ! curl -fsS -m 10 http://127.0.0.1:8787/healthz >/dev/null 2>&1; then
      LOG=/var/lib/schedule/hang-$(date +%F-%H%M).log
      journalctl -u schedule-bot -n 120 --no-pager > "$LOG" 2>&1 || true
      systemctl restart schedule-bot
      sleep 3
      STATE=$(curl -fsS -m 10 http://127.0.0.1:8787/healthz >/dev/null 2>&1 && echo "отвечает" || echo "всё ещё НЕ отвечает")
      if [ -f /etc/schedule/env ]; then
        set -a; . /etc/schedule/env; set +a
        API="${TELEGRAM_API_BASE:-https://api.telegram.org}/bot$BOT_TOKEN"
        curl -fsS -m 30 "$API/sendDocument" -F "chat_id=$OWNER_ID" \
          -F "caption=⚠️ Бот завис и был перезапущен сторожем. После перезапуска: $STATE. Журнал перед зависанием — в файле." \
          -F "document=@$LOG" >/dev/null 2>&1 || true
      fi
      echo "Бот завис — перезапущен ($STATE)."
    fi
  fi
fi
# Бета грузилась медленно: без кэша телефон при каждом открытии заново
# переспрашивал каждый файл. Страница — по-прежнему всегда свежая, файлы
# кэшируются на минуту: и быстро, и обновления видны почти сразу.
CADDY=/etc/caddy/Caddyfile
if [ -f "$CADDY" ] && grep -q '^	header Cache-Control "no-cache"$' "$CADDY" && grep -q "beta.bodryash.ru" "$CADDY"; then
  cp "$CADDY" "$CADDY.bak"
  sed -i 's#^\theader Cache-Control "no-cache"$#\t@betapage path / /index.html\n\theader @betapage Cache-Control "no-cache"\n\t@betaassets path *.js *.css *.json *.woff2 *.png *.svg *.jpg\n\theader @betaassets Cache-Control "public, max-age=60"#' "$CADDY"
  if caddy validate --config "$CADDY" --adapter caddyfile >/dev/null 2>&1; then
    systemctl reload caddy
  else
    cp "$CADDY.bak" "$CADDY"
  fi
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
