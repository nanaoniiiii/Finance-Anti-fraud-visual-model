import test from 'node:test';
import assert from 'node:assert/strict';
import {
  changeForUser,
  notificationAllowed,
  normalizeNotificationPolicy,
} from '../worker/notification-policy.js';
import {
  defaultInterventionNote,
  interventionBasics,
} from '../shared/intervention.js';
import { dispositionDefaults } from '../shared/disposition-defaults.js';
test('弹窗四档同时约束实时消息与原始JSON，事件数据始终可同步', () => {
  const users = [
    { id: 'o', role: 'owner' },
    { id: 'a', role: 'staff' },
    { id: 'b', role: 'staff' },
  ];
  const expected = {
    all: [true, true, true],
    admins: [true, false, false],
    selected: [false, true, false],
    off: [false, false, false],
  };
  for (const [mode, flags] of Object.entries(expected))
    for (let i = 0; i < users.length; i++) {
      const change = {
        category: 'event',
        data: {
          notify: true,
          event_id: 'visible-event',
          notification_scope: { mode, member_ids: ['a'] },
        },
      };
      assert.equal(notificationAllowed(users[i], change), flags[i]);
      const filtered = changeForUser(users[i], change);
      assert.equal(filtered.data.notify, flags[i]);
      assert.equal(JSON.parse(filtered.data_json).notify, flags[i]);
      assert.equal(filtered.data.event_id, 'visible-event');
    }
});
test('指定介入始终只给指定人员弹窗，不受自动告警范围关闭影响', () => {
  const change = {
    category: 'message',
    data: {
      kind: 'intervention',
      notify: true,
      recipient_id: 'a',
      notification_scope: { mode: 'off', member_ids: [] },
    },
  };
  assert.equal(notificationAllowed({ id: 'a', role: 'staff' }, change), true);
  assert.equal(
    notificationAllowed({ id: 'owner', role: 'owner' }, change),
    false,
  );
});
test('通知范围输入校验；默认介入说明、Tab信息与处置文案', () => {
  assert.throws(() =>
    normalizeNotificationPolicy({
      'phone_to_ear:2': { mode: 'selected', member_ids: [] },
    }),
  );
  assert.throws(() =>
    normalizeNotificationPolicy({
      'device:offline': { mode: 'invalid', member_ids: [] },
    }),
  );
  const event = {
    device_name: '本地测试设备',
    location: '东区',
    risk_kind: 'phone_to_ear',
    severity: 2,
    observed_frames: 101,
  };
  assert.match(defaultInterventionNote(event), /疑似手机电诈/);
  assert.match(
    defaultInterventionNote({ ...event, risk_kind: 'multi_person' }),
    /疑似多人进入/,
  );
  assert.match(interventionBasics(event), /设备：本地测试设备\n位置：东区/);
  assert.match(interventionBasics(event), /风险等级：高风险/);
  assert.ok(interventionBasics(event).endsWith('说明：'));
  assert.match(dispositionDefaults.not_intervened, /语音提醒、规劝与风险问询/);
  assert.match(dispositionDefaults.intervened, /确认风险属实/);
  assert.match(dispositionDefaults.no_risk, /用户当前行为无风险/);
});
