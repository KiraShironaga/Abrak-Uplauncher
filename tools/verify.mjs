import assert from 'node:assert/strict';
import {createLocalServer} from '../backend/server.mjs';
import {State} from '../backend/state.mjs';
import {verifyAssets,saveJson} from './project.mjs';

const state=new State(':memory:'),app=await createLocalServer({state,port:0});
const checks=[];
try{
  await app.listen();
  const call=async(url,token)=>{const response=await fetch(app.origin+url,{headers:token?{Authorization:'Bearer '+token}:{}});return{status:response.status,body:await response.json()};};
  const admin=(await call('/local/session?user=1')).body,player=(await call('/local/session?user=2')).body;
  assert.equal(admin.user.role_id,4);assert.equal(player.user.role_id,0);checks.push('demo roles');
  assert.equal((await call('/api/admin/process-detections/users/1/context',admin.token)).status,200);checks.push('admin anti-cheat context');
  assert.equal((await call('/api/admin/process-detections/users/1/context',player.token)).status,403);checks.push('player denied admin');
  assert.equal((await call('/api/admin/process-detections/users/1/context')).status,401);checks.push('anonymous denied admin');
  const count=await verifyAssets();checks.push(`${count} original bundled assets`);
  const response=await fetch(app.origin+'/');assert.equal(response.status,200);assert.match(await response.text(),/local-bootstrap/);checks.push('frontend served');
  const report={status:'PASS',checks,routes:app.router.inventory().length};await saveJson('verification.json',report);console.log(JSON.stringify(report));
}finally{await app.close();state.close();}
