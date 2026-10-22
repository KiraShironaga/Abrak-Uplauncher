import http from 'node:http';
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {State} from './state.mjs';
import {Router, HttpError, Response} from './router.mjs';
import {seedCore} from './seed.mjs';
import * as auth from './auth.mjs';
import * as commerce from './modules/commerce.mjs';
import * as world from './modules/world.mjs';
import {attachRealtime} from './realtime.mjs';
import {activeRelease,selectRelease,releaseFile,snapshotPayload} from './client-releases.mjs';
import {createClientAssetRenderer} from './client-assets.mjs';

export const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.svg':'image/svg+xml','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.wav':'audio/wav','.swf':'application/x-shockwave-flash','.xml':'application/xml','.zip':'application/zip','.yml':'text/yaml; charset=utf-8'};
const localOrigin=value=>!value||value==='null'||/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(value);
const escaped=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function below(root,relative){
  if(typeof relative!=='string'||relative.includes('\0')||relative.includes('\\')||relative.split('/').some(x=>x==='..'||x==='.')||path.isAbsolute(relative)) throw new HttpError(400,'Chemin invalide');
  const resolved=path.resolve(root,relative);
  if(resolved!==root&&!resolved.startsWith(root+path.sep)) throw new HttpError(400,'Chemin hors du dossier autorisé');
  return resolved;
}
async function readBody(req){
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>25*1024*1024)throw new HttpError(413,'Fichier ou requête trop volumineux');chunks.push(chunk);}
  const buffer=Buffer.concat(chunks),type=req.headers['content-type']||'';
  if(!buffer.length)return{body:{},files:[]};
  if(type.includes('application/json')){try{return{body:JSON.parse(buffer.toString()),files:[]};}catch{throw new HttpError(400,'JSON invalide');}}
  if(type.includes('application/x-www-form-urlencoded'))return{body:Object.fromEntries(new URLSearchParams(buffer.toString())),files:[]};
  if(type.includes('multipart/form-data')){
    const boundary=/boundary=(?:"([^"]+)"|([^;]+))/.exec(type);if(!boundary)throw new HttpError(400,'Séparateur multipart absent');
    const marker=Buffer.from('--'+(boundary[1]||boundary[2])),body={},files=[];let cursor=0;
    while((cursor=buffer.indexOf(marker,cursor))>=0){cursor+=marker.length;if(buffer.subarray(cursor,cursor+2).equals(Buffer.from('--')))break;
      const headerEnd=buffer.indexOf('\r\n\r\n',cursor);if(headerEnd<0)break;
      const next=buffer.indexOf(marker,headerEnd+4);if(next<0)break;
      const headers=buffer.subarray(cursor,headerEnd).toString(),name=/name="([^"]*)"/.exec(headers)?.[1],filename=/filename="([^"]*)"/.exec(headers)?.[1],data=buffer.subarray(headerEnd+4,next-2);
      if(name){if(filename!==undefined)files.push({fieldName:name,name:path.basename(filename.replaceAll('\\','/')),type:/content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]||'application/octet-stream',data});else body[name]=data.toString();}
      cursor=next;
    }
    for(const [key,value]of Object.entries(body)){if(key.endsWith('[]'))body[key.slice(0,-2)]=[value];else if(/^[\[{]/.test(value)){try{body[key]=JSON.parse(value);}catch{}}}
    return{body,files};
  }
  throw new HttpError(415,'Format de requête non pris en charge');
}
async function serveFile(req,res,filename,headers={}){
  let stat;try{stat=await fs.stat(filename);}catch{throw new HttpError(404,'Fichier local absent');}
  if(!stat.isFile())throw new HttpError(404,'Fichier local absent');
  let start=0,end=stat.size-1,status=200;
  const range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range||'');
  if(range){start=Number(range[1]);end=range[2]?Math.min(Number(range[2]),end):end;if(start>end||start>=stat.size){res.writeHead(416,{'content-range':`bytes */${stat.size}`});res.end();return;}status=206;headers['content-range']=`bytes ${start}-${end}/${stat.size}`;}
  res.writeHead(status,{'content-type':types[path.extname(filename).toLowerCase()]||'application/octet-stream','content-length':Math.max(0,end-start+1),'accept-ranges':'bytes','cache-control':'no-cache',...headers});
  if(req.method==='HEAD'||!stat.size){res.end();return;}
  await new Promise((resolve,reject)=>{const stream=createReadStream(filename,{start,end});stream.on('error',reject);res.on('close',()=>{stream.destroy();resolve();});stream.on('end',resolve);stream.pipe(res);});
}
export async function createLocalServer(options={}){
  if(options.emulator)throw new Error('Game server integration is not included in this distribution.');
  const root=options.root||projectRoot,port=options.port??4318;
  let origin=`http://127.0.0.1:${port}`;
  const state=options.state||new State(options.database||path.join(root,'data/local.sqlite'));
  seedCore(state);commerce.seed(state);world.seed(state);
  const router=new Router();auth.register(router);commerce.register(router);world.register(router);
  const pusherSecret=state.meta('pusherSecret')||state.setMeta('pusherSecret',crypto.randomBytes(32).toString('hex'));
  const uploads=path.join(root,'data/uploads');await fs.mkdir(uploads,{recursive:true});
  let realtime;
  const renderClientAsset=createClientAssetRenderer(root);
  const services={origin,pusherSecret,emit:(...args)=>realtime?.emit(...args),saveUpload:async file=>{
    if(!file?.data?.length)throw new HttpError(422,'Fichier vide');
    const extension=path.extname(file.name||'').toLowerCase();
    if(!['.png','.jpg','.jpeg','.webp','.gif'].includes(extension))throw new HttpError(422,'Image PNG, JPG, GIF ou WebP requise');
    const name=crypto.randomBytes(18).toString('hex')+extension;await fs.writeFile(path.join(uploads,name),file.data,{flag:'wx'});return origin+'/uploads/'+name;
  }};
  if(!options.state&&!options.database&&!state.meta('clientCatalogImported')){
    const catalog=JSON.parse(await fs.readFile(path.join(root,'catalog/client-fr.json'),'utf8'));
    state.transaction(()=>{for(const row of catalog.items)state.put('items',row);for(const row of catalog.monsters)state.put('monsters',row);for(const row of state.list('products'))if(row.type==='item'&&row.item){const item=state.get('items',row.item.id);if(item)state.patch('products',row.id,{item});}
      for(const row of state.list('inventory')){const item=state.get('items',row.item_id||row.item?.id||row.item_template?.id);if(item)state.patch('inventory',row.id,{item,item_template:item});}
      state.setMeta('clientCatalogImported',true);});
  }
  router.post('/api/local/emulator/launcher-ticket',async ctx=>{
    ctx.requireUser();ctx.fail(503,'Aucun connecteur de serveur de jeu n’est fourni dans cette distribution.');
  },{auth:true});
  router.get('/api/launcher/zaap-connect/token',ctx=>{ctx.requireUser();ctx.fail(503,'La connexion automatique au serveur nécessite un connecteur fourni séparément.');});
  router.get('/local/routes',()=>({local_test:true,routes:router.inventory()}));
  router.get('/local/status',async()=>({mode:'local-test',projectRoot:root,origin,version:'1.4.65-local.1',database:path.relative(root,options.database||path.join(root,'data/local.sqlite')),routes:router.inventory().length,realtime:realtime?.stats(),records:Object.fromEntries(['users','players','gameAccounts','inventory','orders'].map(x=>[x,state.list(x).length])),clientCopy:await fs.access(path.join(root,'desktop/client-copy.json')).then(()=>true,()=>false),providers:{payments:'local test invoices; no real money',mail:'local mailbox',discord:'local association test',game:'external client; no game server or SQL connector included'},requests:state.requestSummary()}));
  router.get(/^\/local\/wiki(?:\/(?<slug>.*))?$/,ctx=>ctx.html(`<!doctype html><html lang="fr"><meta charset="utf-8"><title>Wiki local</title><style>body{font:16px system-ui;background:#101a20;color:#e5ede7;max-width:960px;margin:40px auto;padding:24px}a{color:#9dd455}pre{white-space:pre-wrap}</style><h1>Wiki du launcher — test local</h1><p>Cette page est hébergée dans la copie locale.</p><p><a href="/local/wiki/client">Installer le client</a> · <a href="/local/wiki/updates">Publier une mise à jour</a></p><pre>${escaped(ctx.params.slug==='client'?'Le bouton Jouer ouvre le client importé. La connexion au jeu utilise votre propre serveur ; aucun émulateur ni base de jeu ne sont inclus.':ctx.params.slug==='updates'?'Utilise le guide local et le préparateur de publication pour calculer les empreintes, préparer le ZIP et activer la version après vérification.':'Le guide complet est disponible à /local/guide. Les recherches encyclopédie, statistiques et classements restent dans les pages originales du launcher.')}</pre></html>`));
  // Original backoffice helper uses a separate /api base. Only known route aliases are normalized below.
  const normalizePath=value=>value.startsWith('/backoffice/api/')?value.slice('/backoffice'.length):value.startsWith('/drops/api/')?value.slice('/drops'.length):value;
  let manifestCache=null,manifestStamp=null;
  async function clientManifest(){try{const filename=path.join(root,'desktop/client-manifest.json'),stat=await fs.stat(filename),stamp=`${stat.mtimeMs}:${stat.size}`;if(!manifestCache||manifestStamp!==stamp){manifestCache=JSON.parse(await fs.readFile(filename,'utf8'));manifestStamp=stamp;}return manifestCache;}catch{throw new HttpError(503,'La copie vérifiée du client est encore en préparation');}}
  const server=http.createServer(async(req,res)=>{
    const started=Date.now();let requestPath='/';
    try{
      const host=req.headers.host||'';if(!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host))throw new HttpError(403,'Hôte non local refusé');
      if(!localOrigin(req.headers.origin))throw new HttpError(403,'Origine non locale refusée');
      const originHeader=req.headers.origin;if(originHeader){res.setHeader('access-control-allow-origin',originHeader);res.setHeader('access-control-allow-credentials','true');res.setHeader('vary','Origin');}
      res.setHeader('x-content-type-options','nosniff');
      if(req.method==='OPTIONS'){res.writeHead(204,{'access-control-allow-methods':'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS','access-control-allow-headers':'Authorization,Content-Type,X-Requested-With,X-XSRF-TOKEN,X-Socket-ID'});res.end();return;}
      const url=new URL(req.url,origin);requestPath=normalizePath(url.pathname);
      if(req.method==='GET'||req.method==='HEAD'){
        if(requestPath==='/'||requestPath==='/index.html'){await serveFile(req,res,path.join(root,'source/app/index.html'));return;}
        if(requestPath==='/tinymce/langs/fr-FR.js'){await serveFile(req,res,path.join(root,'node_modules/tinymce-i18n/langs8/fr-FR.js'));return;}
        if(requestPath.startsWith('/tinymce/')){await serveFile(req,res,below(path.join(root,'node_modules/tinymce'),decodeURIComponent(requestPath.slice(9))));return;}
        if(/^\/(js|css|img|fonts|icons|tinymce|assets|template|media|sounds|shop|wheel)\//.test(requestPath)||['/favicon.ico','/local-bootstrap.js','/local-fonts.css','/icons.svg','/logo.png','/logo_ico.png','/app.css','/dofusEmblems.js','/temporis_two.jpg','/temporis_two.svg','/1.jpg'].includes(requestPath)){
          const relative=decodeURIComponent(requestPath.slice(1)),appRoot=path.join(root,'source/app');
          const candidates=[below(appRoot,relative)];
          if(relative.startsWith('assets/template/'))candidates.push(below(appRoot,relative.slice('assets/'.length)));
          const aliases={'assets/template/icons/logo.png':'logo.png','favicon.ico':'icons/icon.ico','assets/template/media/click.wav':'media/click.6799a3c0.wav'};
          if(aliases[relative])candidates.push(below(appRoot,aliases[relative]));
          candidates.push(below(path.join(root,'assets-cache'),relative));
          candidates.push(below(path.join(root,'assets-client'),relative));
          let found;for(const candidate of candidates)if(await fs.stat(candidate).then(s=>s.isFile(),()=>false)){found=candidate;break;}
          if(!found)found=await renderClientAsset(requestPath);
          if(!found)throw new HttpError(404,'Ressource locale absente : '+relative);
          await serveFile(req,res,found);return;
        }
        if(requestPath.startsWith('/bundled/')){await serveFile(req,res,below(path.join(root,'source/app'),decodeURIComponent(requestPath.slice(9))));return;}
        if(requestPath.startsWith('/uploads/')){
          const relative=decodeURIComponent(requestPath.slice(9));
          if(/^avatars\/(local-default\.png|null|undefined)$/.test(relative)){await serveFile(req,res,path.join(root,'source/app/logo_ico.png'));return;}
          const file=below(uploads,relative);
          const actual=await fs.access(file).then(()=>file,()=>relative.startsWith('avatars/')?below(uploads,relative.slice(8)):file);
          await serveFile(req,res,actual,{'cache-control':'private, no-cache'});return;
        }
        if(requestPath==='/local/guide'){await serveFile(req,res,path.join(root,'GUIDE-INTEGRATION-FR.html'));return;}
        const guideFiles={'/local/docs/features':'docs/FONCTIONS-LAUNCHER-FR.html','/local/docs/updates':'docs/UPDATE-LOCAL.html','/local/docs/build':'BUILD-FR.html','/local/GUIDE-INTEGRATION-FR.html':'GUIDE-INTEGRATION-FR.html','/local/BUILD-FR.html':'BUILD-FR.html','/local/docs/FONCTIONS-LAUNCHER-FR.html':'docs/FONCTIONS-LAUNCHER-FR.html','/local/docs/UPDATE-LOCAL.html':'docs/UPDATE-LOCAL.html','/local/docs/CONTRATS-PUBLICATION-REFERENCE.html':'docs/CONTRATS-PUBLICATION-REFERENCE.html','/local/desktop/README-CLIENT-FR.html':'desktop/README-CLIENT-FR.html'};
        if(guideFiles[requestPath]){await serveFile(req,res,path.join(root,guideFiles[requestPath]));return;}
        const published=/^\/local\/releases\/([1-9]\d*)\/files\/(.+)$/.exec(requestPath);
        if(published){await serveFile(req,res,await snapshotPayload(root,published[1],decodeURIComponent(published[2])),{'cache-control':'public, max-age=31536000, immutable'});return;}
        if(requestPath.startsWith('/local/client-files/')){
          const relative=decodeURIComponent(requestPath.slice('/local/client-files/'.length)),manifest=await clientManifest();
          if(!Object.hasOwn(manifest,relative))throw new HttpError(404,'Fichier hors du manifeste client');
          const config=JSON.parse(await fs.readFile(path.join(root,'desktop/client-config.json'),'utf8'));
          const override=config.payloadOverrides?.[relative];
          if(override&&!String(override).startsWith('desktop/client-payload-overrides/'))throw new HttpError(500,'Override client hors du dossier autorisé');
          await serveFile(req,res,override?below(root,override):below(path.resolve(root,config.payloadRoot),relative));return;
        }
        const versions=/^\/launcher\/v2\/(main|beta|rush)\/versions\.json$/.exec(requestPath);
        if(versions){if(versions[1]!=='main')throw new HttpError(409,'Cette variante ne correspond pas au client fourni');res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({version:(await activeRelease(root)).version,local_test:true}));return;}
        if(/^\/launcher\/v2\/main\/fullclient\/win\/\w+\.json$/.test(requestPath)){const release=await selectRelease(root,url.searchParams.get('version'));if(!release.builtin){await serveFile(req,res,await releaseFile(root,release.manifestRelative));return;}const manifest=await clientManifest();res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(manifest));return;}
        if(requestPath.startsWith('/launcher/electron-updater/')&&requestPath.endsWith('.yml')){const data='version: 1.4.65\nfiles: []\npath: Abrak Launcher.exe\nsha512: ""\nreleaseDate: 2026-10-19T00:00:00.000Z\n';res.writeHead(200,{'content-type':'text/yaml'});res.end(data);return;}
        if(/^\/launcher\/v2\/main\/fullclient\/win\/\w+\.zip$/.test(requestPath)){const release=await selectRelease(root,url.searchParams.get('version'));await serveFile(req,res,release.builtin?path.join(root,'releases/client-main-1.zip'):await releaseFile(root,release.zipRelative));return;}
        if(requestPath.startsWith('/launcher/v2/main/graphics_packs/')){res.writeHead(200,{'content-type':'application/json'});res.end('{}');return;}
        if(/^\/launcher\/(img|images|icons|uploads)\//.test(requestPath)){
          const relative=decodeURIComponent(requestPath.replace(/^\/launcher\//,''));
          try{await serveFile(req,res,below(path.join(root,'source/app'),relative));return;}catch(error){if(error.status!==404)throw error;}
          throw new HttpError(404,'Cette image distante n’était pas livrée avec le programme');
        }
      }
      const {body,files}=await readBody(req);
      const user=auth.resolveUser(state,req),query=Object.fromEntries(url.searchParams);
      const result=await router.dispatch(req.method,requestPath,{body,files,query,user,state,services,req});
      res.writeHead(result.status,{'content-type':result.type,'cache-control':'no-store',...result.headers});
      res.end(req.method==='HEAD'?'':result.type.startsWith('application/json')?JSON.stringify(result.body):String(result.body));
      state.log(req.method,requestPath,result.status,`${Date.now()-started}ms`);
    }catch(error){const status=Number(error.status)||500;if(!res.headersSent){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify({message:error.message,local_test:true,...error.extra}));}else res.destroy();state.log(req.method,requestPath,status,error.message);if(status>=500)options.onError?.(error);}
  });
  realtime=attachRealtime(server,origin,pusherSecret);
  return{server,state,router,services,realtime,get origin(){return origin;},listen:()=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{origin=`http://127.0.0.1:${server.address().port}`;services.origin=origin;resolve(server.address());});}),close:async()=>{realtime.close();await new Promise(resolve=>server.close(resolve));if(!options.state)state.close();}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const instance=await createLocalServer({onError:error=>console.error('[local]',error.message)});
  await instance.listen();
  const resumed=await commerce.resumePending(instance.router,instance.state,instance.services);
  console.log(`Abrak local backend ${instance.origin} — ${instance.router.inventory().length} routes; ${instance.services.emulator?'owned native game bridge':'isolated fixtures'}, persistent SQLite; ${resumed.length} outbox recovery attempts.`);
  for(const signal of['SIGINT','SIGTERM'])process.on(signal,async()=>{await instance.close();process.exit(0);});
}
