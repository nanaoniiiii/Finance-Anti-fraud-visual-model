const CACHE = 'poseguard-shell-v1';
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(['/', '/icon.svg', '/manifest.webmanifest']))
  );
});
self.addEventListener('activate', (event) =>
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
          )
        ),
    ])
  )
);
self.addEventListener('fetch', (event) => {
  const u = new URL(event.request.url);
  if (
    event.request.method !== 'GET' ||
    u.origin !== location.origin ||
    u.pathname.startsWith('/api/') ||
    u.pathname.startsWith('/.well-known/')
  )
    return;
  if (event.request.mode === 'navigate')
    event.respondWith(fetch(event.request).catch(() => caches.match('/')));
  else if (u.pathname.startsWith('/assets/'))
    event.respondWith(
      caches.open(CACHE).then(async (c) => {
        const old = await c.match(event.request);
        if (old) return old;
        const response = await fetch(event.request);
        if (response.ok) c.put(event.request, response.clone());
        return response;
      })
    );
});
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data?.json() || {};
  } catch {}
  const title = data.title || 'PoseGuard 设备预警';
  const options = {
    body: data.body || '有新的设备事件，请解锁查看。',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.event_id ? 'pg-' + data.event_id : 'pg-system',
    renotify: true,
    requireInteraction: (data.severity || 1) >= 2,
    data: { url: data.url || '/', event_id: data.event_id },
    timestamp: data.timestamp || Date.now(),
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(
    event.notification.data?.url || '/',
    self.location.origin
  );
  if (url.origin !== self.location.origin) return;
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(async (clients) => {
        for (const client of clients) {
          if ('navigate' in client) await client.navigate(url.href);
          if ('focus' in client) return client.focus();
        }
        return self.clients.openWindow(url.href);
      })
  );
});
