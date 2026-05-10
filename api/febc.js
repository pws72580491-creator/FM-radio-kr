// api/febc.js — Vercel Serverless Function
// 극동방송 http:// 스트림을 https://로 프록시
// 브라우저 Mixed Content 문제 해결

export const config = {
  runtime: 'edge', // Edge 런타임 — 스트리밍 지원
};

const ALLOWED = {
  seoulfm:   'http://mlive2.febc.net:1935/live/seoulfm/',
  changwonfm: 'http://mlive2.febc.net:1935/live/cwlive/', // cwlive/playlist.m3u8
};

export default async function handler(req) {
  const url  = new URL(req.url);
  const city = url.searchParams.get('city'); // ?city=seoulfm
  const path = url.searchParams.get('path') || 'playlist.m3u8';

  if (!city || !ALLOWED[city]) {
    return new Response('Not allowed', { status: 403 });
  }

  const target = ALLOWED[city] + path;

  try {
    const res = await fetch(target, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    const headers = new Headers(res.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    headers.delete('content-encoding'); // 압축 해제 충돌 방지

    return new Response(res.body, {
      status: res.status,
      headers,
    });
  } catch (e) {
    return new Response('Proxy error: ' + e.message, { status: 502 });
  }
}
