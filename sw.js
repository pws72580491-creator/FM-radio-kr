/* ══════════════════════════════════════════
   KOREA FM 라디오 – Service Worker v3
   GitHub Pages 배포용
══════════════════════════════════════════ */
const CACHE  = 'kr-radio-v3';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Noto+Sans+KR:wght@300;400;500;700&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.4.12/hls.min.js',
];

/* 설치 */
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

/* 활성화: 이전 캐시 삭제 */
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* 패치 전략 */
self.addEventListener('fetch', e => {
  const url = e.request.url;

  /* 스트림·API·Firebase → 항상 네트워크 */
  if (
    url.includes('/stream') ||
    url.includes('.m3u8')   ||
    url.includes('.ts')     ||
    url.includes('firebasedatabase') ||
    url.includes('gstatic.com/firebasejs') ||
    url.includes('googleapis.com/firebase')
  ) {
    e.respondWith(fetch(e.request));
    return;
  }

  /* 앱 셸 → Cache First, 없으면 네트워크 후 캐시 저장 */
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res && res.status === 200 && res.type !== 'opaque') {
          caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        }
        return res;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
