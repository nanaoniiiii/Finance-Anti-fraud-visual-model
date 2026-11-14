import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Bell,
  BellRing,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Cpu,
  Download,
  Eye,
  FileText,
  Grid2X2,
  HelpCircle,
  History,
  Image as ImageIcon,
  Link,
  LoaderCircle,
  LogOut,
  Mail,
  Menu,
  Monitor,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Smartphone,
  TriangleAlert,
  Unplug,
  Users,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import QRCode from 'qrcode';
import './style.css';

const riskName = {
  phone_to_ear: '疑似通话姿态',
  multi_person: '多人进入',
  lingering: '长时间停留',
};
const stateName = {
  open: '待确认',
  acknowledged: '已确认',
  intervention_requested: '待工作人员介入',
  resolved: '已处理',
};
const platformName = {
  windows: 'Windows',
  rk3566: 'RK3566',
  maixcam: 'MaixCAM',
  esp32s3: 'ESP32-S3',
  android: '安卓手机',
  ios: 'iPhone',
};
const levels = ['候选', '关注', '高风险', '紧急'];
const timeFormat = (value) =>
  value
    ? new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(new Date(value))
    : '—';
function ago(value) {
  if (!value) return '尚未上线';
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(value)) / 1000)
  );
  return seconds < 60
    ? `${seconds} 秒前`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)} 分钟前`
      : `${Math.floor(seconds / 3600)} 小时前`;
}
const nativeRequests = new Map();
window.__poseguardNativeResult = (id, status, body) => {
  const pending = nativeRequests.get(id);
  if (!pending) return;
  nativeRequests.delete(id);
  clearTimeout(pending.timeout);
  pending.resolve({ status, body });
};
function nativeRequest(path, options) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timeout = setTimeout(() => {
      nativeRequests.delete(id);
      reject(new Error('原生连接超时'));
    }, 22000);
    nativeRequests.set(id, { resolve, reject, timeout });
    window.PoseGuardNative.request(
      id,
      '/api' + path,
      options.method || 'GET',
      options.body || ''
    );
  });
}
async function api(path, options = {}) {
  const retryable =
    !options.method || options.method === 'GET' || path === '/auth/login';
  const attempts = retryable ? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      if (window.PoseGuardNative) {
        const native = await nativeRequest(path, options);
        if (!native.status) throw new Error('网络连接未完成');
        let data;
        try {
          data = JSON.parse(native.body);
        } catch {
          throw new Error('服务响应异常');
        }
        if (native.status < 200 || native.status >= 300) {
          const error = new Error(data.error || '操作失败');
          error.status = native.status;
          throw error;
        }
        return data;
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      let response;
      try {
        response = await fetch('/api' + path, {
          credentials: 'same-origin',
          cache: 'no-store',
          ...options,
          signal: controller.signal,
          headers: {
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...options.headers,
          },
        });
      } finally {
        clearTimeout(timeout);
      }
      let data;
      try {
        data = await response.json();
      } catch {
        const error = new Error('服务响应异常，请稍后重试');
        error.status = response.status;
        throw error;
      }
      if (!response.ok) {
        const error = new Error(data.error || '操作失败');
        error.status = response.status;
        throw error;
      }
      return data;
    } catch (error) {
      if (error.status) throw error;
      if (attempt === attempts - 1)
        throw new Error(
          '网络连接未完成，请稍后重试。账号和口令不会因此被修改。'
        );
      await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
    }
  }
}

function Button({
  children,
  icon: Icon,
  onClick,
  kind = '',
  busy = false,
  disabled = false,
  type = 'button',
  className = '',
}) {
  return (
    <button
      type={type}
      className={`button ${kind} ${className}`}
      onClick={onClick}
      disabled={disabled || busy}
    >
      {busy ? (
        <LoaderCircle size={16} className="spin" />
      ) : Icon ? (
        <Icon size={16} />
      ) : null}
      {children}
    </button>
  );
}
function Badge({ children, type = 'quiet' }) {
  return <span className={`badge ${type}`}>{children}</span>;
}
function Empty({ icon: Icon = ShieldCheck, title, children, action }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon size={27} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
function Modal({ title, children, onClose, wide = false }) {
  return (
    <div
      className="modal-overlay"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <section
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
function PlatformIcon({ platform, size = 21 }) {
  return platform === 'windows' ? (
    <Monitor size={size} />
  ) : ['android', 'ios'].includes(platform) ? (
    <Smartphone size={size} />
  ) : (
    <Cpu size={size} />
  );
}
function Login({ onDone, notice }) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [invite] = useState(() =>
    new URLSearchParams(location.hash.slice(1)).get('invite')
  );
  async function submit(e) {
    e.preventDefault();
    setLoading(true);
    setMessage('');
    try {
      if (invite) {
        const result = await api('/auth/join', {
          method: 'POST',
          body: JSON.stringify({ token: invite, password }),
        });
        setEmail(result.email);
        history.replaceState({}, '', '/');
        setMessage('成员账号已创建，请使用该邮箱和口令登录。');
        location.hash = '';
        return;
      }
      await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      onDone();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="login-screen">
      <div className="login-story">
        <div className="brand">
          <span className="brand-mark">
            <ShieldCheck />
          </span>
          <span>
            PoseGuard <small>云端预警中心</small>
          </span>
        </div>
        <div>
          <span className="eyebrow">ONE WORKSPACE. EVERY DEVICE.</span>
          <h1>
            让风险被看见，
            <br />
            让处置有回应。
          </h1>
          <p>
            从端侧的一个异常动作，到工作人员的一次及时介入。
            <br />
            Windows、RK3566、MaixCAM 与 ESP32-S3，在同一处协同。
          </p>
          <div className="platform-strip">
            <Monitor />
            <Cpu />
            <Cpu />
            <Smartphone />
            <span>端侧记录 · 云端同步 · 移动接收</span>
          </div>
        </div>
        <div className="login-footer">
          <span className="status-dot" /> 设备密钥接入 · 截图按权限访问
        </div>
      </div>
      <div className="login-form-wrap">
        <form onSubmit={submit} className="login-form">
          <div className="mobile-brand">
            <ShieldCheck /> PoseGuard
          </div>
          <span className="eyebrow">WELCOME BACK</span>
          <h2>{invite ? '加入管理团队' : '登录管理工作台'}</h2>
          <p>
            {invite
              ? '设置你的登录口令，加入设备预警工作区。'
              : '查看设备、处理预警，并同步通知偏好。'}
          </p>
          {!invite && (
            <label>
              邮箱
              <input
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="管理员或成员邮箱"
                required
              />
            </label>
          )}
          <label>
            {invite ? '设置口令（至少 12 位）' : '登录口令'}
            <input
              type="password"
              autoComplete={invite ? 'new-password' : 'current-password'}
              minLength={invite ? 12 : 1}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="输入登录口令"
              required
            />
          </label>
          {message && (
            <div className="form-message" role="alert">
              {message}
            </div>
          )}
          <Button type="submit" kind="primary full" busy={loading}>
            {invite ? '创建成员账号' : '进入工作台'}
            <ArrowRight size={16} />
          </Button>
          <div className="form-note">
            <ShieldCheck size={16} />
            <span>
              首次管理员口令由部署时生成。
              <br />
              登录后可在“系统设置”中修改。
            </span>
          </div>
        </form>
      </div>
    </div>
  );
}

function App() {
  const [user, setUser] = useState(undefined);
  const [page, setPage] = useState(
    location.pathname.startsWith('/events')
      ? 'events'
      : ['devices', 'notifications', 'settings', 'team'].includes(
            location.pathname.slice(1)
          )
        ? location.pathname.slice(1)
        : 'overview'
  );
  const [selectedEvent, setSelectedEvent] = useState(
    location.pathname.split('/events/')[1] || null
  );
  const [devices, setDevices] = useState([]);
  const [receivers, setReceivers] = useState([]);
  const [events, setEvents] = useState([]);
  const [stats, setStats] = useState(null);
  const [settings, setSettings] = useState(null);
  const [config, setConfig] = useState(null);
  const [toast, setToast] = useState('');
  const [testNotice, setTestNotice] = useState(null);
  const [modal, setModal] = useState(null);
  const [urgent, setUrgent] = useState(null);
  const [connection, setConnection] = useState('connecting');
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [mobileMenu, setMobileMenu] = useState(false);
  const [error, setError] = useState('');
  const cursor = useRef(0);
  const seen = useRef(new Set());
  const socket = useRef(null);
  const alertAudio = useRef(null);
  const [sound, setSound] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState(
    window.PoseGuardNative
      ? 'default'
      : 'Notification' in window
        ? Notification.permission
        : 'unsupported'
  );
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!window.PoseGuardNative) return;
    const update = () =>
      setNotificationPermission(
        window.PoseGuardNative.notificationsEnabled?.() ? 'granted' : 'default'
      );
    update();
    const timer = setInterval(update, 3000);
    return () => clearInterval(timer);
  }, []);
  const notify = (message) => {
    setToast(message);
    setTimeout(() => setToast(''), 4500);
  };
  async function identity() {
    try {
      const result = await api('/auth/me');
      setUser(result.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }
  async function reload() {
    try {
      const [fleet, feed, counts, prefs] = await Promise.all([
        api('/devices'),
        api('/events'),
        api('/stats'),
        api('/settings'),
      ]);
      setDevices(fleet.devices);
      setReceivers(fleet.receivers);
      setEvents(feed.events);
      setStats(counts);
      setSettings(prefs);
      setError('');
    } catch (e) {
      if (e.status === 401) setUser(null);
      else setError(e.message);
    }
  }
  function changeEvent(change) {
    if (change.seq) cursor.current = Math.max(cursor.current, change.seq);
    const key = change.seq || `${change.entity_id}:${change.action}`;
    if (seen.current.has(key)) return;
    seen.current.add(key);
    if (seen.current.size > 500)
      seen.current = new Set([...seen.current].slice(-300));
    if (change.category === 'notification' && change.data?.test)
      setTestNotice(change.data);
    if (change.category === 'device' && change.data?.notify)
      notify(`${change.data.title}：${change.data.name}`);
    if (change.category === 'event' && change.data?.notify) {
      setUrgent({ ...change.data, id: change.entity_id });
      if (sound && alertAudio.current) {
        try {
          const oscillator = alertAudio.current.createOscillator();
          const gain = alertAudio.current.createGain();
          gain.gain.value = 0.07;
          oscillator.connect(gain);
          gain.connect(alertAudio.current.destination);
          oscillator.frequency.value = 660;
          oscillator.start();
          oscillator.stop(alertAudio.current.currentTime + 0.25);
        } catch {}
      }
    }
    reload();
  }
  useEffect(() => {
    identity();
    api('/public-config')
      .then(setConfig)
      .catch(() => {});
    if ('serviceWorker' in navigator && !window.PoseGuardNative)
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    const handler = () => {
      setPage(
        location.pathname.startsWith('/events')
          ? 'events'
          : ['devices', 'notifications', 'settings', 'team'].includes(
                location.pathname.slice(1)
              )
            ? location.pathname.slice(1)
            : 'overview'
      );
      setSelectedEvent(location.pathname.split('/events/')[1] || null);
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);
  useEffect(() => {
    if (!user) return;
    reload();
    let stopped = false;
    let retry;
    let initial = true;
    async function poll() {
      try {
        const result = await api(
          '/changes?after=' + cursor.current + (initial ? '&bootstrap=1' : '')
        );
        if (initial) {
          initial = false;
          cursor.current = result.cursor || 0;
          for (const item of result.changes || []) seen.current.add(item.seq);
        } else for (const change of result.changes || []) changeEvent(change);
      } catch {}
    }
    poll();
    function connect() {
      if (stopped) return;
      const ws = new WebSocket(
        `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/socket`
      );
      socket.current = ws;
      ws.onopen = () => setConnection('live');
      ws.onmessage = (e) => {
        if (e.data === 'pong') return;
        try {
          changeEvent(JSON.parse(e.data));
        } catch {}
      };
      ws.onerror = () => setConnection('reconnecting');
      ws.onclose = () => {
        setConnection('reconnecting');
        if (!stopped) retry = setTimeout(connect, 3000);
      };
    }
    if (window.PoseGuardNative) setConnection('live');
    else connect();
    const heartbeat = setInterval(() => {
      if (socket.current?.readyState === 1) socket.current.send('ping');
      poll();
    }, 6000);
    const refresh = setInterval(reload, 20000);
    return () => {
      stopped = true;
      clearTimeout(retry);
      clearInterval(heartbeat);
      clearInterval(refresh);
      socket.current?.close();
    };
  }, [user?.id, sound]);
  useEffect(() => {
    if (!selectedEvent || !user) {
      setDetail(null);
      return;
    }
    api('/events/' + selectedEvent)
      .then(setDetail)
      .catch((e) => notify(e.message));
  }, [selectedEvent, events, user?.id]);
  function navigate(next, id = null) {
    setPage(next);
    setSelectedEvent(id);
    setMobileMenu(false);
    history.pushState(
      {},
      '',
      next === 'events'
        ? '/events' + (id ? '/' + id : '')
        : next === 'overview'
          ? '/'
          : '/' + next
    );
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  async function action(id, kind, note = '') {
    setBusy(true);
    try {
      await api(`/events/${id}/${kind}`, {
        method: 'POST',
        body: JSON.stringify({ note }),
      });
      notify(
        kind === 'request-intervention'
          ? '已发起工作人员介入请求'
          : kind === 'ack'
            ? '已确认，处置记录已同步'
            : '处置结果已保存'
      );
      setModal(null);
      await reload();
    } catch (e) {
      notify(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function subscribe() {
    if (window.PoseGuardNative) {
      if (window.PoseGuardNative.notificationsEnabled?.()) {
        notify('本机告警接收已开启');
        return;
      }
      try {
        const result = await api('/native-receivers', {
          method: 'POST',
          body: JSON.stringify({
            installation_id: window.PoseGuardNative.installationId(),
            label: 'Android 原生告警接收端',
            device_ids: [],
          }),
        });
        window.PoseGuardNative.enableNotifications(
          result.receiver_token,
          result.cursor
        );
        setNotificationPermission('default');
        notify('已绑定此手机；请允许系统通知，保持告警服务运行。');
        reload();
      } catch (error) {
        notify(error.message);
      }
      return;
    }
    if (!('Notification' in window) || !('PushManager' in window)) {
      notify('当前浏览器不支持推送。iPhone 请先添加到主屏幕并从主屏幕打开。');
      return;
    }
    try {
      const permission = await Notification.requestPermission();
      setNotificationPermission(permission);
      if (permission !== 'granted') {
        notify('请在系统或浏览器设置中允许此站点通知。');
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        const key = config.vapid_public_key;
        const padding = '='.repeat((4 - (key.length % 4)) % 4);
        const bytes = Uint8Array.from(
          atob((key + padding).replaceAll('-', '+').replaceAll('_', '/')),
          (c) => c.charCodeAt(0)
        );
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: bytes,
        });
      }
      const label = /iPhone|iPad/.test(navigator.userAgent)
        ? 'iPhone 主屏幕 App'
        : /Android/.test(navigator.userAgent)
          ? '安卓 App / Chrome'
          : 'Windows / 桌面浏览器';
      await api('/push-subscriptions', {
        method: 'POST',
        body: JSON.stringify({
          subscription: subscription.toJSON(),
          label,
          device_ids: [],
        }),
      });
      notify('本接收端已绑定当前工作区的设备通知');
      reload();
    } catch (e) {
      notify(e.message || '通知授权未完成');
    }
  }
  if (loading && user === undefined)
    return (
      <div className="initial-load">
        <ShieldCheck size={36} />
        <p>正在连接预警中心…</p>
      </div>
    );
  if (!user) return <Login onDone={identity} />;
  const active = devices.filter((d) => !d.revoked_at);
  const online = active.filter((d) => d.online).length;
  const waiting = events.filter((e) => e.status !== 'resolved');
  const critical = events.filter((e) => e.status === 'intervention_requested');
  const shown = events.filter(
    (e) =>
      (filter === 'all' || e.status === filter) &&
      (!search ||
        `${e.device_name} ${riskName[e.risk_kind]} ${e.location}`
          .toLowerCase()
          .includes(search.toLowerCase()))
  );
  const pageTitles = {
    overview: '工作区总览',
    devices: '设备与绑定',
    events: '事件中心',
    notifications: '通知与成员',
    settings: '系统设置',
  };
  const nav = [
    ['overview', Grid2X2, '工作区总览'],
    ['devices', Monitor, '设备与绑定'],
    ['events', Activity, '事件中心'],
    ['notifications', Bell, '通知与成员'],
    ['settings', Settings, '系统设置'],
  ];
  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileMenu ? 'visible' : ''}`}>
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate('overview');
          }}
        >
          <span className="brand-mark">
            <ShieldCheck />
          </span>
          <span>
            PoseGuard<small>多端云预警中心</small>
          </span>
        </a>
        <div className="workspace-label">
          <span className="status-dot" /> 主工作区 <ChevronDown size={13} />
        </div>
        <nav>
          {nav.map(([key, Icon, label]) => (
            <button
              key={key}
              className={page === key ? 'active' : ''}
              onClick={() => navigate(key)}
            >
              <Icon size={19} />
              {label}
              {key === 'events' && waiting.length > 0 && (
                <span className="nav-count">{waiting.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="edge-note">
            <span className="mini-shield">
              <ShieldCheck size={18} />
            </span>
            <b>端侧记录，云端协同</b>
            <p>设备离线时保留本地事件，恢复连接后同步。</p>
          </div>
          <button className="profile" onClick={() => setModal('profile')}>
            <span className="avatar">{user.name.slice(0, 1)}</span>
            <span>
              <b>{user.name}</b>
              <small>
                {user.role === 'owner' ? '工作区管理员' : '工作人员'}
              </small>
            </span>
            <Settings size={15} />
          </button>
        </div>
      </aside>
      {mobileMenu && (
        <div className="sidebar-mask" onClick={() => setMobileMenu(false)} />
      )}
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              onClick={() => setMobileMenu(true)}
              aria-label="打开菜单"
            >
              <Menu size={22} />
            </button>
            <span>云端管理</span>
            <ChevronRight size={14} />
            <b>{pageTitles[page]}</b>
          </div>
          <div className="topbar-actions">
            <span
              className={`connection ${connection === 'live' ? '' : 'warning'}`}
            >
              <span className="status-dot" />
              {connection === 'live' ? '实时同步' : '正在重连'}
            </span>
            <button
              className="icon-button"
              title="通知设置"
              onClick={() => navigate('notifications')}
            >
              <Bell size={20} />
              {waiting.length > 0 && <i className="notification-dot" />}
            </button>
            <span className="avatar small">{user.name.slice(0, 1)}</span>
          </div>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {page === 'overview'
                  ? 'MONITOR / RESPOND / RESOLVE'
                  : 'POSEGUARD WORKSPACE'}
              </div>
              <h1>{pageTitles[page]}</h1>
              <p>
                {page === 'overview'
                  ? '连接每一台设备，及时跟进每一次预警。'
                  : page === 'devices'
                    ? '绑定终端、查看在线状态，并管理手机接收端。'
                    : page === 'events'
                      ? '从首次触发到升级、确认和介入，完整追踪每一次处置。'
                      : page === 'notifications'
                        ? '网页、手机和邮箱使用同一套通知偏好。'
                        : '累计规则、发信账号和登录口令，统一配置。'}
              </p>
            </div>
            <div className="heading-actions">
              <Button icon={RefreshCw} onClick={reload}>
                刷新
              </Button>
              {user.role === 'owner' && (
                <Button
                  icon={Plus}
                  kind="primary"
                  onClick={() => setModal('bind')}
                >
                  绑定设备
                </Button>
              )}
            </div>
          </div>
          {error && (
            <div className="alert-banner">
              <TriangleAlert size={18} />
              {error}
              <Button onClick={reload}>重试</Button>
            </div>
          )}

          {page === 'overview' && (
            <>
              <section
                className={`focus-banner ${critical.length ? 'urgent' : ''}`}
              >
                <div className="focus-symbol">
                  {critical.length ? (
                    <BellRing size={26} />
                  ) : (
                    <ShieldCheck size={28} />
                  )}
                </div>
                <div>
                  <span>
                    {critical.length ? '需要及时跟进' : '设备监测工作区'}
                  </span>
                  <h2>
                    {critical.length
                      ? `${critical.length} 件预警正在等待工作人员介入`
                      : '每一次预警，都有清晰的处理路径'}
                  </h2>
                  <p>
                    {critical.length
                      ? '查看目标截图、确认现场情况，并记录介入结果。'
                      : `候选与确认状态累计超过 ${settings?.rules.frame_threshold || 100} 帧上报，升级事件单独留痕。`}
                  </p>
                </div>
                <Button
                  kind={critical.length ? 'danger' : 'light'}
                  icon={ArrowUpRight}
                  onClick={() => {
                    setFilter(
                      critical.length ? 'intervention_requested' : 'all'
                    );
                    navigate('events');
                  }}
                >
                  {critical.length ? '立即处理' : '查看事件'}
                </Button>
              </section>
              <div className="metrics">
                <Metric
                  title="在线监测设备"
                  value={online}
                  suffix={'/ ' + active.length}
                  icon={Monitor}
                  note="90 秒内收到心跳"
                />
                <Metric
                  title="待确认事件"
                  value={stats?.events.open || 0}
                  icon={Clock}
                  note="最近 24 小时"
                />
                <Metric
                  title="待工作人员介入"
                  value={stats?.events.intervention || 0}
                  icon={BellRing}
                  type="red"
                  note="需优先跟进"
                />
                <Metric
                  title="已完成处置"
                  value={stats?.events.resolved || 0}
                  icon={CheckCheck}
                  type="green"
                  note="最近 24 小时"
                />
              </div>
              <div className="overview-grid">
                <section className="panel">
                  <PanelHeader
                    title="监测终端"
                    subtitle="所有平台统一接入"
                    action={
                      <button
                        className="text-button"
                        onClick={() => navigate('devices')}
                      >
                        管理设备 <ArrowRight size={14} />
                      </button>
                    }
                  />
                  {active.length ? (
                    <div className="device-grid">
                      {active.slice(0, 4).map((d) => (
                        <DeviceCard
                          key={d.id}
                          device={d}
                          onOpen={() => {
                            navigate('devices');
                            setModal({ type: 'device', device: d });
                          }}
                        />
                      ))}
                    </div>
                  ) : (
                    <Empty
                      icon={Monitor}
                      title="先连接你的第一台设备"
                      action={
                        <Button
                          kind="primary"
                          icon={Plus}
                          onClick={() => setModal('bind')}
                        >
                          创建设备绑定码
                        </Button>
                      }
                    >
                      支持 Windows、RK3566、MaixCAM 和 ESP32-S3。
                    </Empty>
                  )}
                </section>
                <section className="panel flow-panel">
                  <PanelHeader
                    title="预警处置流程"
                    subtitle="让每一步都有记录"
                  />
                  <div className="workflow">
                    <Workflow
                      icon={Activity}
                      n="01"
                      title="端侧发现"
                      text="累计候选与确认状态，保留本地记录及目标截图。"
                    />
                    <Workflow
                      icon={Bell}
                      n="02"
                      title="云端同步"
                      text="超过阈值时上报，网页、App 与邮箱接收通知。"
                    />
                    <Workflow
                      icon={Users}
                      n="03"
                      title="人工介入"
                      text="确认、呼叫工作人员、记录处置结果并闭环。"
                    />
                  </div>
                  <div className="rule-caption">
                    <ShieldCheck size={15} /> 视觉预警用于辅助核查
                  </div>
                </section>
              </div>
              <section className="panel">
                <PanelHeader
                  title="最近事件"
                  subtitle="最新状态与各接收端同步"
                  action={
                    <button
                      className="text-button"
                      onClick={() => navigate('events')}
                    >
                      全部事件 <ArrowRight size={14} />
                    </button>
                  }
                />
                {events.length ? (
                  <EventTable
                    events={events.slice(0, 6)}
                    onOpen={(id) => navigate('events', id)}
                  />
                ) : (
                  <Empty title="目前没有上报事件">
                    设备累计超过阈值后，事件会出现在这里。
                  </Empty>
                )}
              </section>
            </>
          )}

          {page === 'devices' && (
            <>
              <div className="section-heading">
                <h2>
                  监测终端 <span>{active.length}</span>
                </h2>
                <div className="platform-pills">
                  {['windows', 'rk3566', 'maixcam', 'esp32s3'].map((p) => (
                    <span key={p}>
                      <PlatformIcon platform={p} size={14} />
                      {platformName[p]}
                    </span>
                  ))}
                </div>
              </div>
              {active.length ? (
                <div className="device-grid full-grid">
                  {active.map((d) => (
                    <DeviceCard
                      key={d.id}
                      device={d}
                      onOpen={() => setModal({ type: 'device', device: d })}
                    />
                  ))}
                </div>
              ) : (
                <section className="panel">
                  <Empty
                    icon={Link}
                    title="用一次性绑定码连接设备"
                    action={
                      <Button kind="primary" onClick={() => setModal('bind')}>
                        添加终端
                      </Button>
                    }
                  >
                    绑定码 10 分钟有效，每个码只绑定一台设备。
                  </Empty>
                </section>
              )}
              <section className="panel receiver-panel">
                <PanelHeader
                  title="手机与浏览器接收端"
                  subtitle="安装 App 或授权通知后，在这里查看接收终端"
                  action={
                    <Button icon={Bell} onClick={subscribe}>
                      启用本机通知
                    </Button>
                  }
                />
                {receivers.length ? (
                  <div className="receiver-list">
                    {receivers.map((r) => (
                      <div className="receiver" key={r.id}>
                        <span className="device-icon">
                          <Smartphone size={22} />
                        </span>
                        <div>
                          <b>{r.label}</b>
                          <small>
                            {r.user_name} ·{' '}
                            {r.last_error ||
                              `已订阅 · ${timeFormat(r.created_at)}`}
                          </small>
                        </div>
                        <Badge type={r.last_error ? 'orange' : 'green'}>
                          {r.last_error ? '需重新授权' : '通知已订阅'}
                        </Badge>
                        <button
                          className="text-button"
                          onClick={async () => {
                            try {
                              await api('/push-subscriptions/' + r.id, {
                                method: 'DELETE',
                              });
                              notify('接收端已解绑');
                              reload();
                            } catch (e) {
                              notify(e.message);
                            }
                          }}
                        >
                          解除
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <Empty icon={Smartphone} title="让手机接收设备预警">
                    在安卓 App 或 iPhone 主屏幕 App 中登录，选择“启用本机通知”。
                  </Empty>
                )}
              </section>
            </>
          )}

          {page === 'events' && (
            <>
              {selectedEvent && detail ? (
                <section className="event-detail">
                  <button
                    className="text-button back"
                    onClick={() => navigate('events')}
                  >
                    <ArrowLeft size={16} /> 返回事件列表
                  </button>
                  <div className="detail-heading">
                    <div>
                      <div className="inline">
                        <Badge type={'level' + detail.event.severity}>
                          {levels[detail.event.severity]}
                        </Badge>
                        <Badge>{stateName[detail.event.status]}</Badge>
                      </div>
                      <h2>{riskName[detail.event.risk_kind]}</h2>
                      <p>
                        {detail.event.device_name} ·{' '}
                        {detail.event.location || '位置未设置'} ·{' '}
                        {platformName[detail.event.platform]}
                      </p>
                    </div>
                    <div className="heading-actions">
                      <Button
                        kind="primary"
                        icon={Check}
                        busy={busy}
                        onClick={() => action(selectedEvent, 'ack')}
                      >
                        确认收到
                      </Button>
                      <Button
                        kind="danger-outline"
                        icon={Users}
                        busy={busy}
                        onClick={() =>
                          setModal({ type: 'intervention', id: selectedEvent })
                        }
                      >
                        呼叫工作人员
                      </Button>
                      <Button
                        icon={CheckCheck}
                        onClick={() =>
                          setModal({ type: 'resolve', id: selectedEvent })
                        }
                      >
                        记录处置
                      </Button>
                    </div>
                  </div>
                  <div className="detail-grid">
                    <section className="panel screenshot-panel">
                      <PanelHeader
                        title="目标人员截图"
                        subtitle="仅工作区登录成员可访问"
                      />
                      {detail.snapshots.length ? (
                        <>
                          <img
                            className="person-snapshot"
                            src={'/api/snapshots/' + detail.snapshots[0].id}
                            alt="特殊事件目标人员截图"
                          />
                          <div className="capture-time">
                            截图时间{' '}
                            {timeFormat(detail.snapshots[0].captured_at)}
                          </div>
                          {detail.snapshots.length > 1 && (
                            <div className="snapshot-strip">
                              {detail.snapshots.map((s) => (
                                <a
                                  href={'/api/snapshots/' + s.id}
                                  key={s.id}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  <img
                                    src={'/api/snapshots/' + s.id}
                                    alt={
                                      '事件截图 ' + timeFormat(s.captured_at)
                                    }
                                  />
                                </a>
                              ))}
                            </div>
                          )}
                        </>
                      ) : (
                        <Empty icon={ImageIcon} title="此事件没有可用截图">
                          终端未提供图像，或截图已超过保留期限。
                        </Empty>
                      )}
                    </section>
                    <section className="panel">
                      <PanelHeader
                        title="事件信息"
                        subtitle="发生、接收与风险等级"
                      />
                      <dl className="facts">
                        <div>
                          <dt>累计特殊状态</dt>
                          <dd>{detail.event.observed_frames} 帧</dd>
                        </div>
                        <div>
                          <dt>模型状态</dt>
                          <dd>
                            {detail.event.model_state === 'candidate'
                              ? '橙色候选'
                              : '红色确认'}
                          </dd>
                        </div>
                        <div>
                          <dt>发生时间</dt>
                          <dd>{timeFormat(detail.event.occurred_at)}</dd>
                        </div>
                        <div>
                          <dt>云端接收</dt>
                          <dd>{timeFormat(detail.event.received_at)}</dd>
                        </div>
                        <div>
                          <dt>最近更新</dt>
                          <dd>{timeFormat(detail.event.updated_at)}</dd>
                        </div>
                        <div>
                          <dt>确认人员</dt>
                          <dd>{detail.event.acknowledged_by || '尚未确认'}</dd>
                        </div>
                      </dl>
                      {!!detail.event.clock_warning && (
                        <div className="form-message">
                          设备时间待核查，请同时参考云端接收时间。
                        </div>
                      )}
                      <p className="detail-note">
                        {detail.event.summary ||
                          '请结合截图和现场情况进行人工核查。'}
                      </p>
                    </section>
                  </div>
                  <div className="detail-grid">
                    <section className="panel">
                      <PanelHeader
                        title="事件与升级记录"
                        subtitle="端侧与人工操作统一留痕"
                      />
                      <div className="timeline">
                        {detail.updates.map((u) => (
                          <div className="timeline-item" key={u.id}>
                            <span
                              className={'timeline-point level' + u.severity}
                            />
                            <div>
                              <b>
                                {{
                                  created: '特殊状态超过阈值',
                                  escalated: '风险程度升级',
                                  resolved: '端侧状态解除',
                                  interrupted: '端侧采集中断',
                                  ack: '工作人员确认',
                                  resolve: '处置完成',
                                  'request-intervention': '呼叫工作人员介入',
                                }[u.action] || u.action}
                              </b>
                              <span>
                                {timeFormat(u.received_at)} ·{' '}
                                {u.actor.startsWith('device:')
                                  ? '设备上报'
                                  : u.actor}
                              </span>
                              <p>
                                {parseJson(u.details_json)?.note ||
                                  `${u.observed_frames} 帧 · ${levels[u.severity]}`}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                    <section className="panel">
                      <PanelHeader
                        title="通知投递记录"
                        subtitle="服务接受与实际送达分开记录"
                      />
                      {detail.notifications.length ? (
                        <div className="delivery-list">
                          {detail.notifications.map((n) => (
                            <div key={n.id}>
                              <span className="delivery-icon">
                                {n.channel === 'email' ? (
                                  <Mail size={17} />
                                ) : (
                                  <Bell size={17} />
                                )}
                              </span>
                              <div>
                                <b>
                                  {n.channel === 'email'
                                    ? n.target
                                    : '手机 / 浏览器推送'}
                                </b>
                                <small>
                                  {n.last_error || timeFormat(n.updated_at)}
                                </small>
                              </div>
                              <Badge
                                type={
                                  n.status === 'accepted'
                                    ? 'green'
                                    : n.status === 'failed'
                                      ? 'red'
                                      : 'orange'
                                }
                              >
                                {
                                  {
                                    accepted: '服务已接受',
                                    pending: '等待重试',
                                    sending: '发送中',
                                    blocked: '待配置',
                                    failed: '未成功',
                                  }[n.status]
                                }
                              </Badge>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <Empty icon={Bell} title="暂无通知投递记录">
                          联调设备默认不向真实收件人发送消息。
                        </Empty>
                      )}
                    </section>
                  </div>
                </section>
              ) : (
                <section className="panel">
                  <div className="event-toolbar">
                    <div className="tabs">
                      {[
                        ['all', '全部'],
                        ['open', '待确认'],
                        ['intervention_requested', '需介入'],
                        ['resolved', '已处理'],
                      ].map(([key, label]) => (
                        <button
                          className={filter === key ? 'active' : ''}
                          key={key}
                          onClick={() => setFilter(key)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <label className="search">
                      <Search size={17} />
                      <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="搜索设备、位置或风险"
                      />
                    </label>
                  </div>
                  {shown.length ? (
                    <EventTable
                      events={shown}
                      onOpen={(id) => navigate('events', id)}
                    />
                  ) : (
                    <Empty icon={Activity} title="没有符合条件的事件">
                      试试调整筛选，或等待设备上报。
                    </Empty>
                  )}
                </section>
              )}
            </>
          )}

          {page === 'notifications' && (
            <>
              <div className="install-grid">
                <section className="panel install-card">
                  <span className="install-icon">
                    <Smartphone size={26} />
                  </span>
                  <Badge type="green">Android</Badge>
                  <h2>安卓告警 App</h2>
                  <p>
                    安装 APK，登录同一工作区并允许系统通知。设备告警与网页同步。
                  </p>
                  <a
                    className={
                      'button primary ' +
                      (!config?.android_ready ? 'disabled' : '')
                    }
                    href={
                      config?.android_ready
                        ? '/downloads/PoseGuard-Android.apk'
                        : undefined
                    }
                  >
                    <Download size={16} />
                    {config?.android_ready ? '下载安装 APK' : 'APK 正在构建'}
                  </a>
                  <small>登录后启用后台接收，可在常驻通知中停止</small>
                </section>
                <section className="panel install-card">
                  <span className="install-icon">
                    <ArrowUpRight size={26} />
                  </span>
                  <Badge>iPhone / iPad</Badge>
                  <h2>添加到主屏幕</h2>
                  <p>
                    在 Safari 打开此站点，点分享 →
                    添加到主屏幕，再从主屏幕打开并启用通知。
                  </p>
                  <Button icon={BellRing} onClick={subscribe}>
                    启用此设备通知
                  </Button>
                  <small>iOS / iPadOS 16.4 或更高版本</small>
                </section>
                <section className="panel install-card">
                  <span className="install-icon">
                    <Monitor size={26} />
                  </span>
                  <Badge>网页 / 桌面</Badge>
                  <h2>
                    {window.PoseGuardNative ? '本机后台告警' : '当前浏览器接收'}
                  </h2>
                  <p>
                    页面打开时显示实时预警弹窗，授权系统通知后也可接收后台提醒。
                  </p>
                  <Button icon={Bell} onClick={subscribe}>
                    {window.PoseGuardNative
                      ? notificationPermission === 'granted'
                        ? '本机接收已开启'
                        : '启用本机通知'
                      : notificationPermission === 'granted'
                        ? '当前浏览器已授权'
                        : '授权浏览器通知'}
                  </Button>
                  <small>
                    当前权限：
                    {
                      {
                        granted: '已允许',
                        default: '尚未授权',
                        denied: '已禁止',
                        unsupported: '浏览器不支持',
                      }[notificationPermission]
                    }
                  </small>
                </section>
              </div>
              <section className="panel">
                <PanelHeader
                  title="当前接收终端"
                  subtitle="每个接收端可选择接收全部设备或指定设备的通知"
                />
                {receivers.length ? (
                  <div className="receiver-list">
                    {receivers.map((r) => (
                      <div className="receiver" key={r.id}>
                        <span className="device-icon">
                          <Smartphone size={22} />
                        </span>
                        <div>
                          <b>{r.label}</b>
                          <small>
                            {r.user_name} ·{' '}
                            {r.last_error || receiverDeviceLabel(r, active)}
                          </small>
                        </div>
                        {r.can_manage && (
                          <Button
                            icon={Settings}
                            onClick={() =>
                              setModal({ type: 'receiver', receiver: r })
                            }
                          >
                            配置
                          </Button>
                        )}
                        <Badge type={r.last_error ? 'orange' : 'green'}>
                          {r.last_error ? '需处理' : '已绑定'}
                        </Badge>
                      </div>
                    ))}
                  </div>
                ) : (
                  <Empty
                    icon={Bell}
                    title="还没有通知接收端"
                    action={
                      <Button kind="primary" onClick={subscribe}>
                        启用本机通知
                      </Button>
                    }
                  >
                    完成授权后，这台手机或浏览器会列在这里。
                  </Empty>
                )}
              </section>
              <section className="panel">
                <PanelHeader
                  title="通知偏好"
                  subtitle="网页弹窗默认开启；系统通知受设备权限和勿扰设置影响"
                />
                <div className="preference-row">
                  <div>
                    <b>网页 / App 内提示音</b>
                    <p>当前页面打开时，对新的预警播放简短提示。</p>
                  </div>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={sound}
                      onChange={(e) => {
                        setSound(e.target.checked);
                        if (e.target.checked) {
                          alertAudio.current ||= new (window.AudioContext ||
                            window.webkitAudioContext)();
                          alertAudio.current.resume();
                        }
                      }}
                    />
                    <span />
                  </label>
                </div>
                <div className="preference-row">
                  <div>
                    <b>邮箱通知</b>
                    <p>{settings?.mail.recipients.join(' · ')}</p>
                  </div>
                  <Button icon={Settings} onClick={() => navigate('settings')}>
                    配置
                  </Button>
                </div>
              </section>
              {user.role === 'owner' && <Members notify={notify} />}
            </>
          )}

          {page === 'settings' && settings && (
            <SettingsPage
              settings={settings}
              user={user}
              notify={notify}
              reload={reload}
            />
          )}
          <footer className="page-footer">
            <span>
              <ShieldCheck size={14} /> PoseGuard · 视觉辅助预警，人工核查处置
            </span>
            <span>
              {new Intl.DateTimeFormat('zh-CN', {
                timeZone: 'Asia/Shanghai',
                dateStyle: 'long',
              }).format(new Date())}{' '}
              · UTC+8
            </span>
          </footer>
        </div>
      </main>
      <nav className="mobile-nav">
        {nav
          .filter(([key]) => key !== 'notifications')
          .map(([key, Icon, label]) => (
            <button
              key={key}
              onClick={() => navigate(key)}
              className={page === key ? 'active' : ''}
            >
              <Icon size={20} />
              <span>
                {label
                  .replace('工作区', '')
                  .replace('与绑定', '')
                  .replace('中心', '')
                  .replace('系统', '')}
              </span>
            </button>
          ))}
      </nav>
      {testNotice && (
        <Modal
          title={testNotice.title || '通知测试'}
          onClose={() => setTestNotice(null)}
        >
          <div className="modal-body">
            <Badge type="orange">测试消息</Badge>
            <p>{testNotice.body}</p>
            <Button kind="primary" onClick={() => setTestNotice(null)}>
              知道了
            </Button>
          </div>
        </Modal>
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
        </div>
      )}
      {modal?.type === 'receiver' && (
        <ReceiverModal
          receiver={modal.receiver}
          devices={active}
          onClose={() => setModal(null)}
          onSave={reload}
          notify={notify}
        />
      )}
      {modal === 'bind' && (
        <BindModal onClose={() => setModal(null)} notify={notify} />
      )}
      {modal?.type === 'device' && (
        <DeviceModal
          device={modal.device}
          user={user}
          onClose={() => setModal(null)}
          onSave={reload}
          notify={notify}
        />
      )}
      {['resolve', 'intervention'].includes(modal?.type) && (
        <ActionModal
          kind={modal.type}
          busy={busy}
          onClose={() => setModal(null)}
          onSubmit={(note) =>
            action(
              modal.id,
              modal.type === 'resolve' ? 'resolve' : 'request-intervention',
              note
            )
          }
        />
      )}
      {modal === 'profile' && (
        <Modal title="当前账号" onClose={() => setModal(null)}>
          <div className="modal-body">
            <p>
              {user.name} · {user.email}
            </p>
            <Button
              icon={LogOut}
              onClick={async () => {
                await api('/auth/logout', { method: 'POST', body: '{}' });
                setUser(null);
                setModal(null);
              }}
            >
              退出登录
            </Button>
          </div>
        </Modal>
      )}
      {urgent && (
        <Modal
          title={urgent.severity >= 3 ? '工作人员介入请求' : '新的设备预警'}
          onClose={() => setUrgent(null)}
        >
          <div className="modal-body urgent-modal">
            <span className={'large-risk level' + urgent.severity}>
              <BellRing size={31} />
            </span>
            <Badge type={'level' + urgent.severity}>
              {levels[urgent.severity]}
            </Badge>
            <h2>{riskName[urgent.risk_kind]}</h2>
            <p>
              {urgent.device_name} · 累计 {urgent.observed_frames} 帧特殊状态
            </p>
            <p className="muted">
              {urgent.model_state === 'candidate'
                ? '候选状态累计触发，请结合现场情况核查。'
                : '检测到持续特殊姿态，请工作人员及时关注。'}
            </p>
            <div className="modal-actions">
              <Button onClick={() => setUrgent(null)}>稍后查看</Button>
              <Button
                kind="primary"
                onClick={() => {
                  navigate('events', urgent.id);
                  setUrgent(null);
                }}
              >
                查看并处理 <ArrowRight size={16} />
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function receiverDeviceIds(receiver) {
  const ids = parseJson(receiver.device_ids_json);
  return Array.isArray(ids) ? ids : [];
}

function receiverDeviceLabel(receiver, devices) {
  const ids = receiverDeviceIds(receiver);
  if (!ids.length) return '全部设备';
  const selected = devices.filter((device) => ids.includes(device.id));
  return selected.length
    ? selected.map((device) => device.name).join('、')
    : '所选设备已解绑';
}

function ReceiverModal({ receiver, devices, onClose, onSave, notify }) {
  const [ids, setIds] = useState(() => receiverDeviceIds(receiver));
  const [all, setAll] = useState(() => !receiverDeviceIds(receiver).length);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const selected = ids.filter((id) =>
    devices.some((device) => device.id === id)
  );
  const route = '/push-subscriptions/' + encodeURIComponent(receiver.id);
  async function perform(action) {
    setBusy(true);
    try {
      if (action === 'test') {
        const prefix =
          receiver.channel === 'android'
            ? '/native-receivers/'
            : '/push-subscriptions/';
        await api(prefix + encodeURIComponent(receiver.id) + '/test', {
          method: 'POST',
          body: '{}',
        });
        notify('测试通知已提交，请在接收端确认');
      } else if (action === 'remove') {
        await api(route, { method: 'DELETE' });
        notify('已解除接收端');
        onClose();
        await onSave();
      } else {
        await api(route, {
          method: 'PUT',
          body: JSON.stringify({ device_ids: all ? [] : selected }),
        });
        notify('已更新接收范围');
        onClose();
        await onSave();
      }
    } catch (error) {
      notify(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={receiver.label} onClose={onClose}>
      <div className="modal-body">
        <fieldset className="receiver-scope">
          <legend>接收哪些设备的通知</legend>
          <label>
            <input
              type="checkbox"
              checked={all}
              onChange={(e) => setAll(e.target.checked)}
            />{' '}
            全部设备（含之后绑定的设备）
          </label>
          {!all &&
            devices.map((device) => (
              <label key={device.id}>
                <input
                  type="checkbox"
                  checked={ids.includes(device.id)}
                  onChange={(e) =>
                    setIds(
                      e.target.checked
                        ? [...ids, device.id]
                        : ids.filter((id) => id !== device.id)
                    )
                  }
                />
                {device.name}
              </label>
            ))}
        </fieldset>
        <div className="receiver-actions">
          <Button
            kind="primary"
            disabled={busy || (!all && !selected.length)}
            onClick={() => perform('save')}
          >
            保存
          </Button>
          <Button disabled={busy} onClick={() => perform('test')}>
            测试通知
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              confirmRemove ? perform('remove') : setConfirmRemove(true)
            }
          >
            {confirmRemove ? '确认解除' : '解除接收端'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Metric({ title, value, suffix, icon: Icon, note, type = '' }) {
  return (
    <section className="metric">
      <div>
        <span>{title}</span>
        <Icon size={19} />
      </div>
      <strong className={type}>
        {value}
        {suffix && <small>{suffix}</small>}
      </strong>
      <p>
        <span className="tiny-dot" />
        {note}
      </p>
    </section>
  );
}
function PanelHeader({ title, subtitle, action }) {
  return (
    <header className="panel-header">
      <div>
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {action}
    </header>
  );
}
function Workflow({ icon: Icon, n, title, text }) {
  return (
    <div className="workflow-step">
      <span>
        <Icon size={19} />
      </span>
      <div>
        <small>{n}</small>
        <h3>{title}</h3>
        <p>{text}</p>
      </div>
    </div>
  );
}
function DeviceCard({ device: d, onOpen }) {
  return (
    <button className="device-card" onClick={onOpen}>
      <div className="device-card-top">
        <span className={'device-icon ' + d.platform}>
          <PlatformIcon platform={d.platform} />
        </span>
        <Badge type={d.online ? 'green' : 'quiet'}>
          <span className={'status-dot ' + (!d.online ? 'off' : '')} />
          {d.online ? '在线' : '离线'}
        </Badge>
      </div>
      <h3>{d.name}</h3>
      <p>
        {platformName[d.platform]} {d.is_test ? '· 联调设备' : ''}
      </p>
      <div className="device-card-data">
        <span>
          <Activity size={13} />
          {d.health.fps == null ? '—' : d.health.fps.toFixed(1) + ' FPS'}
        </span>
        <span>{d.health.outbox_pending || 0} 条待同步</span>
      </div>
      <div className="device-card-bottom">
        <span>{d.location || '未设置位置'}</span>
        <small>{ago(d.last_seen)}</small>
      </div>
    </button>
  );
}
function EventTable({ events, onOpen }) {
  return (
    <div className="event-table">
      <div className="event-table-head">
        <span>风险事件 / 设备</span>
        <span>风险程度</span>
        <span>发生时间</span>
        <span>状态</span>
        <span />
      </div>
      {events.map((e) => (
        <button className="event-row" key={e.id} onClick={() => onOpen(e.id)}>
          <div className="event-primary">
            <span className={'event-symbol level' + e.severity}>
              {e.severity >= 3 ? (
                <BellRing size={19} />
              ) : (
                <TriangleAlert size={19} />
              )}
            </span>
            <div>
              <b>{riskName[e.risk_kind]}</b>
              <small>
                {e.device_name} · {platformName[e.platform]} ·{' '}
                {e.observed_frames} 帧
              </small>
            </div>
          </div>
          <span>
            <Badge type={'level' + e.severity}>{levels[e.severity]}</Badge>
          </span>
          <span className="event-time">
            {timeFormat(e.occurred_at)}
            {e.clock_warning ? <small>设备时间待核查</small> : null}
          </span>
          <span className="event-state">{stateName[e.status]}</span>
          <ChevronRight size={17} />
        </button>
      ))}
    </div>
  );
}
function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function BindModal({ onClose, notify }) {
  const [name, setName] = useState('');
  const [platform, setPlatform] = useState('rk3566');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState('');
  async function create(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const value = await api('/enrollments', {
        method: 'POST',
        body: JSON.stringify({ name, platform }),
      });
      setResult(value);
      setQr(
        await QRCode.toDataURL(value.pairing_uri, { width: 200, margin: 1 })
      );
    } catch (error) {
      notify(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="绑定监测设备" onClose={onClose}>
      <div className="modal-body">
        {result ? (
          <>
            <div className="pairing-result">
              <img src={qr} alt="设备绑定二维码" />
              <div>
                <Badge type="green">一次性绑定码</Badge>
                <div className="pairing-code">{result.code}</div>
                <p>
                  平台：{platformName[result.platform]}
                  <br />
                  有效期至 {timeFormat(result.expires_at)}
                </p>
                <Button
                  icon={Copy}
                  onClick={() => {
                    navigator.clipboard.writeText(result.code);
                    notify('绑定码已复制');
                  }}
                >
                  复制绑定码
                </Button>
              </div>
            </div>
            <div className="instruction">
              <b>在对应设备的接入程序中填写</b>
              <p>服务地址：{result.server_url}</p>
              <p>
                绑定成功后，设备会出现在列表中。设备密钥只在绑定时返回，由终端保存在本地。
              </p>
            </div>
            <div className="modal-actions">
              <Button kind="primary" onClick={onClose}>
                完成
              </Button>
            </div>
          </>
        ) : (
          <form onSubmit={create} className="form-grid">
            <label>
              设备名称
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                placeholder="例如：大厅 01 / RK3566"
                required
              />
            </label>
            <label>
              终端平台
              <select
                value={platform}
                onChange={(e) => setPlatform(e.target.value)}
              >
                {['windows', 'rk3566', 'maixcam', 'esp32s3'].map((p) => (
                  <option key={p} value={p}>
                    {platformName[p]}
                  </option>
                ))}
              </select>
            </label>
            <div className="instruction">
              <Link size={18} />
              <p>
                每台监测终端使用独立密钥。手机接收端在“通知与成员”中启用通知。
              </p>
            </div>
            <div className="modal-actions">
              <Button onClick={onClose}>取消</Button>
              <Button type="submit" kind="primary" busy={busy}>
                生成绑定码
              </Button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}
function DeviceModal({ device, user, onClose, onSave, notify }) {
  const [name, setName] = useState(device.name);
  const [location, setLocation] = useState(device.location);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="设备详情" onClose={onClose}>
      <div className="modal-body">
        <div className="device-modal-title">
          <span className="device-icon">
            <PlatformIcon platform={device.platform} />
          </span>
          <div>
            <h3>{device.name}</h3>
            <p>
              {platformName[device.platform]} ·{' '}
              {device.online ? '在线' : '离线'}
            </p>
          </div>
        </div>
        <dl className="facts">
          <div>
            <dt>最近心跳</dt>
            <dd>{timeFormat(device.last_seen)}</dd>
          </div>
          <div>
            <dt>运行版本</dt>
            <dd>{device.health.firmware || '—'}</dd>
          </div>
          <div>
            <dt>输入状态</dt>
            <dd>{device.health.mode || '—'}</dd>
          </div>
          <div>
            <dt>待同步队列</dt>
            <dd>{device.health.outbox_pending || 0}</dd>
          </div>
        </dl>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await api('/devices/' + device.id, {
                method: 'PATCH',
                body: JSON.stringify({ name, location }),
              });
              notify('设备设置已同步');
              onSave();
              onClose();
            } catch (error) {
              notify(error.message);
            } finally {
              setBusy(false);
            }
          }}
          className="form-grid"
        >
          <label>
            设备名称
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              disabled={user.role !== 'owner'}
            />
          </label>
          <label>
            设备位置
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="填写安装位置"
              disabled={user.role !== 'owner'}
            />
          </label>
          {device.health.last_error && (
            <div className="form-message">{device.health.last_error}</div>
          )}
          {user.role === 'owner' && (
            <div className="modal-actions">
              <Button
                kind="danger-outline"
                onClick={async () => {
                  if (
                    !confirm('解除绑定会撤销此设备密钥，历史事件将保留。继续？')
                  )
                    return;
                  await api('/devices/' + device.id, { method: 'DELETE' });
                  notify('设备已解除绑定');
                  onSave();
                  onClose();
                }}
              >
                解除绑定
              </Button>
              <Button type="submit" kind="primary" busy={busy}>
                保存设备信息
              </Button>
            </div>
          )}
        </form>
      </div>
    </Modal>
  );
}
function ActionModal({ kind, busy, onClose, onSubmit }) {
  const [note, setNote] = useState('');
  return (
    <Modal
      title={kind === 'resolve' ? '记录处置结果' : '呼叫工作人员介入'}
      onClose={onClose}
    >
      <form
        className="modal-body form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(note);
        }}
      >
        <p>
          {kind === 'resolve'
            ? '处置结果会同步到网页和 App，并写入事件时间线。'
            : '该操作会提升事件程度，向接收终端和邮箱发出介入通知，并同步给端侧记录。'}
        </p>
        <label>
          {kind === 'resolve' ? '处置结果' : '介入说明'}
          <textarea
            rows={4}
            maxLength={300}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            required={kind === 'resolve'}
            placeholder={
              kind === 'resolve'
                ? '例如：现场核查完成，已提醒当事人。'
                : '例如：需要工作人员到现场协助核查。'
            }
          />
        </label>
        <div className="modal-actions">
          <Button onClick={onClose}>取消</Button>
          <Button
            type="submit"
            kind={kind === 'resolve' ? 'primary' : 'danger'}
            busy={busy}
          >
            确认{kind === 'resolve' ? '完成处置' : '请求介入'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function Members({ notify }) {
  const [users, setUsers] = useState([]);
  const [mail, setMail] = useState('');
  const [name, setName] = useState('');
  const [link, setLink] = useState('');
  useEffect(() => {
    api('/users')
      .then((r) => setUsers(r.users))
      .catch(() => {});
  }, []);
  return (
    <section className="panel">
      <PanelHeader
        title="管理成员"
        subtitle="收件邮箱与管理账号分别设置；成员可登录查看截图和处置事件"
      />
      <div className="member-list">
        {users.map((u) => (
          <div key={u.id}>
            <span className="avatar">{u.name.slice(0, 1)}</span>
            <div>
              <b>{u.name}</b>
              <small>{u.email}</small>
            </div>
            <Badge>{u.role === 'owner' ? '管理员' : '工作人员'}</Badge>
          </div>
        ))}
      </div>
      <form
        className="invite-form"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const result = await api('/users/invite', {
              method: 'POST',
              body: JSON.stringify({ email: mail, name }),
            });
            setLink(result.url);
            notify('邀请链接已创建，24 小时有效');
          } catch (error) {
            notify(error.message);
          }
        }}
      >
        <input
          placeholder="工作人员姓名"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="工作人员姓名"
        />
        <input
          placeholder="工作人员邮箱"
          type="email"
          value={mail}
          onChange={(e) => setMail(e.target.value)}
          required
          aria-label="工作人员邮箱"
        />
        <Button type="submit" icon={Plus}>
          生成邀请链接
        </Button>
      </form>
      {link && (
        <div className="copy-link">
          <input readOnly value={link} />
          <Button
            icon={Copy}
            onClick={() => {
              navigator.clipboard.writeText(link);
              notify('邀请链接已复制');
            }}
          >
            复制
          </Button>
        </div>
      )}
    </section>
  );
}

function SettingsPage({ settings, user, notify, reload }) {
  const [rules, setRules] = useState(settings.rules);
  const [mail, setMail] = useState({ ...settings.mail, password: '' });
  const [recipients, setRecipients] = useState(
    settings.mail.recipients.join('\n')
  );
  const [saving, setSaving] = useState('');
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  useEffect(() => {
    setRules(settings.rules);
    setMail({ ...settings.mail, password: '' });
    setRecipients(settings.mail.recipients.join('\n'));
  }, [settings]);
  const owner = user.role === 'owner';
  async function save(kind) {
    setSaving(kind);
    try {
      const input =
        kind === 'rules'
          ? { rules }
          : {
              mail: {
                ...mail,
                recipients: recipients.split(/[\s,;，；]+/).filter(Boolean),
              },
            };
      await api('/settings', { method: 'PUT', body: JSON.stringify(input) });
      notify(
        kind === 'rules' ? '规则已保存，设备心跳时同步' : '发信设置已保存'
      );
      reload();
    } catch (e) {
      notify(e.message);
    } finally {
      setSaving('');
    }
  }
  return (
    <>
      <section className="panel settings-panel">
        <PanelHeader
          title="累计上报与风险升级"
          subtitle="各平台使用相同规则；帧数按实际完成推理的帧累计"
        />
        <div className="settings-body">
          <div className="settings-fields">
            <label>
              首次上报：累计超过
              <input
                type="number"
                min={1}
                max={1000000}
                value={rules.frame_threshold}
                disabled={!owner}
                onChange={(e) =>
                  setRules({
                    ...rules,
                    frame_threshold: Number(e.target.value),
                  })
                }
              />
              <small>
                当前第 {Number(rules.frame_threshold) + 1} 帧首次上报
              </small>
            </label>
            <label>
              持续风险升级：累计超过
              <input
                type="number"
                min={rules.frame_threshold + 1}
                value={rules.escalation_threshold}
                disabled={!owner}
                onChange={(e) =>
                  setRules({
                    ...rules,
                    escalation_threshold: Number(e.target.value),
                  })
                }
              />
              <small>有红色确认状态时可升级为紧急介入</small>
            </label>
            <label>
              正常间隔复位（秒）
              <input
                type="number"
                min={0.5}
                max={30}
                step={0.5}
                value={rules.clear_grace_seconds}
                disabled={!owner}
                onChange={(e) =>
                  setRules({
                    ...rules,
                    clear_grace_seconds: Number(e.target.value),
                  })
                }
              />
              <small>同一设备、同一轨迹、同一风险分别累计</small>
            </label>
            <label>
              截图保留天数
              <input
                type="number"
                min={1}
                max={30}
                value={rules.retention_days}
                disabled={!owner}
                onChange={(e) =>
                  setRules({ ...rules, retention_days: Number(e.target.value) })
                }
              />
              <small>自动清理过期截图，保留事件处置记录</small>
            </label>
          </div>
          <label className="checkbox-line">
            <input
              type="checkbox"
              checked={rules.include_candidates}
              disabled={!owner}
              onChange={(e) =>
                setRules({ ...rules, include_candidates: e.target.checked })
              }
            />
            <span>
              橙色候选也计入累计
              <small>
                候选与红色确认保持不同风险等级，截图和升级独立记录。
              </small>
            </span>
          </label>
          <div className="settings-footer">
            <span>端侧先保留本地记录，超过阈值再上报。</span>
            <Button
              kind="primary"
              disabled={!owner}
              busy={saving === 'rules'}
              onClick={() => save('rules')}
            >
              保存累计规则
            </Button>
          </div>
        </div>
      </section>
      <section className="panel settings-panel">
        <PanelHeader
          title="邮箱通知"
          subtitle="使用你指定的 Gmail 发件账号；登录信息只由管理员设置"
          action={
            <Badge
              type={mail.enabled && mail.password_set ? 'green' : 'orange'}
            >
              {mail.enabled && mail.password_set ? '已配置' : '待完成邮箱授权'}
            </Badge>
          }
        />
        <div className="settings-body">
          <div className="settings-fields">
            <label>
              发件邮箱
              <input
                type="email"
                value={mail.from}
                disabled={!owner}
                onChange={(e) => setMail({ ...mail, from: e.target.value })}
              />
            </label>
            <label>
              SMTP 登录账号
              <input
                type="email"
                value={mail.username}
                disabled={!owner}
                onChange={(e) => setMail({ ...mail, username: e.target.value })}
              />
              <small>
                若发件地址是已验证别名，填写有发送权限的 Gmail 登录账号。
              </small>
            </label>
            <label>
              SMTP 服务器
              <input
                value={mail.host}
                disabled={!owner}
                onChange={(e) => setMail({ ...mail, host: e.target.value })}
              />
            </label>
            <label>
              加密端口
              <select
                value={mail.port}
                disabled={!owner}
                onChange={(e) =>
                  setMail({ ...mail, port: Number(e.target.value) })
                }
              >
                <option value={465}>465 · TLS</option>
                <option value={587}>587 · STARTTLS</option>
              </select>
            </label>
            <label className="span-two">
              Gmail 应用专用密码
              <input
                type="password"
                autoComplete="new-password"
                value={mail.password}
                disabled={!owner}
                onChange={(e) => setMail({ ...mail, password: e.target.value })}
                placeholder={
                  mail.password_set
                    ? '已设置；留空保留原授权码'
                    : '填写 Gmail 应用专用密码'
                }
              />
              <small>
                在 Gmail / Google 账号中创建应用专用密码；发件别名应已在 Gmail
                中获得授权。
              </small>
            </label>
            <label className="span-two">
              告警收件人
              <textarea
                value={recipients}
                rows={4}
                disabled={!owner}
                onChange={(e) => setRecipients(e.target.value)}
              />
              <small>
                多个邮箱以换行或逗号分隔，可在网页和 App 中随时增删。
              </small>
            </label>
          </div>
          <label className="checkbox-line">
            <input
              type="checkbox"
              checked={mail.enabled}
              disabled={!owner}
              onChange={(e) => setMail({ ...mail, enabled: e.target.checked })}
            />
            启用自动邮箱通知
          </label>
          <div className="settings-footer">
            <span>邮件状态“服务已接受”表示发信服务接受了请求。</span>
            <div className="inline">
              <Button
                icon={Mail}
                disabled={!owner || !mail.password_set || !mail.enabled}
                busy={saving === 'test'}
                onClick={async () => {
                  setSaving('test');
                  try {
                    const result = await api('/settings/test-email', {
                      method: 'POST',
                      body: JSON.stringify({ to: settings.mail.recipients[0] }),
                    });
                    notify(result.message);
                  } catch (e) {
                    notify(e.message);
                  } finally {
                    setSaving('');
                  }
                }}
              >
                发送测试邮件
              </Button>
              <Button
                kind="primary"
                disabled={!owner}
                busy={saving === 'mail'}
                onClick={() => save('mail')}
              >
                保存发信设置
              </Button>
            </div>
          </div>
        </div>
      </section>
      <section className="panel settings-panel">
        <PanelHeader
          title="修改登录口令"
          subtitle="修改后，其他已登录会话将失效"
        />
        <form
          className="settings-body"
          onSubmit={async (e) => {
            e.preventDefault();
            setSaving('password');
            try {
              await api('/auth/password', {
                method: 'POST',
                body: JSON.stringify({
                  current_password: oldPassword,
                  password: newPassword,
                }),
              });
              setOldPassword('');
              setNewPassword('');
              notify('登录口令已更新');
            } catch (error) {
              notify(error.message);
            } finally {
              setSaving('');
            }
          }}
        >
          <div className="settings-fields">
            <label>
              当前口令
              <input
                type="password"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </label>
            <label>
              新口令
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                minLength={12}
                required
                autoComplete="new-password"
              />
              <small>至少 12 位</small>
            </label>
          </div>
          <div className="settings-footer">
            <span>登录口令与设备密钥分开管理。</span>
            <Button type="submit" kind="primary" busy={saving === 'password'}>
              更新口令
            </Button>
          </div>
        </form>
      </section>
    </>
  );
}

createRoot(document.getElementById('root')).render(<App />);
