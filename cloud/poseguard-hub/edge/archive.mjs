import { sanitizeRecord } from '../worker/workspaces.js';

function object(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

export async function enableArchiveQueue(db) {
  const state = await db.prepare('SELECT archive_enabled FROM station_runtime WHERE id=1').first();
  if (state.archive_enabled) return;
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO station_outbox(kind,entity_id) SELECT 'event',id FROM incidents`),
    db.prepare(`INSERT OR IGNORE INTO station_outbox(kind,entity_id) SELECT 'device',id FROM devices`),
    db.prepare(`INSERT OR IGNORE INTO station_outbox(kind,entity_id) SELECT 'staff',id FROM users`),
    db.prepare('UPDATE station_runtime SET archive_enabled=1 WHERE id=1'),
  ]);
}

async function serializeQueued(db, queued, includeSnapshots) {
  let value;
  if (queued.kind === 'staff') {
    value = await db.prepare('SELECT id,name,role FROM users WHERE id=?').bind(queued.entity_id).first();
  } else if (queued.kind === 'device') {
    const row = await db.prepare('SELECT id,name,platform,location,last_seen,revoked_at,config_json FROM devices WHERE id=?')
      .bind(queued.entity_id).first();
    if (row) value = { ...row, revoked: !!row.revoked_at, fusion_group: object(row.config_json, {}).fusion_group };
  } else if (queued.kind === 'event') {
    const row = await db.prepare(`SELECT i.*,d.name AS device_name,d.location,d.is_test FROM incidents i
      JOIN devices d ON d.id=i.device_id WHERE i.id=?`).bind(queued.entity_id).first();
    if (!row) return null;
    const history = await db.prepare(`SELECT action,severity,observed_frames,occurred_at FROM incident_updates
      WHERE incident_id=? ORDER BY id DESC LIMIT 60`).bind(row.id).all();
    const snapshot = includeSnapshots ? await db.prepare(`SELECT data_base64,captured_at FROM snapshots
      WHERE incident_id=? ORDER BY created_at DESC LIMIT 1`).bind(row.id).first() : null;
    value = { ...row, updates: history.results.reverse(), evidence: object(row.evidence_json, []), snapshot };
  }
  return value ? sanitizeRecord(queued.kind, value) : null;
}

export async function archiveBatch(db, includeSnapshots) {
  const queued = (await db.prepare('SELECT seq,kind,entity_id FROM station_outbox ORDER BY seq LIMIT 20').all()).results;
  let size = 32;
  const payload = [];
  for (const row of queued) {
    const record = await serializeQueued(db, row, includeSnapshots);
    if (!record) {
      await db.prepare('DELETE FROM station_outbox WHERE seq=?').bind(row.seq).run();
      continue;
    }
    const item = { seq: row.seq, kind: row.kind, record };
    size += new TextEncoder().encode(JSON.stringify(item)).length + 2;
    if (size > 600_000) break;
    payload.push(item);
  }
  return payload;
}

export async function acknowledgeArchive(db, sequence) {
  if (!Array.isArray(sequence) || sequence.length > 20 ||
    sequence.some(value => !Number.isSafeInteger(value) || value < 1)) {
    throw new Error('Invalid archive acknowledgements');
  }
  if (sequence.length)
    await db.batch(sequence.map(seq => db.prepare('DELETE FROM station_outbox WHERE seq=?').bind(seq)));
}

export async function pushArchive(payload, config, fetcher = fetch) {
  const destination = new URL(config.server_url);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(destination.hostname);
  if ((destination.protocol !== 'https:' && !(local && destination.protocol === 'http:')) ||
      destination.username || destination.password || destination.search || destination.hash ||
      destination.pathname !== '/' || !/^pge_[A-Za-z0-9_-]{35,100}$/.test(config.token))
    throw new Error('Invalid station archive HTTPS origin or token');
  const response = await fetcher(new URL('/api/workspaces/ingest', destination), {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(12_000),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.token },
    body: JSON.stringify({ records: payload }),
  });
  if (!response.ok) throw new Error('Archive service HTTP ' + response.status);
  const result = await response.json();
  const expected = payload.map(row => row.seq);
  if (JSON.stringify(result.accepted) !== JSON.stringify(expected))
    throw new Error('Archive receipt did not match the queued records');
  return expected;
}
