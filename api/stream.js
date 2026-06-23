/**
 * api/stream.js — Vercel Edge Function v3
 * 한국 라디오 스트림 URL CORS 프록시
 */

export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

function ok(url)            { return new Response(JSON.stringify({ url }), { status: 200, headers: CORS }); }
function err(msg, s = 502)  { return new Response(JSON.stringify({ error: msg }), { status: s, headers: CORS }); }

// ── 정적 URL
const STATIC = {
  'cbs:mfm':   'https://aac.cbs.co.kr/cbs939/_definst_/cbs939.stream/playlist.m3u8',
  'cbs:sfm':   'https://aac.cbs.co.kr/cbs981/_definst_/cbs981.stream/playlist.m3u8',
  'cbs:joy4u': 'https://aac.cbs.co.kr/joy4u/_definst_/joy4u.stream/playlist.m3u8',
  'tbs:':      'https://cdnfm.tbs.seoul.kr/tbs/_definst_/tbs_fm_web_360.smil/playlist.m3u8',
  'ytn:':      'https://radiolive.ytn.co.kr/radio/_definst_/20211118_fmlive/playlist.m3u8',
  'ebs:':      'https://ebsonair.ebs.co.kr/fmradiofamilypc/familypc1m/playlist.m3u8',
};

// Plain Text m3u8 추출
async function fetchPlainM3u8(url, referer) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': referer },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = (await res.text()).trim();
  if (text.startsWith('http') && text.includes('m3u8')) return text;
  const m = text.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/);
  if (m) return m[0];
  throw new Error(`m3u8 추출 실패: ${text.slice(0, 150)}`);
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const { searchParams } = new URL(req.url);
  const stn = searchParams.get('stn') || '';
  const ch  = searchParams.get('ch')  || '';
  if (!stn) return err('stn 파라미터 필요', 400);

  // 정적 URL
  const staticUrl = STATIC[`${stn}:${ch}`];
  if (staticUrl) return ok(staticUrl);

  // ── KBS: json.channel_item[0].service_url
  if (stn === 'kbs') {
    try {
      const res = await fetch(
        `https://cfpwwwapi.kbs.co.kr/api/v1/landing/live/channel_code/${ch}`,
        { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://office.kbs.co.kr/' } }
      );
      if (!res.ok) return err(`KBS HTTP ${res.status}`);
      const json = await res.json();
      const item = json?.channel_item?.[0];
      if (!item) return err(`KBS: channel_item 없음 — keys: ${Object.keys(json).join(',')}`);
      const url = item.service_url || item.stream_url || item.url || item.hls_url;
      if (!url) return err(`KBS: URL 필드 없음 — item keys: ${Object.keys(item).join(',')}`);
      return ok(url);
    } catch(e) { return err(`KBS 실패: ${e.message}`); }
  }

  // ── MBC: sminiplay (Referer 추가로 재시도)
  if (stn === 'mbc') {
    if (!['sfm','mfm'].includes(ch)) return err(`MBC 알 수 없는 채널: ${ch}`, 400);
    try {
      const url = await fetchPlainM3u8(
        `https://sminiplay.imbc.com/aacplay.ashx?agent=webapp&channel=${ch}`,
        'https://mini.imbc.com/'
      );
      return ok(url);
    } catch(e) { return err(`MBC 실패: ${e.message}`); }
  }

  // ── SBS: powerpc=러브FM, lovepc=파워FM (bsod.kr README 기준)
  if (stn === 'sbs') {
    const SBS_URL = {
      lovefm:  'https://apis.sbs.co.kr/play-api/1.0/livestream/powerpc/powerfm?protocol=hls&ssl=Y',
      powerfm: 'https://apis.sbs.co.kr/play-api/1.0/livestream/lovepc/lovefm?protocol=hls&ssl=Y',
    };
    if (!SBS_URL[ch]) return err(`SBS 알 수 없는 채널: ${ch}`, 400);
    try {
      const url = await fetchPlainM3u8(SBS_URL[ch], 'https://www.sbs.co.kr/');
      return ok(url);
    } catch(e) { return err(`SBS 실패: ${e.message}`); }
  }

  return err(`알 수 없는 stn: ${stn}`, 400);
}
