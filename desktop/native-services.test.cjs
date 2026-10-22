'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { createNativeServices, validateTicket } = require('./native-services.cjs');
async function fixture(t, peerPid = 65001) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'abrak-native-service-')));
  await fs.mkdir(path.join(root, 'desktop')); await fs.writeFile(path.join(root, '.abrak-local-project'), 'owned');
  const assetKey = 'resources/app/retroclient/data/test.swf', native = path.join(root, 'client/Abrak/Retro/resources/app/retroclient/Abrak.exe');
  const asset = path.join(root, 'client/Abrak/Retro', assetKey); await fs.mkdir(path.dirname(asset), { recursive: true }); await fs.writeFile(asset, 'inert-data'); await fs.writeFile(native, 'inert-not-a-program');
  await fs.writeFile(path.join(root, 'desktop/client-manifest.json'), JSON.stringify({ [assetKey]: { size: 10, hash: crypto.createHash('sha1').update('inert-data').digest('hex'), fileUrl: 'http://127.0.0.1:4318/local/client-files/' + assetKey } }));
  const tickets = [];
  const services = createNativeServices({ projectRoot: root, ports: { data: 0, zaap: 0 }, lookupPeer: async () => ({ pid: peerPid, executable: native }), ticketProvider: async input => { tickets.push(input.accountId); return { token: String(tickets.length).padStart(32, '0'), accountId: 271, expiresAt: Date.now() + 30000, real_emulator: true }; } });
  t.after(async () => { await services.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, services, native, tickets };
}
async function connect(port) {
  const socket = net.createConnection({ host: '127.0.0.1', port }); await once(socket, 'connect');
  let buffer = '', waiting = [];
  socket.on('data', data => { buffer += data.toString('ascii'); let at; while ((at = buffer.indexOf('\0')) >= 0) { const frame = buffer.slice(0, at); buffer = buffer.slice(at + 1); const waiter = waiting.shift(); if (waiter) waiter(frame); } });
  const read = () => new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('test_frame_timeout')), 5000); waiting.push(frame => { clearTimeout(timer); resolve(frame); }); });
  return { socket, read };
}
test('service import and construction are inert; explicit start serves only manifested copied data', async t => {
  const f = await fixture(t); assert.equal(f.services.status().ready, false); const state = await f.services.start(); assert.equal(state.ready, true);
  const base = 'http://127.0.0.1:' + state.dataPort;
  const response = await fetch(base + '/data/test.swf'); assert.equal(response.status, 200); assert.equal(await response.text(), 'inert-data');
  for (const target of ['/resources/app/retroclient/Abrak.exe', '/data/%2e%2e%2fconfig.xml', '/data/unlisted.swf', '/']) assert.equal((await fetch(base + target)).status, 404);
  assert.equal((await fetch(base + '/crossdomain.xml')).status, 200); assert.equal(f.tickets.length, 0);
});
test('ASCII NUL protocol handles fragmented frames and issues a fresh short-lived backend ticket for the bound PID', async t => {
  const f = await fixture(t), state = await f.services.start();
  const launch = f.services.armLaunch({ accountId: 1, webToken: 'synthetic-web-token', executable: f.native }); f.services.bindPID(launch, 65001);
  const { socket, read } = await connect(state.zaapPort); t.after(() => socket.destroy());
  let answer = read(); socket.write('<policy-file-request/>\0'); assert.match(await answer, /cross-domain-policy/);
  answer = read(); socket.write('connect retro '); socket.write('main -1 -1\0'); const session = (await answer).split(' ')[1]; assert.match(session, /^[0-9a-f]{32}$/);
  answer = read(); socket.write('auth_getGameToken ' + session + ' 101\0'); const first = await answer; assert.match(first, /^auth_getGameToken [0-9a-f]{32}$/);
  answer = read(); socket.write('auth_getGameToken ' + session + ' 101\0'); assert.notEqual(await answer, first); assert.deepEqual(f.tickets, [1, 1]);
  const report = JSON.stringify(f.services.status()); assert.equal(report.includes('synthetic-web-token'), false); assert.equal(report.includes(first.split(' ')[1]), false);
});
test('an unrelated loopback PID cannot consume the selected account or request a ticket', async t => {
  const f = await fixture(t, 65002), state = await f.services.start();
  const launch = f.services.armLaunch({ accountId: 1, webToken: 'synthetic-web-token', executable: f.native }); f.services.bindPID(launch, 65001);
  const { socket } = await connect(state.zaapPort); const closed = once(socket, 'close'); socket.write('connect retro main -1 -1\0'); await closed;
  assert.equal(f.tickets.length, 0); assert.equal(f.services.status().events.at(-1).reason, 'native_peer_not_authorized');
});
test('malformed ticket, wrong session and unsupported game frames are rejected', async t => {
  for (const value of [{}, { token: '1'.repeat(32), accountId: 271, expiresAt: Date.now() - 1, real_emulator: true }, { token: '1'.repeat(32), accountId: 271, expiresAt: Date.now() + 60000, real_emulator: true }]) assert.throws(() => validateTicket(value), /invalid_ticket_response/);
  const f = await fixture(t), state = await f.services.start(), { socket } = await connect(state.zaapPort); const closed = once(socket, 'close');
  socket.write('auth_getGameToken unknown 101\0'); await closed; assert.equal(f.tickets.length, 0);
});
test('occupied ports fail without taking over or stopping the existing listener', async t => {
  const f = await fixture(t), other = http.createServer((req, res) => res.end('keep')); await new Promise(resolve => other.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => other.close(resolve)));
  const candidate = createNativeServices({ projectRoot: f.root, ports: { data: other.address().port, zaap: 0 } });
  await assert.rejects(candidate.start(), { code: 'EADDRINUSE' }); assert.equal(await (await fetch('http://127.0.0.1:' + other.address().port)).text(), 'keep'); await candidate.close();
});
