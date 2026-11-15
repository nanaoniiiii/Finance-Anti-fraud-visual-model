import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import WebSocket from 'ws';
import { dispositionDefaults } from '../shared/disposition-defaults.js';
const base = process.env.PG_TEST_BASE || 'http://127.0.0.1:8787';
async function call(path, token, method = 'GET', input) {
  const response = await fetch(base + '/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
    },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  return { status: response.status, data: await response.json() };
}
async function connect(token) {
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/api/socket', {
      headers: { Authorization: 'Bearer ' + token },
    }),
    messages = [];
  ws.on('message', (value) => {
    if (String(value) !== 'pong') messages.push(JSON.parse(String(value)));
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return { ws, messages };
}
async function until(predicate) {
  const end = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Notification scope update missing');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
test(
  '真实Worker：弹窗四档、全员事件可见、指定介入覆盖、外部联系人、3秒确认与处置信息',
  { skip: !process.env.PG_MESSAGE_QA_FILE },
  async () => {
    assert.match(base, /^http:\/\/(127\.0\.0\.1|localhost):/);
    const fixture = JSON.parse(
      await fs.readFile(process.env.PG_MESSAGE_QA_FILE, 'utf8'),
    );
    assert.equal(fixture.base, base);
    const owner = fixture.owner_token,
      [a, b, c] = fixture.members;
    assert.ok(owner);
    const original = (await call('/settings', owner)).data;
    assert.equal(
      original.mail.enabled,
      false,
      'Only use a local fixture with automatic email disabled',
    );
    const directory = (await call('/personal-messages/contacts', owner)).data;
    const sockets = await Promise.all([
        connect(owner),
        connect(a.token),
        connect(c.token),
      ]),
      receivers = [];
    let device;
    try {
      const enrollment = await call('/enrollments', owner, 'POST', {
        name: '通知范围与处置回归设备',
        platform: 'windows',
        is_test: true,
      });
      const claim = await call('/enroll', '', 'POST', {
        code: enrollment.data.code,
        platform: 'windows',
      });
      assert.equal(claim.status, 201);
      device = claim.data;
      for (const member of [a, c]) {
        const receiver = await call('/native-receivers', member.token, 'POST', {
          installation_id: crypto.randomUUID(),
          label: '通知范围本地回归',
          device_ids: [],
        });
        assert.equal(receiver.status, 201);
        receivers.push(receiver.data);
      }
      const ids = [];
      for (const [mode, expected] of [
        ['all', [true, true, true]],
        ['admins', [true, false, false]],
        ['selected', [false, true, false]],
        ['off', [false, false, false]],
      ]) {
        const policy = structuredClone(original.notification_policy);
        policy['phone_to_ear:2'] = {
          mode,
          member_ids: mode === 'selected' ? [a.id] : [],
        };
        assert.equal(
          (
            await call('/settings', owner, 'PUT', {
              notification_policy: policy,
            })
          ).status,
          200,
        );
        const result = await call(
          '/device/events',
          device.device_token,
          'POST',
          {
            event_id: crypto.randomUUID(),
            update_type: 'created',
            risk_kind: 'phone_to_ear',
            model_state: 'alert',
            observed_frames: original.rules.frame_threshold + 1,
            revision: 1,
            notify_test: true,
            occurred_at: new Date().toISOString(),
          },
        );
        assert.equal(result.status, 201, JSON.stringify(result.data));
        const id = result.data.incident_id;
        ids.push(id);
        await until(() =>
          sockets.every((socket) =>
            socket.messages.some((change) => change.entity_id === id),
          ),
        );
        assert.deepEqual(
          sockets.map(
            (socket) =>
              socket.messages.find((change) => change.entity_id === id).data
                .notify,
          ),
          expected,
        );
      }
      assert.equal(
        (await call('/events', c.token)).data.events.filter((event) =>
          ids.includes(event.id),
        ).length,
        4,
      );
      assert.ok(
        (await call('/events/' + ids[3], c.token)).data.notifications.some(
          (job) => job.channel === 'email',
        ),
        'Popup off does not disable configured email records',
      );
      const mobileA = (
        await call(
          '/mobile/changes?after=' + receivers[0].cursor,
          receivers[0].receiver_token,
        )
      ).data.changes.filter((change) => ids.includes(change.entity_id));
      const mobileC = (
        await call(
          '/mobile/changes?after=' + receivers[1].cursor,
          receivers[1].receiver_token,
        )
      ).data.changes.filter((change) => ids.includes(change.entity_id));
      assert.deepEqual(
        mobileA.map((change) => change.entity_id),
        [ids[0], ids[2]],
      );
      assert.deepEqual(
        mobileC.map((change) => change.entity_id),
        [ids[0]],
      );
      const eventId = ids[3],
        assigned = await call(
          '/events/' + eventId + '/assign-intervention',
          owner,
          'POST',
          {
            recipient_ids: [a.id],
            request_id: crypto.randomUUID(),
            notify_test: true,
          },
        );
      assert.equal(assigned.status, 201, JSON.stringify(assigned.data));
      assert.match(assigned.data.messages[0].body, /疑似手机电诈/);
      await until(() =>
        sockets[1].messages.some(
          (change) => change.entity_id === assigned.data.messages[0].id,
        ),
      );
      assert.equal(
        sockets[1].messages.find(
          (change) => change.entity_id === assigned.data.messages[0].id,
        ).data.notify,
        true,
      );
      const phone = await call('/personal-messages/contacts', owner, 'POST', {
        name: '本地测试电话（勿拨号）',
        phone: '00000000000',
        area: '东区',
      });
      assert.ok([200, 201].includes(phone.status));
      const phoneAssignment = await call(
        '/events/' + eventId + '/assign-intervention',
        owner,
        'POST',
        {
          recipient_ids: [],
          contact_ids: [phone.data.key.slice(8)],
          request_id: crypto.randomUUID(),
        },
      );
      assert.equal(
        phoneAssignment.status,
        201,
        JSON.stringify(phoneAssignment.data),
      );
      assert.equal(
        phoneAssignment.data.messages[0].delivery_status,
        'manual_call_required',
      );
      assert.equal(
        (
          await call(
            '/personal-messages/' + phoneAssignment.data.messages[0].id,
            c.token,
          )
        ).status,
        404,
      );
      const emailContact = await call(
        '/personal-messages/contacts',
        owner,
        'POST',
        { name: '本地测试邮箱', email: 'external-contact@example.test' },
      );
      assert.ok([200, 201].includes(emailContact.status));
      const emailAssignment = await call(
        '/events/' + eventId + '/assign-intervention',
        owner,
        'POST',
        {
          recipient_ids: [],
          contact_ids: [emailContact.data.key.slice(8)],
          request_id: crypto.randomUUID(),
        },
      );
      assert.equal(emailAssignment.status, 409);
      assert.match(emailAssignment.data.error, /发信通道/);
      const reordered = [
        'user:' + b.id,
        ...directory.contact_order.filter((key) => key !== 'user:' + b.id),
      ];
      assert.equal(
        (
          await call('/personal-messages/contact-order', owner, 'PUT', {
            keys: reordered,
          })
        ).status,
        200,
      );
      assert.equal(
        (await call('/personal-messages/contacts', owner)).data.preferred_key,
        'user:' + b.id,
      );
      const ownOrder = [
        phone.data.key,
        ...reordered.filter((key) => key !== phone.data.key),
      ];
      assert.equal(
        (
          await call('/personal-messages/contact-order', a.token, 'PUT', {
            keys: ownOrder,
          })
        ).status,
        200,
      );
      assert.equal(
        (await call('/personal-messages/contacts', owner)).data.preferred_key,
        'user:' + b.id,
      );
      const adminRecord = await call(
        '/events/' + eventId + '/disposition',
        owner,
        'POST',
        { outcome: 'intervened', request_id: crypto.randomUUID() },
      );
      assert.equal(adminRecord.status, 201, JSON.stringify(adminRecord.data));
      assert.equal(
        adminRecord.data.record.note,
        dispositionDefaults.intervened,
      );
      const challenge = await call(
        '/events/' + eventId + '/disposition-confirmation',
        a.token,
        'POST',
        {},
      );
      assert.equal(challenge.status, 200);
      assert.ok(challenge.data.not_before - challenge.data.server_time >= 3000);
      const input = {
        outcome: 'no_risk',
        request_id: crypto.randomUUID(),
        confirmation_id: challenge.data.confirmation_id,
      };
      assert.equal(
        (
          await call(
            '/events/' + eventId + '/disposition',
            a.token,
            'POST',
            input,
          )
        ).status,
        425,
      );
      assert.notEqual(
        (
          await call(
            '/events/' + eventId + '/disposition',
            b.token,
            'POST',
            input,
          )
        ).status,
        201,
      );
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.max(0, challenge.data.not_before - Date.now()) + 40,
        ),
      );
      const completed = await call(
        '/events/' + eventId + '/disposition',
        a.token,
        'POST',
        input,
      );
      assert.equal(completed.status, 201, JSON.stringify(completed.data));
      assert.equal(completed.data.record.note, dispositionDefaults.no_risk);
      assert.equal(
        (
          await call(
            '/events/' + eventId + '/disposition',
            a.token,
            'POST',
            input,
          )
        ).data.duplicate,
        true,
      );
      const handled = (await call('/events/' + eventId, c.token)).data.event;
      assert.equal(handled.handled_by_name, a.name);
      assert.ok(handled.handled_at);
      assert.equal(handled.status, 'resolved');
      assert.ok(
        (
          await call(
            '/personal-messages/' + assigned.data.messages[0].id,
            a.token,
          )
        ).data.message.completed_at,
      );
    } finally {
      for (const socket of sockets) socket.ws.terminate();
      await call('/settings', owner, 'PUT', {
        notification_policy: original.notification_policy,
      });
      await call('/personal-messages/contact-order', owner, 'PUT', {
        keys: directory.contact_order,
      });
      for (const receiver of receivers)
        await call('/push-subscriptions/' + receiver.id, owner, 'DELETE', {});
      if (device)
        await call('/devices/' + device.device_id, owner, 'DELETE', {});
    }
  },
);
