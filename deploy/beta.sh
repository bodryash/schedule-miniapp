#!/usr/bin/env bash
# Бета-версия приложения на beta.bodryash.ru. Запустить один раз от root:
#   sudo bash /opt/schedule/deploy/beta.sh
# Ставит вторую копию из ветки beta в /opt/schedule-beta и добавляет сайт в
# Caddy. Дальше бету обновляет тот же таймер, что и основную копию
# (deploy/update.sh), — каждые 5 минут. Бот и база у беты общие с основной.
# Нужна DNS-запись: beta.bodryash.ru → IP этого сервера (A-запись «beta»).
set -euo pipefail

if [ ! -d /opt/schedule-beta/.git ]; then
  git clone -q --branch beta https://github.com/bodryash/schedule-miniapp.git /opt/schedule-beta
fi
chown -R schedule:schedule /opt/schedule-beta
git config --system --add safe.directory /opt/schedule-beta

# Сайт беты — в конец Caddyfile, если его там ещё нет. Поисковикам бету не
# показываем, кэш не держим: смотрят её, чтобы видеть самое свежее.
if ! grep -q "beta.bodryash.ru" /etc/caddy/Caddyfile; then
  cat >> /etc/caddy/Caddyfile <<'CADDY'

# Бета: ветка beta, обновляется вместе с основной копией.
beta.bodryash.ru {
	root * /opt/schedule-beta/docs
	encode zstd gzip
	file_server
	header Cache-Control "no-cache"
	header X-Robots-Tag "noindex, nofollow"
}
CADDY
fi
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl reload caddy
echo "Готово: бета на https://beta.bodryash.ru (сертификат появится через минуту-две после DNS)."
echo "Ветка: $(git -C /opt/schedule-beta log --oneline -1)"
