// api/stream.js — KOREA FM 라디오 방송3사(KBS·MBC·SBS) 스트림 주소 중계 (Vercel Edge Function)
//
// 왜 필요한가
//   방송사 API(sminiplay.imbc.com 등)는 브라우저가 다른 사이트에서 직접 호출하면 CORS 때문에 막히는 경우가 있다.
//   이 함수가 서버에서 대신 호출하고, 앱에는 같은 도메인(/api/stream)으로 JSON({ url })만 돌려준다.
//
// 설치
//   1) 이 파일을 앱을 배포한 프로젝트의 api/stream.js 로 저장 (index.html 과 같은 레벨의 api 폴더)
//   2) 다시 배포(git push 또는 vercel --prod)
//   3) 브라우저에서 https://<내 도메인>/api/stream?stn=mbc&ch=sfm 을 열어 {"url":"https://..."} 가 나오면 성공
//
// 호출: GET /api/stream?stn=mbc&ch=sfm  →  200 {"url":"https://...m3u8?..."}
//   stn/ch 조합은 아래 SOURCES 에 적힌 것만 허용 (임의 주소 중계 불가 — SSRF 방지)
//
// Edge 런타임은 요청자와 가까운 지역(한국이면 서울)에서 실행되므로, 국내 IP만 허용하는 방송사 API도
// radio.bsod.kr 의 Cloudflare Worker 와 같은 조건으로 호출된다.

export const config = { runtime: 'edge' };

const KBS_API = 'https://cfpwwwapi.kbs.co.kr/api/v1/landing/live/channel_code/';

// 출처: radio.bsod.kr 저장소 functions/api/template/{kbs,mbc,sbs}.js (2026-11-10 기준)
const SOURCES = {
  kbs: {
    '1radio': { kind: 'kbs', code: '21' },
    '2radio': { kind: 'kbs', code: '22' },
    '3radio': { kind: 'kbs', code: '23' },
    '1fm':    { kind: 'kbs', code: '24' },
    '2fm':    { kind: 'kbs', code: '25' },
    'hanminjok': { kind: 'kbs', code: '26' },
  },
  mbc: {
    'sfm':  { kind: 'text', url: 'https://sminiplay.imbc.com/aacplay.ashx?agent=webapp&channel=sfm' },
    'fm4u': { kind: 'text', url: 'https://sminiplay.imbc.com/aacplay.ashx?agent=webapp&channel=mfm' },
    'chm':  { kind: 'text', url: 'https://sminiplay.imbc.com/aacplay.ashx?agent=webapp&channel=chm' },
  },
  sbs: {
    'lovefm':  { kind: 'text', url: 'https://apis.sbs.co.kr/play-api/1.0/livestream/lovepc/lovefm?protocol=hls&ssl=Y' },
    'powerfm': { kind: 'text', url: 'https://apis.sbs.co.kr/play-api/1.0/livestream/powerpc/powerfm?protocol=hls&ssl=Y' },
    'dmb':     { kind: 'text', url: 'https://apis.sbs.co.kr/play-api/1.0/livestream/sbsdmbpc/sbsdmb?protocol=hls&ssl=Y' },
  },
};

const TIMEOUT_MS = 6000;

function reply(status, body, extra = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: {
      'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
      'cache-control': 'no-store', // 토큰이 붙은 주소라 캐시하지 않음
      ...extra,
    },
  });
}

// 응답 문자열 안의 첫 http(s) 주소만 추출 (줄바꿈·HTML 껍데기 대응)
function pickUrl(raw) {
  const m = typeof raw === 'string' ? raw.match(/https?:\/\/[^\s"'<>]+/i) : null;
  return m ? m[0] : null;
}

async function upstream(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: 'no-store' });
  if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);
  return res;
}

export default async function handler(request) {
  if (request.method !== 'GET') return reply(405, 'Method Not Allowed');

  const params = new URL(request.url).searchParams;
  const stn = params.get('stn');
  const ch = params.get('ch');
  const src = stn && ch && SOURCES[stn] && Object.prototype.hasOwnProperty.call(SOURCES[stn], ch)
    ? SOURCES[stn][ch]
    : null;
  if (!src) return reply(400, 'Bad Request');

  try {
    let found = null;
    if (src.kind === 'kbs') {
      const j = await (await upstream(KBS_API + src.code)).json();
      const item = (j && j.channel_item && j.channel_item[0]) || (j && j.channel && j.channel.item && j.channel.item[0]);
      found = pickUrl(item && item.service_url);
    } else {
      found = pickUrl(await (await upstream(src.url)).text());
    }
    if (!found) return reply(502, 'Upstream returned no stream url');
    return reply(200, { url: found });
  } catch (e) {
    return reply(502, `Upstream error: ${e && e.message ? e.message : e}`);
  }
}
