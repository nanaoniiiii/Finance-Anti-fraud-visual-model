import { connect } from 'cloudflare:sockets';
import { ApiError, decrypt, readSetting } from './utils.js';
import { mailSettings, validateSmtp } from './mail-config.js';
import { deliverSmtp } from './smtp-client.js';
export { mimeMessage } from './smtp-client.js';

export async function verifySmtp(env, mail) {
  const config = validateSmtp(mail);
  if (!config.password_cipher || !config.from) throw new ApiError(409, '请填写 SMTP 发件账号和授权码');
  return deliverSmtp(config, await decrypt(env, config.password_cipher), null, connect, { authenticateOnly: true });
}

export async function sendSmtp(
  env,
  to,
  subject,
  text,
  id,
  { test = false } = {}
) {
  const config = validateSmtp(mailSettings(await readSetting(env, 'mail', {})));
  if ((!test && !config.enabled) || !config.password_cipher || !config.from)
    throw new ApiError(
      409,
      '请先保存 SMTP 发信账号和凭据',
      'mail_not_configured'
    );
  return deliverSmtp(
    config,
    await decrypt(env, config.password_cipher),
    { to, subject, text, id },
    connect
  );
}
