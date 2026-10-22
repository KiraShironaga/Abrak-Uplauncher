import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {ROOT,saveJson} from './project.mjs';

const files=execFileSync('git',['-C',ROOT,'ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8',windowsHide:true}).split('\0').filter(Boolean);
const unique=[...new Set(files)].sort(),findings=[];
const forbidden=/^(?:data|client|releases|downloads|work|evidence|profile(?:-local)?|runtime-template|runtime)\/|(?:^|\/)node_modules\/|^emulator\/(?:private|database|run|logs|snapshots)\/|^emulator\/(?:Login|Game)\/(?:build\/|Logs\/|config\.(?:properties|txt)$)|^desktop\/client-(?:activation-backups|payload-overrides)\/|(?:^|\/)\.env(?:\.|$)|\.(?:sqlite(?:-wal|-shm)?|db|log|sol|pem|key|p12|pfx|exe|dll|jar|zip|rar|7z)$/i;
const textFiles=/\.(?:md|html|js|mjs|cjs|css|json|yml|yaml|txt|xml|svg|properties|java|kt|py|cmd|gitignore|gitattributes)$/i;
const residues=/(?:co)(?:dex)(?:projects|-runtimes)|(?:chat)(?:gpt)|(?:open)(?:ai)|(?:generated|created|written)\s+(?:by|with)\s+(?:an?\s+)?(?:AI|LLM)/i;
const userPath=/(?:[a-z]:[\\/]+users[\\/]+(?!public\b|default\b)[^\\/"'\s]+)/i;
const unixHome=/(?:^|["'\s])\/(?:Users|home)\/[^/\s"']+/;
const privateKey=/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
const privateDatabasePath=/(?:^|\/)(?:database|databases|db|sql|migrations?|backups?|dumps?)\/|\.(?:sql(?:\.gz)?|sqlite\w*(?:-wal|-shm)?|db3?|dump|bak|backup|bson|ibd|frm|myd|myi|mdb|accdb)$/i;
const serverSource=/^(?:emulator|Game|Login)\/|^backend\/modules\/emulator(?:-bootstrap|-contract\.test)?\.mjs$|^tools\/(?:emulator-sql|migrate-emulator)\.mjs$|\.(?:java|kt|class|jar)$/i;
const sqliteHeader=Buffer.from('SQLite format 3\0');
const sqlDumpHeader=/^--\s*(?:MySQL dump|PostgreSQL database dump|phpMyAdmin SQL Dump)\b/im;
const credential=/(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd|keystore_password)\s*["']?\s*[:=]\s*["']([A-Za-z0-9_!+\/-]{16,})["']/gi;
const denyArg=process.argv.indexOf('--deny-values');
const denyValues=denyArg<0?[]:JSON.parse(await fs.readFile(process.argv[denyArg+1],'utf8')).filter(x=>typeof x==='string'&&x.length>=8);
let bytes=0,largest={path:'',bytes:0};
for(const relative of unique){
  const name=relative.replaceAll('\\','/'),file=path.join(ROOT,relative),stat=await fs.lstat(file);
  const add=type=>findings.push({file:name,type});
  if(stat.isSymbolicLink()){add('linked file');continue;}
  if(name.startsWith('emulator/')||forbidden.test(name)||/^desktop\/client-(?:config|copy|manifest|clone-activation)\.json$/.test(name))add('private or generated file');
  if(privateDatabasePath.test(name))add('database or database export');
  if(serverSource.test(name))add('game server source or private connector');
  if(residues.test(name))add('environment naming residue');
  if(stat.size>50*1024*1024)add('oversized source file');
  bytes+=stat.size;if(stat.size>largest.bytes)largest={path:name,bytes:stat.size};
  const buffer=await fs.readFile(file);
  if(buffer.subarray(0,sqliteHeader.length).equals(sqliteHeader))add('SQLite database content');
  if(sqlDumpHeader.test(buffer.subarray(0,65536).toString('utf8')))add('SQL dump content');
  if(denyValues.some(value=>buffer.includes(Buffer.from(value))))add('private value');
  if(!textFiles.test(name)&&!name.startsWith('.'))continue;
  const content=buffer.toString('utf8');
  if(residues.test(content))add('environment text residue');
  if(userPath.test(content)||unixHome.test(content))add('personal home path');
  if(privateKey.test(content))add('private key');
  // Demonstration credentials, explicit test fixtures and third-party attribution are retained.
  for(const match of content.matchAll(credential))if(!/(?:local|test|demo|example|placeholder|wrong|fake)/i.test(match[1]))add('credential literal to review');
}
const report={status:findings.length?'FAIL':'PASS',files:unique.length,totalBytes:bytes,largestFile:largest,checks:['publication file allowlist','databases and SQL exports','game server sources and connectors','database binary signatures','personal home paths','environment naming and text','private keys','credential literals','source file size','optional private denylist'],findings};
await saveJson('publication.json',report);
console.log(JSON.stringify(report,null,2));if(findings.length)process.exitCode=1;
