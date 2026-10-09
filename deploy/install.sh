#!/usr/bin/env bash
# Первая настройка сервера (Ubuntu 24.04), запускать от root один раз:
#   bash install.sh
# Ставит Node, Caddy, создаёт службу бота, ночные копии и защиту. Секреты
# не трогает: их кладут в /etc/schedule/env руками.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update -q
apt-get install -y -q curl git sqlite3 rclone ufw unattended-upgrades

# Node 24: в нём встроенный SQLite, отдельных библиотек боту не нужно.
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y -q nodejs
fi

# Caddy — веб-сервер с автоматическими сертификатами. Из штатных пакетов
# Ubuntu: собственное хранилище Caddy из России отвечает отказом.
rm -f /etc/apt/sources.list.d/caddy-stable.list
if ! command -v caddy >/dev/null; then
  apt-get update -q
  apt-get install -y -q caddy
fi

id schedule >/dev/null 2>&1 || useradd --system --home /opt/schedule --shell /usr/sbin/nologin schedule
mkdir -p /opt/schedule /var/lib/schedule/backups /etc/schedule
if [ ! -d /opt/schedule/.git ]; then
  git clone -q --branch "${BRANCH:-main}" https://github.com/bodryash/schedule-miniapp.git /opt/schedule
fi
chown -R schedule:schedule /opt/schedule /var/lib/schedule
git config --system --add safe.directory /opt/schedule

if [ ! -f /etc/schedule/env ]; then
  cp /opt/schedule/deploy/env.example /etc/schedule/env
  # Случайные строки для подписи счётчиков и вебхука — сразу свои.
  sed -i "s|^STATS_SALT=.*|STATS_SALT=$(openssl rand -hex 24)|; s|^WEBHOOK_SECRET=.*|WEBHOOK_SECRET=$(openssl rand -hex 24)|" /etc/schedule/env
fi
chown root:schedule /etc/schedule/env
chmod 640 /etc/schedule/env

# У api.telegram.org два адреса, и у части российских хостеров один из них
# не отвечает: бот зависал бы на каждом втором сообщении. Закрепляем тот,
# что отвечает отсюда; если не отвечает ни один — оставляем как есть.
if ! grep -q "api.telegram.org" /etc/hosts; then
  for ip in 149.154.167.220 149.154.166.110; do
    if curl -s -m 8 -o /dev/null --resolve "api.telegram.org:443:$ip" https://api.telegram.org/; then
      echo "$ip api.telegram.org" >> /etc/hosts
      break
    fi
  done
fi

# Память под пики: файл подкачки на 2 ГБ, если его ещё нет.
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Наружу открыты только SSH и сайт.
ufw allow OpenSSH >/dev/null
ufw allow 80,443/tcp >/dev/null
ufw --force enable >/dev/null

install -m 644 /opt/schedule/deploy/schedule-bot.service /etc/systemd/system/schedule-bot.service
install -m 644 /opt/schedule/deploy/Caddyfile /etc/caddy/Caddyfile
install -m 755 /opt/schedule/deploy/backup.sh /usr/local/bin/schedule-backup
install -m 755 /opt/schedule/deploy/update.sh /usr/local/bin/schedule-update

# Копия базы каждую ночь в 04:10 по Москве.
timedatectl set-timezone Europe/Moscow
cat > /etc/cron.d/schedule <<'CRON'
10 4 * * * root /usr/local/bin/schedule-backup >> /var/log/schedule-backup.log 2>&1
CRON

systemctl daemon-reload
systemctl enable -q schedule-bot caddy
echo
echo "Сервер готов. Дальше: заполнить /etc/schedule/env, залить базу, запустить:"
echo "  systemctl start schedule-bot && systemctl reload caddy"
