'use strict';
// Owned local-client adapter. Loading this module never starts the native client.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { Transform, Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const BACKEND = 'http://127.0.0.1:4318';
const GAME_DIRS = { main: 'Retro', beta: 'Beta', rush: 'Rush' };
const SHA1 = /^[a-f0-9]{40}$/;
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ n >>> 1 : n >>> 1;
  return n >>> 0;
});
function crcUpdate(crc, bytes) { for (const b of bytes) crc = crcTable[(crc ^ b) & 255] ^ crc >>> 8; return crc >>> 0; }
function fail(code, detail = '') { const error = new Error(detail || code); error.code = code; throw error; }
function errorResult(error) { return { code: error?.code || 'local_client_error', detail: String(error?.message || error).slice(0, 400) }; }
function within(file, root) { const relative = path.relative(root, file); return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); }
function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes(':')) fail('invalid_client_path');
  const parts = value.replace(/\\/g, '/').split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[ .]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) fail('invalid_client_path');
  return parts.join('/');
}
function localURL(value, backendOnly = true) {
  let url; try { url = new URL(value); } catch { fail('invalid_url'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('invalid_url');
  if (backendOnly ? url.origin !== BACKEND : !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) fail('external_network_disabled');
  return url;
}
function isLoopbackRequest(value) {
  try { const u = new URL(value); return ['file:', 'data:', 'blob:', 'about:', 'devtools:'].includes(u.protocol) || ['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname); } catch { return false; }
}
function navigationDecision(value, type = 'window') {
  let url; try { url = localURL(value, false); } catch { return { allow: false, external: null }; }
  const wiki = url.origin === BACKEND && /^\/local\/wiki(?:\/|$)/.test(url.pathname);
  if (type === 'webview') return { allow: wiki, external: null };
  const app = url.origin === BACKEND && ['/', '/index.html'].includes(url.pathname);
  return { allow: app, external: app ? null : url.href };
}
function clientSettings(value) {
  if (!value || value.gameLoginHost !== '127.0.0.1' || !Number.isInteger(value.gameLoginPort) || value.gameLoginPort < 1 || value.gameLoginPort > 65535 || !Number.isInteger(value.zaapBridgePort) || value.zaapBridgePort < 1 || value.zaapBridgePort > 65535) fail('invalid_client_configuration');
  const data = localURL(value.clientDataOrigin, false);
  if (data.hostname !== '127.0.0.1' || data.search || data.hash) fail('invalid_client_configuration');
  return { gameLoginHost: value.gameLoginHost, gameLoginPort: value.gameLoginPort, clientDataOrigin: data.href.replace(/\/$/, ''), zaapBridgePort: value.zaapBridgePort };
}
function xmlAttributes(text) {
  const result = Object.create(null);
  for (const match of text.matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/g)) result[match[1].toLowerCase()] = match[3];
  return result;
}
function inspectClientXML(xml, configuration) {
  const settings = clientSettings(configuration);
  if (typeof xml !== 'string' || /<!DOCTYPE|<!ENTITY/i.test(xml)) return false;
  const connections = [...xml.matchAll(/<connserver\b([^>]*)>/gi)].map(m => xmlAttributes(m[1]));
  const confs = [...xml.matchAll(/<conf\b([^>]*)>/gi)].map(m => xmlAttributes(m[1]));
  const data = [...xml.matchAll(/<dataserver\b([^>]*)>/gi)].map(m => xmlAttributes(m[1]));
  return connections.length > 0 && connections.every(c => c.ip === settings.gameLoginHost && c.port === String(settings.gameLoginPort))
    && confs.length > 0 && confs.every(c => c.zaapconnectport === String(settings.zaapBridgePort))
    && data.length > 0 && data.every(d => d.type === 'local' ? typeof d.url === 'string' && !/^[\\/]|:|(?:^|[\\/])\.\.(?:[\\/]|$)/.test(d.url) : typeof d.url === 'string' && d.url.startsWith(settings.clientDataOrigin + '/'));
}
async function noSymlinks(file, boundary) {
  if (!within(file, boundary)) fail('path_not_owned');
  let current = boundary;
  for (const part of ['', ...path.relative(boundary, file).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    try { if ((await fsp.lstat(current)).isSymbolicLink()) fail('symlink_not_allowed'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return file;
}
async function fileHash(file, algorithm = 'sha1') {
  const hash = crypto.createHash(algorithm);
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function request(value, redirects = 0) {
  const url = localURL(value);
  if (redirects > 3) fail('too_many_redirects');
  const response = await new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).get(url, { timeout: 30000, headers: { accept: '*/*' } }, resolve);
    req.on('timeout', () => req.destroy(Object.assign(new Error('Local server timeout'), { code: 'network_error' })));
    req.on('error', reject);
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    response.resume(); return request(new URL(response.headers.location, url).href, redirects + 1);
  }
  if (response.statusCode !== 200) { response.resume(); fail('network_error', `Local HTTP ${response.statusCode}`); }
  return response;
}
async function jsonRequest(url, requestImpl = request) {
  localURL(url); const response = await requestImpl(url); let size = 0; const chunks = [];
  for await (const chunk of response) { size += chunk.length; if (size > 48 * 1024 * 1024) { response.destroy(); fail('manifest_too_large'); } chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function validateManifest(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length > 100000) fail('invalid_manifest');
  const seen = new Set();
  for (const [key, entry] of Object.entries(value)) {
    const relative = safeRelative(key), identity = relative.toLowerCase();
    if (seen.has(identity) || !entry || !Number.isSafeInteger(entry.size) || entry.size < 0 || !SHA1.test(entry.hash)) fail('invalid_manifest');
    seen.add(identity); localURL(entry.fileUrl);
  }
  return value;
}
async function downloadFile(url, destination, expected, progress, requestImpl = request) {
  localURL(url); const response = await requestImpl(url), partial = destination + '.part-' + crypto.randomUUID();
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const hash = crypto.createHash('sha1'); let received = 0;
  const validator = new Transform({ transform(chunk, encoding, callback) {
    received += chunk.length; hash.update(chunk);
    if (expected && received > expected.size) return callback(Object.assign(new Error('Size exceeded'), { code: 'integrity_error' }));
    progress?.(received); callback(null, chunk);
  } });
  try {
    await pipeline(response, validator, fs.createWriteStream(partial, { flags: 'wx' }));
    const digest = hash.digest('hex');
    if (expected && (received !== expected.size || digest !== expected.hash)) fail('integrity_error', 'Downloaded bytes do not match manifest');
    await fsp.rename(partial, destination); return { size: received, hash: digest };
  } catch (error) { await fsp.rm(partial, { force: true }).catch(() => {}); throw error; }
}

// ZIP32/ZIP64 central-directory preflight. Only stored/deflate ordinary files are accepted.
async function zipEntries(filename) {
  const handle = await fsp.open(filename, 'r');
  async function read(position, length) { const b = Buffer.alloc(length); const result = await handle.read(b, 0, length, position); if (result.bytesRead !== length) fail('invalid_zip'); return b; }
  function safe64(value) { if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('invalid_zip'); return Number(value); }
  try {
    const size = (await handle.stat()).size, length = Math.min(size, 65557), tail = await read(size - length, length);
    let eocd = -1;
    for (let p = tail.length - 22; p >= 0; p--) if (tail.readUInt32LE(p) === 0x06054b50 && p + 22 + tail.readUInt16LE(p + 20) === tail.length) { eocd = p; break; }
    if (eocd < 0 || tail.readUInt16LE(eocd + 4) || tail.readUInt16LE(eocd + 6)) fail('invalid_zip');
    let count = tail.readUInt16LE(eocd + 10), centralSize = tail.readUInt32LE(eocd + 12), centralOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      const locator = await read(size - length + eocd - 20, 20);
      if (locator.readUInt32LE(0) !== 0x07064b50 || locator.readUInt32LE(4) || locator.readUInt32LE(16) !== 1) fail('invalid_zip');
      const z = await read(safe64(locator.readBigUInt64LE(8)), 56);
      if (z.readUInt32LE(0) !== 0x06064b50 || z.readUInt32LE(16) || z.readUInt32LE(20)) fail('invalid_zip');
      count = safe64(z.readBigUInt64LE(32)); centralSize = safe64(z.readBigUInt64LE(40)); centralOffset = safe64(z.readBigUInt64LE(48));
    }
    if (count > 100000 || centralSize > 64 * 1024 * 1024 || centralOffset + centralSize > size) fail('invalid_zip');
    const central = await read(centralOffset, centralSize), entries = [], names = new Set(); let cursor = 0;
    for (let n = 0; n < count; n++) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== 0x02014b50) fail('invalid_zip');
      const p = cursor, flags = central.readUInt16LE(p + 8), method = central.readUInt16LE(p + 10), nameLength = central.readUInt16LE(p + 28), extraLength = central.readUInt16LE(p + 30), commentLength = central.readUInt16LE(p + 32);
      cursor += 46 + nameLength + extraLength + commentLength;
      if (cursor > central.length || flags & 1 || ![0, 8].includes(method) || central.readUInt16LE(p + 34)) fail('unsupported_zip');
      const nameBytes = central.subarray(p + 46, p + 46 + nameLength);
      if (!(flags & 0x800) && [...nameBytes].some(b => b > 127)) fail('unsupported_zip_name');
      const rawName = new TextDecoder('utf8', { fatal: true }).decode(nameBytes), directory = rawName.endsWith('/'), name = safeRelative(directory ? rawName.slice(0, -1) : rawName);
      const identity = name.toLowerCase(); if (names.has(identity)) fail('duplicate_zip_path'); names.add(identity);
      const kind = central.readUInt32LE(p + 38) >>> 16 & 0xf000;
      if (kind && kind !== 0x8000 && kind !== 0x4000) fail('unsupported_zip_link');
      let compressed = central.readUInt32LE(p + 20), uncompressed = central.readUInt32LE(p + 24), offset = central.readUInt32LE(p + 42);
      if ([compressed, uncompressed, offset].includes(0xffffffff)) {
        const end = p + 46 + nameLength + extraLength; let ep = p + 46 + nameLength, found = false;
        while (ep + 4 <= end) {
          const id = central.readUInt16LE(ep), el = central.readUInt16LE(ep + 2); ep += 4; if (ep + el > end) fail('invalid_zip');
          if (id === 1) { let q = ep; const next = () => { if (q + 8 > ep + el) fail('invalid_zip'); const v = safe64(central.readBigUInt64LE(q)); q += 8; return v; }; if (uncompressed === 0xffffffff) uncompressed = next(); if (compressed === 0xffffffff) compressed = next(); if (offset === 0xffffffff) offset = next(); found = true; break; } ep += el;
        }
        if (!found) fail('invalid_zip');
      }
      const local = await read(offset, 30);
      if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(8) !== method) fail('invalid_zip');
      const localNameLength = local.readUInt16LE(26), localExtraLength = local.readUInt16LE(28), localName = await read(offset + 30, localNameLength);
      if (!localName.equals(nameBytes)) fail('invalid_zip');
      const start = offset + 30 + localNameLength + localExtraLength;
      if (start + compressed > centralOffset) fail('invalid_zip');
      entries.push({ name, directory, method, start, compressed, size: uncompressed, crc: central.readUInt32LE(p + 16) });
    }
    if (cursor !== central.length) fail('invalid_zip'); return entries;
  } finally { await handle.close(); }
}
async function extractZip(filename, staging, entries) {
  for (const entry of entries) {
    const destination = path.join(staging, entry.name);
    await noSymlinks(destination, staging);
    if (entry.directory) { await fsp.mkdir(destination, { recursive: true }); continue; }
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    let count = 0, crc = 0xffffffff;
    const validator = new Transform({ transform(chunk, encoding, callback) { count += chunk.length; crc = crcUpdate(crc, chunk); if (count > entry.size) return callback(Object.assign(new Error('ZIP size exceeded'), { code: 'integrity_error' })); callback(null, chunk); } });
    const input = entry.compressed ? fs.createReadStream(filename, { start: entry.start, end: entry.start + entry.compressed - 1 }) : Readable.from([]);
    await pipeline(...[input, entry.method === 8 ? zlib.createInflateRaw() : null, validator, fs.createWriteStream(destination, { flags: 'wx' })].filter(Boolean));
    if (count !== entry.size || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) fail('integrity_error', `ZIP CRC/size mismatch: ${entry.name}`);
  }
}

function createRuntime({ projectRoot, electron, spawnImpl = spawn, requestImpl = request, nativeServicesFactory }) {
  const root = fs.realpathSync(projectRoot), clientBase = path.join(root, 'client', 'Abrak');
  const profile = electron.app.getPath('userData'), processes = new Map(), expectedFiles = new Map(), zipManifests = new Map();
  let nativeServices = null;
  if (!within(path.resolve(profile), root)) fail('profile_not_owned', 'Launch with the project-owned --user-data-dir profile');
  let profileAncestor = root;
  for (const part of path.relative(root, profile).split(path.sep).filter(Boolean)) {
    profileAncestor = path.join(profileAncestor, part);
    if (fs.existsSync(profileAncestor) && fs.lstatSync(profileAncestor).isSymbolicLink()) fail('profile_not_owned');
  }
  const gameRoot = game => path.join(clientBase, GAME_DIRS[game] || GAME_DIRS.main);
  const nativeRelative = 'resources/app/retroclient/Abrak.exe';
  async function owned(value, allowRoot = true) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) fail('path_not_owned');
    const resolved = path.resolve(value), permitted = Object.keys(GAME_DIRS).some(game => within(resolved, gameRoot(game)) && (allowRoot || resolved !== gameRoot(game)));
    if (!permitted) fail('path_not_owned'); return noSymlinks(resolved, root);
  }
  function event(channel, payload) { for (const w of electron.BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload); }
  function services() {
    if (!nativeServices) {
      const factory = nativeServicesFactory || require(path.join(root, 'desktop/native-services.cjs')).createNativeServices;
      nativeServices = factory({ projectRoot: root });
    }
    return nativeServices;
  }
  function status() { return [...processes.values()].map(p => ({ pid: p.child.pid, id: p.account || p.child.pid, game: 'main', connected: false, processRunning: true, state: 'running-zaap-ticket', authMode: 'zaap-ticket', executable: p.executable, launchedAt: p.launchedAt })); }
  function requireStopped() { if (processes.size) fail('closeDofus', 'Close this project native client before updating its files'); }
  async function currentState() {
    const installRoot = gameRoot('main'), executable = path.join(installRoot, nativeRelative), configPath = path.join(installRoot, 'resources/app/retroclient/config.xml');
    let config = ''; try { config = await fsp.readFile(configPath, 'utf8'); } catch {}
    let clientTargets = null, configurationError = null, gameConfigured = false;
    try {
      const settingsPath = await noSymlinks(path.join(root, 'desktop/client-config.json'), root);
      clientTargets = clientSettings(JSON.parse(await fsp.readFile(settingsPath, 'utf8')));
      gameConfigured = inspectClientXML(config, clientTargets);
    } catch (error) { configurationError = errorResult(error); }
    let copyComplete = false;
    try { const copy = JSON.parse(await fsp.readFile(path.join(root, 'desktop/client-copy.json'), 'utf8')); copyComplete = copy.files > 0 && path.resolve(copy.destination) === installRoot && fs.existsSync(path.join(root, 'desktop/client-manifest.json')); } catch {}
    const nativeClientReady = copyComplete && fs.existsSync(executable) && fs.existsSync(path.join(installRoot, 'resources/app/retroclient/loader.swf'));
    const cloneActivated = gameConfigured && clientTargets.gameLoginPort === 11419 && clientTargets.clientDataOrigin === 'http://127.0.0.1:8159' && clientTargets.zaapBridgePort === 31559;
    return { mode: 'local', projectRoot: root, profilePath: profile, backendOrigin: BACKEND, clientRoot: installRoot, nativeExecutable: executable, copyComplete, nativeClientReady, gameConfigured, clientTargets, configurationError, cloneActivated, nativeServices: nativeServices?.status() || { ready: false, dataPort: 8159, zaapPort: 31559 }, manualLogin: false, authMode: 'zaap-ticket', clientVersion: 1, platform: 'win', networkPolicy: 'loopback-only-renderer', nativeNetworkPolicy: 'Config XML points to loopback; no OS network sandbox for native Flash is claimed', bridgeUsed: false, processes: status(), gameplayVerified: false, games: { main: { id: 'main', path: installRoot, installed: nativeClientReady && gameConfigured, arch: 32, pack: 'remastered', version: 1, remote_version: 1 }, beta: { id: 'beta', configured: false }, rush: { id: 'rush', configured: false } } };
  }
  const handlers = {
    'get-local-runtime-state': async () => currentState(),
    'start-local-native-services': async () => services().start(),
    'get-path': async (e, game) => gameRoot(game),
    'get-platform': async () => 'win',
    'get-game-status': async () => processes.size,
    'get-clients': async () => status(),
    'get-token': async () => null,
    'open-folder': async (e, previous, game) => gameRoot(game),
    'openGameDirectory': async (e, value) => electron.shell.openPath(await owned(value)),
    'open-link': async (e, value) => { const u = localURL(value); return electron.shell.openExternal(u.href); },
    'openGame': async (e, arch, value, options = {}) => {
      const installRoot = await owned(value), current = await currentState();
      if (installRoot !== gameRoot('main') || Number(arch) !== 32 || options.currentGame && options.currentGame !== 'main') fail('client_not_configured');
      if (!current.nativeClientReady || !current.gameConfigured) fail('local_client_not_ready');
      if (!current.cloneActivated) fail('local_clone_not_activated');
      const selected = options.account ? [options.account] : Array.isArray(options.accounts) ? options.accounts : [];
      const accounts = [...new Set(selected.map(raw => Number(raw && typeof raw === 'object' ? raw.id : raw)))];
      if (!accounts.length || accounts.length > 16 || accounts.some(id => !Number.isSafeInteger(id) || id < 1)) fail('local_game_account_required');
      if (typeof options.token !== 'string' || !options.token || options.token.length > 8192 || /[\r\n]/.test(options.token)) fail('local_authentication_required');
      const executable = await owned(path.join(installRoot, nativeRelative), false), cwd = path.dirname(executable);
      const childProfile = path.join(profile, 'native-client');
      for (const part of ['Roaming', 'Local', 'Temp']) await fsp.mkdir(path.join(childProfile, part), { recursive: true });
      const native = services(); await native.start(); const results = [];
      const compatibility = [process.env.__COMPAT_LAYER || '', 'RunAsInvoker'].join(' ').trim();
      for (const account of accounts) {
        const launchId = native.armLaunch({ accountId: account, webToken: options.token, executable }); let child;
        try {
          child = spawnImpl(executable, [], { cwd, windowsHide: false, detached: false, stdio: 'ignore', env: { ...process.env, __COMPAT_LAYER: compatibility, APPDATA: path.join(childProfile, 'Roaming'), LOCALAPPDATA: path.join(childProfile, 'Local'), TEMP: path.join(childProfile, 'Temp'), TMP: path.join(childProfile, 'Temp') } });
          await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
          native.bindPID(launchId, child.pid);
        } catch (error) { native.cancelLaunch(launchId); throw error; }
        const record = { child, executable, account, launchId, launchedAt: Date.now() }; processes.set(child.pid, record);
        child.once('exit', () => { native.cancelLaunch(launchId); processes.delete(child.pid); event('gameStatus', processes.size); event('localClientProcess', status()); fsp.writeFile(path.join(profile, 'local-client-processes.json'), JSON.stringify(status(), null, 2)).catch(() => {}); });
        child.unref?.(); results.push({ pid: child.pid, accountId: account, executable });
      }
      await fsp.writeFile(path.join(profile, 'local-client-processes.json'), JSON.stringify(status(), null, 2));
      event('gameStatus', processes.size); event('localClientProcess', status());
      return { launched: true, processRunning: results.some(item => processes.has(item.pid)), pid: results[0].pid, executable, manualLogin: false, authMode: 'zaap-ticket', authenticated: false, launches: results };
    },
    'openRush': async () => 'client_not_configured',
    'deleteCacheFolder': async () => { const cache = path.join(profile, 'client-cache'); await noSymlinks(cache, root); await fsp.rm(cache, { recursive: true, force: true }); return 'completed'; },
    'listShortcutAccounts': async () => [],
    'copyShortcuts': async () => fail('local_shortcuts_not_available', 'Manual-login client shortcuts stay inside the native client'),
    'checkDiskSpace': async (e, value, needed) => {
      const target = await owned(value); if (!Number.isSafeInteger(needed) || needed < 0) fail('invalid_update_payload');
      let ancestor = target; while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
      const stat = await fsp.statfs(ancestor); const free = stat.bavail * stat.bsize; return free < needed ? { code: 'disk_full', needed, free } : null;
    },
    'compareFiles': async (e, old, incoming, value) => {
      const target = await owned(value), manifest = validateManifest(incoming), result = [];
      for (const [relative, expected] of Object.entries(manifest)) {
        const destination = await owned(path.join(target, safeRelative(relative)), false); expectedFiles.set(destination, expected);
        let same = false; try { const st = await fsp.stat(destination); same = st.isFile() && st.size === expected.size && await fileHash(destination) === expected.hash; } catch {}
        if (!same) result.push({ filePath: destination, fileUrl: expected.fileUrl, totalSize: expected.size, expectedHash: expected.hash });
      }
      return result;
    },
    'alteredFiles': async (e, manifest, value, synced, existOnly) => {
      const target = await owned(value); validateManifest(manifest); const result = [];
      for (const [relative, expected] of Object.entries(manifest)) {
        const destination = await owned(path.join(target, safeRelative(relative)), false);
        try { const st = await fsp.stat(destination); if (!st.isFile() || st.size !== expected.size || !existOnly && await fileHash(destination) !== expected.hash) result.push(relative); } catch { result.push(relative); }
      }
      return result;
    },
    'updateFiles': async (e, candidates, batch = 10, concurrency = 4) => {
      requireStopped(); if (!Array.isArray(candidates) || candidates.length > 100000) fail('invalid_update_payload');
      const plan = [];
      for (const candidate of candidates) {
        const destination = await owned(candidate.filePath, false), expected = expectedFiles.get(destination) || { hash: candidate.expectedHash, size: candidate.totalSize };
        if (!SHA1.test(expected.hash) || !Number.isSafeInteger(expected.size) || expected.size < 0) fail('invalid_update_payload');
        localURL(candidate.fileUrl); plan.push({ destination, expected, url: candidate.fileUrl });
      }
      for (const item of plan) await downloadFile(item.url, item.destination, item.expected, undefined, requestImpl);
      e?.sender?.send('updateProgress', { type: 'extract', value: 100 }); e?.sender?.send('updateProgressFiles', null); return true;
    },
    'download': async (e, value, destination) => {
      requireStopped(); localURL(value); const target = await owned(destination), temporary = path.join(target, '.tmp'); await noSymlinks(temporary, root); await fsp.mkdir(temporary, { recursive: true });
      const manifestURL = new URL(value); manifestURL.pathname = manifestURL.pathname.replace(/\.zip$/i, '.json');
      if (manifestURL.pathname === new URL(value).pathname) fail('invalid_zip_url');
      const manifest = validateManifest(await jsonRequest(manifestURL.href, requestImpl)), zip = path.join(temporary, crypto.randomUUID() + '.zip');
      await downloadFile(value, zip, null, undefined, requestImpl); zipManifests.set(zip, manifest); return { path: zip, state: 'completed' };
    },
    'unZip': async (e, value, destination) => {
      requireStopped(); const zip = await owned(value, false), target = await owned(destination), manifest = zipManifests.get(zip);
      if (!manifest) fail('manifest_required', 'Download the archive through this local adapter first');
      const entries = await zipEntries(zip), files = entries.filter(x => !x.directory), actual = new Set(files.map(x => x.name));
      if (actual.size !== Object.keys(manifest).length || Object.keys(manifest).some(k => !actual.has(k))) fail('integrity_error', 'ZIP and manifest members differ');
      const staging = path.join(profile, 'staging', crypto.randomUUID()); await noSymlinks(staging, root); await fsp.mkdir(staging, { recursive: true });
      try {
        await extractZip(zip, staging, entries);
        for (const [relative, expected] of Object.entries(manifest)) { const file = path.join(staging, relative); if ((await fsp.stat(file)).size !== expected.size || await fileHash(file) !== expected.hash) fail('integrity_error', `ZIP manifest mismatch: ${relative}`); }
        for (const relative of Object.keys(manifest)) { const destination = await owned(path.join(target, safeRelative(relative)), false); await fsp.mkdir(path.dirname(destination), { recursive: true }); await fsp.rename(path.join(staging, relative), destination); }
        await fsp.unlink(zip); zipManifests.delete(zip); return { state: 'completed' };
      } finally { await fsp.rm(staging, { recursive: true, force: true }); }
    },
    'removeOrphanFiles': async (e, incoming, value) => {
      requireStopped(); const target = await owned(value), manifest = validateManifest(incoming); if (Object.keys(manifest).length < 3) fail('invalid_manifest'); let removed = 0;
      async function visit(directory) { for (const entry of await fsp.readdir(directory, { withFileTypes: true })) { const file = await owned(path.join(directory, entry.name), false); if (entry.isDirectory()) await visit(file); else if (!Object.hasOwn(manifest, path.relative(target, file).split(path.sep).join('/'))) { await fsp.unlink(file); removed++; } } }
      await visit(target); return removed;
    },
    'emptyGameFolder': async (e, value) => { requireStopped(); const target = await owned(value); if (!Object.values(GAME_DIRS).some(name => target === path.join(clientBase, name))) fail('path_not_owned'); for (const item of await fsp.readdir(target)) { const file = await owned(path.join(target, item), false); await fsp.rm(file, { recursive: true, force: true }); } return 'completed'; },
    'deleteGameFolder': async (e, value) => { requireStopped(); const target = await owned(value); if (!Object.values(GAME_DIRS).some(name => target === path.join(clientBase, name))) fail('path_not_owned'); await fsp.rm(target, { recursive: true, force: true }); return 'completed'; }
  };
  return { handlers, currentState, status, gameRoot, owned, root, profile, closeNativeServices: async () => nativeServices?.close() };
}

function resolveProjectRoot({ starts = [__dirname, process.resourcesPath, path.dirname(process.execPath)], explicit = process.env.ABRAK_LOCAL_ROOT, maxParents = 6 } = {}) {
  const candidates = [], seen = new Set();
  if (explicit) candidates.push(path.resolve(explicit));
  for (const start of starts.filter(Boolean)) {
    let current = path.resolve(start);
    for (let depth = 0; depth <= Math.min(8, Math.max(0, maxParents)); depth++) {
      if (!seen.has(current)) { candidates.push(current); seen.add(current); }
      const parent = path.dirname(current); if (parent === current) break; current = parent;
    }
  }
  for (const candidate of candidates) {
    try {
      if (fs.statSync(path.join(candidate, '.abrak-local-project')).isFile() && fs.statSync(path.join(candidate, 'desktop/client-config.json')).isFile() && fs.statSync(path.join(candidate, 'backend')).isDirectory()) return fs.realpathSync(candidate);
    } catch {}
  }
  fail('project_root_not_found');
}
function install() {
  const electron = require('electron');
  if (electron.app.__abrakLocalRuntime) return electron.app.__abrakLocalRuntime;
  const runtime = createRuntime({ projectRoot: resolveProjectRoot(), electron });
  for (const [channel, handler] of Object.entries(runtime.handlers)) {
    electron.ipcMain.removeHandler(channel);
    electron.ipcMain.handle(channel, async (...args) => { try { return await handler(...args); } catch (error) { return channel === 'unZip' ? { state: errorResult(error) } : errorResult(error); } });
  }
  function guardSession(session) {
    session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => callback({ cancel: !isLoopbackRequest(details.url) }));
  }
  electron.app.on('session-created', guardSession);
  electron.app.whenReady().then(() => guardSession(electron.session.defaultSession));
  electron.app.on('web-contents-created', (event, contents) => {
    guardSession(contents.session);
    queueMicrotask(() => {
      if (contents.isDestroyed()) return;
      // Replace the copied launcher's hardcoded public-wiki rule only in this process.
      contents.removeAllListeners('will-attach-webview');
      for (const channel of ['will-navigate', 'will-redirect']) {
        contents.removeAllListeners(channel);
        contents.on(channel, (event, value) => {
          const decision = navigationDecision(value, contents.getType());
          if (!decision.allow) { event.preventDefault(); if (decision.external) electron.shell.openExternal(decision.external).catch(() => {}); }
        });
      }
      contents.on('will-attach-webview', (event, preferences, params) => {
        delete preferences.preload; delete preferences.preloadURL; preferences.nodeIntegration = false; preferences.contextIsolation = true; preferences.sandbox = true;
        if (!navigationDecision(params.src, 'webview').allow) event.preventDefault();
      });
      contents.setWindowOpenHandler(({ url }) => { const decision = navigationDecision(url, contents.getType()); if (decision.allow || decision.external) { try { const u = localURL(url, false); electron.shell.openExternal(u.href).catch(() => {}); } catch {} } return { action: 'deny' }; });
    });
  });
  electron.app.once('before-quit', () => { runtime.closeNativeServices().catch(() => {}); });
  electron.app.__abrakLocalRuntime = runtime; return runtime;
}
module.exports = { install, resolveProjectRoot, createRuntime, clientSettings, inspectClientXML, navigationDecision, safeRelative, localURL, isLoopbackRequest, validateManifest, fileHash, zipEntries, extractZip, crcUpdate, errorResult };
