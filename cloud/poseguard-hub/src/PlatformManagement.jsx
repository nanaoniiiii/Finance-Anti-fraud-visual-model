import React, { useEffect, useRef, useState } from 'react';
import { Activity, ArrowRight, BarChart3, ChevronDown, Monitor, Plus, RadioTower, UsersRound, X } from 'lucide-react';
import { stationEvidence } from '../shared/station-policy.js';
import './platform-management.css';

const labels = {
  phone_to_ear: '疑似通话姿态', multi_person: '多人进入', lingering: '长时间停留', fraud_risk: '疑似诈骗综合风险',
};
const severities = ['关注', '高风险', '紧急介入'];
const periodNames = { month: '逐月', day: '逐日', hour: '逐小时' };
const statuses = {
  open: '待确认', acknowledged: '待处置', intervention_requested: '待工作人员介入', resolved: '已处理',
};
const localTime = (value) => value ? new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(new Date(value)) : '—';
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());

export function WorkspacePicker({ workspace, workspaces, canCreate, onSelect, onCreate }) {
  const host = useRef(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event) => { if (!host.current?.contains(event.target)) setOpen(false); };
    const escape = (event) => {
      if (event.key === 'Escape') {
        setOpen(false);
        host.current?.querySelector('button')?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  async function create(event) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await onCreate(name.trim());
      setOpen(false);
      setForm(false);
      setName('');
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return <div className="workspace-picker" ref={host}>
    <button className="workspace-label workspace-toggle" type="button" onClick={() => setOpen(!open)}
      aria-expanded={open} aria-controls="poseguard-workspace-list" aria-label={`切换工作区，当前为${workspace.name}`}>
      <span className="status-dot" /><span className="workspace-current">{workspace.name}</span><ChevronDown size={14} />
    </button>
    {open && <div id="poseguard-workspace-list" className="workspace-menu">
      <div className="workspace-menu-items" aria-label="工作区列表">
        {workspaces.map((item) => <button type="button" key={item.id} aria-current={item.id === workspace.id}
          onClick={() => { onSelect(item.id); setOpen(false); }}>{item.name}</button>)}
      </div>
      {canCreate && (form ? <form onSubmit={create}>
        <label htmlFor="new-workspace">工作区名称</label>
        <input id="new-workspace" value={name} onChange={event => setName(event.target.value)}
          maxLength={48} autoFocus required placeholder="例如 城北网点" />
        <button type="submit" className="workspace-create" disabled={busy}>{busy ? '创建中…' : '创建工作区'}</button>
        {error && <p role="alert">{error}</p>}
      </form> : <button type="button" className="workspace-create" onClick={() => setForm(true)}>
        <Plus size={16} /> 新增工作区
      </button>)}
    </div>}
  </div>;
}

function BucketChart({ series, period, onPeriod, date, onDate }) {
  const [selected, setSelected] = useState(null);
  useEffect(() => setSelected(null), [period, date]);
  const bars = series?.buckets || [];
  const max = Math.max(1, ...bars.map(bar => bar.levels.reduce((a, b) => a + b, 0)));
  const detail = selected === null ? null : bars[selected];
  return <>
    <div className="platform-chart-controls">
      <div className="platform-chart-period" aria-label="统计粒度">
        {Object.entries(periodNames).map(([key, name]) => <button type="button" key={key}
          aria-pressed={period === key} onClick={() => onPeriod(key)}>{name}</button>)}
      </div>
      <input type={period === 'day' ? 'month' : 'date'} aria-label="统计日期"
        value={period === 'day' ? date.slice(0, 7) : date}
        onChange={event => { if (event.target.value) onDate(event.target.value.length === 7 ? event.target.value + '-01' : event.target.value); }} />
    </div>
    <div className="platform-chart-key">{severities.map((label, index) =>
      <span key={label}><i className={`bar-level-${index + 1}`} />{label}</span>)}</div>
    <div className="platform-chart-scroll">
      <div className="platform-chart" style={{ '--bar-count': bars.length || 12 }} aria-label={`${periodNames[period]}风险事件分布`}>
        {bars.map((bar, index) => {
          const total = bar.levels.reduce((a, b) => a + b, 0);
          return <button type="button" key={bar.index} aria-pressed={selected === index}
            aria-label={`${bar.label}，关注 ${bar.levels[0]}，高风险 ${bar.levels[1]}，紧急介入 ${bar.levels[2]}`}
            title={`${bar.label} · ${total} 件`} onClick={() => setSelected(index)}>
            <span className="platform-bar-track">
              {[3, 2, 1].map(level => <i key={level} className={`bar-level-${level}`}
                style={{ height: (bar.levels[level - 1] / max * 100) + '%' }} />)}
            </span>
            <small>{bars.length <= 12 || index % (bars.length > 24 ? 5 : 4) === 0 ? bar.label : '\u00a0'}</small>
          </button>;
        })}
      </div>
    </div>
    <div className="platform-chart-caption" aria-live="polite">
      {detail ? `${detail.label} · ${severities.map((label, i) => `${label} ${detail.levels[i]}`).join('　')}` :
        bars.some(item => item.levels.some(Boolean)) ? '按发生时间统计 · 北京时间' : '本周期暂无风险事件'}
    </div>
  </>;
}

export default function PlatformManagement({ workspace, user, api, onLegacy, refreshKey }) {
  const [period, setPeriod] = useState('day');
  const [date, setDate] = useState(today);
  const [summary, setSummary] = useState(null);
  const [section, setSection] = useState(null);
  const [entries, setEntries] = useState([]);
  const [offset, setOffset] = useState(null);
  const [members, setMembers] = useState(null);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [relayName, setRelayName] = useState('');
  const [relay, setRelay] = useState(null);
  const area = useRef(null);
  const root = '/workspaces/' + encodeURIComponent(workspace.id);
  const owner = user.role === 'owner';
  useEffect(() => {
    let valid = true;
    api(`${root}/dashboard?period=${period}&date=${date}`).then(value => {
      if (valid) setSummary(value);
    }).catch(error => { if (valid) setError(error.message); });
    return () => { valid = false; };
  }, [root, period, date, refreshKey]);
  useEffect(() => {
    if (!section) return undefined;
    let valid = true;
    setEntries([]);
    setDetail(null);
    setMembers(null);
    setOffset(null);
    setError('');
    setBusy(true);
    Promise.all([api(root + '/' + section),
      section === 'staff' && owner ? api(root + '/access') : null,
    ]).then(([data, access]) => {
      if (!valid) return;
      setEntries(data.records);
      setOffset(data.next_offset);
      setMembers(access?.members || null);
    }).catch(error => { if (valid) setError(error.message); })
      .finally(() => { if (valid) setBusy(false); });
    return () => { valid = false; };
  }, [root, section, owner, refreshKey]);

  function select(value) {
    setSection(value);
    requestAnimationFrame(() => area.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  }
  async function more() {
    if (offset === null || busy) return;
    setBusy(true);
    try {
      const data = await api(`${root}/${section}?offset=${offset}`);
      setEntries(previous => [...previous, ...data.records]);
      setOffset(data.next_offset);
    } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  async function open(item) {
    try {
      const { record } = await api(root + '/event/' + item.relay_id + '/' + item.id);
      setDetail(record);
    } catch (error) { setError(error.message); }
  }
  async function grant(member) {
    try {
      await api(root + '/access/' + member.id, { method: member.allowed ? 'DELETE' : 'PUT' });
      setMembers(previous => previous.map(item => item.id === member.id ? { ...item, allowed: !item.allowed } : item));
    } catch (error) { setError(error.message); }
  }
  async function register(event) {
    event.preventDefault();
    if (!relayName.trim() || busy) return;
    setBusy(true);
    try {
      const value = await api(root + '/relays', { method: 'POST', body: JSON.stringify({ name: relayName.trim() }) });
      setRelay(value);
      setRelayName('');
      setSummary(await api(`${root}/dashboard?period=${period}&date=${date}`));
    } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  async function revoke(item) {
    if (!window.confirm(`停用边端 ${item.name} 的归档接入？已有归档将保留。`)) return;
    try {
      await api(root + '/relays/' + item.id, { method: 'DELETE' });
      setSummary(previous => ({ ...previous, relays: previous.relays.filter(relay => relay.id !== item.id) }));
    } catch (error) { setError(error.message); }
  }
  const cards = [
    ['event', Activity, '事件管理', '查看风险记录和处置时间线'],
    ['device', Monitor, '设备总览与管理', '查看设备在线状态与边端接入'],
    ['staff', UsersRound, '人员管理', '查看本网点人员与云端访问权限'],
  ];
  const card = ([key, Icon, title, caption]) => <article className="platform-tile" key={key}>
    <div className="platform-tile-heading"><span className="platform-tile-icon"><Icon size={20} /></span>
      <h2>{title}</h2></div>
    <strong className="platform-total">{summary?.counts[key] ?? '—'}</strong>
    <p>{caption}</p>
    <button type="button" className="platform-open" onClick={() => select(key)}>{title}<ArrowRight size={16} /></button>
  </article>;
  const sectionName = cards.find(([key]) => key === section)?.[2];
  return <div className="platform-management">
    {error && <div className="alert-banner" role="alert">{error}<button type="button" onClick={() => setError('')}>关闭</button></div>}
    <div className="platform-grid">
      {card(cards[0])}
      <article className="platform-tile platform-chart-tile">
        <div className="platform-tile-heading"><span className="platform-tile-icon"><BarChart3 size={20} /></span><h2>风险报警分布</h2></div>
        <BucketChart series={summary?.series} period={period} date={date} onDate={setDate} onPeriod={setPeriod} />
      </article>
      {card(cards[1])}
      {card(cards[2])}
    </div>
    {section && <section ref={area} className="platform-section">
      <div className="platform-tile-heading"><h2>{sectionName}</h2>
        <button type="button" className="icon-button" aria-label={`关闭${sectionName}`} onClick={() => setSection(null)}><X size={18} /></button>
      </div>
      {workspace.id === 'main' && <button type="button" className="platform-open" onClick={() => onLegacy(section)}>
        {section === 'event' ? '主工作区直连设备事件' : section === 'device' ? '主工作区直连设备管理' : '主工作区通知与成员'}
        <ArrowRight size={16} />
      </button>}
      {busy && !entries.length && <p role="status">正在读取归档…</p>}
      {section === 'event' && <div className="platform-records">
        {entries.map(item => <button type="button" key={item.relay_id + item.id}
          className={`platform-event ${item.status !== 'resolved' ? 'pending' : ''}`} onClick={() => open(item)}>
          <span><b>{labels[item.risk_kind] || item.risk_kind}</b><small>{item.device_name} · {item.edge_name}</small></span>
          <span className={`platform-level platform-level-${item.severity}`}>{severities[item.severity - 1]}</span>
          <span>{localTime(item.occurred_at)}</span>
          <span>{statuses[item.status]}
            {item.handled_at && <small>{item.handled_by_name || '—'} · {localTime(item.handled_at)}</small>}
          </span>
        </button>)}
        {detail && <div className="platform-event-detail">
          <div className="platform-tile-heading"><h3>{labels[detail.risk_kind]}</h3>
            <button type="button" className="icon-button" aria-label="关闭事件详情" onClick={() => setDetail(null)}><X size={17} /></button>
          </div>
          <p>{detail.device_name} · {detail.edge_name} · {statuses[detail.status]} · {localTime(detail.occurred_at)}</p>
          {detail.risk_score !== null && <p>边端融合评分 {detail.risk_score} / 100</p>}
          {detail.evidence.length > 0 && <ul>{detail.evidence.map(code => <li key={code}>{stationEvidence[code]?.label}</li>)}</ul>}
          {detail.snapshot && <img alt="边端事件截图" src={`data:${detail.snapshot.mime_type};base64,${detail.snapshot.data_base64}`} />}
          <p>处理人 {detail.handled_by_name || '—'} · 处理时间 {localTime(detail.handled_at)}</p>
          {detail.updates.length > 0 && <ol>{detail.updates.map((value,index) =>
            <li key={index}>{localTime(value.occurred_at)} · {({
              created:'边端记录风险', escalated:'风险证据更新', resolved:'检测信号结束', disposition:'人工处置',
              acknowledged:'人工确认', intervention_requested:'请求工作人员介入', 'record-disposition':'人工处置',
            })[value.action] || value.action}</li>)}</ol>}
        </div>}
      </div>}
      {section === 'device' && <>
        <div className="platform-records">
          {entries.map(item => <div className="platform-record" key={item.relay_id + item.id}>
            <div><b>{item.name}</b><small>{
              [...new Set([item.edge_name, item.location || item.platform, item.fusion_group].filter(Boolean))].join(' · ')
            }</small></div>
            <span>{item.revoked ? '已解绑' : item.last_seen && Date.now() - Date.parse(item.last_seen) < 90000 ? '在线' : '离线'}</span>
          </div>)}
        </div>
        {owner && <div className="platform-relays">
          <h3><RadioTower size={16} /> 边端归档接入</h3>
          {(summary?.relays || []).map(item => <div className="platform-record" key={item.id}>
            <div><b>{item.name}</b><small>最后同步 {localTime(item.last_seen)}</small></div>
            <button type="button" onClick={() => revoke(item)}>停用接入</button>
          </div>)}
          <form onSubmit={register}><input aria-label="边端名称" placeholder="边端名称" maxLength={80}
            required value={relayName} onChange={event => setRelayName(event.target.value)} />
            <button className="button primary" type="submit" disabled={busy}><Plus size={15} /> 生成边端接入配置</button>
          </form>
          {relay && <div className="platform-secret">
            <p>将配置中的 archive 部分保存到边端。归档密钥只在生成时显示。</p>
            <pre>{JSON.stringify({ archive: { server_url: relay.server_url, token: relay.token } }, null, 2)}</pre>
            <button type="button" onClick={() => setRelay(null)}>收起配置</button>
          </div>}
        </div>}
      </>}
      {section === 'staff' && <>
        <div className="platform-records">
          {entries.map(item => <div className="platform-record" key={item.relay_id + item.id}>
            <div><b>{item.name}</b><small>{item.edge_name}</small></div><span>{item.role === 'owner' ? '边端管理员' : '边端工作人员'}</span>
          </div>)}
        </div>
        {members && <div className="platform-relays">
          <h3>云端查看权限</h3>
          {members.map(member => <div className="platform-record" key={member.id}>
            <div><b>{member.name}</b><small>{member.email}</small></div>
            <button type="button" disabled={member.role === 'owner' || workspace.id === 'main'}
              onClick={() => grant(member)}>{member.allowed ? '允许查看' : '未授权'}</button>
          </div>)}
        </div>}
      </>}
      {!busy && !entries.length && <p className="platform-empty">暂无来自边端的归档</p>}
      {offset !== null && <button className="platform-open" type="button" onClick={more} disabled={busy}>加载更多</button>}
    </section>}
  </div>;
}
