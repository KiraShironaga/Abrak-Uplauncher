'use strict';
// Explicit activation tool. Requiring this file does not inspect or modify a client.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { clientSettings, inspectClientXML, safeRelative, fileHash } = require('../source/app/local-runtime.cjs');
const execFileAsync = promisify(execFile);
const CONFIG_KEY = 'resources/app/retroclient/config.xml';
const OVERRIDE_KEY = 'desktop/client-payload-overrides/config.xml';
const DEFAULT_TARGETS = Object.freeze({ gameLoginHost: '127.0.0.1', gameLoginPort: 11419, gameServerPort: 55419, databasePort: 3319, exchangePort: 61419, clientDataOrigin: 'http://127.0.0.1:8159', zaapBridgePort: 31559 });
function fail(code) { throw Object.assign(new Error(code), { code }); }
function inside(file, root) { const relative = path.relative(root, file); return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); }
async function owned(root, relative) {
  const resolved = path.join(root, safeRelative(relative));
  if (!inside(resolved, root)) fail('path_not_owned');
  let current = root;
  for (const part of path.relative(root, resolved).split(path.sep)) {
    current = path.join(current, part);
    try { if ((await fsp.lstat(current)).isSymbolicLink()) fail('symlink_not_allowed'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return resolved;
}
function validatedTargets(value) {
  const targets = { ...value, ...clientSettings(value) };
  for (const field of ['gameServerPort', 'databasePort', 'exchangePort']) if (!Number.isInteger(targets[field]) || targets[field] < 1 || targets[field] > 65535) fail('invalid_clone_port');
  const dataPort = Number(new URL(targets.clientDataOrigin).port) || (targets.clientDataOrigin.startsWith('https:') ? 443 : 80);
  targets.readinessPorts = [...new Set([targets.gameLoginPort, targets.gameServerPort, targets.databasePort, targets.exchangePort, dataPort, targets.zaapBridgePort])];
  if (targets.readinessPorts.length !== 6) fail('clone_ports_must_be_distinct');
  return targets;
}
function replaceAttribute(tag, name, value) {
  const expression = new RegExp('(\\b' + name + '\\s*=\\s*)(["\'])(.*?)\\2', 'i');
  if (!expression.test(tag)) fail('missing_xml_attribute_' + name);
  return tag.replace(expression, (_, prefix, quote) => prefix + quote + String(value) + quote);
}
function prepareCloneXML(xml, previous, next) {
  const before = clientSettings(previous), targets = validatedTargets(next);
  if (!inspectClientXML(xml, before)) fail('source_xml_does_not_match_current_config');
  let result = xml.replace(/<conf\b[^>]*>/gi, tag => replaceAttribute(tag, 'zaapconnectport', targets.zaapBridgePort));
  result = result.replace(/<connserver\b[^>]*>/gi, tag => replaceAttribute(replaceAttribute(tag, 'ip', targets.gameLoginHost), 'port', targets.gameLoginPort));
  result = result.replace(/<dataserver\b[^>]*>/gi, tag => {
    const url = /\burl\s*=\s*(["'])(.*?)\1/i.exec(tag);
    return url && url[2].startsWith(before.clientDataOrigin + '/') ? replaceAttribute(tag, 'url', targets.clientDataOrigin + url[2].slice(before.clientDataOrigin.length)) : tag;
  });
  if (!inspectClientXML(result, targets)) fail('prepared_xml_does_not_match_clone_config');
  return { xml: result, targets };
}
async function inspectWindowsProcesses(ports) {
  if (process.platform !== 'win32') fail('windows_process_inspection_required');
  const list = ports.map(Number).join(',');
  const script = "$ErrorActionPreference='Stop'; $ports=@(" + list + "); $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {$_.LocalPort -in $ports} | ForEach-Object {$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$_.OwningProcess); [pscustomobject]@{port=$_.LocalPort;address=$_.LocalAddress;pid=$_.OwningProcess;executable=$p.ExecutablePath;commandLine=$p.CommandLine}}); $clients=@(Get-CimInstance Win32_Process -Filter \"Name='Abrak.exe'\" | Select-Object ProcessId,ExecutablePath); [pscustomobject]@{listeners=$listeners;clients=$clients}|ConvertTo-Json -Depth 4 -Compress";
  const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout.replace(/^\uFEFF/, ''));
}
function checkOwnership(snapshot, root, ports, nativeExecutable) {
  const normalized = value => String(value || '').replace(/\//g, '\\').toLowerCase();
  const rootPrefix = normalized(root).replace(/\\$/, '') + '\\', native = normalized(nativeExecutable);
  for (const client of snapshot.clients || []) {
    if (!client.ExecutablePath) fail('native_process_identity_unavailable');
    if (normalized(client.ExecutablePath) === native) fail('close_owned_native_client_before_activation');
  }
  const proof = [];
  for (const port of ports) {
    const listeners = (snapshot.listeners || []).filter(item => item.port === port);
    if (!listeners.length) fail('clone_port_not_listening_' + port);
    for (const listener of listeners) {
      if (!normalized(listener.executable).startsWith(rootPrefix) && !normalized(listener.commandLine).includes(rootPrefix)) fail('clone_port_not_owned_' + port);
      proof.push({ port, pid: listener.pid, address: listener.address, executable: listener.executable || null, project_path_in_command: normalized(listener.commandLine).includes(rootPrefix) });
    }
  }
  return proof;
}
async function replaceFile(filename, content) {
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  const temporary = filename + '.pending-' + crypto.randomUUID();
  try { await fsp.writeFile(temporary, content, { flag: 'wx' }); await fsp.rename(temporary, filename); }
  finally { await fsp.rm(temporary, { force: true }); }
}
async function activateClone({ projectRoot = path.resolve(__dirname, '..'), targets = DEFAULT_TARGETS, commit = false, inspectProcesses = inspectWindowsProcesses } = {}) {
  const root = await fsp.realpath(projectRoot), configured = validatedTargets(targets);
  if (!(await fsp.stat(path.join(root, '.abrak-local-project'))).isFile()) fail('project_marker_required');
  const configPath = await owned(root, 'desktop/client-config.json'), manifestPath = await owned(root, 'desktop/client-manifest.json');
  const beforeConfigBytes = await fsp.readFile(configPath), beforeManifestBytes = await fsp.readFile(manifestPath);
  const previous = JSON.parse(beforeConfigBytes), manifest = JSON.parse(beforeManifestBytes);
  const clientRootRelative = safeRelative(previous.clientRootRelative), nativePath = await owned(root, clientRootRelative + '/' + safeRelative(previous.nativeExecutableRelative));
  const installedPath = await owned(root, clientRootRelative + '/' + CONFIG_KEY), overridePath = await owned(root, OVERRIDE_KEY);
  const beforeInstalledBytes = await fsp.readFile(installedPath);
  let beforeOverride = null; try { beforeOverride = await fsp.readFile(overridePath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const prepared = prepareCloneXML(beforeInstalledBytes.toString('utf8'), previous, configured), xmlBytes = Buffer.from(prepared.xml, 'utf8');
  const proof = checkOwnership(await inspectProcesses(configured.readinessPorts), root, configured.readinessPorts, nativePath);
  const entry = { size: xmlBytes.length, hash: crypto.createHash('sha1').update(xmlBytes).digest('hex'), fileUrl: 'http://127.0.0.1:4318/local/client-files/' + CONFIG_KEY };
  if (!manifest[CONFIG_KEY]) fail('config_missing_from_manifest');
  const nextConfig = { ...previous, ...clientSettings(configured), gameServerPort: configured.gameServerPort, databasePort: configured.databasePort, exchangePort: configured.exchangePort, cloneRuntimeRelative: 'emulator', payloadOverrides: { ...(previous.payloadOverrides || {}), [CONFIG_KEY]: OVERRIDE_KEY } };
  const report = { prepared_at_utc: new Date().toISOString(), committed: false, projectRoot: root, native_client_executed: false, original_files_modified: false, configuration_key: CONFIG_KEY, override: OVERRIDE_KEY, targets: { ...clientSettings(configured), gameServerPort: configured.gameServerPort, databasePort: configured.databasePort, exchangePort: configured.exchangePort }, manifest_entry: entry, previous_installed_sha256: crypto.createHash('sha256').update(beforeInstalledBytes).digest('hex'), next_installed_sha256: crypto.createHash('sha256').update(xmlBytes).digest('hex'), listening_ownership: proof, readiness_limit: 'Listening sockets and project ownership checked; authentication and gameplay are separate proofs' };
  if (!commit) return report;
  const backupDirectory = await owned(root, 'desktop/client-activation-backups/' + crypto.randomUUID());
  await fsp.mkdir(backupDirectory, { recursive: true });
  await fsp.writeFile(path.join(backupDirectory, 'client-config.json'), beforeConfigBytes);
  await fsp.writeFile(path.join(backupDirectory, 'config.xml'), beforeInstalledBytes);
  // Recheck ports immediately before committing the owned files.
  checkOwnership(await inspectProcesses(configured.readinessPorts), root, configured.readinessPorts, nativePath);
  manifest[CONFIG_KEY] = entry;
  try {
    await replaceFile(overridePath, xmlBytes);
    await replaceFile(manifestPath, JSON.stringify(manifest) + '\n');
    await replaceFile(configPath, JSON.stringify(nextConfig, null, 2) + '\n');
    await replaceFile(installedPath, xmlBytes);
    if (await fileHash(installedPath) !== entry.hash || await fileHash(overridePath) !== entry.hash) fail('installed_config_integrity_error');
  } catch (error) {
    const rollback = await Promise.allSettled([replaceFile(manifestPath, beforeManifestBytes), replaceFile(configPath, beforeConfigBytes), replaceFile(installedPath, beforeInstalledBytes), beforeOverride === null ? fsp.rm(overridePath, { force: true }) : replaceFile(overridePath, beforeOverride)]);
    error.rollbackFailures = rollback.filter(r => r.status === 'rejected').length;
    throw error;
  }
  report.committed = true; report.manifest_sha256 = await fileHash(manifestPath, 'sha256'); report.backup_directory_relative = path.relative(root, backupDirectory).split(path.sep).join('/');
  await replaceFile(await owned(root, 'desktop/client-clone-activation.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}
if (require.main === module) activateClone({ commit: process.argv.includes('--activate') }).then(report => process.stdout.write(JSON.stringify(report, null, 2) + '\n')).catch(error => { process.stderr.write(JSON.stringify({ code: error.code || 'activation_failed', rollbackFailures: error.rollbackFailures || 0 }) + '\n'); process.exitCode = 1; });
module.exports = { activateClone, prepareCloneXML, validatedTargets, checkOwnership, DEFAULT_TARGETS, CONFIG_KEY, OVERRIDE_KEY };
