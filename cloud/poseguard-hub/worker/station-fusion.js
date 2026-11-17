import { ApiError, identifier, json, now, parse, uid, validSnapshot } from './utils.js';
import { rateLimit } from './auth.js';
import { combineStationSignals, stationEvidence, stationWindowMs } from '../shared/station-policy.js';

const visualCodes = {
  phone_to_ear: 'vision_phone',
  multi_person: 'vision_multi_person',
  lingering: 'vision_lingering',
};

export function fusionGroup(value) {
  if (value === '') return '';
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(value))
    throw new ApiError(400, '融合分组须为 1–32 位字母、数字、下划线或短横线');
  return value;
}

function stationRoom(env, scope) {
  return env.ROOMS.get(env.ROOMS.idFromName('station-fusion:' + scope));
}

function scopeFor(device) {
  const group = parse(device.config_json, {}).fusion_group;
  const scope = group ? 'group:' + fusionGroup(group) : 'device:' + device.id;
  return device.is_test ? 'test:' + scope : scope;
}

function captureTime(value) {
  const stamp = typeof value === 'string' ? Date.parse(value) : NaN;
  const stampNow = Date.now();
  if (!Number.isFinite(stamp) || stamp < stampNow - stationWindowMs || stamp > stampNow + 5000)
    throw new ApiError(422, '信号已过期，请校对设备与边端时间');
  return Math.min(stamp, stampNow);
}

function sendToRoom(env, device, signal, snapshot) {
  const scope = scopeFor(device);
  return stationRoom(env, scope).fetch('https://station/internal/fusion', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, device_id: device.id, ...signal, snapshot }),
  });
}

export async function acceptStationSignal(env, device, input) {
  if (env.DEPLOYMENT_MODE !== 'edge') throw new ApiError(404, '此接口由网点边端提供');
  const modality = device.platform === 'speech' ? 'speech' :
    device.platform === 'transaction' ? 'transaction' : null;
  if (!modality) throw new ApiError(403, '该设备未绑定为语音或交易信号源');
  await rateLimit(env, 'station:' + device.id, 60, 60);
  if (!Array.isArray(input.codes) || !input.codes.length || input.codes.length > 8 ||
      input.codes.some((code) => !Object.hasOwn(stationEvidence, code) || stationEvidence[code].modality !== modality))
    throw new ApiError(400, '信号类型与已绑定设备不匹配');
  if (!Number.isFinite(input.confidence) || input.confidence < .42 || input.confidence > 1)
    throw new ApiError(400, '信号置信度不正确');
  return sendToRoom(env, device, {
    signal_id: identifier(input.signal_id), codes: [...new Set(input.codes)],
    confidence: input.confidence, captured_at: captureTime(input.captured_at),
  });
}

export async function forwardVision(env, device, input) {
  if (env.DEPLOYMENT_MODE !== 'edge' || !parse(device.config_json, {}).fusion_group ||
      !Object.hasOwn(visualCodes, input.risk_kind) || !['created', 'escalated'].includes(input.update_type))
    return;
  let stamp;
  try { stamp = captureTime(input.updated_at || input.occurred_at); } catch { return; }
  let snapshot;
  try { snapshot = validSnapshot(input.snapshot); } catch { /* The original event already has validation. */ }
  const response = await sendToRoom(env, device, {
    signal_id: `vision:${input.event_id}:${input.revision}`,
    codes: [visualCodes[input.risk_kind]], confidence: input.confirmed_seen ? .95 : .70,
    captured_at: stamp,
  }, snapshot);
  if (!response.ok) throw new Error('Station fusion did not accept the visual signal');
}

async function signalExpiry(env, scope, writeEvent, stampNow) {
  const previous = await env.DB.prepare('SELECT * FROM station_cases WHERE scope=?').bind(scope).first();
  if (!previous || previous.last_signal_at > stampNow - stationWindowMs) return previous;
  const device = await env.DB.prepare('SELECT * FROM devices WHERE id=?').bind(previous.device_id).first();
  if (device && previous.revision && previous.level > 0) {
    const saved = await env.DB.prepare(`SELECT risk_score,evidence_json FROM incidents
      WHERE device_id=? AND client_event_id=?`).bind(previous.device_id, previous.case_key).first();
    const response = await writeEvent(device, {
      event_id: previous.case_key, revision: previous.revision + 1,
      risk_kind: 'fraud_risk', model_state: previous.level >= 2 ? 'alert' : 'candidate',
      observed_frames: 0, occurred_at: new Date(previous.occurred_at).toISOString(),
      updated_at: now(), update_type: 'resolved', termination_reason: 'evidence_window_elapsed',
      summary: '多模态证据采集窗口已结束，事件等待人工核查',
    }, { level: previous.level, score: saved?.risk_score ?? 0, evidence: parse(saved?.evidence_json, []) });
    if (!response.ok) throw new Error('Could not close the station signal window');
  }
  await env.DB.prepare('DELETE FROM station_cases WHERE scope=? AND case_key=?').bind(scope, previous.case_key).run();
  return null;
}

export async function processStationRoom(request, env, writeEvent) {
  if (env.DEPLOYMENT_MODE !== 'edge') throw new ApiError(404, '边端风险融合未启用');
  const input = await request.json();
  const stampNow = Date.now();
  let active = await signalExpiry(env, input.scope, writeEvent, stampNow);
  if (input.expire === true) return json({ ok: true });
  const origin = await env.DB.prepare('SELECT * FROM devices WHERE id=? AND revoked_at IS NULL').bind(input.device_id).first();
  if (!origin || scopeFor(origin) !== input.scope) throw new ApiError(403, '边端信号来源不正确');
  await env.DB.batch([
    ...input.codes.map(code => env.DB.prepare(`INSERT OR IGNORE INTO station_signals
      (device_id,signal_id,scope,code,confidence,captured_at) VALUES(?,?,?,?,?,?)`)
      .bind(origin.id, input.signal_id, input.scope, code, input.confidence, input.captured_at)),
    env.DB.prepare('UPDATE devices SET last_seen=CASE WHEN last_seen IS NULL OR last_seen<? THEN ? ELSE last_seen END WHERE id=?')
      .bind(now(), now(), origin.id),
  ]);
  const rows = (await env.DB.prepare(`SELECT code,MAX(confidence) AS confidence,MAX(captured_at) AS source_time
    FROM station_signals WHERE scope=? AND captured_at>? GROUP BY code`)
    .bind(input.scope, stampNow - stationWindowMs).all()).results;
  const decision = combineStationSignals(rows);
  // Visual-only evidence already has its own event/notification pipeline.
  const level = decision.modalities.every(modality => modality === 'vision') ? 0 : decision.level;
  if (!level && !active) return json({ accepted: true, level: 0, score: decision.score });
  const at = Math.max(input.captured_at, active?.last_signal_at ?? 0);
  if (!active) {
    active = {
      scope: input.scope, case_key: 'fusion-' + uid(), device_id: origin.id,
      occurred_at: input.captured_at, last_signal_at: at, revision: 0, level: 0, evidence_key: '',
    };
    await env.DB.prepare(`INSERT INTO station_cases(scope,case_key,device_id,occurred_at,last_signal_at)
      VALUES(?,?,?,?,?)`).bind(input.scope, active.case_key, origin.id, active.occurred_at, at).run();
  }
  const peak = Math.max(level, active.level);
  const evidence = decision.evidence.map(({ code }) => code);
  const signature = evidence.join(',');
  let incident;
  if (level > 0 && (!active.revision || peak > active.level || signature !== active.evidence_key)) {
    const anchor = active.device_id === origin.id ? origin :
      (await env.DB.prepare('SELECT * FROM devices WHERE id=?').bind(active.device_id).first());
    if (!anchor) throw new ApiError(409, '融合事件缺少关联设备');
    const revision = active.revision + 1;
    const result = await writeEvent(anchor, {
      event_id: active.case_key, revision, risk_kind: 'fraud_risk',
      model_state: peak >= 2 ? 'alert' : 'candidate', observed_frames: 0,
      occurred_at: new Date(active.occurred_at).toISOString(), updated_at: now(),
      update_type: active.revision ? 'escalated' : 'created',
      summary: evidence.map(code => stationEvidence[code].label).join('、'),
      snapshot: input.snapshot || undefined,
    }, { level: peak, score: decision.score, evidence });
    if (!result.ok) throw new Error('Could not record station incident');
    incident = (await result.json()).incident_id;
    await env.DB.prepare('UPDATE station_cases SET revision=?,level=?,evidence_key=? WHERE scope=? AND case_key=?')
      .bind(revision, peak, signature, active.scope, active.case_key).run();
  }
  await env.DB.prepare('UPDATE station_cases SET last_signal_at=? WHERE scope=? AND case_key=?')
    .bind(at, active.scope, active.case_key).run();
  return json({ accepted: true, level: peak, score: decision.score, incident_id: incident || null });
}

export async function stationMaintenance(env) {
  if (env.DEPLOYMENT_MODE !== 'edge') return;
  const expired = (await env.DB.prepare('SELECT scope FROM station_cases WHERE last_signal_at<=? LIMIT 64')
    .bind(Date.now() - stationWindowMs).all()).results;
  for (const { scope } of expired) {
    try {
      await stationRoom(env, scope).fetch('https://station/internal/fusion', {
        method: 'POST', body: JSON.stringify({ scope, expire: true }),
      });
    } catch { /* Preserve the previous episode and try on the next sweep. */ }
  }
  await env.DB.prepare('DELETE FROM station_signals WHERE captured_at<?').bind(Date.now() - 86_400_000).run();
}
