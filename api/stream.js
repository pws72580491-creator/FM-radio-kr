// api/stream.js — KOREA FM 라디오 방송3사(KBS·MBC·SBS) 스트림 주소 중계 (Vercel Edge Function)
//
// 왜 필요한가
//   방송사 API(sminiplay.imbc.com 등)는 브라우저가 다른 사이트에서 직접 호출하면 CORS 때문에 막히는 경우가 있다.
//   이 함수가 서버에서 대신 호출하고, 앱에는 JSON({ url })만 돌려준다.
//
// 설치
//   1) 이 파일을 Vercel 프로젝트의 api/stream.js 로 저장 (index.html 과 같은 레벨의 api 폴더)
//   2) 다시 배포(git push 또는 vercel --prod)
//   3) 브라우저에서 https://<내 도메인>/api/stream?stn=mbc&ch=sfm 을 열어 {"url":"https://..."} 가 나오면 성공
//      실패하면 502 와 함께 원인이 한 줄로 나온다(예: "upstream HTTP 403 — ..." / region=iad1 등)
//
// 앱이 Vercel 이 아닌 곳(GitHub Pages 등)에서 열리는 경우
//   이 함수만 별도 Vercel 프로젝트로 배포하고, 앱에서 한 번만 지정하면 된다 (CORS 허용 — 아래 CORS 헤더).
//   앱 콘솔(또는 주소창 javascript:)에서  localStorage.radio_relay_url='https://<중계 도메인>/api/stream'
//
// 호출: GET /api/stream?stn=mbc&ch=sfm  →  200 {"url":"https://...m3u8?..."}
//   stn/ch 조합은 아래 SOURCES 에 적힌 것만 허용 (임의 주소 중계 불가 — SSRF 방지)
//   돌려주는 것은 방송사가 누구에게나 주는 공개 재생 주소뿐이라 CORS 는 * 로 연다.
//
// ★ v2.8.83 — 11/12 로그: KBS 는 이 함수로 주소를 받았지만 MBC 만 HTTP 502.
//   원인 후보: MBC API(sminiplay.imbc.com)가 이 함수가 실행된 서버의 IP·지역을 막음(국내 IP만 허용하는 경우),
//   또는 User-Agent 없는 요청을 거부. 그래서 ① 브라우저와 같은 User-Agent 를 보내고 ② 502 응답에
//   방송사 응답 상태·본문 앞부분·실행 지역(region)을 담아 앱 로그에서 원인을 바로 볼 수 있게 했다.
//   region 이 iad1(미국) 등으로 찍히면 지역 차단이 유력 — 그때는 함수 실행 지역을 서울(icn1)로 옮겨야 한다.
//
// ★ v2.8.86 — MBC 의 "Network connection lost." 는 방송사가 해외 서버 연결을 끊는 증상과 같다.
//   Edge Function 은 기본적으로 요청이 들어온 가장 가까운 지역에서 실행되므로 해외 지역에서 돌 수 있다.
//   그래서 실행 지역을 서울(icn1)로 고정했다. (KBS·SBS 는 지역과 무관하게 동작하므로 영향 없음)
//   배포 후 /api/stream?stn=mbc&ch=sfm 응답 헤더 x-relay-region 이 icn1 인지 확인.
//   그래도 502 면 응답 끝의 [region=icn1] 로 "지역 문제가 아님"이 확정되므로 cloudflare-worker.js 로 넘어가면 된다.

export const config = { runtime: 'edge', regions: ['icn1'] };

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

// 서버에서 보내는 요청도 일반 모바일 브라우저처럼 보이게 (User-Agent 가 없으면 거부하는 서버 대응)
const UPSTREAM_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Mobile Safari/537.36',
  'accept': '*/*',
  'accept-language': 'ko-KR,ko;q=0.9',
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
};

// 이 함수가 실제로 실행된 Vercel 지역 (예: icn1, iad1) — 지역 차단 여부 판단용
function region() {
  try { return (typeof process !== 'undefined' && process.env && process.env.VERCEL_REGION) || 'unknown'; }
  catch (e) { return 'unknown'; }
}

function reply(status, body, extra = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: {
      'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
      'cache-control': 'no-store', // 토큰이 붙은 주소라 캐시하지 않음
      'x-relay-region': region(),
      ...CORS,
      ...extra,
    },
  });
}

const snippet = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, 80);

// 응답 문자열 안의 첫 http(s) 주소만 추출 (줄바꿈·HTML 껍데기 대응)
function pickUrl(raw) {
  const m = typeof raw === 'string' ? raw.match(/https?:\/\/[^\s"'<>]+/i) : null;
  return m ? m[0] : null;
}

async function upstream(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: 'no-store', headers: UPSTREAM_HEADERS });
  if (!res.ok) {
    let body = '';
    try { body = snippet(await res.text()); } catch (e) {}
    throw new Error(`upstream HTTP ${res.status}${body ? ' — ' + body : ''}`);
  }
  return res;
}

export default async function handler(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
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
    let raw = '';
    if (src.kind === 'kbs') {
      const j = await (await upstream(KBS_API + src.code)).json();
      const item = (j && j.channel_item && j.channel_item[0]) || (j && j.channel && j.channel.item && j.channel.item[0]);
      raw = item && item.service_url;
      found = pickUrl(raw);
    } else {
      raw = await (await upstream(src.url)).text();
      found = pickUrl(raw);
    }
    if (!found) return reply(502, `Upstream returned no stream url: "${snippet(raw)}" [region=${region()}]`);
    return reply(200, { url: found });
  } catch (e) {
    return reply(502, `Upstream error: ${e && e.message ? e.message : e} [region=${region()}]`);
  }
}
