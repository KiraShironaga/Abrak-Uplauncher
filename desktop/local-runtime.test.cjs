'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const adapter = require('../source/app/local-runtime.cjs');
const digest = data => crypto.createHash('sha1').update(data).digest('hex');
const URL = 'http://127.0.0.1:4318/local/client-files/a.dat';

async function fixture(t, requestImpl) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'abrak-owned-desktop-test-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const profile = path.join(root, 'profile'), client = path.join(root, 'client/Abrak/Retro'), native = path.join(client, 'resources/app/retroclient');
  await fsp.mkdir(native, { recursive: true }); await fsp.mkdir(path.join(root, 'desktop')); await fsp.mkdir(profile);
  await fsp.writeFile(path.join(native, 'Abrak.exe'), 'inert-not-a-program');
  await fsp.writeFile(path.join(native, 'loader.swf'), 'inert');
  await fsp.writeFile(path.join(native, 'config.xml'), '<config><conf zaapconnectport="31549"><connserver ip="127.0.0.1" port="1149"/><dataserver url="data/" type="local"/><dataserver url="http://127.0.0.1:8150/data/"/></conf></config>');
  await fsp.writeFile(path.join(root, 'desktop/client-config.json'), JSON.stringify({ gameLoginHost: '127.0.0.1', gameLoginPort: 1149, clientDataOrigin: 'http://127.0.0.1:8150', zaapBridgePort: 31549 }));
  await fsp.writeFile(path.join(root, 'desktop/client-copy.json'), JSON.stringify({ destination: client, files: 3 }));
  await fsp.writeFile(path.join(root, 'desktop/client-manifest.json'), '{}');
  const spawned = [], windows = [], serviceCalls = [], electron = { app: { getPath: () => profile }, BrowserWindow: { getAllWindows: () => windows }, shell: { openPath: async p => p, openExternal: async p => p } };
  const spawnImpl = (...args) => { const child = new EventEmitter(); child.pid = 52001 + spawned.length; child.unref = () => {}; spawned.push({ args, child }); queueMicrotask(() => child.emit('spawn')); return child; };
  let serviceReady = false;
  const nativeServicesFactory = () => { serviceCalls.push('created'); return { start: async () => { serviceReady = true; serviceCalls.push('started'); return { ready: true }; }, status: () => ({ ready: serviceReady }), armLaunch: data => { serviceCalls.push({ arm: data.accountId }); return 'launch-' + serviceCalls.length; }, bindPID: (id, pid) => serviceCalls.push({ bind: id, pid }), cancelLaunch: id => serviceCalls.push({ cancel: id }), close: async () => { serviceReady = false; } }; };
  const runtime = adapter.createRuntime({ projectRoot: root, electron, spawnImpl, requestImpl, nativeServicesFactory });
  return { root, profile, client, native, runtime, spawned, electron, serviceCalls };
}
async function activateFixture(f) {
  const configPath = path.join(f.root, 'desktop/client-config.json'), nativeConfig = path.join(f.native, 'config.xml');
  const configuration = { gameLoginHost: '127.0.0.1', gameLoginPort: 11419, clientDataOrigin: 'http://127.0.0.1:8159', zaapBridgePort: 31559 };
  await fsp.writeFile(configPath, JSON.stringify(configuration));
  await fsp.writeFile(nativeConfig, (await fsp.readFile(nativeConfig, 'utf8')).replace('1149', '11419').replace('31549', '31559').replace('8150', '8159'));
}
function zip(name, data, { crcWrong = false, symlink = false, zip64 = false } = {}) {
  const bytes = Buffer.from(data), encoded = Buffer.from(name), compressed = zlib.deflateRawSync(bytes), crc = (adapter.crcUpdate(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(encoded.length, 26);
  const payload = Buffer.concat([local, encoded, compressed]), central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(crcWrong ? crc ^ 1 : crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(encoded.length, 28); central.writeUInt32LE((symlink ? 0xa1ff : 0x81a4) * 65536 >>> 0, 38);
  const directory = Buffer.concat([central, encoded]), eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50); eocd.writeUInt16LE(zip64 ? 0xffff : 1, 8); eocd.writeUInt16LE(zip64 ? 0xffff : 1, 10); eocd.writeUInt32LE(zip64 ? 0xffffffff : directory.length, 12); eocd.writeUInt32LE(zip64 ? 0xffffffff : payload.length, 16);
  if (!zip64) return Buffer.concat([payload, directory, eocd]);
  const record = Buffer.alloc(56); record.writeUInt32LE(0x06064b50); record.writeBigUInt64LE(44n, 4); record.writeUInt16LE(45, 12); record.writeUInt16LE(45, 14); record.writeBigUInt64LE(1n, 24); record.writeBigUInt64LE(1n, 32); record.writeBigUInt64LE(BigInt(directory.length), 40); record.writeBigUInt64LE(BigInt(payload.length), 48);
  const locator = Buffer.alloc(20); locator.writeUInt32LE(0x07064b50); locator.writeBigUInt64LE(BigInt(payload.length + directory.length), 8); locator.writeUInt32LE(1, 16);
  return Buffer.concat([payload, directory, record, locator, eocd]);
}

test('path traversal, Windows device paths and public download URLs are rejected', () => {
  for (const input of ['../a', '/a', 'a/../b', 'C:/x', 'a:stream', 'CON', 'a/NUL.txt', 'x.']) assert.throws(() => adapter.safeRelative(input));
  assert.equal(adapter.safeRelative('data\\a.dat'), 'data/a.dat');
  for (const input of ['https://cdn.abrak.fr/a', 'http://127.0.0.1:4318@public.example/a', 'file:///x']) assert.throws(() => adapter.localURL(input));
  assert.equal(adapter.localURL(URL).origin, 'http://127.0.0.1:4318');
  assert.equal(adapter.isLoopbackRequest('https://public.example/x'), false);
  assert.equal(adapter.isLoopbackRequest('ws://127.0.0.1:4318/ws'), true);
});

test('main navigation keeps the app context while wiki navigation stays inside the wiki webview', () => {
  assert.equal(adapter.navigationDecision('http://127.0.0.1:4318/#/faq').allow, true);
  assert.equal(adapter.navigationDecision('http://127.0.0.1:4318/index.html#/wiki').allow, true);
  const wiki = adapter.navigationDecision('http://127.0.0.1:4318/local/wiki/faq');
  assert.equal(wiki.allow, false); assert.equal(wiki.external, 'http://127.0.0.1:4318/local/wiki/faq');
  assert.deepEqual(adapter.navigationDecision('https://public.example/'), { allow: false, external: null });
  assert.deepEqual(adapter.navigationDecision('file:///C:/outside.html'), { allow: false, external: null });
  assert.equal(adapter.navigationDecision('http://127.0.0.1:4318/local/wiki/faq', 'webview').allow, true);
  for (const url of ['http://127.0.0.1:4318/', 'http://127.0.0.1:4318/local/wikievil', 'http://localhost:4318/local/wiki/']) assert.equal(adapter.navigationDecision(url, 'webview').allow, false);
});
test('profile outside owned project is rejected', async t => {
  const f = await fixture(t); f.electron.app.getPath = () => path.dirname(f.root);
  assert.throws(() => adapter.createRuntime({ projectRoot: f.root, electron: f.electron }), /project-owned/);
});
test('packaged project resolution walks bounded parents and requires all project markers', async t => {
  const f = await fixture(t), nested = path.join(f.root, 'dist/Abrak Launcher/resources/app.asar');
  await fsp.mkdir(path.join(f.root, 'backend')); await fsp.writeFile(path.join(f.root, '.abrak-local-project'), 'local'); await fsp.writeFile(path.join(f.root, 'desktop/client-config.json'), '{}');
  assert.equal(adapter.resolveProjectRoot({ starts: [nested], explicit: '', maxParents: 6 }), fs.realpathSync(f.root));
  assert.throws(() => adapter.resolveProjectRoot({ starts: [nested], explicit: '', maxParents: 1 }), /project_root_not_found/);
  await fsp.unlink(path.join(f.root, '.abrak-local-project'));
  assert.throws(() => adapter.resolveProjectRoot({ starts: [nested], explicit: f.root, maxParents: 6 }), /project_root_not_found/);
});
test('runtime state distinguishes copied files and configured private login from gameplay proof', async t => {
  const f = await fixture(t), state = await f.runtime.currentState();
  assert.equal(state.nativeClientReady, true); assert.equal(state.gameConfigured, true); assert.equal(state.gameplayVerified, false); assert.equal(state.bridgeUsed, false);
  await fsp.unlink(path.join(f.root, 'desktop/client-copy.json')); assert.equal((await f.runtime.currentState()).nativeClientReady, false);
});

test('runtime reloads explicit client targets and rejects XML or public target mismatches', async t => {
  const f = await fixture(t), configPath = path.join(f.root, 'desktop/client-config.json'), nativeConfig = path.join(f.native, 'config.xml');
  const settings = { gameLoginHost: '127.0.0.1', gameLoginPort: 11419, clientDataOrigin: 'http://127.0.0.1:8159', zaapBridgePort: 31559 };
  await fsp.writeFile(configPath, JSON.stringify(settings));
  assert.equal((await f.runtime.currentState()).gameConfigured, false);
  const xml = (await fsp.readFile(nativeConfig, 'utf8')).replace('1149', '11419').replace('31549', '31559').replace('8150', '8159');
  await fsp.writeFile(nativeConfig, xml); const state = await f.runtime.currentState();
  assert.equal(state.gameConfigured, true); assert.equal(state.clientTargets.gameLoginPort, 11419);
  await fsp.writeFile(nativeConfig, xml.replace('127.0.0.1:8159', 'public.example:8159')); assert.equal((await f.runtime.currentState()).gameConfigured, false);
  await fsp.writeFile(configPath, JSON.stringify({ ...settings, gameLoginHost: 'public.example' }));
  const invalid = await f.runtime.currentState(); assert.equal(invalid.gameConfigured, false); assert.equal(invalid.configurationError.code, 'invalid_client_configuration');
});
test('out-of-project writes and symlink traversal are rejected', async t => {
  const f = await fixture(t); await assert.rejects(f.runtime.owned(path.join(f.root, 'unowned')), /path_not_owned/);
  const outside = path.join(f.root, 'other'); await fsp.mkdir(outside); const link = path.join(f.client, 'link');
  try { await fsp.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch (e) { if (e.code === 'EPERM') return t.skip('OS does not permit creating test symlink'); throw e; }
  await assert.rejects(f.runtime.owned(path.join(link, 'x')), /symlink_not_allowed/);
});
test('comparison detects same-size tampering despite cached manifest equality', async t => {
  const f = await fixture(t); await fsp.writeFile(path.join(f.client, 'a.dat'), 'bad');
  const manifest = { 'a.dat': { size: 3, hash: digest('yes'), fileUrl: URL } };
  const candidates = await f.runtime.handlers.compareFiles(null, manifest, manifest, f.client);
  assert.equal(candidates.length, 1); assert.equal(candidates[0].expectedHash, digest('yes'));
});
test('bad differential bytes fail and preserve previous file', async t => {
  const f = await fixture(t, async () => Readable.from([Buffer.from('bad')])), target = path.join(f.client, 'a.dat'); await fsp.writeFile(target, 'old');
  await assert.rejects(f.runtime.handlers.updateFiles(null, [{ filePath: target, fileUrl: URL, totalSize: 3, expectedHash: digest('yes') }]), /Downloaded bytes/);
  assert.equal(await fsp.readFile(target, 'utf8'), 'old'); assert.deepEqual((await fsp.readdir(f.client)).filter(x => x.includes('.part')), []);
});
test('valid differential update uses verified file bytes', async t => {
  const f = await fixture(t, async () => Readable.from([Buffer.from('new')])), target = path.join(f.client, 'a.dat'); await fsp.writeFile(target, 'old');
  assert.equal(await f.runtime.handlers.updateFiles(null, [{ filePath: target, fileUrl: URL, totalSize: 3, expectedHash: digest('new') }]), true);
  assert.equal(await fsp.readFile(target, 'utf8'), 'new');
});
test('native services start only on explicit IPC and do not launch the client', async t => {
  const f = await fixture(t); await f.runtime.currentState(); assert.deepEqual(f.serviceCalls, []);
  assert.equal((await f.runtime.handlers['start-local-native-services']()).ready, true); assert.deepEqual(f.serviceCalls, ['created', 'started']); assert.equal(f.spawned.length, 0);
});

test('native launch refuses original ports and launches copied path with PID-bound ticket auth only after clone activation', async t => {
  const f = await fixture(t); assert.equal(f.spawned.length, 0);
  await assert.rejects(f.runtime.handlers.openGame(null, 32, f.client, { currentGame: 'main', account: 101, token: 'synthetic-not-used' }), /local_clone_not_activated/);
  await activateFixture(f);
  const result = await f.runtime.handlers.openGame(null, 32, f.client, { currentGame: 'main', account: 101, token: 'synthetic-not-used' });
  assert.equal(result.authenticated, false); assert.equal(result.manualLogin, false); assert.equal(result.authMode, 'zaap-ticket'); assert.equal(f.spawned.length, 1);
  assert.equal(f.spawned[0].args[0], path.join(f.native, 'Abrak.exe')); assert.deepEqual(f.spawned[0].args[1], []); assert.equal(f.spawned[0].args[2].cwd, f.native);
  assert.match(f.spawned[0].args[2].env.__COMPAT_LAYER, /RunAsInvoker/); assert.equal(f.serviceCalls[2].arm, 101); assert.equal(f.serviceCalls[3].pid, 52001);
  assert.equal(f.runtime.status()[0].connected, false); await assert.rejects(f.runtime.handlers.updateFiles(null, []), /Close this project/);
  f.spawned[0].child.emit('exit', 0); assert.equal(await f.runtime.handlers['get-game-status'](), 0);
});

test('multiple selected accounts get distinct native children and sessions without duplicate launches', async t => {
  const f = await fixture(t); await activateFixture(f);
  const result = await f.runtime.handlers.openGame(null, 32, f.client, { accounts: [101, 102, 101], token: 'synthetic-not-used' });
  assert.equal(result.launches.length, 2); assert.deepEqual(f.runtime.status().map(item => item.id), [101, 102]); assert.deepEqual(f.spawned.map(item => item.child.pid), [52001, 52002]);
  for (const item of f.spawned) item.child.emit('exit', 0);
});
test('cache clear changes only project-owned cache', async t => {
  const f = await fixture(t), cache = path.join(f.profile, 'client-cache'); await fsp.mkdir(cache); await fsp.writeFile(path.join(cache, 'a'), 'cache'); await fsp.writeFile(path.join(f.root, 'untouched'), 'keep');
  assert.equal(await f.runtime.handlers.deleteCacheFolder(), 'completed'); assert.equal(fs.existsSync(cache), false); assert.equal(await fsp.readFile(path.join(f.root, 'untouched'), 'utf8'), 'keep');
});
test('ZIP32 and ZIP64 central directory preserve exact member bytes', async t => {
  const f = await fixture(t);
  for (const use64 of [false, true]) { const archive = path.join(f.root, `a-${use64}.zip`), staging = path.join(f.root, `extract-${use64}`); await fsp.writeFile(archive, zip('data/a.dat', 'payload', { zip64: use64 })); await fsp.mkdir(staging); const entries = await adapter.zipEntries(archive); await adapter.extractZip(archive, staging, entries); assert.equal(await fsp.readFile(path.join(staging, 'data/a.dat'), 'utf8'), 'payload'); }
});
test('ZIP traversal and symlink members are rejected before extraction', async t => {
  const f = await fixture(t);
  for (const [name, options] of [['../outside', {}], ['data/link', { symlink: true }]]) { const archive = path.join(f.root, 'bad.zip'); await fsp.writeFile(archive, zip(name, 'payload', options)); await assert.rejects(adapter.zipEntries(archive)); }
});
test('ZIP CRC corruption is detected', async t => {
  const f = await fixture(t), archive = path.join(f.root, 'bad.zip'), staging = path.join(f.root, 'staging'); await fsp.mkdir(staging); await fsp.writeFile(archive, zip('a.dat', 'payload', { crcWrong: true }));
  await assert.rejects(adapter.extractZip(archive, staging, await adapter.zipEntries(archive)), /CRC\/size/);
});
test('full ZIP install requires manifest and verifies staged content before replacing installed file', async t => {
  const payload = Buffer.from('new'), data = zip('a.dat', payload), manifest = { 'a.dat': { size: payload.length, hash: digest(payload), fileUrl: URL } };
  const f = await fixture(t, async url => Readable.from([url.endsWith('.json') ? Buffer.from(JSON.stringify(manifest)) : data]));
  const downloaded = await f.runtime.handlers.download(null, 'http://127.0.0.1:4318/local/release.zip', f.client);
  assert.deepEqual(await f.runtime.handlers.unZip(null, downloaded.path, f.client), { state: 'completed' }); assert.equal(await fsp.readFile(path.join(f.client, 'a.dat'), 'utf8'), 'new');
});
