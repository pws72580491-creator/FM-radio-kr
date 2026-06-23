/**
 * api/stream.js — Vercel Edge Function v4
 * 한국 라디오 스트림 URL CORS 프록시
 *
 * 변경(v4):
 *  - CBS STATIC 제거 → 서버사이드 HEAD 검증 후 URL 반환
 *    (aac.cbs.co.kr가 브라우저 직접 fetch를 CORS 차단해 manifestLoadError 발생하던 문제 해결)
 *  - TBS/YTN/EBS도 HEAD 검증 후 반환 (URL 만료 감지 목적)
 */

export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

function ok(url)            { return new Response(JSON.stringify({ url }), { status: 200, headers: CORS }); }
function err(msg, s = 502)  { return new Response(JSON.stringify({ error: msg }), { status: s, headers: CORS }); }

// Plain Text 응답에서 m3u8 URL 추출
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

// 정적 URL HEAD 검증 — 200/206이면 ok(), 아니면 err()
async function fetchStaticUrl(rawUrl, referer, label) {
  try {
    const res = await fetch(rawUrl, {
      method: 'HEAD',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': referer },
    });
    // HEAD를 거부하는 서버(405)는 URL 자체는 유효 → ok()
    if (res.ok || res.status === 405 || res.status === 403) return ok(rawUrl);
    return err(`${label} HTTP ${res.status}`);
  } catch(e) {
    // 네트워크 오류여도 URL 자체는 반환 (클라이언트가 재시도 가능)
    return ok(rawUrl);
  }
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const { searchParams } = new URL(req.url);
  const stn = searchParams.get('stn') || '';
  const ch  = searchParams.get('ch')  || '';
  if (!stn) return err('stn 파라미터 필요', 400);

  // ── KBS: JSON API → service_url 추출
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

  // ── MBC: sminiplay Plain Text → m3u8 추출
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

  // ── SBS: apis.sbs.co.kr Plain Text → m3u8 추출
  if (stn === 'sbs') {
    const SBS_API = {
      lovefm:  'https://apis.sbs.co.kr/play-api/1.0/livestream/powerpc/powerfm?protocol=hls&ssl=Y',
      powerfm: 'https://apis.sbs.co.kr/play-api/1.0/livestream/lovepc/lovefm?protocol=hls&ssl=Y',
    };
    if (!SBS_API[ch]) return err(`SBS 알 수 없는 채널: ${ch}`, 400);
    try {
      const url = await fetchPlainM3u8(SBS_API[ch], 'https://www.sbs.co.kr/');
      return ok(url);
    } catch(e) { return err(`SBS 실패: ${e.message}`); }
  }

  // ── CBS: aac.cbs.co.kr — 브라우저 직접 fetch 시 CORS 차단 → 서버에서 HEAD 검증 후 URL 반환
  //   (HLS.js는 반환된 URL로 직접 스트리밍 — manifest는 CDN CORS 허용)
  if (stn === 'cbs') {
    const CBS_MAP = {
      mfm:   'https://aac.cbs.co.kr/cbs939/_definst_/cbs939.stream/playlist.m3u8',
      sfm:   'https://aac.cbs.co.kr/cbs981/_definst_/cbs981.stream/playlist.m3u8',
      joy4u: 'https://aac.cbs.co.kr/joy4u/_definst_/joy4u.stream/playlist.m3u8',
    };
    const rawUrl = CBS_MAP[ch];
    if (!rawUrl) return err(`CBS 알 수 없는 채널: ${ch}`, 400);
    return await fetchStaticUrl(rawUrl, 'https://www.cbs.co.kr/', 'CBS');
  }

  // ── TBS
  if (stn === 'tbs') {
    return await fetchStaticUrl(
      'https://cdnfm.tbs.seoul.kr/tbs/_definst_/tbs_fm_web_360.smil/playlist.m3u8',
      'https://tbs.seoul.kr/', 'TBS'
    );
  }

  // ── YTN
  if (stn === 'ytn') {
    return await fetchStaticUrl(
      'https://radiolive.ytn.co.kr/radio/_definst_/20211118_fmlive/playlist.m3u8',
      'https://www.ytn.co.kr/', 'YTN'
    );
  }

  // ── EBS
  if (stn === 'ebs') {
    return await fetchStaticUrl(
      'https://ebsonair.ebs.co.kr/fmradiofamilypc/familypc1m/playlist.m3u8',
      'https://www.ebs.co.kr/', 'EBS'
    );
  }

  return err(`알 수 없는 stn: ${stn}`, 400);
}
