import { DurableObject } from 'cloudflare:workers';
import {
  ApiError,
  audit,
  body,
  defaultMail,
  defaultRules,
  decrypt,
  digest,
  email,
  encrypt,
  identifier,
  integer,
  iso,
  json,
  levelLabels,
  now,
  parse,
  platforms,
  randomToken,
  readSetting,
  riskLabels,
  risks,
  saveSetting,
  secure,
  severityFor,
  text,
  uid,
  unb64,
  validSnapshot,
  validateRules,
} from './utils.js';
import {
  checkOrigin,
  deviceAuth,
  login,
  logout,
  ownerOnly,
  passwordHash,
  passwordMatches,
  rateLimit,
  userAuth,
} from './auth.js';
import {
  emitChange,
  processJobs,
  queueEventNotifications,
  validateSubscription,
} from './notify.js';
import { sendSmtp } from './smtp.js';
import { enrollReceiver, mobileRoute } from './native-receivers.js';
import { updateDeviceState, checkOfflineDevices } from './device-status.js';

const list = async (statement) => (await statement.all()).results;
const publicUser = (user) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
});
async function rulesFor(env, device) {
  return validateRules({
    ...(await readSetting(env, 'rules', defaultRules)),
    ...parse(device?.config_json, {}).rules,
  });
}
async function eventById(env, id) {
  return env.DB.prepare(
    'SELECT incidents.*,devices.name AS device_name,devices.platform,devices.location,devices.is_test FROM incidents JOIN devices ON devices.id=incidents.device_id WHERE incidents.id=?'
  )
    .bind(id)
    .first();
}
function requireEvent(event) {
  if (!event) throw new ApiError(404, '事件不存在');
  return event;
}
async function publicSettings(env) {
  const mail = { ...defaultMail, ...(await readSetting(env, 'mail', {})) };
  return {
    rules: await readSetting(env, 'rules', defaultRules),
    mail: {
      ...mail,
      password_set: !!mail.password_cipher,
      password_cipher: undefined,
    },
    notification_permissions:
      '浏览器和手机需分别授权通知；邮件服务接受不等于收件箱送达',
  };
}

export class EventRoom extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/internal/broadcast' && request.method === 'POST') {
      const value = await request.text();
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(value);
        } catch {
          try {
            ws.close();
          } catch {}
        }
      }
      return new Response('ok');
    }
    if (request.headers.get('Upgrade') !== 'websocket')
      return new Response('Upgrade required', { status: 426 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  webSocketMessage(socket, message) {
    if (message === 'ping') socket.send('pong');
  }
  webSocketClose(socket, code) {
    socket.close(code);
  }
}

async function claimDevice(request, env, input) {
  checkOrigin(request, env);
  await rateLimit(
    env,
    'enroll:' + request.headers.get('CF-Connecting-IP'),
    30,
    600
  );
  const code = text(input.code, 80)
    .replaceAll('-', '')
    .replaceAll(' ', '')
    .toUpperCase();
  const enrollment = await env.DB.prepare(
    'SELECT * FROM enrollments WHERE code_hash=?'
  )
    .bind(await digest(code))
    .first();
  if (!enrollment || enrollment.expires_at < now())
    throw new ApiError(400, '绑定码无效或已过期');
  if (enrollment.consumed_at)
    throw new ApiError(409, '绑定码已使用，请重新生成');
  if (input.platform && input.platform !== enrollment.platform)
    throw new ApiError(400, '设备平台与绑定码不符');
  const id = enrollment.device_id || uid();
  const token = 'pgd_' + randomToken();
  const tokenHash = await digest(token);
  const nonce = uid();
  const time = now();
  const statements = [
    env.DB.prepare(
      'UPDATE enrollments SET consumed_at=?,claim_nonce=? WHERE id=? AND consumed_at IS NULL AND expires_at>?'
    ).bind(time, nonce, enrollment.id, time),
  ];
  if (enrollment.device_id) {
    statements.push(
      env.DB.prepare(
        'UPDATE devices SET token_hash=?,revoked_at=NULL WHERE id=? AND EXISTS(SELECT 1 FROM enrollments WHERE id=? AND claim_nonce=?)'
      ).bind(tokenHash, id, enrollment.id, nonce)
    );
  } else {
    statements.push(
      env.DB.prepare(
        'INSERT INTO devices(id,name,platform,token_hash,created_at,is_test) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM enrollments WHERE id=? AND claim_nonce=?)'
      ).bind(
        id,
        enrollment.name,
        enrollment.platform,
        tokenHash,
        time,
        enrollment.is_test || 0,
        enrollment.id,
        nonce
      )
    );
  }
  const result = await env.DB.batch(statements);
  if (result[0].meta.changes !== 1 || result[1].meta.changes !== 1)
    throw new ApiError(409, '绑定码已使用');
  await audit(env, 'device:' + id, 'device_bound', id, {
    platform: enrollment.platform,
  });
  await emitChange(env, 'device', id, 'bound', {
    device_id: id,
    name: enrollment.name,
    platform: enrollment.platform,
  });
  return json(
    {
      device_id: id,
      device_token: token,
      server_url: env.PUBLIC_ORIGIN,
      rules: await rulesFor(env),
      heartbeat_seconds: 30,
      server_time: now(),
    },
    201
  );
}

async function receiveEvent(request, env, device, input, ctx) {
  await rateLimit(env, 'event:' + device.id, 120, 60);
  const clientId = identifier(input.event_id);
  const revision = integer(input.revision, 1, 1000000);
  const frames = integer(input.observed_frames, 0, 1000000000);
  if (
    !risks.has(input.risk_kind) ||
    !['candidate', 'alert'].includes(input.model_state) ||
    !['created', 'escalated', 'resolved', 'interrupted'].includes(
      input.update_type
    )
  )
    throw new ApiError(400, '事件类型不正确');
  const rules = await rulesFor(env, device);
  if (frames <= rules.frame_threshold)
    throw new ApiError(422, '未超过累计帧阈值');
  const existing = await env.DB.prepare(
    'SELECT * FROM incidents WHERE device_id=? AND client_event_id=?'
  )
    .bind(device.id, clientId)
    .first();
  if (existing && revision <= existing.revision)
    return json({
      accepted: true,
      duplicate: true,
      incident_id: existing.id,
      revision: existing.revision,
    });
  if (existing && frames < existing.observed_frames)
    throw new ApiError(409, '累计帧数不能回退');
  const id = existing?.id || uid();
  const snapshot = validSnapshot(input.snapshot);
  const time = now();
  const rawTime = new Date(input.occurred_at);
  const clockWarning =
    !Number.isFinite(rawTime.getTime()) ||
    rawTime.getUTCFullYear() < 2024 ||
    rawTime.getTime() > Date.now() + 300000 ||
    input.clock_synced === false;
  const occurred = iso(input.occurred_at, time);
  const ended = ['resolved', 'interrupted'].includes(input.update_type);
  const severity = Math.max(
    existing?.severity || 0,
    severityFor(frames, input.model_state, input.confirmed_seen === true, rules)
  );
  const shouldNotify =
    !ended &&
    (!device.is_test || input.notify_test === true) &&
    (!existing || severity > existing.severity);
  const status = ended
    ? 'resolved'
    : severity >= 3
      ? 'intervention_requested'
      : existing?.status || 'open';
  const summary = text(input.summary || '', 500);
  const changeData = {
    id,
    device_id: device.id,
    device_name: device.name,
    platform: device.platform,
    risk_kind: input.risk_kind,
    model_state: input.model_state,
    severity,
    status,
    observed_frames: frames,
    occurred_at: occurred,
    received_at: time,
    notify: shouldNotify,
    is_test: !!device.is_test,
  };
  const statements = [];
  if (!existing) {
    statements.push(
      env.DB.prepare(
        'INSERT INTO incidents(id,device_id,client_event_id,risk_kind,model_state,severity,status,observed_frames,revision,occurred_at,received_at,updated_at,resolved_at,staff_requested_at,clock_warning,summary) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).bind(
        id,
        device.id,
        clientId,
        input.risk_kind,
        input.model_state,
        severity,
        status,
        frames,
        revision,
        occurred,
        time,
        time,
        ended ? time : null,
        severity >= 3 ? time : null,
        clockWarning ? 1 : 0,
        summary
      )
    );
  } else {
    statements.push(
      env.DB.prepare(
        'UPDATE incidents SET model_state=?,severity=?,status=?,observed_frames=?,revision=?,updated_at=?,resolved_at=?,staff_requested_at=CASE WHEN ? THEN COALESCE(staff_requested_at,?) ELSE staff_requested_at END,clock_warning=?,summary=? WHERE id=? AND revision<?'
      ).bind(
        input.model_state,
        severity,
        status,
        frames,
        revision,
        time,
        ended ? time : null,
        severity >= 3 ? 1 : 0,
        time,
        clockWarning ? 1 : 0,
        summary,
        id,
        revision
      )
    );
  }
  statements.push(
    env.DB.prepare(
      'INSERT INTO incident_updates(incident_id,device_id,client_revision,action,severity,observed_frames,actor,occurred_at,received_at,details_json) VALUES(?,?,?,?,?,?,?,?,?,?)'
    ).bind(
      id,
      device.id,
      revision,
      input.update_type,
      severity,
      frames,
      'device:' + device.id,
      iso(input.updated_at, time),
      time,
      JSON.stringify({
        clock_warning: clockWarning,
        confirmed_seen: input.confirmed_seen === true,
        termination_reason: text(input.termination_reason || '', 100),
      })
    )
  );
  if (snapshot)
    statements.push(
      env.DB.prepare(
        'INSERT INTO snapshots(id,incident_id,mime_type,bytes,data_base64,captured_at,created_at) VALUES(?,?,?,?,?,?,?)'
      ).bind(
        uid(),
        id,
        snapshot.mime_type,
        snapshot.bytes,
        snapshot.data_base64,
        snapshot.captured_at,
        time
      )
    );
  statements.push(
    env.DB.prepare('UPDATE devices SET last_seen=? WHERE id=?').bind(
      time,
      device.id
    )
  );
  try {
    const result = await env.DB.batch(statements);
    if (existing && result[0].meta.changes !== 1)
      return json({ accepted: true, duplicate: true, incident_id: id });
  } catch (error) {
    if (String(error).includes('UNIQUE')) {
      const current = await env.DB.prepare(
        'SELECT id,revision FROM incidents WHERE device_id=? AND client_event_id=?'
      )
        .bind(device.id, clientId)
        .first();
      return json({
        accepted: true,
        duplicate: true,
        incident_id: current?.id,
        revision: current?.revision,
      });
    }
    throw error;
  }
  const change = await emitChange(
    env,
    'event',
    id,
    input.update_type,
    changeData
  );
  if (shouldNotify) {
    await queueEventNotifications(
      env,
      { ...changeData, id, location: device.location },
      change
    );
    ctx.waitUntil(processJobs(env));
  }
  return json(
    { accepted: true, incident_id: id, revision, received_at: time },
    existing ? 200 : 201
  );
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (path === '/api/health')
    return json({
      ok: true,
      service: 'poseguard-hub',
      version: '1.2.0',
      server_time: now(),
    });
  if (path === '/api/public-config')
    return json({
      name: 'PoseGuard',
      vapid_public_key: env.VAPID_PUBLIC_KEY || null,
      platforms: [...platforms],
      server_time: now(),
      app_url: '/downloads/PoseGuard-Android.apk',
      android_ready: !!env.ANDROID_CERT_SHA256,
    });
  if (path === '/api/auth/login' && method === 'POST') {
    const result = await login(request, env, await body(request, 8000));
    return json(result.data, 200, { 'Set-Cookie': result.cookie });
  }
  if (path === '/api/auth/join' && method === 'POST') {
    checkOrigin(request, env);
    const input = await body(request, 8000);
    const invite = await env.DB.prepare(
      'SELECT * FROM user_invites WHERE token_hash=? AND used_at IS NULL AND expires_at>?'
    )
      .bind(await digest(text(input.token, 100)), now())
      .first();
    if (!invite) throw new ApiError(400, '邀请链接无效或已过期');
    const id = uid();
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)'
      ).bind(
        id,
        invite.email,
        invite.name,
        'staff',
        await passwordHash(input.password),
        now()
      ),
      env.DB.prepare('UPDATE user_invites SET used_at=? WHERE id=?').bind(
        now(),
        invite.id
      ),
    ]);
    return json({ ok: true, email: invite.email }, 201);
  }
  if (path === '/api/enroll' && method === 'POST')
    return claimDevice(request, env, await body(request, 16000));
  if (path.startsWith('/api/device/')) {
    const device = await deviceAuth(request, env);
    if (path === '/api/device/heartbeat' && method === 'POST') {
      const input = await body(request, 20000);
      const health = {
        mode: text(input.mode || 'unknown', 50),
        fps: Number.isFinite(input.fps) ? input.fps : null,
        source: text(input.source || '', 150),
        people: integer(input.people || 0, 0, 100),
        outbox_pending: integer(input.outbox_pending || 0, 0, 1000000),
        firmware: text(input.firmware || '', 80),
        clock_synced: input.clock_synced === true,
        capabilities: input.capabilities || {},
        last_error: text(input.last_error || '', 300),
      };
      await env.DB.prepare(
        'UPDATE devices SET last_seen=?,health_json=? WHERE id=?'
      )
        .bind(now(), JSON.stringify(health), device.id)
        .run();
      await updateDeviceState(env, device, health, ctx);
      return json({
        ok: true,
        device_id: device.id,
        rules: await rulesFor(env, device),
        server_time: now(),
        pending_commands: await list(
          env.DB.prepare(
            'SELECT id,kind,incident_id,payload_json,created_at FROM device_commands WHERE device_id=? AND acknowledged_at IS NULL ORDER BY created_at LIMIT 20'
          ).bind(device.id)
        ),
      });
    }
    if (path === '/api/device/events' && method === 'POST')
      return receiveEvent(request, env, device, await body(request), ctx);
    const match = path.match(/^\/api\/device\/commands\/([^/]+)\/ack$/);
    if (match && method === 'POST') {
      const result = await env.DB.prepare(
        'UPDATE device_commands SET acknowledged_at=? WHERE id=? AND device_id=? AND acknowledged_at IS NULL'
      )
        .bind(now(), identifier(match[1]), device.id)
        .run();
      return json({ ok: true, acknowledged: result.meta.changes === 1 });
    }
    throw new ApiError(404, '设备接口不存在');
  }
  if (path.startsWith('/api/mobile/')) return mobileRoute(request, env, url);
  const user = await userAuth(request, env);
  if (path === '/api/native-receivers' && method === 'POST')
    return enrollReceiver(env, user, await body(request, 12000));
  const nativeTest = path.match(/^\/api\/native-receivers\/([^/]+)\/test$/);
  if (nativeTest && method === 'POST') {
    const receiver = await env.DB.prepare(
      'SELECT * FROM native_receivers WHERE id=? AND revoked_at IS NULL'
    )
      .bind(identifier(nativeTest[1]))
      .first();
    if (!receiver || (receiver.user_id !== user.id && user.role !== 'owner'))
      throw new ApiError(404, '通知接收端不存在');
    const change = await emitChange(env, 'notification', uid(), 'test_native', {
      receiver_id: receiver.id,
      notify: true,
      test: true,
      title: 'PoseGuard 紧急通知测试',
      body: '这是已绑定手机的通知实测，无需现场处置。',
      severity: 3,
      url: '/notifications',
    });
    return json({ ok: true, seq: change.seq }, 202);
  }

  if (path === '/api/auth/me') return json({ user: publicUser(user) });
  if (path === '/api/auth/logout' && method === 'POST')
    return json({ ok: true }, 200, { 'Set-Cookie': await logout(env, user) });
  if (path === '/api/auth/password' && method === 'POST') {
    const input = await body(request, 8000);
    const stored =
      user.password_hash ||
      (user.role === 'owner' ? env.OWNER_PASSWORD_HASH : null);
    if (!(await passwordMatches(input.current_password, stored)))
      throw new ApiError(403, '当前口令不正确');
    await env.DB.prepare('UPDATE users SET password_hash=? WHERE id=?')
      .bind(await passwordHash(input.password), user.id)
      .run();
    await env.DB.prepare(
      'DELETE FROM sessions WHERE user_id=? AND token_hash<>?'
    )
      .bind(user.id, user.token_hash)
      .run();
    await audit(env, user.email, 'password_changed', user.id);
    return json({ ok: true });
  }
  if (path === '/api/socket') {
    if (request.headers.get('Upgrade') !== 'websocket')
      throw new ApiError(400, '需要 WebSocket');
    checkOrigin(request, env);
    return env.ROOMS.get(env.ROOMS.idFromName('workspace')).fetch(request);
  }
  if (path === '/api/changes') {
    if (url.searchParams.get('bootstrap') === '1') {
      const row = await env.DB.prepare(
        'SELECT COALESCE(MAX(seq),0) AS cursor FROM changes'
      ).first();
      return json({ changes: [], cursor: row.cursor });
    }
    const after = integer(
      Number(url.searchParams.get('after') || 0),
      0,
      Number.MAX_SAFE_INTEGER
    );
    const rows = await list(
      env.DB.prepare(
        'SELECT * FROM changes WHERE seq>? ORDER BY seq LIMIT 100'
      ).bind(after)
    );
    return json({
      changes: rows.map((r) => ({ ...r, data: parse(r.data_json, {}) })),
      cursor: rows.length ? rows.at(-1).seq : after,
    });
  }
  if (path === '/api/devices' && method === 'GET') {
    const rows = await list(
      env.DB.prepare(
        'SELECT id,name,platform,location,created_at,last_seen,health_json,config_json,revoked_at,is_test,connection_state FROM devices ORDER BY created_at DESC'
      )
    );
    return json({
      devices: rows.map((d) => ({
        ...d,
        online:
          !d.revoked_at &&
          !!d.last_seen &&
          Date.now() - Date.parse(d.last_seen) < 90000,
        health: parse(d.health_json, {}),
        config: parse(d.config_json, {}),
      })),
      receivers: [
        ...(await list(
          env.DB.prepare(
            'SELECT push_subscriptions.id,push_subscriptions.user_id,push_subscriptions.label,push_subscriptions.device_ids_json,push_subscriptions.created_at,push_subscriptions.last_success,push_subscriptions.last_error,users.name AS user_name FROM push_subscriptions JOIN users ON users.id=push_subscriptions.user_id ORDER BY push_subscriptions.created_at DESC'
          )
        )),
        ...(await list(
          env.DB.prepare(
            "SELECT native_receivers.id,native_receivers.user_id,native_receivers.label,native_receivers.device_ids_json,native_receivers.created_at,native_receivers.last_success,native_receivers.last_error,users.name AS user_name,'android' AS channel FROM native_receivers JOIN users ON users.id=native_receivers.user_id WHERE native_receivers.revoked_at IS NULL ORDER BY native_receivers.created_at DESC"
          )
        )),
      ].map(({ user_id, ...row }) => ({
        ...row,
        can_manage: user.role === 'owner' || user.id === user_id,
      })),
    });
  }
  if (path === '/api/enrollments' && method === 'POST') {
    ownerOnly(user);
    const input = await body(request, 8000);
    if (!platforms.has(input.platform)) throw new ApiError(400, '平台不受支持');
    const name = text(input.name || '', 80);
    if (!name) throw new ApiError(400, '请填写设备名称');
    let target = null;
    if (input.device_id) {
      target = await env.DB.prepare('SELECT * FROM devices WHERE id=?')
        .bind(identifier(input.device_id))
        .first();
      if (!target || target.platform !== input.platform)
        throw new ApiError(400, '重新绑定平台不匹配');
    }
    const code = randomToken(12).replace(/[-_]/g, 'A').toUpperCase();
    const id = uid();
    const expires = new Date(Date.now() + 600000).toISOString();
    await env.DB.prepare(
      'INSERT INTO enrollments(id,code_hash,name,platform,device_id,expires_at,created_at,is_test) VALUES(?,?,?,?,?,?,?,?)'
    )
      .bind(
        id,
        await digest(code),
        name,
        input.platform,
        target?.id || null,
        expires,
        now(),
        input.is_test ? 1 : 0
      )
      .run();
    await audit(env, user.email, 'enrollment_created', id, {
      platform: input.platform,
    });
    return json(
      {
        code,
        expires_at: expires,
        server_url: env.PUBLIC_ORIGIN,
        pairing_uri: `poseguard://pair?server=${encodeURIComponent(env.PUBLIC_ORIGIN)}&code=${code}`,
        platform: input.platform,
        name,
      },
      201
    );
  }
  const devicePath = path.match(/^\/api\/devices\/([^/]+)$/);
  if (devicePath) {
    ownerOnly(user);
    const id = identifier(devicePath[1]);
    if (method === 'PATCH') {
      const input = await body(request, 16000);
      const current = await env.DB.prepare('SELECT * FROM devices WHERE id=?')
        .bind(id)
        .first();
      if (!current) throw new ApiError(404, '设备不存在');
      const config = { ...parse(current.config_json, {}) };
      if (input.rules) config.rules = validateRules(input.rules);
      await env.DB.prepare(
        'UPDATE devices SET name=?,location=?,config_json=? WHERE id=?'
      )
        .bind(
          text(input.name || current.name, 80),
          text(input.location ?? current.location, 120),
          JSON.stringify(config),
          id
        )
        .run();
      await audit(env, user.email, 'device_updated', id);
      await emitChange(env, 'device', id, 'updated', { device_id: id });
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      await env.DB.prepare('UPDATE devices SET revoked_at=? WHERE id=?')
        .bind(now(), id)
        .run();
      await audit(env, user.email, 'device_revoked', id);
      await emitChange(env, 'device', id, 'revoked', { device_id: id });
      return json({ ok: true });
    }
  }
  if (path === '/api/events' && method === 'GET') {
    const filters = [];
    const args = [];
    const status = url.searchParams.get('status');
    if (status && status !== 'all') {
      filters.push('incidents.status=?');
      args.push(status);
    }
    const device = url.searchParams.get('device');
    if (device) {
      filters.push('incidents.device_id=?');
      args.push(identifier(device));
    }
    const risk = url.searchParams.get('risk');
    if (risk) {
      if (!risks.has(risk)) throw new ApiError(400, '风险类型不正确');
      filters.push('risk_kind=?');
      args.push(risk);
    }
    const before = url.searchParams.get('before');
    if (before) {
      filters.push('incidents.updated_at<?');
      args.push(iso(before));
    }
    const rows = await list(
      env.DB.prepare(
        `SELECT incidents.*,devices.name AS device_name,devices.platform,devices.location,devices.is_test,(SELECT id FROM snapshots WHERE incident_id=incidents.id ORDER BY created_at DESC LIMIT 1) AS snapshot_id FROM incidents JOIN devices ON devices.id=incidents.device_id ${filters.length ? 'WHERE ' + filters.join(' AND ') : ''} ORDER BY incidents.updated_at DESC LIMIT 50`
      ).bind(...args)
    );
    return json({
      events: rows,
      next_before: rows.length === 50 ? rows.at(-1).updated_at : null,
    });
  }
  const eventPath = path.match(
    /^\/api\/events\/([^/]+)(?:\/(ack|request-intervention|resolve|retry-notifications))?$/
  );
  if (eventPath) {
    const id = identifier(eventPath[1]);
    const event = requireEvent(await eventById(env, id));
    if (method === 'GET' && !eventPath[2])
      return json({
        event,
        updates: await list(
          env.DB.prepare(
            'SELECT id,action,severity,observed_frames,actor,occurred_at,received_at,details_json FROM incident_updates WHERE incident_id=? ORDER BY id'
          ).bind(id)
        ),
        snapshots: await list(
          env.DB.prepare(
            'SELECT id,mime_type,bytes,captured_at,created_at FROM snapshots WHERE incident_id=? ORDER BY created_at DESC LIMIT 30'
          ).bind(id)
        ),
        notifications: await list(
          env.DB.prepare(
            'SELECT id,channel,target,status,attempts,last_error,created_at,updated_at FROM notification_jobs WHERE incident_id=? ORDER BY created_at DESC'
          ).bind(id)
        ),
      });
    if (method === 'POST') {
      const input = await body(request, 8000);
      const action = eventPath[2];
      if (
        (action === 'ack' && event.acknowledged_at) ||
        (action === 'request-intervention' &&
          (await env.DB.prepare(
            "SELECT id FROM device_commands WHERE incident_id=? AND kind='staff_intervention_requested'"
          )
            .bind(id)
            .first())) ||
        (action === 'resolve' && event.status === 'resolved')
      )
        return json({ ok: true, duplicate: true });
      let status = event.status;
      let severity = event.severity;
      if (action === 'ack') {
        status = 'acknowledged';
        await env.DB.prepare(
          'UPDATE incidents SET status=?,acknowledged_at=?,acknowledged_by=?,updated_at=? WHERE id=?'
        )
          .bind(status, now(), user.name, now(), id)
          .run();
      } else if (action === 'resolve') {
        status = 'resolved';
        const note = text(input.note || '', 300);
        if (!note) throw new ApiError(400, '请填写处置结果');
        await env.DB.prepare(
          'UPDATE incidents SET status=?,resolved_at=?,updated_at=? WHERE id=?'
        )
          .bind(status, now(), now(), id)
          .run();
      } else if (action === 'request-intervention') {
        status = 'intervention_requested';
        severity = 3;
        await env.DB.prepare(
          'UPDATE incidents SET status=?,severity=3,staff_requested_at=?,updated_at=? WHERE id=?'
        )
          .bind(status, now(), now(), id)
          .run();
        await env.DB.prepare(
          'INSERT INTO device_commands(id,device_id,incident_id,kind,payload_json,created_at) VALUES(?,?,?,?,?,?)'
        )
          .bind(
            uid(),
            event.device_id,
            id,
            'staff_intervention_requested',
            JSON.stringify({
              client_event_id: event.client_event_id,
              severity: 3,
              requested_by: user.name,
              reason: text(input.note || '请求工作人员介入', 300),
            }),
            now()
          )
          .run();
      } else if (action === 'retry-notifications') {
        ownerOnly(user);
        await env.DB.prepare(
          "UPDATE notification_jobs SET status='pending',attempts=0,next_attempt=0,updated_at=? WHERE incident_id=? AND status IN ('failed','blocked')"
        )
          .bind(now(), id)
          .run();
        ctx.waitUntil(processJobs(env));
        return json({ ok: true });
      } else throw new ApiError(404, '操作不存在');
      await env.DB.prepare(
        'INSERT INTO incident_updates(incident_id,device_id,action,severity,observed_frames,actor,occurred_at,received_at,details_json) VALUES(?,?,?,?,?,?,?,?,?)'
      )
        .bind(
          id,
          event.device_id,
          action,
          severity,
          event.observed_frames,
          user.name,
          now(),
          now(),
          JSON.stringify({ note: text(input.note || '', 300) })
        )
        .run();
      await audit(env, user.email, action, id);
      const change = await emitChange(env, 'event', id, action, {
        ...event,
        status,
        severity,
        notify:
          action === 'request-intervention' &&
          (!event.is_test || input.notify_test === true),
      });
      if (
        action === 'request-intervention' &&
        (!event.is_test || input.notify_test === true)
      ) {
        await queueEventNotifications(
          env,
          { ...event, status, severity },
          change
        );
        ctx.waitUntil(processJobs(env));
      }
      return json({ ok: true });
    }
  }
  const imagePath = path.match(/^\/api\/snapshots\/([^/]+)$/);
  if (imagePath && method === 'GET') {
    const image = await env.DB.prepare('SELECT * FROM snapshots WHERE id=?')
      .bind(identifier(imagePath[1]))
      .first();
    if (!image) throw new ApiError(404, '截图不存在或已过保留期限');
    return new Response(unb64(image.data_base64), {
      headers: {
        'Content-Type': image.mime_type,
        'Cache-Control': 'private, no-store',
        'Content-Disposition': 'inline',
      },
    });
  }
  if (path === '/api/stats') {
    const total = await env.DB.prepare(
      "SELECT COUNT(*) AS total,SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) AS open,SUM(CASE WHEN status='intervention_requested' THEN 1 ELSE 0 END) AS intervention,SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) AS resolved FROM incidents WHERE received_at>=?"
    )
      .bind(new Date(Date.now() - 86400000).toISOString())
      .first();
    const devices = await env.DB.prepare(
      'SELECT COUNT(*) AS total,SUM(CASE WHEN last_seen>? THEN 1 ELSE 0 END) AS online FROM devices WHERE revoked_at IS NULL'
    )
      .bind(new Date(Date.now() - 90000).toISOString())
      .first();
    const notifications = await env.DB.prepare(
      "SELECT SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END) AS blocked,SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed FROM notification_jobs"
    ).first();
    return json({ events: total, devices, notifications, server_time: now() });
  }
  if (path === '/api/settings' && method === 'GET')
    return json(await publicSettings(env));
  if (path === '/api/settings' && method === 'PUT') {
    ownerOnly(user);
    const input = await body(request, 24000);
    if (input.rules)
      await saveSetting(env, 'rules', validateRules(input.rules));
    if (input.mail) {
      const previous = {
        ...defaultMail,
        ...(await readSetting(env, 'mail', {})),
      };
      const mail = {
        ...previous,
        ...input.mail,
        password_cipher: previous.password_cipher,
      };
      delete mail.password;
      delete mail.password_set;
      mail.from = email(mail.from);
      mail.username = email(mail.username);
      mail.recipients = [...new Set((mail.recipients || []).map(email))];
      if (mail.recipients.length > 20)
        throw new ApiError(400, '收件人最多 20 个');
      mail.host = text(mail.host, 200);
      integer(mail.port, 465, 587);
      if (![465, 587].includes(mail.port))
        throw new ApiError(400, '支持 465 TLS 或 587 STARTTLS');
      if (input.mail.password)
        mail.password_cipher = await encrypt(
          env,
          text(input.mail.password, 500)
        );
      await saveSetting(env, 'mail', mail);
    }
    await audit(env, user.email, 'settings_updated', 'settings', {
      rules: !!input.rules,
      mail: !!input.mail,
    });
    return json(await publicSettings(env));
  }
  if (path === '/api/settings/test-email' && method === 'POST') {
    ownerOnly(user);
    const input = await body(request, 4000);
    const mail = { ...defaultMail, ...(await readSetting(env, 'mail', {})) };
    const target = email(input.to || mail.recipients[0] || user.email);
    if (!mail.recipients.includes(target) && target !== user.email)
      throw new ApiError(400, '请先添加收件人');
    const id = uid();
    await sendSmtp(
      env,
      target,
      '【PoseGuard】发信配置测试',
      `这是一封由管理员主动触发的发信测试。\n\n服务：${env.PUBLIC_ORIGIN}\n时间：${now()}\n\n此消息不代表真实风险事件。`,
      id
    );
    await audit(env, user.email, 'test_email_accepted', target);
    return json({
      ok: true,
      status: 'accepted',
      message: '邮件服务已接受，请检查收件箱和垃圾邮件文件夹',
    });
  }
  if (path === '/api/push-subscriptions' && method === 'GET')
    return json({
      subscriptions: await list(
        env.DB.prepare(
          'SELECT id,label,device_ids_json,created_at,last_success,last_error FROM push_subscriptions WHERE user_id=?'
        ).bind(user.id)
      ),
    });
  if (path === '/api/push-subscriptions' && method === 'POST') {
    const input = await body(request, 12000);
    const subscription = validateSubscription(input.subscription);
    const ids = Array.isArray(input.device_ids)
      ? input.device_ids.map(identifier)
      : [];
    for (const id of ids) {
      if (
        !(await env.DB.prepare(
          'SELECT id FROM devices WHERE id=? AND revoked_at IS NULL'
        )
          .bind(id)
          .first())
      )
        throw new ApiError(400, '订阅包含未绑定设备');
    }
    const hash = await digest(subscription.endpoint);
    const existing = await env.DB.prepare(
      'SELECT id,user_id FROM push_subscriptions WHERE endpoint_hash=?'
    )
      .bind(hash)
      .first();
    if (existing && existing.user_id !== user.id)
      throw new ApiError(409, '本浏览器订阅属于另一登录账号，请先取消旧订阅');
    const id = existing?.id || uid();
    await env.DB.prepare(
      'INSERT INTO push_subscriptions(id,user_id,endpoint_hash,subscription_json,label,device_ids_json,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(endpoint_hash) DO UPDATE SET subscription_json=excluded.subscription_json,label=excluded.label,device_ids_json=excluded.device_ids_json,last_error=NULL'
    )
      .bind(
        id,
        user.id,
        hash,
        JSON.stringify(subscription),
        text(input.label || '当前通知终端', 80),
        JSON.stringify(ids),
        now()
      )
      .run();
    return json({ ok: true, id }, 201);
  }
  const pushTest = path.match(/^\/api\/push-subscriptions\/([^/]+)\/test$/);
  if (pushTest && method === 'POST') {
    const subscription = await env.DB.prepare(
      'SELECT id,user_id FROM push_subscriptions WHERE id=?'
    )
      .bind(identifier(pushTest[1]))
      .first();
    if (
      !subscription ||
      (subscription.user_id !== user.id && user.role !== 'owner')
    )
      throw new ApiError(404, '通知接收端不存在');
    const id = uid();
    const payload = {
      title: 'PoseGuard 测试通知',
      body: '这是通知通道测试，无需现场处置。请确认手机收到系统通知。',
      severity: 2,
      url: '/notifications',
      timestamp: Date.now(),
    };
    await env.DB.prepare(
      'INSERT INTO notification_jobs(id,channel,target,payload_json,status,next_attempt,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)'
    )
      .bind(
        id,
        'webpush',
        subscription.id,
        JSON.stringify(payload),
        'pending',
        0,
        now(),
        now()
      )
      .run();
    await audit(env, user.email, 'test_push', subscription.id);
    ctx.waitUntil(processJobs(env));
    return json({ ok: true, notification_id: id, status: 'pending' }, 202);
  }
  const subPath = path.match(/^\/api\/push-subscriptions\/([^/]+)$/);
  if (subPath && method === 'PUT') {
    const id = identifier(subPath[1]);
    const input = await body(request, 12000);
    if (!Array.isArray(input.device_ids) || input.device_ids.length > 100) {
      throw new ApiError(400, '请选择关联设备');
    }
    const ids = [...new Set(input.device_ids.map(identifier))];
    for (const deviceId of ids) {
      const device = await env.DB.prepare(
        'SELECT id FROM devices WHERE id=? AND revoked_at IS NULL'
      )
        .bind(deviceId)
        .first();
      if (!device) throw new ApiError(400, '关联设备已解绑');
    }
    const [web, android] = await env.DB.batch([
      env.DB.prepare(
        "UPDATE push_subscriptions SET device_ids_json=? WHERE id=? AND (user_id=? OR ?='owner')"
      ).bind(JSON.stringify(ids), id, user.id, user.role),
      env.DB.prepare(
        "UPDATE native_receivers SET device_ids_json=? WHERE id=? AND revoked_at IS NULL AND (user_id=? OR ?='owner')"
      ).bind(JSON.stringify(ids), id, user.id, user.role),
    ]);
    if (!web.meta.changes && !android.meta.changes)
      throw new ApiError(404, '接收端不存在');
    await audit(env, user.email, 'receiver_devices_updated', id, {
      device_count: ids.length,
    });
    return json({ ok: true, device_ids: ids });
  }
  if (subPath && method === 'DELETE') {
    if (user.role === 'owner')
      await env.DB.prepare('DELETE FROM push_subscriptions WHERE id=?')
        .bind(identifier(subPath[1]))
        .run();
    else
      await env.DB.prepare(
        'DELETE FROM push_subscriptions WHERE id=? AND user_id=?'
      )
        .bind(identifier(subPath[1]), user.id)
        .run();
    if (user.role === 'owner')
      await env.DB.prepare(
        'UPDATE native_receivers SET revoked_at=? WHERE id=?'
      )
        .bind(now(), identifier(subPath[1]))
        .run();
    else
      await env.DB.prepare(
        'UPDATE native_receivers SET revoked_at=? WHERE id=? AND user_id=?'
      )
        .bind(now(), identifier(subPath[1]), user.id)
        .run();
    return json({ ok: true });
  }
  if (path === '/api/users' && method === 'GET') {
    ownerOnly(user);
    return json({
      users: await list(
        env.DB.prepare(
          'SELECT id,email,name,role,created_at FROM users ORDER BY created_at'
        )
      ),
    });
  }
  if (path === '/api/users/invite' && method === 'POST') {
    ownerOnly(user);
    const input = await body(request, 4000);
    const address = email(input.email);
    if (
      await env.DB.prepare('SELECT id FROM users WHERE email=?')
        .bind(address)
        .first()
    )
      throw new ApiError(409, '该账号已存在');
    const token = randomToken();
    const id = uid();
    await env.DB.prepare(
      'INSERT INTO user_invites(id,token_hash,email,name,expires_at,created_at) VALUES(?,?,?,?,?,?)'
    )
      .bind(
        id,
        await digest(token),
        address,
        text(input.name || address.split('@')[0], 80),
        new Date(Date.now() + 86400000).toISOString(),
        now()
      )
      .run();
    await audit(env, user.email, 'staff_invited', id, { email: address });
    return json(
      {
        url: `${env.PUBLIC_ORIGIN}/join#invite=${token}`,
        expires_in_hours: 24,
      },
      201
    );
  }
  if (path === '/api/device-status-events' && method === 'GET')
    return json({
      events: await list(
        env.DB.prepare(
          'SELECT device_status_events.*,devices.name FROM device_status_events JOIN devices ON devices.id=device_status_events.device_id ORDER BY occurred_at DESC LIMIT 100'
        )
      ),
    });
  if (path === '/api/notifications' && method === 'GET') {
    ownerOnly(user);
    return json({
      notifications: await list(
        env.DB.prepare(
          'SELECT id,incident_id,channel,target,status,attempts,last_error,created_at,updated_at FROM notification_jobs ORDER BY created_at DESC LIMIT 100'
        )
      ),
    });
  }
  throw new ApiError(404, '接口不存在');
}

export default {
  async fetch(request, env, ctx) {
    try {
      const path = new URL(request.url).pathname;
      const response = path.startsWith('/api/')
        ? await route(request, env, ctx)
        : await env.ASSETS.fetch(request);
      return secure(response, request, env);
    } catch (error) {
      const known = error instanceof ApiError;
      if (!known)
        console.error('request_failed', String(error.message).slice(0, 160));
      return secure(
        json(
          {
            error: known ? error.message : '服务暂时不可用',
            code: known ? error.code : 'server_error',
          },
          known ? error.status : 500
        ),
        request,
        env
      );
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        await checkOfflineDevices(env, ctx);
        await processJobs(env);
        const rules = await readSetting(env, 'rules', defaultRules);
        const cutoff = new Date(
          Date.now() - (rules.retention_days || 7) * 86400000
        ).toISOString();
        await env.DB.batch([
          env.DB.prepare('DELETE FROM snapshots WHERE created_at<?').bind(
            cutoff
          ),
          env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(now()),
          env.DB.prepare('DELETE FROM rate_limits WHERE expires_at<?').bind(
            Math.floor(Date.now() / 1000)
          ),
          env.DB.prepare('DELETE FROM enrollments WHERE expires_at<?').bind(
            new Date(Date.now() - 86400000).toISOString()
          ),
          env.DB.prepare('DELETE FROM changes WHERE created_at<?').bind(
            new Date(Date.now() - 30 * 86400000).toISOString()
          ),
        ]);
      })()
    );
  },
};
