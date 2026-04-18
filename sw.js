/* ══════════════════════════════════════════
   KOREA FM 라디오 – Service Worker v4
   개선사항:
   · index.html → Network First (항상 최신 버전)
   · 앱 셸(JS·CSS·폰트) → Stale-while-revalidate
   · 스트림·Firebase → 항상 네트워크 (캐싱 금지)
   · install 시 외부 CDN 제외 → 설치 실패 방지
══════════════════════════════════════════ */
const CACHE_NAME    = 'kr-radio-v4';
const CACHE_STATIC  = 'kr-radio-static-v4';

/* 설치 시 캐싱할 로컬 앱 셸만 포함 (외부 CDN 제외) */
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
];

/* ── 설치 ── */
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

/* ── 활성화: 구버전 캐시 삭제 ── */
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

/* ── 요청 분류 ── */
function isStream(url) {
  return (
    url.includes('/stream')          ||
    url.includes('.m3u8')            ||
    url.includes('.ts')              ||
    url.includes('firebasedatabase') ||
    url.includes('gstatic.com/firebasejs') ||
    url.includes('googleapis.com/firebase')
  );
}

function isAppShell(url) {
  return (
    url.endsWith('/') ||
    url.includes('index.html') ||
    url.includes('manifest.json')
  );
}

function isStaticAsset(url) {
  return (
    url.includes('fonts.googleapis.com') ||
    url.includes('fonts.gstatic.com')    ||
    url.includes('cdnjs.cloudflare.com') ||
    url.match(/\.(js|css|png|ico|svg|woff2?)(\?|$)/)
  );
}

/* ── 패치 전략 ── */
self.addEventListener('fetch', e => {
  const url = e.request.url;

  /* 1. 스트림·Firebase → 항상 네트워크, 캐싱 없음 */
  if (isStream(url)) {
    e.respondWith(fetch(e.request));
    return;
  }

  /* 2. index.html·manifest → Network First
        네트워크 실패 시에만 캐시 폴백 (항상 최신 버전 보장) */
  if (isAppShell(url)) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(e.request)
          .then(cached => cached || caches.match('./index.html'))
        )
    );
    return;
  }

  /* 3. 외부 정적 자산(폰트·hls.js) → Stale-while-revalidate
        캐시를 즉시 반환하고 백그라운드에서 업데이트 */
  if (isStaticAsset(url)) {
    e.respondWith(
      caches.open(CACHE_STATIC).then(cache =>
        cache.match(e.request).then(cached => {
          const fetchPromise = fetch(e.request).then(res => {
            if (res && res.status === 200) {
              cache.put(e.request, res.clone());
            }
            return res;
          }).catch(() => cached);
          return cached || fetchPromise;
        })
      )
    );
    return;
  }

  /* 4. 그 외 → Cache First, 없으면 네트워크 */
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
