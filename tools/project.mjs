import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const APP=path.join(ROOT,'source/app');
export const OUTPUT=path.join(ROOT,'dist/Abrak Launcher');
export const STAGING=path.join(ROOT,'work/build-staging');
export const digest=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
export async function saveJson(name,value){
  await fs.mkdir(path.join(ROOT,'work/reports'),{recursive:true});
  await fs.writeFile(path.join(ROOT,'work/reports',name),JSON.stringify(value,null,2)+'\n');
}
export async function fileRecords(directory){
  const records=[];
  async function walk(relative=''){
    for(const entry of await fs.readdir(path.join(directory,relative),{withFileTypes:true})){
      const rel=relative?relative+'/'+entry.name:entry.name;
      const file=path.join(directory,rel),stat=await fs.lstat(file);
      if(stat.isSymbolicLink())throw Error('Linked build inputs are refused: '+rel);
      if(stat.isDirectory())await walk(rel);
      else if(stat.isFile())records.push({path:rel,size:stat.size,sha256:digest(await fs.readFile(file))});
      else throw Error('Unsupported build input: '+rel);
    }
  }
  await walk();return records.sort((a,b)=>a.path.localeCompare(b.path));
}
export async function checkedRemove(target){
  const relative=path.relative(ROOT,path.resolve(target)).replaceAll('\\','/');
  if(!['work/build-staging','dist/Abrak Launcher'].includes(relative))throw Error('Build cleanup target refused');
  if((await fs.readFile(path.join(ROOT,'.abrak-local-project'),'utf8')).trim()!=='abrak-launcher-local-project-v1')throw Error('Project marker missing');
  for(let p=path.resolve(target);p!==ROOT;p=path.dirname(p)){
    try{if((await fs.lstat(p)).isSymbolicLink())throw Error('Linked build directory refused');}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  await fs.rm(target,{recursive:true,force:true});
}
export async function verifyAssets(){
  const {assets}=JSON.parse(await fs.readFile(path.join(ROOT,'metadata/bundled-assets.json'),'utf8'));
  for(const item of assets){const data=await fs.readFile(path.join(APP,item.path));if(data.length!==item.size||digest(data)!==item.sha256)throw Error('Bundled asset changed: '+item.path);}
  return assets.length;
}
