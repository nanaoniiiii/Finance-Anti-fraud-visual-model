import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, GripVertical, Pin, Plus, Send } from 'lucide-react';
import {
  defaultInterventionNote,
  interventionBasics,
} from '../shared/intervention.js';
import './intervention.css';

export default function InterventionAssignment({
  api,
  ui,
  eventId,
  user,
  onClose,
  onSent,
}) {
  const { Modal, Button } = ui;
  const [directory, setDirectory] = useState(null),
    [event, setEvent] = useState(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [keys, setKeys] = useState([]),
    [selected, setSelected] = useState([]),
    [expanded, setExpanded] = useState(false),
    [multiple, setMultiple] = useState(false);
  const [search, setSearch] = useState(''),
    [area, setArea] = useState(''),
    [note, setNote] = useState(''),
    [focused, setFocused] = useState(false),
    [dragging, setDragging] = useState(null);
  const [adding, setAdding] = useState(false),
    [contact, setContact] = useState({ name: '', email: '', phone: '' }),
    [contactBusy, setContactBusy] = useState(false);
  const request = useRef(crypto.randomUUID()),
    orderQueue = useRef(Promise.resolve()),
    field = useRef(null);
  const change = (setter) => (e) => {
    setter(e.target.value);
    request.current = crypto.randomUUID();
  };
  useEffect(() => {
    let active = true;
    Promise.all([
      api('/personal-messages/contacts'),
      api('/events/' + encodeURIComponent(eventId)),
    ])
      .then(([people, detail]) => {
        if (!active) return;
        setDirectory(people);
        setKeys(people.contact_order);
        setSelected(people.preferred_key ? [people.preferred_key] : []);
        setEvent(detail.event);
        setArea(detail.event.location || '');
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [eventId]);
  const contacts = directory
      ? [...directory.contacts, ...directory.external_contacts]
      : [],
    byKey = new Map(contacts.map((contact) => [contact.key, contact]));
  async function reorder(from, to) {
    const next = keys.filter((key) => key !== from);
    next.splice(Math.max(0, next.indexOf(to)), 0, from);
    setKeys(next);
    if (!multiple) setSelected([next[0]]);
    setError('');
    request.current = crypto.randomUUID();
    orderQueue.current = orderQueue.current
      .catch(() => {})
      .then(() =>
        api('/personal-messages/contact-order', {
          method: 'PUT',
          body: JSON.stringify({ keys: next }),
        }),
      );
    try {
      await orderQueue.current;
    } catch (e) {
      setError('顺序尚未保存：' + e.message);
    }
  }
  async function addContact() {
    setContactBusy(true);
    setError('');
    try {
      const added = await api('/personal-messages/contacts', {
        method: 'POST',
        body: JSON.stringify({ ...contact, area }),
      });
      const next = await api('/personal-messages/contacts');
      setDirectory(next);
      setKeys(next.contact_order);
      setSelected(
        multiple ? [...new Set([...selected, added.key])] : [added.key],
      );
      setAdding(false);
      setExpanded(false);
      setContact({ name: '', email: '', phone: '' });
      request.current = crypto.randomUUID();
    } catch (e) {
      setError(e.message);
    } finally {
      setContactBusy(false);
    }
  }
  async function send(e) {
    e.preventDefault();
    if (!selected.length) {
      setError('请选择介入人员');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await api(
        '/events/' + encodeURIComponent(eventId) + '/assign-intervention',
        {
          method: 'POST',
          body: JSON.stringify({
            recipient_ids: selected
              .filter((key) => key.startsWith('user:'))
              .map((key) => key.slice(5)),
            contact_ids: selected
              .filter((key) => key.startsWith('contact:'))
              .map((key) => key.slice(8)),
            area,
            note: note.trim() || defaultInterventionNote(event),
            request_id: request.current,
          }),
        },
      );
      onSent(result);
    } catch (e) {
      setError(e.message);
      if (e.status && e.status < 500) request.current = crypto.randomUUID();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="呼叫指定工作人员介入" onClose={() => !busy && onClose()} wide>
      <form className="modal-body personal-compose" onSubmit={send}>
        <fieldset className="intervention-fields" disabled={busy}>
          <p className="message-intervention-note">
            成员收到介入警告弹窗及个人消息；外部联系人通过邮箱或系统拨号联系，过程记录在个人消息中。
          </p>
          {event && (
            <p className="message-context">
              {event.device_name} · {event.location || '位置未设置'} ·{' '}
              {['候选', '关注', '高风险', '紧急介入'][event.severity]}
            </p>
          )}
          <label>介入人员</label>
          <button
            type="button"
            className="staff-selector"
            aria-expanded={expanded}
            aria-label="选择介入工作人员"
            onClick={() => setExpanded(!expanded)}
          >
            <span>
              {selected.length
                ? selected
                    .map((key) => {
                      const person = byKey.get(key);
                      return person
                        ? `${person.name}${person.email && person.email !== person.name ? ' · ' + person.email : ''}`
                        : key;
                    })
                    .join('、')
                : '请选择工作人员'}
            </span>
            <ChevronDown size={17} />
          </button>
          {expanded && (
            <div className="staff-options">
              <input
                aria-label="搜索介入人员"
                placeholder="搜索姓名、邮箱、电话或区域"
                value={search}
                onChange={change(setSearch)}
              />
              <label className="staff-multiple">
                <input
                  type="checkbox"
                  checked={multiple}
                  onChange={(e) => {
                    setMultiple(e.target.checked);
                    if (!e.target.checked) setSelected(selected.slice(0, 1));
                  }}
                />
                同时通知多名工作人员
              </label>
              <p className="message-help">
                拖动姓名选项排序，第一位作为默认人员；手机可点置顶。
                {user?.role === 'owner'
                  ? '管理员的顺序作为工作区默认。'
                  : '排序保存在本账号。'}
              </p>
              <div className="staff-options-list">
                {keys
                  .filter((key) => {
                    const contact = byKey.get(key);
                    return (
                      contact &&
                      `${contact.name} ${contact.email || ''} ${contact.phone || ''} ${contact.areas.join(' ')}`
                        .toLowerCase()
                        .includes(search.toLowerCase())
                    );
                  })
                  .map((key) => {
                    const person = byKey.get(key);
                    return (
                      <div
                        key={key}
                        className={
                          'staff-option ' +
                          (selected.includes(key) ? 'selected' : '')
                        }
                        draggable
                        onDragStart={() => setDragging(key)}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (dragging && dragging !== key)
                            reorder(dragging, key);
                          setDragging(null);
                        }}
                      >
                        <GripVertical size={15} aria-hidden="true" />
                        <label>
                          <input
                            type={multiple ? 'checkbox' : 'radio'}
                            name="intervention-person"
                            checked={selected.includes(key)}
                            onChange={(e) => {
                              setSelected(
                                multiple
                                  ? e.target.checked
                                    ? [...selected, key]
                                    : selected.filter((value) => value !== key)
                                  : [key],
                              );
                              request.current = crypto.randomUUID();
                              if (!multiple) setExpanded(false);
                            }}
                          />
                          <span>
                            <b>{person.name}</b>
                            <small>
                              {person.email || person.phone || '工作区成员'} ·{' '}
                              {person.areas.join('、') || '区域未设置'}
                              {key === keys[0] ? ' · 默认' : ''}
                            </small>
                          </span>
                        </label>
                        {key !== keys[0] && (
                          <button
                            className="staff-pin"
                            type="button"
                            aria-label={'将' + person.name + '置顶为默认人员'}
                            onClick={() => reorder(key, keys[0])}
                          >
                            <Pin size={13} />
                            置顶
                          </button>
                        )}
                      </div>
                    );
                  })}
              </div>
            </div>
          )}
          <Button icon={Plus} onClick={() => setAdding(!adding)}>
            {adding ? '收起联系人填写' : '手动添加联系方式'}
          </Button>
          {adding && (
            <div className="manual-contact">
              <div className="message-form-pair">
                <label>
                  联系人姓名
                  <input
                    value={contact.name}
                    maxLength={80}
                    onChange={(e) =>
                      setContact({ ...contact, name: e.target.value })
                    }
                  />
                </label>
                <label>
                  联系邮箱
                  <input
                    type="email"
                    value={contact.email}
                    maxLength={254}
                    onChange={(e) =>
                      setContact({ ...contact, email: e.target.value })
                    }
                  />
                </label>
                <label>
                  联系电话
                  <input
                    type="tel"
                    value={contact.phone}
                    maxLength={40}
                    onChange={(e) =>
                      setContact({ ...contact, phone: e.target.value })
                    }
                  />
                </label>
              </div>
              <small>
                邮箱和电话至少填写一项。电话联系人提交后可在消息详情中使用系统拨号。
              </small>
              <Button
                busy={contactBusy}
                disabled={!contact.email && !contact.phone}
                onClick={addContact}
              >
                保存并选择联系人
              </Button>
            </div>
          )}
          <label>
            介入区域
            <input
              list="intervention-areas"
              value={area}
              onChange={change(setArea)}
              maxLength={160}
            />
            <datalist id="intervention-areas">
              {directory?.areas.map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
          </label>
          <label>
            介入说明
            <textarea
              ref={field}
              rows={5}
              value={note}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onChange={change(setNote)}
              maxLength={4000}
              placeholder={
                event && !focused ? defaultInterventionNote(event) : ''
              }
              onKeyDown={(e) => {
                if (
                  e.key === 'Tab' &&
                  !e.shiftKey &&
                  event &&
                  !note.startsWith('设备：')
                ) {
                  e.preventDefault();
                  const next = interventionBasics(event) + note;
                  setNote(next);
                  request.current = crypto.randomUUID();
                  setTimeout(() => {
                    field.current?.setSelectionRange(next.length, next.length);
                  }, 0);
                }
              }}
            />
            <small>
              留空直接发送灰色默认说明。点击后可自填；按 Tab
              填入设备、位置、风险与等级，再补充说明。
            </small>
          </label>
          {error && (
            <p role="alert" className="form-message">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <Button onClick={onClose}>取消</Button>
            <Button
              icon={Send}
              type="submit"
              kind="danger"
              busy={busy}
              disabled={!event || !directory || !selected.length}
            >
              发送介入请求
            </Button>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}
