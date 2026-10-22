import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {ROOT,APP} from './project.mjs';

if(Number(process.versions.node.split('.')[0])<24)throw Error('Node.js 24.15 ou supérieur est requis.');
try{await fs.copyFile(path.join(ROOT,'desktop/client-config.example.json'),path.join(ROOT,'desktop/client-config.json'),fs.constants.COPYFILE_EXCL);}catch(e){if(e.code!=='EEXIST')throw e;}
// npm-cli.js is supplied by npm itself; no machine-specific executable is stored.
const npm=process.env.npm_execpath;
if(!npm)throw Error('Lancer cette commande avec npm run setup.');
const child=spawn(process.execPath,[npm,'ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:APP,stdio:'inherit',shell:false});
await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('Installation des dépendances du launcher refusée.')));});
console.log('Configuration locale créée; dépendances du launcher installées. npm run build puis npm run desktop.');
