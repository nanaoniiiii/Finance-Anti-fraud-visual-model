import { ApiError, email } from './utils.js';

export const AGENTLY_API = 'https://api.agent.qq.com';
export const AGENTLY_AUTH = 'https://auth.agent.qq.com/oauth/token';
export function normalizeGrant(input) {
  if (!input || typeof input !== 'object')
    throw new ApiError(400, 'Agent Mail 授权格式不正确');
  for (const field of ['access_token', 'refresh_token', 'app_id'])
    if (
      typeof input[field] !== 'string' ||
      !input[field] ||
      input[field].length > 16000
    )
      throw new ApiError(400, 'Agent Mail 授权缺少必要字段');
  const expires = Number(input.expires_at);
  if (!Number.isFinite(expires) || expires <= 0)
    throw new ApiError(400, 'Agent Mail 授权有效期不正确');
  return {
    access_token: input.access_token,
    refresh_token: input.refresh_token,
    app_id: input.app_id,
    expires_at: expires,
  };
}
async function responseData(response) {
  let result;
  try {
    result = await response.json();
  } catch {
    throw new ApiError(502, 'Agent Mail 返回的响应无法解析');
  }
  if (!response.ok || result.error || result.ok === false) {
    if (response.status === 429) {
      const raw = response.headers.get('Retry-After');
      const seconds = Number(raw);
      const delay = raw && Number.isFinite(seconds) ? seconds : raw && Number.isFinite(Date.parse(raw)) ? Math.ceil((Date.parse(raw) - Date.now()) / 1000) : 60;
      const error = new ApiError(
        429,
        'Agent Mail 发送额度或请求频率受限，邮件保留在队列中等待重试',
        'mail_rate_limited'
      );
      error.retryAfter = Math.max(
        10,
        Math.min(86400, delay)
      );
      throw error;
    }
    if (
      response.status === 401 ||
      ([400, 403].includes(response.status) &&
        /invalid_grant|invalid_token|expired_token/.test(String(result.error)))
    )
      throw new ApiError(
        409,
        'Agent Mail 授权已失效，请重新授权接入',
        'mail_reauthorization_required'
      );
    throw new ApiError(
      502,
      `Agent Mail 服务拒绝请求（${response.status}）`,
      'agently_rejected'
    );
  }
  return result;
}
export async function refreshGrant(grant, fetcher = fetch) {
  const response = await fetcher(AGENTLY_AUTH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: grant.app_id,
      refresh_token: grant.refresh_token,
    }),
    signal: AbortSignal.timeout(10000),
  });
  const body = await responseData(response),
    value = body.data || body;
  if (
    !value.access_token ||
    !value.refresh_token ||
    !Number.isFinite(Number(value.expires_in))
  )
    throw new ApiError(502, 'Agent Mail 续期响应缺少必要字段');
  return normalizeGrant({
    ...grant,
    ...value,
    expires_at: Math.floor(Date.now() / 1000) + Number(value.expires_in),
  });
}
export async function agentlyIdentity(grant, fetcher = fetch) {
  const response = await fetcher(AGENTLY_API + '/v1/me', {
    headers: {
      Authorization: 'Bearer ' + grant.access_token,
      'User-Agent': 'PoseGuard-Cloud/1.4.0',
    },
    signal: AbortSignal.timeout(10000),
  });
  const value = await responseData(response);
  return value.data || value;
}
export async function queueAgentlyMessage(
  grant,
  aliasId,
  message,
  fetcher = fetch
) {
  if (!/^alias_[A-Za-z0-9_-]+$/.test(aliasId))
    throw new ApiError(400, 'Agent Mail 发件地址标识不正确');
  if (
    typeof message.subject !== 'string' ||
    !message.subject ||
    message.subject.length > 300 ||
    /[\r\n]/.test(message.subject)
  )
    throw new ApiError(400, '邮件主题不正确');
  if (typeof message.text !== 'string' || message.text.length > 100000)
    throw new ApiError(400, '邮件正文不正确');
  const response = await fetcher(
    AGENTLY_API +
      '/v1/aliases/' +
      encodeURIComponent(aliasId) +
      '/messages/send',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + grant.access_token,
        'Content-Type': 'application/json',
        'User-Agent': 'PoseGuard-Cloud/1.4.0',
      },
      body: JSON.stringify({
        to: [{ email: email(message.to) }],
        subject: message.subject,
        body: message.text,
        body_format: 'PLAIN',
        skip_confirmation: true,
      }),
      signal: AbortSignal.timeout(12000),
    }
  );
  const result = await responseData(response),
    value = result.data || result;
  if (value.confirmation_required)
    throw new ApiError(
      409,
      'Agent Mail 仍要求单封邮件确认，邮件尚未发送',
      'mail_confirmation_required'
    );
  if (value.queued !== true)
    throw new ApiError(502, 'Agent Mail 未返回邮件已入队回执');
  return {
    queued: true,
    provider_id: value.message_id || 'agently:' + message.id,
  };
}
