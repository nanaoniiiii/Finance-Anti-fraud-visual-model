import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mailSettings,
  updateMailSettings,
  validateSmtp,
} from '../worker/mail-config.js';
import { deliverSmtp, mimeMessage } from '../worker/smtp-client.js';
import { decrypt } from '../worker/utils.js';

const env = { ENCRYPTION_KEY: btoa('0123456789abcdef0123456789abcdef') };
const account = (extra = {}) =>
  mailSettings({
    host: 'smtp.example.test',
    port: 2525,
    security: 'starttls',
    auth: 'auto',
    username: 'smtp-api-user',
    from: 'alerts@example.test',
    recipients: ['staff@example.test'],
    enabled: false,
    ...extra,
  });

test('通用SMTP：旧配置迁移，端口和TLS独立，用户名无需邮箱格式', async () => {
  assert.equal(mailSettings({ port: 587, tls: true }).security, 'starttls');
  assert.equal(mailSettings({ port: 465 }).security, 'tls');
  const mail = await updateMailSettings(
    env,
    {},
    account({ port: 2465, security: 'tls', password: 'fixture-api-key' })
  );
  assert.equal(mail.port, 2465);
  assert.equal(mail.security, 'tls');
  assert.equal(mail.username, 'smtp-api-user');
  assert.equal(await decrypt(env, mail.password_cipher), 'fixture-api-key');
  assert.equal(mail.password, undefined);
  assert.equal(mail.password_set, undefined);
});
test('通用SMTP：保留已有凭据，换服务器或账号后不复用旧凭据', async () => {
  const previous = await updateMailSettings(
    env,
    {},
    account({ password: 'private-fixture' })
  );
  const kept = await updateMailSettings(env, previous, {
    from: 'alias@example.test',
    password: '',
  });
  assert.equal(kept.password_cipher, previous.password_cipher);
  const switched = await updateMailSettings(env, previous, {
    host: 'new.example.test',
    password: '',
  });
  assert.equal(switched.password_cipher, undefined);
  await assert.rejects(
    updateMailSettings(env, previous, {
      username: 'different-user',
      enabled: true,
    }),
    /新凭据/
  );
  const replaced = await updateMailSettings(env, previous, {
    username: 'different-user',
    password: 'new-key',
    enabled: true,
  });
  assert.equal(await decrypt(env, replaced.password_cipher), 'new-key');
});
test('通用SMTP：拒绝端口25、非法端口、私网地址和注入', () => {
  for (const change of [
    { port: 25 },
    { port: 0 },
    { port: 65536 },
    { security: 'none' },
    { username: 'user\r\nAUTH x' },
    { host: 'localhost' },
    { host: '172.16.1.1' },
    { host: 'smtp.example.test:465' },
  ])
    assert.throws(() => validateSmtp(account(change)));
  assert.equal(
    validateSmtp(account({ port: 1587, security: 'tls' })).port,
    1587
  );
});

function fixture({
  security = 'tls',
  auth = ['PLAIN', 'LOGIN'],
  challengePlain = false,
  authFailure = false,
  starttls = true,
} = {}) {
  const commands = [],
    connections = [],
    upgrades = [];
  let authenticated = false,
    loginStep = 0,
    plainStep = false;
  const sockets = [];
  const makeSocket = (secure, greet) => {
    let receive,
      closed = false;
    const send = (text) =>
      receive.enqueue(new TextEncoder().encode(text + '\r\n'));
    const socket = {
      opened: Promise.resolve(),
      closed: Promise.resolve(),
      readable: new ReadableStream({
        start(controller) {
          receive = controller;
          if (greet) send('220 fixture SMTP');
        },
      }),
      writable: new WritableStream({
        write(bytes) {
          const line = new TextDecoder().decode(bytes).replace(/\r\n$/, '');
          commands.push({ line, secure });
          if (line.startsWith('EHLO ')) {
            send('250-fixture');
            if (!secure && starttls) send('250-STARTTLS');
            send(secure ? '250 AUTH ' + auth.join(' ') : '250 SIZE 100000');
          } else if (line === 'STARTTLS') send('220 Ready to start TLS');
          else if (line === 'AUTH LOGIN') {
            assert.ok(secure);
            loginStep = 1;
            send('334 VXNlcm5hbWU6');
          } else if (loginStep === 1) {
            assert.equal(atob(line), 'smtp-api-user');
            loginStep = 2;
            send('334 UGFzc3dvcmQ6');
          } else if (
            loginStep === 2 ||
            plainStep ||
            line.startsWith('AUTH PLAIN ')
          ) {
            assert.ok(secure);
            if (line.startsWith('AUTH PLAIN ') && challengePlain) {
              plainStep = true;
              send('334 ');
              return;
            }
            assert.equal(
              atob(line.startsWith('AUTH PLAIN ') ? line.slice(11) : line),
              loginStep === 2 ? 'fixture-key' : '\0smtp-api-user\0fixture-key'
            );
            loginStep = 0;
            plainStep = false;
            authenticated = !authFailure;
            send(
              authFailure ? '535 Authentication failed' : '235 Authenticated'
            );
          } else if (line.startsWith('MAIL FROM:')) {
            assert.ok(authenticated);
            send('250 OK');
          } else if (line.startsWith('RCPT TO:')) send('250 OK');
          else if (line === 'DATA') send('354 End with dot');
          else if (line.endsWith('\r\n.')) send('250 Message accepted');
          else if (line === 'QUIT') send('221 Bye');
          else throw new Error('Unexpected protocol command');
        },
      }),
      startTls(options) {
        upgrades.push(options);
        return makeSocket(true, false);
      },
      close() {
        if (!closed) {
          closed = true;
          receive.close();
        }
      },
    };
    sockets.push(socket);
    return socket;
  };
  const connect = (address, options) => {
    connections.push({ address, options });
    return makeSocket(options.secureTransport === 'on', true);
  };
  return { connect, commands, connections, upgrades, sockets };
}
const message = {
  to: 'staff@example.test',
  subject: '中文告警测试',
  text: 'A\nB',
  id: 'fixture-id',
};
test('SMTP切换：只验证登录，不发送邮件；验证失败不会冒充成功', async () => {
  const server=fixture();
  assert.deepEqual(await deliverSmtp(account({security:'tls'}),'fixture-key',null,server.connect,{authenticateOnly:true}),{authenticated:true});
  assert.equal(server.commands.some(c=>c.line.startsWith('MAIL FROM:')||c.line==='DATA'),false);
  const denied=fixture({authFailure:true});
  await assert.rejects(deliverSmtp(account({security:'tls'}),'fixture-key',null,denied.connect,{authenticateOnly:true}),/SMTP 登录验证失败/);
});
test('SMTP协议：自定义TLS端口，自动协商PLAIN并发送UTF8正文', async () => {
  const server = fixture();
  assert.equal(
    await deliverSmtp(
      account({ security: 'tls', port: 2465 }),
      'fixture-key',
      message,
      server.connect
    ),
    'fixture-id'
  );
  assert.deepEqual(server.connections[0], {
    address: { hostname: 'smtp.example.test', port: 2465 },
    options: { secureTransport: 'on' },
  });
  assert.ok(server.commands.some((c) => c.line.startsWith('AUTH PLAIN ')));
  assert.ok(
    server.commands.some((c) =>
      c.line.includes('Content-Transfer-Encoding: base64')
    )
  );
});
test('SMTP协议：STARTTLS后重新EHLO，仅在TLS内发送LOGIN凭据', async () => {
  const server = fixture({ security: 'starttls', auth: ['LOGIN'] });
  await deliverSmtp(account(), 'fixture-key', message, server.connect);
  assert.deepEqual(server.upgrades, [
    { expectedServerHostname: 'smtp.example.test' },
  ]);
  assert.equal(
    server.commands.filter((c) => c.line.startsWith('EHLO ')).length,
    2
  );
  assert.ok(
    server.commands
      .filter((c) => !c.secure)
      .every((c) => c.line.startsWith('EHLO ') || c.line === 'STARTTLS')
  );
});
test('SMTP协议：支持PLAIN challenge；认证失败不提交邮件', async () => {
  const challenge = fixture({ challengePlain: true });
  await deliverSmtp(
    account({ security: 'tls', auth: 'plain' }),
    'fixture-key',
    message,
    challenge.connect
  );
  const rejected = fixture({ authFailure: true });
  await assert.rejects(
    deliverSmtp(
      account({ security: 'tls' }),
      'fixture-key',
      message,
      rejected.connect
    ),
    /SMTP 登录验证失败/
  );
  assert.equal(
    rejected.commands.some((c) => c.line.startsWith('MAIL FROM:')),
    false
  );
});
test('SMTP协议：拒绝缺失STARTTLS或不支持的认证，不发送凭据', async () => {
  const server = fixture({ starttls: false });
  await assert.rejects(
    deliverSmtp(account(), 'fixture-key', message, server.connect),
    /未提供 STARTTLS/
  );
  assert.equal(
    server.commands.some((c) => c.line.startsWith('AUTH ')),
    false
  );
  const unsupported = fixture({ auth: ['XOAUTH2'] });
  await assert.rejects(
    deliverSmtp(
      account({ security: 'tls' }),
      'fixture-key',
      message,
      unsupported.connect
    ),
    /不支持所选认证/
  );
  assert.equal(
    unsupported.commands.some((c) => c.line.startsWith('AUTH ')),
    false
  );
});
test('SMTP协议：连接超时会关闭尚未打开的socket', async () => {
  let closed = 0;
  const connector = () => ({
    opened: new Promise(() => {}),
    close() {
      closed++;
    },
  });
  await assert.rejects(
    deliverSmtp(account(), 'fixture-key', message, connector, {
      timeoutMs: 20,
    }),
    /超时/
  );
  assert.ok(closed > 0);
});
test('SMTP MIME：拒绝邮件头注入', () => {
  assert.throws(() =>
    mimeMessage({
      ...message,
      from: 'alerts@example.test',
      subject: 'x\r\nBcc:bad@example.test',
    })
  );
});

test(
  '真实Worker/D1：保存通用SMTP、凭据脱敏与非法配置拒绝',
  { skip: process.env.PG_SMTP_API_TEST !== '1' },
  async () => {
    const base = process.env.PG_TEST_BASE || 'http://127.0.0.1:8787';
    assert.ok(
      /^http:\/\/(127\.0\.0\.1|localhost):/.test(base),
      'Use local test worker only'
    );
    const call = async (path, method = 'GET', input, token) => {
      const res = await fetch(base + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },
        body: input ? JSON.stringify(input) : undefined,
      });
      return { status: res.status, body: await res.json() };
    };
    const logged = await call('/api/auth/login', 'POST', {
      email: process.env.PG_TEST_EMAIL,
      password: process.env.PG_TEST_PASSWORD,
      client_type: 'cli',
    });
    assert.equal(logged.status, 200);
    const token = logged.body.api_token;
    const before = (await call('/api/settings', 'GET', undefined, token)).body
      .mail;
    assert.equal(
      before.password_set,
      false,
      'Test worker must have no real SMTP credential'
    );
    try {
      const result = await call(
        '/api/settings',
        'PUT',
        {
          mail: account({
            password: 'api-fixture-secret',
            security: 'tls',
            port: 2465,
          }),
        },
        token
      );
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.mail.port, 2465);
      assert.equal(result.body.mail.username, 'smtp-api-user');
      assert.equal(result.body.mail.password_set, true);
      assert.equal(result.body.mail.password_cipher, undefined);
      assert.equal(result.body.mail.password, undefined);
      const invalid = await call(
        '/api/settings',
        'PUT',
        { mail: { port: 25 } },
        token
      );
      assert.equal(invalid.status, 400);
      assert.equal(
        (await call('/api/settings', 'GET', undefined, token)).body.mail.port,
        2465
      );
    } finally {
      assert.equal(
        (await call('/api/settings', 'PUT', { mail: before }, token)).status,
        200
      );
    }
  }
);
