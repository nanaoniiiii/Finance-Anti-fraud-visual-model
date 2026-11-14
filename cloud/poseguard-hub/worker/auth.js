import {
  ApiError,
  audit,
  digest,
  email,
  now,
  randomToken,
  text,
  uid,
  unb64,
  b64,
} from './utils.js';
const COOKIE = 'poseguard_session';
export async function passwordHash(password) {
  text(password, 300);
  if (password.length < 12) throw new ApiError(400, '口令至少 12 位');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 },
    key,
    256
  );
  return `pbkdf2$100000$${b64(salt)}$${b64(new Uint8Array(bits))}`;
}
export async function passwordMatches(password, encoded) {
  if (!encoded) return false;
  try {
    const [kind, count, salt, wanted] = encoded.split('$');
    if (kind !== 'pbkdf2' || Number(count) !== 100000) return false;
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(text(password, 300)),
      'PBKDF2',
      false,
      ['deriveBits']
    );
    const bits = new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: 'PBKDF2',
          hash: 'SHA-256',
          salt: unb64(salt),
          iterations: 100000,
        },
        key,
        256
      )
    );
    const target = unb64(wanted);
    if (bits.length !== target.length) return false;
    let mismatch = 0;
    for (let i = 0; i < bits.length; i++) mismatch |= bits[i] ^ target[i];
    return mismatch === 0;
  } catch {
    return false;
  }
}
export async function rateLimit(env, key, limit, seconds) {
  const window = Math.floor(Date.now() / 1000 / seconds);
  const id = await digest(key + ':' + window);
  const result = await env.DB.prepare(
    'INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count'
  )
    .bind(id, (window + 2) * seconds)
    .first();
  if (result.count > limit)
    throw new ApiError(429, '请求过于频繁，请稍后重试', 'rate_limit');
}
export function checkOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (
    origin &&
    origin !== new URL(request.url).origin &&
    origin !== env.PUBLIC_ORIGIN
  )
    throw new ApiError(403, '跨站请求已拒绝');
}
export async function login(request, env, input) {
  checkOrigin(request, env);
  await rateLimit(
    env,
    'login:' + request.headers.get('CF-Connecting-IP'),
    12,
    600
  );
  const address = email(input.email);
  const row = await env.DB.prepare('SELECT * FROM users WHERE email=?')
    .bind(address)
    .first();
  const owner = address === env.OWNER_EMAIL?.toLowerCase();
  const encoded =
    row?.password_hash || (owner ? env.OWNER_PASSWORD_HASH : null);
  if (!(await passwordMatches(input.password || '', encoded)))
    throw new ApiError(401, '邮箱或口令不正确');
  let user = row;
  if (!user && owner) {
    user = { id: 'owner', email: address, name: '管理员', role: 'owner' };
    await env.DB.prepare(
      'INSERT OR IGNORE INTO users(id,email,name,role,created_at) VALUES(?,?,?,?,?)'
    )
      .bind(user.id, user.email, user.name, user.role, now())
      .run();
  }
  const token = randomToken();
  const expires = new Date(Date.now() + 30 * 86400000).toISOString();
  await env.DB.prepare(
    'INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)'
  )
    .bind(await digest(token), user.id, expires, now())
    .run();
  await audit(env, user.email, 'login', user.id);
  const isLocal = ['127.0.0.1', 'localhost'].includes(
    new URL(request.url).hostname
  );
  return {
    data: {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      ...(input.client_type === 'cli' ? { api_token: token } : {}),
    },
    cookie: `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${isLocal ? '' : '; Secure'}`,
  };
}
export async function userAuth(request, env) {
  let token = request.headers
    .get('Authorization')
    ?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
  const isBearer = !!token;
  if (!token) {
    token = (request.headers.get('Cookie') || '')
      .split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith(COOKIE + '='))
      ?.slice(COOKIE.length + 1);
  }
  if (!token) throw new ApiError(401, '请先登录', 'login_required');
  const row = await env.DB.prepare(
    'SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>?'
  )
    .bind(await digest(token), now())
    .first();
  if (!row) throw new ApiError(401, '登录已过期', 'login_required');
  if (!isBearer && !['GET', 'HEAD'].includes(request.method)) {
    const origin = request.headers.get('Origin');
    if (!origin) throw new ApiError(403, '缺少同源校验');
    checkOrigin(request, env);
  }
  return { ...row, token_hash: await digest(token) };
}
export function ownerOnly(user) {
  if (user.role !== 'owner') throw new ApiError(403, '需要管理员权限');
}
export async function deviceAuth(request, env) {
  const token = request.headers
    .get('Authorization')
    ?.match(/^Bearer (pgd_[A-Za-z0-9_-]+)$/)?.[1];
  if (!token) throw new ApiError(401, '缺少设备密钥');
  const device = await env.DB.prepare(
    'SELECT * FROM devices WHERE token_hash=? AND revoked_at IS NULL'
  )
    .bind(await digest(token))
    .first();
  if (!device) throw new ApiError(401, '设备密钥无效或已解除绑定');
  return device;
}
export async function logout(env, user) {
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?')
    .bind(user.token_hash)
    .run();
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
