import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {State} from '../state.mjs';
import {Router} from '../router.mjs';
import {seedCore} from '../seed.mjs';
import {register,seed} from './commerce.mjs';

function setup(t, filename=':memory:') {
  const state=new State(filename);seedCore(state);
  state.put('items',{id:39,name:{fr:'Épée locale'},description:{fr:'Test'},computed_img:'39.svg',effects:[]});
  seed(state);const router=new Router();register(router);const events=[];
  const api=async(method,url,body={},userId=2)=>{
    const parsed=new URL(url,'http://127.0.0.1:14555');
    const response=await router.dispatch(method,parsed.pathname,{body,query:Object.fromEntries(parsed.searchParams),user:userId?state.get('users',userId):null,state,services:{origin:parsed.origin,emit:(...args)=>events.push(args)}});
    return response.body;
  };
  t.after(()=>state.close());return {state,router,api,events};
}
async function rejectsStatus(action,status) {await assert.rejects(action,error=>error.status===status)}
const ownedRows=(state,uid=2)=>state.list('inventory').filter(x=>x.user_id===uid);

test('shop and inventory expose the recovered consumer shapes and ownership',async t=>{
  const {api}=setup(t),sections=await api('GET','/api/products/all');
  assert(sections.some(s=>s.name==='services'&&s.products.some(p=>p.service.translation[0].title)));
  const rows=await api('GET','/api/inventory');assert(rows.length>0);assert(rows.every(r=>r.user_id===2));
  assert(rows.find(r=>r.type==='item').item.name.fr);
  await rejectsStatus(()=>api('GET','/api/inventory',{},null),401);
  const market=await api('GET','/api/products/market/5');assert(Array.isArray(market.players));assert(market.players.length>0);assert.equal(market.pagination.total,market.players.length);
});

test('gift code is persistent, transactional and one claim per user',async t=>{
  const {api,state}=setup(t),before=ownedRows(state).length;
  const result=await api('POST','/api/inventory/code/LOCAL-GIFT');assert(result.success);assert.equal(result.data.length,2);assert.equal(ownedRows(state).length,before+2);
  await rejectsStatus(()=>api('POST','/api/inventory/code/LOCAL-GIFT'),409);assert.equal(ownedRows(state).length,before+2);
  const other=await api('POST','/api/inventory/code/LOCAL-GIFT',{},1);assert(other.success);
});

test('checkout ignores client supplied prices and grants exactly once',async t=>{
  const {api,state,events}=setup(t),before=state.get('users',2).ogrines,inventory=ownedRows(state).length;
  const order=await api('POST','/api/order',{gateway:'ogrines',products:[{id:2001,type:'item',quantity:2,price:0,total:-1000}]});
  assert.equal(order.total,200);assert.equal(order.status,'pending');
  await api('POST',`/api/order/${order.id}/pay/ogrines`);assert.equal(state.get('users',2).ogrines,before-200);assert.equal(ownedRows(state).length,inventory+1);
  await api('POST',`/api/order/${order.id}/pay/ogrines`);assert.equal(state.get('users',2).ogrines,before-200);assert.equal(ownedRows(state).length,inventory+1);
  assert(events.some(e=>e[1]==='OgrinesCommit'&&e[2][0]===before-200));
});

test('invalid checkout quantities/types/gateways cannot create an order',async t=>{
  const {api,state}=setup(t),before=state.list('orders');
  for(const quantity of [0,-1,1.5,100,Number.MAX_SAFE_INTEGER])await rejectsStatus(()=>api('POST','/api/order',{gateway:'ogrines',products:[{id:2001,type:'item',quantity}]}),422);
  await rejectsStatus(()=>api('POST','/api/order',{gateway:'ogrines',products:[{id:2001,type:'service',quantity:1}]}),422);
  await rejectsStatus(()=>api('POST','/api/order',{gateway:'crypto',products:[{id:2001,type:'item',quantity:1}]}),422);
  await rejectsStatus(()=>api('POST','/api/order',{gateway:'ogrines',products:[{id:2001,quantity:1},{id:2001,quantity:1}]}),422);
  assert.deepEqual(state.list('orders'),before);
});

test('malformed bodies and negative catalogue prices cannot mutate wallets',async t=>{
  const {api,state}=setup(t),before=state.get('users',2).ogrines;
  await rejectsStatus(()=>api('POST','/api/order',null),422);
  await rejectsStatus(()=>api('POST','/api/order',[]),422);
  const p=state.get('products',2001);state.patch('products',2001,{prices:{ogrines:{value:-100}}});
  await rejectsStatus(()=>api('POST','/api/order',{gateway:'ogrines',products:[{id:2001,quantity:1}]}),422);
  assert.equal(state.get('users',2).ogrines,before);assert.equal(state.list('orders').length,0);state.put('products',p);
});

test('insufficient wallet rolls back fulfilment and keeps order pending',async t=>{
  const {api,state}=setup(t);state.patch('users',2,{ogrines:50});const before=ownedRows(state);
  const order=await api('POST','/api/order',{gateway:'ogrines',products:[{id:2001,quantity:1}]});
  await rejectsStatus(()=>api('POST',`/api/order/${order.id}/pay/ogrines`),409);
  assert.equal(state.get('users',2).ogrines,50);assert.equal(state.get('orders',order.id).status,'pending');assert.deepEqual(ownedRows(state),before);
});

test('other users cannot inspect or pay an order',async t=>{
  const {api}=setup(t);const order=await api('POST','/api/order',{gateway:'ogrines',products:[{id:2001,quantity:1}]});
  await rejectsStatus(()=>api('GET',`/api/order/${order.id}`,{},1),403);
  await rejectsStatus(()=>api('POST',`/api/order/${order.id}/pay/ogrines`,{},1),403);
});

test('inventory pickup validates both inventory and account ownership before decrement',async t=>{
  const {api,state}=setup(t),entry=ownedRows(state).find(i=>i.type==='item'),before=state.get('inventory',entry.id);
  await rejectsStatus(()=>api('POST','/api/inventory',{id:entry.id,account:1,quantity:1,server_id:5}),403);assert.deepEqual(state.get('inventory',entry.id),before);
  await rejectsStatus(()=>api('POST','/api/inventory',{id:entry.id,account:2,quantity:99,server_id:5}),409);
  await rejectsStatus(()=>api('POST','/api/inventory',{id:entry.id,account:2,quantity:-1,server_id:5}),422);
  const result=await api('POST','/api/inventory',{id:entry.id,account:2,quantity:2,server_id:5});assert.equal(result.item.quantity,before.quantity-2);assert.equal(state.list('commerceDeliveries')[0].mode,'local-test');
  assert.equal(state.get('gameAccounts',2).local_inventory[0].quantity,2);
  await rejectsStatus(()=>api('POST','/api/inventory',{id:entry.id,account:1,quantity:1,server_id:5},1),403);
});

test('world reward item_template can be displayed and claimed without product_id',async t=>{
  const {api,state}=setup(t),item=state.get('items',39),entry=state.put('inventory',{user_id:2,type:'item',item_id:39,item_template:item,quantity:120});
  assert.equal((await api('GET','/api/inventory')).find(i=>i.id===entry.id).item.id,39);
  const result=await api('POST','/api/inventory',{id:entry.id,account:2,quantity:120,server_id:5});assert.equal(result.item.quantity,0);
});

test('subscription extends the existing future expiry and rejects foreign accounts atomically',async t=>{
  const {api,state}=setup(t),before=state.get('users',2).ogrines,end=Date.parse(state.get('gameAccounts',2).subscription_end);
  await rejectsStatus(()=>api('POST','/api/service/checkout',{service_id:16,accounts:[1],quantity:1}),403);assert.equal(state.get('users',2).ogrines,before);
  await api('POST','/api/service/checkout',{service_id:16,accounts:[2],quantity:1,auto_renew:true});
  const account=state.get('gameAccounts',2);assert.equal(Date.parse(account.subscription_end),end+7*86400000);assert.equal(account.auto_renew,true);assert.equal(account.subscription,account.subscribed_until);
});

test('arcane subscriptions require owned accounts and debit the canonical local price',async t=>{
  const {api,state}=setup(t),before=state.get('users',2).arcanes;
  const result=await api('POST','/api/shop/gemmes/abonnement',{duration:'week',accounts:[2]});assert(result.success);assert.equal(result.balance,before-70);
  await rejectsStatus(()=>api('POST','/api/shop/gemmes/abonnement',{duration:'week',accounts:[1]}),403);assert.equal(state.get('users',2).arcanes,before-70);
});

test('arcane shop cannot buy a service disguised as an item or overspend',async t=>{
  const {api,state}=setup(t),before=state.get('users',2).arcanes;
  await rejectsStatus(()=>api('POST','/api/shop/gemmes',{items:[{id:16,quantity:1}]}),422);assert.equal(state.get('users',2).arcanes,before);
  const result=await api('POST','/api/shop/gemmes',{items:[{id:2001,quantity:3}]});assert.equal(result.balance,before-30);
});

test('local payment requires unguessable capability and explicit confirmation, idempotently',async t=>{
  const {api,state}=setup(t),before=state.get('users',2).ogrines;
  const invoice=await api('GET','/api/btcpay/invoice/1001');assert.equal(invoice.local_test,true);assert(invoice.checkoutUrl.startsWith('http://127.0.0.1:14555/local/payments/'));
  assert.equal(state.get('users',2).ogrines,before);
  const p=state.list('commercePayments')[0];
  await rejectsStatus(()=>api('POST',`/local/payments/${p.id}?token=wrong`,{confirm:'local-test'},null),404);
  await rejectsStatus(()=>api('POST',invoice.checkoutUrl,{confirm:true},null),422);assert.equal(state.get('users',2).ogrines,before);
  const html=await api('POST',invoice.checkoutUrl,{confirm:'local-test'},null);assert(html.includes('Aucune carte'));assert(html.includes('Simulation confirmée'));assert(!html.includes('pay.abrak.fr'));
  assert.equal(state.get('users',2).ogrines,before+1000);
  await api('POST',invoice.checkoutUrl,{confirm:'local-test'},null);assert.equal(state.get('users',2).ogrines,before+1000);
  const frame=await api('GET','/invoice?id='+invoice.invoice_id,{},null);assert(frame.includes('invoice_confirmed'));
});

test('expired local invoice cannot grant a paid pack',async t=>{
  const {api,state}=setup(t),before=state.get('users',2).ogrines,invoice=await api('GET','/api/btcpay/invoice/1001');
  state.patch('commercePayments',1,{expires_at:'2000-01-01T00:00:00Z'});
  await rejectsStatus(()=>api('POST',invoice.checkoutUrl,{confirm:'local-test'},null),409);assert.equal(state.get('users',2).ogrines,before);
});

test('promo and local entitlement payments affect only local persistent fields',async t=>{
  const {api,state}=setup(t),before=state.get('users',2).ogrines;
  const promo=await api('POST','/api/promo/validate',{code:'LOCAL10'});assert.equal(promo.buyer_percent,10);
  const pack=await api('GET','/api/tebex/redirect/1001');await api('POST',pack.url,{confirm:'local-test'},null);assert.equal(state.get('users',2).ogrines,before+1100);
  const vip=await api('GET','/api/tebex/redirect/7002');assert(!state.get('users',2).vip_until);await api('POST',vip.url,{confirm:'local-test'},null);assert(Date.parse(state.get('users',2).vip_until)>Date.now());
});

test('player codes disclose only a local name/code and support the recovered normalizer',async t=>{
  const {api,state}=setup(t),own=await api('GET','/api/player-code');assert.match(own.code,/^ABK-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
  const code=state.get('users',1).player_code,lookup=await api('GET','/api/player-code/lookup?code='+encodeURIComponent(code.toLowerCase().replace('-', ' - ')));
  assert.equal(lookup.name,state.get('users',1).name);assert.equal(lookup.email,undefined);
  await rejectsStatus(()=>api('GET','/api/player-code/lookup?code=ABK-000000'),404);
});

test('scheduled promotions require admin and return the recovered CRUD/stat shapes',async t=>{
  const {api,state}=setup(t),draft={ogrine_id:1001,percent:15,max_per_user:2,starts_at:'2020-01-01 00:00',ends_at:'2099-01-01 00:00',active:true};
  for(const [method,url,body] of [['GET','/api/admin/ogrine-promos',{}],['GET','/api/admin/ogrine-promos/packs',{}],['POST','/api/admin/ogrine-promos',draft]])await rejectsStatus(()=>api(method,url,body),403);
  const packs=await api('GET','/api/admin/ogrine-promos/packs',{},1);assert.equal(packs.find(p=>p.id===1001).price,5);
  const created=await api('POST','/api/admin/ogrine-promos',draft,1);assert(created.id);assert.equal(created.ogrine.id,1001);assert.equal(created.purchases_count,0);
  const stats=await api('GET',`/api/admin/ogrine-promos/${created.id}/stats`,{},1);assert.equal(stats.total_purchases,0);assert.deepEqual(stats.timeline,[]);assert.equal(stats.avg_first_delay_min,null);
  const updated=await api('PUT',`/api/admin/ogrine-promos/${created.id}`,{...draft,percent:20,active:false},1);assert.equal(updated.id,created.id);assert.equal(updated.percent,20);assert.equal(updated.active,false);
  await api('DELETE',`/api/admin/ogrine-promos/${created.id}`,{},1);assert.equal(state.get('commerceOgrinePromos',created.id),null);
  await rejectsStatus(()=>api('GET',`/api/admin/ogrine-promos/${created.id}/stats`,{},1),404);
});

test('invalid promotion bodies cannot create or change a campaign',async t=>{
  const {api,state}=setup(t),draft={ogrine_id:1001,percent:15,max_per_user:2,starts_at:'2020-01-01',ends_at:'2099-01-01',active:true},before=state.list('commerceOgrinePromos');
  for(const invalid of [null,[],{...draft,ogrine_id:2001},{...draft,percent:-1},{...draft,percent:101},{...draft,max_per_user:0},{...draft,starts_at:'invalid'},{...draft,ends_at:'2010-01-01'},{...draft,active:'yes'}])await rejectsStatus(()=>api('POST','/api/admin/ogrine-promos',invalid,1),422);
  await rejectsStatus(()=>api('PUT','/api/admin/ogrine-promos/1',{...draft,percent:-3},1),422);assert.deepEqual(state.list('commerceOgrinePromos'),before);
});

test('scheduled pack bonus is bounded per user and payment replay cannot alter its statistics',async t=>{
  const {api,state}=setup(t),before=state.get('users',2).ogrines;
  const promo=await api('POST','/api/admin/ogrine-promos',{ogrine_id:1001,percent:15,max_per_user:2,starts_at:'2020-01-01',ends_at:'2099-01-01',active:true},1);
  assert.equal((await api('GET','/api/pages/ogrine-promos/active')).active,true);
  assert.equal((await api('GET','/api/products/ogrine')).find(p=>p.id===1001).promo.remaining,2);
  const order=await api('POST','/api/order',{gateway:'crypto',products:[{id:1001,quantity:3,type:'ogrine'}]});
  const paymentUrl=await api('POST',`/api/order/${order.id}/pay/crypto`);await api('POST',paymentUrl,{confirm:'local-test'},null);
  assert.equal(state.get('users',2).ogrines,before+3300);assert.equal((await api('GET','/api/products/ogrine')).find(p=>p.id===1001).promo.remaining,0);
  await api('POST',paymentUrl,{confirm:'local-test'},null);assert.equal(state.get('users',2).ogrines,before+3300);
  const stats=await api('GET',`/api/admin/ogrine-promos/${promo.id}/stats`,{},1);assert.equal(stats.total_purchases,2);assert.equal(stats.unique_users,1);assert.equal(stats.completed_users,1);assert.equal(stats.completion_rate,100);assert.equal(stats.timeline[0].count,2);
  assert.equal((await api('GET','/api/products/ogrine',{},1)).find(p=>p.id===1001).promo.remaining,2);
  await api('PUT',`/api/admin/ogrine-promos/${promo.id}`,{ogrine_id:1001,percent:15,max_per_user:2,starts_at:'2020-01-01',ends_at:'2099-01-01',active:false},1);assert.equal((await api('GET','/api/pages/ogrine-promos/active')).active,false);
});

test('market listing validates ownership and charges a canonical listing fee',async t=>{
  const {api,state}=setup(t),before=state.get('users',2).ogrines;
  await rejectsStatus(()=>api('POST','/api/market/sell',{player_id:1,server_id:5,price:5000}),403);
  await rejectsStatus(()=>api('POST','/api/market/sell',{player_id:4,server_id:5,price:1}),422);
  const result=await api('POST','/api/market/sell',{player_id:4,server_id:5,price:5000});assert(result.success);assert.equal(state.get('users',2).ogrines,before-250);
  await rejectsStatus(()=>api('POST','/api/market/sell',{player_id:4,server_id:5,price:5000}),409);
  const rows=await api('GET','/api/products/market/5?mine=1&name=Dalia&page=1&per_page=1');assert.equal(rows.players[0].id,4);assert.equal(rows.pagination.total,1);
});

test('market purchase persists a pending transfer and transfers ownership only to recipient account',async t=>{
  const {api,state}=setup(t),buyer=state.get('users',2).ogrines,seller=state.get('users',1).ogrines;
  const result=await api('POST','/api/market/buy',{player_id:3,server_id:5,account_id:2,price:0});assert(result.success);
  assert.equal(state.get('users',2).ogrines,buyer-5000);assert.equal(state.get('users',1).ogrines,seller+5000);assert.equal(state.get('players',3).user_id,1);
  assert.equal((await api('GET','/api/market/pending-transfers')).players[0].id,3);
  await rejectsStatus(()=>api('POST','/api/market/transfert/5/3',{account_id:1}),403);
  await api('POST','/api/market/transfert/5/3',{account_id:2});assert.equal(state.get('players',3).user_id,2);assert.equal(state.get('players',3).account_id,2);assert.equal(state.get('players',3).current_transfert,null);
  await rejectsStatus(()=>api('POST','/api/market/buy',{player_id:3,server_id:5,account_id:2}),409);
});

test('cancelling a pending market purchase refunds once and restores seller ownership',async t=>{
  const {api,state}=setup(t),before=state.get('users',2).ogrines;
  await api('POST','/api/market/buy',{player_id:3,server_id:5,account_id:2});
  await api('POST','/api/market/cancel/5/3');assert.equal(state.get('users',2).ogrines,before);assert.equal(state.get('players',3).current_transfert,null);assert.equal(state.get('players',3).user_id,1);
  await rejectsStatus(()=>api('POST','/api/market/cancel/5/3'),403);assert.equal(state.get('users',2).ogrines,before);
});

test('cross-user service transfer uses a player code and remains a local pending transfer',async t=>{
  const {api,state}=setup(t),code=state.get('users',1).player_code;
  await api('POST','/api/service/checkout',{service_id:21,player_id:4,server_id:5,user_to_code:code,quantity:1});
  assert.equal(state.get('players',4).current_transfert.new_user_id,1);assert.equal(state.get('players',4).user_id,2);
  await api('POST','/api/market/transfert/5/4',{account_id:1},1);assert.equal(state.get('players',4).user_id,1);
});

test('web bank transfer conserves wallet plus player kamas and checks ownership',async t=>{
  const {api,state,events}=setup(t),u=state.get('users',2).kamas,p=state.get('players',4).kamas;
  const send=await api('POST','/api/pages/bak/web-bank',{server_id:5,player_id:4,amount:500,type:'+'});assert.equal(state.get('users',2).kamas,u-500);assert.equal(state.get('players',4).kamas,p+500);assert.equal(send.balance.kamas[5],u-500);
  await api('POST','/api/pages/bak/web-bank',{server_id:5,player_id:4,amount:250,type:'-'});assert.equal(state.get('users',2).kamas+state.get('players',4).kamas,u+p);
  await rejectsStatus(()=>api('POST','/api/pages/bak/web-bank',{server_id:5,player_id:1,amount:100,type:'+'}),403);
  await rejectsStatus(()=>api('POST','/api/pages/bak/web-bank',{server_id:5,player_id:4,amount:-1,type:'+'}),422);
  assert(events.some(e=>e[1]==='KamasCommit'&&typeof e[2][0]==='object'&&e[2][0][5]===u-250));
});

test('BAK exposes source-consumed avg/today rates and server-indexed wallet shape',async t=>{
  const {api}=setup(t),data=await api('GET','/api/pages/bak/offers/5');assert.equal(data.rates.today,100);assert.equal(data.rates.avg,100);assert.equal(data.chart.length,2);
  const result=await api('POST','/api/pages/bak/web-bank',{server_id:5,player_id:4,amount:100,type:'+'});assert.equal(typeof result.balance.kamas[5],'number');
});

test('BAK creation escrows assets and partial fill conserves currencies apart from declared fee',async t=>{
  const {api,state}=setup(t),u2=state.get('users',2),u1=state.get('users',1);
  const created=await api('POST','/api/pages/bak/offers',{server_id:5,type:'ogrines',quantity:100,rate:100});assert.equal(state.get('users',2).ogrines,u2.ogrines-105);
  await api('POST','/api/pages/bak/offer',{id:created.offer.id,quantity:20,rate:100,owner:true},1);
  assert.equal(state.get('users',1).kamas,u1.kamas-2000);assert.equal(state.get('users',2).kamas,u2.kamas+2000);assert.equal(state.get('users',1).ogrines,u1.ogrines+20);assert.equal(state.get('commerceBakOffers',created.offer.id).quantity,80);
  await api('POST','/api/pages/bak/offer',{id:created.offer.id,quantity:0,rate:100});assert.equal(state.get('users',2).ogrines,u2.ogrines-25);
});

test('BAK insufficient balance and stale price cannot consume escrow',async t=>{
  const {api,state}=setup(t),offer=state.get('commerceBakOffers',1),before=state.get('users',2);
  await rejectsStatus(()=>api('POST','/api/pages/bak/offer',{id:offer.id,quantity:20,rate:101,owner:true}),409);assert.deepEqual(state.get('users',2),before);assert.deepEqual(state.get('commerceBakOffers',1),offer);
  state.patch('users',2,{kamas:0});await rejectsStatus(()=>api('POST','/api/pages/bak/offer',{id:offer.id,quantity:20,rate:100}),409);assert.deepEqual(state.get('commerceBakOffers',1),offer);
});

test('commerce seed is idempotent and does not reset a changed wallet',t=>{
  const {state}=setup(t),before=state.list('inventory').length;state.patch('users',2,{ogrines:123});seed(state);assert.equal(state.get('users',2).ogrines,123);assert.equal(state.list('inventory').length,before);
});

test('SQLite persistence survives reopening after a purchase',async t=>{
  const directory=path.dirname(fileURLToPath(import.meta.url)),filename=path.join(directory,'commerce-test-'+randomBytes(8).toString('hex')+'.sqlite');
  assert(filename.startsWith(directory+path.sep+'commerce-test-'));
  const state=new State(filename);seedCore(state);state.put('items',{id:39,name:{fr:'Objet local'}});seed(state);const router=new Router();register(router);
  const api=async(method,url,body={})=>{
    const parsed=new URL(url,'http://127.0.0.1:14555');return (await router.dispatch(method,parsed.pathname,{body,query:Object.fromEntries(parsed.searchParams),user:state.get('users',2),state,services:{origin:parsed.origin,emit(){}}})).body;
  };
  const initial=state.get('users',2).ogrines,order=await api('POST','/api/order',{gateway:'ogrines',products:[{id:2001,quantity:1}]});await api('POST',`/api/order/${order.id}/pay/ogrines`);state.close();
  const reopened=new State(filename);try{assert.equal(reopened.get('orders',order.id).status,'paid');assert.equal(reopened.get('users',2).ogrines,initial-100);}finally{reopened.close();for(const suffix of ['','-wal','-shm']){const own=filename+suffix;assert(own.startsWith(directory+path.sep+'commerce-test-'));if(fs.existsSync(own))fs.unlinkSync(own);}}
});
