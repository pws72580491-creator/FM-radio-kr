/**
 * /api/stream.js  — 한국 라디오 스트림 URL CORS 프록시
 * Vercel Serverless Function (Node.js)
 *
 * 사용법:
 *   GET /api/stream?stn=kbs&ch=21
 *   GET /api/stream?stn=mbc&ch=sfm
 *   GET /api/stream?stn=sbs&ch=lovefm
 *   GET /api/stream?stn=tbs
 *   GET /api/stream?stn=ytn
 *
 * 응답: { url: "https://...playlist.m3u8" }
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json',
};

// ── 방송사별 업스트림 URL 생성
function buildUpstreamUrl(stn, ch) {
  switch (stn) {
    case 'kbs':
      // ch = KBS 채널코드 (21,22,24,25 등)
      return `https://cfpwwwapi.kbs.co.kr/api/v1/landing/live/channel_code/${ch}`;

    case 'mbc':
      // ch = sfm | mfm
      return `https://sminiplay.imbc.com/aacplay.ashx?agent=webapp&channel=${ch}`;

    case 'sbs':
      // ch = lovefm | powerfm
      if (ch === 'lovefm')  return 'https://apis.sbs.co.kr/play-api/1.0/livestream/lovepc/lovefm?protocol=hls&ssl=Y';
      if (ch === 'powerfm') return 'https://apis.sbs.co.kr/play-api/1.0/livestream/powerpc/powerfm?protocol=hls&ssl=Y';
      break;

    case 'cbs':
      // ch = mfm | sfm | joy4u
      const CBS_MAP = {
        mfm:   'https://aac.cbs.co.kr/cbs939/_definst_/cbs939.stream/playlist.m3u8',
        sfm:   'https://aac.cbs.co.kr/cbs981/_definst_/cbs981.stream/playlist.m3u8',
        joy4u: 'https://aac.cbs.co.kr/joy4u/_definst_/joy4u.stream/playlist.m3u8',
      };
      return CBS_MAP[ch] ? `__static__:${CBS_MAP[ch]}` : null;

    case 'tbs':
      return '__static__:https://cdnfm.tbs.seoul.kr/tbs/_definst_/tbs_fm_web_360.smil/playlist.m3u8';

    case 'ytn':
      return '__static__:https://radiolive.ytn.co.kr/radio/_definst_/20211118_fmlive/playlist.m3u8';

    case 'ebs':
      return '__static__:https://ebsonair.ebs.co.kr/fmradiofamilypc/familypc1m/playlist.m3u8';
  }
  return null;
}

// ── 업스트림 응답에서 m3u8 URL 추출
async function extractUrl(stn, upstreamUrl) {
  const res = await fetch(upstreamUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KoreaFMRadio/1.0)' },
  });

  if (!res.ok) throw new Error(`upstream ${res.status}`);

  if (stn === 'kbs') {
    const json = await res.json();
    const url  = json?.channel?.item?.[0]?.service_url;
    if (!url) throw new Error('KBS: service_url 없음');
    return url;
  }

  if (stn === 'mbc' || stn === 'sbs') {
    const text = (await res.text()).trim();
    // Plain Text = m3u8 URL 그대로
    if (text.startsWith('http') && text.includes('m3u8')) return text;
    // 혹시 JSON/HTML로 감싸인 경우 정규식 폴백
    const m = text.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/);
    if (m) return m[0];
    throw new Error(`${stn}: m3u8 URL 추출 실패`);
  }

  throw new Error(`알 수 없는 stn: ${stn}`);
}

// ── 메인 핸들러
export default async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(204).set(CORS_HEADERS).end();
  }

  const { stn, ch = '' } = req.query;

  if (!stn) {
    return res.status(400).json({ error: 'stn 파라미터 필요' });
  }

  try {
    const upstream = buildUpstreamUrl(stn, ch);

    if (!upstream) {
      return res.status(400)
        .set(CORS_HEADERS)
        .json({ error: `알 수 없는 채널: stn=${stn} ch=${ch}` });
    }

    // 정적 URL (CBS/TBS/YTN/EBS) — 업스트림 fetch 없이 바로 반환
    if (upstream.startsWith('__static__:')) {
      const url = upstream.replace('__static__:', '');
      return res.status(200).set(CORS_HEADERS).json({ url });
    }

    // 동적 URL (KBS/MBC/SBS) — 업스트림 fetch 후 파싱
    const url = await extractUrl(stn, upstream);
    return res.status(200).set(CORS_HEADERS).json({ url });

  } catch (e) {
    console.error('[stream proxy error]', e.message);
    return res.status(502)
      .set(CORS_HEADERS)
      .json({ error: e.message });
  }
}
