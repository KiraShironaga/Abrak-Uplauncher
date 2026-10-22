import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from'node:path';
const temporary=path.resolve('work/temp');await fs.mkdir(temporary,{recursive:true});
const tests=[];
for(const directory of['backend/tests','backend/modules','desktop'])for(const entry of await fs.readdir(directory))if(/(?:[.-]test\.mjs|\.test\.cjs)$/.test(entry))tests.push(directory+'/'+entry);
const child=spawn(process.execPath,['--test',...tests],{stdio:'inherit',shell:false,env:{...process.env,TEMP:temporary,TMP:temporary}});child.on('error',error=>{console.error(error);process.exitCode=1;});child.on('exit',code=>process.exitCode=code||0);
