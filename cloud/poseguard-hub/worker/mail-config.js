import {
  ApiError,
  defaultMail,
  email,
  encrypt,
  integer,
  readSetting,
  text,
} from './utils.js';

export function mailSettings(saved = {}) {
  return {
    ...defaultMail,
    ...saved,
    // Old configurations chose encryption by port; retain that behavior.
    security: saved.security ?? (saved.port === 587 ? 'starttls' : 'tls'),
    auth: saved.auth ?? 'auto',
  };
}
export function validateSmtp(mail, { allowEmpty = false } = {}) {
  const host = text(mail.host, 253).toLowerCase().replace(/\.$/, '');
  if (!host && !allowEmpty) throw new ApiError(400, '请填写 SMTP 服务器');
  if (
    host &&
    (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) ||
      host.includes('..') ||
      /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(
        host
      ))
  )
    throw new ApiError(400, '请填写可由云端访问的 SMTP 公网域名或地址');
  integer(mail.port, 1, 65535);
  if (mail.port === 25)
    throw new ApiError(
      400,
      '当前云端不支持连接 25 端口，请使用服务商提供的加密提交端口'
    );
  if (!['tls', 'starttls'].includes(mail.security))
    throw new ApiError(400, '请选择 TLS 或 STARTTLS');
  if (!['auto', 'login', 'plain'].includes(mail.auth))
    throw new ApiError(400, 'SMTP 认证方式不正确');
  const username = text(mail.username, 320);
  if (/[\r\n\0]/.test(username) || (!username && !allowEmpty))
    throw new ApiError(400, '请填写有效的 SMTP 登录账号');
  return { ...mail, host, username };
}
export async function updateMailSettings(env, previous, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new ApiError(400, '邮件设置格式不正确');
  previous = mailSettings(previous);
  const security =
    input.security ??
    (input.port !== undefined && input.port !== previous.port
      ? input.port === 465
        ? 'tls'
        : 'starttls'
      : previous.security);
  const merged = { ...previous, ...input, security };
  if (typeof merged.enabled !== 'boolean')
    throw new ApiError(400, '自动通知开关不正确');
  if (!Array.isArray(merged.recipients))
    throw new ApiError(400, '收件人须为邮箱列表');
  const recipients = [...new Set(merged.recipients.map(email))];
  if (recipients.length > 20) throw new ApiError(400, '收件人最多 20 个');
  const provider = input.provider ?? previous.provider;
  if (!['smtp', 'agently'].includes(provider))
    throw new ApiError(400, '发信通道不正确');
  if (provider === 'agently') {
    const account = await readSetting(env, 'mail_agently', null);
    if (merged.enabled && (!account?.credentials_cipher || !recipients.length))
      throw new ApiError(409, '启用通知前，请先连接 Agent Mail 并添加收件人');
    return { ...previous, provider, enabled: merged.enabled, recipients };
  }
  const mail = validateSmtp(
    {
      provider: 'smtp',
      host: merged.host,
      port: merged.port,
      security,
      auth: merged.auth,
      username: merged.username,
      from: merged.from ? email(merged.from) : '',
      from_name: text(merged.from_name || 'PoseGuard 预警中心', 100),
      enabled: merged.enabled,
      recipients,
    },
    { allowEmpty: !merged.enabled }
  );
  const changedAccount =
    mail.host !==
      String(previous.host).trim().toLowerCase().replace(/\.$/, '') ||
    mail.username !== previous.username ||
    mail.auth !== previous.auth;
  mail.password_cipher = changedAccount ? undefined : previous.password_cipher;
  if (
    input.password !== undefined &&
    (typeof input.password !== 'string' || input.password.length > 2048)
  )
    throw new ApiError(400, 'SMTP 凭据格式或长度不正确');
  if (input.password) mail.password_cipher = await encrypt(env, input.password);
  if (
    mail.enabled &&
    (!mail.from || !mail.password_cipher || !mail.recipients.length)
  )
    throw new ApiError(
      400,
      changedAccount && !input.password
        ? '更换 SMTP 服务器或账号后，请填写新凭据或关闭自动通知'
        : '启用自动通知前，请配置发件邮箱、SMTP 凭据和收件人'
    );
  return mail;
}
