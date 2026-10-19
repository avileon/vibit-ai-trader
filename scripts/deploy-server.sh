#!/usr/bin/env bash
# Deploy/update VIBIT AI Trader on an Ubuntu server that already has Docker + Caddy.
# Usage (as root):  bash deploy-server.sh /path/to/vibit-ai-trader.tar.gz trader.example.com
set -euo pipefail
TARBALL="$1"; DOMAIN="$2"
APP=/opt/vibit-trader
PORT="${WEB_PORT:-3200}"

mkdir -p "$APP"
tar -xzf "$TARBALL" -C "$APP" --strip-components=1
cd "$APP"

if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s|^MASTER_KEY=.*|MASTER_KEY=$(openssl rand -base64 32)|" .env
  sed -i "s|^MYSQL_ROOT_PASSWORD=.*|MYSQL_ROOT_PASSWORD=$(openssl rand -hex 24)|" .env
  sed -i "s|^MYSQL_PASSWORD=.*|MYSQL_PASSWORD=$(openssl rand -hex 24)|" .env
  sed -i "s|^COOKIE_SECURE=.*|COOKIE_SECURE=true|" .env
  sed -i "s|^WEB_BIND=.*|WEB_BIND=127.0.0.1|" .env
  if ss -ltn | grep -q ":$PORT "; then echo "port $PORT busy"; exit 1; fi
  sed -i "s|^WEB_PORT=.*|WEB_PORT=$PORT|" .env
  chmod 600 .env
  echo ".env created (MASTER_KEY generated — back it up!)"
fi
PORT=$(grep ^WEB_PORT= .env | cut -d= -f2)

docker compose up -d --build

echo "waiting for health..."
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q '"alive":true'; then ok=1; break; fi
  sleep 5
done
[ "${ok:-}" = 1 ] || { docker compose ps; docker compose logs --tail 40 api worker; exit 1; }
curl -fsS "http://127.0.0.1:$PORT/api/health"; echo

# Caddy site block (only once)
if ! grep -q "^$DOMAIN {" /etc/caddy/Caddyfile; then
  cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak-$(date +%Y%m%d-%H%M%S)"
  cat >> /etc/caddy/Caddyfile <<CADDY

$DOMAIN {
	encode zstd gzip
	header Strict-Transport-Security "max-age=31536000; includeSubDomains"
	reverse_proxy 127.0.0.1:$PORT
	log {
		output file /var/log/caddy/vibit-trader.log {
			roll_size 10MiB
			roll_keep 5
		}
	}
}
CADDY
  touch /var/log/caddy/vibit-trader.log && chown caddy:caddy /var/log/caddy/vibit-trader.log
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  chown caddy:caddy /var/log/caddy/vibit-trader.log
  systemctl reload caddy
  echo "Caddy: added $DOMAIN"
fi

# daily backup cron (03:15 UTC)
CRON="15 3 * * * $APP/scripts/backup.sh >> /var/log/vibit-backup.log 2>&1"
( crontab -l 2>/dev/null | grep -v vibit-trader/scripts/backup.sh; echo "$CRON" ) | crontab -
chmod +x scripts/*.sh
echo "DONE: https://$DOMAIN"
