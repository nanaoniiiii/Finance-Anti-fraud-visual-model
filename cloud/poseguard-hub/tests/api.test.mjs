import test from 'node:test';
import assert from 'node:assert/strict';
const base = process.env.PG_TEST_BASE || 'http://127.0.0.1:8787';
const credentials = process.env.PG_TEST_PASSWORD;
const call = async (path, method = 'GET', input, token) => {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(input ? { 'Content-Type': 'application/json' } : {}),
    },
    body: input ? JSON.stringify(input) : undefined,
  });
  const data = response.headers.get('Content-Type')?.includes('json')
    ? await response.json()
    : await response.arrayBuffer();
  return { status: response.status, data };
};
test(
  '真实Worker/D1：绑定、101帧边界、幂等、升级、私有截图、介入与撤销',
  { skip: !credentials },
  async () => {
    for (const path of [
      '/api/devices',
      '/api/events',
      '/api/snapshots/unknown',
    ])
      assert.equal((await call(path)).status, 401);
    const login = await call('/api/auth/login', 'POST', {
      email: process.env.PG_TEST_EMAIL || 'operator@example.test',
      password: credentials,
      client_type: 'cli',
    });
    assert.equal(login.status, 200, JSON.stringify(login.data));
    const admin = login.data.api_token;
    assert.ok(admin);
    const fleetRead = await call('/api/devices', 'GET', undefined, admin);
    assert.equal(fleetRead.status, 200, JSON.stringify(fleetRead.data));
    assert.ok(Array.isArray(fleetRead.data.receivers));
    const invitation = await call(
      '/api/enrollments',
      'POST',
      {
        name: '联调 Windows ' + Date.now(),
        platform: 'windows',
        is_test: true,
      },
      admin
    );
    assert.equal(invitation.status, 201, JSON.stringify(invitation.data));
    const enrolled = await call('/api/enroll', 'POST', {
      code: invitation.data.code,
      platform: 'windows',
    });
    assert.equal(enrolled.status, 201, JSON.stringify(enrolled.data));
    const device = enrolled.data.device_token;
    assert.ok(device.startsWith('pgd_'));
    assert.equal(
      (await call('/api/enroll', 'POST', { code: invitation.data.code }))
        .status,
      409
    );
    assert.equal(
      (await call('/api/devices', 'GET', undefined, device)).status,
      401
    );
    assert.equal(
      (
        await call(
          '/api/device/heartbeat',
          'POST',
          { mode: 'testing', fps: 12, people: 1, clock_synced: true },
          device
        )
      ).status,
      200
    );
    const fixture = {
      event_id: crypto.randomUUID(),
      revision: 1,
      risk_kind: 'phone_to_ear',
      model_state: 'candidate',
      confirmed_seen: false,
      observed_frames: 100,
      occurred_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      update_type: 'created',
      summary: '自动化联调，不代表真实风险',
      snapshot: {
        data_base64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6C5sAAAAASUVORK5CYII=',
        captured_at: new Date().toISOString(),
      },
    };
    assert.equal(
      (await call('/api/device/events', 'POST', fixture, device)).status,
      422
    );
    fixture.observed_frames = 101;
    const first = await call('/api/device/events', 'POST', fixture, device);
    assert.equal(first.status, 201, JSON.stringify(first.data));
    const id = first.data.incident_id;
    const duplicates = await Promise.all(
      Array.from({ length: 4 }, () =>
        call('/api/device/events', 'POST', fixture, device)
      )
    );
    assert.ok(duplicates.every((x) => x.status === 200 && x.data.duplicate));
    let detail = await call('/api/events/' + id, 'GET', undefined, admin);
    assert.equal(detail.data.updates.length, 1);
    assert.equal(detail.data.event.severity, 1);
    const image = detail.data.snapshots[0].id;
    assert.equal((await call('/api/snapshots/' + image)).status, 401);
    assert.equal(
      (await call('/api/snapshots/' + image, 'GET', undefined, admin)).status,
      200
    );
    let next = {
      ...fixture,
      revision: 2,
      observed_frames: 301,
      update_type: 'escalated',
    };
    assert.equal(
      (await call('/api/device/events', 'POST', next, device)).status,
      200
    );
    detail = await call('/api/events/' + id, 'GET', undefined, admin);
    assert.equal(detail.data.event.severity, 2);
    next = {
      ...next,
      revision: 3,
      observed_frames: 302,
      model_state: 'alert',
      confirmed_seen: true,
    };
    assert.equal(
      (await call('/api/device/events', 'POST', next, device)).status,
      200
    );
    detail = await call('/api/events/' + id, 'GET', undefined, admin);
    assert.equal(detail.data.event.severity, 3);
    assert.equal(
      (await call('/api/events/' + id + '/ack', 'POST', {}, admin)).status,
      200
    );
    assert.equal(
      (
        await call(
          '/api/events/' + id + '/request-intervention',
          'POST',
          { note: '联调工作人员介入' },
          admin
        )
      ).status,
      200
    );
    const heartbeat = await call(
      '/api/device/heartbeat',
      'POST',
      { mode: 'testing', people: 1 },
      device
    );
    assert.equal(heartbeat.data.pending_commands.length, 1);
    const command = heartbeat.data.pending_commands[0].id;
    assert.equal(
      (
        await call(
          '/api/device/commands/' + command + '/ack',
          'POST',
          {},
          device
        )
      ).status,
      200
    );
    assert.equal(
      (
        await call(
          '/api/events/' + id + '/resolve',
          'POST',
          { note: '自动化联调完成，非真实事件' },
          admin
        )
      ).status,
      200
    );
    assert.equal(
      (
        await call(
          '/api/devices/' + enrolled.data.device_id,
          'DELETE',
          {},
          admin
        )
      ).status,
      200
    );
    assert.equal(
      (await call('/api/device/heartbeat', 'POST', { mode: 'testing' }, device))
        .status,
      401
    );
  }
);
