import {
  ApiError, audit, body, digest, identifier, integer, json, now, parse, randomToken,
  riskLabels, text, uid, validSnapshot,
} from './utils.js';
import { ownerOnly, rateLimit } from './auth.js';
import { stationEvidence } from '../shared/station-policy.js';

const queryRows = async (prepared) => (await prepared.all()).results;
const zoneOffset = 8 * 3600_000;
const periodSizes = { month: 12, day: 31, hour: 24 };
const riskKinds = new Set([...Object.keys(riskLabels), 'fraud_risk']);
const eventStatuses = new Set(['open', 'acknowledged', 'intervention_requested', 'resolved']);

export async function requireWorkspace(db, id, user) {
  const workspace = await db.prepare('SELECT id,name,created_at FROM workspaces WHERE id=?').bind(id).first();
  if (!workspace || (id !== 'main' && user.role !== 'owner' &&
    !await db.prepare('SELECT 1 FROM workspace_access WHERE workspace_id=? AND user_id=?').bind(id, user.id).first())) {
    throw new ApiError(404, '工作区不存在或无访问权限');
  }
  return workspace;
}

function dateString(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw new ApiError(400, '时间格式不正确');
  return new Date(value).toISOString();
}

export function calendar(period, date) {
  if (!Object.hasOwn(periodSizes, period)) throw new ApiError(400, '统计周期不正确');
  const day = date || new Date(Date.now() + zoneOffset).toISOString().slice(0, 10);
  if (!/^20\d\d-\d\d-\d\d$/.test(day) || dateString(day).slice(0, 10) !== day)
    throw new ApiError(400, '日期格式不正确');
  const [year, month, dateOfMonth] = day.split('-').map(Number);
  const monthly = period === 'month';
  const daily = period === 'day';
  const begin = Date.UTC(year, monthly ? 0 : month - 1, monthly || daily ? 1 : dateOfMonth);
  const end = monthly ? Date.UTC(year + 1, 0, 1) :
    daily ? Date.UTC(year, month, 1) : begin + 24 * 3600_000;
  const count = daily ? new Date(Date.UTC(year, month, 0)).getUTCDate() : periodSizes[period];
  const buckets = Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    label: monthly ? `${i + 1}月` : daily ? `${i + 1}日` : `${String(i).padStart(2, '0')}:00`,
    levels: [0, 0, 0],
  }));
  return {
    period, date: day, timezone: 'Asia/Shanghai', buckets,
    start: new Date(begin - zoneOffset).toISOString(), end: new Date(end - zoneOffset).toISOString(),
    format: monthly ? '%m' : daily ? '%d' : '%H',
  };
}

function cleanHistory(values) {
  if (!Array.isArray(values)) return [];
  return values.slice(-60).map((entry) => ({
    action: text(entry.action, 64),
    severity: integer(entry.severity, 0, 3),
    occurred_at: dateString(entry.occurred_at),
    observed_frames: integer(entry.observed_frames ?? 0, 0, 1_000_000_000),
  }));
}

export function sanitizeRecord(kind, record) {
  if (!record || typeof record !== 'object' || Array.isArray(record))
    throw new ApiError(400, '归档记录格式不正确');
  const base = { id: identifier(record.id) };
  if (kind === 'device') {
    return {
      ...base, name: text(record.name, 80), platform: text(record.platform, 24),
      location: text(record.location || '', 120),
      fusion_group: text(record.fusion_group || '', 32),
      last_seen: record.last_seen ? dateString(record.last_seen) : null,
      revoked: record.revoked === true,
    };
  }
  if (kind === 'staff') {
    return { ...base, name: text(record.name, 80), role: record.role === 'owner' ? 'owner' : 'staff' };
  }
  if (kind !== 'event' || !riskKinds.has(record.risk_kind) || !eventStatuses.has(record.status))
    throw new ApiError(400, '归档类型或事件状态不正确');
  const evidence = Array.isArray(record.evidence) ? [...new Set(record.evidence.filter(
    (code) => typeof code === 'string' && Object.hasOwn(stationEvidence, code),
  ))].slice(0, 12) : [];
  return {
    ...base, device_id: identifier(record.device_id), device_name: text(record.device_name, 80),
    location: text(record.location || '', 120), risk_kind: record.risk_kind,
    status: record.status, severity: integer(record.severity, 1, 3),
    occurred_at: dateString(record.occurred_at), updated_at: dateString(record.updated_at),
    handled_by_name: text(record.handled_by_name || '', 100),
    handled_at: record.handled_at ? dateString(record.handled_at) : null,
    disposition: text(record.disposition || '', 24),
    observed_frames: integer(record.observed_frames ?? 0, 0, 1_000_000_000),
    signal_ended_at: record.signal_ended_at ? dateString(record.signal_ended_at) : null,
    risk_score: Number.isSafeInteger(record.risk_score) ? integer(record.risk_score, 0, 100) : null,
    is_test: !!record.is_test, evidence,
    updates: cleanHistory(record.updates),
    snapshot: record.snapshot ? validSnapshot(record.snapshot) : null,
  };
}

export async function archiveIngress(request, env) {
  if (env.DEPLOYMENT_MODE === 'edge' || request.method !== 'POST')
    throw new ApiError(404, '归档接口不可用');
  const secret = request.headers.get('Authorization')?.match(/^Bearer (pge_[A-Za-z0-9_-]{35,100})$/)?.[1];
  if (!secret) throw new ApiError(401, '需要边端归档密钥');
  const relay = await env.DB.prepare('SELECT id,workspace_id FROM workspace_relays WHERE token_hash=? AND revoked_at IS NULL')
    .bind(await digest(secret)).first();
  if (!relay) throw new ApiError(401, '归档密钥无效或已停用');
  await rateLimit(env, `archive:${relay.id}`, 180, 60);
  const input = await body(request, 610_000);
  if (!Array.isArray(input.records) || input.records.length > 20)
    throw new ApiError(400, '每批归档最多 20 条');
  const statements = input.records.map((entry) => {
    const value = sanitizeRecord(entry.kind, entry.record);
    return env.DB.prepare(`
      INSERT INTO workspace_records(workspace_id,relay_id,kind,entity_id,source_seq,timestamp,severity,active,payload_json)
      VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(workspace_id,relay_id,kind,entity_id) DO UPDATE SET
        source_seq=excluded.source_seq,timestamp=excluded.timestamp,severity=excluded.severity,
        active=excluded.active,payload_json=excluded.payload_json
      WHERE excluded.source_seq > workspace_records.source_seq
    `).bind(relay.workspace_id, relay.id, entry.kind, value.id, integer(entry.seq, 1, Number.MAX_SAFE_INTEGER),
      value.occurred_at || value.last_seen || null, value.severity || 0,
      value.revoked ? 0 : 1, JSON.stringify(value));
  });
  statements.push(env.DB.prepare('UPDATE workspace_relays SET last_seen=? WHERE id=? AND revoked_at IS NULL')
    .bind(now(), relay.id));
  await env.DB.batch(statements);
  return json({ ok: true, accepted: input.records.map((entry) => entry.seq) });
}

function archivalList(record) {
  const { snapshot, updates, ...summary } = parse(record.payload_json, {});
  return {
    ...summary, relay_id: record.relay_id, edge_name: record.edge_name,
    has_snapshot: !!snapshot,
  };
}

async function analytics(env, workspace, url) {
  const series = calendar(url.searchParams.get('period') || 'day', url.searchParams.get('date'));
  const summary = await env.DB.batch([
    env.DB.prepare(`SELECT CAST(strftime(?,timestamp,'+8 hours') AS INTEGER) AS slot, severity, COUNT(*) AS n
      FROM workspace_records WHERE workspace_id=? AND kind='event' AND timestamp>=? AND timestamp<?
      AND COALESCE(json_extract(payload_json,'$.is_test'),0)=0 GROUP BY slot,severity`)
      .bind(series.format, workspace.id, series.start, series.end),
    env.DB.prepare(`SELECT kind,COUNT(*) AS n FROM workspace_records WHERE workspace_id=? AND active=1 GROUP BY kind`)
      .bind(workspace.id),
    ...(workspace.id === 'main' ? [
      env.DB.prepare(`SELECT CAST(strftime(?,occurred_at,'+8 hours') AS INTEGER) AS slot,
        severity,COUNT(*) AS n FROM incidents JOIN devices ON devices.id=incidents.device_id
        WHERE occurred_at>=? AND occurred_at<? AND devices.is_test=0 GROUP BY slot,severity`)
        .bind(series.format, series.start, series.end),
      env.DB.prepare(`SELECT 'event' AS kind,COUNT(*) AS n FROM incidents
        UNION ALL SELECT 'device',COUNT(*) FROM devices WHERE revoked_at IS NULL
        UNION ALL SELECT 'staff',COUNT(*) FROM users`),
    ] : []),
  ]);
  for (const row of [...summary[0].results, ...(summary[2]?.results || [])]) {
    const index = row.slot - (series.period === 'hour' ? 0 : 1);
    if (row.severity >= 1 && row.severity <= 3 && series.buckets[index])
      series.buckets[index].levels[row.severity - 1] += row.n;
  }
  const counts = { event: 0, device: 0, staff: 0 };
  for (const row of [...summary[1].results, ...(summary[3]?.results || [])])
    counts[row.kind] += row.n;
  const relays = await queryRows(env.DB.prepare(`SELECT id,name,last_seen FROM workspace_relays
    WHERE workspace_id=? AND revoked_at IS NULL ORDER BY name`).bind(workspace.id));
  return json({ workspace, counts, series: { period: series.period, date: series.date,
    timezone: series.timezone, buckets: series.buckets }, relays });
}

export async function workspaceRoute(request, env, user, url) {
  const path = url.pathname;
  if (path !== '/api/workspaces' && !path.startsWith('/api/workspaces/')) return null;
  if (env.DEPLOYMENT_MODE === 'edge') throw new ApiError(404, '边端只有本网点');
  if (path === '/api/workspaces' && request.method === 'GET') {
    const rows = user.role === 'owner' ?
      await queryRows(env.DB.prepare(`SELECT id,name,created_at FROM workspaces ORDER BY id<>'main',name`)) :
      await queryRows(env.DB.prepare(`SELECT id,name,created_at FROM workspaces
        WHERE id='main' OR id IN (SELECT workspace_id FROM workspace_access WHERE user_id=?)
        ORDER BY id<>'main',name`).bind(user.id));
    return json({ workspaces: rows, can_create: user.role === 'owner' });
  }
  if (path === '/api/workspaces' && request.method === 'POST') {
    ownerOnly(user);
    const name = text((await body(request, 2000)).name, 48);
    if (!name) throw new ApiError(400, '请输入工作区名称');
    const id = uid();
    const result = await env.DB.prepare('INSERT OR IGNORE INTO workspaces(id,name,created_at) VALUES(?,?,?)')
      .bind(id, name, now()).run();
    if (!result.meta.changes) throw new ApiError(409, '工作区名称已存在');
    await audit(env, user.email, 'workspace_created', id, { name });
    return json({ workspace: { id, name } }, 201);
  }
  const parts = path.split('/').slice(3).map(identifier);
  if (parts.length < 2) throw new ApiError(404, '工作区接口不存在');
  const workspace = await requireWorkspace(env.DB, parts[0], user);
  const [id, route, relayId, entityId] = parts;
  if (route === 'dashboard' && request.method === 'GET') return analytics(env, workspace, url);
  if (['event', 'device', 'staff'].includes(route) && request.method === 'GET' && parts.length === 2) {
    const offset = integer(Number(url.searchParams.get('offset') || 0), 0, 50000);
    const items = await queryRows(env.DB.prepare(`
      SELECT r.relay_id,r.payload_json,s.name AS edge_name FROM workspace_records r
      JOIN workspace_relays s ON s.id=r.relay_id WHERE r.workspace_id=? AND r.kind=?
      ORDER BY r.timestamp DESC,r.relay_id,r.entity_id LIMIT 41 OFFSET ?
    `).bind(id, route, offset));
    return json({ records: items.slice(0, 40).map(archivalList), next_offset: items.length > 40 ? offset + 40 : null });
  }
  if (route === 'event' && parts.length === 4 && request.method === 'GET') {
    const row = await env.DB.prepare(`SELECT r.payload_json,s.name AS edge_name FROM workspace_records r
      JOIN workspace_relays s ON s.id=r.relay_id WHERE r.workspace_id=? AND r.relay_id=? AND kind='event' AND entity_id=?`)
      .bind(id, relayId, entityId).first();
    if (!row) throw new ApiError(404, '归档事件不存在');
    return json({ record: { ...parse(row.payload_json, {}), edge_name: row.edge_name } });
  }
  if (route === 'relays' && parts.length <= 3) {
    ownerOnly(user);
    if (request.method === 'POST' && parts.length === 2) {
      const name = text((await body(request, 2000)).name, 80);
      if (!name) throw new ApiError(400, '请输入边端名称');
      const secret = 'pge_' + randomToken();
      const relay = uid();
      await env.DB.prepare('INSERT INTO workspace_relays(id,workspace_id,name,token_hash,created_at) VALUES(?,?,?,?,?)')
        .bind(relay, id, name, await digest(secret), now()).run();
      await audit(env, user.email, 'station_relay_registered', relay, { workspace_id: id });
      return json({ relay_id: relay, workspace_id: id, server_url: env.PUBLIC_ORIGIN, token: secret }, 201);
    }
    if (request.method === 'DELETE' && parts.length === 3) {
      const result = await env.DB.prepare('UPDATE workspace_relays SET revoked_at=? WHERE id=? AND workspace_id=? AND revoked_at IS NULL')
        .bind(now(), relayId, id).run();
      if (!result.meta.changes) throw new ApiError(404, '边端不存在或已停用');
      await audit(env, user.email, 'station_relay_revoked', relayId, { workspace_id: id });
      return json({ ok: true });
    }
  }
  if (route === 'access' && parts.length <= 3) {
    ownerOnly(user);
    if (request.method === 'GET' && parts.length === 2) {
      const rows = await queryRows(env.DB.prepare(`SELECT u.id,u.name,u.email,u.role,
        CASE WHEN a.user_id IS NOT NULL OR u.role='owner' OR ?='main' THEN 1 ELSE 0 END allowed
        FROM users u LEFT JOIN workspace_access a ON a.user_id=u.id AND a.workspace_id=?
        ORDER BY u.role<>'owner',u.name`).bind(id, id));
      return json({ members: rows });
    }
    if (id !== 'main' && parts.length === 3 && ['PUT', 'DELETE'].includes(request.method)) {
      const member = await env.DB.prepare('SELECT id,role FROM users WHERE id=?').bind(relayId).first();
      if (!member || member.role === 'owner') throw new ApiError(400, '只能管理普通成员的区域访问');
      if (request.method === 'PUT')
        await env.DB.prepare('INSERT OR IGNORE INTO workspace_access(workspace_id,user_id,created_at) VALUES(?,?,?)')
          .bind(id, member.id, now()).run();
      else await env.DB.prepare('DELETE FROM workspace_access WHERE workspace_id=? AND user_id=?').bind(id, member.id).run();
      await audit(env, user.email, request.method === 'PUT' ? 'workspace_access_granted' : 'workspace_access_revoked',
        member.id, { workspace_id: id });
      return json({ ok: true });
    }
  }
  throw new ApiError(404, '工作区接口不存在');
}
