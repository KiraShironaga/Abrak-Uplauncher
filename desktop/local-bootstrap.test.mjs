import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const script=await fs.readFile(new URL('./local-bootstrap.js',import.meta.url),'utf8');
function browser(user=1,search=""){
  const elements=new Map(),buttons=[],saved=new Map([['abrak-local-fixture-user',String(user)]]),requests=[];
  const auth={user:{},token:null,$patch(value){Object.assign(this,value);},_setAuthHeader(value){this.header=value;},_upsertAccount(){},async _reloadUserScopedData(){},get isAdmin(){return this.user.role_id>0;}};
  const settings={leftDrawerOpen:false},stores=new Map([['use-auth-store',auth],['admin-settings',settings]]);
  const router={currentRoute:{value:{name:'admin_home',matched:[{meta:{requiresAdmin:true}}]}},async isReady(){assert(auth.user.id,'The initial route must receive an authenticated session');},async push(route){this.last=route;this.currentRoute.value={name:route?.name??'home_fr',matched:route?.name==='admin_home'?[{meta:{requiresAdmin:true}}]:[]};}};
  const app={pinia:{_s:stores},router,app:{config:{globalProperties:{},errorHandler:null}}};
  const context=vm.createContext({location:{search},console,setTimeout,requestAnimationFrame:fn=>fn(),CustomEvent:class{},localStorage:{getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value)},document:{createElement(){return{style:{},setAttribute(){},append(child){if(child.id)elements.set(child.id,child);if(child.textContent==='Admin'||child.textContent==='Joueur')buttons.push(child);}};},getElementById:id=>elements.get(id),body:{append(){}}},window:{addEventListener(){},dispatchEvent(){}},fetch:async url=>{requests.push(url);const id=Number(new URL(url).searchParams.get('user'));return{ok:true,json:async()=>({token:'test-token-'+id,user:{id,name:id===1?'Administrateur local':'Joueur local',role_id:id===1?4:0}})};}});
  vm.runInContext(script,context);
  context.__ABRAK_LOCAL__=app;
  return{context,app,auth,settings,buttons,requests,elements};
}
async function mount(harness){
  await harness.context.__ABRAK_LOCAL_BOOT__(harness.app);
  harness.context.__ABRAK_LOCAL_MOUNTED__();
  // Activations are serialized; wait for the initial one to finish.
  await harness.context.__ABRAK_LOCAL_ACTIVATE__(undefined,{reuseSession:true});
}

test('a browser can authenticate and mount a protected page without a native launcher store',async()=>{
  const h=browser();
  assert.equal(h.requests.length,0);
  await mount(h);
  assert.equal(h.auth.header,'test-token-1');
  assert.equal(h.context.__ABRAK_LOCAL_STATUS__.ready,true);
  assert.equal(h.app.pinia._s.has('launcher'),false);
  assert.equal(h.requests.length,1,'Mounting must reuse the session established before navigation');
});

test('admin activation changes the local profile and opens its navigation drawer',async()=>{
  const h=browser(2);await mount(h);
  assert.equal(h.auth.isAdmin,false);
  await h.context.__ABRAK_LOCAL_ACTIVATE__(1,{openAdmin:true});
  assert.equal(h.auth.user.id,1);
  assert.equal(h.auth.header,'test-token-1');
  assert.equal(h.app.router.last.name,'admin_home');
  assert.equal(h.settings.leftDrawerOpen,true);
});

test('player activation leaves the protected administration page',async()=>{
  const h=browser();await mount(h);
  await h.context.__ABRAK_LOCAL_ACTIVATE__(2);
  assert.equal(h.auth.user.id,2);
  assert.equal(h.auth.isAdmin,false);
  assert.equal(h.app.router.last,'/');
});

test('administration startup route is reached with the demo administrator session',async()=>{
  const h=browser(1,'?admin=1');await mount(h);
  assert.equal(h.auth.isAdmin,true);
  assert.equal(h.app.router.currentRoute.value.name,'admin_home');
  assert.equal(h.settings.leftDrawerOpen,true);
});
