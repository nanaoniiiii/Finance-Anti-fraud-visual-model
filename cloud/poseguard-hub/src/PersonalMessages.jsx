import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  CheckCheck,
  ClipboardCheck,
  Inbox,
  MapPin,
  MessageSquare,
  Plus,
  Search,
  Send,
} from 'lucide-react';
import './personal-messages.css';
import Assignment from './InterventionAssignment.jsx';

const labels = {
  notice: '普通消息',
  inspection: '巡查要求',
  intervention: '指定介入',
};
const time = (value) =>
  value
    ? new Date(value).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
      })
    : '—';
const deliveryLabels = {
  pending: '邮件待发送',
  sending: '邮件发送中',
  accepted: '服务已接受',
  failed: '发送失败',
  blocked: '待授权',
  suppressed: '测试记录·未外发',
  manual_call_required: '待拨号联系',
};
const stateLabel = (message) =>
  message.is_external
    ? deliveryLabels[message.delivery_status] || '联系记录'
    : message.completed_at
      ? '已完成'
      : message.acknowledged_at
        ? '已接单'
        : message.read_at
          ? '已读'
          : '未读';

function Recipients({ contacts, value, onChange }) {
  const [search, setSearch] = useState('');
  const visible = contacts.filter((contact) =>
    `${contact.name} ${contact.email || ''} ${(contact.areas || []).join(' ')}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <fieldset className="message-recipients">
      <legend>
        指定收件人 <small>已选 {value.length} 人</small>
      </legend>
      <label className="message-search">
        <Search size={16} />
        <input
          aria-label="搜索收件人姓名或负责区域"
          placeholder="搜索姓名或负责区域"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      {value.length > 0 && (
        <p className="message-selected">
          收件人：
          {contacts
            .filter((contact) => value.includes(contact.id))
            .map((contact) => contact.name)
            .join('、')}
        </p>
      )}
      <div className="message-recipient-list">
        {visible.map((contact) => (
          <label key={contact.id}>
            <input
              type="checkbox"
              checked={value.includes(contact.id)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...value, contact.id]
                    : value.filter((id) => id !== contact.id),
                )
              }
            />
            <span>
              <b>{contact.name}</b>
              <small>
                {contact.email} ·{' '}
                {contact.areas?.length
                  ? contact.areas.join('、')
                  : '负责区域未设置'}{' '}
                · {contact.role === 'owner' ? '管理员' : '工作人员'}
              </small>
            </span>
          </label>
        ))}
        {!visible.length && (
          <p className="message-help">没有匹配的成员，请调整搜索条件。</p>
        )}
      </div>
    </fieldset>
  );
}

function MessageForm({
  api,
  ui,
  onClose,
  onSent,
  devices = [],
  eventId,
  replyTo,
}) {
  const { Button, Modal } = ui;
  const [contacts, setContacts] = useState([]),
    [areas, setAreas] = useState([]);
  const [event, setEvent] = useState(null),
    [loading, setLoading] = useState(true);
  const [kind, setKind] = useState('notice'),
    [area, setArea] = useState(''),
    [deviceId, setDeviceId] = useState('');
  const [recipientIds, setRecipientIds] = useState(
    replyTo ? [replyTo.sender_id] : [],
  );
  const [title, setTitle] = useState(
    replyTo ? ('回复：' + replyTo.title).slice(0, 120) : '',
  );
  const [content, setContent] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    let active = true;
    Promise.all([
      api('/personal-messages/contacts'),
      eventId
        ? api('/events/' + encodeURIComponent(eventId))
        : Promise.resolve(null),
    ])
      .then(([directory, incident]) => {
        if (!active) return;
        setContacts(directory.contacts);
        setAreas(directory.areas);
        if (incident) {
          setEvent(incident.event);
          setArea(incident.event.location || '');
        }
      })
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [eventId]);
  async function send(e) {
    e.preventDefault();
    setError('');
    if (!recipientIds.length) {
      setError('请选择至少一名指定收件人。');
      return;
    }
    setBusy(true);
    try {
      const payload = eventId
        ? {
            recipient_ids: recipientIds,
            area,
            note: content,
            request_id: requestId,
          }
        : {
            kind,
            recipient_ids: recipientIds,
            title,
            body: content,
            area,
            device_id: deviceId || null,
            request_id: requestId,
          };
      const result = await api(
        eventId
          ? '/events/' + encodeURIComponent(eventId) + '/assign-intervention'
          : '/personal-messages',
        { method: 'POST', body: JSON.stringify(payload) },
      );
      onSent(result);
    } catch (e) {
      setError(e.message);
      // A validation or authentication failure did not persist a message. A
      // timeout keeps its key, so retrying the same request stays idempotent.
      if (e.status && e.status < 500) setRequestId(crypto.randomUUID());
    } finally {
      setBusy(false);
    }
  }
  const update = (setter) => (e) => {
    setter(e.target.value);
    setRequestId(crypto.randomUUID());
  };
  return (
    <Modal
      title={eventId ? '指定工作人员介入' : '发送个人消息'}
      onClose={() => !busy && onClose()}
      wide
    >
      <form className="modal-body form-grid personal-compose" onSubmit={send}>
        <p className={eventId ? 'message-intervention-note' : 'message-help'}>
          {eventId
            ? '所选工作人员会收到介入警告弹窗，并在个人消息中保留这条要求。事件状态同步到工作区。'
            : '普通消息和巡查要求进入指定成员的个人消息，通过未读角标提示。巡查可在没有风险事件时发起。'}
        </p>
        {event && (
          <p className="message-context">
            关联事件：{event.device_name} · {event.summary || '风险事件'}
          </p>
        )}
        {loading ? (
          <p role="status">正在读取成员信息…</p>
        ) : (
          <>
            {!eventId && (
              <label>
                消息类型
                <select value={kind} onChange={update(setKind)}>
                  <option value="notice">普通消息</option>
                  <option value="inspection">巡查要求</option>
                </select>
              </label>
            )}
            <div className="message-form-pair">
              <label>
                {!eventId && kind === 'inspection'
                  ? '检查区域（必填）'
                  : '相关区域'}
                <input
                  list="personal-message-areas"
                  value={area}
                  maxLength={160}
                  onChange={update(setArea)}
                  required={!eventId && kind === 'inspection'}
                  placeholder="例如：东门取款区"
                />
                <datalist id="personal-message-areas">
                  {areas.map((value) => (
                    <option key={value} value={value} />
                  ))}
                </datalist>
              </label>
              {!eventId && (
                <label>
                  关联设备（可选）
                  <select
                    value={deviceId}
                    onChange={(e) => {
                      setDeviceId(e.target.value);
                      setRequestId(crypto.randomUUID());
                      const device = devices.find(
                        (item) => item.id === e.target.value,
                      );
                      if (device?.location) setArea(device.location);
                    }}
                  >
                    <option value="">独立消息 / 无关联设备</option>
                    {devices.map((device) => (
                      <option key={device.id} value={device.id}>
                        {device.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <Recipients
              contacts={contacts}
              value={recipientIds}
              onChange={(value) => {
                setRecipientIds(value);
                setRequestId(crypto.randomUUID());
              }}
            />
            {!eventId && (
              <label>
                消息标题
                <input
                  value={title}
                  maxLength={120}
                  onChange={update(setTitle)}
                  required
                  placeholder={
                    kind === 'inspection'
                      ? '例如：请检查东门取款区设备与现场情况'
                      : '填写消息标题'
                  }
                />
              </label>
            )}
            <label>
              {eventId
                ? '介入说明'
                : kind === 'inspection'
                  ? '检查要求'
                  : '消息内容'}
              <textarea
                rows={4}
                maxLength={eventId ? 300 : 4000}
                value={content}
                onChange={update(setContent)}
                required
                placeholder={
                  eventId
                    ? '说明需要工作人员到场处理的事项'
                    : '请填写需要对方了解或完成的事项'
                }
              />
            </label>
          </>
        )}
        {error && (
          <p className="form-message" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            icon={Send}
            type="submit"
            kind={eventId ? 'danger' : 'primary'}
            busy={busy}
            disabled={
              loading ||
              !contacts.length ||
              !recipientIds.length ||
              (eventId && !event)
            }
          >
            {' '}
            {eventId ? '发送指定介入通知' : '发送给所选成员'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function InterventionAssignment(props) {
  return <Assignment {...props} />;
}

function MessageDetail({
  message,
  user,
  ui,
  api,
  onClose,
  onUpdate,
  onReply,
  onOpenEvent,
  onDisposition,
}) {
  const { Modal, Badge, Button } = ui;
  const [note, setNote] = useState(''),
    [busy, setBusy] = useState(''),
    [error, setError] = useState('');
  const recipient = message.recipient_id === user.id;
  async function act(action) {
    setBusy(action);
    setError('');
    try {
      const result = await api(
        '/personal-messages/' + message.id + '/' + action,
        {
          method: 'POST',
          body: JSON.stringify(action === 'complete' ? { note } : {}),
        },
      );
      onUpdate(result.message);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }
  return (
    <Modal title={message.title} onClose={onClose} wide>
      <div className="modal-body message-detail">
        <div className="message-tags">
          <Badge
            type={
              message.kind === 'intervention'
                ? 'red'
                : message.kind === 'inspection'
                  ? 'orange'
                  : 'quiet'
            }
          >
            {labels[message.kind]}
          </Badge>
          <Badge type={message.completed_at ? 'green' : 'quiet'}>
            {stateLabel(message)}
          </Badge>
        </div>
        <dl className="message-meta">
          <div>
            <dt>发出人</dt>
            <dd>{message.sender_name}</dd>
          </div>
          <div>
            <dt>收件人</dt>
            <dd>{message.recipient_name}</dd>
          </div>
          <div>
            <dt>相关区域</dt>
            <dd>{message.area || '未指定'}</dd>
          </div>
          <div>
            <dt>发送时间</dt>
            <dd>{time(message.created_at)}</dd>
          </div>
        </dl>
        <p className="message-body">{message.body}</p>
        {!message.is_external&&message.delivery_status&&<p className="message-help">介入邮件：{deliveryLabels[message.delivery_status]||message.delivery_status} · {message.contact_email}</p>}
        {!!message.is_external && (
          <div className="message-completion">
            <b>外部联系记录 · {message.recipient_name}</b>
            <p>
              {message.contact_email && `邮箱：${message.contact_email}\n`}
              {message.contact_phone && `电话：${message.contact_phone}\n`}
              当前状态：
              {{
                pending: '邮件等待发送',
                sending: '邮件发送中',
                accepted: '发信服务已接受',
                failed: '邮件发送失败',
                blocked: '发信授权需要处理',
                suppressed: '测试记录，未向联系人外发邮件',
                manual_call_required: '请使用系统拨号联系',
              }[message.delivery_status] || message.delivery_status}
            </p>
            {message.contact_phone && (
              <a
                className="button primary"
                href={'tel:' + message.contact_phone}
              >
                拨号联系
              </a>
            )}
          </div>
        )}
        {message.device_name && (
          <p className="message-help">关联设备：{message.device_name}</p>
        )}
        {message.event_id && (
          <Button
            icon={ArrowUpRight}
            onClick={() => onOpenEvent(message.event_id)}
          >
            查看关联风险事件
          </Button>
        )}
        <div className="message-progress">
          <span>阅读：{time(message.read_at)}</span>
          {message.kind !== 'notice' && (
            <>
              <span>接单：{time(message.acknowledged_at)}</span>
              <span>完成：{time(message.completed_at)}</span>
            </>
          )}
        </div>
        {message.completed_at && (
          <section className="message-completion">
            <b>完成反馈</b>
            <p>{message.completion_note}</p>
          </section>
        )}
        {recipient && message.kind !== 'notice' && !message.completed_at && (
          <div className="message-task-actions">
            {!message.acknowledged_at && (
              <Button
                kind="primary"
                icon={ClipboardCheck}
                busy={busy === 'ack'}
                disabled={!!busy}
                onClick={() => act('ack')}
              >
                确认接单
              </Button>
            )}
            {message.kind === 'intervention' ? (
              <Button
                kind="primary"
                onClick={() => onDisposition(message.event_id)}
              >
                记录处置结果
              </Button>
            ) : (
              <>
                <label>
                  完成情况
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={1000}
                    rows={3}
                    placeholder="完成检查后，在此反馈处理情况"
                  />
                </label>
                <small>
                  任务反馈同步给发出人与管理员；关联风险事件的处置结果可在事件详情中确认。
                </small>
                <Button
                  kind="primary"
                  icon={CheckCheck}
                  busy={busy === 'complete'}
                  disabled={!!busy || !note.trim()}
                  onClick={() => act('complete')}
                >
                  提交完成反馈
                </Button>
              </>
            )}
          </div>
        )}
        {error && (
          <p className="form-message" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <Button onClick={() => onReply(message)} icon={MessageSquare}>
            回复发出人
          </Button>
          <Button onClick={onClose}>关闭消息</Button>
        </div>
      </div>
    </Modal>
  );
}

function InlineMessageView({ title, children, onClose }) {
  return (
    <section className="message-inline-view" aria-label={title}>
      <header className="message-inline-header">
        <button className="text-button" onClick={onClose}>
          ← 返回消息列表
        </button>
        <h3>{title}</h3>
      </header>
      {children}
    </section>
  );
}

export default function PersonalMessages({
  api,
  ui,
  user,
  notify,
  reload,
  devices,
  selectedId,
  onSelect,
  onOpenEvent,
  onDisposition,
  refreshKey,
  compact = false,
}) {
  const childUi = compact ? { ...ui, Modal: InlineMessageView } : ui;
  const { Button, PanelHeader, Badge, Empty } = ui;
  const [scope, setScope] = useState(user.role === 'owner' ? 'all' : 'inbox');
  const [kind, setKind] = useState(''),
    [unread, setUnread] = useState(false),
    [recipientId, setRecipientId] = useState('');
  const [messages, setMessages] = useState([]),
    [contacts, setContacts] = useState([]),
    [next, setNext] = useState(null);
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [composer, setComposer] = useState(null),
    [detail, setDetail] = useState(null);
  const request = useRef(0);
  async function load(cursor) {
    const version = ++request.current;
    setLoading(true);
    setError('');
    const query = new URLSearchParams({ scope });
    if (kind) query.set('kind', kind);
    if (unread) query.set('unread', '1');
    if (recipientId && scope === 'all') query.set('recipient_id', recipientId);
    if (cursor) query.set('before', cursor);
    try {
      const result = await api('/personal-messages?' + query);
      if (version !== request.current) return;
      setMessages((previous) =>
        cursor
          ? [
              ...previous,
              ...result.messages.filter(
                (item) => !previous.some((old) => old.id === item.id),
              ),
            ]
          : result.messages,
      );
      setNext(result.next_cursor);
    } catch (e) {
      if (version === request.current) setError(e.message);
    } finally {
      if (version === request.current) setLoading(false);
    }
  }
  useEffect(() => {
    load();
    return () => {
      request.current++;
    };
  }, [scope, kind, unread, recipientId, refreshKey]);
  useEffect(() => {
    let active = true;
    api('/personal-messages/contacts')
      .then((result) => active && setContacts(result.contacts))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [refreshKey]);
  useEffect(() => {
    let active = true;
    if (!selectedId) {
      setDetail(null);
      setError('');
      return;
    }
    setError('');
    setDetail((previous) => (previous?.id === selectedId ? previous : null));
    api('/personal-messages/' + encodeURIComponent(selectedId))
      .then(async (result) => {
        if (!active) return;
        setDetail(result.message);
        if (
          result.message.recipient_id === user.id &&
          !result.message.read_at
        ) {
          const read = await api(
            '/personal-messages/' + encodeURIComponent(selectedId) + '/read',
            { method: 'POST', body: '{}' },
          );
          if (active) {
            setDetail(read.message);
            reload();
          }
        }
      })
      .catch((e) => {
        if (active) {
          setError(e.message);
          notify(e.message);
        }
      });
    return () => {
      active = false;
    };
  }, [selectedId, user.id, refreshKey]);
  async function updated(message) {
    setDetail(message);
    await load();
    await reload();
  }
  return (
    <>
      {(!compact || (!selectedId && !composer)) && (
        <section className="panel personal-messages-panel">
          <PanelHeader
            title={
              scope === 'all'
                ? '全部成员的个人消息'
                : scope === 'sent'
                  ? '我发出的消息'
                  : '我的收件箱'
            }
            subtitle={
              user.role === 'owner'
                ? '管理员可查看全部记录；阅读与处置状态由对应收件人确认。'
                : '接收与你有关的消息、巡查要求与指定介入通知。'
            }
            action={
              <Button
                icon={Plus}
                kind="primary"
                onClick={() => setComposer({})}
              >
                发送消息 / 巡查要求
              </Button>
            }
          />
          <div className="message-toolbar">
            <div
              className="message-tabs"
              role="group"
              aria-label="个人消息范围"
            >
              {[...(user.role === 'owner' ? ['all'] : []), 'inbox', 'sent'].map(
                (value) => (
                  <button
                    key={value}
                    className={scope === value ? 'active' : ''}
                    aria-pressed={scope === value}
                    onClick={() => setScope(value)}
                  >
                    {value === 'all'
                      ? '全部成员'
                      : value === 'sent'
                        ? '已发送'
                        : '我的收件箱'}
                  </button>
                ),
              )}
            </div>
            <div className="message-filters">
              <label>
                消息类型
                <select value={kind} onChange={(e) => setKind(e.target.value)}>
                  <option value="">全部类型</option>
                  {Object.entries(labels).map(([key, label]) => (
                    <option value={key} key={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {scope === 'all' && (
                <label>
                  收件人
                  <select
                    value={recipientId}
                    onChange={(e) => setRecipientId(e.target.value)}
                  >
                    <option value="">全部成员</option>
                    {contacts.map((contact) => (
                      <option key={contact.id} value={contact.id}>
                        {contact.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="message-unread">
                <input
                  type="checkbox"
                  checked={unread}
                  onChange={(e) => setUnread(e.target.checked)}
                />
                只看未读
              </label>
            </div>
          </div>
          {error && (
            <div className="message-list-error" role="alert">
              {error}
              <Button onClick={() => load()}>重新加载消息</Button>
            </div>
          )}
          {!error &&
            !messages.length &&
            (loading ? (
              <p className="message-loading" role="status">
                正在读取个人消息…
              </p>
            ) : (
              <Empty icon={Inbox} title="暂无个人消息">
                新的消息、巡查要求和指定介入通知会显示在这里。
              </Empty>
            ))}
          <div className="personal-message-list">
            {messages.map((message) => (
              <button
                key={message.id}
                className={`personal-message-item ${!message.read_at ? 'unread' : ''}`}
                onClick={() => onSelect(message.id)}
                aria-label={`${message.title}，发出人 ${message.sender_name}，收件人 ${message.recipient_name}`}
              >
                <span className={'message-kind-symbol ' + message.kind}>
                  {message.kind === 'notice' ? (
                    <MessageSquare size={21} />
                  ) : (
                    <ClipboardCheck size={21} />
                  )}
                </span>
                <span className="personal-message-text">
                  <span className="message-title-row">
                    <b>{message.title}</b>
                    <Badge
                      type={message.kind === 'intervention' ? 'red' : 'quiet'}
                    >
                      {labels[message.kind]}
                    </Badge>
                  </span>
                  <span className="personal-message-preview">
                    {message.body}
                  </span>
                  <span className="message-people">
                    发出人：{message.sender_name} <span>→</span> 收件人：
                    {message.recipient_name}
                    {message.area && (
                      <span className="message-area">
                        <MapPin size={12} />
                        {message.area}
                      </span>
                    )}
                  </span>
                </span>
                <span className="message-item-meta">
                  <Badge
                    type={
                      message.completed_at
                        ? 'green'
                        : !message.read_at
                          ? 'orange'
                          : 'quiet'
                    }
                  >
                    {stateLabel(message)}
                  </Badge>
                  <small>{time(message.created_at)}</small>
                </span>
              </button>
            ))}
          </div>
          {next && (
            <div className="message-more">
              <Button busy={loading} onClick={() => load(next)}>
                加载更早消息
              </Button>
            </div>
          )}
        </section>
      )}
      {compact && selectedId && (!detail || detail.id !== selectedId) && (
        <InlineMessageView title="读取消息" onClose={() => onSelect(null)}>
          <p className="message-loading" role={error ? 'alert' : 'status'}>
            {error || '正在读取消息内容…'}
          </p>
        </InlineMessageView>
      )}
      {composer && (
        <MessageForm
          api={api}
          ui={childUi}
          devices={devices}
          replyTo={composer.replyTo}
          onClose={() => setComposer(null)}
          onSent={async () => {
            setComposer(null);
            setScope('sent');
            notify('消息已发送给指定成员');
            await load();
            await reload();
          }}
        />
      )}
      {detail && detail.id === selectedId && (
        <MessageDetail
          key={detail.id}
          message={detail}
          user={user}
          ui={childUi}
          api={api}
          onClose={() => onSelect(null)}
          onUpdate={updated}
          onReply={(message) => {
            onSelect(null);
            setComposer({ replyTo: message });
          }}
          onOpenEvent={onOpenEvent}
          onDisposition={onDisposition}
        />
      )}
    </>
  );
}

export function MemberAreas({ member, api, Button, notify }) {
  let initial = [];
  try {
    initial = JSON.parse(member.areas_json || '[]');
  } catch {}
  const [value, setValue] = useState(initial.join('，')),
    [saved, setSaved] = useState(initial.join('，')),
    [busy, setBusy] = useState(false);
  return (
    <form
      className="member-areas"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const result = await api('/users/' + member.id + '/areas', {
            method: 'PUT',
            body: JSON.stringify({
              areas: value
                .split(/[,，;；\n]+/)
                .map((item) => item.trim())
                .filter(Boolean),
            }),
          });
          const nextValue = result.areas.join('，');
          setValue(nextValue);
          setSaved(nextValue);
          notify('成员负责区域已保存');
        } catch (e) {
          notify(e.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        负责区域
        <input
          aria-label={member.name + '负责区域'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="多个区域用逗号分隔"
          maxLength={1600}
        />
      </label>
      <Button type="submit" busy={busy} disabled={value === saved}>
        保存区域
      </Button>
    </form>
  );
}
