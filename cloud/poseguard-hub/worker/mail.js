import { ApiError, readSetting } from './utils.js';
import { mailSettings } from './mail-config.js';
import { sendSmtp } from './smtp.js';
import { agentlyCall } from './agently-room.js';
export async function mailConfigured(env, mail) {
  return mail.provider === 'agently'
    ? !!(await readSetting(env, 'mail_agently', null))?.credentials_cipher
    : !!mail.password_cipher;
}
export async function sendMail(
  env,
  to,
  subject,
  text,
  id,
  { test = false } = {}
) {
  const mail = mailSettings(await readSetting(env, 'mail', {}));
  if (!test && !mail.enabled)
    throw new ApiError(409, '自动邮箱通知未启用', 'mail_not_configured');
  if (mail.provider === 'agently') {
    const result = await agentlyCall(env, 'send', { to, subject, text, id });
    return result.provider_id;
  }
  return sendSmtp(env, to, subject, text, id, { test });
}
