/**
 * api/stream.js — Vercel Edge Function v2
 * 한국 라디오 스트림 URL CORS 프록시
 */

export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

function ok(url)  { return new Response(JSON.stringify({ url }), { status: 200, headers: CORS }); }
function err(msg, status=502) { return new Response(JSON.stringify({ error: msg }), { status, headers: CORS }); }

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const { searchParams } = new URL(req.url);
  const stn = searchParams.get('stn') || '';
  const ch  = searchParams.get('ch')  || '';

  if (!stn) return err('stn 파라미터 필요', 400);

  // ── 정적 URL (서버 fetch 없이 바로 반환)
  const STATIC = {
    'cbs:mfm':   'https://aac.cbs.co.kr/cbs939/_definst_/cbs939.stream/playlist.m3u8',
    'cbs:sfm':   'https://aac.cbs.co.kr/cbs981/_definst_/cbs981.stream/playlist.m3u8',
    'cbs:joy4u': 'https://aac.cbs.co.kr/joy4u/_definst_/joy4u.stream/playlist.m3u8',
    'tbs:':      'https://cdnfm.tbs.seoul.kr/tbs/_definst_/tbs_fm_web_360.smil/playlist.m3u8',
    'ytn:':      'https://radiolive.ytn.co.kr/radio/_definst_/20211118_fmlive/playlist.m3u8',
    'ebs:':      'https://ebsonair.ebs.co.kr/fmradiofamilypc/familypc1m/playlist.m3u8',
  };
  if (STATIC[`${stn}:${ch}`]) return ok(STATIC[`${stn}:${ch}`]);

  // ── SBS (Plain Text)
  if (stn === 'sbs') {
    // bsod.kr README 기준: 러브FM=powerpc/powerfm, 파워FM=lovepc/lovefm
    const SBS = {
      lovefm:  'https://apis.sbs.co.kr/play-api/1.0/livestream/powerpc/powerfm?protocol=hls&ssl=Y',
      powerfm: 'https://apis.sbs.co.kr/play-api/1.0/livestream/lovepc/lovefm?protocol=hls&ssl=Y',
    };
    if (!SBS[ch]) return err(`SBS 알 수 없는 채널: ${ch}`, 400);
    try {
      const res = await fetch(SBS[ch], { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) return err(`SBS upstream HTTP ${res.status}`);
      const text = (await res.text()).trim();
      if (text.startsWith('http') && text.includes('m3u8')) return ok(text);
      const m = text.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/);
      if (m) return ok(m[0]);
      return err(`SBS m3u8 추출 실패: ${text.slice(0,100)}`);
    } catch(e) { return err(`SBS fetch 실패: ${e.message}`); }
  }

  // ── KBS (JSON → channel.item[0].service_url)
  if (stn === 'kbs') {
    try {
      const res = await fetch(
        `https://cfpwwwapi.kbs.co.kr/api/v1/landing/live/channel_code/${ch}`,
        { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://office.kbs.co.kr/' } }
      );
      if (!res.ok) return err(`KBS upstream HTTP ${res.status}`);
      const json = await res.json();
      // 구조 디버그용으로 전체 키 확인
      const item = json?.channel?.item?.[0];
      if (!item) return err(`KBS: channel.item 없음 — keys: ${Object.keys(json).join(',')}`);
      const url = item.service_url || item.stream_url || item.url || item.hls_url;
      if (!url) return err(`KBS: URL 필드 없음 — item keys: ${Object.keys(item).join(',')}`);
      return ok(url);
    } catch(e) { return err(`KBS fetch 실패: ${e.message}`); }
  }

  // ── MBC (Plain Text) — sminiplay.imbc.com이 Vercel Edge에서 차단될 수 있음
  if (stn === 'mbc') {
    const MBC_CH = { sfm: 'sfm', mfm: 'mfm' };
    if (!MBC_CH[ch]) return err(`MBC 알 수 없는 채널: ${ch}`, 400);
    try {
      const res = await fetch(
        `https://sminiplay.imbc.com/aacplay.ashx?agent=webapp&channel=${ch}`,
        { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://mini.imbc.com/' } }
      );
      if (!res.ok) return err(`MBC upstream HTTP ${res.status}`);
      const text = (await res.text()).trim();
      if (text.startsWith('http') && text.includes('m3u8')) return ok(text);
      const m = text.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/);
      if (m) return ok(m[0]);
      return err(`MBC m3u8 추출 실패: ${text.slice(0,200)}`);
    } catch(e) { return err(`MBC fetch 실패: ${e.message}`); }
  }

  return err(`알 수 없는 stn: ${stn}`, 400);
}
