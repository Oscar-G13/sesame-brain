#!/usr/bin/env python3
"""Install only Brain's additive Caddy route under shared host locks."""
import fcntl,hashlib,json,os,subprocess
from pathlib import Path
root=Path('/srv/sesame-brain')
assert os.geteuid()==0
fragment=Path('/etc/caddy/sesame-brain.caddy')
main=Path('/etc/caddy/Caddyfile')
site="""brain.arxsable.ai {
 encode zstd gzip
 request_body {
  max_size 1MB
 }
 reverse_proxy 127.0.0.1:3360 {
  header_up -Forwarded
  header_up -X-Forwarded-Host
 }
}
"""
with open('/run/lock/caddy-config.lock','a') as one,open('/run/lock/caddy-sites.lock','a') as two:
 fcntl.flock(one,fcntl.LOCK_EX);fcntl.flock(two,fcntl.LOCK_EX)
 before=main.read_bytes()
 old=fragment.read_bytes() if fragment.exists() else None
 protected={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in Path('/etc/caddy').glob('*.caddy') if p!=fragment}
 importline=b'import /etc/caddy/sesame-brain.caddy'
 assert before.count(importline)<=1
 try:
  fragment.write_text(site);os.chmod(fragment,0o644)
  if importline not in before:main.write_bytes(before.rstrip()+b'\n\n'+importline+b'\n')
  subprocess.run(['caddy','validate','--config',str(main),'--adapter','caddyfile'],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  after={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in Path('/etc/caddy').glob('*.caddy') if p!=fragment}
  assert protected==after,'Unrelated Caddy fragments changed'
  subprocess.run(['systemctl','reload','caddy'],check=True)
 except BaseException:
  main.write_bytes(before)
  if old is None:fragment.unlink(missing_ok=True)
  else:fragment.write_bytes(old)
  raise
 receipt={'ok':True,'fragment':str(fragment),'unchanged_other_fragments':len(protected),'upstream':'127.0.0.1:3360'}
 (root/'evidence/proxy-install.json').write_text(json.dumps(receipt,indent=2)+'\n')
 os.chown(root/'evidence/proxy-install.json',1000,1000)
 print(json.dumps(receipt))
