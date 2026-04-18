/* ════════════════════════════════════════
   KOREA FM 라디오 — Service Worker v5
   · index.html       → Network First (항상 최신)
   · 앱 셸(JS·CSS·폰트) → Stale-while-revalidate
   · 스트림·Firebase   → 항상 네트워크 (캐싱 금지)
════════════════════════════════════════ */
const CACHE_NAME   = 'kr-radio-v5';
const CACHE_STATIC = 'kr-radio-static-v5';

const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
];

/* 설치 */
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

/* 활성화: 구버전 캐시 삭제 */
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== CACHE_STATIC)
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* 요청 분류 */
function isStream(url) {
  return url.includes('/stream') || url.includes('.m3u8') ||
         url.includes('.ts')     || url.includes('firebasedatabase') ||
         url.includes('gstatic.com/firebasejs') || url.includes('googleapis.com/firebase');
}
function isAppShell(url) {
  return url.endsWith('/') || url.includes('index.html') || url.includes('manifest.json');
}
function isStaticAsset(url) {
  return url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com') ||
         url.includes('cdnjs.cloudflare.com') || /\.(js|css|png|ico|svg|woff2?)(\?|$)/.test(url);
}

/* fetch 전략 */
self.addEventListener('fetch', e => {
  const url = e.request.url;

  /* 1. 스트림·Firebase → 네트워크만 */
  if (isStream(url)) {
    e.respondWith(fetch(e.request));
    return;
  }

  /* 2. index.html·manifest → Network First */
  if (isAppShell(url)) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res && res.status === 200) {
            caches.open(CACHE_NAME).then(c => c.put(e.request, res.clone()));
          }
          return res;
        })
        .catch(() => caches.match(e.request)
          .then(cached => cached || caches.match('./index.html'))
        )
    );
    return;
  }

  /* 3. 폰트·hls.js → Stale-while-revalidate */
  if (isStaticAsset(url)) {
    e.respondWith(
      caches.open(CACHE_STATIC).then(cache =>
        cache.match(e.request).then(cached => {
          const fetchPromise = fetch(e.request).then(res => {
            if (res && res.status === 200) cache.put(e.request, res.clone());
            return res;
          }).catch(() => cached);
          return cached || fetchPromise;
        })
      )
    );
    return;
  }

  /* 4. 그 외 → Cache First */
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res && res.status === 200 && res.type !== 'opaque') {
          caches.open(CACHE_NAME).then(c => c.put(e.request, res.clone()));
        }
        return res;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
