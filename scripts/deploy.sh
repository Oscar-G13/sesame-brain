#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /srv/sesame-brain
[[ "$(hostname)" == hermes && "$(pwd -P)" == /srv/sesame-brain ]] || { echo 'Wrong deployment host or directory' >&2; exit 1; }
exec 9>.deploy.lock
flock -n 9 || { echo 'Another Brain deploy is running' >&2; exit 1; }
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then echo 'Commit tracked changes before deployment' >&2; exit 1; fi
if [[ -n "$(git ls-files --others --exclude-standard -- src migrations scripts config)" ]]; then echo 'Commit new runtime files before deployment' >&2; exit 1; fi
git pull --ff-only
export IMAGE_TAG
IMAGE_TAG=$(git rev-parse --short=12 HEAD)
if docker inspect sesame-brain-app-1 >/dev/null 2>&1; then
 # Backup work is deferred by the owner; preserve prior image metadata only.
 docker inspect -f '{{.Image}}' sesame-brain-app-1 > .previous-image
fi
docker compose -p sesame-brain build app sandbox
docker compose -p sesame-brain up -d db sandbox app
for _ in $(seq 1 60); do
 if curl --max-time 5 --fail --silent http://127.0.0.1:3360/health >/dev/null && curl --max-time 5 --fail --silent http://127.0.0.1:3360/ready >/dev/null; then
  python3 - "$IMAGE_TAG" <<'PY'
from pathlib import Path
import sys
p=Path('.env')
s='\n'.join(x for x in p.read_text().splitlines() if not x.startswith('IMAGE_TAG='))
p.write_text(s+'\nIMAGE_TAG='+sys.argv[1]+'\n')
PY
  printf 'deploy_ok revision=%s\n' "$IMAGE_TAG"
  exit 0
 fi
 sleep 2
done
echo 'Health/readiness check failed; prior image digest recorded in .previous-image. V3 privacy migrations require a compatibility review before image rollback' >&2
exit 1
