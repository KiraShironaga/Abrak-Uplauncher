'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const activation = require('./activate-client-clone.cjs');
const previous = { gameLoginHost: '127.0.0.1', gameLoginPort: 1149, clientDataOrigin: 'http://127.0.0.1:8150', zaapBridgePort: 31549, clientRootRelative: 'client/Abrak/Retro', nativeExecutableRelative: 'resources/app/retroclient/Abrak.exe', payloadRoot: 'D:/provided-original' };
const xml = '<config><conf name="keep" zaapconnectport="31549"><dataserver type="local" url="data/"/><dataserver url="http://127.0.0.1:8150/data/"/><connserver ip="127.0.0.1" port="1149"/></conf><cache value="keep"/></config>';
const hash = value => crypto.createHash('sha1').update(value).digest('hex');
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'abrak-clone-activation-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'desktop')); await fs.writeFile(path.join(root, '.abrak-local-project'), 'owned');
  const installed = path.join(root, previous.clientRootRelative, activation.CONFIG_KEY);
  await fs.mkdir(path.dirname(installed), { recursive: true }); await fs.writeFile(installed, xml);
  await fs.writeFile(path.join(root, 'desktop/client-config.json'), JSON.stringify(previous));
  await fs.writeFile(path.join(root, 'desktop/client-manifest.json'), JSON.stringify({ [activation.CONFIG_KEY]: { size: Buffer.byteLength(xml), hash: hash(xml), fileUrl: 'http://127.0.0.1:4318/local/client-files/' + activation.CONFIG_KEY } }));
  const inspectProcesses = async ports => ({ listeners: ports.map(port => ({ port, pid: 65001, address: '127.0.0.1', executable: 'C:/runtime/fake-not-a-program.exe', commandLine: '"' + path.join(root, 'emulator/fake.jar') + '"' })), clients: [] });
  return { root, installed, inspectProcesses };
}
test('clone XML changes only connection targets and rejects public or invalid ports', () => {
  const prepared = activation.prepareCloneXML(xml, previous, activation.DEFAULT_TARGETS).xml;
  assert.match(prepared, /port="11419"/); assert.match(prepared, /127\.0\.0\.1:8159\/data\//); assert.match(prepared, /zaapconnectport="31559"/);
  assert.match(prepared, /type="local" url="data\/"/); assert.match(prepared, /<cache value="keep"\/>/);
  assert.throws(() => activation.validatedTargets({ ...activation.DEFAULT_TARGETS, exchangePort: 66419 }), /invalid_clone_port/);
  assert.throws(() => activation.prepareCloneXML(xml, previous, { ...activation.DEFAULT_TARGETS, gameLoginHost: 'public.example' }), /invalid_client_configuration/);
});
test('activation dry run preserves installed XML, manifest and config bytes', async t => {
  const f = await fixture(t), files = ['desktop/client-config.json', 'desktop/client-manifest.json', previous.clientRootRelative + '/' + activation.CONFIG_KEY];
  const before = await Promise.all(files.map(file => fs.readFile(path.join(f.root, file))));
  const report = await activation.activateClone({ projectRoot: f.root, inspectProcesses: f.inspectProcesses }); assert.equal(report.committed, false);
  for (let i = 0; i < files.length; i++) assert.deepEqual(await fs.readFile(path.join(f.root, files[i])), before[i]);
  await assert.rejects(fs.stat(path.join(f.root, activation.OVERRIDE_KEY)), { code: 'ENOENT' });
});
test('activation refuses missing or foreign listeners and an active owned client', async t => {
  const f = await fixture(t), ports = activation.validatedTargets(activation.DEFAULT_TARGETS).readinessPorts, clean = await f.inspectProcesses(ports), native = path.join(f.root, previous.clientRootRelative, previous.nativeExecutableRelative);
  assert.throws(() => activation.checkOwnership({ listeners: clean.listeners.slice(1), clients: [] }, f.root, ports, native), /clone_port_not_listening/);
  assert.throws(() => activation.checkOwnership({ listeners: clean.listeners.map(p => ({ ...p, commandLine: 'D:/different/runtime.jar' })), clients: [] }, f.root, ports, native), /clone_port_not_owned/);
  assert.throws(() => activation.checkOwnership({ ...clean, clients: [{ ProcessId: 65002, ExecutablePath: native }] }, f.root, ports, native), /close_owned_native_client/);
});
test('explicit activation creates matching payload override, manifest and installed XML', async t => {
  const f = await fixture(t), report = await activation.activateClone({ projectRoot: f.root, inspectProcesses: f.inspectProcesses, commit: true });
  assert.equal(report.committed, true); assert.equal(report.original_files_modified, false);
  const config = JSON.parse(await fs.readFile(path.join(f.root, 'desktop/client-config.json'))), manifest = JSON.parse(await fs.readFile(path.join(f.root, 'desktop/client-manifest.json')));
  const installed = await fs.readFile(f.installed), override = await fs.readFile(path.join(f.root, activation.OVERRIDE_KEY));
  assert.deepEqual(installed, override); assert.equal(hash(installed), manifest[activation.CONFIG_KEY].hash); assert.equal(installed.length, manifest[activation.CONFIG_KEY].size);
  assert.equal(config.payloadRoot, previous.payloadRoot); assert.equal(config.payloadOverrides[activation.CONFIG_KEY], activation.OVERRIDE_KEY); assert.equal(config.gameLoginPort, 11419);
  assert.equal((await fs.readFile(path.join(f.root, report.backup_directory_relative, 'config.xml'), 'utf8')), xml);
});
