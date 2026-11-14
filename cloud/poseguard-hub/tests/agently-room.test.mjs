import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { encrypt, decrypt } from '../worker/utils.js';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers')
      return {
        url:
          'data:text/javascript,' +
          encodeURIComponent(
            'export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }'
          ),
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
const { AgentlyMailRoom } = await import('../worker/agently-room.js');
async function fixture({ expired = false } = {}) {
  const rows = new Map(),
    stored = new Map();
  let chain = Promise.resolve(),
    refreshes = 0,
    sends = 0;
  const env = {
    ENCRYPTION_KEY: btoa('0123456789abcdef0123456789abcdef'),
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            this.args = args;
            return this;
          },
          async first() {
            const value = rows.get(this.args[0]);
            return value === undefined ? null : { value };
          },
          async run() {
            rows.set(this.args[0], this.args[1]);
          },
        };
      },
    },
  };
  const ctx = {
    blockConcurrencyWhile(fn) {
      const result = chain.then(fn);
      chain = result.then(
        () => {},
        () => {}
      );
      return result;
    },
    storage: {
      async get(k) {
        return stored.get(k);
      },
      async put(k, v) {
        stored.set(k, v);
      },
      async setAlarm() {},
      async list({ prefix }) {
        return new Map([...stored].filter(([key]) => key.startsWith(prefix)));
      },
      async delete(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys])
          stored.delete(key);
      },
    },
  };
  const grant = {
    app_id: 'cli_fixture',
    access_token: 'fixture-access-private',
    refresh_token: 'fixture-refresh-private',
    expires_at: Math.floor(Date.now() / 1000) + (expired ? -10 : 3600),
  };
  rows.set(
    'mail_agently',
    JSON.stringify({
      credentials_cipher: await encrypt(env, JSON.stringify(grant)),
      alias_id: 'alias_fixture',
      email: 'alerts@example.test',
      expires_at: new Date(grant.expires_at * 1000).toISOString(),
    })
  );
  const room = new AgentlyMailRoom(ctx, env);
  const fetcher = async (url, options = {}) => {
    if (url === 'https://auth.agent.qq.com/oauth/token') {
      refreshes++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return Response.json({
        access_token: 'new-access-private',
        refresh_token: 'rotated-refresh-private',
        expires_in: 3600,
      });
    }
    if (url === 'https://api.agent.qq.com/v1/me')
      return Response.json({
        data: {
          aliases: [
            { alias_id: 'alias_fixture', email: 'alerts@example.test' },
          ],
          scopes: ['mail:send'],
          rate_limits: { daily_send_quota: 50 },
        },
      });
    if (
      url === 'https://api.agent.qq.com/v1/aliases/alias_fixture/messages/send'
    ) {
      sends++;
      const body = JSON.parse(options.body);
      assert.equal(body.to[0].email, 'staff@example.test');
      return Response.json({ queued: true });
    }
    throw new Error('Unexpected egress host');
  };
  const call = async (op, value) => {
    const response = await room.fetch(
      new Request('https://mail.internal/' + op, {
        method: 'POST',
        body: JSON.stringify(value),
      })
    );
    return { status: response.status, body: await response.json() };
  };
  return {
    env,
    rows,
    stored,
    room,
    fetcher,
    call,
    counts: () => ({ refreshes, sends }),
  };
}
const message = (id) => ({
  id,
  to: 'staff@example.test',
  subject: 'fixture notification',
  text: 'fixture body',
});
test('云端Agent Mail：并发邮件只续期一次，旋转凭据加密持久化', async () => {
  const f = await fixture({ expired: true }),
    original = globalThis.fetch;
  globalThis.fetch = f.fetcher;
  try {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => f.call('send', message('job-' + i)))
    );
    assert.ok(results.every((r) => r.status === 200));
    assert.deepEqual(f.counts(), { refreshes: 1, sends: 6 });
    const record = JSON.parse(f.rows.get('mail_agently'));
    const updated = JSON.parse(await decrypt(f.env, record.credentials_cipher));
    assert.equal(updated.refresh_token, 'rotated-refresh-private');
    assert.ok(updated.expires_at > Date.now() / 1000 + 3500);
    assert.equal(JSON.stringify(results).includes('private'), false);
  } finally {
    globalThis.fetch = original;
  }
});
test('云端Agent Mail：相同任务复用已接受回执，内容冲突不重复发信', async () => {
  const f = await fixture(),
    original = globalThis.fetch;
  globalThis.fetch = f.fetcher;
  try {
    assert.equal((await f.call('send', message('same-job'))).status, 200);
    assert.equal((await f.call('send', message('same-job'))).body.cached, true);
    assert.equal(
      (await f.call('send', { ...message('same-job'), text: 'changed' }))
        .status,
      409
    );
    assert.equal(f.counts().sends, 1);
  } finally {
    globalThis.fetch = original;
  }
});
test('云端Agent Mail：发送窗口超限进入等待，不再调用外部发信', async () => {
  const f = await fixture(),
    original = globalThis.fetch;
  globalThis.fetch = f.fetcher;
  try {
    for (let i = 0; i < 8; i++)
      assert.equal((await f.call('send', message('limited-' + i))).status, 200);
    const limited = await f.call('send', message('limited-9'));
    assert.equal(limited.status, 429);
    assert.ok(limited.body.retry_after > 0);
    assert.equal(f.counts().sends, 8);
  } finally {
    globalThis.fetch = original;
  }
});
test('云端Agent Mail：导入核对邮箱与权限，响应不包含凭据', async () => {
  const f = await fixture(),
    original = globalThis.fetch;
  globalThis.fetch = f.fetcher;
  try {
    const record = JSON.parse(f.rows.get('mail_agently'));
    const denied = await f.call('install', {
      credentials_cipher: record.credentials_cipher,
      expected_email: 'different@example.test',
    });
    assert.equal(denied.status, 409);
    assert.equal(
      JSON.parse(f.rows.get('mail_agently')).email,
      'alerts@example.test'
    );
    const accepted = await f.call('install', {
      credentials_cipher: record.credentials_cipher,
      expected_email: 'alerts@example.test',
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.daily_send_quota, 50);
    assert.equal(accepted.body.credentials_cipher, undefined);
    assert.equal(JSON.stringify(accepted).includes('private'), false);
    assert.equal(
      (await f.call('verify', { refresh: true })).body.verified,
      true
    );
  } finally {
    globalThis.fetch = original;
  }
});
