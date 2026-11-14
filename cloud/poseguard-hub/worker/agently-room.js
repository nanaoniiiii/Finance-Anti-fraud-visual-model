import { DurableObject } from 'cloudflare:workers';
import {
  ApiError,
  decrypt,
  digest,
  email,
  encrypt,
  json,
  now,
  readSetting,
  saveSetting,
} from './utils.js';
import {
  normalizeGrant,
  refreshGrant,
  agentlyIdentity,
  queueAgentlyMessage,
} from './agently-client.js';

export function publicAgently(record) {
  return {
    connected: !!record?.credentials_cipher,
    email: record?.email || '',
    expires_at: record?.expires_at || null,
    refreshed_at: record?.refreshed_at || null,
    daily_send_quota: record?.daily_send_quota || null,
    last_error: record?.last_error || null,
  };
}
export async function agentlyCall(env, operation, input = {}) {
  const stub = env.MAIL_AUTH.get(
    env.MAIL_AUTH.idFromName('primary-mail-account')
  );
  const response = await stub.fetch('https://mail.internal/' + operation, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new ApiError(
      response.status,
      result.error || 'Agent Mail 处理失败',
      result.code
    );
    error.retryAfter = result.retry_after;
    throw error;
  }
  return result;
}
export class AgentlyMailRoom extends DurableObject {
  async fetch(request) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const operation = new URL(request.url).pathname;
      try {
        const input = await request.json();
        if (operation === '/install') return await this.install(input);
        const record = await readSetting(this.env, 'mail_agently', null);
        if (!record?.credentials_cipher)
          throw new ApiError(
            409,
            'Agent Mail 尚未授权接入',
            'mail_not_configured'
          );
        if (operation === '/verify') {
          const { grant } = await this.token(record, input.refresh === true);
          const identity = await agentlyIdentity(grant);
          if (
            !identity.aliases?.some(
              (alias) =>
                alias.alias_id === record.alias_id &&
                alias.email === record.email
            )
          )
            throw new ApiError(
              409,
              'Agent Mail 发件地址授权已变更，请重新接入'
            );
          return json({ ...publicAgently(record), verified: true });
        }
        if (operation !== '/send') throw new ApiError(404, '操作不存在');
        if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(input.id || ''))
          throw new ApiError(400, '邮件任务标识不正确');
        const hash = await digest(
          JSON.stringify([record.email, input.to, input.subject, input.text])
        );
        const receiptKey = 'sent/' + input.id;
        const previous = await this.ctx.storage.get(receiptKey);
        if (previous) {
          if (previous.hash !== hash)
            throw new ApiError(409, '邮件任务内容与已有回执不一致');
          return json({
            queued: true,
            provider_id: previous.provider_id,
            cached: true,
          });
        }
        const timestamp = Date.now();
        const blocked = (await this.ctx.storage.get('blocked_until')) || 0;
        let window = ((await this.ctx.storage.get('send_window')) || []).filter(
          (at) => timestamp - at < 60000
        );
        if (timestamp < blocked || window.length >= 8) {
          const error = new ApiError(
            429,
            'Agent Mail 发送频率受限，邮件在队列中等待',
            'mail_rate_limited'
          );
          error.retryAfter = Math.max(
            1,
            Math.ceil(
              ((timestamp < blocked ? blocked : window[0] + 60000) -
                timestamp) /
                1000
            )
          );
          throw error;
        }
        const { grant } = await this.token(record);
        await this.ctx.storage.put('send_window', [...window, timestamp]);
        let result;
        try {
          result = await queueAgentlyMessage(grant, record.alias_id, {
            to: input.to,
            subject: input.subject,
            text: input.text,
            id: input.id,
          });
        } catch (error) {
          if (error.status === 429)
            await this.ctx.storage.put(
              'blocked_until',
              Date.now() + (error.retryAfter || 60) * 1000
            );
          throw error;
        }
        await this.ctx.storage.put(receiptKey, {
          hash,
          provider_id: result.provider_id,
          accepted_at: Date.now(),
        });
        await this.ctx.storage.setAlarm(Date.now() + 86400000);
        if (record.last_error) {
          record.last_error = null;
          await saveSetting(this.env, 'mail_agently', record);
        }
        return json(result);
      } catch (error) {
        if (error.status === 429)
          await this.ctx.storage.put(
            'blocked_until',
            Date.now() + (error.retryAfter || 60) * 1000
          );
        const message =
          error instanceof ApiError
            ? error.message
            : 'Agent Mail 服务连接失败，任务将按队列规则重试';
        if (operation !== '/install') {
          const record = await readSetting(this.env, 'mail_agently', null);
          if (record) {
            record.last_error = message;
            await saveSetting(this.env, 'mail_agently', record);
          }
        }
        return json(
          { error: message, code: error.code, retry_after: error.retryAfter },
          error.status || 502
        );
      }
    });
  }
  async token(record, force = false) {
    let grant = normalizeGrant(
      JSON.parse(await decrypt(this.env, record.credentials_cipher))
    );
    if (force || grant.expires_at <= Date.now() / 1000 + 90) {
      grant = await refreshGrant(grant);
      record.credentials_cipher = await encrypt(
        this.env,
        JSON.stringify(grant)
      );
      record.expires_at = new Date(grant.expires_at * 1000).toISOString();
      record.refreshed_at = now();
      record.last_error = null;
      await saveSetting(this.env, 'mail_agently', record);
    }
    return { grant };
  }
  async install(input) {
    if (
      typeof input.credentials_cipher !== 'string' ||
      input.credentials_cipher.length > 50000
    )
      throw new ApiError(400, '缺少加密的项目专用授权');
    let grant = normalizeGrant(
      JSON.parse(await decrypt(this.env, input.credentials_cipher))
    );
    if (grant.expires_at <= Date.now() / 1000 + 90)
      grant = await refreshGrant(grant);
    const identity = await agentlyIdentity(grant);
    const expected = email(input.expected_email);
    const alias = identity.aliases?.find((alias) => alias.email === expected);
    if (!alias || !/^alias_[A-Za-z0-9_-]+$/.test(alias.alias_id))
      throw new ApiError(409, '项目授权返回的邮箱与预期不一致');
    if (!identity.scopes?.includes('mail:send'))
      throw new ApiError(409, '项目授权缺少发信权限');
    const record = {
      credentials_cipher: await encrypt(this.env, JSON.stringify(grant)),
      email: expected,
      alias_id: alias.alias_id,
      connected_at: now(),
      expires_at: new Date(grant.expires_at * 1000).toISOString(),
      daily_send_quota: identity.rate_limits?.daily_send_quota || null,
      last_error: null,
    };
    await saveSetting(this.env, 'mail_agently', record);
    return json({ ...publicAgently(record), verified: true });
  }
  async alarm() {
    const entries = await this.ctx.storage.list({ prefix: 'sent/' });
    const expired = [...entries]
      .filter(([, item]) => item.accepted_at < Date.now() - 7 * 86400000)
      .map(([key]) => key);
    if (expired.length) await this.ctx.storage.delete(expired);
    if (entries.size > expired.length)
      await this.ctx.storage.setAlarm(Date.now() + 86400000);
  }
}
