/* KOREA FM 라디오 — Service Worker */
// ★ index.html이 sw.js?v=타임스탬프 로 등록하므로
//    이 파일 자체는 버전 관리 불필요 — 배포마다 자동으로 새 SW로 인식됨
const CACHE = 'kr-radio-cache-v1';
const SHELL = ['/'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting()) // 새 SW 즉시 활성화 대기
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(
        ks.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim()) // 열린 탭 즉시 제어
  );
});

self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);

  // 스트리밍/외부 리소스는 캐시 없이 네트워크 직접 사용
  const passThrough = [
    'febc.net', 'bsod.kr', 'ebs.co.kr',
    'firebase', 'gstatic.com', 'googleapis.com',
    'cdnjs.cloudflare.com'
  ].some(h => u.hostname.includes(h)) ||
  ['.m3u8', '.ts'].some(x => u.pathname.endsWith(x));

  if (passThrough) {
    e.respondWith(fetch(e.request));
    return;
  }

  // 네트워크 우선 — 성공 시 캐시 갱신, 실패 시 캐시 fallback
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }).then(r => {
      if (r && r.status === 200 && r.type !== 'opaque') {
        const c = r.clone();
        caches.open(CACHE).then(ca => ca.put(e.request, c));
      }
      return r;
    }).catch(() => caches.match(e.request))
  );
});

// index.html에서 postMessage({ type: 'SKIP_WAITING' }) 수신 시 즉시 교체
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
