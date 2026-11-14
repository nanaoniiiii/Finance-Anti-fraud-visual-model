export class ApiError extends Error {
  constructor(status, message, code = 'request_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const now = () => new Date().toISOString();
export const uid = () => crypto.randomUUID();
export const platforms = new Set([
  'windows',
  'rk3566',
  'maixcam',
  'esp32s3',
  'android',
  'ios',
]);
export const risks = new Set(['phone_to_ear', 'multi_person', 'lingering']);
export const riskLabels = {
  phone_to_ear: '疑似通话姿态',
  multi_person: '多人进入',
  lingering: '长时间停留',
};
export const levelLabels = ['候选', '关注', '高风险', '紧急介入'];
export const defaultRules = {
  frame_threshold: 100,
  escalation_threshold: 300,
  include_candidates: true,
  clear_grace_seconds: 2,
  heartbeat_seconds: 30,
  retention_days: 7,
};
export const defaultMail = {
  provider: 'smtp',
  host: 'smtp.gmail.com',
  port: 465,
  tls: true,
  username: '',
  from: '',
  from_name: 'PoseGuard 预警中心',
  recipients: [],
  enabled: false,
};
export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extra,
    },
  });
}
export function text(value, max = 200) {
  if (typeof value !== 'string' || value.length > max)
    throw new ApiError(400, '文本格式或长度不正确');
  return value.trim();
}
export function email(value) {
  const result = text(value, 254).toLowerCase();
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(result))
    throw new ApiError(400, '邮箱格式不正确');
  return result;
}
export function identifier(value) {
  const result = text(value, 100);
  if (!/^[a-zA-Z0-9_.:-]{1,100}$/.test(result))
    throw new ApiError(400, '标识格式不正确');
  return result;
}
export function integer(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new ApiError(400, `数值须在 ${min}～${max} 之间`);
  return value;
}
export function parse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
export async function body(request, max = 420000) {
  const reader = request.body?.getReader();
  if (!reader) return {};
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new ApiError(413, '请求超过大小限制');
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const item of chunks) {
    bytes.set(item, offset);
    offset += item.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError(400, 'JSON 格式不正确');
  }
}
export function b64(bytes) {
  let value = '';
  for (let i = 0; i < bytes.length; i += 8192)
    value += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(value);
}
export function unb64(value) {
  try {
    return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  } catch {
    throw new ApiError(400, 'Base64 格式不正确');
  }
}
export function randomToken(bytes = 32) {
  return b64(crypto.getRandomValues(new Uint8Array(bytes)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
export async function digest(value) {
  const result = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value)
  );
  return [...new Uint8Array(result)]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}
export async function readSetting(env, key, fallback) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key=?')
    .bind(key)
    .first();
  return row ? parse(row.value, fallback) : fallback;
}
export async function saveSetting(env, key, value) {
  await env.DB.prepare(
    'INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at'
  )
    .bind(key, JSON.stringify(value), now())
    .run();
}
export async function audit(env, actor, action, entity, details = {}) {
  await env.DB.prepare(
    'INSERT INTO audit(actor,action,entity_id,details_json,created_at) VALUES(?,?,?,?,?)'
  )
    .bind(actor, action, entity, JSON.stringify(details), now())
    .run();
}
export async function encrypt(env, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    unb64(env.ENCRYPTION_KEY),
    'AES-GCM',
    false,
    ['encrypt']
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(value)
  );
  return b64(iv) + '.' + b64(new Uint8Array(data));
}
export async function decrypt(env, value) {
  if (!value) return '';
  const [iv, data] = value.split('.');
  const key = await crypto.subtle.importKey(
    'raw',
    unb64(env.ENCRYPTION_KEY),
    'AES-GCM',
    false,
    ['decrypt']
  );
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(iv) },
      key,
      unb64(data)
    )
  );
}
export function iso(value, fallback = now()) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}
export function severityFor(frames, state, confirmed, rules) {
  if (frames <= rules.frame_threshold) return 0;
  if (confirmed && frames > rules.escalation_threshold) return 3;
  if (confirmed || state === 'alert' || frames > rules.escalation_threshold)
    return 2;
  return 1;
}
export function validateRules(input) {
  const rule = { ...defaultRules, ...input };
  integer(rule.frame_threshold, 1, 1000000);
  integer(rule.escalation_threshold, rule.frame_threshold + 1, 10000000);
  integer(rule.heartbeat_seconds, 10, 300);
  integer(rule.retention_days, 1, 30);
  if (
    typeof rule.include_candidates !== 'boolean' ||
    !Number.isFinite(rule.clear_grace_seconds) ||
    rule.clear_grace_seconds < 0.5 ||
    rule.clear_grace_seconds > 30
  )
    throw new ApiError(400, '累计规则不正确');
  return rule;
}
export function validSnapshot(input) {
  if (!input) return null;
  const data = text(input.data_base64, 280000);
  const bytes = unb64(data);
  if (bytes.length < 4 || bytes.length > 200000)
    throw new ApiError(400, '截图须小于 200KB');
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const png =
    bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
  if (!jpeg && !png) throw new ApiError(400, '截图只支持 JPEG/PNG');
  return {
    data_base64: data,
    bytes: bytes.length,
    mime_type: jpeg ? 'image/jpeg' : 'image/png',
    captured_at: iso(input.captured_at),
  };
}
export function secure(response, request, env) {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set(
    'Content-Security-Policy',
    `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' wss://${new URL(env.PUBLIC_ORIGIN || request.url).host}; worker-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'`
  );
  if (new URL(request.url).protocol === 'https:')
    headers.set('Strict-Transport-Security', 'max-age=31536000');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
    webSocket: response.webSocket,
  });
}
