import crypto from 'node:crypto';
import { hashPassword, checkPassword, publicUser } from './seed.mjs';
import { Response } from './router.mjs';

const success = message => ({ success: true, message, local_test: true });
export function issueSession(state, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  state.put('sessions', { id: token, user_id: userId, created_at: new Date().toISOString(), expires: Date.now() + 7 * 86400000 });
  return token;
}
export function resolveUser(state, request) {
  const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  const cookie = /(?:^|;\s*)local_session=([^;]+)/.exec(request.headers.cookie || '')?.[1];
  const session = state.get('sessions', bearer || cookie || '');
  if (!session || session.expires < Date.now()) return null;
  return state.get('users', session.user_id);
}
function ownedAccounts(ctx, includeDeleted = false) {
  const user = ctx.requireUser();
  return ctx.state.list('gameAccounts').filter(x => x.user_id === user.id && (includeDeleted || !x.deleted));
}
async function accountRows(ctx, includeDeleted = false) {
  if(ctx.services.emulator){
    const realAccounts=await ctx.services.emulator.listAccounts(ctx.requireUser().id);
    for(const account of ownedAccounts(ctx,includeDeleted).filter(x=>x.emulator_account_id)){
      const native=realAccounts.find(x=>x.id===account.emulator_account_id);
      if(!native)ctx.fail(409,'Le lien du compte vers le clone doit être réparé');
      const response=await ctx.services.emulator.listPlayers({webUserId:ctx.user.id,accountId:native.id});
      for(const p of response.players||[]){const local=ctx.state.list('players').find(x=>x.account_id===account.id&&x.emulator_player_id===p.id);if(local)ctx.state.patch('players',local.id,{name:p.name,emulator_name:p.name,level:p.level,lvl:p.level,class_id:p.class_id,classe:p.class_id,kamas:p.kamas,online:p.online,real_emulator:true});}
      ctx.state.patch('gameAccounts',account.id,{account:native.name,name:native.name,emulator_login:native.name,subscribe:native.subscriptionEndMs,subscription_end:new Date(native.subscriptionEndMs||0).toISOString(),connected:(response.players||[]).some(x=>x.online)});
    }
  }
  return ownedAccounts(ctx, includeDeleted).map(account => ({
    ...account,
    password_hash: undefined,
    players: ctx.state.list('players').filter(x => x.account_id === account.id),
    bPack: account.subscription_end || null, subscription_until: account.subscription_end || null,
    subscribe: (account.subscribe??Date.parse(account.subscription_end||''))||0,
    count: ctx.state.list('players').filter(x => x.account_id === account.id).length
  }));
}
function selection(ctx) {
  const values = ctx.body.accounts || (ctx.body.id ? [ctx.body.id] : []);
  const ids = (Array.isArray(values) ? values : [values]).map(x => Number(x?.id ?? x));
  if (!ids.length || ids.some(x => !Number.isInteger(x))) ctx.fail(422, 'Sélectionne au moins un compte');
  const owned = ownedAccounts(ctx, true);
  if (ids.some(id => !owned.some(x => x.id === id))) ctx.fail(403, 'Ce compte ne t’appartient pas');
  return ids;
}
export function register(router) {
  router.post('/api/admin/impersonate/:id',ctx=>{
    const admin=ctx.requireAdmin();if(admin.role_id<4)ctx.fail(403,'Gestionnaire local requis');
    const user=ctx.state.get('users',Number(ctx.params.id));if(!user)ctx.fail(404,'Utilisateur introuvable');
    if(user.role_id>0)ctx.fail(403,'Impossible de prendre la session d’un administrateur');
    ctx.state.put('adminAudit',{user_id:admin.id,action:'local.impersonate',target_user_id:user.id,created_at:new Date().toISOString(),local_test:true});
    return{token:issueSession(ctx.state,user.id),user:publicUser(user,ctx.state),name:user.name,id:user.id,local_test:true};
  },{admin:true});
  router.get('/sanctum/csrf-cookie', () => new Response('', 204, 'text/plain'));
  router.get('/api/auth/register/config', () => ({ registration: true, invite_code_required: false, local_test: true }));
  router.post('/api/auth/login', ctx => {
    const login = String(ctx.body.email || ctx.body.login || ctx.body.username || ctx.body.name || '').toLowerCase();
    const user = ctx.state.list('users').find(x => x.email.toLowerCase() === login || x.name.toLowerCase() === login);
    if (!user || !checkPassword(ctx.body.password, user.password_hash)) ctx.fail(422, 'Identifiants locaux incorrects', { errors: { email: ['Identifiants incorrects'] } });
    if (user.banned) ctx.fail(403, 'Compte local suspendu');
    const token = issueSession(ctx.state, user.id);
    return new Response(token, 200, 'application/json; charset=utf-8', { 'set-cookie': `local_session=${token}; HttpOnly; SameSite=Lax; Path=/` });
  });
  router.post('/api/auth/register', ctx => {
    const email = String(ctx.body.email || '').trim().toLowerCase();
    const name = String(ctx.body.name || ctx.body.pseudo || '').trim();
    if (!email.includes('@') || !name || String(ctx.body.password || '').length < 8) ctx.fail(422, 'Nom, e-mail et mot de passe de 8 caractères requis', { errors: { email: ['Vérifie les champs'] } });
    if (ctx.state.list('users').some(x => x.email === email)) ctx.fail(422, 'Cet e-mail existe déjà', { errors: { email: ['E-mail déjà utilisé'] } });
    const template = ctx.state.get('users', 2);
    const user = ctx.state.put('users', { ...template, id: undefined, email, name, role_id: 0, password_hash: hashPassword(ctx.body.password), created_at: new Date().toISOString(), player_code: undefined });
    return { ...success('Compte local créé et activé pour le test'), user: publicUser(user, ctx.state) };
  });
  for (const method of ['get', 'post']) router[method]('/api/auth/logout', ctx => {
    if (ctx.user) {
      const token = ctx.req.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (token) ctx.state.delete('sessions', token);
    }
    return new Response(success('Déconnecté'), 200, 'application/json; charset=utf-8', { 'set-cookie': 'local_session=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/' });
  });
  router.post('/api/auth/forgot-password', ctx => {
    const user = ctx.state.list('users').find(x => x.email === String(ctx.body.email || '').toLowerCase());
    if (user) {
      const token = crypto.randomBytes(20).toString('hex');
      ctx.state.put('mailbox', { user_id: user.id, to: user.email, subject: 'Réinitialisation locale', token, url: ctx.url(`/local/reset-password?token=${token}&email=${encodeURIComponent(user.email)}`), used: false, created_at: new Date().toISOString() });
    }
    return { ...success('Le message de test est disponible dans la boîte mail locale'), mailbox: ctx.url('/local/mailbox') };
  });
  router.post('/api/auth/reset-password', ctx => {
    const mail = ctx.state.list('mailbox').find(x => x.token === ctx.body.token && !x.used);
    if (!mail || String(ctx.body.password || '').length < 8) ctx.fail(422, 'Jeton de test invalide ou mot de passe trop court');
    ctx.state.transaction(() => {
      ctx.state.patch('users', mail.user_id, { password_hash: hashPassword(ctx.body.password) });
      ctx.state.patch('mailbox', mail.id, { used: true });
    });
    return success('Mot de passe local modifié');
  });
  router.post('/api/auth/activate', ctx => success('Compte de test déjà activé'));
  router.get('/api/auth/activate/:token?', ctx => success('Compte de test déjà activé'));
  router.get('/api/pages/user/profil', ctx => publicUser(ctx.requireUser(), ctx.state));
  router.get('/api/pages/user', ctx => publicUser(ctx.requireUser(), ctx.state));
  router.get('/api/pages/user/accounts', ctx => accountRows(ctx));
  router.get('/api/pages/user/accountsLauncher', ctx => accountRows(ctx));
  router.put('/api/pages/user/accounts/reorder', ctx => {
    const order = (ctx.body.order || []).map(Number);
    const allowed = ownedAccounts(ctx, true).map(x => x.id);
    if (order.some(x => !allowed.includes(x))) ctx.fail(403, 'Ordre contenant un compte non autorisé');
    ctx.state.setMeta(`accounts-order-${ctx.user.id}`, order);
    return success('Ordre enregistré');
  });
  router.get('/api/pages/user/account/:id/players', ctx => {
    if (!ownedAccounts(ctx, true).some(x => x.id === Number(ctx.params.id))) ctx.fail(403, 'Compte non autorisé');
    return ctx.state.list('players').filter(x => x.account_id === Number(ctx.params.id));
  });
  router.post('/api/user/account', async ctx => {
    const user = ctx.requireUser();
    const name = String(ctx.body.name || ctx.body.account || ctx.body.login || `local${Date.now()}`).trim();
    if (ctx.state.list('gameAccounts').some(x => x.name.toLowerCase() === name.toLowerCase())) ctx.fail(422, 'Ce compte existe déjà', { errors: { name: ['Nom déjà pris'] } });
    const real=ctx.services.emulator?await ctx.services.emulator.createGameAccount({webUserId:user.id,login:name,password:ctx.body.password,pseudo:ctx.body.nickname||name}):null;
    return ctx.state.put('gameAccounts', { id: undefined, user_id: user.id, name, account: name, nickname: ctx.body.nickname || name, email: user.email, deleted: false, auto_renew: false, connected: false, players: [], subscription_end: null, created_at: new Date().toISOString(), local_test: true,...(real?{emulator_account_id:real.id,emulator_login:real.name,emulator_server_id:1,real_emulator:true}:{}) });
  });
  router.post('/api/user/account/update', ctx => {
    const ids = selection(ctx);
    const password = String(ctx.body.password || '');
    if (password.length < 8 || ctx.body.password_confirmation && password !== ctx.body.password_confirmation) ctx.fail(422, 'Vérifie le mot de passe et sa confirmation');
    ctx.state.transaction(() => ids.forEach(id => ctx.state.patch('gameAccounts', id, { password_hash: hashPassword(password) })));
    return success('Mots de passe des comptes de test modifiés');
  });
  router.post('/api/user/account/delete', ctx => {
    const ids = selection(ctx);
    ctx.state.transaction(() => ids.forEach(id => ctx.state.patch('gameAccounts', id, { deleted: true })));
    return success('Comptes masqués dans le launcher local');
  });
  router.post('/api/user/account/restore', ctx => {
    const restored = ownedAccounts(ctx, true).filter(x => x.deleted);
    ctx.state.transaction(() => restored.forEach(x => ctx.state.patch('gameAccounts', x.id, { deleted: false })));
    return restored.map(x => ({ ...x, deleted: false }));
  });
  router.post('/api/user/account/auto-renew', ctx => {
    const ids = selection(ctx);
    ctx.state.transaction(() => ids.forEach(id => ctx.state.patch('gameAccounts', id, { auto_renew: Boolean(ctx.body.enabled) })));
    return success('Renouvellement local enregistré');
  });
  router.post('/api/user/update/avatar', async ctx => {
    const user = ctx.requireUser();
    if (!ctx.files?.length) ctx.fail(422, 'Image manquante');
    const avatar = await ctx.services.saveUpload(ctx.files[0]);
    ctx.state.patch('users', user.id, { avatar });
    return { ...success('Avatar enregistré'), avatar };
  });
  router.post('/api/auth/update-password', ctx => {
    const user = ctx.requireUser();
    const password = ctx.body.password || ctx.body.new_password;
    if (String(password || '').length < 8) ctx.fail(422, 'Mot de passe trop court');
    if (ctx.body.current_password && !checkPassword(ctx.body.current_password, user.password_hash)) ctx.fail(422, 'Mot de passe actuel incorrect');
    ctx.state.patch('users', user.id, { password_hash: hashPassword(password) });
    return success('Mot de passe local enregistré');
  });
  router.post('/api/user/update/:field', ctx => {
    const user = ctx.requireUser();
    const allowed = { pseudo: ['name', 'pseudo'], name: ['name'], question: ['question', 'answer'], 'question-answer': ['question', 'answer'], email: ['email'], notifications: ['notifications'], security: ['allowed_ips', 'ip_allowed'], discord: ['id_discord'] };
    if (ctx.params.field === 'logoutSessions') {
      ctx.state.list('sessions').filter(x => x.user_id === user.id).forEach(x => ctx.state.delete('sessions', x.id));
      return success('Sessions locales révoquées');
    }
    const keys = allowed[ctx.params.field];
    if (!keys) ctx.fail(404, 'Préférence locale inconnue');
    const values = Object.fromEntries(keys.filter(k => k in ctx.body).map(k => [k, ctx.body[k]]));
    if (ctx.params.field === 'pseudo' && ctx.body.pseudo) values.name = String(ctx.body.pseudo);
    if (ctx.params.field === 'notifications') values.notifications = ctx.body.notifications ?? ctx.body;
    ctx.state.patch('users', user.id, values);
    return success('Préférences locales enregistrées');
  });
  router.post('/api/user/subscription', ctx => {
    const user = ctx.requireUser();
    ctx.state.put('pushSubscriptions', { id: user.id, user_id: user.id, subscription: ctx.body, created_at: new Date().toISOString() });
    return success('Abonnement aux notifications de test enregistré');
  });
  router.post('/api/user/subscription/delete', ctx => { ctx.state.delete('pushSubscriptions', ctx.requireUser().id); return success('Abonnement supprimé'); });
  router.post('/api/broadcasting/auth', ctx => {
    const user = ctx.requireUser();
    const channel = String(ctx.body.channel_name || '');
    if (/private-App\.Models\.Login\.User\.(\d+)/.test(channel) && Number(channel.split('.').at(-1)) !== user.id) ctx.fail(403, 'Canal privé non autorisé');
    const value = crypto.createHmac('sha256', ctx.services.pusherSecret).update(`${ctx.body.socket_id}:${channel}`).digest('hex');
    return { auth: `local-test:${value}` };
  });
  router.get('/api/pages/user/redirect/discord', ctx => {
    const user = ctx.requireUser();
    const code = crypto.randomBytes(16).toString('hex');
    ctx.state.put('oauthCodes', { id: code, user_id: user.id, used: false });
    return { url: ctx.url(`/local/discord?code=${code}&user=${user.id}`) };
  });
  router.get('/api/pages/user/callback/discord', ctx => {
    const user = ctx.requireUser();
    const code = ctx.state.get('oauthCodes', ctx.query.code || '');
    if (!code || code.user_id !== user.id || code.used) ctx.fail(422, 'Code OAuth de test invalide');
    ctx.state.patch('oauthCodes', code.id, { used: true });
    ctx.state.patch('users', user.id, { id_discord: `local-${user.id}`, discord: { name: user.name, local_test: true } });
    ctx.services.emit(user.id, 'DiscordCallback', [ctx.url('/local/discord-complete')]);
    return success('Association Discord simulée localement, aucun compte Discord externe lié');
  });
  router.get('/local/session', ctx => {
    const id = Number(ctx.query.user || 1);
    if (![1, 2].includes(id)) ctx.fail(404, 'Compte de démonstration inconnu');
    const user = ctx.state.get('users', id);
    const token=issueSession(ctx.state,id);
    return new Response({token,user:publicUser(user,ctx.state),local_test:true},200,'application/json; charset=utf-8',{'set-cookie':`local_session=${token}; HttpOnly; SameSite=Lax; Path=/`});
  });
  router.get('/local/mailbox', ctx => ({ local_test: true, messages: ctx.state.list('mailbox').map(x => ({ ...x, token: undefined })) }));
  router.get('/local/reset-password', ctx => ctx.html(`<!doctype html><html lang="fr"><meta charset="utf-8"><title>Réinitialisation locale</title><h1>Mot de passe du compte de test</h1><p>Aucun e-mail externe n'est envoyé. Ce formulaire modifie uniquement la base locale de démonstration.</p><form id="reset"><label>Nouveau mot de passe <input type="password" id="password" minlength="8" required autocomplete="new-password"></label><button>Enregistrer</button></form><p id="result"></p><script>document.getElementById('reset').onsubmit=async e=>{e.preventDefault();const query=new URL(location.href).searchParams;const response=await fetch('/api/auth/reset-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:query.get('token'),email:query.get('email'),password:document.getElementById('password').value})});const data=await response.json();document.getElementById('result').textContent=data.message;if(response.ok)document.getElementById('reset').hidden=true;};</script></html>`));
  router.get('/local/discord', ctx => ctx.html(`<!doctype html><meta charset="utf-8"><title>Discord en test local</title><h1>TEST LOCAL</h1><p>Aucun compte Discord réel n'est utilisé. L'association de test se valide dans ton API locale.</p><button id="confirm">Confirmer l'association de test</button><p id="result"></p><script>document.getElementById('confirm').onclick=async()=>{const query=new URL(location.href).searchParams;const s=await fetch('/local/session?user='+encodeURIComponent(query.get('user')||'1')).then(r=>r.json());const r=await fetch('/api/pages/user/callback/discord?code='+encodeURIComponent(query.get('code')),{headers:{Authorization:'Bearer '+s.token}}).then(r=>r.json());document.getElementById('result').textContent=r.message;};</script>`));
}
