import * as webpush from 'web-push';
import {
  ApiError,
  defaultMail,
  digest,
  iso,
  levelLabels,
  now,
  parse,
  readSetting,
  riskLabels,
  uid,
} from './utils.js';
import { sendSmtp } from './smtp.js';

export function validateSubscription(subscription) {
  let url;
  try {
    url = new URL(subscription.endpoint);
  } catch {
    throw new ApiError(400, '推送订阅地址无效');
  }
  const host = url.hostname;
  const allowed =
    host === 'fcm.googleapis.com' ||
    host.endsWith('.push.apple.com') ||
    host === 'web.push.apple.com' ||
    host.endsWith('.push.services.mozilla.com') ||
    host.endsWith('.notify.windows.com');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && !['443'].includes(url.port)) ||
    !allowed
  )
    throw new ApiError(400, '推送服务地址不受支持');
  if (
    !/^[A-Za-z0-9_-]{20,300}$/.test(subscription.keys?.p256dh || '') ||
    !/^[A-Za-z0-9_-]{16,100}$/.test(subscription.keys?.auth || '')
  )
    throw new ApiError(400, '推送密钥格式错误');
  return subscription;
}
export async function emitChange(env, category, entityId, action, data) {
  const row = await env.DB.prepare(
    'INSERT INTO changes(category,entity_id,action,data_json,created_at) VALUES(?,?,?,?,?) RETURNING seq'
  )
    .bind(category, entityId, action, JSON.stringify(data), now())
    .first();
  const change = {
    seq: row.seq,
    category,
    entity_id: entityId,
    action,
    data,
    created_at: now(),
  };
  try {
    const room = env.ROOMS.get(env.ROOMS.idFromName('workspace'));
    await room.fetch('https://room/internal/broadcast', {
      method: 'POST',
      body: JSON.stringify(change),
    });
  } catch {}
  return change;
}
export async function queueEventNotifications(env, event, change) {
  const mail = { ...defaultMail, ...(await readSetting(env, 'mail', {})) };
  const title = `${event.severity >= 3 ? '请求工作人员介入' : levelLabels[event.severity]} · ${riskLabels[event.risk_kind] || '设备事件'}`;
  const body = `${event.device_name || event.device_id}：累计 ${event.observed_frames} 帧${event.model_state === 'candidate' ? '候选' : '特殊'}状态。请人工核查。`;
  const payload = {
    title,
    body,
    event_id: event.id,
    severity: event.severity,
    url: '/events/' + encodeURIComponent(event.id),
    timestamp: Date.now(),
  };
  const jobs = [];
  for (const address of mail.recipients || [])
    jobs.push({
      channel: 'email',
      target: address,
      payload: {
        ...payload,
        subject: `【PoseGuard】${title}`,
        text: `${title}\n\n设备：${event.device_name || event.device_id}\n位置：${event.location || '未设置'}\n风险：${riskLabels[event.risk_kind]}\n风险程度：${levelLabels[event.severity]}\n模型状态：${event.model_state === 'candidate' ? '候选（需核查）' : '已确认姿态'}\n累计特殊帧：${event.observed_frames}\n发生时间：${event.occurred_at}\n接收时间：${event.received_at}\n\n详情：${env.PUBLIC_ORIGIN}${payload.url}\n\n本消息为视觉辅助预警，请工作人员结合现场情况核查。`,
      },
      status: mail.enabled && mail.password_cipher ? 'pending' : 'blocked',
    });
  const subscriptions = (
    await env.DB.prepare('SELECT * FROM push_subscriptions').all()
  ).results;
  for (const sub of subscriptions) {
    const ids = parse(sub.device_ids_json, []);
    if (ids.length && !ids.includes(event.device_id)) continue;
    jobs.push({
      channel: 'webpush',
      target: sub.id,
      payload,
      status: 'pending',
    });
  }
  for (const job of jobs) {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO notification_jobs(id,incident_id,change_seq,channel,target,payload_json,status,next_attempt,created_at,updated_at,last_error) VALUES(?,?,?,?,?,?,?,?,?,?,?)'
    )
      .bind(
        uid(),
        event.id,
        change.seq,
        job.channel,
        job.target,
        JSON.stringify(job.payload),
        job.status,
        0,
        now(),
        now(),
        job.status === 'blocked' ? '发信账号待授权' : null
      )
      .run();
  }
  return jobs.length;
}
export async function processJobs(env) {
  const seconds = Math.floor(Date.now() / 1000);
  const rows = (
    await env.DB.prepare(
      "SELECT id FROM notification_jobs WHERE (status='pending' AND next_attempt<=?) OR (status='sending' AND lease_until<?) ORDER BY created_at LIMIT 8"
    )
      .bind(seconds, seconds)
      .all()
  ).results;
  await Promise.allSettled(
    rows.map(async (item) => {
      const job = await env.DB.prepare(
        "UPDATE notification_jobs SET status='sending',lease_until=?,attempts=attempts+1,updated_at=? WHERE id=? AND ((status='pending' AND next_attempt<=?) OR (status='sending' AND lease_until<?)) RETURNING *"
      )
        .bind(seconds + 45, now(), item.id, seconds, seconds)
        .first();
      if (!job) return;
      try {
        const payload = parse(job.payload_json, {});
        let providerId = job.id;
        if (job.channel === 'email') {
          providerId = await sendSmtp(
            env,
            job.target,
            payload.subject,
            payload.text,
            job.id
          );
        } else {
          const sub = await env.DB.prepare(
            'SELECT * FROM push_subscriptions WHERE id=?'
          )
            .bind(job.target)
            .first();
          if (!sub) throw new Error('推送订阅已删除');
          const details = webpush.generateRequestDetails(
            parse(sub.subscription_json, {}),
            JSON.stringify(payload),
            {
              TTL: 86400,
              urgency: payload.severity >= 2 ? 'high' : 'normal',
              contentEncoding: 'aes128gcm',
              vapidDetails: {
                subject: `mailto:${env.OWNER_EMAIL}`,
                publicKey: env.VAPID_PUBLIC_KEY,
                privateKey: env.VAPID_PRIVATE_KEY,
              },
            }
          );
          const response = await fetch(details.endpoint, {
            method: 'POST',
            headers: details.headers,
            body: details.body,
            signal: AbortSignal.timeout(12000),
          });
          if ([404, 410].includes(response.status)) {
            await env.DB.prepare('DELETE FROM push_subscriptions WHERE id=?')
              .bind(sub.id)
              .run();
            throw new Error('推送订阅已失效，请在接收端重新启用通知');
          }
          if (!response.ok) throw new Error(`推送服务返回 ${response.status}`);
          await env.DB.prepare(
            'UPDATE push_subscriptions SET last_success=?,last_error=NULL WHERE id=?'
          )
            .bind(now(), sub.id)
            .run();
        }
        await env.DB.prepare(
          "UPDATE notification_jobs SET status='accepted',provider_id=?,last_error=NULL,updated_at=?,lease_until=0 WHERE id=?"
        )
          .bind(providerId, now(), job.id)
          .run();
      } catch (error) {
        const message = String(error.message || '通知发送失败').slice(0, 240);
        const retry = job.attempts < 5 && error.code !== 'mail_not_configured';
        await env.DB.prepare(
          'UPDATE notification_jobs SET status=?,next_attempt=?,last_error=?,updated_at=?,lease_until=0 WHERE id=?'
        )
          .bind(
            error.code === 'mail_not_configured'
              ? 'blocked'
              : retry
                ? 'pending'
                : 'failed',
            seconds + Math.min(3600, 30 * 2 ** job.attempts),
            message,
            now(),
            job.id
          )
          .run();
        if (job.channel === 'webpush')
          await env.DB.prepare(
            'UPDATE push_subscriptions SET last_error=? WHERE id=?'
          )
            .bind(message, job.target)
            .run();
      }
    })
  );
}
