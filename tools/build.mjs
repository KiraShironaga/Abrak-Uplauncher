import fs from 'node:fs/promises';
import path from 'node:path';
import {createPackageWithOptions,listPackage,statFile,extractFile,uncache} from '@electron/asar';
import {ROOT,APP,OUTPUT,STAGING,checkedRemove,fileRecords,verifyAssets,saveJson,digest} from './project.mjs';

if(process.platform!=='win32'||process.arch!=='x64')throw Error('La compilation desktop fournie cible Windows x64.');
const electronRoot=path.join(ROOT,'node_modules/electron'),runtime=path.join(electronRoot,'dist');
const expected=JSON.parse(await fs.readFile(path.join(electronRoot,'package.json'),'utf8')).version;
const actual=(await fs.readFile(path.join(runtime,'version'),'utf8')).trim();
if(expected!==actual)throw Error('Version du runtime différente du paquet installé.');
await fs.access(path.join(APP,'node_modules/fs-extra/package.json')).catch(()=>{throw Error('Lancer npm run setup avant la compilation.');});
const excludedFile=name=>/\.(?:log|sqlite(?:-wal|-shm)?|sol)$/i.test(name)||/(?:^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|profile|profile-local)(?:\/|$)/i.test(name);
const assets=await verifyAssets(),sources=(await fileRecords(APP)).filter(item=>!excludedFile(item.path));
await checkedRemove(STAGING);await fs.mkdir(path.dirname(STAGING),{recursive:true});
await fs.cp(runtime,STAGING,{recursive:true,errorOnExist:true,force:false});
await fs.rename(path.join(STAGING,'electron.exe'),path.join(STAGING,'Abrak Launcher.exe'));
await fs.mkdir(path.join(STAGING,'resources'),{recursive:true});
await fs.rm(path.join(STAGING,'resources/default_app.asar'),{force:true});
const archive=path.join(STAGING,'resources/app.asar');await createPackageWithOptions(APP,archive,{globOptions:{ignore:['**/*.log','**/*.sqlite','**/*.sqlite-wal','**/*.sqlite-shm','**/*.sol','**/.env','**/.env.*','**/.npmrc','**/profile/**','**/profile-local/**']}});uncache(archive);
const actualMembers=new Map();
for(const member of listPackage(archive)){
  const relative=member.replace(/^[\\/]+/,'').replaceAll('\\','/'),native=relative.split('/').join(path.sep),stat=statFile(archive,native,false);
  if(stat.files)continue;
  if(stat.link||stat.unpacked)throw Error('Archive link or unpacked member refused');
  const data=extractFile(archive,native);actualMembers.set(relative,{size:data.length,sha256:digest(data)});
}
if(actualMembers.size!==sources.length)throw Error('ASAR member count differs from source');
for(const source of sources){const entry=actualMembers.get(source.path);if(!entry||entry.size!==source.size||entry.sha256!==source.sha256)throw Error('ASAR verification failed: '+source.path);}
await fs.writeFile(path.join(STAGING,'resources/app-update.yml'),'provider: generic\nurl: http://127.0.0.1:4318/launcher/electron-updater\nupdaterCacheDirName: abrak-launcher-updater\n');
await checkedRemove(OUTPUT);await fs.mkdir(path.dirname(OUTPUT),{recursive:true});await fs.rename(STAGING,OUTPUT);
await saveJson('build.json',{status:'PASS',electron:actual,archiveMembers:sources.length,bundledAssets:assets,archiveSha256:digest(await fs.readFile(path.join(OUTPUT,'resources/app.asar')))});
console.log(`Compilation vérifiée: ${sources.length} fichiers, ${assets} assets préservés.\ndist/Abrak Launcher/Abrak Launcher.exe`);
