/**
 * api/stream.js — Vercel Edge Function
 * 한국 라디오 스트림 URL CORS 프록시
 *
 * GET /api/stream?stn=kbs&ch=21
 * GET /api/stream?stn=mbc&ch=sfm
 * GET /api/stream?stn=sbs&ch=lovefm
 * GET /api/stream?stn=cbs&ch=mfm
 * GET /api/stream?stn=tbs
 * GET /api/stream?stn=ytn
 * GET /api/stream?stn=ebs
 *
 * 응답: { url: "https://...playlist.m3u8" }
 */

export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

// 정적 URL (fetch 없이 바로 반환)
const STATIC = {
  'cbs:mfm':   'https://aac.cbs.co.kr/cbs939/_definst_/cbs939.stream/playlist.m3u8',
  'cbs:sfm':   'https://aac.cbs.co.kr/cbs981/_definst_/cbs981.stream/playlist.m3u8',
  'cbs:joy4u': 'https://aac.cbs.co.kr/joy4u/_definst_/joy4u.stream/playlist.m3u8',
  'tbs:':      'https://cdnfm.tbs.seoul.kr/tbs/_definst_/tbs_fm_web_360.smil/playlist.m3u8',
  'ytn:':      'https://radiolive.ytn.co.kr/radio/_definst_/20211118_fmlive/playlist.m3u8',
  'ebs:':      'https://ebsonair.ebs.co.kr/fmradiofamilypc/familypc1m/playlist.m3u8',
};

// 동적 URL — 업스트림 API에서 파싱
function buildUpstream(stn, ch) {
  if (stn === 'kbs') return `https://cfpwwwapi.kbs.co.kr/api/v1/landing/live/channel_code/${ch}`;
  if (stn === 'mbc') return `https://sminiplay.imbc.com/aacplay.ashx?agent=webapp&channel=${ch}`;
  if (stn === 'sbs') {
    if (ch === 'lovefm')  return 'https://apis.sbs.co.kr/play-api/1.0/livestream/lovepc/lovefm?protocol=hls&ssl=Y';
    if (ch === 'powerfm') return 'https://apis.sbs.co.kr/play-api/1.0/livestream/powerpc/powerfm?protocol=hls&ssl=Y';
  }
  return null;
}

async function extractUrl(stn, upstream) {
  const res = await fetch(upstream, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KoreaFMRadio/1.0)' },
  });
  if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);

  if (stn === 'kbs') {
    const json = await res.json();
    const url  = json?.channel?.item?.[0]?.service_url;
    if (!url) throw new Error('KBS: service_url 없음');
    return url;
  }

  // MBC / SBS: Plain Text = m3u8 URL
  const text = (await res.text()).trim();
  if (text.startsWith('http') && text.includes('m3u8')) return text;
  const m = text.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/);
  if (m) return m[0];
  throw new Error(`${stn}: m3u8 추출 실패 — ${text.slice(0, 100)}`);
}

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const stn = searchParams.get('stn') || '';
  const ch  = searchParams.get('ch')  || '';

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (!stn) {
    return new Response(JSON.stringify({ error: 'stn 파라미터 필요' }), { status: 400, headers: CORS });
  }

  // 정적 URL 체크
  const staticUrl = STATIC[`${stn}:${ch}`];
  if (staticUrl) {
    return new Response(JSON.stringify({ url: staticUrl }), { status: 200, headers: CORS });
  }

  // 동적 URL
  const upstream = buildUpstream(stn, ch);
  if (!upstream) {
    return new Response(JSON.stringify({ error: `알 수 없는 채널: stn=${stn} ch=${ch}` }), { status: 400, headers: CORS });
  }

  try {
    const url = await extractUrl(stn, upstream);
    return new Response(JSON.stringify({ url }), { status: 200, headers: CORS });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: CORS });
  }
}
