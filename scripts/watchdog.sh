#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /srv/sesame-brain
exec 9>.watchdog.lock
flock -n 9 || exit 0
if curl --max-time 10 --fail --silent http://127.0.0.1:3360/health >/dev/null; then
 echo 0 > .watchdog-failures
 exit 0
fi
count=0
if [[ -f .watchdog-failures ]]; then read -r count < .watchdog-failures; fi
[[ "$count" =~ ^[0-9]+$ ]] || count=0
count=$((count+1))
echo "$count" > .watchdog-failures
if ((count>=3)); then
 printf '%s restart after three failed checks\n' "$(date -u +%FT%TZ)" >> watchdog.log
 docker compose -p sesame-brain restart db app >>watchdog.log 2>&1
 echo 0 > .watchdog-failures
fi
