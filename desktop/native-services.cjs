'use strict';
// Local development services. Importing this module opens no port and launches nothing.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const HOST = '127.0.0.1';
const BACKEND = 'http://127.0.0.1:4318';
const DEFAULT_PORTS = Object.freeze({ data: 8159, zaap: 31559 });
function fail(code) { throw Object.assign(new Error(code), { code }); }
function normalized(file) { return String(file || '').replace(/\//g, '\\').toLowerCase(); }
function inside(file, root) { const rel = path.relative(root, file); return rel === '' || rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); }
async function ownedPath(root, relative) {
  if (!relative || /\\|:|\0/.test(relative) || relative.split('/').some(p => !p || p === '.' || p === '..' || /[ .]$/.test(p))) fail('invalid_asset_path');
  const target = path.join(root, relative); if (!inside(target, root)) fail('path_not_owned');
  let current = root;
  for (const part of path.relative(root, target).split(path.sep)) { current = path.join(current, part); if ((await fsp.lstat(current)).isSymbolicLink()) fail('symlink_not_allowed'); }
  return target;
}
async function requestLauncherTicket({ accountId, webToken, timeout = 10000 }) {
  if (!Number.isSafeInteger(accountId) || accountId < 1 || typeof webToken !== 'string' || !webToken || webToken.length > 8192 || /[\r\n]/.test(webToken)) fail('local_authentication_required');
  const body = Buffer.from(JSON.stringify({ account_id: accountId }));
  const response = await new Promise((resolve, reject) => {
    const req = http.request(BACKEND + '/api/local/emulator/launcher-ticket', { method: 'POST', timeout, headers: { authorization: 'Bearer ' + webToken, 'content-type': 'application/json', 'content-length': body.length } }, resolve);
    req.on('timeout', () => req.destroy(Object.assign(new Error('ticket_timeout'), { code: 'ticket_timeout' }))); req.on('error', reject); req.end(body);
  });
  const chunks = []; let size = 0;
  for await (const chunk of response) { size += chunk.length; if (size > 65536) { response.destroy(); fail('invalid_ticket_response'); } chunks.push(chunk); }
  if (response.statusCode !== 200) fail('ticket_request_rejected_' + response.statusCode);
  let result; try { result = JSON.parse(Buffer.concat(chunks)); } catch { fail('invalid_ticket_response'); }
  return validateTicket(result);
}
function validateTicket(result, now = Date.now()) {
  if (!result || !/^[0-9a-f]{32}$/.test(result.token) || !Number.isSafeInteger(result.accountId) || result.accountId < 1 || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= now || result.expiresAt > now + 35000 || result.real_emulator !== true) fail('invalid_ticket_response');
  return result;
}
async function lookupWindowsPeer(socket) {
  if (process.platform !== 'win32') fail('windows_peer_identity_required');
  const local = Number(socket.localPort), remote = Number(socket.remotePort);
  if (!Number.isInteger(local) || !Number.isInteger(remote)) fail('invalid_peer');
  const script = "$ErrorActionPreference='Stop';$rows=@(Get-NetTCPConnection -State Established -LocalPort " + remote + ' -RemotePort ' + local + " -ErrorAction SilentlyContinue|Where-Object {$_.LocalAddress -eq '127.0.0.1' -and $_.RemoteAddress -eq '127.0.0.1'});$ids=@($rows.OwningProcess|Sort-Object -Unique);if($ids.Count -ne 1){throw 'peer_identity_unavailable'};$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ids[0]);[pscustomobject]@{pid=$p.ProcessId;executable=$p.ExecutablePath}|ConvertTo-Json -Compress";
  try { const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000, maxBuffer: 65536 }); return JSON.parse(stdout.replace(/^\uFEFF/, '')); }
  catch { fail('peer_identity_unavailable'); }
}
function createNativeServices({ projectRoot, ports = DEFAULT_PORTS, lookupPeer = lookupWindowsPeer, ticketProvider = requestLauncherTicket, now = Date.now } = {}) {
  const root = fs.realpathSync(projectRoot), clientRoot = path.join(root, 'client/Abrak/Retro');
  if (!fs.statSync(path.join(root, '.abrak-local-project')).isFile()) fail('project_marker_required');
  for (const port of [ports.data, ports.zaap]) if (!Number.isInteger(port) || port < 0 || port > 65535) fail('invalid_service_port');
  const launches = new Map(), connections = new Set(), events = []; let assetServer = null, zaapServer = null, manifestCache = null, starting = null;
  function record(type, fields = {}) { events.push({ at: now(), type, ...fields }); if (events.length > 40) events.shift(); }
  function status() { return { ready: !!assetServer?.listening && !!zaapServer?.listening, host: HOST, dataPort: assetServer?.address()?.port || ports.data, zaapPort: zaapServer?.address()?.port || ports.zaap, pid: process.pid, projectRoot: root, clientRoot, pendingLaunches: launches.size, events: events.slice(), nativeAuthenticationVerified: false }; }
  async function manifest() {
    const filename = await ownedPath(root, 'desktop/client-manifest.json'), stat = await fsp.stat(filename), version = stat.mtimeMs + ':' + stat.size;
    if (manifestCache?.version === version) return manifestCache.value;
    const value = JSON.parse(await fsp.readFile(filename, 'utf8')); manifestCache = { version, value }; return value;
  }
  async function assetRequest(req, res) {
    try {
      if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) { res.writeHead(403).end(); return; }
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { allow: 'GET, HEAD' }).end(); return; }
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/__abrak_native/health') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(status())); return; }
      if (url.pathname === '/crossdomain.xml') { res.writeHead(200, { 'content-type': 'application/xml' }).end('<?xml version="1.0"?><cross-domain-policy><allow-access-from domain="*" secure="false"/></cross-domain-policy>'); return; }
      const relative = decodeURIComponent(url.pathname).replace(/^\//, '');
      if (!relative.startsWith('data/') && !relative.startsWith('datatemporis/')) fail('asset_not_allowed');
      const key = 'resources/app/retroclient/' + relative, entry = (await manifest())[key];
      if (!entry || !Number.isSafeInteger(entry.size) || entry.size < 0) fail('asset_not_manifested');
      const target = await ownedPath(root, 'client/Abrak/Retro/' + key), stat = await fsp.stat(target);
      if (!stat.isFile() || stat.size !== entry.size) fail('asset_integrity_mismatch');
      const type = /\.swf$/i.test(target) ? 'application/x-shockwave-flash' : /\.xml$/i.test(target) ? 'application/xml' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'cache-control': 'no-store' });
      if (req.method === 'HEAD') { res.end(); return; }
      const stream = fs.createReadStream(target); stream.on('error', () => res.destroy()); stream.pipe(res);
    } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
  }
  function armLaunch({ accountId, webToken, executable, launchLifetime = 120000 }) {
    if (!Number.isSafeInteger(accountId) || accountId < 1 || typeof webToken !== 'string' || !webToken || webToken.length > 8192 || /[\r\n]/.test(webToken)) fail('local_authentication_required');
    if (!inside(path.resolve(executable), clientRoot) || path.resolve(executable) !== path.join(clientRoot, 'resources/app/retroclient/Abrak.exe')) fail('native_executable_not_owned');
    if (!status().ready) fail('native_services_not_ready');
    for (const [id, launch] of launches) if (launch.expiresAt < now()) launches.delete(id);
    if (launches.size >= 16) fail('too_many_native_launches');
    const id = crypto.randomUUID(); launches.set(id, { id, accountId, webToken, executable, pid: null, expiresAt: now() + Math.min(120000, launchLifetime), requests: 0 }); record('launch-armed', { accountId }); return id;
  }
  function bindPID(id, pid) { const launch = launches.get(id); if (!launch || launch.pid || !Number.isInteger(pid) || pid < 1) fail('invalid_native_pid'); launch.pid = pid; record('launch-bound', { accountId: launch.accountId, pid }); }
  function cancelLaunch(id) { launches.delete(id); for (const socket of connections) if (socket.launchId === id) socket.destroy(); }
  async function launchFor(socket) {
    const peer = await lookupPeer(socket);
    for (let attempt = 0; attempt < 50; attempt++) {
      const launch = [...launches.values()].find(item => item.pid === peer.pid && normalized(item.executable) === normalized(peer.executable) && item.expiresAt > now());
      if (launch) return launch;
      if (![...launches.values()].some(item => !item.pid && item.expiresAt > now())) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    fail('native_peer_not_authorized');
  }
  function nativeConnection(socket) {
    if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(socket.remoteAddress)) { socket.destroy(); return; }
    connections.add(socket); socket.on('close', () => connections.delete(socket)); socket.on('error', () => {}); socket.setTimeout(60000, () => socket.destroy());
    let buffer = Buffer.alloc(0), queue = Promise.resolve(), gameSession = null, launch = null, requests = 0;
    async function frame(bytes) {
      if (bytes.some(b => b < 32 && ![9, 10, 13].includes(b) || b > 126)) fail('invalid_native_frame');
      const text = bytes.toString('ascii').trim(); let response;
      if (text === '<policy-file-request/>') response = '<?xml version="1.0"?><cross-domain-policy><allow-access-from domain="*" to-ports="' + status().zaapPort + '" /></cross-domain-policy>';
      else if (text === 'connect retro main -1 -1' && !gameSession) {
        launch = await launchFor(socket); socket.launchId = launch.id; gameSession = crypto.randomBytes(16).toString('hex'); response = 'connect ' + gameSession; record('zaap-connected', { accountId: launch.accountId, pid: launch.pid });
      } else if (gameSession && text === 'auth_getGameToken ' + gameSession + ' 101') {
        if (!launches.has(launch.id) || launch.expiresAt <= now() || ++requests > 3 || ++launch.requests > 6) fail('native_session_expired');
        const ticket = validateTicket(await ticketProvider({ accountId: launch.accountId, webToken: launch.webToken }), now());
        response = 'auth_getGameToken ' + ticket.token; record('ticket-issued', { accountId: launch.accountId, emulatorAccountId: ticket.accountId, pid: launch.pid, expiresAt: ticket.expiresAt });
      } else fail('unsupported_native_frame');
      if (!socket.destroyed) socket.write(response + '\0');
    }
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 8192) { record('native-rejected', { reason: 'frame_too_large' }); socket.destroy(); return; }
      let separator;
      while ((separator = buffer.indexOf(0)) >= 0) {
        const next = buffer.subarray(0, separator); buffer = buffer.subarray(separator + 1);
        queue = queue.then(() => frame(next)).catch(error => { record('native-rejected', { reason: error.code || 'native_protocol_error' }); socket.destroy(); });
      }
    });
  }
  async function start() {
    if (status().ready) return status(); if (starting) return starting;
    starting = (async () => {
      assetServer = http.createServer((req, res) => { void assetRequest(req, res); }); zaapServer = net.createServer(nativeConnection);
      async function listen(server, port) { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, HOST, resolve); }); server.on('error', () => record('service-error')); }
      try { await listen(assetServer, ports.data); await listen(zaapServer, ports.zaap); record('services-ready'); return status(); }
      catch (error) { await close(); throw error; }
      finally { starting = null; }
    })();
    return starting;
  }
  async function close() {
    for (const socket of connections) socket.destroy(); launches.clear();
    await Promise.all([assetServer, zaapServer].filter(Boolean).map(server => new Promise(resolve => server.listening ? server.close(resolve) : resolve())));
    assetServer = null; zaapServer = null;
  }
  return { start, close, status, armLaunch, bindPID, cancelLaunch };
}
module.exports = { createNativeServices, requestLauncherTicket, validateTicket, DEFAULT_PORTS };
