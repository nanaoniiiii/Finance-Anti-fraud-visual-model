import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeGrant,
  refreshGrant,
  agentlyIdentity,
  queueAgentlyMessage,
  AGENTLY_API,
  AGENTLY_AUTH,
} from '../worker/agently-client.js';
import { updateMailSettings } from '../worker/mail-config.js';

const grant = () => ({
  access_token: 'fixture-access',
  refresh_token: 'fixture-refresh',
  app_id: 'cli_fixture',
  expires_at: Date.now() / 1000 + 3600,
});
test('Agent Mail：授权只保留所需字段，拒绝无效有效期和缺失凭据', () => {
  assert.equal(
    normalizeGrant({ ...grant(), api_base: 'https://invalid.example' })
      .api_base,
    undefined
  );
  assert.throws(() => normalizeGrant({ ...grant(), refresh_token: '' }));
  assert.throws(() => normalizeGrant({ ...grant(), expires_at: 'invalid' }));
});
test('Agent Mail：身份查询固定官方HTTPS域名，携带Bearer', async () => {
  const identity = await agentlyIdentity(grant(), async (url, options) => {
    assert.equal(url, AGENTLY_API + '/v1/me');
    assert.equal(options.headers.Authorization, 'Bearer fixture-access');
    return Response.json({
      data: {
        aliases: [{ email: 'alerts@example.test' }],
        scopes: ['mail:send'],
      },
    });
  });
  assert.equal(identity.aliases[0].email, 'alerts@example.test');
});
test('Agent Mail：云端续期使用原生OAuth表单，接收旋转后的refresh_token', async () => {
  const before = Date.now() / 1000;
  const updated = await refreshGrant(grant(), async (url, options) => {
    assert.equal(url, AGENTLY_AUTH);
    assert.equal(options.method, 'POST');
    const form = new URLSearchParams(options.body);
    assert.equal(form.get('client_id'), 'cli_fixture');
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('refresh_token'), 'fixture-refresh');
    return Response.json({
      access_token: 'new-access',
      refresh_token: 'rotated-refresh',
      expires_in: 3600,
      token_type: 'Bearer',
    });
  });
  assert.equal(updated.refresh_token, 'rotated-refresh');
  assert.ok(updated.expires_at >= before + 3599);
});
test('Agent Mail：授权失效给出重新接入状态，不伪造续期成功', async () => {
  await assert.rejects(
    refreshGrant(grant(), async () =>
      Response.json({ error: 'invalid_grant' }, { status: 401 })
    ),
    (error) => error.code === 'mail_reauthorization_required'
  );
});
test('Agent Mail：告警邮件为纯文本，收件人精确匹配，确认服务已入队', async () => {
  const result = await queueAgentlyMessage(
    grant(),
    'alias_fixture',
    {
      id: 'job-1',
      to: 'staff@example.test',
      subject: '紧急通知测试',
      text: 'fixture body',
    },
    async (url, options) => {
      assert.equal(
        url,
        AGENTLY_API + '/v1/aliases/alias_fixture/messages/send'
      );
      const body = JSON.parse(options.body);
      assert.deepEqual(body.to, [{ email: 'staff@example.test' }]);
      assert.equal(body.body_format, 'PLAIN');
      assert.equal(body.skip_confirmation, true);
      return Response.json({ queued: true });
    }
  );
  assert.deepEqual(result, { queued: true, provider_id: 'agently:job-1' });
});
test('Agent Mail：服务限流保留Retry-After；未入队不当作发送成功', async () => {
  await assert.rejects(
    queueAgentlyMessage(
      grant(),
      'alias_fixture',
      { id: 'job-1', to: 'staff@example.test', subject: 'test', text: 'body' },
      async () =>
        Response.json(
          { error: 'rate_limited' },
          { status: 429, headers: { 'Retry-After': '120' } }
        )
    ),
    (error) => error.status === 429 && error.retryAfter === 120
  );
  await assert.rejects(
    queueAgentlyMessage(
      grant(),
      'alias_fixture',
      { id: 'job-1', to: 'staff@example.test', subject: 'test', text: 'body' },
      async () => Response.json({ queued: false })
    ),
    /未返回邮件已入队/
  );
});
test('Agent Mail：拒绝伪造地址ID和邮件头注入', async () => {
  const never = () => {
    throw new Error('network must not be reached');
  };
  const message = {
    id: 'job-1',
    to: 'staff@example.test',
    subject: 'x',
    text: 'body',
  };
  await assert.rejects(
    queueAgentlyMessage(grant(), '../invalid', message, never)
  );
  await assert.rejects(
    queueAgentlyMessage(
      grant(),
      'alias_fixture',
      { ...message, subject: 'x\r\nBcc:bad@example.test' },
      never
    )
  );
});
test('Agent Mail：切换通道保留SMTP凭据与收件人，未授权不能启用', async () => {
  const db = {
    prepare() {
      return {
        bind() {
          return this;
        },
        async first() {
          return {
            value: JSON.stringify({ credentials_cipher: 'fixture-encrypted' }),
          };
        },
      };
    },
  };
  const previous = {
    provider: 'smtp',
    host: 'smtp.example.test',
    port: 465,
    security: 'tls',
    auth: 'auto',
    username: 'smtp-user',
    from: 'smtp@example.test',
    password_cipher: 'saved-smtp',
    enabled: false,
    recipients: ['staff@example.test'],
  };
  const mail = await updateMailSettings({ DB: db }, previous, {
    provider: 'agently',
    enabled: true,
    from: 'different@example.test',
  });
  assert.equal(mail.from, previous.from);
  assert.equal(mail.password_cipher, previous.password_cipher);
  assert.deepEqual(mail.recipients, previous.recipients);
  const empty = {
    prepare() {
      return {
        bind() {
          return this;
        },
        async first() {
          return null;
        },
      };
    },
  };
  await assert.rejects(
    updateMailSettings({ DB: empty }, previous, {
      provider: 'agently',
      enabled: true,
    }),
    /请先连接 Agent Mail/
  );
});
