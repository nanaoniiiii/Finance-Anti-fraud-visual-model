import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { choosePendingAlert, popupKey, postponePendingAlerts } from '../src/popup-state.js';
test('稍后处理只暂时收起弹窗，升级提醒可重新出现，处置表单打开时不叠加弹窗', () => {
  const first = { id: 'event-a', event_id: 'event-a', severity: 2 },
    second = { id: 'event-a', event_id: 'event-a', severity: 3 };
  const snooze = { [popupKey(first)]: 5000 };
  assert.equal(choosePendingAlert(null, [first], snooze, null, 1000), null);
  assert.equal(choosePendingAlert(null, [second], snooze, null, 1000), second);
  assert.equal(
    choosePendingAlert(null, [first], {}, 'other-event', 1000),
    null,
  );
  assert.equal(choosePendingAlert(first, [], {}, null, 1000), null);
  assert.equal(choosePendingAlert(null, [first], {}, null, 1000), first);
  const queued={id:'event-b',event_id:'event-b',severity:2};
  const deferred=postponePendingAlerts(first,[first,queued],{},1000);
  assert.equal(choosePendingAlert(null,[first,queued],deferred,null,1001),null);
  assert.equal(choosePendingAlert(null,[second],deferred,null,1001),second);
  const newAssigned={id:'message-new',event_id:'event-a',personal:true,severity:3};
  assert.equal(choosePendingAlert(null,[newAssigned],deferred,null,1001),newAssigned);
});
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
test(
  '真实Worker：检测结束保持待处理、新客户端恢复、指定提醒优先、人工提交才关闭及新旧安卓清理协议',
  { skip: !process.env.PG_MESSAGE_QA_FILE },
  async () => {
    assert.match(base, /^http:\/\/(127\.0\.0\.1|localhost):/);
    const fixture = JSON.parse(
      await fs.readFile(process.env.PG_MESSAGE_QA_FILE, 'utf8'),
    );
    assert.equal(fixture.base, base);
    const owner = fixture.owner_token,
      [a, , c] = fixture.members,
      original = (await call('/settings', owner)).data;
    assert.equal(original.mail.enabled, false);
    const enrollment = await call('/enrollments', owner, 'POST', {
      name: '弹窗生命周期本地回归',
      platform: 'windows',
      is_test: true,
    });
    const device = (
      await call('/enroll', '', 'POST', {
        code: enrollment.data.code,
        platform: 'windows',
      })
    ).data;
    const receivers = [];
    try {
      const policy = structuredClone(original.notification_policy);
      for (const level of [1, 2, 3])
        policy['phone_to_ear:' + level] = { mode: 'all', member_ids: [] };
      await call('/settings', owner, 'PUT', { notification_policy: policy });
      for (let i = 0; i < 2; i++) {
        const receiver = await call('/native-receivers', owner, 'POST', {
          installation_id: crypto.randomUUID(),
          label: i ? '旧版接收兼容回归' : '新版接收清理回归',
          device_ids: [],
        });
        assert.equal(receiver.status, 201);
        receivers.push(receiver.data);
      }
      await call(
        '/mobile/changes?supports_clear=1&bootstrap=1',
        receivers[0].receiver_token,
      );
      const clientId = crypto.randomUUID(),
        common = {
          event_id: clientId,
          risk_kind: 'phone_to_ear',
          model_state: 'alert',
          observed_frames: original.rules.frame_threshold + 1,
          notify_test: true,
          occurred_at: new Date().toISOString(),
        };
      const created = await call(
        '/device/events',
        device.device_token,
        'POST',
        { ...common, revision: 1, update_type: 'created' },
      );
      assert.equal(created.status, 201, JSON.stringify(created.data));
      const id = created.data.incident_id;
      assert.ok(
        (await call('/pending-alerts', owner)).data.alerts.some(
          (alert) => alert.event_id === id,
        ),
      );
      const ended = await call('/device/events', device.device_token, 'POST', {
        ...common,
        revision: 2,
        update_type: 'resolved',
      });
      assert.equal(ended.status, 200, JSON.stringify(ended.data));
      const pending = (await call('/events/' + id, c.token)).data.event;
      assert.notEqual(pending.status, 'resolved');
      assert.equal(pending.resolved_at, null);
      assert.ok(pending.signal_ended_at);
      assert.ok(
        (await call('/pending-alerts', c.token)).data.alerts.some(
          (alert) => alert.event_id === id && alert.signal_ended_at,
        ),
      );
      policy['phone_to_ear:2'] = { mode: 'off', member_ids: [] };
      await call('/settings', owner, 'PUT', { notification_policy: policy });
      const assigned = await call(
        '/events/' + id + '/assign-intervention',
        owner,
        'POST',
        {
          recipient_ids: [a.id],
          request_id: crypto.randomUUID(),
          notify_test: true,
        },
      );
      assert.equal(assigned.status, 201);
      assert.ok(
        (await call('/pending-alerts', a.token)).data.alerts.some(
          (alert) => alert.event_id === id && alert.personal,
        ),
      );
      assert.equal(
        (await call('/pending-alerts', c.token)).data.alerts.some(
          (alert) => alert.event_id === id,
        ),
        false,
        'Manual urgency does not widen an earlier automatic warning',
      );
      const escalation = await call(
        '/device/events',
        device.device_token,
        'POST',
        {
          ...common,
          revision: 3,
          update_type: 'escalated',
          confirmed_seen: true,
          observed_frames: original.rules.escalation_threshold + 1,
        },
      );
      assert.equal(escalation.status, 200);
      assert.ok(
        (await call('/pending-alerts', c.token)).data.alerts.some(
          (alert) => alert.event_id === id,
        ),
        'A real model escalation uses emergency popup policy',
      );
      await call('/device/events', device.device_token, 'POST', {
        ...common,
        revision: 4,
        update_type: 'resolved',
        confirmed_seen: true,
        observed_frames: original.rules.escalation_threshold + 1,
      });
      assert.notEqual(
        (await call('/events/' + id, owner)).data.event.status,
        'resolved',
      );
      assert.equal(
        (
          await call('/events/' + id + '/resolve', a.token, 'POST', {
            note: 'bypass',
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await call(
            '/personal-messages/' + assigned.data.messages[0].id + '/complete',
            a.token,
            'POST',
            { note: 'bypass' },
          )
        ).status,
        400,
      );
      const handled = await call(
        '/events/' + id + '/disposition',
        owner,
        'POST',
        {
          outcome: 'false_positive',
          note: '本地联调：核实为测试事件',
          request_id: crypto.randomUUID(),
        },
      );
      assert.equal(handled.status, 201, JSON.stringify(handled.data));
      for (const token of [owner, a.token, c.token])
        assert.equal(
          (await call('/pending-alerts', token)).data.alerts.some(
            (alert) => alert.event_id === id,
          ),
          false,
        );
      const personal = (
        await call(
          '/personal-messages/' + assigned.data.messages[0].id,
          a.token,
        )
      ).data.message;
      assert.ok(personal.completed_at);
      assert.equal(personal.read_at, null);
      assert.match(personal.completion_note, /管理员/);
      const modern = (
        await call(
          '/mobile/changes?supports_clear=1&after=' + receivers[0].cursor,
          receivers[0].receiver_token,
        )
      ).data.changes;
      const legacy = (
        await call(
          '/mobile/changes?after=' + receivers[1].cursor,
          receivers[1].receiver_token,
        )
      ).data.changes;
      const cleared = modern.find(
        (change) =>
          change.entity_id === id && change.action === 'record-disposition',
      );
      assert.ok(cleared);
      assert.equal(
        legacy.some(
          (change) =>
            change.entity_id === id && change.action === 'record-disposition',
        ),
        false,
      );
      assert.equal(
        (
          await call('/mobile/ack', receivers[0].receiver_token, 'POST', {
            seq: cleared.seq,
          })
        ).data.status,
        'cleared',
      );
      await call('/device/events', device.device_token, 'POST', {
        ...common,
        revision: 5,
        update_type: 'resolved',
        confirmed_seen: true,
        observed_frames: original.rules.escalation_threshold + 2,
      });
      assert.equal(
        (await call('/events/' + id, owner)).data.event.status,
        'resolved',
      );
    } finally {
      await call('/settings', owner, 'PUT', {
        notification_policy: original.notification_policy,
      });
      for (const receiver of receivers)
        await call('/push-subscriptions/' + receiver.id, owner, 'DELETE', {});
      await call('/devices/' + device.device_id, owner, 'DELETE', {});
    }
  },
);
