/** Rebuild evidence for the independent local commerce implementation. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Router} from '../router.mjs';
import {register,acceptanceCases} from './commerce.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const tracked=['backend/modules/commerce.mjs','backend/modules/commerce-outbox.mjs','backend/modules/commerce-contract.test.mjs','backend/modules/commerce-outbox.test.mjs','backend/modules/commerce-verify.mjs','backend/state.mjs','backend/router.mjs','backend/seed.mjs','backend/API-CONTRACT.md'];
const files=tracked.map(file=>{const bytes=fs.readFileSync(path.join(root,file));return{file,bytes:bytes.length,sha256:hash(bytes)}});
const refs=[],unresolved=[];
function retain(id,file,needle,{before=0,after=0}={}) {
  const bytes=fs.readFileSync(path.join(root,file)),text=bytes.toString('utf8'),at=text.indexOf(needle);
  if(at<0){unresolved.push({id,file,needle,reason:'Exact source fragment not found in current local source; may have been intentionally patched.'});return;}
  const start=Math.max(0,at-before),end=Math.min(text.length,at+needle.length+after),code=text.slice(start,end);
  refs.push({id,file,sourceSha256:hash(bytes),start,end,rangeUnits:'UTF-16 code units, zero-based, end-exclusive',byteStart:Buffer.byteLength(text.slice(0,start)),byteEnd:Buffer.byteLength(text.slice(0,end)),excerptSha256:hash(Buffer.from(code)),code});
}
const common='source/app/js/chunk-common.js';
retain('cart.order-products',common,'n.api.post("/api/order",{products:this.products.map((e=>({id:e.id,quantity:e.quantity,type:e.type}))),gateway:e})',{after:180});
retain('shop.inventory-getter',common,'getInventory:e=>e.inventory.filter((e=>e.quantity>0))');
retain('inventory.pickup-response',common,'s.api.post("/api/inventory",e)',{after:150});
retain('inventory.gift-code-response',common,'s.api.post("/api/inventory/code/"+e)',{after:120});
retain('promo.response',common,'s.api.post("/api/promo/validate",{code:e})',{after:220});
retain('player-code.lookup',common,'n.api.get("/api/player-code/lookup",{params:{code:l}})',{after:140});
retain('service.checkout-body',common,'let e={service_id:N.service_id,account_to_id:N.account_to?.id,player_id:N.player.id,server_id:N.player.serverId,accounts:N.accounts,quantity:B.value,user_to_code:H.value?.code,auto_renew:T.value}',{after:750});
retain('arcanes.shop-response',common,'u.api.post("/api/shop/gemmes",{items:He.value.map((e=>({id:e.product.id,quantity:e.quantity})))})',{after:180});
retain('arcanes.subscription-duration',common,'arcane:{duration:(0,n.R1)(ia).key,price:(0,n.R1)(ia).price,originalPrice:(0,n.R1)(ia).original_price,degressive:(0,n.R1)(ia).degressive,maxAccounts:(0,n.R1)(ia).max_accounts}');
retain('arcanes.catalog-response',common,'u.api.get("/api/shop/gemmes")',{after:250});
retain('bak.offers-response',common,'this.data=a})).finally((()=>{this.loading=!1,this._pending=!1,this._pendingPromise=null})))',{before:160});
retain('bak.bank-direction',common,'title:"+"==c.value?"Envoyer mes kamas web en jeu":"Ajouter des kamas"');
retain('bak.server-wallet-shape',common,'Math.floor(e.kamas[e.server])',{after:100});
retain('bak.rate-default',common,'rate:(0,n.R1)(m).today>0?(0,n.R1)(m).today:(0,n.R1)(m).avg');
retain('bak.offer-balance',common,'a.value.kamas=e.balance.kamas,a.value.ogrines=e.balance.ogrines,a.value.ogrines_linked=e.balance.ogrines_linked');
retain('market.pagination-consumer',common,'"market"===e&&a.pagination&&(this.marketPagination=a.pagination)');
retain('market.purchase-body',common,'pe=(0,s.Kh)({player_id:ce.value.id,server_id:ce.value.serverId,account_id:null,account_to:null,service_id:null,panoply_item_id:null');
retain('market.pending-transfer',common,'ce.value.current_transfert&&i.value.id===ce.value.current_transfert.new_user_id');
retain('history.group-keys','source/app/js/6393.js','const s={OgrinesHistory:c.A,IgHistory:i.A,ServicesHistory:n.A}',{after:200});
retain('currency.events','source/app/js/app.js','.listen("KamasCommit",(e=>{n.value.kamas=e[0]})).listen("OgrinesCommit",(e=>{n.value.ogrines=e[0],n.value.ogrines_linked=e[1]})).listen("ArcanesCommit",(e=>{n.value.arcanes=e[0]}))');
retain('ogrine-promos.admin-crud','source/app/js/8477.js','actions:{async fetchContent()',{after:1010});
retain('ogrine-promos.admin-form','source/app/js/8477.js','const H=()=>({id:null,ogrine_id:null,percent:5,max_per_user:5,starts_at:"",ends_at:"",active:!0})',{after:840});
retain('ogrine-promos.stats-shape','source/app/js/8477.js','N.value.total_purchases',{before:50,after:1900});
retain('ogrine-promos.public-remaining',common,'e.promo&&e.promo.remaining>0?',{after:200});

const run=spawnSync(process.execPath,['--test','--test-reporter=tap',path.join(root,'backend/modules/commerce-contract.test.mjs'),path.join(root,'backend/modules/commerce-outbox.test.mjs')],{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:4*1024*1024});
const output=run.stdout??'',get=key=>Number(new RegExp('^# '+key+' (\\d+)','m').exec(output)?.[1]??0);
const router=new Router();register(router);
const report={
  schemaVersion:1,createdUtc:new Date().toISOString(),status:run.status===0?'PASS':'FAIL',
  implementationKind:'Persistent local economy matching recovered UI consumers. Optional services.emulator performs acknowledged effects in the owned Java/SQL clone. Original remote backend source was not supplied.',
  executionBoundary:{originalApplicationExecuted:false,remoteApiCalled:false,realPaymentMade:false,realClientInventoryOrCharacterModified:false,originalOrReplicaModified:false},
  files,sourceRefs:refs,unresolvedSourceRefs:unresolved,
  routes:router.inventory(),acceptanceCases,
  tests:{command:'node --test backend/modules/commerce-contract.test.mjs backend/modules/commerce-outbox.test.mjs',runtime:process.version,exitCode:run.status,tests:get('tests'),pass:get('pass'),fail:get('fail'),durationMs:Number(/^# duration_ms ([0-9.]+)/m.exec(output)?.[1]??0),cases:[...output.matchAll(/^# Subtest: (.+)$/gm)].map(match=>match[1]),stdout:output,stderr:run.stderr??'',coverage:['Canonical server-derived checkout totals and rejection of malformed quantities/prices/body','Order ownership, insufficient-balance rollback and idempotent fulfilment','One gift-code redemption per user and inventory/account ownership checks','World item_template reward compatibility and bounded local delivery ledger','Subscription extensions preserve existing future expiry; Arcanes canonical debit','Explicit local payment capability token, expiry, manual confirmation and replay safety','Local VIP/BattlePass entitlements, promo bonus and privacy-limited player code lookup','Character sale fee, canonical purchase, pending transfer, ownership transition and cancellation refund','Web bank direction from recovered UI and currency conservation','BAK escrow/reservation, partial fill, rate validation, cancellation refund and ownership','SQLite close/reopen persistence and seed idempotence','Persistent outbox before bridge dispatch, inventory/wallet reservation and real ACK requirement','Recovery after bridge commit plus connection loss and after ACK plus SQLite settlement failure','Real-transfer mode accounting, replay after changed owner, gifted fee reservation and market cancellation guard','Real-mode service20 rejection and existing bundled image references']},
  sharedState:{internalUserKamas:'Numeric shared bucket value',publicKamas:'{5: numericAmount}, per recovered WebBank consumer',subscriptionFields:['subscription_end','subscription','subscribed_until','subscription_until','bPack'],entitlements:['users.vip_until','users.battlepass_premium_until'],buckets:['products','inventory','orders','commercePromos','commerceOgrinePromos','commercePromoPurchases','commerceGiftCodes','commercePayments','commerceLogs','commerceDeliveries','commerceMarketListings','commerceBakOffers'],worldRewardShape:'inventory item/item_template with item_id is accepted without product_id'},
  demoFixtures:{promoCode:'LOCAL10',giftCode:'LOCAL-GIFT',shopItem:2001,subscriptionProducts:[16,17,18],playerService:20,accountTransferService:21,ogrinePacks:[1001,1002,1003],battlePassTebex:7001,vipTebex:7002,marketListing:'Admin player3, price5000, local test only',bakOffer:'Admin offer100ogrines at100kamas/ogrine, locally escrowed'},
  modelChoices:[
    'Catalogue IDs, prices, promotional percentages, BAK rates and contents are explicit local fixtures; they are not claimed as recovered upstream server data.',
    'Recovered UI displays a5% listing fee; local BAK creation also charges a declared5% fee in the offered currency. Exact unavailable upstream settlement rules are not claimed.',
    'A character purchase reserves a persistent pending transfer. With services.emulator, finalisation requires a Java/SQL ownership acknowledgement before the SQLite owner changes; otherwise it uses fixture state.',
    'Without services.emulator, effects remain fixture records. With it, item/subscription/kamas/account-transfer actions use the authenticated owned clone and a persistent outbox; undefined service20 is hidden and refused.',
    'Money-denominated catalogue packs use explicit TEST confirmation on a loopback page. They do not create a real card/crypto/Tebex/BTCPay transaction.'
    ,'Scheduled Ogrine pack promotions use date bounds, the highest active percentage, per-user quantity caps and additive promo-code bonuses. Admin statistics count bonus-eligible pack units; these settlement choices are local model behavior.'
  ],
  integrationNotes:[
    'Patch CryptoPayment hardcoded pay.abrak.fr iframe URL/origin to the local checkoutUrl and local origin; /invoice?id=<opaque invoice_id> is supplied for compatible local use.',
    'Public user serialization must expose kamas as server-indexed object while internal shared State remains numeric.',
    'OfferCreated/OfferUpdated must be broadcast on offers_<server_id>; module calls services.emit(null,event,[offer]).',
    'A pending transfer banner refetch requires original DOM event abrak:pending-transfers or a remount; publication of its local notification remains a root integration concern.'
  ],
  validationLimits:{routerAndSQLiteContract:'PASS when tests exit0',wireHttp:'Fixture/controlled-ACK tests here; real Java HTTP/SQL evidence is emulator/run/bridge-contract-tests.json and emulator/run/transfer-proof.json',nativeLauncherScreens:'NOT_RUN_BY_THIS_MODULE_TEST; root task retains separate native evidence',realGameEconomy:'Real effects available only with services.emulator and explicit real_emulator receipts; fixture mode otherwise',livePaymentProvider:'NOT_CONNECTED; explicit local test confirmation only'}
};
const target=path.join(root,'evidence/commerce-contract-tests.json');fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({file:target,status:report.status,routes:report.routes.length,tests:report.tests.tests,pass:report.tests.pass,fail:report.tests.fail,sourceRefs:refs.length,unresolved:unresolved.length,sha256:hash(fs.readFileSync(target))},null,2));
if(run.status!==0)process.exitCode=1;
