/** Local test economy for the recovered launcher. No remote payment/game API. */
import { randomBytes } from 'node:crypto';
import {runOutbox,reservedBalance} from './commerce-outbox.mjs';

const DAY = 86400000;
const AUTH = {auth: true};
const MIN_PRICES = {1: 100, 50: 500, 100: 1000, 150: 2000, 200: 3000};
const CURRENCIES = new Set(['ogrines', 'ogrines_linked', 'arcanes', 'jetons', 'kamas']);
const now = () => new Date().toISOString();
const copy = value => structuredClone(value);
const num = value => Number(value ?? 0);
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const values = value => Array.isArray(value) ? value : value == null || value === '' ? [] : String(value).split(',');
const ids = value => values(value).map(value => num(value?.id ?? value));

function bad(c, message, status = 422) { c.fail(status, message); throw new Error(message); }
function integer(c, value, name, min = 1, max = 1000000000) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) bad(c, `${name} invalide`);
  return result;
}
function user(c) { c.requireUser(); return c.state.get('users', c.user.id) ?? bad(c, 'Utilisateur introuvable', 401); }
function owned(c, bucket, id, ownerId = user(c).id) {
  const record = c.state.get(bucket, Number(id));
  if (!record) bad(c, `${bucket}: élément introuvable`, 404);
  if (Number(record.user_id) !== Number(ownerId)) bad(c, 'Cet élément ne vous appartient pas', 403);
  return record;
}
function wallet(u) { return {...Object.fromEntries([...CURRENCIES].map(key => [key, num(u[key])])),kamas:{5:num(u.kamas)}}; }
function money(c, owner, currency, delta, reservationId = null) {
  if (!CURRENCIES.has(currency) || !Number.isSafeInteger(delta)) bad(c, 'Devise ou montant invalide');
  const current = c.state.get('users', owner);
  const next = num(current?.[currency]) + delta;
  if (!current || !Number.isSafeInteger(next) || next < 0 || delta < 0 && next < reservedBalance(c.state,owner,currency,reservationId)) bad(c, `Solde ${currency} insuffisant ou réservé`, 409);
  return c.state.patch('users', owner, {[currency]: next});
}
function log(c, userId, kind, details) {
  return c.state.put('commerceLogs', {user_id: userId, kind, created_at: now(), local_test: true, ...details});
}
function notify(c, event = 'InventoryUpdated', ownerId = c.user?.id) {
  const current = c.state.get('users', ownerId);
  if (!current) return;
  c.services?.emit?.(ownerId, event, {local_test: true, balance: wallet(current)});
  for (const [field, name] of [['ogrines','OgrinesCommit'],['kamas','KamasCommit'],['arcanes','ArcanesCommit'],['jetons','JetonsCommit']]) {
    c.services?.emit?.(ownerId, name, field === 'ogrines' ? [num(current.ogrines),num(current.ogrines_linked)] : field==='kamas' ? [{5:num(current.kamas)}] : [num(current[field])]);
  }
}
function product(c, id) {
  const p = c.state.get('products', Number(id));
  if (!p || p.active === false) bad(c, 'Produit local introuvable', 404);
  if(c.services?.emulator&&p.type==='service'&&num(p.service?.service_action_id)===2)bad(c,'Ce service ne définit aucun effet réel ni cible de nom/classe/couleur',409);
  return p;
}
const availableProduct=(c,p)=>p.active!==false&&(!c.services?.emulator||p.type!=='service'||num(p.service?.service_action_id)!==2);
function campaign(c, productId, ownerId = c.user?.id) {
  const candidates=c.state.list('commerceOgrinePromos').filter(p=>p.active&&p.ogrine_id===Number(productId)&&Date.parse(p.starts_at)<=Date.now()&&Date.parse(p.ends_at)>Date.now());
  const p=candidates.sort((a,b)=>b.percent-a.percent)[0];
  if(!p)return null;
  const used=c.state.list('commercePromoPurchases').filter(x=>x.promo_id===p.id&&x.user_id===ownerId).reduce((sum,x)=>sum+x.quantity,0);
  return {...p,remaining:Math.max(0,p.max_per_user-used)};
}
function publicProduct(c,p) {
  if(p.type==='service'&&num(p.service?.service_action_id)===3)p={...p,image:'/assets/template/images/services/6.png',service:{...p.service,computed_img:'6.png',image:'/assets/template/images/services/6.png'}};
  if(c.services?.emulator&&p.type==='service'){
    const description=num(p.service?.service_action_id)===3?'Test local : transfert réel entre les comptes du clone. Le personnage doit être hors ligne.':'Test local : abonnement appliqué au compte du clone privé.';
    p={...p,service:{...p.service,translation:(p.service.translation||[]).map(t=>({...t,desc:description,description}))}};
  }
  const promo=campaign(c,p.id);
  return promo?{...p,promo:{id:promo.id,percent:promo.percent,remaining:promo.remaining,max_per_user:promo.max_per_user,starts_at:promo.starts_at,ends_at:promo.ends_at}}:p;
}
function translation(title, description = 'Démonstration locale : aucun effet sur un serveur de jeu réel.') {
  return ['fr', 'en', 'es', 'pt', 'de', 'it', 'nl'].map(lang => ({lang, title, desc: description, description}));
}
function itemView(c, entry) {
  const p = entry.product_id ? c.state.get('products', entry.product_id) : null;
  const type = entry.type ?? p?.type ?? 'item';
  const row = {...entry, type, local_test: true};
  if (type === 'item') row.item = row.item ?? row.item_template ?? p?.item ?? c.state.get('items', row.item_id) ?? {id: row.item_id, name: {fr: `Objet local ${row.item_id}`}, description: {fr: 'Objet de test'}};
  else row[type] = row[type] ?? p?.[type];
  if(type==='service'&&num(row.service?.service_action_id)===3)row.service={...row.service,computed_img:'6.png',image:'/assets/template/images/services/6.png'};
  return row;
}
function grant(c, ownerId, p, quantity, source = 'local-shop') {
  if (p.type === 'ogrine') {
    const bonus = p.local_bonus_percent ?? 0;
    const amount = integer(c,Math.floor(num(p.ogrine?.quantity) * quantity * (100 + bonus) / 100),'Crédits du pack',1,1000000000);
    money(c, ownerId, 'ogrines', amount);
    log(c, ownerId, 'ogrine', {product_id: p.id, quantity: amount, montant_ttc: num(p.prices?.euros?.value) * quantity, source});
    return null;
  }
  if (p.type === 'entitlement') {
    const key = p.grant?.kind === 'vip' ? 'vip_until' : 'battlepass_premium_until';
    const u = c.state.get('users', ownerId);
    const end = Math.max(Date.now(), Date.parse(u[key] ?? '') || 0) + num(p.grant?.days ?? 30) * quantity * DAY;
    c.state.patch('users', ownerId, {[key]: new Date(end).toISOString()});
    log(c, ownerId, 'service', {service: {one_translation: {title: p.name}}, product_id: p.id, source});
    return null;
  }
  return c.state.put('inventory', {user_id: ownerId, product_id: p.id, type: p.type, item_id: p.item?.id, [p.type]: copy(p[p.type]), quantity, source, state: 'pending', claimed: false, local_test: true, created_at: now()});
}
function codeOf(id) {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let n = Number(id), result = '';
  do { result = alphabet[n % alphabet.length] + result; n = Math.floor(n / alphabet.length); } while (n);
  return 'ABK-' + result.padStart(6, '2').slice(-6);
}
function normalizeCode(value) {
  let text = String(value ?? '').toUpperCase().replace(/[\s-]+/g, '');
  if (text.startsWith('ABK')) text = text.slice(3);
  return /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/.test(text) ? 'ABK-' + text : null;
}
function recipient(c, value) {
  const code = normalizeCode(value);
  const found = code && c.state.list('users').find(u => (u.player_code ?? codeOf(u.id)) === code);
  if (!found) bad(c, 'Code joueur introuvable', 404);
  return found;
}
function price(c, p, gateway, quantity = 1) {
  const currency = gateway === 'crypto' || gateway === 'tebex' || gateway === 'test' ? 'euros' : gateway === 'arcane' ? 'arcanes' : gateway;
  const entry = p.prices?.[currency] ?? (currency === 'arcanes' ? p.prices?.arcane : undefined);
  if (!entry || !Number.isFinite(num(entry.promo ?? entry.value))) bad(c, 'Moyen de paiement indisponible pour ce produit');
  const total = num(entry.promo ?? entry.value) * quantity;
  if(total<0||!Number.isSafeInteger(Math.round(total*100))||total>1000000000)bad(c,'Prix du produit invalide');
  return {currency, total: Math.round(total * 100) / 100};
}
function orderLines(c, input, gateway) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 100) bad(c, 'Panier vide ou trop volumineux');
  const seen = new Set();
  return input.map(line => {
    const p = product(c, line.id), quantity = integer(c, line.quantity, 'Quantité', 1, 99);
    if (seen.has(p.id)) bad(c, 'Produit dupliqué dans le panier');
    seen.add(p.id);
    if (line.type != null && line.type !== p.type) bad(c, 'Type de produit incorrect');
    if (!p.gateways?.includes(gateway) && !(['euros', 'tebex', 'test'].includes(gateway) && p.gateways?.includes('crypto'))) bad(c, 'Moyen de paiement incompatible');
    const cost = price(c, p, gateway, quantity);
    return {id: p.id, quantity, type: p.type, currency: cost.currency, total: cost.total};
  });
}
function makeOrder(c, input, gateway) {
  const u = user(c), lines = orderLines(c, input, gateway);
  if (new Set(lines.map(line => line.currency)).size !== 1) bad(c, 'Devises incompatibles');
  const promo = c.body?.promo_code ?? c.query?.promo_code ?? u.promo_code;
  return c.state.put('orders', {user_id: u.id, products: lines, gateway, currency: lines[0].currency, total: Math.round(lines.reduce((sum, line) => sum + line.total, 0) * 100) / 100, status: 'pending', promo_code: promo ?? null, local_test: true, created_at: now()});
}
function fulfil(c, orderId, simulatedPayment = false) {
  const order = c.state.get('orders', orderId);
  if (!order) bad(c, 'Commande introuvable', 404);
  if (order.status === 'paid') return order;
  if (order.status !== 'pending') bad(c, 'Commande non payable', 409);
  if (order.currency === 'euros' && !simulatedPayment) bad(c, 'Confirmez explicitement le paiement de TEST local', 409);
  if (order.currency !== 'euros') money(c, order.user_id, order.currency, -integer(c, order.total, 'Total', 0));
  const promo = c.state.list('commercePromos').find(p => p.code === String(order.promo_code ?? '').toUpperCase() && p.active);
  for (const line of order.products) {
    const p = product(c, line.id);
    const scheduled=p.type==='ogrine'?campaign(c,p.id,order.user_id):null,eligible=scheduled?Math.min(line.quantity,scheduled.remaining):0;
    if(eligible){
      grant(c,order.user_id,{...p,local_bonus_percent:(promo?.buyer_percent??0)+scheduled.percent},eligible,'local-order-'+order.id);
      c.state.put('commercePromoPurchases',{promo_id:scheduled.id,user_id:order.user_id,order_id:order.id,product_id:p.id,quantity:eligible,created_at:now(),local_test:true});
    }
    if(line.quantity>eligible)grant(c,order.user_id,{...p,local_bonus_percent:promo?.buyer_percent??0},line.quantity-eligible,'local-order-'+order.id);
  }
  const saved = c.state.patch('orders', order.id, {status: 'paid', paid_at: now(), simulated_payment: simulatedPayment});
  log(c, order.user_id, 'order', {order_id: order.id, currency: order.currency, amount: order.total});
  return saved;
}
function payment(c, order) {
  const existing = c.state.list('commercePayments').find(p => p.order_id === order.id);
  if (existing) return existing;
  return c.state.put('commercePayments', {user_id: order.user_id, order_id: order.id, token: randomBytes(24).toString('hex'), invoice_id: 'LOCAL-' + randomBytes(16).toString('hex'), status: 'pending', local_test: true, expires_at: new Date(Date.now() + 3600000).toISOString(), created_at: now()});
}
const checkoutUrl = (c, p) => c.url('/local/payments/' + p.id + '?token=' + encodeURIComponent(p.token));
function requirePayment(c, id = c.params.id) {
  const p = c.state.get('commercePayments', Number(id));
  if (!p || !c.query?.token || p.token !== c.query.token) bad(c, 'Lien de paiement local invalide', 404);
  return p;
}
function paymentPage(c, p, completed = false) {
  const order = c.state.get('orders', p.order_id), origin = new URL(c.url('/')).origin;
  const done = completed || p.status === 'confirmed';
  const script = done ? '<script>if(parent!==window)parent.postMessage({event:"invoice_confirmed",status:"confirmed",local_test:true},' + JSON.stringify(origin) + ')</script>' : '';
  return c.html('<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Paiement de TEST local</title><style>body{font:18px system-ui;background:#111827;color:#e5e7eb;max-width:700px;margin:60px auto;padding:24px}strong{color:#fbbf24}button{padding:16px;background:#2563eb;color:white;border:0;border-radius:8px;cursor:pointer}</style><h1>Paiement de TEST LOCAL</h1><p><strong>Aucune carte, aucune cryptomonnaie, aucun débit réel.</strong></p><p>Commande locale n°' + order.id + ' — montant indicatif ' + esc(order.total) + ' ' + esc(order.currency) + '.</p>' + (done ? '<h2>Simulation confirmée</h2><p>Les crédits/objets ont été ajoutés uniquement à la base locale. Vous pouvez fermer cette page.</p>' : '<form method="post" action="' + esc(checkoutUrl(c, p)) + '"><input type="hidden" name="confirm" value="local-test"><button>Confirmer explicitement la simulation locale</button></form>') + script + '</html>');
}
function accountIds(c, body) {
  const selected = [...new Set(ids(body.accounts))];
  if (!selected.length) bad(c, 'Sélectionnez au moins un compte');
  for (const id of selected) owned(c, 'gameAccounts', id);
  return selected;
}
function subscribe(c, accountIds, days, autoRenew = false) {
  for (const id of accountIds) {
    const a = owned(c, 'gameAccounts', id);
    const end = Math.max(Date.now(), ...['subscription_until','subscription_end','subscribed_until','subscription','bPack'].map(key=>Date.parse(a[key]??'')||0)) + days * DAY;
    const expiry = new Date(end).toISOString();
    c.state.patch('gameAccounts', id, {subscription_until:expiry,subscription_end:expiry,subscription:expiry,subscribed_until:expiry,bPack:expiry,auto_renew:!!autoRenew,local_test:true});
  }
}
function applyService(c, p, body, inventoryEntry = null) {
  const action = Number(p.service?.service_action_id), u = user(c);
  if (body.user_to_code && action === 3) {
    const to = recipient(c, body.user_to_code), player = owned(c, 'players', body.player_id);
    if (to.id === u.id || player.current_transfert || player.isInSell) bad(c, 'Destinataire ou état du personnage invalide');
    const listing = c.state.put('commerceMarketListings', {user_id:u.id,player_id:player.id,server_id:num(player.server_id??player.serverId),price:0,status:'pending-transfer',buyer_id:to.id,paid:0,created_at:now(),local_test:true});
    c.state.patch('players',player.id,{current_transfert:{new_user_id:to.id,old_user_id:u.id,account_id:null,listing_id:listing.id,amount:0,state:'pending',created_at:now(),local_test:true}});
  } else if (body.user_to_code) {
    const to = recipient(c, body.user_to_code);
    if (to.id === u.id) bad(c, 'Le destinataire doit être un autre utilisateur');
    grant(c, to.id, p, integer(c, body.quantity ?? 1, 'Quantité', 1, 99), 'local-gift');
  } else if ([1, 5].includes(action)) {
    const accounts = accountIds(c, body), max = p.service?.service_card?.max_accounts ?? 8;
    if (accounts.length > max) bad(c, 'Trop de comptes sélectionnés');
    subscribe(c, accounts, p.service?.days ?? 7, body.auto_renew);
  } else if (action === 2) {
    const player = owned(c, 'players', body.player_id);
    if (body.server_id != null && num(player.server_id ?? player.serverId) !== num(body.server_id)) bad(c, 'Serveur incorrect');
    c.state.patch('players', player.id, {local_service_effects: [...(player.local_service_effects ?? []), {service_id: p.id, applied_at: now(), mode: 'local-test'}]});
  } else if (action === 3) {
    const player = owned(c, 'players', body.player_id), account = owned(c, 'gameAccounts', body.account_to_id ?? body.account_id);
    c.state.patch('players', player.id, {account_id: account.id, local_transfer_at: now()});
  } else bad(c, 'Action de service locale non prise en charge');
  log(c, u.id, 'service', {product_id: p.id, service: {...p.service, one_translation: {title: p.service?.translation?.[0]?.title ?? p.name}}, price: p.prices?.ogrines?.value ?? 0, inventory_id: inventoryEntry?.id});
}
function nativeAccount(c,id,ownerId=user(c).id){
  const account=owned(c,'gameAccounts',id,ownerId);
  if(!account.emulator_account_id)bad(c,'Compte non relié au serveur de jeu réel',409);
  return {webUserId:ownerId,accountId:integer(c,account.emulator_account_id,'Compte de jeu réel'),localAccountId:account.id};
}
function nativePlayer(c,accountId,playerId){
  if(accountId)nativeAccount(c,accountId);
  const local=playerId?owned(c,'players',playerId):c.state.list('players').filter(p=>p.user_id===user(c).id&&p.account_id===num(accountId)&&p.emulator_player_id).sort((a,b)=>a.id-b.id)[0];
  if(!local||accountId&&local.account_id!==num(accountId))bad(c,'Choisissez un personnage réel de ce compte',409);
  if(!local.emulator_player_id)bad(c,'Personnage non relié au serveur réel',409);
  return {...nativeAccount(c,local.account_id),playerId:integer(c,local.emulator_player_id,'Personnage réel'),localPlayerId:local.id,name:local.emulator_name??local.name};
}
async function realSubscription(c,{accounts,days,currency=null,cost=0,entry=null,quantity=0,product:p=null,autoRenew=false}){
  const targets=accounts.map(id=>nativeAccount(c,id)),emulator=c.services.emulator;
  if(!emulator.extendSubscriptions&&targets.length!==1)bad(c,'Abonnement groupé réel indisponible',503);
  const payload={webUserId:user(c).id,accountIds:targets.map(t=>t.accountId).sort((a,b)=>a-b),days};
  const requestPath=entry?'/api/inventory':currency==='arcanes'?'/api/shop/gemmes/abonnement':'/api/service/checkout';
  const result=await runOutbox(c,{kind:'subscription',payload,currency,cost,inventoryId:entry?.id,quantity,requestPath,
    execute:operationId=>emulator.extendSubscriptions?emulator.extendSubscriptions({...payload,operationId}):emulator.extendSubscription({...targets[0],days,operationId}),
    apply:(ack,operationId)=>{
      if(currency)money(c,user(c).id,currency,-cost,operationId);
      for(const target of targets){const end=ack.subscriptionEnds?.[target.accountId]??ack.subscriptionEndMs;if(!Number.isFinite(end))bad(c,'Échéance réelle non confirmée',503);const expiry=new Date(end).toISOString();c.state.patch('gameAccounts',target.localAccountId,{subscription_until:expiry,subscription_end:expiry,subscription:expiry,subscribed_until:expiry,bPack:expiry,auto_renew:!!autoRenew,real_emulator:true})}
      let item;if(entry){const fresh=owned(c,'inventory',entry.id);if(fresh.quantity<quantity)bad(c,'Quantité réservée incohérente après confirmation',409);item=itemView(c,c.state.patch('inventory',entry.id,{quantity:fresh.quantity-quantity,claimed:fresh.quantity===quantity,state:fresh.quantity===quantity?'claimed':'pending'}))}
      log(c,user(c).id,'service',{product_id:p?.id,service:p?{...p.service,one_translation:{title:p.service?.translation?.[0]?.title??p.name}}:{one_translation:{title:`Abonnement réel ${days} jours`}},price:cost,operation_id:operationId,emulator_ack:ack,real_emulator:true});
      return {success:true,balance:currency==='arcanes'?num(user(c).arcanes):wallet(user(c)),...(item?{item}:{}),operation_id:operationId,emulator_ack:ack,real_emulator:true,local_test:true,message:'Abonnement persisté dans le serveur de jeu isolé.'};
    }});result.balance=currency==='arcanes'?num(user(c).arcanes):wallet(user(c));if(result.item)result.item=itemView(c,owned(c,'inventory',entry.id));notify(c);return result;
}
async function realInventory(c){
  const entry=owned(c,'inventory',c.body.id),quantity=integer(c,c.body.quantity??1,'Quantité',1,1000000);
  if(entry.type==='service'){
    const p=product(c,entry.product_id);if(num(p.service?.service_action_id)===3)return realServiceTransfer(c,p,{entry,quantity});if(![1,5].includes(num(p.service?.service_action_id))||c.body.user_to_code)bad(c,'Ce service nécessite encore son raccord réel avant récupération',409);
    const accounts=accountIds(c,c.body);if(accounts.length>(p.service?.service_card?.max_accounts??8))bad(c,'Trop de comptes sélectionnés');
    return realSubscription(c,{accounts,days:p.service?.days??7,entry,quantity,product:p,autoRenew:c.body.auto_renew});
  }
  if(entry.type!=='item')bad(c,'Récupération réelle de ce type indisponible',409);
  const target=nativePlayer(c,c.body.account?.id??c.body.account??c.body.account_id,c.body.player_id),view=itemView(c,entry);
  const payload={webUserId:user(c).id,accountId:target.accountId,playerId:target.playerId,itemId:integer(c,view.item?.id,'Objet réel'),quantity};
  const result=await runOutbox(c,{kind:'inventory',payload,inventoryId:entry.id,quantity,requestPath:'/api/inventory',
    execute:operationId=>c.services.emulator.deliverItem({...payload,operationId}),
    apply:(ack,operationId)=>{
      const fresh=owned(c,'inventory',entry.id);if(fresh.quantity<quantity)bad(c,'Réservation inventaire incohérente après livraison',409);
      c.state.put('commerceDeliveries',{user_id:user(c).id,account_id:target.localAccountId,player_id:target.localPlayerId,item_id:view.item.id,quantity,mode:'isolated-game-bridge',operation_id:operationId,emulator_ack:ack,created_at:now()});
      const item=itemView(c,c.state.patch('inventory',entry.id,{quantity:fresh.quantity-quantity,claimed:fresh.quantity===quantity,state:fresh.quantity===quantity?'claimed':'pending'}));
      log(c,user(c).id,'item',{item:view.item,quantity,price:0,operation_id:operationId,emulator_ack:ack,real_emulator:true});
      return {success:true,item,operation_id:operationId,emulator_ack:ack,real_emulator:true,local_test:true,message:`Objet livré au personnage réel ${target.name}.`};
    }});result.item=itemView(c,owned(c,'inventory',entry.id));notify(c);return result;
}
async function realBank(c){
  const p=owned(c,'players',c.body.player_id),amount=integer(c,c.body.amount,'Montant');
  if(num(p.server_id??p.serverId)!==num(c.body.server_id))bad(c,'Serveur incorrect');
  if(!['+','-'].includes(c.body.type))bad(c,'Sens du transfert invalide');
  const target=nativePlayer(c,p.account_id,p.id),send=c.body.type==='+';
  const payload={webUserId:user(c).id,accountId:target.accountId,playerId:target.playerId,delta:send?amount:-amount};
  const result=await runOutbox(c,{kind:'bank',payload,currency:send?'kamas':null,cost:send?amount:0,requestPath:'/api/pages/bak/web-bank',
    execute:operationId=>c.services.emulator.changeKamas({...payload,operationId}),
    apply:(ack,operationId)=>{
      if(!Number.isSafeInteger(ack.kamas)||ack.kamas<0)bad(c,'Solde réel non confirmé',503);
      money(c,user(c).id,'kamas',send?-amount:amount,operationId);c.state.patch('players',p.id,{kamas:ack.kamas,real_emulator:true});
      log(c,user(c).id,'bank',{player_id:p.id,amount,type:c.body.type,operation_id:operationId,emulator_ack:ack,real_emulator:true});
      return {success:true,balance:wallet(user(c)),operation_id:operationId,emulator_ack:ack,real_emulator:true,local_test:true,message:'Transfert confirmé par le serveur de jeu isolé.'};
    }});result.balance=wallet(user(c));notify(c);return result;
}
function completedTransferReplay(c,kind,requestPath){
  const key=c.body.operationId??c.req?.headers?.['idempotency-key'];if(typeof key!=='string')return null;
  const row=c.state.list('commerceOutbox').find(row=>row.user_id===user(c).id&&row.operation_id===`commerce:${user(c).id}:${kind}:${key}`&&row.state==='applied');if(!row)return null;
  const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([k,v])=>k!=='operationId'&&v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stable(v)])):value;
  if(row.request?.path!==requestPath||JSON.stringify(stable(row.request.body))!==JSON.stringify(stable(c.body)))bad(c,'Cette clé possède déjà une autre demande de transfert',409);
  const response=copy(row.response);response.balance=wallet(user(c));return response;
}
async function realServiceTransfer(c,p,{entry=null,quantity=1}={}){
  const replay=completedTransferReplay(c,'transfer',entry?'/api/inventory':'/api/service/checkout');if(replay)return replay;
  if(quantity!==1||integer(c,c.body.quantity??1,'Quantité',1,99)!==1)bad(c,'Un transfert concerne un seul personnage');
  const player=owned(c,'players',c.body.player_id);
  if(c.body.server_id!=null&&num(player.server_id??player.serverId)!==num(c.body.server_id))bad(c,'Serveur incorrect');
  if(player.current_transfert||player.isInSell)bad(c,'Ce personnage est déjà en vente ou en transfert',409);
  const source=nativePlayer(c,player.account_id,player.id),cost=entry?0:price(c,p,'ogrines').total;
  if(c.body.user_to_code){
    const to=recipient(c,c.body.user_to_code);if(to.id===user(c).id)bad(c,'Le destinataire doit être un autre utilisateur');
    const result=c.state.transaction(()=>{
      if(cost&&num(user(c).ogrines)-reservedBalance(c.state,user(c).id,'ogrines')<cost)bad(c,'Solde disponible insuffisant',409);
      if(entry&&entry.quantity<quantity)bad(c,'Service inventaire épuisé',409);
      const listing=c.state.put('commerceMarketListings',{user_id:user(c).id,player_id:player.id,server_id:num(player.server_id??player.serverId),price:0,status:'pending-transfer',buyer_id:to.id,paid:0,service_product_id:p.id,service_fee:cost,service_fee_paid:false,service_inventory_id:entry?.id??null,service_inventory_quantity:entry?quantity:0,created_at:now(),real_emulator:true});
      c.state.patch('players',player.id,{current_transfert:{new_user_id:to.id,old_user_id:user(c).id,old_account_id:player.account_id,old_emulator_account_id:source.accountId,account_id:null,listing_id:listing.id,amount:0,state:'pending',created_at:now(),real_emulator:true}});
      return {success:true,pending:true,current_transfert:c.state.get('players',player.id).current_transfert,...(entry?{item:itemView(c,entry)}:{}),balance:wallet(user(c)),real_emulator:false,local_test:true,message:'Transfert préparé. Le destinataire doit choisir son compte ; le service sera consommé après confirmation du jeu.'};
    });notify(c);notify(c,'InventoryUpdated',to.id);return result;
  }
  const destination=nativeAccount(c,c.body.account_to_id??c.body.account_id);
  if(source.accountId===destination.accountId)bad(c,'Choisissez un compte de destination différent');
  const payload={webUserId:user(c).id,accountId:source.accountId,playerId:source.playerId,destinationWebUserId:user(c).id,destinationAccountId:destination.accountId};
  const result=await runOutbox(c,{kind:'transfer',payload,currency:cost?'ogrines':null,cost,inventoryId:entry?.id,quantity:entry?quantity:0,requestPath:entry?'/api/inventory':'/api/service/checkout',
    execute:operationId=>c.services.emulator.transferPlayer({...payload,operationId}),
    apply:(ack,operationId)=>{
      if(ack.playerId!==source.playerId||ack.accountId!==destination.accountId)bad(c,'Destination réelle non confirmée',503);
      if(cost)money(c,user(c).id,'ogrines',-cost,operationId);
      c.state.patch('players',player.id,{account_id:destination.localAccountId,emulator_account_id:destination.accountId,real_emulator:true});
      let item;if(entry){const fresh=owned(c,'inventory',entry.id);if(fresh.quantity<quantity)bad(c,'Réservation service incohérente',409);item=itemView(c,c.state.patch('inventory',entry.id,{quantity:fresh.quantity-quantity,claimed:fresh.quantity===quantity,state:fresh.quantity===quantity?'claimed':'pending'}))}
      log(c,user(c).id,'service',{product_id:p.id,service:{...p.service,one_translation:{title:p.service?.translation?.[0]?.title??p.name}},price:cost,operation_id:operationId,emulator_ack:ack,real_emulator:true});
      return {success:true,...(item?{item}:{}),balance:wallet(user(c)),operation_id:operationId,emulator_ack:ack,real_emulator:true,local_test:true,message:'Personnage transféré dans le serveur de jeu isolé.'};
    }});notify(c);return result;
}
async function realMarketTransfer(c){
  const requestPath=`/api/market/transfert/${c.params.server}/${c.params.id}`,replay=completedTransferReplay(c,'market-transfer',requestPath);if(replay)return replay;
  const p=c.state.get('players',num(c.params.id)),u=user(c),t=p?.current_transfert;
  if(!t||t.new_user_id!==u.id||![t.old_user_id,t.new_user_id].includes(p.user_id))bad(c,'Transfert non autorisé',403);
  if(num(p.server_id??p.serverId)!==num(c.params.server))bad(c,'Serveur incorrect');
  if(t.service_id)bad(c,'Service complémentaire sans définition de cible réelle',409);
  const listing=c.state.get('commerceMarketListings',t.listing_id);if(!listing||listing.status!=='pending-transfer')bad(c,'Vente non disponible',409);
  const source=nativeAccount(c,t.old_account_id??p.account_id,t.old_user_id),destination=nativeAccount(c,c.body.account_id??t.account_id);
  if(!p.emulator_player_id)bad(c,'Personnage non relié au clone réel',409);
  const payload={webUserId:t.old_user_id,accountId:source.accountId,playerId:integer(c,p.emulator_player_id,'Personnage réel'),destinationWebUserId:u.id,destinationAccountId:destination.accountId,listingId:listing.id};
  const result=await runOutbox(c,{kind:'market-transfer',payload,requestPath,
    execute:async operationId=>{
      const ack=await c.services.emulator.transferPlayer({...payload,operationId});
      const delivered=[];for(let i=0;i<(t.panoply?.pieces??[]).length;i++){const piece=t.panoply.pieces[i];delivered.push(await c.services.emulator.deliverItem({webUserId:u.id,accountId:destination.accountId,playerId:payload.playerId,itemId:piece.id,quantity:piece.quantity??1,operationId:operationId+':item:'+i}))}
      return {...ack,operationId,panoplyReceipts:delivered};
    },
    apply:(ack,operationId)=>{
      if(ack.accountId!==destination.accountId||ack.playerId!==payload.playerId)bad(c,'Propriété réelle non confirmée',503);
      if(listing.service_fee&&!listing.service_fee_paid)money(c,t.old_user_id,'ogrines',-listing.service_fee,`listing:${listing.id}`);
      if(listing.service_inventory_id){const entry=owned(c,'inventory',listing.service_inventory_id,t.old_user_id),quantity=listing.service_inventory_quantity;if(entry.quantity<quantity)bad(c,'Service réservé incohérent',409);c.state.patch('inventory',entry.id,{quantity:entry.quantity-quantity,claimed:entry.quantity===quantity,state:entry.quantity===quantity?'claimed':'pending'})}
      c.state.patch('commerceMarketListings',listing.id,{status:'sold',completed_at:now(),service_fee_paid:true,emulator_ack:ack,real_emulator:true});
      const saved=c.state.patch('players',p.id,{user_id:u.id,account_id:destination.localAccountId,emulator_account_id:destination.accountId,current_transfert:null,isInSell:0,price:0,real_emulator:true});
      log(c,u.id,'market',{player_id:p.id,action:'real-transfer',operation_id:operationId,emulator_ack:ack,real_emulator:true});
      return {success:true,player:playerView(c,saved),balance:wallet(user(c)),operation_id:operationId,emulator_ack:ack,real_emulator:true,local_test:true,message:'Propriété du personnage confirmée par le jeu isolé.'};
    }});notify(c);notify(c,'WalletUpdated',t.old_user_id);return result;
}
function playerView(c, p, listing = null) {
  return {...p, serverId: num(p.server_id ?? p.serverId ?? 5), server_id: num(p.server_id ?? p.serverId ?? 5), lvl: p.level ?? p.lvl ?? 1, classe: p.class_id ?? p.classe ?? 1, alignement: p.alignement && typeof p.alignement==='object' ? p.alignement : {id:num(p.alignement),value:0}, jobs: Array.isArray(p.jobs) ? p.jobs : [], isInSell: listing?.status === 'active' ? 1 : p.isInSell ?? 0, price: listing?.price ?? p.price ?? 0, isInSell_date: listing?.created_at ?? p.isInSell_date, premium_until: listing?.premium_until ?? p.premium_until, full_parcho: p.full_parcho ?? false, local_test: true};
}
function activeListing(c, playerId, server) {
  return c.state.list('commerceMarketListings').find(l => l.player_id === num(playerId) && l.server_id === num(server) && l.status === 'active');
}
function panoplies(c, p) {
  const item = c.state.list('items')[0] ?? {id: 39, name: {fr: 'Équipement local'}};
  return [{item_id: item.id, name: 'Panoplie locale de démonstration', type: 'force', price: 100, pieces: [{...item, computed_img: item.computed_img ?? item.id + '.svg'}]}];
}

export function seed(state) {
  if (state.meta('commerce.seed.v1', false)) return;
  const item = state.list('items')[0] ?? {id: 39, name: {fr: 'Épée locale'}, description: {fr: 'Objet de test local'}, level: 1};
  const base = (id, type, name, cost) => ({id, type, name, active: true, gateways: ['ogrines'], prices: {ogrines: {value: cost}}, cat: 1, local_test: true});
  for (const p of [
    {...base(2001, 'item', 'Objet local — ' + (item.name?.fr ?? item.name ?? item.id), 100), item},
    {...base(2002, 'item', 'Lot local de ressources', 50), item: {...item, id: item.id, name: {fr: 'Ressource locale de démonstration'}}},
    ...[[16,7,8],[17,30,8],[18,7,1]].map(([id,days,max]) => ({...base(id,'service',`Abonnement local ${days} jours (${max} compte(s))`,days===30?800:200),service:{id,service_action_id:1,days,service_card:{max_accounts:max},translation:translation(`Abonnement local ${days} jours`)}})),
    {...base(20,'service','Service de personnage local',100),prices_99:{ogrines:{value:100}},service:{id:20,service_action_id:2,translation:translation('Service de personnage local')}},
    {...base(21,'service','Transfert entre comptes locaux',150),service:{id:21,service_action_id:3,translation:translation('Transfert local de personnage')}},
    ...[[1001,1000,5],[1002,2500,10],[1003,5000,18]].map(([id,quantity,cost])=>({...base(id,'ogrine','Pack TEST '+quantity+' ogrines',0),gateways:['crypto'],prices:{euros:{value:cost}},tebex_package_id:id,ogrine:{id,quantity,quantity_crypto:quantity,price:cost,others:true,crypto:true,items:[],translation:translation('Pack TEST '+quantity+' ogrines')}})),
    ...[[7001,'battlepass',5],[7002,'vip',7]].map(([id,kind,cost])=>({...base(id,'entitlement',kind==='vip'?'VIP local 30 jours':'BattlePass local 30 jours',0),gateways:['crypto'],prices:{euros:{value:cost}},tebex_package_id:id,grant:{kind,days:30}})),
  ]) if (!state.get('products',p.id)) state.put('products',p);
  state.put('commercePromos',{id:1,code:'LOCAL10',active:true,buyer_percent:10,owner_name:'Équipe locale',local_test:true});
  state.put('commerceGiftCodes',{id:1,code:'LOCAL-GIFT',active:true,used_by:[],products:[{id:2001,quantity:2},{id:16,quantity:1}],local_test:true});
  state.put('commerceOgrinePromos',{id:1,ogrine_id:1001,percent:5,max_per_user:5,starts_at:now(),ends_at:new Date(Date.now()+30*DAY).toISOString(),active:false,local_test:true});
  for(const u of state.list('users')) {
    if(!u.player_code) state.patch('users',u.id,{player_code:codeOf(u.id)});
    if(!state.list('inventory').some(x=>x.user_id===u.id&&x.source==='commerce-seed')) {
      const p=state.get('products',2001),s=state.get('products',16);
      state.put('inventory',{user_id:u.id,type:'item',product_id:p.id,item_id:p.item.id,item:p.item,quantity:3,source:'commerce-seed',local_test:true});
      state.put('inventory',{user_id:u.id,type:'service',product_id:s.id,service:s.service,quantity:1,source:'commerce-seed',local_test:true});
    }
  }
  for(const p of state.list('players'))if(p.kamas==null)state.patch('players',p.id,{kamas:100000});
  const seller=state.get('users',1),sample=state.get('players',3);
  if(seller&&sample&&sample.user_id===seller.id&&!sample.current_transfert) {
    state.put('commerceMarketListings',{id:1,user_id:1,player_id:sample.id,server_id:num(sample.server_id??sample.serverId??5),price:5000,fee:0,status:'active',created_at:now(),local_test:true,fixture:true});
    state.patch('players',sample.id,{isInSell:1,price:5000,isInSell_date:now()});
  }
  if(seller&&num(seller.ogrines)>=105) {
    state.patch('users',seller.id,{ogrines:num(seller.ogrines)-105});
    state.put('commerceBakOffers',{id:1,user_id:1,server_id:5,type:'ogrines',quantity:100,rate:100,price:10000,fee:5,status:'active',created_at:now(),local_test:true,fixture:true});
  }
  state.setMeta('commerce.seed.v1',true);
}

export function register(router) {
  const target=router;
  const write=verb=>(route,handler,options)=>target[verb](route,c=>{
    if(!c.body||typeof c.body!=='object'||Array.isArray(c.body))bad(c,'Objet JSON ou formulaire requis');
    return handler(c);
  },options);
  router={get:target.get.bind(target),post:write('post'),put:write('put'),delete:target.delete.bind(target)};
  router.get('/api/products/all',c=>{
    const products=c.state.list('products').filter(p=>availableProduct(c,p)).map(p=>publicProduct(c,p));
    const background='/bundled/img/blue-green-white-bg.9e3091b7.jpg';return [{name:'ogrines',background_image:background,products:products.filter(p=>p.type==='ogrine')},{name:'services',background_image:background,products:products.filter(p=>p.type==='service')},{name:'items',background_image:background,products:products.filter(p=>p.type==='item')},{name:'market',background_image:background,products:[]}];
  });
  router.get('/api/products/item',c=>c.state.list('products').filter(p=>p.type==='item'&&p.active!==false));
  router.get('/api/products/service',c=>c.state.list('products').filter(p=>p.type==='service'&&availableProduct(c,p)).map(p=>publicProduct(c,p)));
  router.get('/api/products/ogrine',c=>c.state.list('products').filter(p=>p.type==='ogrine'&&p.active!==false).map(p=>publicProduct(c,p)));
  router.get('/api/products/:type/:id',c=>publicProduct(c,product(c,c.params.id)));
  router.get('/api/pages/ogrine-promos/active',c=>({active:c.state.list('commerceOgrinePromos').some(p=>p.active&&Date.parse(p.starts_at)<=Date.now()&&Date.parse(p.ends_at)>Date.now()),local_test:true}));
  router.post('/api/promo/validate',c=>{
    const promo=c.state.list('commercePromos').find(p=>p.active&&p.code===String(c.body.code??'').toUpperCase());
    if(!promo)bad(c,'Code promotionnel local invalide',422);
    c.state.transaction(()=>c.state.patch('users',user(c).id,{promo_code:promo.code}));
    return {success:true,buyer_percent:promo.buyer_percent,owner_name:promo.owner_name,local_test:true};
  },AUTH);
  router.post('/api/promo/clear',c=>{c.state.transaction(()=>c.state.patch('users',user(c).id,{promo_code:null}));return {success:true,local_test:true}},AUTH);
  router.get('/api/player-code',c=>{const u=user(c);return {code:u.player_code??codeOf(u.id),local_test:true}},AUTH);
  router.get('/api/player-code/lookup',c=>{const u=recipient(c,c.query.code);return {code:u.player_code??codeOf(u.id),name:u.name,local_test:true}},AUTH);
  router.get('/api/inventory',c=>c.state.list('inventory').filter(i=>num(i.user_id)===user(c).id).map(i=>itemView(c,i)),AUTH);
  router.post('/api/inventory/code/:code',c=>{
    const result=c.state.transaction(()=>{
      const u=user(c),code=c.state.list('commerceGiftCodes').find(g=>g.active&&g.code===String(c.params.code).toUpperCase());
      if(!code)bad(c,'Code cadeau local introuvable',404);
      if(code.used_by.includes(u.id))bad(c,'Code cadeau déjà utilisé par ce compte',409);
      const data=code.products.map(line=>grant(c,u.id,product(c,line.id),line.quantity,'local-gift-code')).filter(Boolean);
      c.state.patch('commerceGiftCodes',code.id,{used_by:[...code.used_by,u.id]});return data;
    });notify(c);return {success:true,data:result,local_test:true};
  },AUTH);
  router.post('/api/inventory',async c=>{
    if(c.services?.emulator)return realInventory(c);
    const result=c.state.transaction(()=>{
      const u=user(c),entry=owned(c,'inventory',c.body.id),quantity=integer(c,c.body.quantity??1,'Quantité',1,1000000);
      if(quantity>entry.quantity)bad(c,'Quantité supérieure au solde inventaire',409);
      if(entry.type==='service')applyService(c,product(c,entry.product_id),c.body,entry);
      else if(entry.type==='ogrine')grant(c,u.id,product(c,entry.product_id),quantity,'local-inventory');
      else {
        const account=owned(c,'gameAccounts',c.body.account?.id??c.body.account??c.body.account_id);
        const view=itemView(c,entry);
        c.state.put('commerceDeliveries',{user_id:u.id,account_id:account.id,server_id:num(c.body.server_id??5),item_id:view.item?.id,quantity,mode:'local-test',created_at:now()});
        c.state.patch('gameAccounts',account.id,{local_inventory:[...(account.local_inventory??[]),{item_id:view.item?.id,quantity,source_inventory_id:entry.id}]});
        log(c,u.id,'item',{item:view.item,quantity,server_id:num(c.body.server_id??5),price:0});
      }
      const item=c.state.patch('inventory',entry.id,{quantity:entry.quantity-quantity,claimed:entry.quantity===quantity,state:entry.quantity===quantity?'claimed':'pending'});return itemView(c,item);
    });notify(c);return {success:true,item:result,local_test:true,message:'Récupération simulée dans la base locale uniquement.'};
  },AUTH);
  router.post('/api/order',c=>c.state.transaction(()=>makeOrder(c,c.body.products,c.body.gateway)),AUTH);
  router.post('/api/order/:id/pay/:gateway',c=>{
    const result=c.state.transaction(()=>{
      const order=owned(c,'orders',c.params.id);
      if(order.gateway!==c.params.gateway)bad(c,'Moyen de paiement différent de la commande');
      if(order.currency==='euros')return {url:checkoutUrl(c,payment(c,order)),external:true};
      const paid=fulfil(c,order.id);return {success:true,id:paid.id,order_id:paid.id,balance:wallet(user(c)),local_test:true};
    });if(result.external)return result.url;notify(c);return result;
  },AUTH);
  router.get('/api/order/:id',c=>owned(c,'orders',c.params.id),AUTH);
  router.get('/api/tebex/redirect/:id',c=>{
    const p=c.state.list('products').find(p=>num(p.tebex_package_id)===num(c.params.id));
    if(!p)bad(c,'Offre de paiement locale introuvable',404);
    const result=c.state.transaction(()=>payment(c,makeOrder(c,[{id:p.id,quantity:1,type:p.type}],'crypto')));
    return {url:checkoutUrl(c,result),local_test:true,message:'Simulation locale : aucun paiement réel.'};
  },AUTH);
  router.get('/api/btcpay/invoice/:id',c=>{
    const p=product(c,c.params.id);
    if(p.type!=='ogrine')bad(c,'Ce produit ne crée pas de facture de pack');
    const invoice=c.state.transaction(()=>payment(c,makeOrder(c,[{id:p.id,quantity:1,type:p.type}],'crypto')));
    return {success:true,invoice_id:invoice.invoice_id,status:invoice.status,expires_at:invoice.expires_at,checkoutUrl:checkoutUrl(c,invoice),local_test:true,message:'Facture de TEST local, sans blockchain.'};
  },AUTH);
  router.get('/local/payments/:id',c=>paymentPage(c,requirePayment(c)));
  router.post('/local/payments/:id',c=>{
    const p=requirePayment(c);
    if(c.body.confirm!=='local-test')bad(c,'Confirmation explicite du TEST local requise');
    const saved=c.state.transaction(()=>{
      const fresh=c.state.get('commercePayments',p.id);
      if(fresh.status==='confirmed')return fresh;
      if(Date.parse(fresh.expires_at)<Date.now())bad(c,'Simulation expirée',409);
      fulfil(c,fresh.order_id,true);return c.state.patch('commercePayments',p.id,{status:'confirmed',confirmed_at:now()});
    });notify(c,'PaymentConfirmed',saved.user_id);return paymentPage(c,saved,true);
  });
  router.get('/invoice',c=>{
    const p=c.state.list('commercePayments').find(p=>p.invoice_id===c.query.id);
    if(!p)bad(c,'Facture locale introuvable',404);
    return paymentPage(c,p);
  });
  router.get('/api/shop/speedrush-packs',c=>({packs:c.state.list('products').filter(p=>p.type==='ogrine'),local_test:true}));
  router.get('/api/shop/speedrush-pot',c=>({amount:c.state.meta('commerce.speedrushPot',0),local_test:true}));
  router.get('/api/shop/gemmes',c=>{
    const rows=c.state.list('products').filter(p=>p.type==='item').map(p=>({id:p.id,name:p.item?.name?.fr??p.name,price:10,original_price:15,computed_img:p.item?.computed_img??p.item?.id+'.svg',product_id:p.id}));
    return {sections:[{id:125,name:'Objets de TEST',products:rows}],subscriptions:[{key:'week',days:7,price:70,original_price:80,product_id:16,degressive:[],max_accounts:8},{key:'month',days:30,price:250,original_price:300,product_id:17,degressive:[],max_accounts:8}],balance:num(user(c).arcanes),local_test:true};
  },AUTH);
  router.post('/api/shop/gemmes',c=>{
    const result=c.state.transaction(()=>{
      if(!Array.isArray(c.body.items)||!c.body.items.length)bad(c,'Panier Arcanes vide');
      const lines=c.body.items.map(i=>({p:product(c,i.id),quantity:integer(c,i.quantity,'Quantité',1,99)}));
      if(lines.some(i=>i.p.type!=='item'))bad(c,'Produit Arcanes invalide');
      money(c,user(c).id,'arcanes',-lines.reduce((n,l)=>n+l.quantity*10,0));
      for(const line of lines)grant(c,user(c).id,line.p,line.quantity,'local-arcanes');
      return num(user(c).arcanes);
    });notify(c);return {success:true,balance:result,local_test:true};
  },AUTH);
  router.post('/api/shop/gemmes/abonnement',async c=>{
    if(c.services?.emulator){const accounts=accountIds(c,c.body),duration=String(c.body.duration),days=duration==='month'||duration==='30'?30:duration==='week'||duration==='7'?7:0;if(!days||accounts.length>8)bad(c,'Durée ou comptes invalides');return realSubscription(c,{accounts,days,currency:'arcanes',cost:(days===30?250:70)*accounts.length})}
    const balance=c.state.transaction(()=>{
      const accounts=accountIds(c,c.body),duration=String(c.body.duration),days=duration==='month'||duration==='30'?30:duration==='week'||duration==='7'?7:0;
      if(!days||accounts.length>8)bad(c,'Durée ou comptes invalides');
      money(c,user(c).id,'arcanes',-(days===30?250:70)*accounts.length);subscribe(c,accounts,days);return num(user(c).arcanes);
    });notify(c);return {success:true,balance,local_test:true};
  },AUTH);
  router.post('/api/service/checkout',async c=>{
    if(c.services?.emulator){const p=product(c,c.body.service_id);if(p.type==='service'&&num(p.service?.service_action_id)===3)return realServiceTransfer(c,p);if(p.type!=='service'||![1,5].includes(num(p.service?.service_action_id))||c.body.user_to_code)bad(c,'Ce service nécessite son raccord réel avant achat',409);const accounts=accountIds(c,c.body);if(accounts.length>(p.service?.service_card?.max_accounts??8))bad(c,'Trop de comptes sélectionnés');return realSubscription(c,{accounts,days:p.service?.days??7,currency:'ogrines',cost:price(c,p,'ogrines',accounts.length).total,product:p,autoRenew:c.body.auto_renew})}
    c.state.transaction(()=>{
      const p=product(c,c.body.service_id);
      if(p.type!=='service')bad(c,'Service invalide');
      const quantity=[1,5].includes(num(p.service.service_action_id))?Math.max(1,ids(c.body.accounts).length):integer(c,c.body.quantity??1,'Quantité',1,99);
      const cost=price(c,p,'ogrines',quantity);money(c,user(c).id,'ogrines',-cost.total);applyService(c,p,c.body);
    });notify(c);if(c.body.user_to_code)notify(c,'InventoryUpdated',recipient(c,c.body.user_to_code).id);return {success:true,balance:wallet(user(c)),local_test:true};
  },AUTH);
  router.post('/api/service/checkout/temporis',c=>{
    const entry=c.state.transaction(()=>{const p=product(c,c.body.service_id);if(p.type!=='service')bad(c,'Service invalide');money(c,user(c).id,'ogrines',-price(c,p,'ogrines').total);return grant(c,user(c).id,p,1,'local-temporis')});
    notify(c);return {success:true,item:entry,local_test:true};
  },AUTH);
  router.get('/api/pages/user/history',c=>{
    const logs=c.state.list('commerceLogs').filter(l=>l.user_id===user(c).id).reverse();
    return {IgHistory:logs.filter(l=>l.kind==='item'),OgrinesHistory:logs.filter(l=>l.kind==='ogrine'),ServicesHistory:logs.filter(l=>l.kind==='service'),local_test:true};
  },AUTH);
  registerMarket(router);
  registerBak(router);
  registerPromotions(router);
}

function registerPromotions(router) {
  const options={admin:true};
  const view=(c,p)=>({...p,ogrine:{id:p.ogrine_id,name:product(c,p.ogrine_id).name},purchases_count:c.state.list('commercePromoPurchases').filter(x=>x.promo_id===p.id).reduce((n,x)=>n+x.quantity,0)});
  const requirePromo=(c)=>c.state.get('commerceOgrinePromos',num(c.params.id))??bad(c,'Promotion introuvable',404);
  const validated=c=>{
    const p=product(c,c.body.ogrine_id);if(p.type!=='ogrine')bad(c,'Pack Ogrines requis');
    const start=Date.parse(c.body.starts_at),end=Date.parse(c.body.ends_at);
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)bad(c,'Période de promotion invalide');
    const active=[true,false,0,1,'true','false','0','1'].includes(c.body.active)?[true,1,'true','1'].includes(c.body.active):bad(c,'État de promotion invalide');
    return {ogrine_id:p.id,percent:integer(c,c.body.percent,'Bonus',1,100),max_per_user:integer(c,c.body.max_per_user,'Limite par joueur',1,1000),starts_at:new Date(start).toISOString(),ends_at:new Date(end).toISOString(),active,local_test:true};
  };
  router.get('/api/admin/ogrine-promos',c=>c.state.list('commerceOgrinePromos').map(p=>view(c,p)),options);
  router.get('/api/admin/ogrine-promos/packs',c=>c.state.list('products').filter(p=>p.type==='ogrine').map(p=>({id:p.id,name:p.name,price:p.prices?.euros?.value??0})),options);
  router.post('/api/admin/ogrine-promos',c=>c.state.transaction(()=>view(c,c.state.put('commerceOgrinePromos',validated(c)))),options);
  router.put('/api/admin/ogrine-promos/:id',c=>c.state.transaction(()=>{const p=requirePromo(c);return view(c,c.state.patch('commerceOgrinePromos',p.id,validated(c)))}),options);
  router.delete('/api/admin/ogrine-promos/:id',c=>{c.state.transaction(()=>{const p=requirePromo(c);c.state.delete('commerceOgrinePromos',p.id)});return {success:true,local_test:true}},options);
  router.get('/api/admin/ogrine-promos/:id/stats',c=>{
    const p=requirePromo(c),purchases=c.state.list('commercePromoPurchases').filter(x=>x.promo_id===p.id).sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at)),byUser=new Map(),days=new Map();
    for(const row of purchases){if(!byUser.has(row.user_id))byUser.set(row.user_id,[]);byUser.get(row.user_id).push(row);const day=row.created_at.slice(0,10);days.set(day,(days.get(day)??0)+row.quantity);}
    const total=purchases.reduce((n,x)=>n+x.quantity,0),unique=byUser.size,completed=[...byUser.values()].filter(rows=>rows.reduce((n,x)=>n+x.quantity,0)>=p.max_per_user).length;
    const first=[...byUser.values()].map(rows=>(Date.parse(rows[0].created_at)-Date.parse(p.starts_at))/60000),between=[...byUser.values()].flatMap(rows=>rows.slice(1).map((row,i)=>(Date.parse(row.created_at)-Date.parse(rows[i].created_at))/60000));
    const avg=list=>list.length?Math.round(list.reduce((n,x)=>n+x,0)/list.length*100)/100:null;
    return {total_purchases:total,unique_users:unique,avg_per_user:unique?Math.round(total/unique*100)/100:0,completed_users:completed,completion_rate:unique?Math.round(completed/unique*100):0,avg_first_delay_min:avg(first),avg_between_delay_min:avg(between),timeline:[...days].map(([day,count])=>({day,count})),local_test:true};
  },options);
}

function registerMarket(router) {
  router.get('/api/products/market/:server',c=>{
    const q=c.query,all=c.state.list('commerceMarketListings').filter(l=>l.status==='active'&&l.server_id===num(c.params.server));
    let rows=all.map(l=>({listing:l,player:c.state.get('players',l.player_id)})).filter(row=>row.player).map(row=>playerView(c,row.player,row.listing));
    if(q.name)rows=rows.filter(p=>p.name.toLowerCase().includes(String(q.name).toLowerCase()));
    const classes=ids(q.classe??q['classe[]']),jobs=ids(q.jobs??q['jobs[]']);
    if(classes.length)rows=rows.filter(p=>classes.includes(num(p.classe)));
    if(jobs.length)rows=rows.filter(p=>p.jobs.some(j=>jobs.includes(num(j.id))));
    if(q.align!=null&&q.align!=='')rows=rows.filter(p=>num(p.alignement.id)===num(q.align));
    if(q.mine==='1'||q.mine===1)rows=rows.filter(p=>p.user_id===user(c).id);
    if(q.parcho==='1'||q.parcho===1)rows=rows.filter(p=>p.full_parcho);
    for(const [key,field,sign]of [['price_min','price',1],['price_max','price',-1],['lvl_min','lvl',1],['lvl_max','lvl',-1]])if(q[key]!=null&&q[key]!=='')rows=rows.filter(p=>sign>0?p[field]>=num(q[key]):p[field]<=num(q[key]));
    const [field,direction]=String(q.sort_by??'price,0').split(','),allowed=new Set(['price','lvl','isInSell_date']);
    if(allowed.has(field))rows.sort((a,b)=>(direction==='1'?-1:1)*(field==='isInSell_date'?Date.parse(a[field])-Date.parse(b[field]):a[field]-b[field]));
    rows.sort((a,b)=>(Date.parse(b.premium_until??'')>Date.now()?1:0)-(Date.parse(a.premium_until??'')>Date.now()?1:0));
    const page=integer(c,q.page??1,'Page',1,10000),per=integer(c,q.per_page??18,'Taille de page',1,100),total=rows.length;
    return {players:rows.slice((page-1)*per,page*per),min_prices:MIN_PRICES,max_price:30000,pagination:{current_page:page,last_page:Math.max(1,Math.ceil(total/per)),per_page:per,total},local_test:true};
  });
  router.post('/api/market/sell',c=>{
    const listing=c.state.transaction(()=>{
      const p=owned(c,'players',c.body.player_id),server=num(c.body.server_id??p.server_id??p.serverId),amount=integer(c,c.body.price,'Prix',1,30000);
      if(num(p.server_id??p.serverId)!==server)bad(c,'Serveur incorrect');
      if(p.current_transfert||activeListing(c,p.id,server))bad(c,'Personnage déjà en vente ou en transfert',409);
      let minimum=100;for(const[level,value]of Object.entries(MIN_PRICES))if(num(p.level??p.lvl)>=num(level))minimum=value;
      if(amount<minimum)bad(c,'Prix inférieur au minimum local de '+minimum);
      const fee=Math.round(amount*.05);money(c,user(c).id,'ogrines',-fee);
      const l=c.state.put('commerceMarketListings',{user_id:user(c).id,player_id:p.id,server_id:server,price:amount,fee,status:'active',created_at:now(),local_test:true});
      c.state.patch('players',p.id,{isInSell:1,price:amount,isInSell_date:l.created_at});return l;
    });notify(c);return {success:true,listing,balance:wallet(user(c)),local_test:true};
  },AUTH);
  router.post('/api/market/buy',c=>{
    const result=c.state.transaction(()=>{
      const u=user(c),p=c.state.get('players',num(c.body.player_id));if(!p)bad(c,'Personnage introuvable',404);
      const server=num(c.body.server_id??p.server_id??p.serverId),l=activeListing(c,p.id,server);if(!l)bad(c,'Vente non disponible',409);
      if(l.user_id===u.id)bad(c,'Impossible d’acheter son propre personnage');
      const account=owned(c,'gameAccounts',c.body.account_id??c.body.account_to?.id);
      const option=c.body.panoply_item_id?panoplies(c,p).find(x=>x.item_id===num(c.body.panoply_item_id)):null;
      if(c.body.panoply_item_id&&!option)bad(c,'Panoplie locale invalide');
      const service=c.body.service_id?product(c,c.body.service_id):null;
      if(c.services?.emulator&&service)bad(c,'Le service complémentaire ne définit pas de cible réelle',409);
      if(service&&(service.type!=='service'||num(service.service?.service_action_id)!==2))bad(c,'Service complémentaire non disponible');
      const total=l.price+(option?.price??0)+(service?price(c,service,'ogrines').total:0);money(c,u.id,'ogrines',-total);money(c,l.user_id,'ogrines',l.price);
      const transfer={new_user_id:u.id,old_user_id:l.user_id,old_account_id:p.account_id,old_emulator_account_id:p.emulator_account_id,account_id:account.id,listing_id:l.id,amount:total,panoply:option,service_id:service?.id,state:'pending',created_at:now(),local_test:true};
      c.state.patch('players',p.id,{isInSell:0,price:0,current_transfert:transfer});c.state.patch('commerceMarketListings',l.id,{status:'pending-transfer',buyer_id:u.id,paid:total});
      log(c,u.id,'market',{player_id:p.id,amount:total,action:'purchase'});return transfer;
    });notify(c);notify(c,'WalletUpdated',result.old_user_id);return {success:true,current_transfert:result,balance:wallet(user(c)),local_test:true,message:'Achat local enregistré ; finalisez le transfert local.'};
  },AUTH);
  router.get('/api/market/pending-transfers',c=>({players:c.state.list('players').filter(p=>p.current_transfert?.new_user_id===user(c).id).map(p=>playerView(c,p)),local_test:true}),AUTH);
  router.post('/api/market/transfert/:server/:id',async c=>{
    if(c.services?.emulator)return realMarketTransfer(c);
    const p=c.state.transaction(()=>{
      const p=c.state.get('players',num(c.params.id)),u=user(c),t=p?.current_transfert;
      if(!t||t.new_user_id!==u.id)bad(c,'Transfert local non autorisé',403);
      if(num(p.server_id??p.serverId)!==num(c.params.server))bad(c,'Serveur incorrect');
      const a=owned(c,'gameAccounts',c.body.account_id??t.account_id);
      c.state.patch('commerceMarketListings',t.listing_id,{status:'sold',completed_at:now()});
      const saved=c.state.patch('players',p.id,{user_id:u.id,account_id:a.id,current_transfert:null,isInSell:0,price:0,...(t.panoply?{local_panoply:t.panoply}:{})});
      if(t.service_id)applyService(c,product(c,t.service_id),{player_id:p.id,server_id:num(c.params.server)});
      return c.state.get('players',saved.id);
    });return {success:true,player:playerView(c,p),local_test:true,message:'Propriété transférée dans la base locale uniquement.'};
  },AUTH);
  router.post('/api/market/cancel/:server/:id',c=>{
    const affected=[];
    c.state.transaction(()=>{
      const p=c.state.get('players',num(c.params.id));if(!p)bad(c,'Personnage introuvable',404);
      if(num(p.server_id??p.serverId)!==num(c.params.server))bad(c,'Serveur incorrect');
      const t=p.current_transfert;
      if(t&&c.state.list('commerceOutbox').some(row=>['pending','acknowledged'].includes(row.state)&&row.kind==='market-transfer'&&row.payload?.listingId===t.listing_id))bad(c,'La confirmation du transfert réel doit être reprise avant annulation',409);
      if(t){if(t.new_user_id!==user(c).id)bad(c,'Transfert non autorisé',403);const l=c.state.get('commerceMarketListings',t.listing_id);money(c,l.user_id,'ogrines',-l.price);money(c,t.new_user_id,'ogrines',t.amount);affected.push(l.user_id);c.state.patch('commerceMarketListings',l.id,{status:'cancelled'});}
      else {const l=activeListing(c,p.id,c.params.server);if(!l||l.user_id!==user(c).id)bad(c,'Vente non autorisée',403);c.state.patch('commerceMarketListings',l.id,{status:'cancelled'});}
      c.state.patch('players',p.id,{isInSell:0,price:0,current_transfert:null,premium_until:null});
    });notify(c);for(const id of affected)notify(c,'WalletUpdated',id);return {success:true,local_test:true};
  },AUTH);
  router.post('/api/market/premium',c=>{
    const end=c.state.transaction(()=>{
      const p=owned(c,'players',c.body.player_id),l=activeListing(c,p.id,c.body.server_id??p.server_id??p.serverId);if(!l)bad(c,'Vente introuvable',404);
      money(c,user(c).id,'ogrines',-100);const end=new Date(Math.max(Date.now(),Date.parse(l.premium_until??'')||0)+7*DAY).toISOString();c.state.patch('commerceMarketListings',l.id,{premium_until:end});c.state.patch('players',p.id,{premium_until:end});return end;
    });notify(c);return {success:true,premium_until:end,balance:wallet(user(c)),local_test:true};
  },AUTH);
  router.get('/api/market/panoplies/:server/:id',c=>{const p=c.state.get('players',num(c.params.id));if(!p||num(p.server_id??p.serverId)!==num(c.params.server))bad(c,'Personnage introuvable',404);return {panoplies:panoplies(c,p),quality:'locale',local_test:true}},AUTH);
}

function registerBak(router) {
  const balance=c=>wallet(user(c));
  router.get('/api/pages/bak/players/:server',c=>c.state.list('players').filter(p=>p.user_id===user(c).id&&num(p.server_id??p.serverId)===num(c.params.server)).map(p=>playerView(c,p)),AUTH);
  router.post('/api/pages/bak/web-bank',async c=>{
    if(c.services?.emulator)return realBank(c);
    const result=c.state.transaction(()=>{
      const p=owned(c,'players',c.body.player_id),amount=integer(c,c.body.amount,'Montant');
      if(num(p.server_id??p.serverId)!==num(c.body.server_id))bad(c,'Serveur incorrect');
      if(c.body.type==='+'){money(c,user(c).id,'kamas',-amount);c.state.patch('players',p.id,{kamas:num(p.kamas)+amount});}
      else if(c.body.type==='-'){if(num(p.kamas)<amount)bad(c,'Kamas du personnage insuffisants',409);money(c,user(c).id,'kamas',amount);c.state.patch('players',p.id,{kamas:num(p.kamas)-amount});}
      else bad(c,'Sens du transfert invalide');
      log(c,user(c).id,'bank',{player_id:p.id,amount,type:c.body.type});return balance(c);
    });notify(c);return {success:true,balance:result,local_test:true,message:'Transfert de kamas dans la base locale uniquement.'};
  },AUTH);
  router.get('/api/pages/bak/offers/:server',c=>{
    const offers=c.state.list('commerceBakOffers').filter(o=>o.server_id===num(c.params.server)&&o.quantity>0&&o.status==='active').sort((a,b)=>a.rate-b.rate);
    return {chart:[['J-2','J-1','Aujourd’hui'],[100,105,100]],offers,rates:{kamas:100,ogrines:100,min:100,max:105,average:100,avg:100,today:100},local_test:true};
  },AUTH);
  router.post('/api/pages/bak/offers',c=>{
    const offer=c.state.transaction(()=>{
      const u=user(c),type=c.body.type;if(!['ogrines','kamas'].includes(type))bad(c,'Type d’offre invalide');
      const quantity=integer(c,c.body.quantity,'Quantité'),rate=integer(c,c.body.rate,'Taux',1,100000),server=integer(c,c.body.server_id??5,'Serveur');
      if(type==='kamas'&&quantity%rate!==0)bad(c,'La quantité de kamas doit être un multiple du taux');
      if(c.state.list('commerceBakOffers').some(o=>o.user_id===u.id&&o.server_id===server&&o.type===type&&o.status==='active'))bad(c,'Une offre de ce type existe déjà',409);
      const fee=Math.floor(quantity*.05);money(c,u.id,type,-quantity-fee);
      return c.state.put('commerceBakOffers',{user_id:u.id,server_id:server,type,quantity,rate,price:type==='ogrines'?quantity*rate:quantity/rate,fee,status:'active',created_at:now(),local_test:true});
    });notify(c);c.services?.emit?.(null,'OfferCreated',[offer]);return {success:true,offer,balance:balance(c),local_test:true};
  },AUTH);
  router.post('/api/pages/bak/offer',c=>{
    const offer=c.state.transaction(()=>{
      const o=c.state.get('commerceBakOffers',num(c.body.id)),u=user(c);if(!o||o.status!=='active')bad(c,'Offre indisponible',409);
      const quantity=integer(c,c.body.quantity,'Quantité',0),rate=integer(c,c.body.rate??o.rate,'Taux',1,100000);
      if(o.type==='kamas'&&quantity%rate!==0)bad(c,'Quantité indivisible par le taux');
      if(o.user_id===u.id){const delta=quantity-o.quantity,fee=delta>0?Math.floor(delta*.05):0;money(c,u.id,o.type,-delta-fee);return c.state.patch('commerceBakOffers',o.id,{quantity,rate,price:o.type==='ogrines'?quantity*rate:quantity/rate,status:quantity?'active':'cancelled',fee:o.fee+fee});}
      if(!quantity||quantity>o.quantity)bad(c,'Quantité non disponible',409);
      if(rate!==o.rate)bad(c,'Le taux de l’offre a changé',409);
      const buyCurrency=o.type==='ogrines'?'kamas':'ogrines',cost=o.type==='ogrines'?quantity*o.rate:quantity/o.rate;
      if(!Number.isSafeInteger(cost))bad(c,'Prix non entier');
      money(c,u.id,buyCurrency,-cost);money(c,o.user_id,buyCurrency,cost);money(c,u.id,o.type,quantity);
      log(c,u.id,'bak',{offer_id:o.id,quantity,cost,type:o.type});
      return c.state.patch('commerceBakOffers',o.id,{quantity:o.quantity-quantity,price:o.type==='ogrines'?(o.quantity-quantity)*o.rate:(o.quantity-quantity)/o.rate,status:o.quantity===quantity?'sold':'active'});
    });notify(c);if(offer.user_id!==user(c).id)notify(c,'WalletUpdated',offer.user_id);c.services?.emit?.(null,'OfferUpdated',[offer]);return {success:true,offer,balance:balance(c),local_test:true};
  },AUTH);
}

export const acceptanceCases = [
  {method:'GET',path:'/api/products/all',auth:'player',expect:'sections with purchasable local products'},
  {method:'POST',path:'/api/promo/validate',auth:'player',body:{code:'LOCAL10'},expect:'success buyer_percent10'},
  {method:'POST',path:'/api/inventory/code/LOCAL-GIFT',auth:'player',expect:'persistent inventory; duplicate claim409'},
  {method:'POST',path:'/api/order',auth:'player',body:{gateway:'ogrines',products:[{id:2001,type:'item',quantity:2}]},expect:'pending order with backend-derived total200'},
  {method:'GET',path:'/api/btcpay/invoice/1001',auth:'player',expect:'opaque local invoice and loopback checkoutUrl; manual TEST confirmation required'},
  {method:'GET',path:'/api/shop/gemmes',auth:'player',expect:'sections/subscriptions/balance'},
  {method:'GET',path:'/api/products/market/5',auth:'player',expect:'players/min_prices/pagination'},
  {method:'GET',path:'/api/pages/bak/offers/5',auth:'player',expect:'chart/offers/rates'},
  {method:'GET',path:'/api/admin/ogrine-promos',auth:'admin',expect:'promotion rows including ogrine.name and purchases_count; player403'},
  {method:'GET',path:'/api/admin/ogrine-promos/packs',auth:'admin',expect:'pack id/name/price choices'},
];

/** Resume after a backend crash using the persisted request and the same Java operation ID. */
export async function resumePending(router,state,services){
  const paths=new Set(['/api/inventory','/api/service/checkout','/api/shop/gemmes/abonnement','/api/pages/bak/web-bank']),results=[];
  if(!services?.emulator)return results;
  for(const row of state.list('commerceOutbox').filter(row=>['pending','acknowledged'].includes(row.state))){
    if(!paths.has(row.request?.path)&&!/^\/api\/market\/transfert\/\d+\/\d+$/.test(row.request?.path??''))continue;
    const current=state.get('users',row.user_id);if(!current)continue;
    try{await router.dispatch('POST',row.request.path,{body:row.request.body,query:{},user:current,state,services,req:{method:'POST',url:row.request.path,headers:{}}});results.push({id:row.id,operation_id:row.operation_id,status:'applied'})}
    catch(error){results.push({id:row.id,operation_id:row.operation_id,status:'pending-or-refused',httpStatus:error.status||503})}
  }return results;
}
