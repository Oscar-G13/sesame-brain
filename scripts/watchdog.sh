#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /srv/sesame-brain
exec 9>.watchdog.lock
flock -n 9 || exit 0
if curl --max-time 10 --fail --silent http://127.0.0.1:3360/health >/dev/null; then
 echo 0 > .watchdog-failures
else
 count=0
 if [[ -f .watchdog-failures ]]; then read -r count < .watchdog-failures; fi
 [[ "$count" =~ ^[0-9]+$ ]] || count=0
 count=$((count+1));echo "$count" > .watchdog-failures
 if ((count>=3)); then
  printf '%s liveness_restart after_three_failed_checks\n' "$(date -u +%FT%TZ)" >>watchdog.log
  docker compose -p sesame-brain restart db app >>watchdog.log 2>&1
  echo 0 > .watchdog-failures
 fi
fi
# Warn only. Storage pressure never triggers deletion or an unrelated service restart.
used=$(df -P /srv/sesame-brain | awk 'NR==2 {gsub("%","",$5); print $5}')
threshold="${BRAIN_DISK_WARNING_PERCENT:-85}"
if [[ "$used" =~ ^[0-9]+$ && "$threshold" =~ ^[0-9]+$ ]]; then
 disk_ok=true
 if ((used>=threshold)); then disk_ok=false; fi
 docker compose -p sesame-brain exec -T db psql -U brain -d brain -v ON_ERROR_STOP=1 -q -c "INSERT INTO operational_status(key,ok,code) VALUES('disk',$disk_ok,'capacity_check') ON CONFLICT(key) DO UPDATE SET ok=EXCLUDED.ok,code=EXCLUDED.code,checked_at=now()" >/dev/null 2>&1 || true
fi

# Readiness failures alert; restarting a database cannot repair provider credentials.
status=$(curl --max-time 15 --silent --show-error http://127.0.0.1:3360/ready 2>/dev/null || printf '{"ok":false,"issues":["Readiness endpoint unavailable."]}')
printf '%s' "$status" | python3 -c '
import json,sys
from pathlib import Path
from datetime import datetime,timezone
try:
 data=json.load(sys.stdin);issues=data.get("issues",[])
 if not isinstance(issues,list):issues=["Readiness response invalid."]
 safe={"ok":data.get("ok") is True,"issues":[str(x)[:180] for x in issues[:10]]}
except Exception:safe={"ok":False,"issues":["Readiness response invalid."]}
path=Path(".ops-last-status.json")
try:previous=json.loads(path.read_text()) if path.exists() else None
except Exception:previous=None
if safe!=previous:
 with Path("watchdog.log").open("a") as f:f.write(json.dumps({"time":datetime.now(timezone.utc).isoformat(),"event":"readiness_restored" if safe["ok"] else "operator_attention_required",**safe})+"\n")
 path.write_text(json.dumps(safe)+"\n")
'
