/* Explicit fixtures for the isolated local build. No real credentials or remote login. */
(()=>{
  'use strict';
  const origin='http://127.0.0.1:4318';
  const status={mode:'local-test',ready:false,errors:[],runtime:null};
  globalThis.__ABRAK_LOCAL_STATUS__=status;
  // Quasar prefetch changes a shared admin store before the route commits.
  // Keep its previous page unmounted until the destination owns that data.
  globalThis.__ABRAK_LOCAL_ADMIN_RELEASE__=(store,name)=>{
    const router=globalThis.__ABRAK_LOCAL__?.router;
    if(!router||router.currentRoute.value.name===name){store.loading=false;return;}
    const release=router.afterEach(()=>{release();requestAnimationFrame(()=>{store.loading=false;});});
  };
  window.addEventListener('unhandledrejection',event=>status.errors.push(String(event.reason?.stack||event.reason)));
  window.addEventListener('error',event=>status.errors.push(String(event.error?.stack||event.message)));
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const selectedUser=()=>Number(localStorage.getItem('abrak-local-fixture-user')||1);
  async function ready(){for(let i=0;i<300;i++){const app=globalThis.__ABRAK_LOCAL__;if(status.mounted&&app?.pinia?._s?.has('use-auth-store'))return app;await wait(100);}throw Error('Initialisation de l’application locale incomplète');}
  function observeErrors(app){
    if(!status.vueErrorHandler){const previous=app.app.config.errorHandler;app.app.config.errorHandler=(error,instance,info)=>{status.errors.push(String(error?.stack||error));if(previous)previous(error,instance,info);else console.error(error);};status.vueErrorHandler=true;}
  }
  async function session(app,id){
    const auth=app.pinia._s.get('use-auth-store');
    if(!auth)throw Error('Le compte local ne peut pas encore être initialisé');
    const response=await fetch(origin+'/local/session?user='+encodeURIComponent(id));if(!response.ok)throw Error('Le backend local ne répond pas');
    const fixture=await response.json();
    auth.$patch({token:fixture.token,user:fixture.user});auth._setAuthHeader(fixture.token);auth._upsertAccount?.();
    app.app.config.globalProperties.$echo?.connector?.pusher?.config&&(app.app.config.globalProperties.$echo.connector.pusher.config.auth={headers:{Authorization:'Bearer '+fixture.token}});
    app.app.config.globalProperties.$echo?.connector?.options?.auth&&(app.app.config.globalProperties.$echo.connector.options.auth.headers={Authorization:'Bearer '+fixture.token});
    localStorage.setItem('abrak-local-fixture-user',String(id));
    return fixture;
  }
  // The session must exist before Vue Router starts its first protected route.
  // Browsers do not instantiate the native launcher store during App.setup().
  globalThis.__ABRAK_LOCAL_BOOT__=async app=>{
    observeErrors(app);
    try{const fixture=await session(app,selectedUser());status.user=fixture.user.id;status.sessionReady=true;}
    catch(error){report(error);throw error;}
  };
  let activation=Promise.resolve();
  function activate(id=selectedUser(),options={}){
    const pending=activation.catch(()=>{}).then(()=>finishActivation(id,options));activation=pending;return pending;
  }
  async function finishActivation(id,{openAdmin=false,reuseSession=false}={}){
    const app=await ready(),auth=app.pinia._s.get('use-auth-store');
    observeErrors(app);
    await app.router.isReady();
    if(!reuseSession||!status.sessionReady||Number(auth.user?.id)!==Number(id))await session(app,id);
    await auth._reloadUserScopedData?.();
    const launcher=app.pinia._s.get('launcher');
    if(openAdmin){
      await app.router.push({name:'admin_home'});
      const settings=app.pinia._s.get('admin-settings');if(settings)settings.leftDrawerOpen=true;
    }
    else if(!auth.isAdmin&&app.router.currentRoute.value.matched.some(route=>route.meta.requiresAdmin))await app.router.push('/');
    if(window.LAUNCHER?.getLocalRuntimeState){
      const runtime=await window.LAUNCHER.getLocalRuntimeState();status.runtime=runtime;
      if(runtime.nativeClientReady&&window.LAUNCHER.startLocalNativeServices){const services=await window.LAUNCHER.startLocalNativeServices();status.nativeServices=services;if(services?.code)throw Error(services.detail||services.code);}
      const previous=launcher.games.main||{},installed=runtime.games.main;
      const version=previous.path===installed.path&&previous.installed&&Number.isSafeInteger(Number(previous.version))&&Number(previous.version)>=1?Number(previous.version):installed.version;
      launcher.$patch({tab:'games',current_game:'main',platform:'win',games:{...launcher.games,main:{...previous,...installed,version}},disable:false});
    }
    if(launcher&&!launcher.accounts_selected?.length)launcher.accounts_selected=[id];
    status.ready=true;status.user=id;
    document.title='Abrak Launcher';
    window.dispatchEvent(new CustomEvent('abrak:pending-transfers'));
    return status;
  }
  function report(error){status.errors.push(String(error.stack||error));console.error('[local bootstrap]',error);}
  globalThis.__ABRAK_LOCAL_MOUNTED__=()=>{status.mounted=true;activate(selectedUser(),{reuseSession:true,openAdmin:typeof location!=='undefined'&&/(?:^|[?&])admin=1(?:&|$)/.test(location.search)}).catch(report);};
  globalThis.__ABRAK_LOCAL_ACTIVATE__=activate;
})();
