import React, { useEffect, useState } from 'react';
import useSettingsDraft from './useSettingsDraft.js';
import './intervention.css';
const risks = [
  ['phone_to_ear', '疑似通话姿态'],
  ['multi_person', '多人进入'],
  ['lingering', '长时间停留'],
];
const modes = [
  ['all', '全体成员'],
  ['admins', '仅管理员'],
  ['selected', '指定成员'],
  ['off', '关闭提醒'],
];
export default function NotificationPolicy({
  api,
  ui,
  settings,
  user,
  notify,
  reload,
}) {
  const { PanelHeader, Button } = ui;
  const [draft, setDraft, saved, dirty] = useSettingsDraft(
    settings?.notification_policy || {},
    ),
    [contacts, setContacts] = useState([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const owner = user.role === 'owner';
  useEffect(() => {
    let active = true;
    api('/personal-messages/contacts')
      .then((value) => active && setContacts(value.contacts))
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, []);
  function row(key, label) {
    const rule = draft[key] || { mode: 'all', member_ids: [] };
    const update = (next) => setDraft((value) => ({ ...value, [key]: next }));
    return (
      <div className="notification-policy-row" key={key}>
        <b>{label}</b>
        <div>
          <select
            aria-label={(risks.find(([risk])=>key.startsWith(risk+':'))?.[1]||'设备状态')+' · '+label+'弹窗范围'}
            disabled={!owner || busy}
            value={rule.mode}
            onChange={(e) => update({ ...rule, mode: e.target.value })}
          >
            {modes.map(([value, title]) => (
              <option value={value} key={value}>
                {title}
              </option>
            ))}
          </select>
          {rule.mode === 'selected' && (
            <fieldset disabled={!owner || busy}>
              <legend>选择可收到提醒的成员（可勾选管理员）</legend>
              {contacts.map((contact) => (
                <label key={contact.id}>
                  <input
                    type="checkbox"
                    checked={rule.member_ids.includes(contact.id)}
                    onChange={(e) =>
                      update({
                        ...rule,
                        member_ids: e.target.checked
                          ? [...rule.member_ids, contact.id]
                          : rule.member_ids.filter((id) => id !== contact.id),
                      })
                    }
                  />
                  {contact.name}
                </label>
              ))}
            </fieldset>
          )}
        </div>
      </div>
    );
  }
  return (
    <section className="panel">
      <PanelHeader
        title="弹窗范围与风险等级"
        subtitle="控制网页、App 弹窗与系统提醒；指定介入人员始终收到对应介入弹窗。"
      />
      <div className="notification-policy-body">
        <p className="message-help">
          所有成员仍可在事件中心查看全部事件，邮件沿用既有收件规则。配置保存后用于新产生的自动提醒；指定成员中可以同时选择管理员与工作人员。
        </p>
        {risks.map(([risk, title]) => (
          <section className="notification-policy-group" key={risk}>
            <h3>{title}</h3>
            {[
              [1, '关注'],
              [2, '高风险'],
              [3, '紧急'],
            ].map(([level, label]) => row(risk + ':' + level, label))}
          </section>
        ))}
        <section className="notification-policy-group">
          <h3>设备状态</h3>
          {[
            ['online', '恢复在线'],
            ['offline', '设备离线'],
            ['fault', '设备异常'],
          ].map(([key, label]) => row('device:' + key, label))}
        </section>
        {error && (
          <p className="form-message" role="alert">
            {error}
          </p>
        )}
        <div className="notification-policy-footer">
          <span>
            {dirty
              ? '有未保存的通知范围修改，自动同步保留当前选择。'
              : '当前通知范围已同步。'}
          </span>
          <div className="inline">
            <Button
              disabled={!owner || busy}
              onClick={() =>
                setDraft((value) => {
                  const next = { ...value };
                  for (const [risk] of risks)
                    for (const level of [1, 2, 3])
                      next[risk + ':' + level] = {
                        ...(next[risk + ':' + level] || { member_ids: [] }),
                        mode:
                          level === 1 ? 'off' : level === 2 ? 'admins' : 'all',
                      };
                  return next;
                })
              }
            >
              应用示例方案
            </Button>
            <Button
              kind="primary"
              disabled={!owner || !dirty}
              busy={busy}
              onClick={async () => {
                setBusy(true);
                setError('');
                const submitted = draft;
                try {
                  const result = await api('/settings', {
                    method: 'PUT',
                    body: JSON.stringify({ notification_policy: draft }),
                  });
                  saved(result.notification_policy, submitted);
                  notify('通知范围已保存');
                  await reload(result);
                } catch (e) {
                  setError(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              保存通知范围
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
