/* KOREA FM 라디오 — Service Worker v2.6.3 */
const CACHE = 'kr-radio-v2.6.3';
const SHELL = ['/'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(
        ks.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
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

  // 네트워크 우선, 실패 시 캐시 fallback
  e.respondWith(
    fetch(e.request).then(r => {
      if (r && r.status === 200 && r.type !== 'opaque') {
        const c = r.clone();
        caches.open(CACHE).then(ca => ca.put(e.request, c));
      }
      return r;
    }).catch(() => caches.match(e.request))
  );
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
