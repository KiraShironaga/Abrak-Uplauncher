import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {ROOT,OUTPUT,saveJson} from './project.mjs';

if(Number(process.versions.node.split('.')[0])<24)throw Error('Node.js 24.15 ou supérieur est requis.');
const executable=path.join(OUTPUT,'Abrak Launcher.exe');
await fs.access(executable).catch(()=>{throw Error('Compiler avec npm run build avant de lancer le desktop.');});
const profile=path.join(ROOT,'profile-local'),work=path.join(ROOT,'work');
await fs.mkdir(profile,{recursive:true});await fs.mkdir(work,{recursive:true});
const status=()=>fetch('http://127.0.0.1:4318/local/status',{signal:AbortSignal.timeout(1200)}).then(r=>r.json(),()=>null);
let backend=await status(),backendPID=null;
if(backend&&backend.projectRoot!==ROOT)throw Error('Le port 4318 appartient à un autre projet. Arrêter ce projet avant de continuer.');
if(!backend){
  const out=await fs.open(path.join(work,'backend.out.log'),'a'),err=await fs.open(path.join(work,'backend.err.log'),'a');
  const child=spawn(process.execPath,[path.join(ROOT,'backend/server.mjs')],{cwd:ROOT,windowsHide:true,detached:true,stdio:['ignore',out.fd,err.fd]});
  await once(child,'spawn');backendPID=child.pid;child.unref();await out.close();await err.close();
  for(let i=0;i<80&&!backend;i++){await new Promise(r=>setTimeout(r,250));backend=await status();}
  if(backend?.projectRoot!==ROOT)throw Error('Backend indisponible; consulter work/backend.err.log.');
}
const args=[`--user-data-dir=${profile}`];
if(process.argv.includes('--admin'))args.push('--admin');
if(process.argv.includes('--inspect-ui'))args.push('--remote-debugging-address=127.0.0.1','--remote-debugging-port=9335');
const child=spawn(executable,args,{cwd:OUTPUT,detached:true,stdio:'ignore',env:{...process.env,ABRAK_LOCAL_ROOT:ROOT}});
await once(child,'spawn');child.unref();
await saveJson('last-launch.json',{pid:child.pid,backendPID});
console.log('Abrak Launcher ouvert — démonstration locale. http://127.0.0.1:4318/');
