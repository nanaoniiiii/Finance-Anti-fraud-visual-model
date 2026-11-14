import { defaultMail, now, parse, readSetting, uid } from './utils.js';
import { emitChange, processJobs } from './notify.js';
const faultModes = new Set([
  'inference_unavailable',
  'inference_stalled',
  'waiting_for_usb_camera',
  'error',
]);
const names = {
  online: '设备已恢复在线',
  offline: '设备已离线',
  fault: '设备需要检查',
};
export async function updateDeviceState(env, device, health, ctx) {
  const next = faultModes.has(health.mode) ? 'fault' : 'online';
  if (device.connection_state === next) return;
  await transition(env, device, next, health.last_error || health.mode, ctx);
}
async function transition(env, device, state, detail, ctx) {
  const previous = device.connection_state;
  const result = await env.DB.prepare(
    'UPDATE devices SET connection_state=? WHERE id=? AND connection_state=? AND revoked_at IS NULL'
  )
    .bind(state, device.id, previous)
    .run();
  if (!result.meta.changes) return;
  const occurred = now();
  await env.DB.prepare(
    'INSERT INTO device_status_events(id,device_id,state,occurred_at,detail) VALUES(?,?,?,?,?)'
  )
    .bind(uid(), device.id, state, occurred, detail)
    .run();
  const notify = !device.is_test && previous !== 'unknown';
  const title = names[state];
  const message = `${device.name}：${state === 'offline' ? '超过 90 秒未收到设备心跳' : detail || title}`;
  const change = await emitChange(
    env,
    'device',
    device.id,
    'connection_state',
    {
      device_id: device.id,
      name: device.name,
      state,
      notify,
      title,
      message,
      occurred_at: occurred,
    }
  );
  if (!notify) return;
  const payload = {
    title: 'PoseGuard · ' + title,
    body: message,
    severity: state === 'online' ? 1 : 2,
    url: '/devices',
    device_id: device.id,
    timestamp: Date.now(),
  };
  const mail = { ...defaultMail, ...(await readSetting(env, 'mail', {})) };
  const jobs = [];
  for (const address of mail.recipients || [])
    jobs.push({
      channel: 'email',
      target: address,
      payload: {
        ...payload,
        subject: `【PoseGuard】${title}`,
        text: `${message}\n时间：${occurred}\n详情：${env.PUBLIC_ORIGIN}/devices`,
      },
      status: mail.enabled && mail.password_cipher ? 'pending' : 'blocked',
    });
  const subs = (await env.DB.prepare('SELECT * FROM push_subscriptions').all())
    .results;
  for (const sub of subs) {
    const ids = parse(sub.device_ids_json, []);
    if (!ids.length || ids.includes(device.id))
      jobs.push({
        channel: 'webpush',
        target: sub.id,
        payload,
        status: 'pending',
      });
  }
  for (const job of jobs)
    await env.DB.prepare(
      'INSERT OR IGNORE INTO notification_jobs(id,change_seq,channel,target,payload_json,status,next_attempt,created_at,updated_at,last_error) VALUES(?,?,?,?,?,?,?,?,?,?)'
    )
      .bind(
        uid(),
        change.seq,
        job.channel,
        job.target,
        JSON.stringify(job.payload),
        job.status,
        0,
        occurred,
        occurred,
        job.status === 'blocked' ? '发信账号待授权' : null
      )
      .run();
  if (ctx) ctx.waitUntil(processJobs(env));
}
export async function checkOfflineDevices(env, ctx) {
  const cutoff = new Date(Date.now() - 90000).toISOString();
  const devices = (
    await env.DB.prepare(
      "SELECT * FROM devices WHERE revoked_at IS NULL AND last_seen IS NOT NULL AND last_seen<? AND connection_state IN ('online','fault') LIMIT 100"
    )
      .bind(cutoff)
      .all()
  ).results;
  for (const device of devices)
    await transition(env, device, 'offline', '心跳中断', ctx);
}
