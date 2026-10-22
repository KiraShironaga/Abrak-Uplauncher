import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import{activeRelease,selectRelease,snapshotPayload}from'../client-releases.mjs';

test('immutable release selection survives activation and refuses unlisted files',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'abrak-release-contract-'));
  try{
    await fs.mkdir(path.join(root,'data'));
    assert.equal((await activeRelease(root)).version,1);
    for(const version of[2,3]){
      const base=`releases/snapshots/${version}`;await fs.mkdir(path.join(root,base,'files'),{recursive:true});
      await fs.writeFile(path.join(root,base,'client.zip'),'fixture ZIP, not installed');
      await fs.writeFile(path.join(root,base,'files/config.xml'),String(version));
      await fs.writeFile(path.join(root,base,'manifest.json'),JSON.stringify({'config.xml':{size:1,hash:'0'.repeat(40),fileUrl:`http://127.0.0.1:4318/local/releases/${version}/files/config.xml`}}));
    }
    const pointer=version=>({version,manifestRelative:`releases/snapshots/${version}/manifest.json`,zipRelative:`releases/snapshots/${version}/client.zip`,rootRelative:`releases/snapshots/${version}/files`});
    await fs.writeFile(path.join(root,'data/client-release.json'),JSON.stringify(pointer(2)));
    const pinned=await selectRelease(root,'2');
    await fs.writeFile(path.join(root,'data/client-release.json'),JSON.stringify(pointer(3)));
    assert.equal((await selectRelease(root)).version,3);
    assert.equal(pinned.version,2);
    assert.equal(await fs.readFile(await snapshotPayload(root,'2','config.xml'),'utf8'),'2');
    await assert.rejects(snapshotPayload(root,'2','secret.txt'),e=>e.status===404);
    await assert.rejects(snapshotPayload(root,'2','../data/local.sqlite'),e=>e.status===400);
    await assert.rejects(selectRelease(root,'2x'),e=>e.status===400);
    await fs.writeFile(path.join(root,'data/client-release.json'),JSON.stringify({...pointer(3),manifestRelative:'data/local.sqlite'}));
    await assert.rejects(activeRelease(root),e=>e.status===503);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
