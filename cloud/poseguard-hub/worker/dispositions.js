import {
  ApiError,
  audit,
  body,
  digest,
  identifier,
  json,
  now,
  parse,
  text,
  uid,
} from './utils.js';
import { broadcastChange } from './notify.js';
import { messageAudience } from './message-policy.js';
import { dispositionDefaults } from '../shared/disposition-defaults.js';
export const dispositionNames = {
  false_positive: '误检',
  not_intervened: '未介入',
  intervened: '已介入',
  no_risk: '无风险',
};

export async function dispositionRoute(request, env, user, url, ctx) {
  const match = url.pathname.match(
    /^\/api\/events\/([^/]+)\/(disposition-confirmation|disposition)$/,
  );
  if (!match || request.method !== 'POST') return null;
  const id = identifier(match[1]);
  const event = await env.DB.prepare('SELECT * FROM incidents WHERE id=?')
    .bind(id)
    .first();
  if (!event) throw new ApiError(404, '事件不存在');
  const timestamp = Date.now();
  if (match[2] === 'disposition-confirmation') {
    if (user.role === 'owner')
      return json({
        confirmation_id: null,
        not_before: timestamp,
        server_time: timestamp,
        requires_wait: false,
      });
    const confirmationId = uid();
    await env.DB.prepare(
      'INSERT INTO disposition_confirmations(id,user_id,incident_id,not_before,expires_at) VALUES(?,?,?,?,?)',
    )
      .bind(confirmationId, user.id, id, timestamp + 3000, timestamp + 600000)
      .run();
    return json({
      confirmation_id: confirmationId,
      not_before: timestamp + 3000,
      server_time: timestamp,
      requires_wait: true,
    });
  }
  const input = await body(request, 10000),
    outcome = text(input.outcome || '', 30),
    requestId = identifier(input.request_id);
  if (!dispositionNames[outcome])
    throw new ApiError(400, '请选择误检、未介入、已介入或无风险');
  const note = text(input.note || '', 2000) || dispositionDefaults[outcome];
  const hash = await digest(JSON.stringify({ event: id, outcome, note })),
    recordId = 'dp_' + (await digest(user.id + ':' + requestId)).slice(0, 40);
  const previous = await env.DB.prepare(
    'SELECT * FROM event_dispositions WHERE id=?',
  )
    .bind(recordId)
    .first();
  if (previous) {
    if (previous.payload_hash !== hash)
      throw new ApiError(409, '提交标识已用于其他处置记录');
    return json({ record: previous, duplicate: true });
  }
  let confirmation = null;
  if (user.role !== 'owner') {
    confirmation = await env.DB.prepare(
      'SELECT * FROM disposition_confirmations WHERE id=? AND user_id=? AND incident_id=?',
    )
      .bind(identifier(input.confirmation_id), user.id, id)
      .first();
    if (
      !confirmation ||
      confirmation.used_at ||
      confirmation.expires_at < timestamp
    )
      throw new ApiError(409, '确认已过期，请重新打开处置界面');
    if (confirmation.not_before > timestamp)
      throw new ApiError(425, '请等待 3 秒确认后再提交', 'confirmation_wait');
  }
  const created = now(),
    status = 'resolved',
    final = true;
  const guard = confirmation
    ? `EXISTS(SELECT 1 FROM disposition_confirmations WHERE id='${identifier(confirmation.id)}' AND claim_nonce='${recordId}')`
    : '1=1';
  const accepted = `EXISTS(SELECT 1 FROM event_dispositions WHERE id='${recordId}' AND payload_hash='${hash}')`;
  const tasks = (
    await env.DB.prepare(
      "SELECT id,sender_id,recipient_id FROM personal_messages WHERE event_id=? AND kind='intervention' AND completed_at IS NULL",
    )
      .bind(id)
      .all()
  ).results;
  const statements = [];
  if (confirmation)
    statements.push(
      env.DB.prepare(
        'UPDATE disposition_confirmations SET used_at=?,claim_nonce=? WHERE id=? AND used_at IS NULL AND not_before<=? AND expires_at>=?',
      ).bind(created, recordId, confirmation.id, timestamp, timestamp),
    );
  statements.push(
    env.DB.prepare(
      `INSERT OR IGNORE INTO event_dispositions(id,incident_id,user_id,user_name,outcome,note,created_at,request_id,payload_hash) SELECT ?,?,?,?,?,?,?,?,? WHERE ${guard}`,
    ).bind(
      recordId,
      id,
      user.id,
      user.name,
      outcome,
      note,
      created,
      requestId,
      hash,
    ),
    env.DB.prepare(
      `UPDATE incidents SET status=?,handled_by=?,handled_by_name=?,handled_at=(SELECT created_at FROM event_dispositions WHERE id=?),disposition=?,acknowledged_at=COALESCE(acknowledged_at,?),acknowledged_by=?,resolved_at=?,updated_at=? WHERE id=? AND ${accepted}`,
    ).bind(
      status,
      user.id,
      user.name,
      recordId,
      outcome,
      created,
      user.name,
      final ? created : null,
      created,
      id,
    ),
    env.DB.prepare(
      `INSERT INTO incident_updates(incident_id,device_id,action,severity,observed_frames,actor,occurred_at,received_at,details_json) SELECT ?,?,'record-disposition',?,?,?,?,?,? WHERE ${accepted} AND NOT EXISTS(SELECT 1 FROM incident_updates WHERE incident_id=? AND json_extract(details_json,'$.disposition_id')=?)`,
    ).bind(
      id,
      event.device_id,
      event.severity,
      event.observed_frames,
      user.name,
      created,
      created,
      JSON.stringify({ disposition_id: recordId, outcome, note }),
      id,
      recordId,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO changes(category,entity_id,action,data_json,created_at,dedupe_key) SELECT 'event',?,'record-disposition',?,?,? WHERE ${accepted}`,
    ).bind(
      id,
      JSON.stringify({
        event_id: id,
        device_id: event.device_id,
        status,
        handled_by_name: user.name,
        handled_at: created,
        disposition: outcome,
        notify: false,
      }),
      created,
      'disposition:' + recordId,
    ),
  );
  for (const task of tasks)
    statements.push(
      env.DB.prepare(
        `UPDATE personal_messages SET read_at=CASE WHEN recipient_id=? THEN COALESCE(read_at,?) ELSE read_at END,acknowledged_at=CASE WHEN recipient_id=? THEN COALESCE(acknowledged_at,?) ELSE acknowledged_at END,completed_at=?,completion_note=?,updated_at=? WHERE id=? AND ${accepted}`,
      ).bind(
        user.id,
        created,
        user.id,
        created,
        created,
        task.recipient_id === user.id
          ? note
          : `事件已由${user.name}完成处置（${dispositionNames[outcome]}）：${note}`,
        created,
        task.id,
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO changes(category,entity_id,action,data_json,created_at,audience_json,dedupe_key) SELECT 'message',?,'disposition',?,?,?,? WHERE ${accepted}`,
      ).bind(
        task.id,
        JSON.stringify({
          message_id: task.id,
          recipient_id: task.recipient_id,
          notify: false,
        }),
        created,
        messageAudience(task.sender_id, task.recipient_id),
        'message-disposition:' + recordId + ':' + task.id,
      ),
    );
  await env.DB.batch(statements);
  const record = await env.DB.prepare(
    'SELECT * FROM event_dispositions WHERE id=?',
  )
    .bind(recordId)
    .first();
  if (!record) throw new ApiError(409, '该次确认已使用，请重新打开处置界面');
  if (record.payload_hash !== hash) throw new ApiError(409, '处置提交标识冲突');
  const changeKeys = [
    'disposition:' + recordId,
    ...tasks.map((task) => 'message-disposition:' + recordId + ':' + task.id),
  ];
  const changes = (
    await env.DB.prepare(
      `SELECT * FROM changes WHERE dedupe_key IN (${changeKeys.map(() => '?').join(',')})`,
    )
      .bind(...changeKeys)
      .all()
  ).results;
  ctx.waitUntil(
    Promise.all(
      changes.map((change) =>
        broadcastChange(env, { ...change, data: parse(change.data_json, {}) }),
      ),
    ),
  );
  await audit(env, user.email, 'record_disposition', id, { outcome });
  return json({ record, duplicate: false }, 201);
}
