import test from 'node:test';
import assert from 'node:assert/strict';
const base = process.env.PG_TEST_BASE || 'http://127.0.0.1:8787';
const password = process.env.PG_TEST_PASSWORD;
async function call(route, method = 'GET', input, token) {
  const response = await fetch(base + route, {
    method,
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      'Content-Type': 'application/json',
    },
    body: input ? JSON.stringify(input) : undefined,
  });
  return { status: response.status, data: await response.json() };
}
test(
  '原生手机接收：绑定、权限隔离、测试消息、系统发布回执与解除',
  { skip: !password },
  async () => {
    const login = await call('/api/auth/login', 'POST', {
      email: process.env.PG_TEST_EMAIL,
      password,
      client_type: 'cli',
    });
    assert.equal(login.status, 200);
    const admin = login.data.api_token;
    const receiver = await call(
      '/api/native-receivers',
      'POST',
      {
        installation_id: crypto.randomUUID(),
        label: '原生接收端协议回归',
        device_ids: [],
      },
      admin
    );
    assert.equal(receiver.status, 201);
    const mobile = receiver.data.receiver_token;
    assert.match(mobile, /^pgm_/);
    const updateRoute = '/api/push-subscriptions/' + receiver.data.id;
    assert.equal(
      (await call(updateRoute, 'PUT', { device_ids: ['missing-device'] }, admin)).status,
      400
    );
    assert.equal(
      (await call(updateRoute, 'PUT', { device_ids: [] }, mobile)).status,
      401
    );
    assert.deepEqual(
      (await call(updateRoute, 'PUT', { device_ids: [] }, admin)).data,
      { ok: true, device_ids: [] }
    );
    assert.equal(
      (await call('/api/devices', 'GET', undefined, mobile)).status,
      401
    );
    const initial = await call(
      '/api/mobile/changes?bootstrap=1',
      'GET',
      undefined,
      mobile
    );
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.data.changes, []);
    const sent = await call(
      '/api/native-receivers/' + receiver.data.id + '/test',
      'POST',
      {},
      admin
    );
    assert.equal(sent.status, 202);
    const next = await call(
      '/api/mobile/changes?after=' + initial.data.cursor,
      'GET',
      undefined,
      mobile
    );
    assert.equal(next.status, 200);
    assert.equal(next.data.changes.length, 1);
    assert.equal(next.data.changes[0].data.receiver_id, receiver.data.id);
    const ack = await call(
      '/api/mobile/ack',
      'POST',
      { seq: sent.data.seq },
      mobile
    );
    assert.equal(ack.status, 200);
    assert.equal(ack.data.status, 'posted');
    assert.equal(
      (await call('/api/mobile/ack', 'POST', { seq: sent.data.seq }, mobile))
        .status,
      200
    );
    assert.equal(
      (
        await call(
          '/api/push-subscriptions/' + receiver.data.id,
          'DELETE',
          {},
          admin
        )
      ).status,
      200
    );
    assert.equal(
      (await call('/api/mobile/changes?after=0', 'GET', undefined, mobile))
        .status,
      401
    );
  }
);
