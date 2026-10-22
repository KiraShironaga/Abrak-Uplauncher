/** Render owned client artwork statically; no ActionScript is executed. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import{execFile}from'node:child_process';
import{promisify}from'node:util';
import{inflateSync}from'node:zlib';
import{altereMonsterIds}from'./catalog-icons.mjs';
const exec=promisify(execFile),pending=new Map();
let running=0;const queue=[];
async function slot(){if(running>=2)await new Promise(resolve=>queue.push(resolve));running++;return()=>{running--;queue.shift()?.();};}
const hash=(data,type='sha256')=>crypto.createHash(type).update(data).digest('hex');
export function staticSymbol(input){
  const bytes=input.subarray(0,3).toString()==='CWS'?Buffer.concat([input.subarray(0,8),inflateSync(input.subarray(8))]):input;
  if(!['FWS','CWS'].includes(input.subarray(0,3).toString())||bytes.length<12)return null;
  let offset=8+Math.ceil((5+4*(bytes[8]>>3))/8)+4;const symbols=[];
  while(offset+2<=bytes.length){const header=bytes.readUInt16LE(offset);offset+=2;const code=header>>6;let size=header&63;if(size===63){if(offset+4>bytes.length)return null;size=bytes.readUInt32LE(offset);offset+=4;}const end=offset+size;if(end>bytes.length)return null;
    if((code===56||code===76)&&size>=2){let cursor=offset+2;const count=bytes.readUInt16LE(offset);for(let i=0;i<count&&cursor+2<end;i++){const id=bytes.readUInt16LE(cursor);cursor+=2;const stop=bytes.indexOf(0,cursor);if(stop<cursor||stop>=end)break;symbols.push({id,name:bytes.toString('utf8',cursor,stop)});cursor=stop+1;}}
    offset=end;if(code===0)break;
  }
  return symbols.find(s=>s.name==='staticR')||symbols.find(s=>s.name==='staticL')||symbols.find(s=>/^AnimStatique/.test(s.name))||null;
}
const hasDrawing=svg=>/<(?:path|use|image|circle|rect|polygon|line|text)\b/.test(svg.toString());
async function findSVG(folder){for(const entry of await fs.readdir(folder,{withFileTypes:true})){const file=path.join(folder,entry.name);if(entry.isDirectory()){const found=await findSVG(file);if(found)return found;}else if(entry.name.endsWith('.svg'))return file;}return null;}
export function clientAssetBank(url,catalog){
  let match;
  if((match=/^\/assets\/items\/(\d+)\/(\d+)\.svg$/.exec(url)))return`items/${match[1]}/${match[2]}.swf`;
  if((match=/^\/assets\/template\/images\/items\/(\d+)\.svg$/.exec(url))){const item=catalog.items.find(i=>i.id===Number(match[1]));return item?`items/${item.type}/${item.gfx}.swf`:null;}
  if((match=/^\/assets\/monsters\/(\d+)\.svg$/.exec(url)))return`artworks/big/${match[1]}.swf`;
  if((match=/^\/assets\/template\/images\/alteres\/(\d+)\.svg$/.exec(url))){const index=Number(match[1]),id=altereMonsterIds[index-1]??index,monster=catalog.monsters.find(i=>i.id===id);return monster?`artworks/big/${monster.gfx_id}.swf`:null;}
  return null;
}
export function createClientAssetRenderer(root){
  let catalogPromise,manifestPromise;
  return async function render(url){
    if(!/^\/assets\/(items\/|monsters\/|template\/images\/(items|alteres)\/)/.test(url))return null;
    const target=path.join(root,'assets-client',url.slice(1));
    if(await fs.stat(target).then(s=>s.isFile(),()=>false)){if(hasDrawing(await fs.readFile(target)))return target;await fs.unlink(target);}
    catalogPromise??=fs.readFile(path.join(root,'catalog/client-fr.json'),'utf8').then(JSON.parse);
    const bank=clientAssetBank(url,await catalogPromise);if(!bank)return null;
    const key=root+'\0'+url;if(pending.has(key))return pending.get(key);
    const task=(async()=>{
      const release=await slot();let temporary;
      try{
        let relative='resources/app/retroclient/clips/'+bank;
        manifestPromise??=fs.readFile(path.join(root,'desktop/client-manifest.json'),'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return{};throw error;});
        const manifest=await manifestPromise;
        if(!Object.hasOwn(manifest,relative)&&bank.startsWith('artworks/big/'))relative='resources/app/retroclient/clips/'+bank.replace('artworks/big/','sprites/');
        if(!Object.hasOwn(manifest,relative))return null;
        const source=path.join(root,'client/Abrak/Retro',relative),bytes=await fs.readFile(source);
        if(hash(bytes,'sha1')!==manifest[relative].hash)throw Error('Client artwork differs from the verified manifest');
        const tool=process.env.ABRAK_FFDEC||'';
        if(!tool||!await fs.access(tool).then(()=>true,()=>false))return null;
        const base=path.join(root,'work/client-asset-render');await fs.mkdir(base,{recursive:true});
        temporary=await fs.mkdtemp(path.join(base,'export-'));const config=path.join(temporary,'ffdec.toml');await fs.writeFile(config,'');
        const symbol=staticSymbol(bytes);
        if(relative.includes('/sprites/')&&!symbol)return null;
        const kind=symbol?'sprite':'frame',selection=symbol?[ '-select',symbol.id+':1','-selectid',String(symbol.id)]:['-select','1'];
        await exec(tool,['-configFile',config,'-format',kind+':svg',...selection,'-ignorebackground','-export',kind,temporary,source],{windowsHide:true,timeout:30000,maxBuffer:1024*1024});
        const exported=await findSVG(temporary);if(!exported)return null;
        const svg=await fs.readFile(exported);
        if(svg.length<100||!hasDrawing(svg)||!svg.includes(Buffer.from('<svg'))||/<script\b|\bonload\s*=|(?:href|src)=["']https?:/i.test(svg.toString()))throw Error('Unsafe or empty static SVG export');
        await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,svg,{flag:'wx'});
        await fs.appendFile(path.join(root,'work/client-asset-exports.jsonl'),JSON.stringify({created_utc:new Date().toISOString(),path:url,source_relative:'client/Abrak/Retro/'+relative,source_sha256:hash(bytes),svg_sha256:hash(svg),bytes:svg.length,symbol,method:'FFDec26.3 static first-frame SVG of artwork or available static symbol; not the remote CDN file; no ActionScript executed'})+'\n');
        return target;
      }catch(error){if(error.code==='ENOENT')return null;throw error;}
      finally{if(temporary&&path.dirname(temporary)===path.join(root,'work/client-asset-render'))await fs.rm(temporary,{recursive:true,force:true});release();}
    })();pending.set(key,task);try{return await task;}finally{pending.delete(key);}
  };
}
