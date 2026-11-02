#!/usr/bin/env python3
import os,fcntl,hashlib,json,subprocess
from pathlib import Path
assert os.geteuid()==0
p=Path('/etc/hermes-hardening/expected-containers.tsv')
with open('/run/lock/hermes-expected-containers.lock','a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX)
 before=p.read_bytes()
 lines=before.decode().splitlines()
 for name in ['sesame-brain-app-1','sesame-brain-db-1']:
  status=subprocess.check_output(['docker','inspect','--format','{{.State.Health.Status}}',name],text=True).strip()
  assert status=='healthy',(name,status)
  line=name+'|healthy'
  existing=[x for x in lines if x.startswith(name+'|')]
  assert not existing or existing==[line]
  if not existing:lines.append(line)
 p.write_text('\n'.join(lines)+'\n')
 receipt={'ok':True,'registered':['sesame-brain-app-1','sesame-brain-db-1'],'previous_entries_preserved':all(line in lines for line in before.decode().splitlines()),'before_sha256':hashlib.sha256(before).hexdigest(),'after_sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
 r=Path('/srv/sesame-brain/evidence/runtime-registration.json');r.write_text(json.dumps(receipt,indent=2)+'\n');os.chown(r,1000,1000)
 print(json.dumps(receipt))
