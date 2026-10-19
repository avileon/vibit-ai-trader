#!/usr/bin/env bash
# Daily DB backup (keeps 14 days). Cron:  15 3 * * * /opt/vibit-ai-trader/scripts/backup.sh
set -euo pipefail
cd "$(dirname "$0")/.."
source .env
mkdir -p backups
f="backups/vibit-$(date -u +%Y%m%d-%H%M).sql.gz"
docker compose exec -T mysql mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines vibit | gzip > "$f"
find backups -name 'vibit-*.sql.gz' -mtime +14 -delete
echo "backup: $f"
