import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsDraft, settingsDraftReducer as reduce, settingsDraftDirty, mailDraft } from '../src/settings-draft.js';

const initial = () => mailDraft({ provider: 'agently', from: 'test@agent.example', host: 'smtp.example.com', username: 'test', recipients: ['staff@example.com'], enabled: true });
const edit = (state, update) => reduce(state, { type: 'edit', update: value => ({ ...value, ...update }) });

test('后台重复刷新保留通道、邮箱、密码、收件人和通知开关的草稿', () => {
  let state = createSettingsDraft(initial());
  state = edit(state, { provider: 'smtp', from: 'sender@example.com', username: 'new-user', password: 'test-only-secret', recipientText: 'new@example.com\n', enabled: false });
  const draft = state.value;
  for (let i = 0; i < 12; i++) state = reduce(state, { type: 'sync', value: initial() });
  assert.deepEqual(state.value, draft);
  assert.equal(settingsDraftDirty(state), true);
});

test('授权状态变化不会进入表单草稿；服务端变更同步到未编辑的字段', () => {
  const mail = { from: 'old@example.com', recipients: [], agently: { expires_at: '2026-11-15' } };
  assert.deepEqual(mailDraft(mail), mailDraft({ ...mail, agently: { expires_at: '2026-11-16', last_error: 'retry' } }));
  let state = edit(createSettingsDraft(initial()), { username: 'typing' });
  state = reduce(state, { type: 'sync', value: { ...initial(), host: 'smtp.new.example.com' } });
  assert.equal(state.value.username, 'typing');
  assert.equal(state.value.host, 'smtp.new.example.com');
});

test('保存成功清理已提交密码并采用服务端标准化收件人', () => {
  let state = edit(createSettingsDraft(initial()), { password: 'test-only-secret', recipientText: '  staff@example.com, second@example.com ' });
  const submitted = state.value;
  const saved = { ...initial(), recipientText: 'staff@example.com\nsecond@example.com' };
  state = reduce(state, { type: 'saved', submitted, value: saved });
  assert.deepEqual(state.value, saved);
  assert.equal(state.value.password, '');
  assert.equal(settingsDraftDirty(state), false);
});

test('保存请求期间继续输入的内容不会被保存响应抹掉', () => {
  let state = edit(createSettingsDraft(initial()), { password: 'first-test-code', username: 'submitted' });
  const submitted = state.value;
  state = edit(state, { password: 'second-test-code', username: 'still-typing' });
  const saved = { ...initial(), username: 'submitted' };
  state = reduce(state, { type: 'saved', submitted, value: saved });
  state = reduce(state, { type: 'sync', value: saved });
  assert.equal(state.value.password, 'second-test-code');
  assert.equal(state.value.username, 'still-typing');
  assert.equal(settingsDraftDirty(state), true);
});

test('保存失败不清空密码；规则和邮箱分别保存草稿', () => {
  const mail = edit(createSettingsDraft(initial()), { password: 'test-only-secret' });
  const rules = edit(createSettingsDraft({ frame_threshold: 300, escalation_threshold: 600 }), { frame_threshold: 450 });
  const savedMail = reduce(mail, { type: 'saved', submitted: mail.value, value: initial() });
  assert.equal(savedMail.value.password, '');
  assert.equal(rules.value.frame_threshold, 450);
  assert.equal(mail.value.password, 'test-only-secret');
});

test('未编辑表单继续同步其他端保存的设置，手动恢复原值后视为干净', () => {
  let state = createSettingsDraft(initial());
  const remote = { ...initial(), host: 'smtp.remote.example.com' };
  state = reduce(state, { type: 'sync', value: remote });
  assert.equal(state.value.host, remote.host);
  assert.equal(settingsDraftDirty(state), false);
  state = edit(state, { host: 'typing' });
  state = edit(state, { host: remote.host });
  assert.equal(settingsDraftDirty(state), false);
});
