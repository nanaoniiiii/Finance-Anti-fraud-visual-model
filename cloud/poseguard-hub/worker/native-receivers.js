import {
  ApiError,
  body,
  digest,
  identifier,
  integer,
  json,
  now,
  parse,
  randomToken,
  text,
  uid,
} from './utils.js';
export async function enrollReceiver(env, user, input) {
  const install = identifier(input.installation_id);
  const ids = Array.isArray(input.device_ids)
    ? input.device_ids.map(identifier)
    : [];
  for (const id of ids)
    if (
      !(await env.DB.prepare(
        'SELECT id FROM devices WHERE id=? AND revoked_at IS NULL'
      )
        .bind(id)
        .first())
    )
      throw new ApiError(400, '关联设备不存在');
  const previous = await env.DB.prepare(
    'SELECT id FROM native_receivers WHERE user_id=? AND installation_id=?'
  )
    .bind(user.id, install)
    .first();
  const id = previous?.id || uid();
  const token = 'pgm_' + randomToken();
  await env.DB.prepare(
    'INSERT INTO native_receivers(id,user_id,installation_id,label,device_ids_json,token_hash,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,installation_id) DO UPDATE SET label=excluded.label,device_ids_json=excluded.device_ids_json,token_hash=excluded.token_hash,revoked_at=NULL,last_error=NULL'
  )
    .bind(
      id,
      user.id,
      install,
      text(input.label || 'Android 原生接收端', 80),
      JSON.stringify(ids),
      await digest(token),
      now()
    )
    .run();
  const cursor = (
    await env.DB.prepare(
      'SELECT COALESCE(MAX(seq),0) AS seq FROM changes'
    ).first()
  ).seq;
  return json({ id, receiver_token: token, poll_seconds: 6, cursor }, 201);
}
async function authenticate(request, env) {
  const token = request.headers
    .get('Authorization')
    ?.match(/^Bearer (pgm_[A-Za-z0-9_-]+)$/)?.[1];
  if (!token) throw new ApiError(401, '缺少接收端密钥');
  const receiver = await env.DB.prepare(
    'SELECT * FROM native_receivers WHERE token_hash=? AND revoked_at IS NULL'
  )
    .bind(await digest(token))
    .first();
  if (!receiver) throw new ApiError(401, '接收端已解除绑定');
  return receiver;
}
function allowed(receiver, change) {
  const data = parse(change.data_json, {});
  if (!data.notify) return false;
  if (change.category === 'notification')
    return data.receiver_id === receiver.id;
  const ids = parse(receiver.device_ids_json, []);
  return (
    ['event', 'device'].includes(change.category) &&
    (!ids.length || ids.includes(data.device_id))
  );
}
export async function mobileRoute(request, env, url) {
  const receiver = await authenticate(request, env);
  if (url.pathname === '/api/mobile/changes' && request.method === 'GET') {
    await env.DB.prepare('UPDATE native_receivers SET last_seen=? WHERE id=?')
      .bind(now(), receiver.id)
      .run();
    const max = (
      await env.DB.prepare(
        'SELECT COALESCE(MAX(seq),0) AS seq FROM changes'
      ).first()
    ).seq;
    if (url.searchParams.get('bootstrap') === '1')
      return json({ cursor: max, changes: [] });
    const after = integer(
      Number(url.searchParams.get('after') || 0),
      0,
      Number.MAX_SAFE_INTEGER
    );
    const rows = (
      await env.DB.prepare(
        'SELECT * FROM changes WHERE seq>? ORDER BY seq LIMIT 100'
      )
        .bind(after)
        .all()
    ).results;
    return json({
      cursor: rows.length ? rows.at(-1).seq : max,
      changes: rows
        .filter((change) => allowed(receiver, change))
        .map((change) => ({ ...change, data: parse(change.data_json, {}) })),
    });
  }
  if (url.pathname === '/api/mobile/ack' && request.method === 'POST') {
    const input = await body(request, 4000);
    const seq = integer(input.seq, 1, Number.MAX_SAFE_INTEGER);
    const change = await env.DB.prepare('SELECT * FROM changes WHERE seq=?')
      .bind(seq)
      .first();
    if (!change || !allowed(receiver, change))
      throw new ApiError(404, '通知不存在');
    await env.DB.batch([
      env.DB.prepare(
        'INSERT OR IGNORE INTO notification_jobs(id,incident_id,change_seq,channel,target,payload_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)'
      ).bind(
        uid(),
        change.category === 'event' ? change.entity_id : null,
        seq,
        'android',
        receiver.id,
        change.data_json,
        'posted',
        now(),
        now()
      ),
      env.DB.prepare(
        'UPDATE native_receivers SET last_success=?,last_error=NULL WHERE id=?'
      ).bind(now(), receiver.id),
    ]);
    return json({ ok: true, status: 'posted' });
  }
  throw new ApiError(404, '移动接收接口不存在');
}
