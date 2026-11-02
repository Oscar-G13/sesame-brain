#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "${BRAIN_ROOT:-/srv/sesame-brain}"
mkdir -p backups
exec 9>backups/.backup.lock
flock 9
stamp=$(date -u +%Y%m%d-%H%M%S)
dest="backups/brain-${stamp}.sql.gz"
trap 'rm -f "$dest.tmp"' EXIT
docker compose -p sesame-brain exec -T db pg_dump -U brain -d brain --no-owner --no-acl | gzip -9 > "$dest.tmp"
gzip -t "$dest.tmp"
mv "$dest.tmp" "$dest"
tar -czf "backups/private-config-${stamp}.tar.gz" .env config/clients.json
find backups -maxdepth 1 -type f \( -name 'brain-*.sql.gz' -o -name 'private-config-*.tar.gz' \) -mtime +14 -delete
printf 'backup_ok %s\n' "$dest"
