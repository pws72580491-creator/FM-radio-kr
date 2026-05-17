/* ════════════════════════════════════════════════════════════════
   KOREA FM 라디오 — Service Worker
   전략:
     · 앱 셸(index.html·manifest·아이콘)  → Network First + 캐시 폴백
     · HLS·스트림 URL                      → 캐시 없이 네트워크 패스스루
     · Firebase·외부 CDN                   → 네트워크 패스스루
   ════════════════════════════════════════════════════════════════ */

const CACHE_VER  = 'kr-radio-v2.1.0';
const APP_SHELL  = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-72.png',
  '/icons/icon-96.png',
  '/icons/icon-128.png',
  '/icons/icon-144.png',
  '/icons/icon-152.png',
  '/icons/icon-192.png',
  '/icons/icon-384.png',
  '/icons/icon-512.png',
  '/icons/icon-192-maskable.png',
  '/icons/icon-512-maskable.png',
];

/* ── 설치: 앱 셸 사전 캐싱 ─────────────────────── */
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_VER).then(cache => {
      // 실패해도 SW 설치를 막지 않음
      return cache.addAll(APP_SHELL).catch(err => {
        console.warn('[SW] 앱 셸 캐싱 일부 실패:', err);
      });
    })
  );
});

/* ── 활성화: 이전 버전 캐시 정리 ───────────────── */
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_VER)
          .map(k => { console.log('[SW] 구버전 캐시 삭제:', k); return caches.delete(k); })
      )
    ).then(() => self.clients.claim())
  );
});

/* ── 패스스루 여부 판단 ────────────────────────── */
function shouldPassthrough(url) {
  const h = url.hostname;
  const p = url.pathname;
  return (
    // 스트리밍 서버
    h.includes('febc.net')        ||
    h.includes('bsod.kr')         ||
    h.includes('ebs.co.kr')       ||
    h.includes('kbs.co.kr')       ||
    h.includes('mbc.co.kr')       ||
    h.includes('sbs.co.kr')       ||
    h.includes('cbs.co.kr')       ||
    h.includes('tbs.seoul.kr')    ||
    h.includes('ytn.co.kr')       ||
    // HLS 세그먼트·플레이리스트
    p.endsWith('.m3u8')           ||
    p.endsWith('.ts')             ||
    // Firebase / 외부 라이브러리
    h.includes('firebase')        ||
    h.includes('firebaseio.com')  ||
    h.includes('gstatic.com')     ||
    h.includes('googleapis.com')  ||
    h.includes('cdnjs.cloudflare.com') ||
    h.includes('fonts.googleapis.com') ||
    h.includes('fonts.gstatic.com')
  );
}

/* ── Fetch: Network First ──────────────────────── */
self.addEventListener('fetch', e => {
  // POST 등 캐시 불가 요청
  if (e.request.method !== 'GET') return;

  let url;
  try { url = new URL(e.request.url); } catch { return; }

  // 패스스루: 캐시 관여 없이 네트워크로 직행
  if (shouldPassthrough(url)) return;

  // chrome-extension 등 무시
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        // 성공 응답 → 캐시 갱신 (Stale-While-Revalidate 효과)
        if (res.ok && res.type !== 'opaque') {
          const clone = res.clone();
          caches.open(CACHE_VER).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() =>
        // 오프라인 → 캐시 폴백
        caches.match(e.request).then(cached => {
          if (cached) return cached;
          // index.html 폴백 (SPA 네비게이션)
          if (e.request.mode === 'navigate') {
            return caches.match('/index.html');
          }
        })
      )
  );
});

/* ── 푸시 알림 (향후 확장용) ───────────────────── */
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  e.waitUntil(
    self.registration.showNotification(data.title || 'FM 라디오', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-96.png',
    })
  );
});
