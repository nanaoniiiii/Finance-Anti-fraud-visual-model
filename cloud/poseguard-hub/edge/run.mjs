import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { generateVAPIDKeys } from 'web-push';
import { passwordHash } from '../worker/auth.js';
import { pushArchive } from './archive.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const hub = resolve(here, '..');
const [file, command] = process.argv.slice(2);
if (!file) throw new Error('Usage: node edge/run.mjs path/to/config.json [--init]');
const pathname = resolve(file);
const config = JSON.parse(await readFile(pathname, 'utf8'));
const data = resolve(dirname(pathname), config.data_dir || './station-data');
const mode = config.mode === 'cloud' ? 'cloud' : 'edge';
const listen = config.listen || '127.0.0.1';
const loopback = listen === '127.0.0.1' || listen === 'localhost';
const port = Number(config.port || 8790);
const tls = config.tls?.certificate && config.tls?.key;
const origin = new URL(config.origin || `http://127.0.0.1:${port}`);
if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' ||
    (origin.protocol !== 'https:' && !(loopback && ['127.0.0.1','localhost'].includes(origin.hostname))))
  throw new Error('Set a station HTTPS origin, or a loopback HTTP origin for this computer');
if (!loopback && (!tls || origin.protocol !== 'https:'))
  throw new Error('A LAN listener requires a TLS certificate, TLS key and HTTPS origin');
if (mode === 'cloud' && !loopback) throw new Error('Cloud sandbox mode is only for loopback testing');
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('Station port must be between 1024 and 65535');
await mkdir(data, { recursive: true, mode: 0o700 });

async function credentials() {
  const secretFile = join(data, 'station-secrets.json');
  try {
    return JSON.parse(await readFile(secretFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const password = process.env.POSEGUARD_STATION_SETUP_PASSWORD;
  const address = config.admin_email?.trim().toLowerCase();
  if (command !== '--init' || !password || !address || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))
    throw new Error('Initialize with --init, admin_email and POSEGUARD_STATION_SETUP_PASSWORD (at least 12 characters)');
  const secret = {
    OWNER_EMAIL: address,
    OWNER_PASSWORD_HASH: await passwordHash(password),
    ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
  };
  if (mode === 'edge') {
    const keys = generateVAPIDKeys();
    secret.VAPID_PUBLIC_KEY = keys.publicKey;
    secret.VAPID_PRIVATE_KEY = keys.privateKey;
  }
  await writeFile(secretFile, JSON.stringify(secret, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return secret;
}
const secret = await credentials();
delete process.env.POSEGUARD_STATION_SETUP_PASSWORD;
const state = join(data, 'worker-state');
const maintenanceKey = randomBytes(36).toString('base64url');
const vars = join(data, 'runtime.private.env');
await writeFile(vars, Object.entries({
  OWNER_EMAIL: secret.OWNER_EMAIL,
  STATION_OWNER_HASH_B64: Buffer.from(secret.OWNER_PASSWORD_HASH, 'utf8').toString('base64'),
  ENCRYPTION_KEY: secret.ENCRYPTION_KEY,
  ...(secret.VAPID_PUBLIC_KEY && secret.VAPID_PRIVATE_KEY ? {
    VAPID_PUBLIC_KEY: secret.VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: secret.VAPID_PRIVATE_KEY,
  } : {}),
  PUBLIC_ORIGIN: origin.origin, DEPLOYMENT_MODE: mode, LOCAL_MAINTENANCE_KEY: maintenanceKey,
}).map(([key, value]) => key + '=' + JSON.stringify(value)).join('\n') + '\n', { mode: 0o600 });
const cli = join(hub, 'node_modules/wrangler/bin/wrangler.js');
const local = ['--local', '--persist-to', state, '--config', join(here, 'wrangler.local.jsonc')];
const environment = {
  ...process.env, WRANGLER_SEND_METRICS: 'false',
  X_LOCAL_EXPLORER: 'false', X_LOCAL_OBSERVABILITY: 'false',
};
const migration = spawnSync(process.execPath, [cli, 'd1', 'migrations', 'apply', 'poseguard-station', ...local],
  { cwd: hub, env: environment, stdio: 'inherit' });
if (migration.status !== 0) throw new Error('Applying local station database migrations failed');
const child = spawn(process.execPath, [cli, 'dev', ...local, '--ip', listen, '--port', String(port),
  '--env-file', vars, '--local-protocol', tls ? 'https' : 'http',
  ...(tls ? ['--https-cert-path', resolve(dirname(pathname), config.tls.certificate),
    '--https-key-path', resolve(dirname(pathname), config.tls.key)] : []),
], { cwd: hub, env: environment, stdio: 'inherit', windowsHide: true });
const loopbackURL = tls ? origin.origin : `http://127.0.0.1:${port}`;
const authorized = (route, options = {}) => fetch(loopbackURL + route, {
  ...options, signal: AbortSignal.timeout(10_000),
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + maintenanceKey },
});
let stopping = false;
let tick;
let maintenance;
function stop() {
  stopping = true;
  clearInterval(tick);
  clearInterval(maintenance);
  child.kill();
}
for (const name of ['SIGINT', 'SIGTERM']) process.once(name, stop);
child.once('exit', (code) => {
  clearInterval(tick);
  clearInterval(maintenance);
  if (!stopping) process.exitCode = code || 1;
});
let ready = false;
for (let i = 0; i < 30 && child.exitCode === null; ++i) {
  try {
    const result = await fetch(loopbackURL + '/api/health', { signal: AbortSignal.timeout(1500) });
    if (result.ok && (await result.json()).deployment === mode) { ready = true; break; }
  } catch { /* The local runtime is still starting. */ }
  await pause(500);
}
if (!ready) { stop(); throw new Error('The station service did not become ready'); }
if (mode === 'edge') {
  const response = await authorized('/__station_archive_init', { method: 'POST' });
  if (!response.ok) { stop(); throw new Error('Could not enable the local archive queue'); }
}
console.log(`PoseGuard ${mode} ready at ${origin.origin}`);
let busy = false;
let nextSync = 0;
let lastArchive = 0;
let failures = 0;
let previousError = '';
tick = setInterval(async () => {
  if (busy || mode !== 'edge' || Date.now() < nextSync) return;
  busy = true;
  try {
    const { archive } = JSON.parse(await readFile(pathname, 'utf8'));
    if (!archive) return;
    const result = await authorized('/__station_archive?photos=' + (archive.include_snapshots ? '1' : '0'));
    if (!result.ok) throw new Error('Reading the local archive queue failed');
    const { records } = await result.json();
    if (records.length || Date.now() - lastArchive > 60_000) {
      const accepted = await pushArchive(records, archive);
      if (accepted.length) {
        const response = await authorized('/__station_archive', {
          method: 'POST', body: JSON.stringify({ accepted }),
        });
        if (!response.ok) throw new Error('Applying the archive receipt locally failed');
        console.log(`Archive accepted ${accepted.length} records`);
      }
      lastArchive = Date.now();
    }
    previousError = '';
    failures = 0;
  } catch (error) {
    nextSync = Date.now() + Math.min(60_000, 2500 * 2 ** Math.min(++failures, 5));
    const message = String(error.message).replace(/pge_[\w-]+/g, '[redacted]').slice(0, 120);
    if (previousError !== message) console.error('Archive pending:', message);
    previousError = message;
  } finally {
    busy = false;
  }
}, 2500);
maintenance = setInterval(() => {
  authorized('/__station_maintenance', { method: 'POST' }).catch(() => console.error('Station maintenance will retry'));
}, 45_000);
