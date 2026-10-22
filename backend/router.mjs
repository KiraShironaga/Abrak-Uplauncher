export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
export class Response {
  constructor(body, status = 200, type = 'application/json; charset=utf-8', headers = {}) {
    this.body = body; this.status = status; this.type = type; this.headers = headers;
  }
}
function compile(pattern) {
  if (pattern instanceof RegExp) return { regex: pattern, names: [], score: -10 };
  const names = [];
  let score = 0;
  const parts = pattern.split('/').filter(Boolean).map(part => {
    if (part.startsWith(':')) {
      const optional = part.endsWith('?');
      names.push(part.slice(1, optional ? -1 : undefined));
      return optional ? '(?:/([^/]+))?' : '/([^/]+)';
    }
    score += 10;
    return '/' + part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return { regex: new RegExp('^' + parts.join('') + '/?$'), names, score };
}
export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler, options = {}) {
    this.routes.push({ method: method.toUpperCase(), pattern: String(pattern), ...compile(pattern), handler, options });
    this.routes.sort((a, b) => b.score - a.score);
    return this;
  }
  get(...args) { return this.add('GET', ...args); }
  post(...args) { return this.add('POST', ...args); }
  put(...args) { return this.add('PUT', ...args); }
  patch(...args) { return this.add('PATCH', ...args); }
  delete(...args) { return this.add('DELETE', ...args); }
  inventory() { return this.routes.map(x => ({ method: x.method, path: x.pattern, ...x.options })); }
  async dispatch(method, pathname, baseContext) {
    for (const route of this.routes) {
      if (route.method !== method && !(method === 'HEAD' && route.method === 'GET')) continue;
      const match = route.regex.exec(pathname);
      if (!match) continue;
      const params = Object.fromEntries(route.names.map((name, index) => [name, decodeURIComponent(match[index + 1] || '')]));
      if (!route.names.length) match.slice(1).forEach((value, index) => { params[index] = value; });
      if (match.groups) Object.assign(params, match.groups);
      const ctx = { ...baseContext, params, match, route: route.pattern };
      ctx.requireUser = () => { if (!ctx.user) throw new HttpError(401, 'Connexion locale requise'); return ctx.user; };
      ctx.requireAdmin = () => { const user = ctx.requireUser(); if (!(user.role_id > 0)) throw new HttpError(403, 'Droits administrateur requis'); return user; };
      ctx.fail = (status, message, extra) => { throw new HttpError(status, message, extra); };
      ctx.json = (body, status = 200) => new Response(body, status);
      ctx.html = (body, status = 200) => new Response(body, status, 'text/html; charset=utf-8');
      ctx.redirect = url => new Response('', 302, 'text/plain', { location: url });
      ctx.url = relative => new URL(relative, ctx.services.origin).href;
      if (route.options.auth) ctx.requireUser();
      if (route.options.admin || pathname.startsWith('/api/admin/')) ctx.requireAdmin();
      const result = await route.handler(ctx);
      if (result === undefined) throw new HttpError(500, `La route locale ${route.pattern} n'a pas produit de résultat`);
      return result instanceof Response ? result : new Response(result);
    }
    throw new HttpError(404, 'Route locale non implémentée', { method, path: pathname });
  }
}
