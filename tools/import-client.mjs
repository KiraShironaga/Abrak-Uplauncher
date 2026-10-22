import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {ROOT,digest} from './project.mjs';

const from=process.argv.indexOf('--from');
if(from<0||!process.argv[from+1])throw Error('Usage: npm run import:client -- --from "C:/Games/MonClient"');
const source=await fs.realpath(process.argv[from+1]),prefix='resources/app/retroclient';
const input=path.join(source,prefix),destination=path.join(ROOT,'client/Abrak/Retro');
if(source===ROOT||source.startsWith(ROOT+path.sep))throw Error('Choisir une installation source extérieure au projet.');
for(const file of ['Abrak.exe','loader.swf','config.xml'])await fs.access(path.join(input,file));
if(await fs.stat(destination).then(()=>true,()=>false))throw Error('La destination existe déjà; elle est préservée.');
if((await fs.readFile(path.join(ROOT,'.abrak-local-project'),'utf8')).trim()!=='abrak-launcher-local-project-v1')throw Error('Marqueur du projet absent.');
for(let folder=path.dirname(destination);folder!==ROOT;folder=path.dirname(folder)){
  try{if((await fs.lstat(folder)).isSymbolicLink())throw Error('Dossier de destination lié refusé.');}catch(e){if(e.code!=='ENOENT')throw e;}
}
const excluded=new Set(['cache','gpucache','code cache','local storage','session storage','indexeddb','network','logs','profile','cookies','login data','local state','preferences','secure preferences']);
const manifest={};let files=0,bytes=0;
async function copy(relative=''){
  for(const entry of await fs.readdir(path.join(input,relative),{withFileTypes:true})){
    const rel=relative?relative+'/'+entry.name:entry.name;
    if(excluded.has(entry.name.toLowerCase())||/\.(?:log|sol|sqlite|db)$/i.test(entry.name)||/^(?:\.env|credentials|session\.json|auth\.json|token\.json)/i.test(entry.name))continue;
    const original=path.join(input,rel),before=await fs.lstat(original);
    if(before.isSymbolicLink())throw Error('Lien dans la source refusé: '+rel);
    if(before.isDirectory()){await copy(rel);continue;}
    if(!before.isFile())throw Error('Type de fichier refusé: '+rel);
    const data=await fs.readFile(original),after=await fs.stat(original);
    if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.size!==data.length)throw Error('Source modifiée pendant la lecture: '+rel);
    const key=prefix+'/'+rel,target=path.join(destination,key);
    await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,data,{flag:'wx'});
    if(digest(await fs.readFile(target))!==digest(data))throw Error('Copie différente de la source: '+rel);
    manifest[key]={size:data.length,hash:crypto.createHash('sha1').update(data).digest('hex'),fileUrl:'http://127.0.0.1:4318/local/client-files/'+key.split('/').map(encodeURIComponent).join('/')};
    files++;bytes+=data.length;
  }
}
await copy();
await fs.writeFile(path.join(ROOT,'desktop/client-manifest.json'),JSON.stringify(manifest)+'\n');
await fs.writeFile(path.join(ROOT,'desktop/client-copy.json'),JSON.stringify({files,bytes,destination,originalModified:false},null,2)+'\n');
const config=JSON.parse(await fs.readFile(path.join(ROOT,'desktop/client-config.json'),'utf8'));
config.payloadRoot='client/Abrak/Retro';config.payloadOverrides={};
await fs.writeFile(path.join(ROOT,'desktop/client-config.json'),JSON.stringify(config,null,2)+'\n');
console.log(JSON.stringify({status:'PASS',files,bytes,destination:'client/Abrak/Retro',originalModified:false}));
