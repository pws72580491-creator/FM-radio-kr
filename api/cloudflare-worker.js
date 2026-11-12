// cloudflare-worker.js — KOREA FM 라디오 방송3사(KBS·MBC·SBS) 스트림 주소 중계 (Cloudflare Worker)
//
// 왜 필요한가
//   MBC 주소 API(sminiplay.imbc.com)는 ① 브라우저가 다른 사이트에서 직접 부르면 CORS 로 막히고
//   ② Vercel 서버에서 부르면 응답 없이 연결을 끊는다(11/12 로그: "HTTP 502 — Network connection lost").
//   radio.bsod.kr 은 Cloudflare 서버에서 이 API 를 불러 MBC 주소를 받으므로, 같은 Cloudflare 에 중계를 둔다.
//   (이 환경에서는 MBC 서버에 접속할 수 없어 실제로 열리는지는 확인하지 못했다 — 설치 후 3)번 테스트로 확인)
//
// 설치 (무료 계정으로 충분, 약 3분)
//   1) https://dash.cloudflare.com → Workers & Pages → Create → Create Worker → 이름 입력(예: fm-relay) → Deploy
//   2) Edit code 로 들어가 기본 코드를 지우고 이 파일 전체를 붙여넣기 → Deploy
//   3) 브라우저로  https://<이름>.<계정>.workers.dev/?stn=mbc&ch=sfm  을 열어 {"url":"https://…m3u8?…"} 가 나오면 성공
//      실패하면 502 와 함께 원인이 한 줄로 나온다 (예: upstream HTTP 403 — … [colo=ICN])
//   4) 앱의 "＋ 방송 추가" URL 칸에  https://<이름>.<계정>.workers.dev/  를 붙여넣기 → "중계 서버 주소를 저장했습니다"
//
// 호출: GET /?stn=mbc&ch=sfm  →  200 {"url":"https://...m3u8?..."}
//   stn/ch 조합은 아래 SOURCES 에 적힌 것만 허용 (임의 주소 중계 불가 — SSRF 방지)
//   돌려주는 것은 방송사가 누구에게나 주는 공개 재생 주소뿐이라 CORS 는 * 로 연다.

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

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
};

const snippet = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, 80);

// 응답 문자열 안의 첫 http(s) 주소만 추출 (줄바꿈·HTML 껍데기 대응)
function pickUrl(raw) {
  const m = typeof raw === 'string' ? raw.match(/https?:\/\/[^\s"'<>]+/i) : null;
  return m ? m[0] : null;
}

function reply(status, body, colo) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: {
      'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
      'cache-control': 'no-store', // 토큰이 붙은 주소라 캐시하지 않음
      'x-relay-colo': colo || 'unknown',
      ...CORS,
    },
  });
}

async function upstream(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    let body = '';
    try { body = snippet(await res.text()); } catch (e) {}
    throw new Error(`upstream HTTP ${res.status}${body ? ' — ' + body : ''}`);
  }
  return res;
}

export default {
  async fetch(request) {
    // request.cf.colo = 이 요청을 처리한 Cloudflare 데이터센터 (한국이면 ICN)
    const colo = (request.cf && request.cf.colo) || 'unknown';

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'GET') return reply(405, 'Method Not Allowed', colo);

    const params = new URL(request.url).searchParams;
    const stn = params.get('stn');
    const ch = params.get('ch');
    const src = stn && ch && SOURCES[stn] && Object.prototype.hasOwnProperty.call(SOURCES[stn], ch)
      ? SOURCES[stn][ch]
      : null;
    if (!src) return reply(400, 'Bad Request', colo);

    try {
      let raw = '';
      let found = null;
      if (src.kind === 'kbs') {
        const j = await (await upstream(KBS_API + src.code)).json();
        const item = (j && j.channel_item && j.channel_item[0]) || (j && j.channel && j.channel.item && j.channel.item[0]);
        raw = item && item.service_url;
        found = pickUrl(raw);
      } else {
        raw = await (await upstream(src.url)).text();
        found = pickUrl(raw);
      }
      if (!found) return reply(502, `Upstream returned no stream url: "${snippet(raw)}" [colo=${colo}]`, colo);
      return reply(200, { url: found }, colo);
    } catch (e) {
      return reply(502, `Upstream error: ${e && e.message ? e.message : e} [colo=${colo}]`, colo);
    }
  },
};
