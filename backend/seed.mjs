import crypto from 'node:crypto';

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return salt + ':' + crypto.scryptSync(String(password), salt, 32).toString('hex');
}
export function checkPassword(password, encoded) {
  if (!encoded || !encoded.includes(':')) return false;
  const [salt, hash] = encoded.split(':');
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(String(password), salt, 32);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
export function seedCore(state) {
  if (state.meta('coreSeeded')) return;
  state.transaction(() => {
    for (const [id, name, email, role_id] of [[1, 'Administrateur local', 'admin@local.test', 4], [2, 'Joueur local', 'joueur@local.test', 0]]) {
      state.put('users', {
        id, name, email, role_id, password_hash: hashPassword('LocalTest!2026'), beta: 2, rush: 1,
        avatar: null, email_verified_at: new Date().toISOString(), id_discord: 0,
        question: 'Compte de test local', votes: 12, votes_month: 4, tickets: 10,
        kamas: 10000000, ogrines: 100000, ogrines_linked: 1000, arcanes: 20000, jetons: 200,
        max_level: 200, vip_level: 2, first_order: true, pending_promo_code: null,
        notifications: { launcher: true, vote: true, battlepass: true, email: false },
        sessions: [], created_at: new Date().toISOString(), local_test: true
      });
      state.put('gameAccounts', {
        id, user_id: id, name: `local${id}`, account: `local${id}`, nickname: `Compte local ${id}`,
        email, auto_renew: false, deleted: false, connected: false, players: [],
        created_at: new Date().toISOString(), subscription_end: '2030-01-01T00:00:00Z',
        subscription: '2030-01-01T00:00:00Z', subscribed_until: '2030-01-01T00:00:00Z',
        bonus_pack: true, bonus: true, points: 0
      });
      for (let index = 0; index < 3; index++) {
        const playerId = (id - 1) * 3 + index + 1;
        state.put('players', {
          id: playerId, user_id: id, account_id: id, server_id: 5, serverId: 5,
          name: ['Astra', 'Brume', 'Cendre', 'Dalia', 'Echo', 'Flamme'][playerId - 1] + '-Local',
          level: 200 - index * 20, lvl: 200 - index * 20, class_id: index + 1, classe: index + 1,
          sex: index % 2, sexe: index % 2, colors: ['#24496e', '#b98a35', '#d8e3ee'],
          color1: 2378094, color2: 12159541, color3: 14214126,
          kamas: 5000000, experience: 1000000000 - index * 10000000, xp: 1000000000 - index * 10000000,
          alignement: 0, alignement_grade: 0, guild: null, equipment: [], items: [],
          isInSell: 0, price: 100, online: false, created_at: new Date().toISOString(), local_test: true
        });
      }
    }
    state.setMeta('coreSeeded', true);
  });
}
export function publicUser(user, state) {
  const { password_hash, ...safe } = user;
  return { ...safe, avatar: user.avatar?.startsWith('http://127.0.0.1:')?new URL(user.avatar).pathname.split('/').at(-1):(user.avatar||'local-default.png'), kamas: typeof user.kamas === 'number' ? { 5: user.kamas } : user.kamas, kamas_total: typeof user.kamas === 'number' ? user.kamas : Object.values(user.kamas || {}).reduce((a,b)=>a+Number(b||0),0), accounts: state.list('gameAccounts').filter(x => x.user_id === user.id && !x.deleted).map(({password_hash, ...account})=>account), local_test: true };
}
