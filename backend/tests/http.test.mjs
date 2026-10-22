import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {createLocalServer,projectRoot} from '../server.mjs';
import {State} from '../state.mjs';
import * as commerce from '../modules/commerce.mjs';
import * as world from '../modules/world.mjs';

test('real HTTP contract, origin guard, auth, multipart, routes and persistent SQLite',async t=>{
  const folder=await fs.mkdtemp(path.join(projectRoot,'work/http-test-')),database=path.join(folder,'state.sqlite');
  let app=await createLocalServer({database,port:0});await app.listen();
  async function call(method,url,body,token,headers={}){
    const response=await fetch(app.origin+url,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(token?{authorization:'Bearer '+token}:{}),...headers},body:body?JSON.stringify(body):undefined});
    const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}
    return{status:response.status,data,headers:response.headers};
  }
  try{
    const admin=(await call('GET','/local/session?user=1')).data,player=(await call('GET','/local/session?user=2')).data;
    assert.equal(admin.user.role_id,4);assert.equal(player.user.kamas[5],10000000);assert.equal(admin.user.password_hash,undefined);
    const login=await call('POST','/api/auth/login',{email:'joueur@local.test',password:'LocalTest!2026'});assert.equal(typeof login.data,'string');assert.equal(login.status,200);
    assert.equal((await call('POST','/api/auth/login',{email:'joueur@local.test',password:'wrong'})).status,422);
    assert.equal((await call('GET','/api/pages/user/accountsLauncher',null,player.token)).data[0].id,2);
    assert.equal((await call('GET','/api/pages/user/account/1/players',null,player.token)).status,403);
    assert.equal((await call('GET','/api/admin/beta-access',null,player.token)).status,403);
    assert.equal((await call('GET','/local/status',null,null,{Origin:'https://hostile.example'})).status,403);
    const preflight=await call('OPTIONS','/api/pages/user',null,null,{Origin:'null'});assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),'null');
    const response=await fetch(app.origin+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:'{'});assert.equal(response.status,400);
    const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
    const form=new FormData();form.append('avatar',new Blob([image],{type:'image/png'}),'sample.png');
    const uploaded=await fetch(app.origin+'/api/user/update/avatar',{method:'POST',headers:{Authorization:'Bearer '+player.token},body:form});assert.equal(uploaded.status,200);
    const upload=await uploaded.json();assert.equal(crypto.createHash('sha256').update(Buffer.from(await fetch(upload.avatar).then(r=>r.arrayBuffer()))).digest('hex'),crypto.createHash('sha256').update(image).digest('hex'));
    for(const sample of[...commerce.acceptanceCases,...world.acceptanceCases]){
      const token=sample.auth==='admin'?admin.token:sample.auth==='player'?player.token:undefined;
      const result=await call(sample.method,sample.path,sample.body,token);
      assert.equal(result.status,sample.expectStatus??200,`${sample.name||sample.path}: ${JSON.stringify(result.data).slice(0,500)}`);
    }
    await call('POST','/api/user/update/pseudo',{pseudo:'Persisted Local'},player.token);
    await app.close();app=await createLocalServer({database,port:0});await app.listen();
    assert.equal((await call('GET','/api/pages/user/profil',null,player.token)).data.name,'Persisted Local');
    assert.equal((await call('GET','/api/unknown-operation',null,player.token)).status,404);
  }finally{await app.close();if(!folder.startsWith(path.join(projectRoot,'work')+path.sep))throw Error('Unowned test cleanup path');await fs.rm(folder,{recursive:true,force:true});}
});

test('Pusher protocol verifies private HMAC and delivers committed wallet events',async()=>{
  const state=new State(':memory:'),app=await createLocalServer({state,port:0});await app.listen();
  const socket=new WebSocket(app.origin.replace('http:','ws:')+'/app/local-test?protocol=7');
  const messages=[];socket.on('message',data=>messages.push(JSON.parse(data.toString())));
  const waitFor=async predicate=>{for(let i=0;i<100;i++){const message=messages.find(predicate);if(message)return message;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Expected websocket event not received');};
  try{
    await once(socket,'open');const connected=await waitFor(x=>x.event==='pusher:connection_established'),socketId=JSON.parse(connected.data).socket_id;
    socket.send(JSON.stringify({event:'pusher:subscribe',data:{channel:'private-App.Models.Login.User.2',auth:'local-test:forged'}}));
    assert.equal(JSON.parse((await waitFor(x=>x.event==='pusher:error')).data).code,4009);
    const user=await fetch(app.origin+'/local/session?user=2').then(r=>r.json());
    const auth=await fetch(app.origin+'/api/broadcasting/auth',{method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer '+user.token},body:JSON.stringify({socket_id:socketId,channel_name:'private-App.Models.Login.User.2'})}).then(r=>r.json());
    socket.send(JSON.stringify({event:'pusher:subscribe',data:{channel:'private-App.Models.Login.User.2',auth:auth.auth}}));
    await waitFor(x=>x.event==='pusher_internal:subscription_succeeded');app.services.emit(2,'OgrinesCommit',[123,0]);
    assert.deepEqual(JSON.parse((await waitFor(x=>x.event==='App\\Events\\OgrinesCommit')).data),[123,0]);
    const denied=await fetch(app.origin+'/api/broadcasting/auth',{method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer '+user.token},body:JSON.stringify({socket_id:socketId,channel_name:'private-App.Models.Login.User.1'})});assert.equal(denied.status,403);
  }finally{socket.terminate();await app.close();state.close();}
});
