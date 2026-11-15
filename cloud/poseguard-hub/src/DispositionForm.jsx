import React, { useEffect, useRef, useState } from 'react';
import { dispositionDefaults } from '../shared/disposition-defaults.js';
const outcomes = [
  ['false_positive', '误检'],
  ['not_intervened', '未介入'],
  ['intervened', '已介入'],
  ['no_risk', '无风险'],
];
export default function DispositionForm({
  api,
  ui,
  eventId,
  user,
  onClose,
  onSaved,
}) {
  const { Modal, Button } = ui;
  const [outcome, setOutcome] = useState(''),
    [note, setNote] = useState(''),
    [challenge, setChallenge] = useState(null),
    [remaining, setRemaining] = useState(user.role === 'owner' ? 0 : 3),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const requestId = useRef(crypto.randomUUID()),
    deadline = useRef(0);
  async function confirm() {
    setChallenge(null);
    setError('');
    try {
      const response = await api(
        '/events/' + eventId + '/disposition-confirmation',
        { method: 'POST', body: '{}' },
      );
      deadline.current =
        Date.now() + Math.max(0, response.not_before - response.server_time);
      setChallenge(response);
      setRemaining(
        Math.ceil(Math.max(0, deadline.current - Date.now()) / 1000),
      );
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => {
    confirm();
    const timer = setInterval(
      () =>
        setRemaining(
          Math.ceil(Math.max(0, deadline.current - Date.now()) / 1000),
        ),
      150,
    );
    return () => clearInterval(timer);
  }, [eventId]);
  return (
    <Modal title="记录事件处置" onClose={() => !busy && onClose()} wide>
      <form
        className="modal-body form-grid disposition-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            const result = await api('/events/' + eventId + '/disposition', {
              method: 'POST',
              body: JSON.stringify({
                outcome,
                note,
                request_id: requestId.current,
                confirmation_id: challenge?.confirmation_id,
              }),
            });
            onSaved(result);
          } catch (e) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset className="disposition-options" disabled={busy}>
          <legend>处置分类</legend>
          {outcomes.map(([value, label]) => (
            <label key={value} className={outcome === value ? 'selected' : ''}>
              <input
                type="radio"
                name="disposition"
                value={value}
                checked={outcome === value}
                onChange={() => {
                  setOutcome(value);
                  setNote(dispositionDefaults[value]);
                  requestId.current = crypto.randomUUID();
                }}
                required
              />
              {label}
            </label>
          ))}
        </fieldset>
        <p className="message-help">
          选择分类会填入默认文案，可直接提交或修改说明。请确认已完成对应核查与风险解除措施；提交后归档本次事件。
        </p>
        <label>
          处置说明（可选）
          <textarea
            rows={4}
            maxLength={2000}
            disabled={busy}
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              requestId.current = crypto.randomUUID();
            }}
            placeholder="补充现场核查、介入情况或判断依据"
          />
          <small>分类、说明、处理人和时间在事件中心对所有成员可见。</small>
        </label>
        {user.role !== 'owner' && (
          <p className="disposition-wait" role="status">
            {!challenge
              ? '正在准备确认…'
              : remaining > 0
                ? `请核对处置分类，${remaining} 秒后可提交。`
                : '已完成 3 秒确认等待，可以提交。'}
          </p>
        )}
        {error && (
          <div className="form-message" role="alert">
            {error}
            <Button onClick={confirm} disabled={busy}>
              重新确认
            </Button>
          </div>
        )}
        <div className="modal-actions">
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            type="submit"
            kind="primary"
            busy={busy}
            disabled={!outcome || !challenge || remaining > 0}
          >
            {remaining > 0 ? `确认后提交（${remaining}）` : '提交处置记录'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
