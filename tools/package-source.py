"""Archive exactly the Git publication inventory, never local ignored state."""
from pathlib import Path
import hashlib,json,subprocess,zipfile,sys

root=Path(__file__).resolve().parents[1]
result=subprocess.run(['node',str(root/'tools/check-publication.mjs')],cwd=root)
if result.returncode:raise SystemExit('Publication checks must pass before packaging.')
names=subprocess.check_output(['git','-C',str(root),'ls-files','--cached','--others','--exclude-standard','-z']).decode('utf8').split('\0')
files=sorted(set(n for n in names if n))
output=root.parent/'AbrakLauncher-GitHub.zip'
with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as archive:
 for name in files:
  source=root/name
  if source.is_symlink() or not source.is_file():raise SystemExit('Invalid source entry: '+name)
  archive.write(source,'AbrakLauncher/'+name)
with zipfile.ZipFile(output) as archive:
 if archive.testzip() is not None:raise SystemExit('Archive CRC check failed.')
receipt={'status':'PASS','archive':output.name,'files':len(files),'bytes':output.stat().st_size,'sha256':hashlib.file_digest(output.open('rb'),'sha256').hexdigest()}
(root.parent/'AbrakLauncher-GitHub.sha256').write_text(receipt['sha256']+'  '+output.name+'\n',encoding='ascii')
print(json.dumps(receipt,indent=2))
