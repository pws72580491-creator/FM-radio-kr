const CACHE_NAME = 'grateful-v4';

const CACHE_FILES = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './firebase-init.js',
  './manifest.json',
  './apple-touch-icon.png',
  './favicon.png',
  './icons/icon-192x192.png',
  './icons/icon-512x512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(CACHE_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => e.waitUntil(
  caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
));

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // 페이지 자신 → Cache-First + 백그라운드 갱신
  if (e.request.mode === 'navigate') {
    e.respondWith(
      caches.match(e.request).then(cached => {
        const network = fetch(e.request).then(res => {
          if (res && res.ok) caches.open(CACHE_NAME).then(c => c.put(e.request, res.clone()));
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
    return;
  }
  // 폰트 → Cache-First
  if (url.hostname.includes('fonts.gstatic.com') || url.hostname.includes('fonts.googleapis.com')) {
    e.respondWith(
      caches.match(e.request).then(cached => cached ||
        fetch(e.request, { mode: 'no-cors' }).then(res => {
          caches.open(CACHE_NAME).then(c => c.put(e.request, res.clone()));
          return res;
        }).catch(() => new Response('', { status: 408 }))
      )
    );
  }
  // Firebase, gstatic (SDK), Anthropic → 기본 네트워크
});

let _swTimer = null, _swSchedule = null;

function _msUntil(h, m) {
  const now = new Date(), t = new Date(now);
  t.setHours(h, m, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return t - now;
}

async function _fireReminder() {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  let hasRecord = false;
  if (clients.length > 0) {
    hasRecord = await new Promise(res => {
      const mc = new MessageChannel();
      mc.port1.onmessage = e => res(!!e.data?.hasRecord);
      clients[0].postMessage({ type: 'CHECK_TODAY' }, [mc.port2]);
      setTimeout(() => res(false), 2000);
    });
  }
  if (!hasRecord) {
    await self.registration.showNotification('오늘의 감사를 기록해 보세요 🌿', {
      body: '하루의 따뜻한 순간들을 기억해요 ✦',
      icon: 'data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 192 192%27%3E%3Crect width=%27192%27 height=%27192%27 rx=%2744%27 fill=%27%23f9f5ef%27/%3E%3Ctext x=%2796%27 y=%27136%27 text-anchor=%27middle%27 font-size=%27110%27%3E%F0%9F%8C%BF%3C/text%3E%3C/svg%3E',
      badge: 'data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 96 96%27%3E%3Crect width=%2796%27 height=%2796%27 rx=%2722%27 fill=%27%23c17a52%27/%3E%3Ctext x=%2748%27 y=%2768%27 text-anchor=%27middle%27 font-size=%2756%27 fill=%27white%27%3E%E2%9C%A6%3C/text%3E%3C/svg%3E',
      tag: 'grateful-reminder',
      vibrate: [200, 100, 200],
    });
  }
  _scheduleSW(_swSchedule);
}

function _scheduleSW(s) {
  clearTimeout(_swTimer); _swTimer = null; _swSchedule = s;
  if (!s || !s.on || !s.time) return;
  const parts = s.time.split(':').map(Number);
  _swTimer = setTimeout(() => _fireReminder(), _msUntil(parts[0], parts[1]));
}

self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type === 'SET_REMINDER')    _scheduleSW(d.schedule);
  if (d.type === 'CANCEL_REMINDER') { clearTimeout(_swTimer); _swTimer = null; }
  if (d.type === 'TEST_REMINDER') {
    self.registration.showNotification('테스트 알림 🌿', {
      body: '백그라운드 알림이 정상 작동해요 ✦', tag: 'grateful-test',
    });
  }
  if (d.type === 'CACHE_URL' && d.url) {
    caches.open(CACHE_NAME).then(cache =>
      fetch(d.url).then(res => { if (res.ok) cache.put(d.url, res); }).catch(() => {})
    );
  }
});

self.addEventListener('push', e => {
  const d = e.data ? (e.data.json ? e.data.json() : {}) : {};
  e.waitUntil(self.registration.showNotification(
    d.title || '오늘의 감사를 기록해 보세요 🌿',
    { body: d.body || '하루의 따뜻한 순간들을 기억해요 ✦', tag: 'grateful-push' }
  ));
});

self.addEventListener('periodicsync', e => {
  if (e.tag === 'grateful-daily-reminder') e.waitUntil(_fireReminder());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const w = list.find(c => 'focus' in c);
      return w ? w.focus() : self.clients.openWindow(self.location.origin + self.location.pathname);
    })
  );
});