const exhausted = new WeakMap();
const fallbackTotals = new WeakMap();
export function readQuotaExceeded(error) {
  return /D1_ERROR:.*exceeded D1.*daily row read limit/i.test(String(error?.message || error));
}
export function nextUtcDay(time = Date.now()) {
  return Math.floor(time / 86400000) * 86400000 + 86400000;
}
export function noteReadQuota(env, error, time = Date.now()) {
  if (!readQuotaExceeded(error)) return 0;
  // Allow for reset propagation just after midnight, and periodically probe
  // again so an externally restored quota cannot leave the API latched off.
  const until = time%86400000<300000 ? time+60000 : nextUtcDay(time);
  exhausted.set(env.DB, {until,recheckAt:Math.min(until,time+60000)});
  return until;
}
export function readQuotaResponse(env, time = Date.now()) {
  const state = exhausted.get(env.DB);
  if (!state || state.until<=time || state.recheckAt<=time) return null;
  const {until}=state;
  const retry = Math.max(1, Math.ceil((until - time) / 1000));
  return Response.json({error:'云端服务今日用量达到上限，预计北京时间 08:00 恢复；设备仍在本地记录，恢复后补传。',
    code:'cloud_read_quota',retry_after_seconds:retry,retry_at:new Date(until).toISOString()},
    {status:503,headers:{'Retry-After':String(retry),'Cache-Control':'no-store'}});
}
export async function persistReadQuota(env, until) {
  if (!until || !env.ROOMS) return;
  const room = env.ROOMS.get(env.ROOMS.idFromName('workspace'));
  await room.fetch('https://room/internal/db-budget', {method:'POST',body:JSON.stringify({until})});
}
export async function offlineChecksAllowed(env, time = Date.now()) {
  if (!env.ROOMS) return true;
  const room = env.ROOMS.get(env.ROOMS.idFromName('workspace'));
  const response = await room.fetch('https://room/internal/db-budget');
  if (!response.ok) return false;
  const state = await response.json();
  // Let devices reconnect before deciding they went offline during an outage.
  return !state.until || time >= state.until + 300000;
}
export async function notificationTotals(env, time = Date.now()) {
  try {
    return await env.DB.prepare("SELECT COALESCE(SUM(CASE WHEN status='blocked' THEN total ELSE 0 END),0) AS blocked,COALESCE(SUM(CASE WHEN status='failed' THEN total ELSE 0 END),0) AS failed FROM notification_job_counts WHERE status IN ('blocked','failed')").first();
  } catch (error) {
    // Safe rolling deployment while migration 0011 is waiting for the reset.
    if (!/no such table.*notification_job_counts/i.test(String(error.message))) throw error;
    const cached = fallbackTotals.get(env.DB);
    if (cached && cached.until > time) return cached.value;
    const value = await env.DB.prepare("SELECT SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END) AS blocked,SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed FROM notification_jobs").first();
    fallbackTotals.set(env.DB, {value,until:time+60000});
    return value;
  }
}
