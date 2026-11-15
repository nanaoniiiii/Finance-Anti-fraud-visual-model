import {
  ApiError,
  audit,
  body,
  digest,
  identifier,
  json,
  now,
  parse,
  riskLabels,
  text,
  uid,
} from './utils.js';
import { ownerOnly, rateLimit } from './auth.js';
import { broadcastChange, emitChange, processJobs } from './notify.js';
import { messageAudience } from './message-policy.js';
import { contactRoute } from './staff-contacts.js';
import { defaultMail, readSetting } from './utils.js';
import { mailConfigured } from './mail.js';
import { defaultInterventionNote } from '../shared/intervention.js';

const rows = async (statement) => (await statement.all()).results;
const joined = 'SELECT * FROM personal_message_records m';
const required = (value, max, label) => {
  const result = text(value || '', max);
  if (!result) throw new ApiError(400, `请填写${label}`);
  return result;
};
async function findMessage(env, user, id) {
  const message = await env.DB.prepare(joined + ' WHERE m.id=?')
    .bind(identifier(id))
    .first();
  if (
    !message ||
    (user.role !== 'owner' &&
      message.sender_id !== user.id &&
      message.recipient_id !== user.id)
  )
    throw new ApiError(404, '个人消息不存在');
  return message;
}
async function createMessages(env, user, input, event, ctx) {
  const kind = event ? 'intervention' : input.kind || 'notice';
  if (
    !['notice', 'inspection', 'intervention'].includes(kind) ||
    (!event && kind === 'intervention')
  )
    throw new ApiError(400, '指定介入通知需要从风险事件发起');
  if (
    !Array.isArray(input.recipient_ids) ||
    (input.contact_ids !== undefined &&
      (!event || !Array.isArray(input.contact_ids))) ||
    input.recipient_ids.length + (input.contact_ids?.length || 0) > 20 ||
    !(input.recipient_ids.length + (input.contact_ids?.length || 0))
  )
    throw new ApiError(400, '请选择 1～20 名指定收件人');
  let recipients = [...new Set(input.recipient_ids.map(identifier))].sort();
  let externalRecipients = [];
  for (const contactId of [
    ...new Set((input.contact_ids || []).map(identifier)),
  ]) {
    const contact = await env.DB.prepare(
      'SELECT * FROM staff_contacts WHERE id=?',
    )
      .bind(contactId)
      .first();
    if (!contact) throw new ApiError(400, '外部联系人不存在');
    const linked = contact.email
      ? await env.DB.prepare('SELECT id FROM users WHERE email=?')
          .bind(contact.email)
          .first()
      : null;
    if (linked) recipients.push(linked.id);
    else externalRecipients.push(contact);
  }
  recipients = [...new Set(recipients)].sort();
  externalRecipients.sort((a, b) => a.id.localeCompare(b.id));
  const recipientCount = recipients.length + externalRecipients.length;
  const emailConfigured=kind==='intervention'&&await mailConfigured(env,{...defaultMail,...await readSetting(env,'mail',{})});
  if (
    externalRecipients.some((contact) => contact.email) &&
    !emailConfigured
  )
    throw new ApiError(
      409,
      '外部联系人的邮件通知需要先配置可用的发信通道；也可添加电话后使用拨号联系。',
    );
  const contacts = recipients.length
    ? await rows(
        env.DB.prepare(
          `SELECT id,name,email FROM users WHERE id IN (${recipients.map(() => '?').join(',')})`,
        ).bind(...recipients),
      )
    : [];
  if (contacts.length !== recipients.length)
    throw new ApiError(400, '所选成员不存在，请刷新成员列表');
  const area = text(input.area || event?.location || '', 160);
  if (kind === 'inspection' && !area)
    throw new ApiError(400, '巡查要求需要指定区域');
  const title = event
    ? `介入处置 · ${riskLabels[event.risk_kind] || '风险事件'}`
    : required(input.title, 120, '消息标题');
  const content = event
    ? required(
        text(input.note || '', 4000) || defaultInterventionNote(event),
        4000,
        '介入说明',
      )
    : required(input.body, 4000, '消息内容');
  let deviceId =
    event?.device_id || (input.device_id ? identifier(input.device_id) : null);
  if (
    deviceId &&
    !(await env.DB.prepare(
      'SELECT id FROM devices WHERE id=? AND revoked_at IS NULL',
    )
      .bind(deviceId)
      .first())
  )
    throw new ApiError(400, '关联设备不存在或已解除绑定');
  if (event?.status === 'resolved')
    throw new ApiError(409, '该事件已经完成处置，请使用巡查要求发起新的检查');
  const requestId = identifier(input.request_id);
  const hash = await digest(
    JSON.stringify({
      kind,
      title,
      content,
      area,
      deviceId,
      eventId: event?.id || null,
      recipients,
      contacts: externalRecipients.map((contact) => contact.id),
      notifyTest: input.notify_test === true,
    }),
  );
  const batchId =
    'mb_' + (await digest(user.id + ':' + requestId)).slice(0, 40);
  const existing = await env.DB.prepare(
    'SELECT payload_hash FROM personal_message_batches WHERE id=?',
  )
    .bind(batchId)
    .first();
  if (existing) {
    if (existing.payload_hash !== hash)
      throw new ApiError(409, '本次发送标识已用于其他内容，请重新创建消息');
    return json({
      messages: await rows(
        env.DB.prepare(joined + ' WHERE m.batch_id=? ORDER BY m.id').bind(
          batchId,
        ),
      ),
      duplicate: true,
    });
  }
  await rateLimit(env, 'personal-message:' + user.id, 30, 60);
  const timestamp = now();
  const guard = `EXISTS(SELECT 1 FROM personal_message_batches WHERE id='${batchId}' AND payload_hash='${hash}')`;
  const fresh = `${guard} AND NOT EXISTS(SELECT 1 FROM personal_messages WHERE batch_id='${batchId}') AND NOT EXISTS(SELECT 1 FROM intervention_contact_deliveries WHERE batch_id='${batchId}')`;
  const statements = [
    env.DB.prepare(
      'INSERT OR IGNORE INTO personal_message_batches(id,sender_id,request_id,payload_hash,created_at) VALUES(?,?,?,?,?)',
    ).bind(batchId, user.id, requestId, hash, timestamp),
  ];
  const active = event
    ? ` AND EXISTS(SELECT 1 FROM incidents WHERE id=? AND status<>'resolved')`
    : '';
  const eventArgs = event ? [event.id] : [];
  const globalKey = 'assignment-status:' + batchId;
  if (event) {
    statements.push(
      env.DB.prepare(
        `UPDATE incidents SET status='intervention_requested',severity=3,staff_requested_at=COALESCE(staff_requested_at,?),updated_at=? WHERE id=? AND ${fresh} AND status<>'resolved'`,
      ).bind(timestamp, timestamp, event.id),
      env.DB.prepare(
        `INSERT OR IGNORE INTO device_commands(id,device_id,incident_id,kind,payload_json,created_at) SELECT ?,?,?,'staff_intervention_requested',?,? WHERE ${fresh}${active}`,
      ).bind(
        batchId,
        deviceId,
        event.id,
        JSON.stringify({
          client_event_id: event.client_event_id,
          severity: 3,
          requested_by: user.name,
          reason: content,
          recipient_ids: recipients,
          area,
        }),
        timestamp,
        ...eventArgs,
      ),
      env.DB.prepare(
        `INSERT INTO incident_updates(incident_id,device_id,action,severity,observed_frames,actor,occurred_at,received_at,details_json) SELECT ?,?,'request-intervention',3,?,?,?,?,? WHERE ${fresh}${active}`,
      ).bind(
        event.id,
        deviceId,
        event.observed_frames,
        user.name,
        timestamp,
        timestamp,
        JSON.stringify({ assigned: true, recipient_count: recipientCount }),
        ...eventArgs,
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO changes(category,entity_id,action,data_json,created_at,dedupe_key) SELECT 'event',?,'request-intervention',?,?,? WHERE ${fresh}${active}`,
      ).bind(
        event.id,
        JSON.stringify({
          ...event,
          status: 'intervention_requested',
          severity: 3,
          notify: false,
        }),
        timestamp,
        globalKey,
        ...eventArgs,
      ),
    );
  }
  for (const contact of externalRecipients) {
    const id = 'px_' + (await digest(batchId + ':' + contact.id)).slice(0, 40);
    const jobId = contact.email
      ? 'em_' + (await digest(id)).slice(0, 40)
      : null;
    const key = 'personal-created:' + id;
    const payload = {
      personal_message_id: id,
      sender_id: user.id,
      title,
      body: content,
      subject: '【PoseGuard】' + title,
      text: `${content}\n\n设备：${event.device_name}\n位置：${area || event.location || '未设置'}\n风险：${riskLabels[event.risk_kind]}\n等级：紧急介入请求\n发出人：${user.name}\n详情：${env.PUBLIC_ORIGIN}/events/${event.id}`,
    };
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO intervention_contact_deliveries(id,batch_id,sender_id,contact_id,device_id,event_id,title,body,area,created_at,email_job_id) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${guard}${active}`,
      ).bind(
        id,
        batchId,
        user.id,
        contact.id,
        deviceId,
        event.id,
        title,
        content,
        area,
        timestamp,
        jobId,
        ...eventArgs,
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO changes(category,entity_id,action,data_json,created_at,audience_json,dedupe_key) SELECT 'message',?,'created',?,?,?,? WHERE EXISTS(SELECT 1 FROM intervention_contact_deliveries WHERE id=?)`,
      ).bind(
        id,
        JSON.stringify({
          message_id: id,
          recipient_id: null,
          kind: 'intervention',
          notify: false,
          is_external: true,
        }),
        timestamp,
        messageAudience(user.id, null),
        key,
        id,
      ),
    );
    if (jobId)
      statements.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO notification_jobs(id,incident_id,change_seq,channel,target,payload_json,status,next_attempt,created_at,updated_at)
      SELECT ?,?,c.seq,'email',?,?,?,0,?,? FROM changes c WHERE c.dedupe_key=?`,
        ).bind(
          jobId,
          event.id,
          contact.email,
          JSON.stringify(payload),
          event.is_test && input.notify_test !== true ? 'suppressed' : 'pending',
          timestamp,
          timestamp,
          key,
        ),
      );
  }
  for (const recipientId of recipients) {
    const id = 'pm_' + (await digest(batchId + ':' + recipientId)).slice(0, 40);
    const audience = messageAudience(user.id, recipientId);
    const notify =
      kind === 'intervention' && (!event.is_test || input.notify_test === true);
    const payload = {
      message_id: id,
      recipient_id: recipientId,
      sender_id: user.id,
      sender_name: user.name,
      kind,
      title,
      body: content,
      area,
      device_id: deviceId,
      event_id: event?.id || null,
      notify,
      severity: kind === 'intervention' ? 3 : 0,
      url: '/messages/' + id,
      timestamp: Date.now(),
    };
    const createdKey = 'personal-created:' + id;
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO personal_messages(id,batch_id,sender_id,recipient_id,kind,title,body,area,device_id,event_id,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard}${active}`,
      ).bind(
        id,
        batchId,
        user.id,
        recipientId,
        kind,
        title,
        content,
        area,
        deviceId,
        event?.id || null,
        timestamp,
        timestamp,
        ...eventArgs,
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO changes(category,entity_id,action,data_json,created_at,audience_json,dedupe_key) SELECT 'message',?,'created',?,?,?,? WHERE EXISTS(SELECT 1 FROM personal_messages WHERE id=? AND batch_id=?)`,
      ).bind(
        id,
        JSON.stringify(payload),
        timestamp,
        audience,
        createdKey,
        id,
        batchId,
      ),
    );
    if (notify)
      statements.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO notification_jobs(id,incident_id,change_seq,channel,target,payload_json,status,next_attempt,created_at,updated_at)
      SELECT ?||':'||p.id,?,c.seq,'webpush',p.id,?,'pending',0,?,? FROM push_subscriptions p JOIN changes c ON c.dedupe_key=?
      WHERE p.user_id=? AND EXISTS(SELECT 1 FROM personal_messages WHERE id=?)`,
        ).bind(
          id,
          event?.id || null,
          JSON.stringify(payload),
          timestamp,
          timestamp,
          createdKey,
          recipientId,
          id,
        ),
      );
  }
  for(const recipientId of recipients) {
    if(kind!=='intervention'||(event.is_test&&input.notify_test!==true))continue;
    const member=contacts.find(contact=>contact.id===recipientId);
    const id='pm_'+(await digest(batchId+':'+recipientId)).slice(0,40);
    const key='personal-created:'+id;
    const payload={personal_message_id:id,sender_id:user.id,recipient_id:recipientId,subject:'【PoseGuard】'+title,
      text:`${content}\n\n设备：${event.device_name}\n位置：${area||event.location||'未设置'}\n发出人：${user.name}\n详情：${env.PUBLIC_ORIGIN}/messages/${id}`};
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO notification_jobs(id,incident_id,change_seq,channel,target,payload_json,status,next_attempt,created_at,updated_at,last_error)
      SELECT ?,?,c.seq,'email',?,?,?,?,?,?,? FROM changes c WHERE c.dedupe_key=?`)
      .bind('pm-email:'+id,event.id,member.email,JSON.stringify(payload),emailConfigured?'pending':'blocked',0,timestamp,timestamp,emailConfigured?null:'发信通道待配置',key));
  }
  await env.DB.batch(statements);
  const accepted = await env.DB.prepare(
    'SELECT payload_hash FROM personal_message_batches WHERE id=?',
  )
    .bind(batchId)
    .first();
  if (accepted.payload_hash !== hash)
    throw new ApiError(409, '发送标识冲突，请重新创建消息');
  const messages = await rows(
    env.DB.prepare(joined + ' WHERE m.batch_id=? ORDER BY m.id').bind(batchId),
  );
  if (messages.length !== recipientCount)
    throw new ApiError(409, '事件状态已变化，请刷新后重试');
  const changes = await rows(
    env.DB.prepare(
      `SELECT * FROM changes WHERE (category='message' AND entity_id IN (${messages.map(() => '?').join(',')})) OR dedupe_key=? ORDER BY seq`,
    ).bind(...messages.map((message) => message.id), globalKey),
  );
  ctx.waitUntil(
    Promise.all(
      changes.map((change) =>
        broadcastChange(env, { ...change, data: parse(change.data_json, {}) }),
      ),
    ),
  );
  ctx.waitUntil(processJobs(env));
  await audit(env, user.email, 'personal_messages_created', batchId, {
    kind,
    count: messages.length,
  });
  return json({ messages, duplicate: false }, 201);
}

export async function personalMessageRoute(request, env, user, url, ctx) {
  const path = url.pathname,
    method = request.method;
  const directoryResponse = await contactRoute(request, env, user, url);
  if (directoryResponse) return directoryResponse;
  const assigned = path.match(/^\/api\/events\/([^/]+)\/assign-intervention$/);
  const areasPath = path.match(/^\/api\/users\/([^/]+)\/areas$/);
  if (areasPath && method === 'PUT') {
    ownerOnly(user);
    const input = await body(request, 6000);
    if (!Array.isArray(input.areas) || input.areas.length > 20)
      throw new ApiError(400, '负责区域格式不正确');
    const areas = [
      ...new Set(input.areas.map((area) => required(area, 80, '区域名称'))),
    ];
    const result = await env.DB.prepare(
      'UPDATE users SET areas_json=? WHERE id=?',
    )
      .bind(JSON.stringify(areas), identifier(areasPath[1]))
      .run();
    if (!result.meta.changes) throw new ApiError(404, '成员不存在');
    await audit(env, user.email, 'member_areas_updated', areasPath[1]);
    await emitChange(env, 'members', areasPath[1], 'areas_updated', {});
    return json({ areas });
  }
  if (assigned && method === 'POST') {
    const event = await env.DB.prepare(
      'SELECT incidents.*,devices.name AS device_name,devices.location,devices.is_test FROM incidents JOIN devices ON devices.id=incidents.device_id WHERE incidents.id=?',
    )
      .bind(identifier(assigned[1]))
      .first();
    if (!event) throw new ApiError(404, '事件不存在');
    return createMessages(env, user, await body(request, 16000), event, ctx);
  }
  if (!path.startsWith('/api/personal-messages')) return null;
  if (path === '/api/personal-messages/contacts' && method === 'GET') {
    const contacts = (
      await rows(
        env.DB.prepare(
          'SELECT id,name,role,areas_json FROM users ORDER BY name,id',
        ),
      )
    ).map(({ areas_json, ...contact }) => ({
      ...contact,
      areas: parse(areas_json, []),
    }));
    const locations = await rows(
      env.DB.prepare(
        "SELECT DISTINCT location FROM devices WHERE revoked_at IS NULL AND location<>'' ORDER BY location",
      ),
    );
    return json({
      contacts,
      areas: [
        ...new Set([
          ...locations.map((item) => item.location),
          ...contacts.flatMap((item) => item.areas),
        ]),
      ].sort(),
    });
  }
  if (path === '/api/personal-messages/summary' && method === 'GET') {
    const unread = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM personal_messages WHERE recipient_id=? AND read_at IS NULL',
    )
      .bind(user.id)
      .first();
    const version = await env.DB.prepare(
      `SELECT COALESCE(MAX(seq),0) AS seq FROM changes WHERE category='message' AND
      (?='owner' OR EXISTS(SELECT 1 FROM json_each(audience_json) WHERE value=?))`,
    )
      .bind(user.role, 'user:' + user.id)
      .first();
    return json({ unread: unread.count, version: version.seq });
  }
  if (path === '/api/personal-messages' && method === 'POST')
    return createMessages(env, user, await body(request, 16000), null, ctx);
  if (path === '/api/personal-messages' && method === 'GET') {
    const scope =
      url.searchParams.get('scope') ||
      (user.role === 'owner' ? 'all' : 'inbox');
    if (!['all', 'inbox', 'sent'].includes(scope))
      throw new ApiError(400, '消息范围不正确');
    if (scope === 'all' && user.role !== 'owner')
      throw new ApiError(403, '仅管理员可查看全部成员的个人消息');
    const where = [],
      values = [];
    if (scope !== 'all') {
      where.push(scope === 'sent' ? 'm.sender_id=?' : 'm.recipient_id=?');
      values.push(user.id);
    }
    if (url.searchParams.get('recipient_id')) {
      where.push('m.recipient_id=?');
      values.push(identifier(url.searchParams.get('recipient_id')));
    }
    if (url.searchParams.get('kind')) {
      where.push('m.kind=?');
      values.push(text(url.searchParams.get('kind'), 20));
    }
    if (url.searchParams.get('unread') === '1')
      where.push('m.read_at IS NULL AND m.is_external=0');
    if (url.searchParams.get('before')) {
      const cursor = parse(url.searchParams.get('before'), null);
      if (
        !Array.isArray(cursor) ||
        cursor.length !== 2 ||
        !/^\d{4}-\d{2}-\d{2}T/.test(cursor[0])
      )
        throw new ApiError(400, '消息分页标识不正确');
      where.push('(m.created_at<? OR (m.created_at=? AND m.id<?))');
      values.push(
        text(cursor[0], 40),
        text(cursor[0], 40),
        identifier(cursor[1]),
      );
    }
    const messages = await rows(
      env.DB.prepare(
        joined +
          (where.length ? ' WHERE ' + where.join(' AND ') : '') +
          ' ORDER BY m.created_at DESC,m.id DESC LIMIT 51',
      ).bind(...values),
    );
    const more = messages.length > 50;
    if (more) messages.pop();
    const last = messages.at(-1);
    return json({
      messages,
      next_cursor: more ? JSON.stringify([last.created_at, last.id]) : null,
    });
  }
  const match = path.match(
    /^\/api\/personal-messages\/([^/]+)(?:\/(read|ack|complete))?$/,
  );
  if (match) {
    let message = await findMessage(env, user, match[1]);
    if (method === 'GET' && !match[2]) return json({ message });
    if (method === 'POST' && match[2]) {
      if (message.recipient_id !== user.id)
        throw new ApiError(403, '仅收件人可更新接收与处置状态');
      const operation = match[2],
        input = await body(request, 5000),
        timestamp = now();
      if (operation !== 'read' && message.kind === 'notice')
        throw new ApiError(400, '普通消息无需接单或完成');
      if (operation === 'complete' && message.kind === 'intervention')
        throw new ApiError(400, '请在关联事件中选择处置分类并完成确认后提交');
      let update;
      if (operation === 'read')
        update = env.DB.prepare(
          'UPDATE personal_messages SET read_at=?,updated_at=? WHERE id=? AND read_at IS NULL',
        ).bind(timestamp, timestamp, message.id);
      else if (operation === 'ack')
        update = env.DB.prepare(
          'UPDATE personal_messages SET read_at=COALESCE(read_at,?),acknowledged_at=?,updated_at=? WHERE id=? AND acknowledged_at IS NULL AND completed_at IS NULL',
        ).bind(timestamp, timestamp, timestamp, message.id);
      else
        update = env.DB.prepare(
          'UPDATE personal_messages SET read_at=COALESCE(read_at,?),acknowledged_at=COALESCE(acknowledged_at,?),completed_at=?,completion_note=?,updated_at=? WHERE id=? AND completed_at IS NULL',
        ).bind(
          timestamp,
          timestamp,
          timestamp,
          required(input.note, 1000, '完成情况'),
          timestamp,
          message.id,
        );
      const key = 'personal-' + operation + ':' + message.id;
      const stateColumn =
        operation === 'read'
          ? 'read_at'
          : operation === 'ack'
            ? 'acknowledged_at'
            : 'completed_at';
      const result = await env.DB.batch([
        update,
        env.DB.prepare(
          `INSERT OR IGNORE INTO changes(category,entity_id,action,data_json,created_at,audience_json,dedupe_key)
          SELECT 'message',?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM personal_messages WHERE id=? AND ${stateColumn} IS NOT NULL)`,
        ).bind(
          message.id,
          operation,
          JSON.stringify({
            message_id: message.id,
            recipient_id: user.id,
            kind: message.kind,
            notify: false,
          }),
          timestamp,
          messageAudience(message.sender_id, message.recipient_id),
          key,
          message.id,
        ),
      ]);
      if (result[1].meta.changes) {
        const change = await env.DB.prepare(
          'SELECT * FROM changes WHERE dedupe_key=?',
        )
          .bind(key)
          .first();
        ctx.waitUntil(
          broadcastChange(env, {
            ...change,
            data: parse(change.data_json, {}),
          }),
        );
        await audit(
          env,
          user.email,
          'personal_message_' + operation,
          message.id,
        );
      }
      message = await findMessage(env, user, message.id);
      return json({ message });
    }
  }
  throw new ApiError(404, '个人消息接口不存在');
}
