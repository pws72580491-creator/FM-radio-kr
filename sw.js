/* ════════════════════════════════════════
   KOREA FM 라디오 — Service Worker
   전략:
   - JS/CSS/HTML : Network First (항상 최신 코드)
   - 폰트/이미지  : Cache First (빠른 로딩)
   - 오디오 스트림: 캐시 제외 (항상 라이브)
════════════════════════════════════════ */
const CACHE_NAME  = 'kr-radio-v2.1.2';
const CACHE_SHELL = [
  './',
  './index.html',
  
  
  
  
  
  
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

/* ── 설치: 앱 셸 사전 캐싱 ── */
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(CACHE_SHELL))
      .then(() => self.skipWaiting())
  );
});

/* ── 활성화: 이전 캐시 정리 ── */
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

/* ── fetch 전략 ── */
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // 오디오 스트림, Firebase, CDN 라이브러리 → 캐시 완전 제외 (항상 네트워크)
  if (
    url.hostname.includes('febc.net')       ||
    url.hostname.includes('bsod.kr')        ||
    url.hostname.includes('ebs.co.kr')      ||
    url.hostname.includes('firebase')       ||
    url.hostname.includes('gstatic.com')    ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('cdnjs.cloudflare.com') ||
    url.pathname.endsWith('.m3u8')          ||
    url.pathname.endsWith('.ts')
  ) {
    e.respondWith(fetch(e.request));
    return;
  }

  // 폰트 → Cache First (변경 없음)
  if (url.hostname.includes('fonts.gstatic.com')) {
    e.respondWith(
      caches.match(e.request).then(cached =>
        cached || fetch(e.request).then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          return res;
        })
      )
    );
    return;
  }

  // 앱 셸(JS/CSS/HTML/이미지) → Network First, 실패 시 캐시 폴백
  e.respondWith(
    fetch(e.request)
      .then(res => {
        // 정상 응답이면 캐시 갱신
        if (res && res.status === 200 && res.type !== 'opaque') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

/* ── 백그라운드 동기화 메시지 처리 ── */
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
