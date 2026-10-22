import test from 'node:test';
import assert from 'node:assert/strict';
import {State} from '../state.mjs';
import {Router} from '../router.mjs';
import {seedCore} from '../seed.mjs';
import {seed,register,resumePending} from './commerce.mjs';

function setup(t,emulator){
  const state=new State(':memory:');seedCore(state);state.put('items',{id:39,name:{fr:'Amulette'}});seed(state);
  state.patch('gameAccounts',2,{emulator_account_id:272});state.patch('players',4,{emulator_player_id:18,emulator_name:'Launcher-Dalia'});
  const router=new Router();register(router);const services={origin:'http://127.0.0.1:4318',emulator,emit(){}};
  const api=async(method,url,body={},userId=2)=>(await router.dispatch(method,url,{body,query:{},state,services,user:state.get('users',userId),req:{method,url,headers:{}}})).body;
  const entry=state.list('inventory').find(i=>i.user_id===2&&i.type==='item');
  t.after(()=>state.close());return {state,router,services,api,entry};
}
const err=status=>Object.assign(new Error('Controlled bridge result'),{status});
const fails=(f,status)=>assert.rejects(f,e=>e.status===status);

test('real pickup persists reservation before the ACK and rejects concurrent overclaim',async t=>{
  let release,started,seen;const ready=new Promise(r=>started=r);
  const s=setup(t,{deliverItem:input=>{seen=input;started();return new Promise(resolve=>release=()=>resolve({success:true,persisted:true,operationId:input.operationId,objectId:9001}))}});
  const pending=s.api('POST','/api/inventory',{id:s.entry.id,account:2,quantity:2,operationId:'pickup-reserve-0001'});await ready;
  assert.equal(s.state.get('inventory',s.entry.id).quantity,3);assert.equal(s.state.list('commerceOutbox')[0].state,'pending');assert.equal(seen.accountId,272);assert.equal(seen.playerId,18);
  await fails(()=>s.api('POST','/api/inventory',{id:s.entry.id,account:2,quantity:2,operationId:'pickup-reserve-0002'}),409);
  release();const result=await pending;assert.equal(result.item.quantity,1);assert.equal(result.emulator_ack.objectId,9001);assert.equal(s.state.list('commerceOutbox')[0].state,'applied');
});

test('bridge commit followed by connection loss resumes the same operation without duplicate grant',async t=>{
  let calls=0,effects=0;const receipts=new Map();const s=setup(t,{deliverItem:async input=>{
    calls++;if(!receipts.has(input.operationId)){effects++;receipts.set(input.operationId,{success:true,persisted:true,operationId:input.operationId,objectId:9002});throw err(503)}return receipts.get(input.operationId);
  }});
  await fails(()=>s.api('POST','/api/inventory',{id:s.entry.id,account:2,quantity:1,operationId:'pickup-resume-0001'}),503);
  assert.equal(s.state.get('inventory',s.entry.id).quantity,3);assert.equal(s.state.list('commerceOutbox')[0].state,'pending');
  const result=await resumePending(s.router,s.state,s.services);assert.equal(result[0].status,'applied');assert.equal(effects,1);assert.equal(calls,2);assert.equal(s.state.get('inventory',s.entry.id).quantity,2);
  await s.api('POST','/api/inventory',{id:s.entry.id,account:2,quantity:1,operationId:'pickup-resume-0001'});assert.equal(effects,1);assert.equal(s.state.get('inventory',s.entry.id).quantity,2);
});

test('saved ACK survives a failure in SQLite settlement and resumes without another bridge call',async t=>{
  let calls=0;const s=setup(t,{deliverItem:async input=>{calls++;return {success:true,persisted:true,operationId:input.operationId,objectId:9003}}});
  const original=s.state.patch.bind(s.state);let crash=true;
  s.state.patch=(bucket,id,partial)=>{if(bucket==='inventory'&&crash){crash=false;throw err(503)}return original(bucket,id,partial)};
  await fails(()=>s.api('POST','/api/inventory',{id:s.entry.id,account:2,quantity:1,operationId:'pickup-sqlite-0001'}),503);
  assert.equal(s.state.list('commerceOutbox')[0].state,'acknowledged');assert.equal(s.state.get('inventory',s.entry.id).quantity,3);
  s.state.patch=original;await resumePending(s.router,s.state,s.services);assert.equal(calls,1);assert.equal(s.state.get('inventory',s.entry.id).quantity,2);
});

test('bank wallet stays intact until real ACK and reserved kamas cannot be spent by another flow',async t=>{
  let complete=false;const s=setup(t,{changeKamas:async input=>{if(!complete)throw err(503);return {success:true,persisted:true,operationId:input.operationId,kamas:500}}});s.state.patch('users',2,{kamas:1000});
  await fails(()=>s.api('POST','/api/pages/bak/web-bank',{player_id:4,server_id:5,amount:500,type:'+',operationId:'bank-resume-0001'}),503);assert.equal(s.state.get('users',2).kamas,1000);
  await fails(()=>s.api('POST','/api/pages/bak/offers',{server_id:5,type:'kamas',quantity:600,rate:100}),409);assert.equal(s.state.get('users',2).kamas,1000);
  complete=true;await resumePending(s.router,s.state,s.services);assert.equal(s.state.get('users',2).kamas,500);assert.equal(s.state.get('players',4).kamas,500);
  await s.api('POST','/api/pages/bak/web-bank',{player_id:4,server_id:5,amount:500,type:'+',operationId:'bank-resume-0001'});assert.equal(s.state.get('users',2).kamas,500);
});

test('subscription charges canonical price once and uses the actual game expiry',async t=>{
  let calls=0;const end=Date.parse('2033-01-01T00:00:00Z');const s=setup(t,{extendSubscriptions:async input=>{calls++;return {success:true,persisted:true,operationId:input.operationId,subscriptionEnds:{272:end}}}}),before=s.state.get('users',2).ogrines;
  const body={service_id:16,accounts:[2],quantity:99,price:0,operationId:'subscribe-real-0001'};
  const result=await s.api('POST','/api/service/checkout',body);assert.equal(result.real_emulator,true);assert.equal(s.state.get('users',2).ogrines,before-200);assert.equal(Date.parse(s.state.get('gameAccounts',2).subscription_end),end);
  await s.api('POST','/api/service/checkout',body);assert.equal(calls,1);assert.equal(s.state.get('users',2).ogrines,before-200);
});

test('wrong ACK, ownership violations and changed operation payload cannot consume inventory',async t=>{
  let calls=0;const s=setup(t,{deliverItem:async input=>{calls++;return {success:true,persisted:true,operationId:'different-operation',objectId:9004}}});
  await fails(()=>s.api('POST','/api/inventory',{id:s.entry.id,account:1,quantity:1,operationId:'pickup-invalid-0001'}),403);assert.equal(calls,0);
  await fails(()=>s.api('POST','/api/inventory',{id:s.entry.id,account:2,quantity:1,operationId:'pickup-invalid-0002'}),503);assert.equal(s.state.get('inventory',s.entry.id).quantity,3);
  await fails(()=>s.api('POST','/api/inventory',{id:s.entry.id,account:2,quantity:2,operationId:'pickup-invalid-0002'}),409);assert.equal(calls,1);
});

test('real account transfer charges once after ACK and replays after the local owner account changes',async t=>{
  let calls=0;const s=setup(t,{transferPlayer:async input=>{calls++;return {success:true,persisted:true,operationId:input.operationId,playerId:input.playerId,accountId:input.destinationAccountId}}});
  s.state.put('gameAccounts',{id:3,user_id:2,name:'Second compte',emulator_account_id:273});const before=s.state.get('users',2).ogrines;
  const body={service_id:21,player_id:4,server_id:5,account_to_id:3,quantity:1,operationId:'transfer-account-0001'};
  const result=await s.api('POST','/api/service/checkout',body);assert.equal(result.real_emulator,true);assert.equal(s.state.get('players',4).account_id,3);assert.equal(s.state.get('players',4).emulator_account_id,273);assert.equal(s.state.get('users',2).ogrines,before-150);
  await s.api('POST','/api/service/checkout',body);assert.equal(calls,1);assert.equal(s.state.get('users',2).ogrines,before-150);
});

test('real account transfer connection loss resumes with unchanged fee and operation ID',async t=>{
  let calls=0;const receipts=new Map();const s=setup(t,{transferPlayer:async input=>{calls++;if(!receipts.has(input.operationId)){receipts.set(input.operationId,{success:true,persisted:true,operationId:input.operationId,playerId:input.playerId,accountId:input.destinationAccountId});throw err(503)}return receipts.get(input.operationId)}});
  s.state.put('gameAccounts',{id:3,user_id:2,name:'Second compte',emulator_account_id:273});const before=s.state.get('users',2).ogrines;
  await fails(()=>s.api('POST','/api/service/checkout',{service_id:21,player_id:4,server_id:5,account_to_id:3,operationId:'transfer-resume-0001'}),503);
  assert.equal(s.state.get('users',2).ogrines,before);assert.equal(s.state.get('players',4).account_id,2);
  await resumePending(s.router,s.state,s.services);assert.equal(calls,2);assert.equal(receipts.size,1);assert.equal(s.state.get('users',2).ogrines,before-150);assert.equal(s.state.get('players',4).account_id,3);
});

test('gift transfer reserves its service fee until the recipient chooses a real destination',async t=>{
  let calls=0;const s=setup(t,{transferPlayer:async input=>{calls++;assert.equal(input.webUserId,2);assert.equal(input.destinationWebUserId,1);return {success:true,persisted:true,operationId:input.operationId,playerId:input.playerId,accountId:input.destinationAccountId}}});s.state.patch('gameAccounts',1,{emulator_account_id:271});
  const before=s.state.get('users',2).ogrines,code=s.state.get('users',1).player_code;
  const pending=await s.api('POST','/api/service/checkout',{service_id:21,player_id:4,server_id:5,user_to_code:code});assert.equal(pending.pending,true);assert.equal(pending.real_emulator,false);assert.equal(calls,0);assert.equal(s.state.get('users',2).ogrines,before);
  const result=await s.api('POST','/api/market/transfert/5/4',{account_id:1,operationId:'transfer-gift-final-0001'},1);assert.equal(result.real_emulator,true);assert.equal(calls,1);assert.equal(s.state.get('players',4).user_id,1);assert.equal(s.state.get('players',4).account_id,1);assert.equal(s.state.get('users',2).ogrines,before-150);
  await s.api('POST','/api/market/transfert/5/4',{account_id:1,operationId:'transfer-gift-final-0001'},1);assert.equal(calls,1);assert.equal(s.state.get('users',2).ogrines,before-150);
});

test('market finalisation changes both real and local ownership and refuses cancellation while ACK is uncertain',async t=>{
  let attempts=0;const receipts=new Map();const s=setup(t,{transferPlayer:async input=>{attempts++;if(!receipts.has(input.operationId)){receipts.set(input.operationId,{success:true,persisted:true,operationId:input.operationId,playerId:input.playerId,accountId:input.destinationAccountId});throw err(503)}return receipts.get(input.operationId)}});
  s.state.patch('gameAccounts',1,{emulator_account_id:271});s.state.patch('players',3,{emulator_player_id:17,emulator_account_id:271});
  await s.api('POST','/api/market/buy',{player_id:3,server_id:5,account_id:2});const charged=s.state.get('users',2).ogrines;
  await fails(()=>s.api('POST','/api/market/transfert/5/3',{account_id:2,operationId:'market-real-final-0001'}),503);
  await fails(()=>s.api('POST','/api/market/cancel/5/3'),409);assert.equal(s.state.get('users',2).ogrines,charged);
  const resumed=await resumePending(s.router,s.state,s.services);assert.equal(resumed[0].status,'applied');assert.equal(attempts,2);assert.equal(receipts.size,1);assert.equal(s.state.get('players',3).user_id,2);assert.equal(s.state.get('players',3).emulator_account_id,272);assert.equal(s.state.get('players',3).current_transfert,null);
});

test('real-mode catalogue hides undefined service20 and uses existing bundled category/service images',async t=>{
  const s=setup(t,{}),sections=await s.api('GET','/api/products/all'),services=sections.find(row=>row.name==='services').products;
  assert(!services.some(p=>p.id===20));assert.equal(services.find(p=>p.id===21).service.computed_img,'6.png');assert(sections.every(row=>row.background_image==='/bundled/img/blue-green-white-bg.9e3091b7.jpg'));
  await fails(()=>s.api('POST','/api/service/checkout',{service_id:20,player_id:4}),409);
});
