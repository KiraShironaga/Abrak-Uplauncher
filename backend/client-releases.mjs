import fs from 'node:fs/promises';
import path from 'node:path';
import {HttpError} from './router.mjs';

export function releaseVersion(value) {
  const version=Number(value);
  if(!/^[1-9]\d*$/.test(String(value))||!Number.isSafeInteger(version))throw new HttpError(400,'Version client invalide');
  return version;
}
function relativePath(value){
  if(typeof value!=='string'||!value||value.includes('\\')||value.includes('\0')||value.split('/').some(p=>!p||p==='.'||p==='..'||p.includes(':')))throw new HttpError(400,'Chemin de publication invalide');
  return value;
}
export async function releaseFile(root,relative){
  relativePath(relative);
  root=await fs.realpath(root);
  const target=path.resolve(root,relative);
  if(!target.startsWith(path.resolve(root)+path.sep))throw new HttpError(400,'Publication hors du projet');
  let cursor=root;
  try{
    for(const part of relative.split('/')){cursor=path.join(cursor,part);if((await fs.lstat(cursor)).isSymbolicLink())throw new HttpError(400,'Lien de publication refusé');}
    const real=await fs.realpath(target);
    if(real!==target||!(await fs.stat(real)).isFile())throw new HttpError(400,'Publication indirecte refusée');
    return target;
  }catch(error){if(error.code==='ENOENT')throw new HttpError(404,'Publication client absente');throw error;}
}
export async function activeRelease(root){
  let text;
  try{text=await fs.readFile(path.join(root,'data/client-release.json'),'utf8');}catch(error){if(error.code==='ENOENT')return{version:1,builtin:true};throw error;}
  let pointer;try{pointer=JSON.parse(text.replace(/^\uFEFF/,''));}catch{throw new HttpError(503,'Pointeur de publication illisible');}
  const version=releaseVersion(pointer.version),base=`releases/snapshots/${version}`;
  if(version<2||pointer.manifestRelative!==base+'/manifest.json'||pointer.zipRelative!==base+'/client.zip'||pointer.rootRelative!==base+'/files')throw new HttpError(503,'Pointeur de publication incohérent');
  await Promise.all([releaseFile(root,pointer.manifestRelative),releaseFile(root,pointer.zipRelative)]);
  return pointer;
}
export async function selectRelease(root,value){
  const active=await activeRelease(root),version=value===null||value===undefined?active.version:releaseVersion(value);
  if(version===1)return{version:1,builtin:true};
  const base=`releases/snapshots/${version}`;
  await releaseFile(root,base+'/manifest.json');
  return{version,manifestRelative:base+'/manifest.json',zipRelative:base+'/client.zip',rootRelative:base+'/files'};
}
export async function snapshotPayload(root,version,relative){
  relativePath(relative);
  const release=await selectRelease(root,version);
  if(release.builtin)throw new HttpError(404,'Utiliser les fichiers du client intégré');
  const manifest=JSON.parse(await fs.readFile(await releaseFile(root,release.manifestRelative),'utf8'));
  if(!Object.hasOwn(manifest,relative))throw new HttpError(404,'Fichier hors du manifeste publié');
  return releaseFile(root,release.rootRelative+'/'+relative);
}
