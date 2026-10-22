import {randomBytes,createHash} from 'node:crypto';
const active=row=>['pending','acknowledged'].includes(row.state);
export function reservedBalance(state,userId,currency,excludeOperationId){
  const queued=state.list('commerceOutbox').filter(row=>active(row)&&row.user_id===userId&&row.currency===currency&&row.operation_id!==excludeOperationId).reduce((sum,row)=>sum+(row.cost||0),0);
  const gifts=currency==='ogrines'?state.list('commerceMarketListings').filter(row=>row.status==='pending-transfer'&&row.user_id===userId&&row.service_fee>0&&!row.service_fee_paid&&`listing:${row.id}`!==excludeOperationId).reduce((sum,row)=>sum+row.service_fee,0):0;return queued+gifts;
}
export async function runOutbox(c,{kind,payload,currency=null,cost=0,inventoryId=null,quantity=0,requestPath=null,execute,apply}){
  c.requireUser();const uid=c.user.id;
  const fingerprint=createHash('sha256').update(JSON.stringify({kind,payload,currency,cost,inventoryId,quantity})).digest('hex');
  const requested=c.body.operationId??c.req?.headers?.['idempotency-key'];
  if(requested!=null&&(typeof requested!=='string'||!/^[A-Za-z0-9_.:-]{8,64}$/.test(requested)))c.fail(422,'Clé d’opération invalide');
  let row=c.state.transaction(()=>{
    const rows=c.state.list('commerceOutbox'),operationId=requested?`commerce:${uid}:${kind}:${requested}`:null;
    const old=operationId?rows.find(row=>row.operation_id===operationId):rows.find(row=>row.user_id===uid&&row.fingerprint===fingerprint&&active(row));
    if(old){if(old.fingerprint!==fingerprint||old.user_id!==uid)c.fail(409,'Cette opération possède déjà un autre contenu');return old}
    if(currency){const u=c.state.get('users',uid);if(!Number.isSafeInteger(cost)||cost<0||Number(u?.[currency]||0)-reservedBalance(c.state,uid,currency)<cost)c.fail(409,'Solde disponible insuffisant pour le serveur réel')}
    if(inventoryId){const item=c.state.get('inventory',inventoryId),reserved=rows.filter(row=>active(row)&&row.inventory_id===inventoryId).reduce((sum,row)=>sum+row.quantity,0)+c.state.list('commerceMarketListings').filter(row=>row.status==='pending-transfer'&&row.service_inventory_id===inventoryId).reduce((sum,row)=>sum+(row.service_inventory_quantity||0),0);if(!item||item.user_id!==uid||item.quantity-reserved<quantity)c.fail(409,'Quantité déjà récupérée ou réservée par une livraison')}
    const requestKey=requested||randomBytes(16).toString('hex');
    return c.state.put('commerceOutbox',{user_id:uid,operation_id:operationId||`commerce:${uid}:${kind}:${requestKey}`,kind,payload,fingerprint,currency,cost,inventory_id:inventoryId,quantity,request:{path:requestPath,body:{...structuredClone(c.body),operationId:requestKey}},state:'pending',created_at:new Date().toISOString(),attempts:0,real_emulator:true});
  });
  if(row.state==='applied')return structuredClone(row.response);
  if(row.state==='failed')c.fail(row.error_status||409,'Cette opération réelle a été refusée ; utilisez une nouvelle clé après correction');
  let ack=row.ack;
  if(!ack){
    c.state.transaction(()=>{const current=c.state.get('commerceOutbox',row.id);c.state.patch('commerceOutbox',row.id,{attempts:(current.attempts||0)+1,last_attempt_at:new Date().toISOString()})});
    try{ack=await execute(row.operation_id);if(!ack?.success||!ack.persisted||ack.operationId!==row.operation_id)c.fail(503,'Le serveur réel n’a pas confirmé la persistance de l’opération')}
    catch(error){const status=Number(error.status)||503;c.state.transaction(()=>{const current=c.state.get('commerceOutbox',row.id);if(current.state!=='applied')c.state.patch('commerceOutbox',row.id,{state:status>=400&&status<500?'failed':'pending',error_status:status,last_error:'Opération du clone non confirmée'})});throw error}
    c.state.transaction(()=>{const current=c.state.get('commerceOutbox',row.id);if(current.state!=='applied')c.state.patch('commerceOutbox',row.id,{state:'acknowledged',ack,acknowledged_at:new Date().toISOString()})});
  }
  return c.state.transaction(()=>{
    row=c.state.get('commerceOutbox',row.id);if(row.state==='applied')return structuredClone(row.response);
    const response=apply(ack,row.operation_id);c.state.patch('commerceOutbox',row.id,{state:'applied',response,applied_at:new Date().toISOString()});return response;
  });
}
