import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import WebSocket from 'ws';
import {
  changeVisible,
  messageAudience,
  shouldInterruptMessage,
  userTags,
} from '../worker/message-policy.js';

test('个人消息：发送人、收件人与管理员可见，其他成员和旧匿名连接不可见', () => {
  const change = { audience_json: messageAudience('sender', 'staff-a') };
  assert.equal(
    changeVisible(userTags({ id: 'staff-a', role: 'staff' }), change),
    true,
  );
  assert.equal(
    changeVisible(userTags({ id: 'sender', role: 'staff' }), change),
    true,
  );
  assert.equal(
    changeVisible(userTags({ id: 'admin', role: 'owner' }), change),
    true,
  );
  assert.equal(
    changeVisible(userTags({ id: 'staff-b', role: 'staff' }), change),
    false,
  );
  assert.equal(changeVisible([], change), false);
  assert.equal(changeVisible([], { audience_json: 'invalid' }), false);
  assert.equal(changeVisible([], { audience_json: '[]' }), true);
});
test('只有指定介入会打断对应收件人，普通消息、巡查、回执和管理员旁观均不弹窗', () => {
  for (const kind of ['notice', 'inspection', 'intervention']) {
    const change = {
      category: 'message',
      data: { kind, recipient_id: 'a', notify: kind === 'intervention' },
    };
    assert.equal(shouldInterruptMessage('a', change), kind === 'intervention');
    assert.equal(shouldInterruptMessage('b', change), false);
    assert.equal(shouldInterruptMessage('owner', change), false);
  }
  assert.equal(
    shouldInterruptMessage('a', {
      category: 'message',
      data: { kind: 'intervention', recipient_id: 'a', notify: false },
    }),
    false,
  );
});

const base = process.env.PG_TEST_BASE || 'http://127.0.0.1:8787';
async function call(path, token, method = 'GET', input) {
  const response = await fetch(base + '/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  return { status: response.status, data: await response.json() };
}
async function connect(token) {
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/api/socket', {
    headers: { Authorization: 'Bearer ' + token },
  });
  const messages = [];
  ws.on('message', (bytes) => {
    if (String(bytes) !== 'pong') messages.push(JSON.parse(String(bytes)));
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
    if (Date.now() > end) throw new Error('Scoped WebSocket event missing');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
test(
  '真实Worker/D1：个人消息隔离、无警报巡查、指定介入弹窗、双通道权限与回执',
  { skip: !process.env.PG_TEST_PASSWORD },
  async () => {
    assert.match(
      base,
      /^http:\/\/(127\.0\.0\.1|localhost):/,
      'Use local worker only',
    );
    const login = await call('/auth/login', null, 'POST', {
      email: process.env.PG_TEST_EMAIL,
      password: process.env.PG_TEST_PASSWORD,
      client_type: 'cli',
    });
    assert.equal(login.status, 200);
    const owner = login.data.api_token,
      members = [];
    for (const [index, area] of ['东区', '西区', '北区'].entries()) {
      const address = `messages-${index}-${crypto.randomUUID()}@example.test`,
        password = 'Local-message-test-' + crypto.randomUUID();
      const invite = await call('/users/invite', owner, 'POST', {
        email: address,
        name: `消息测试${index + 1}（${area}）`,
      });
      assert.equal(invite.status, 201);
      const token = new URL(invite.data.url).hash.split('invite=')[1];
      assert.equal(
        (await call('/auth/join', null, 'POST', { token, password })).status,
        201,
      );
      const logged = await call('/auth/login', null, 'POST', {
        email: address,
        password,
        client_type: 'cli',
      });
      assert.equal(logged.status, 200);
      members.push({
        ...logged.data.user,
        token: logged.data.api_token,
        password,
      });
      assert.equal(
        (
          await call('/users/' + logged.data.user.id + '/areas', owner, 'PUT', {
            areas: [area],
          })
        ).status,
        200,
      );
    }
    const [a, b, c] = members;
    assert.equal(
      (
        await call('/users/' + b.id + '/areas', a.token, 'PUT', {
          areas: ['other'],
        })
      ).status,
      403,
    );
    const directory = await call('/personal-messages/contacts', a.token);
    assert.ok(
      directory.data.contacts.some(
        (item) => item.id === b.id && item.areas.includes('西区'),
      ),
    );
    assert.equal(
      directory.data.contacts.some(
        (item) => 'password_hash' in item || 'token_hash' in item,
      ),
      false,
    );
    const cursor = (await call('/changes?bootstrap=1', c.token)).data.cursor;
    const sockets = await Promise.all([
      connect(owner),
      connect(a.token),
      connect(c.token),
    ]);
    const deviceTokens = [],
      receivers = [];
    let eventId, intervention;
    try {
      const input = {
        kind: 'notice',
        title: '个人消息权限回归',
        body: 'PRIVATE_MESSAGE_' + crypto.randomUUID(),
        recipient_ids: [a.id, b.id],
        request_id: crypto.randomUUID(),
      };
      const sent = await call('/personal-messages', owner, 'POST', input);
      assert.equal(sent.status, 201, JSON.stringify(sent.data));
      assert.equal(sent.data.messages.length, 2);
      const messageA = sent.data.messages.find(
          (item) => item.recipient_id === a.id,
        ),
        messageB = sent.data.messages.find(
          (item) => item.recipient_id === b.id,
        );
      await until(() =>
        sockets[1].messages.some((change) => change.entity_id === messageA.id),
      );
      assert.equal(
        sockets[1].messages.some((change) => change.entity_id === messageB.id),
        false,
      );
      assert.equal(
        (await call('/personal-messages?scope=all', c.token)).status,
        403,
      );
      assert.equal(
        (await call('/personal-messages/' + messageA.id, c.token)).status,
        404,
      );
      assert.equal(
        (
          await call(
            '/personal-messages/' + messageA.id + '/read',
            owner,
            'POST',
            {},
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await call(
            '/personal-messages/' + messageA.id + '/read',
            a.token,
            'POST',
            {},
          )
        ).status,
        200,
      );
      assert.equal(
        (await call('/personal-messages/' + messageB.id, b.token)).data.message
          .read_at,
        null,
      );
      assert.equal(
        (await call('/personal-messages/summary', a.token)).data.unread,
        0,
      );
      assert.equal(
        (await call('/personal-messages', c.token)).data.messages.length,
        0,
      );
      const changesC = await call('/changes?after=' + cursor, c.token);
      assert.equal(JSON.stringify(changesC.data).includes(input.body), false);
      const duplicate = await Promise.all([
        call('/personal-messages', owner, 'POST', input),
        call('/personal-messages', owner, 'POST', input),
      ]);
      assert.ok(
        duplicate.every(
          (result) => result.status === 200 && result.data.duplicate,
        ),
      );
      assert.equal(
        (
          await call('/personal-messages', owner, 'POST', {
            ...input,
            body: 'changed',
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await call('/personal-messages', owner, 'POST', {
            ...input,
            request_id: crypto.randomUUID(),
            recipient_ids: ['missing'],
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await call('/personal-messages', owner, 'POST', {
            ...input,
            kind: 'intervention',
            request_id: crypto.randomUUID(),
          })
        ).status,
        400,
      );
      const patrol = await call('/personal-messages', b.token, 'POST', {
        kind: 'inspection',
        title: '无报警时检查东区',
        body: '请检查现场并反馈。',
        area: '东区',
        recipient_ids: [a.id],
        request_id: crypto.randomUUID(),
      });
      assert.equal(patrol.status, 201, JSON.stringify(patrol.data));
      assert.equal(patrol.data.messages[0].event_id, null);
      const patrolId = patrol.data.messages[0].id;
      await until(() =>
        sockets[1].messages.some((change) => change.entity_id === patrolId),
      );
      assert.equal(
        sockets[1].messages.find((change) => change.entity_id === patrolId).data
          .notify,
        false,
      );
      assert.equal(
        (
          await call(
            '/personal-messages/' + patrolId + '/ack',
            a.token,
            'POST',
            {},
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await call(
            '/personal-messages/' + patrolId + '/complete',
            c.token,
            'POST',
            { note: 'not allowed' },
          )
        ).status,
        404,
      );
      const complete = await call(
        '/personal-messages/' + patrolId + '/complete',
        a.token,
        'POST',
        { note: '现场检查完成，设备状态正常。' },
      );
      assert.equal(complete.status, 200);
      assert.ok(complete.data.message.completed_at);
      assert.equal(
        (await call('/personal-messages/' + patrolId, b.token)).data.message
          .completion_note,
        '现场检查完成，设备状态正常。',
      );
      assert.equal(
        (
          await call('/personal-messages?scope=sent', b.token)
        ).data.messages.some((message) => message.id === patrolId),
        true,
      );
      for (let i = 0; i < 2; i++) {
        const enrollment = await call('/enrollments', owner, 'POST', {
          name: '个人消息隔离回归设备' + i,
          platform: 'windows',
          is_test: true,
        });
        assert.equal(enrollment.status, 201, JSON.stringify(enrollment.data));
        const claim = await call('/enroll', null, 'POST', {
          code: enrollment.data.code,
          platform: 'windows',
        });
        assert.equal(claim.status, 201, JSON.stringify(claim.data));
        deviceTokens.push(claim.data);
      }
      for (const member of [a, c]) {
        const receiver = await call('/native-receivers', member.token, 'POST', {
          installation_id: crypto.randomUUID(),
          label: '个人消息目标隔离测试',
          device_ids: [deviceTokens[1].device_id],
        });
        assert.equal(receiver.status, 201);
        receivers.push({ ...receiver.data, member });
      }
      const event = await call(
        '/device/events',
        deviceTokens[0].device_token,
        'POST',
        {
          event_id: crypto.randomUUID(),
          update_type: 'created',
          risk_kind: 'phone_to_ear',
          model_state: 'alert',
          observed_frames: 1001,
          revision: 1,
          occurred_at: new Date().toISOString(),
        },
      );
      assert.equal(event.status, 201, JSON.stringify(event.data));
      eventId = event.data.incident_id;
      const assignment = {
        recipient_ids: [a.id],
        area: '东区',
        note: 'PRIVATE_INTERVENTION_' + crypto.randomUUID(),
        request_id: crypto.randomUUID(),
        notify_test: true,
      };
      const assigned = await call(
        '/events/' + eventId + '/assign-intervention',
        owner,
        'POST',
        assignment,
      );
      assert.equal(assigned.status, 201, JSON.stringify(assigned.data));
      intervention = assigned.data.messages[0];
      assert.equal(intervention.delivery_status,'blocked');
      const privateEmailJobs=(await call('/events/'+eventId,owner)).data.notifications.filter(job=>job.channel==='email'&&job.target===a.email);
      assert.equal(privateEmailJobs.length,1);
      assert.equal((await call('/events/'+eventId,c.token)).data.notifications.some(job=>job.target===a.email),false);
      await until(() =>
        sockets[1].messages.some(
          (change) => change.entity_id === intervention.id,
        ),
      );
      const personalChange = sockets[1].messages.find(
        (change) => change.entity_id === intervention.id,
      );
      assert.equal(shouldInterruptMessage(a.id, personalChange), true);
      assert.equal(shouldInterruptMessage('owner', personalChange), false);
      const mobileA = await call(
        '/mobile/changes?after=' + receivers[0].cursor,
        receivers[0].receiver_token,
      );
      const mobileC = await call(
        '/mobile/changes?after=' + receivers[1].cursor,
        receivers[1].receiver_token,
      );
      assert.equal(
        mobileA.data.changes.filter((change) => change.category === 'message')
          .length,
        1,
      );
      assert.equal(
        mobileC.data.changes.filter((change) => change.category === 'message')
          .length,
        0,
      );
      assert.equal(
        (
          await call('/mobile/ack', receivers[1].receiver_token, 'POST', {
            seq: personalChange.seq,
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await call('/mobile/ack', receivers[0].receiver_token, 'POST', {
            seq: personalChange.seq,
          })
        ).status,
        200,
      );
      const detail = await call('/events/' + eventId, owner);
      assert.equal(detail.data.event.status, 'intervention_requested');
      assert.equal(detail.data.event.severity, 3);
      const timelineForC = await call('/events/' + eventId, c.token);
      assert.equal(
        JSON.stringify(timelineForC.data.updates).includes(assignment.note),
        false,
      );
      const duplicateAssign = await call(
        '/events/' + eventId + '/assign-intervention',
        owner,
        'POST',
        assignment,
      );
      assert.equal(duplicateAssign.data.duplicate, true);
      assert.equal(duplicateAssign.data.messages[0].id, intervention.id);
      assert.equal(
        (
          await call('/devices/' + deviceTokens[1].device_id, owner, 'PATCH', {
            location: '公开状态同步屏障',
          })
        ).status,
        200,
      );
      await until(() =>
        sockets[2].messages.some(
          (change) =>
            change.entity_id === deviceTokens[1].device_id &&
            change.action === 'updated',
        ),
      );
      assert.equal(
        sockets[2].messages.some((change) => change.category === 'message'),
        false,
      );
      const all = await call('/personal-messages?scope=all', owner);
      assert.ok(
        all.data.messages.some(
          (message) =>
            message.id === intervention.id &&
            message.sender_name === login.data.user.name &&
            message.recipient_name === a.name,
        ),
      );
      if (process.env.PG_MESSAGE_QA_FILE)
        await fs.writeFile(
          process.env.PG_MESSAGE_QA_FILE,
          JSON.stringify(
            {
              base,
              members,
              owner_token: owner,
              ownerEmail: process.env.PG_TEST_EMAIL,
              patrolId,
              eventId,
              interventionId: intervention.id,
            },
            null,
            2,
          ),
        );
    } finally {
      for (const socket of sockets) socket.ws.terminate();
      for (const receiver of receivers)
        await call('/push-subscriptions/' + receiver.id, owner, 'DELETE', {});
      for (const device of deviceTokens)
        await call('/devices/' + device.device_id, owner, 'DELETE', {});
    }
  },
);
