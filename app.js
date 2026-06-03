// ╔══════════════════════════════════════════════════════════════╗
// ║  § 0  전역 상태 & 설정                                             ║
// ╚══════════════════════════════════════════════════════════════╝

'use strict';

// ─── Firebase 설정 (하드코딩 — 워크스페이스 ID만 입력하면 됨) ───
const FIREBASE_CONFIG = {
    apiKey: "AIzaSyD9AaPcjjI842XYEz6Man4tgzZmcoFdSHE",
    authDomain: "test-b1713.firebaseapp.com",
    databaseURL: "https://test-b1713-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "test-b1713",
    storageBucket: "test-b1713.firebasestorage.app",
    messagingSenderId: "96408145171",
    appId: "1:96408145171:web:30a300ff2f7b735d929ee6",
    measurementId: "G-LXQ1XZMV02"
};

// ─── 사용설명서 URL (GitHub raw 주소 — 직접 수정하세요) ───
// 예: 'https://raw.githubusercontent.com/YOUR_ID/YOUR_REPO/main/manual.md'
const MANUAL_URL = 'https://raw.githubusercontent.com/pws72580491-creator/Delivery/main/manual.md';

// ─── 탭 순서 ───
const TAB_ORDER = ['dashboard','clients','unpaid','delivery','history','stock','settlement','backup','settings'];

// ─── 상태 ───
let clients    = _loadJSON('p_clients')   || _loadJSON('clients')   || [];
let orders     = (_loadJSON('p_orders') || _loadJSON('orders') || [])
    .map(o => {
        if (o._noItems) { delete o._noItems; }
        if (!Array.isArray(o.items)) o.items = [];
        else o.items = o.items.map(it => ({
            ...it,
            name: (it.name||'').trim(),
            total: it.total ?? (Number(it.qty)||0) * (Number(it.price)||0)  // ① it.total 복원
        }));
        return o;
    });
let prices     = _loadJSON('prices')      || {};

// 거래처 데이터 정규화 (외부 백업 호환)
clients = clients.map(c => {
    if (typeof c === 'string') return { id: _uid(), name: c, phone:'', address:'', note:'', createdAt: new Date().toISOString() };
    if (!c.id) c.id = _uid();
    c.id = String(c.id);                          // int id → string 타입 통일
    if (!c.note && c.memo) c.note = c.memo;       // memo → note 이관
    if (!c.note) c.note = '';
    // isHidden: 저장된 값 보존 (false면 목록에 표시, true면 숨겨짐)
    if (c.isHidden === undefined) c.isHidden = false;
    return c;
});

// 납품 데이터 정규화 (외부 백업 호환)
orders = orders.map(o => {
    if (!o.id) o.id = _uid();
    o.id = String(o.id);                           // int id → string 타입 통일 (clients와 동일)
    if (!o.clientName && o.client) o.clientName = o.client;
    if (o.clientId !== undefined) o.clientId = String(o.clientId); // int→string 타입 통일
    if (!o.clientId) {
        const found = clients.find(c => c.name === o.clientName);
        o.clientId = found ? found.id : '';
    } else {
        // clientId가 있으면 현재 거래처 이름과 다를 경우 자동 보정 (거래처명 변경 후 미반영 복구)
        const linked = clients.find(c => c.id === o.clientId);
        if (linked && linked.name !== o.clientName) {
            o.clientName = linked.name;
        }
    }
    o.total = Number(o.total ?? o.totalAmount ?? 0);
    if (!o.note && o.memo) o.note = o.memo;       // memo → note 이관
    if (!o.note) o.note = '';
    if (!o.isVoid) o.isVoid = false;              // isVoid 복원 (없으면 false)
    return o;
});

let tempGroups = [];
let editingClientId = null;

// ─── 재고 ───
let stockItems     = (_loadJSON('p_stock') || []).map(si => si ? {
    id: si.id || _uid(), name: (si.name || '').trim(), qty: Number(si.qty ?? 0),
    unit: si.unit || '개', low: Number(si.low ?? 10), danger: Number(si.danger ?? 3),
    note: si.note || '', log: Array.isArray(si.log) ? si.log : [],
    updatedAt: si.updatedAt || new Date().toISOString()
} : null).filter(Boolean);
let stockSortMode  = 'name';
// 최초 실행(null) 또는 '1'이면 ON — 기본값 ON
let stockAutoDeduct = localStorage.getItem('stockAutoDeduct') !== '0';
let _adjType = 'in';

// ─── 성능 캐시 ───
// orders가 바뀔 때마다 invalidateOrdersCache()로 무효화
let _itemNamesCache    = null;  // 전체 품목명 Set → 정렬 배열
let _clientItemsCache  = null;  // clientId → [{name,price,date}]
let _clientStatsCache  = null;  // clientId/name → {count,total,unpaid,lastDate}
let _recentPricesCache = null;  // 품목명 → 최근 단가 배열 (getRecentPrices 캐시)

// ╔══════════════════════════════════════════════════════════════╗
// ║  § 1  유틸리티                                                   ║
// ╚══════════════════════════════════════════════════════════════╝

function _loadJSON(key) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch(e) { return null; }
}

function _uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2,7);
}

function todayKST() {
    // 항상 UTC+9(KST) 기준 날짜 반환 — 기기 시간대와 무관하게 정확
    const d = new Date();
    return new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// 재고 이력을 최근 30일 항목만 남기고 이전 이력 삭제
// (과거 날짜 재고 역산 정확도를 위해 30일치 유지)
function _trimLogByDate(log) {
    if (!Array.isArray(log)) return [];
    const yesterday = kstAddDays(todayKST(), -1);  // 어제·오늘만 유지
    return log.filter(l => {
        const d = l.date || (l.at ? l.at.slice(0, 10) : null);
        return d && d >= yesterday;
    });
}

// KST 기준 현재 날짜+시각 반환
// dateStr: 'YYYY-MM-DD HH:MM' (화면 표시용)
// key:     'YYYY-MM-DDTHH-MM-SS' (Firebase 정렬키용, 특수문자 제거)

function nowKST() {
    const kstIso = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString();
    const dateStr = kstIso.slice(0, 16).replace('T', ' ');   // 'YYYY-MM-DD HH:MM'
    const key     = kstIso.slice(0, 19).replace(/[:.]/g, '-'); // 'YYYY-MM-DDTHH-MM-SS'
    return { dateStr, key };
}

// KST 날짜 문자열(YYYY-MM-DD)에 days를 더해 새 날짜 문자열 반환

function kstAddDays(dateStr, days) {
    // +09:00으로 파싱하면 UTC로 변환되므로, 다시 +9h 오프셋을 더해 KST 날짜 추출
    const utcMs = Date.parse(dateStr + 'T00:00:00+09:00') + days * 86400000;
    return new Date(utcMs + 9 * 3600000).toISOString().slice(0, 10);
}

// KST 기준으로 n개월 전 날짜 문자열 반환 (new Date() UTC 오프셋 버그 방지)
function _kstMonthsAgo(n) {
    let [y, m, d] = todayKST().split('-').map(Number);
    m -= n;
    while (m <= 0) { m += 12; y--; }
    const maxDay = new Date(y, m, 0).getDate();
    d = Math.min(d, maxDay);
    return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

function fmt(n) {
    const v = Number(n);
    return isNaN(v) ? '0' : v.toLocaleString('ko-KR');
}

// 전표의 실제 수령액 반환 (할인 완납 시 paidAmount = 실수령액, total - discount)
// 완납이어도 할인이 있으면 paidAmount를 우선 사용
function _actualPaid(o) {
    if (!o.isPaid) return Math.min(o.total, o.paidAmount || 0);
    // 할인 완납: paidAmount = 실수령액 (total보다 작음)
    if (o.discount > 0 && o.paidAmount != null) return o.paidAmount;
    return o.total;
}

// 안정적 hash: 객체 키 삽입 순서에 무관하게 동일한 결과 보장
function dataHash(v) {
    return JSON.stringify(v, (_, val) =>
        (val && typeof val === 'object' && !Array.isArray(val))
            ? Object.keys(val).sort().reduce((acc, k) => { acc[k] = val[k]; return acc; }, {})
            : val
    );
}

function toArray(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    return Object.values(v);
}

function debounce(fn, ms) {
    let t;
    const f = (...a) => { clearTimeout(t); t = setTimeout(()=>fn(...a), ms); };
    f.cancel = () => { clearTimeout(t); t = null; };
    return f;
}

// ─── HTML 이스케이프 (XSS 방지) ───

function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str)
        .replace(/&/g,'&amp;')
        .replace(/</g,'&lt;')
        .replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;')
        .replace(/'/g,'&#39;');
}

// onclick 속성 내 작은따옴표+큰따옴표 이스케이프

function escapeAttr(str) {
    return String(str||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'&quot;');
}

// 초성 검색
const CHO = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];

function extractChosung(str) {
    return [...str].map(c => {
        const code = c.charCodeAt(0) - 44032;
        return code>=0 && code<11172 ? CHO[Math.floor(code/588)] : c;
    }).join('');
}

function matchSearch(target, q) {
    if (!q) return true;
    const t = target.toLowerCase(), query = q.toLowerCase();
    // 일반 문자열 포함 검색
    if (t.includes(query)) return true;
    // 초성 검색: 쿼리가 순수 자음(초성)으로만 이루어진 경우에만 적용
    // 예) 'ㅂㄹ' → 초성 검색 O / '벨렘' → 일반 검색만 O (초성 혼합 방지)
    const isChoOnly = /^[ㄱ-ㅎ]+$/.test(q);
    if (isChoOnly) {
        const tCho = extractChosung(target);
        if (tCho.includes(q)) return true;
    }
    return false;
}

// ─── 함수 래퍼 (monkey-patch 안전화) ───
// fn이 존재하는 함수일 때만 래핑 → 정의 순서 무관하게 안전
function _safeWrap(fn, extra) {
    if (typeof fn !== 'function') { console.warn('_safeWrap: 대상 함수를 찾을 수 없습니다'); return fn || (() => {}); }
    return function(...args) { const r = fn.apply(this, args); extra.apply(this, args); return r; };
}

// ─── 커스텀 confirm 다이얼로그 (Promise 기반) ───
// 사용법: if (!await customConfirm('삭제할까요?')) return;
// okLabel: 확인 버튼 텍스트 / okClass: 버튼 CSS 클래스 (btn-danger|btn-primary)
function customConfirm(msg, okLabel = '확인', okClass = 'btn-danger') {
    return new Promise(resolve => {
        const modal     = document.getElementById('customConfirmModal');
        const msgEl     = document.getElementById('customConfirmMsg');
        const okBtn     = document.getElementById('customConfirmOkBtn');
        const cancelBtn = document.getElementById('customConfirmCancelBtn');
        if (!modal) { resolve(window.confirm(msg)); return; } // fallback
        msgEl.textContent = msg;
        okBtn.textContent = okLabel;
        okBtn.className   = `btn ${okClass}`;
        okBtn.style.flex  = '2';
        const cleanup = (val) => { closeModal('customConfirmModal'); resolve(val); };
        okBtn.onclick     = () => cleanup(true);
        cancelBtn.onclick = () => cleanup(false);
        openModal('customConfirmModal');
    });
}

// ─── 로컬 저장 (스마트 모드) ───
// Firebase 연결 중이거나 워크스페이스 ID가 설정된 경우: 경량 저장 (용량 최소화)
// 순수 오프라인(워크스페이스 ID 없음): 전체 저장
// Firebase 업로드(debouncedSync)는 항상 전체 데이터 사용 (별도 경로)

// ╔══════════════════════════════════════════════════════════════╗
// ║  § 2  성능 캐시 빌드                                               ║
// ╚══════════════════════════════════════════════════════════════╝

function invalidateOrdersCache() {
    _itemNamesCache    = null;
    _clientItemsCache  = null;
    _clientStatsCache  = null;
    _recentPricesCache = null;
}

function _buildClientStatsCache() {
    if (_clientStatsCache) return _clientStatsCache;
    const m = {};
    for (const o of orders) {
        const key = o.clientId || o.clientName;
        if (!m[key]) m[key] = { count:0, total:0, unpaid:0, lastDate:'' };
        m[key].count++;
        m[key].total += o.total;
        if (!o.isPaid) m[key].unpaid += Math.max(0, (o.total - (o.paidAmount||0)));
        if (o.date > m[key].lastDate) m[key].lastDate = o.date;
    }
    _clientStatsCache = m;
    return m;
}

function _buildItemNamesCache() {
    if (_itemNamesCache) return _itemNamesCache;
    const all = new Set();
    for (const o of orders) for (const it of (o.items||[])) if (it.name) all.add(it.name);
    _itemNamesCache = [...all].sort();
    return _itemNamesCache;
}

function _buildClientItemsCache() {
    if (_clientItemsCache) return _clientItemsCache;
    // clientId → 날짜 내림차순으로 품목명 첫 등장만 수집
    // clientId 없는 전표는 clientName을 fallback 키로 사용
    const tmp = {}; // key → [{name,price,date}]
    const sorted = [...orders].sort((a,b) => (b.date||"").localeCompare(a.date||""));
    for (const o of sorted) {
        const cid = o.clientId || ('name:' + (o.clientName || ''));
        if (!cid) continue;
        if (!tmp[cid]) tmp[cid] = { seen:{}, list:[] };
        for (const it of (o.items||[])) {
            if (!tmp[cid].seen[it.name]) {
                tmp[cid].seen[it.name] = true;
                tmp[cid].list.push({ name:it.name, price:it.price, date:o.date });
            }
        }
    }
    _clientItemsCache = {};
    for (const cid in tmp) _clientItemsCache[cid] = tmp[cid].list.slice(0, 10);
    return _clientItemsCache;
}

let histPayFilter = 'all';
let histSortMode  = 'date'; // 'date' | 'client' | 'recent'
let settleFilter  = 'all';
let settleListVisible = false;  // 기본값 숨기기
let settleUnit = 'monthly'; // 'monthly' | 'daily' | 'quarterly'
let clientListVisible = false;  // 기본값 숨기기 (복구/동기화 후 즉시 반영)
let showHiddenClients = false; // 숨긴 거래처 포함 표시 여부


// Firebase
let workspaceRef = null;
let isConnected  = false;
let _initialLoadDone = false;  // 전역 선언 — _fbValueHandler에서 접근 가능
const SESSION_ID = Math.random().toString(36).slice(2);
let lastHash = { clients:'', orders:'', prices:'', stock:'' };

// ─── Delta sync 트래킹 ───
// 변경된 order id만 추적 → debouncedSync에서 건별 업로드 (payload 최소화)
const _dirtyOrders   = new Set(); // 변경/추가된 order id
const _deletedOrders = new Set(); // 삭제된 order id
function _markDirtyOrder(id)   { _dirtyOrders.add(String(id));   _deletedOrders.delete(String(id)); }
function _markDeletedOrder(id) { _deletedOrders.add(String(id)); _dirtyOrders.delete(String(id)); }
function _clearOrderDelta()    { _dirtyOrders.clear(); _deletedOrders.clear(); }

// ─── 동기화 가드 플래그 ───
// _syncGuard: debouncedSync 업로드가 진행 중일 때 true
//   → 리스너가 업로드 응답 echo를 받아 로컬 데이터를 덮어쓰는 것을 차단
let _syncGuard = false;
let _pendingFbSnap = null;   // _syncGuard 중 도착한 타기기 변경 스냅샷 (처리 보류)
let _rtPollTimer   = null;   // 실시간 폴링 백업 타이머
// _connectGuard: _doConnect의 초기 .get() 처리가 완료되기 전 true
//   → .on() 리스너가 먼저 실행되는 레이스 컨디션 방지
let _connectGuard = false;

// ─── Firebase 데이터 정규화 헬퍼 ───
// Firebase에서 받은 raw 데이터를 앱 내부 포맷으로 변환 (4곳 공통 사용)
function _normClientFromFb(c) {
    if (!c.id) c.id = _uid();
    c.id = String(c.id);
    if (!c.note && c.memo) c.note = c.memo;
    if (!c.note) c.note = '';
    if (c.isHidden === undefined) c.isHidden = false;
    return c;
}
function _normOrderFromFb(o) {
    if (!o.id) o.id = _uid();
    o.id = String(o.id);
    o.total = Number(o.total ?? o.totalAmount ?? 0);
    if (!o.clientName && o.client) o.clientName = o.client;
    if (!Array.isArray(o.items)) o.items = [];
    if (!o.note && o.memo) o.note = o.memo;
    if (!o.note) o.note = '';
    // isVoid: Firebase에서 undefined로 오면 명시적으로 false 처리
    if (!o.isVoid) o.isVoid = false;
    // date: undefined이면 startsWith() 호출 시 TypeError 방지
    if (!o.date) o.date = '';
    return o;
}

// ─── Firebase 실시간 리스너 핸들러 (workspaceRef.on('value', ...) 공용) ───
function _fbValueHandler(snap) {
    try {
        const d = snap.val();
        if (!d) return;
        if (!_initialLoadDone) return;  // 초기 .get() 처리 전 차단
        if (_connectGuard)     return;  // 초기 연결 중 레이스 컨디션 차단
        if (d.writtenBy === SESSION_ID) return; // 자기 자신이 올린 echo 차단

        // ★ _syncGuard 중 도착한 타기기 변경 → 버리지 않고 보류, 업로드 완료 후 처리
        if (_syncGuard) { _pendingFbSnap = snap; return; }

        // ★ writtenBy가 명시된 경우(현행 앱): 다른 세션이면 무조건 수락
        //   writtenBy 없는 구버전 데이터만 timestamp 비교로 stale 여부 판단
        //   (이 체크를 제거하지 않으면 기기 간 시계 오차로 결제 변경이 차단됨)
        if (!d.writtenBy) {
            const serverUpdatedAt = d.lastUpdated ? new Date(d.lastUpdated).getTime() : 0;
            const lastLocalMs = (() => {
                const s = localStorage.getItem('lastLocalUpdated');
                return s ? new Date(s).getTime() : 0;
            })();
            const localWriteMs = Math.max(_localWriteTime, lastLocalMs);
            const RECENT_WINDOW_MS = 8_000;
            if (localWriteMs > 0 && localWriteMs >= serverUpdatedAt &&
                (Date.now() - localWriteMs) < RECENT_WINDOW_MS) return;
        }

        let changed = false;
        if (d.clients) {
            const inc = toArray(d.clients).map(_normClientFromFb);
            const h = dataHash(inc);
            if (h !== lastHash.clients) { clients = inc; lastHash.clients = h; changed = true; }
        }
        if (d.orders) {
            const inc = toArray(d.orders).map(_normOrderFromFb);
            const h = dataHash(inc);
            if (h !== lastHash.orders) { orders = inc; lastHash.orders = h; changed = true; }
        }
        if (d.prices) {
            const h = dataHash(d.prices);
            if (h !== lastHash.prices) { prices = d.prices; lastHash.prices = h; }
        }
        if (d.stockItems) {
            const inc = toArray(d.stockItems).map(normStock);
            const h = dataHash(inc);
            if (h !== lastHash.stock) { stockItems = inc; lastHash.stock = h; changed = true; }
        }
        if (changed) {
            saveToLocal();
            _fullRender();
            setSyncStatus('online');
            toast('🔄 다른 기기에서 변경된 내용이 반영됐습니다', 'var(--accent)', 2500);
        }
    } catch(e) {
        console.error('[_fbValueHandler] 처리 중 오류:', e);
        // 오류가 발생해도 리스너는 유지됨 — 다음 이벤트에서 재시도
    }
}
let _localWriteTime = 0; // 로컬 변경 시각 — Firebase 리스너 경쟁 방지용
let backupDirHandle = null;  // File System Access API 디렉토리 핸들

// ╔══════════════════════════════════════════════════════════════╗
// ║  § 3  로컬 저장 + Firebase 동기화 트리거                               ║
// ╚══════════════════════════════════════════════════════════════╝

// ─── localStorage 변경 감지용 해시 캐시 ───
const _localHash = { clients: null, orders: null, prices: null, stock: null };

function saveToLocal() {
    // → isConnected가 아직 false여도 경량 저장으로 용량 절약
    const hasWorkspace = !!(localStorage.getItem('workspaceId'));
    const useLightMode = isConnected || hasWorkspace;
    try {
        const ordersToSave = useLightMode ? _getLightOrders() : orders.map(_minifyOrder);
        const stockToSave  = useLightMode ? _getLightStock()  : stockItems;
        _cleanPrices();
        localStorage.setItem('p_clients', JSON.stringify(clients.map(_minifyClient)));
        localStorage.setItem('p_orders',  JSON.stringify(ordersToSave));
        localStorage.setItem('prices',    JSON.stringify(prices));
        localStorage.setItem('p_stock',   JSON.stringify(stockToSave));
    } catch(e) {
        // ── 자동 긴급 정리: 기존 키 먼저 제거 → 공간 확보 → 경량 재저장 ──
        toast('⚠️ 저장공간 부족 → 자동 정리 중...', 'var(--orange)');
        try {
            // 1단계: 기존 대용량 키 제거로 공간 확보 (데이터는 메모리에 있음)
            localStorage.removeItem('p_orders');
            localStorage.removeItem('p_stock');
            // 2단계: 저장용 임시 배열만 필터링 — 메모리(orders/stockItems)는 절대 변경 안 함
            const cutoff = _kstMonthsAgo(6);
            const lightOrdersForSave = orders
                .filter(o => !(o.isPaid && o.date < cutoff))
                .map(o => {
                    const m = _minifyOrder(o);
                    const cutoff1m = _kstMonthsAgo(1);
                    if (o.isPaid && o.date < cutoff1m) { delete m.items; m._noItems = 1; }
                    return m;
                });
            const lightStockForSave = stockItems.map(si => ({
                ...si,
                log: _trimLogByDate(si.log)
            }));
            const removed = orders.length - lightOrdersForSave.length;
            // 3단계: 경량 데이터로 재저장
            localStorage.setItem('p_clients', JSON.stringify(clients.map(_minifyClient)));
            localStorage.setItem('p_orders',  JSON.stringify(lightOrdersForSave));
            localStorage.setItem('prices',    JSON.stringify(prices));
            localStorage.setItem('p_stock',   JSON.stringify(lightStockForSave));
            toast(`✅ 자동 정리 완료 — 저장용 전표 ${removed}건 축소, 재고 이력 축소 (메모리 유지)`, 'var(--green)');
            if (typeof updateStorageBar === 'function') updateStorageBar();
        } catch(e2) {
            // 최후 수단: 전체 앱 키 삭제 후 경량 재저장
            try {
                ['p_clients','p_orders','prices','p_stock'].forEach(k => localStorage.removeItem(k));
                localStorage.setItem('p_clients', JSON.stringify(clients.map(_minifyClient)));
                localStorage.setItem('p_orders',  JSON.stringify(_getLightOrders()));
                localStorage.setItem('prices',    JSON.stringify(prices));
                localStorage.setItem('p_stock',   JSON.stringify(_getLightStock()));
                toast('✅ 긴급 정리 완료. Firebase에서 전체 데이터를 복원합니다.', 'var(--green)');
            } catch(e3) {
                toast('⚠️ 저장 실패: 설정 탭 > 저장공간 관리에서 직접 정리해 주세요.', 'var(--red)');
            }
        }
    }
}

// ── 품목 목록 표시용 헬퍼 (오프라인 _noItems 전표 안내 포함) ──
function _fmtItems(o) {
    if (!(o.items||[]).length) return '<span style="color:var(--text3);font-size:10px;">📡 온라인 시 표시</span>';
    return (o.items||[]).map(i=>`${i.name}(${i.qty})`).join(', ');
}

// ② createdAt/updatedAt 단축: "YYYY-MM-DDTHH:MM:SS.mmmZ" → "YYYY-MM-DDTHH:MM" (16자, ~8자 절감)
// 값이 없으면 null 반환 → 호출부에서 if(ts) 로 생략 처리
function _compactTs(ts) {
    if (!ts) return null;
    const s = String(ts).slice(0, 16);
    return s.length >= 10 ? s : null;  // 최소 날짜 형식(10자) 미만이면 무효
}

// ① it.total 중복 제거: qty×price 로 항상 복원 가능 → 저장 시 제외
function _minifyItem(it) {
    return { name: it.name, qty: it.qty, price: it.price };
}

function _minifyOrder(o) {
    // totalAmount = total 항상 동일 → 제거
    // memo → note 이관 완료 → 제거
    // client → clientName 이관 완료 → 제거
    // note/paidAt/paidAmount/paidNote: 값 있을 때만 포함
    // it.total: qty×price 복원 가능 → 제거 (① 최적화)
    // createdAt/updatedAt: 16자로 단축 (② 최적화)
    const r = {
        id: o.id,
        clientId: o.clientId,
        clientName: o.clientName,
        date: o.date,
        total: o.total,
        isPaid: o.isPaid,
        items: Array.isArray(o.items) ? o.items.map(_minifyItem) : [],
    };
    const ca = _compactTs(o.createdAt);
    if (ca)            r.createdAt  = ca;
    if (o.note)        r.note       = o.note;       // ③ 빈 값 저장 방지
    if (o.paidAmount != null && o.paidAmount !== 0) r.paidAmount = o.paidAmount;
    if (o.paidMethod)  r.paidMethod = o.paidMethod;
    if (o.paidMethodDetail) r.paidMethodDetail = o.paidMethodDetail;
    if (o.paidAt)      r.paidAt     = o.paidAt;
    if (o.paidNote)    r.paidNote   = o.paidNote;
    if (o.discount)    r.discount   = o.discount;  // 할인 완납 금액
    if (o.isVoid)      r.isVoid     = true;         // 타인거래
    const ua = _compactTs(o.updatedAt);
    if (ua)            r.updatedAt  = ua;
    return r;
}

function _minifyClient(c) {
    // isHidden: false(기본)는 생략, true일 때만 저장 (용량 절약)
    // memo → note 이관 완료 → 제거
    const r = {
        id: c.id,
        name: c.name,
    };
    const ca = _compactTs(c.createdAt);
    if (ca)          r.createdAt = ca;
    if (c.phone)     r.phone     = c.phone;
    if (c.address)   r.address   = c.address;
    if (c.note)      r.note      = c.note;
    if (c.isHidden)  r.isHidden  = true;   // true일 때만 저장 (false는 기본값이므로 생략)
    const ua = _compactTs(c.updatedAt);
    if (ua)          r.updatedAt = ua;
    return r;
}

// ④ prices 오래된 단가 정리: 최근 6개월 미사용 품목 제거
function _cleanPrices() {
    const cutoff = _kstMonthsAgo(6);
    const usedNames = new Set();
    for (const o of orders) {
        if (o.date >= cutoff) {
            for (const it of (o.items||[])) if (it.name) usedNames.add(it.name);
        }
    }
    const cleaned = {};
    for (const [k, v] of Object.entries(prices)) {
        if (usedNames.has(k)) cleaned[k] = v;
    }
    prices = cleaned;
}

// Firebase 연결 중 로컬 저장용 경량 전표 (완납+3개월 이상 제외 + 필드 최소화)

function _getLightOrders() {
    const cutoff = _kstMonthsAgo(3);
    // 완납+1개월 이상 전표는 items 배열 제거 (Firebase에서 복원 가능)
    const cutoff1m = _kstMonthsAgo(1);
    return orders
        .filter(o => !o.isPaid || o.date >= cutoff)
        .map(o => {
            const m = _minifyOrder(o);
            // 완납 + 1개월 초과: items 제거 (합계는 total로 유지)
            if (o.isPaid && o.date < cutoff1m) {
                delete m.items;
                m._noItems = 1; // 오프라인 시 UI에서 안내 표시용 플래그
            }
            return m;
        });
}

// Firebase 연결 중 로컬 저장용 경량 재고 (어제·오늘 이력만 유지)

function _getLightStock() {
    return stockItems.map(si => ({
        ...si,
        log: _trimLogByDate(si.log)
    }));
}

// ── 백업 데이터 공통 정규화 함수 (importJSON & restoreBackup 공유) ──

function normalizeBackupData(data) {
    const imp_clients = toArray(data.clients);
    const imp_orders  = toArray(data.orders);

    const clients_out = imp_clients.map(c => {
        if (!c.id) c.id = _uid();
        c.id = String(c.id);                          // int id → string 타입 통일
        if (!c.note && c.memo) c.note = c.memo;       // memo → note 이관
        if (!c.note) c.note = '';
        if (c.isHidden === undefined) c.isHidden = false;
        return c;
    });

    const orders_out = imp_orders.map(o => {
        if (!o.id) o.id = _uid();
        o.id = String(o.id);                          // int id → string 타입 통일 (clients와 동일)
        if (o.clientId !== undefined) o.clientId = String(o.clientId); // int→string
        // totalAmount=0이지만 items 합계가 있으면 items 기준으로 복원
        const itemsSum = (o.items||[]).reduce((s,i) => s + Number(i.total ?? (i.qty*i.price) ?? 0), 0);
        o.total = Number(o.total ?? o.totalAmount ?? 0);
        if (o.total === 0 && itemsSum > 0) o.total = itemsSum;
        o.totalAmount = o.total;
        if (!Array.isArray(o.items)) o.items = [];  // items 누락 방어
        // it.total 복원 (v41 이후 백업은 total 필드 없음 → qty×price로 복원)
        o.items = o.items.map(it => ({
            ...it,
            name: (it.name||'').trim(),
            total: it.total ?? (Number(it.qty)||0) * (Number(it.price)||0)
        }));
        if (!o.clientName && o.client) o.clientName = o.client;
        if (!o.note && o.memo) o.note = o.memo;       // memo → note 이관
        if (!o.note) o.note = '';
        if (!o.isVoid) o.isVoid = false;              // isVoid 복원 (없으면 false)
        return o;
    });

    // clientId가 없는 전표는 clientName으로 재매핑
    // clientId가 있는 전표는 현재 거래처명과 다를 경우 자동 보정 (거래처명 변경 후 미반영 복구)
    const clientIdSet = new Set(clients_out.map(c => c.id));
    const clientIdMap  = {};
    clients_out.forEach(c => { clientIdMap[c.id] = c; });
    orders_out.forEach(o => {
        if (!o.clientId || !clientIdSet.has(o.clientId)) {
            const found = clients_out.find(c => c.name === (o.clientName || '').trim());
            if (found) { o.clientId = found.id; o.clientName = found.name; }
        } else {
            // clientId 일치하는 거래처가 있으면 이름을 현재 거래처명으로 보정
            const linked = clientIdMap[o.clientId];
            if (linked && linked.name !== o.clientName) {
                o.clientName = linked.name;
            }
        }
    });

    const stock_out = toArray(data.stockItems || data.stock || []).map(si => si ? {
        id: si.id || _uid(), name: si.name || '', qty: Number(si.qty ?? 0),
        unit: si.unit || '개', low: Number(si.low ?? 10), danger: Number(si.danger ?? 3),
        note: si.note || '', log: Array.isArray(si.log) ? si.log : [],
        updatedAt: si.updatedAt || new Date().toISOString()
    } : null).filter(Boolean);
    return { clients: clients_out, orders: orders_out, stockItems: stock_out };
}

const debouncedSync = debounce(() => {
    if (!workspaceRef || !isConnected) return;  // 오프라인이거나 미연결 시 즉시 중단
    const ch = dataHash(clients);
    const oh = dataHash(orders);
    const ph = dataHash(prices);
    const sh = dataHash(stockItems);
    let changed = false;
    const updates = {};
    if (ch !== lastHash.clients) { updates.clients    = clients.map(_minifyClient); changed = true; }
    if (oh !== lastHash.orders)  {
        const _nd = _dirtyOrders.size + _deletedOrders.size;
        if (_nd > 0 && _nd < 20) {
            // delta: 변경된 항목만 개별 경로 업로드 (전체 배열 대신 orders/{id} 경로)
            for (const id of _dirtyOrders)   { const o = orders.find(x=>x.id===id); if (o) updates[`orders/${id}`] = _minifyOrder(o); }
            for (const id of _deletedOrders) { updates[`orders/${id}`] = null; } // null = RTDB 삭제
        } else {
            // full: bulk 작업·첫 동기화 시 전체 map 업로드 (배열→맵 마이그레이션 포함)
            const ordersMap = {};
            orders.forEach(o => { ordersMap[o.id] = _minifyOrder(o); });
            updates.orders = ordersMap;
        }
        changed = true;
    }
    if (ph !== lastHash.prices)  { updates.prices     = prices;     changed = true; }
    if (sh !== lastHash.stock)   { updates.stockItems = _getLightStock(); changed = true; }
    if (!changed) return;
    // writtenBy를 데이터와 함께 업로드 — 리스너가 자기 업데이트를 정확히 무시하도록
    updates.lastUpdated = new Date().toISOString();
    updates.writtenBy   = SESSION_ID;
    // ★ Problem 3 수정: 업로드 전에 dirty set을 스냅샷으로 복사해 두고
    //   실패 시 해당 id들을 다시 dirty로 복원 → 재시도 시 누락 방지
    const dirtySnap   = new Set(_dirtyOrders);
    const deletedSnap = new Set(_deletedOrders);
    // ★ Problem 2 수정: 업로드 진행 중에는 리스너가 echo를 덮어쓰지 못하도록 가드 설정
    _syncGuard = true;
    // ★ 업로드 직전 lastHash 선점 갱신 → 리스너 echo 수신 시 hash 일치로 무시
    if (updates.clients)    lastHash.clients = ch;
    if (updates.orders)     lastHash.orders  = oh;
    if (updates.prices)     lastHash.prices  = ph;
    if (updates.stockItems) lastHash.stock   = sh;
    setSyncStatus('syncing');
    workspaceRef.update(updates)
        .then(() => {
            _clearOrderDelta(); // 성공 시 delta 추적 초기화
            _syncGuard = false;
            setSyncStatus('online');
            // ★ 업로드 중 보류됐던 타기기 변경 처리
            if (_pendingFbSnap) { const s = _pendingFbSnap; _pendingFbSnap = null; _fbValueHandler(s); }
        })
        .catch(e => {
            // 실패 시 lastHash 롤백 → 다음 saveData() 때 재시도
            if (updates.clients)    lastHash.clients = '';
            if (updates.orders)     lastHash.orders  = '';
            if (updates.prices)     lastHash.prices  = '';
            if (updates.stockItems) lastHash.stock   = '';
            // ★ Problem 3 수정: 스냅샷된 dirty/deleted id 복원
            dirtySnap.forEach(id   => _dirtyOrders.add(id));
            deletedSnap.forEach(id => _deletedOrders.add(id));
            _syncGuard = false;
            console.error('동기화 실패:', e);
            setSyncStatus('error');
            // ★ 업로드 실패해도 보류됐던 타기기 변경 처리
            if (_pendingFbSnap) { const s = _pendingFbSnap; _pendingFbSnap = null; _fbValueHandler(s); }
        });
}, 800);

// ─── 금액 입력 필드 콤마 자동 포매터 ───────────────────────────────────────
// 금액 필드: itemPrice / ppAmount / ppTransferAmt / ppCashAmt
//           peAmount / oeditNewPrice / qpDiscountAmt

/** 금액 input 엘리먼트에 콤마 포매팅 초기화 */
function _initMoneyInput(el) {
    if (!el || el.dataset.moneyInited) return;
    el.dataset.moneyInited = '1';

    // el을 클로저로 직접 참조 (this 바인딩 문제 방지)
    function applyFormat() {
        const raw = el.value.replace(/[^0-9]/g, '');
        if (!raw) { el.value = ''; return; }
        const formatted = Number(raw).toLocaleString('ko-KR');
        if (el.value !== formatted) {
            el.value = formatted;
            try { el.setSelectionRange(formatted.length, formatted.length); } catch(e) {}
        }
    }

    // input: 일반 입력 / keyup: 안드로이드 IME 누락 보완 / change: 포커스 아웃 시 최종 보정
    el.addEventListener('input',  applyFormat);
    el.addEventListener('keyup',  applyFormat);
    el.addEventListener('change', applyFormat);

    el.addEventListener('focus', function () {
        setTimeout(() => { try { el.select(); } catch(e) {} }, 0);
    });
}

/** data-money 속성 가진 모든 필드에 일괄 초기화 */
function _initAllMoneyInputs() {
    document.querySelectorAll('[data-money]').forEach(_initMoneyInput);
}

/** 금액 input에서 순수 숫자 추출 */
function _moneyVal(id) {
    const el = document.getElementById(id);
    if (!el) return 0;
    return parseInt(el.value.replace(/[^0-9]/g, ''), 10) || 0;
}

/** 금액 input에 숫자를 콤마 포맷으로 세팅 */
function _setMoneyVal(id, num) {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = (num > 0) ? Number(num).toLocaleString('ko-KR') : '';
}

// ─── settlement / stock / unpaid 탭 조건부 즉시 렌더 헬퍼 ───
// 각 함수에서 반복되던 동일 패턴을 하나로 통합
function _refreshSettlementIfActive() {
    _markDirty('settlement');
    if (document.getElementById('pane-settlement')?.classList.contains('active')) {
        _dirty['settlement'] = false;
        if (settleUnit === 'monthly')   renderSettlement();
        if (settleUnit === 'daily')     renderSettlementDaily();
        if (settleUnit === 'quarterly') renderSettlementQuarterly();
    }
}
function _refreshStockIfActive() {
    _markDirty('stock');
    if (document.getElementById('pane-stock')?.classList.contains('active')) {
        renderStock(); _dirty['stock'] = false;
    }
}
function _refreshUnpaidIfActive() {
    if (document.getElementById('pane-unpaid')?.classList.contains('active')) renderUnpaid();
}

// ─── 메모 즉시 동기화 헬퍼 (메모 저장/삭제 공통 패턴) ───
function _saveAndFlush() {
    saveData();
    debouncedSync.cancel();
    _flushSync();
    saveToLocal();
}

function saveData() {
    invalidateOrdersCache();
    _localWriteTime = Date.now();
    localStorage.setItem('lastLocalUpdated', new Date().toISOString()); // 로컬 변경 시각 기록
    saveToLocal();
    if (isConnected) debouncedSync();
    _markDirty('dashboard','clients','unpaid','delivery','history','settlement','settings');
    _renderActiveIfDirty();
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  § 5  UI 코어 — toast · 테마 · 탭 · 모달 · 바텀네비                     ║
// ╚══════════════════════════════════════════════════════════════╝

// ════════════════════════════════════════════════════════════════
// § 4  부분 렌더링 엔진
// ════════════════════════════════════════════════════════════════
// 탭별 더티 플래그: true = 데이터 변경됨 → 탭 진입 시 렌더링 실행
// 불필요한 DOM 재계산·페인트 제거
// Firebase 동기화 콜백(_fullRender)은 전체 더티 → 현재 탭만 즉시 렌더
// ────────────────────────────────────────────────────────────────
const _dirty = {
    dashboard:  true,
    clients:    true,
    delivery:   true,
    history:    true,
    stock:      true,
    settlement: true,
    unpaid:     true,
    // backup·settings 는 _dirty 미포함 → 탭 진입 시 항상 렌더
};

// 하나 이상의 탭을 더티 마킹 (인수 없으면 전체 더티)
function _markDirty(...tabs) {
    const keys = tabs.length ? tabs : Object.keys(_dirty);
    keys.forEach(t => { if (t in _dirty) _dirty[t] = true; });
}

// 탭 이름으로 렌더링 실행
function _renderTab(name) {
    if      (name === 'dashboard') {
        renderDashboard();
    } else if (name === 'clients') {
        const cl = document.getElementById('clientList');
        const tb = document.getElementById('clientToggleBtn');
        if (cl) cl.style.display = clientListVisible ? 'block' : 'none';
        if (tb) tb.textContent   = clientListVisible ? '숨기기' : '보이기';
        renderClients();
    } else if (name === 'delivery') {
        updateItemDatalist();
        renderTempGroups();
    } else if (name === 'history') {
        renderOrders();
    } else if (name === 'stock') {
        applyAutoDeductUI();
        checkEggInitBanner();
        renderStock();
    } else if (name === 'settlement') {
        const st = document.getElementById('settlementTable');
        const sb = document.getElementById('settleToggleBtn');
        if (st) st.style.display = settleListVisible ? 'block' : 'none';
        if (sb) sb.textContent   = settleListVisible ? '숨기기' : '보이기';
        if (settleUnit === 'monthly')   renderSettlement();
        if (settleUnit === 'daily')     renderSettlementDaily();
        if (settleUnit === 'quarterly') renderSettlementQuarterly();
    } else if (name === 'unpaid') {
        renderUnpaid();
    } else if (name === 'backup') {
        renderBackupTab();
    } else if (name === 'settings') {
        updateInfoCounts();
        setTimeout(updateStorageBar, 100);
    }
}

// 현재 활성 탭이 더티면 즉시 렌더 (_dirty 미포함 탭은 항상 렌더)
function _renderActiveIfDirty() {
    const active = document.querySelector('.pane.active')
                   ?.id?.replace('pane-', '') || 'dashboard';
    const isDirty = !(active in _dirty) || _dirty[active];
    if (!isDirty) return;
    _renderTab(active);
    if (active in _dirty) _dirty[active] = false;
}

function toast(msg, color, duration) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.style.borderColor = color || 'var(--border)';
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), duration || 2400);
}

// ─── 테마 ───

function applyTheme() {
    // 레거시 darkMode 키 마이그레이션
    const legacyDark = localStorage.getItem('darkMode');
    if (legacyDark !== null && localStorage.getItem('theme') === null) {
        if (legacyDark === '0') localStorage.setItem('theme', 'light');
        // darkMode='1'은 기본(dark)이므로 별도 설정 불필요
    }
    const theme = localStorage.getItem('theme');
    const isLight = theme === 'light';
    const isDarkOverride = theme === 'dark';
    document.body.classList.toggle('light', isLight);
    // OS가 라이트모드일 때 사용자가 다크를 명시 선택한 경우 CSS 미디어쿼리 충돌 방지
    document.body.classList.toggle('theme-override-dark', isDarkOverride);
    document.getElementById('themeBtn').textContent = isLight ? '🌙' : '☀️';
}

function toggleTheme() {
    const isLight = document.body.classList.toggle('light');
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
    // 다크 선택 시 OS 라이트모드 CSS 미디어쿼리 충돌 방지 클래스 토글
    document.body.classList.toggle('theme-override-dark', !isLight);
    document.getElementById('themeBtn').textContent = isLight ? '🌙' : '☀️';
}

// ─── 탭 ───

function showTab(name) {
    document.querySelectorAll('.tab, .pane').forEach(el => el.classList.remove('active'));
    const tab  = document.querySelector(`.tab[data-tab="${name}"]`);
    const pane = document.getElementById('pane-' + name);
    if (tab)  { tab.classList.add('active'); tab.scrollIntoView({behavior:'smooth',inline:'center',block:'nearest'}); }
    if (pane) pane.classList.add('active');
    const content = document.getElementById('mainContent');
    if (content) content.scrollTop = 0;

    // ── 탭별 UI 상태 동기화 (렌더링과 별개) ──────────────────────
    if (name === 'delivery') {
        const dInput = document.getElementById('deliveryDate');
        if (!dInput.value || dInput.value < todayKST()) dInput.value = todayKST();
    }
    if (name === 'history') {
        initHistPeriod();
        document.querySelectorAll('#pane-history .sort-btn').forEach(b => {
            b.classList.toggle('active',
                b.id === 'histSort' + histSortMode.charAt(0).toUpperCase() + histSortMode.slice(1));
        });
    }
    if (name === 'clients') {
        const cl = document.getElementById('clientList');
        const tb = document.getElementById('clientToggleBtn');
        if (cl) cl.style.display = clientListVisible ? 'block' : 'none';
        if (tb) tb.textContent   = clientListVisible ? '숨기기' : '보이기';
    }
    if (name === 'settlement') {
        const st = document.getElementById('settlementTable');
        const sb = document.getElementById('settleToggleBtn');
        if (st) st.style.display = settleListVisible ? 'block' : 'none';
        if (sb) sb.textContent   = settleListVisible ? '숨기기' : '보이기';
    }
    if (name === 'stock') {
        const sdInput = document.getElementById('stockViewDate');
        if (sdInput && !sdInput.value) sdInput.value = todayKST();
        refreshStockCarryover(true);  // 재고 이월은 정합성상 항상 실행
        // refreshStockCarryover가 항상 renderStock()을 호출하므로 dirty 해제
        _dirty['stock'] = false;
    }

    // ── 더티 플래그 체크 → 변경 있을 때만 렌더링 ─────────────────
    // _dirty 미포함 탭(backup, settings)은 항상 렌더
    if (!(name in _dirty) || _dirty[name] !== false) {
        _renderTab(name);
        if (name in _dirty) _dirty[name] = false;
    }
}

function initTabs() {
    document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => showTab(btn.dataset.tab)));
}

// ─── 모달 열기/닫기 (뒤로가기 버튼 지원 포함) ───
let _modalHistoryPushed = false;

const _MODAL_IDS = [
    'payEditModal','partialPayModal',
    'firebaseModal','detailModal','statementModal',
    'clientEditModal','orderEditModal',
    'stockEditModal','stockAdjModal','stockLogModal',
    'bulkPayPopup','deliveryConfirmPopup',
    'customConfirmModal'
];

function _anyModalOpen() {
    return _MODAL_IDS.some(id => document.getElementById(id)?.classList.contains('open'));
}

function openModal(id)  {
    const el = document.getElementById(id);
    el.classList.add('open');
    // 모달 시트 스크롤 항상 맨 위로 초기화
    const sheet = el.querySelector('.modal-sheet');
    if (sheet) sheet.scrollTop = 0;
    if (id === 'firebaseModal') applyWsLockUI();
    if (!_modalHistoryPushed) {
        history.pushState({ modalOpen: true }, '');
        _modalHistoryPushed = true;
    }
    // 모달 내 금액 필드 콤마 포매터 초기화 (동적 생성 필드 대비)
    el.querySelectorAll('[data-money]').forEach(_initMoneyInput);
}

function closeModal(id) {
    document.getElementById(id).classList.remove('open');
    if (!_anyModalOpen()) _modalHistoryPushed = false;
}

// 브라우저/안드로이드 이전(뒤로가기) 버튼 → 최상위 모달 닫기
window.addEventListener('popstate', () => {
    _modalHistoryPushed = false;
    // 메모 상세 팝업 (더 안쪽 레이어이므로 먼저 처리)
    if (document.getElementById('memoDetailPopup')?.classList.contains('open')) { closeMemoDetail(); return; }
    // 메모 모아보기 팝업
    if (document.getElementById('memoViewPopup')?.classList.contains('open'))   { closeMemoView();   return; }
    // 더보기 시트
    if (document.getElementById('moreSheetOverlay')?.classList.contains('open')) { closeMoreSheet(); return; }
    // 퀵페이 팝업류 전용 처리
    if (document.getElementById('bulkPayPopup')?.classList.contains('open'))      { closeBulkPayPopup(); return; }
    if (document.getElementById('deliveryConfirmPopup')?.classList.contains('open')) { closeDeliveryConfirm(); return; }
    if (document.getElementById('quickPayPopup')?.classList.contains('open'))     { closeQuickPay(); return; }
    for (const id of _MODAL_IDS) {
        const el = document.getElementById(id);
        if (el?.classList.contains('open')) {
            el.classList.remove('open');
            if (_anyModalOpen()) {
                history.pushState({ modalOpen: true }, '');
                _modalHistoryPushed = true;
            }
            return;
        }
    }
    history.back();
});

// 모달 외부 클릭 닫기 + 드롭다운 외부 클릭 닫기 (통합 핸들러)
document.addEventListener('click', e => {
    // 모달 오버레이 직접 클릭 시 닫기
    ['firebaseModal','detailModal','statementModal','partialPayModal','payEditModal','clientEditModal','orderEditModal','stockEditModal','stockAdjModal','stockLogModal'].forEach(id => {
        const el = document.getElementById(id);
        if (el && e.target === el) closeModal(id);
    });
    // 납품 거래처 드롭다운 외부 클릭 시 닫기
    if (!e.target.closest('#deliveryClient') && !e.target.closest('#clientDropdown'))
        document.getElementById('clientDropdown')?.classList.remove('open');
    // 거래처 카드 툴팁 외부 클릭 시 닫기
    if (!e.target.closest('.client-card'))
        document.querySelectorAll('.client-card.show-tooltip').forEach(el => el.classList.remove('show-tooltip'));
});

// ─── 바텀 네비 ───

function bnavGo(tab, btnEl) {
    showTab(tab);
    // 바텀 네비 active 상태 업데이트
    updateBnavActive(tab);
    // 햅틱 피드백
    if (navigator.vibrate) navigator.vibrate(8);
}

function updateBnavActive(tab) {
    document.querySelectorAll('.bnav-item[data-tab]').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === tab);
    });
    // 더보기에 속한 탭이면 더보기 버튼 하이라이트
    const moreTabs = ['stock','settlement','backup','settings'];
    const moreBtn = document.querySelector('.bnav-item[data-tab="_more"]');
    if (moreBtn) moreBtn.classList.toggle('active', moreTabs.includes(tab));
}

function openMoreSheet() {
    const overlay = document.getElementById('moreSheetOverlay');
    overlay.classList.add('open');
    // 현재 탭 표시
    const activePane = document.querySelector('.pane.active');
    const currentTab = activePane?.id?.replace('pane-', '') || '';
    overlay.querySelectorAll('.more-item').forEach(item => {
        const tabName = item.getAttribute('onclick')?.match(/bnavGo\('(\w+)'/)?.[1];
        item.style.borderColor = tabName === currentTab ? 'var(--accent)' : 'var(--border)';
        item.style.color = tabName === currentTab ? 'var(--accent)' : '';
    });
    if (navigator.vibrate) navigator.vibrate(6);
    if (!_modalHistoryPushed) {
        history.pushState({ modalOpen: true }, '');
        _modalHistoryPushed = true;
    }
}

function closeMoreSheet() {
    document.getElementById('moreSheetOverlay').classList.remove('open');
}

// showTab 호출 시 바텀 네비 자동 동기화
showTab = _safeWrap(showTab, function(name) { updateBnavActive(name); });

// ─── 미수금 배지 업데이트 ───

function updateNavBadges() {
    // _clientStatsCache 활용 — orders 단일 순회로 모두 계산
    let unpaidCount = 0, totalUnpaid = 0, unpaidOrderCount = 0;
    const seen = new Set();
    for (const o of orders) {
        if (!o.isPaid) {
            unpaidOrderCount++;
            totalUnpaid += Math.max(0, o.total - (o.paidAmount || 0));
            seen.add(o.clientId || o.clientName);
        }
    }
    unpaidCount = seen.size;

    // 거래처 배지
    const bc = document.getElementById('bnavBadgeClients');
    if (bc) {
        if (unpaidCount > 0) {
            bc.textContent = unpaidCount > 99 ? '99+' : unpaidCount;
            bc.classList.add('visible');
        } else {
            bc.classList.remove('visible');
        }
    }
    // 내역 배지 (미수금 전표 수)
    const bh = document.getElementById('bnavBadgeHistory');
    if (bh) {
        if (unpaidOrderCount > 0) {
            bh.textContent = unpaidOrderCount > 99 ? '99+' : unpaidOrderCount;
            bh.classList.add('visible');
        } else {
            bh.classList.remove('visible');
        }
    }

    // 거래처 탭 미수금 알림 바
    const alertBar = document.getElementById('unpaidAlertBar');
    const alertSub = document.getElementById('unpaidAlertSub');
    if (alertBar && alertSub) {
        if (unpaidCount > 0) {
            alertBar.classList.add('visible');
            alertSub.textContent = `미수 거래처 ${unpaidCount}곳 · 총 ${fmt(totalUnpaid)}원`;
        } else {
            alertBar.classList.remove('visible');
        }
    }
    // 미수 탭 배지
    const bu = document.querySelector('.tab[data-tab="unpaid"]');
    if (bu) {
        bu.style.position = 'relative';
        let badgeEl = bu.querySelector('.tab-badge');
        if (!badgeEl) {
            badgeEl = document.createElement('span');
            badgeEl.className = 'tab-badge';
            badgeEl.style.cssText = 'position:absolute;top:2px;right:2px;min-width:14px;height:14px;line-height:14px;padding:0 3px;border-radius:7px;background:#ef4444;color:#fff;font-size:9px;font-weight:900;text-align:center;';
            bu.appendChild(badgeEl);
        }
        if (unpaidCount > 0) {
            badgeEl.textContent = unpaidCount > 99 ? '99+' : unpaidCount;
            badgeEl.style.display = 'block';
        } else {
            badgeEl.style.display = 'none';
        }
    }
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  § 6  거래처                                                    ║
// ╚══════════════════════════════════════════════════════════════╝

function checkDupClient() {
    const name = document.getElementById('clientName').value.trim();
    const warn = document.getElementById('dupWarn');
    const exists = clients.some(c => c.name.toLowerCase() === name.toLowerCase() && c.id !== editingClientId);
    warn.style.display = (name && exists) ? 'block' : 'none';
}

function saveClient() {
    const name    = document.getElementById('clientName').value.trim();
    const phone   = document.getElementById('clientPhone').value.trim();
    const address = document.getElementById('clientAddress').value.trim();
    const note    = document.getElementById('clientNote').value.trim();
    if (!name) return toast('❗ 거래처명을 입력하세요');
    const dup = clients.some(c => c.name.toLowerCase() === name.toLowerCase() && c.id !== editingClientId);
    if (dup) return toast('❗ 이미 존재하는 거래처입니다');
    if (editingClientId) {
        const c = clients.find(c => c.id === editingClientId);
        if (c) {
            const oldName = c.name;
            c.name=name; c.phone=phone; c.address=address; c.note=note; c.updatedAt=new Date().toISOString();
            // 거래처명이 변경된 경우 관련 전표 일괄 반영
            if (oldName !== name) {
                let orderCount = 0;
                const oldNameTrim = oldName.trim();
                orders.forEach(o => {
                    // clientId 일치 OR clientName 일치(공백 무시) OR clientId가 비어있고 이름 일치
                    const idMatch   = o.clientId && o.clientId === editingClientId;
                    const nameMatch = (o.clientName || '').trim() === oldNameTrim;
                    if (idMatch || nameMatch) {
                        o.clientName = name;
                        // clientId가 없거나 불일치하면 이 기회에 바로잡기
                        if (!o.clientId || o.clientId !== editingClientId) {
                            o.clientId = editingClientId;
                        }
                        _markDirtyOrder(o.id); // delta sync 마킹
                        orderCount++;
                    }
                });
                if (orderCount > 0) toast(`✅ 거래처 수정 완료 (전표 ${orderCount}건 반영)`, 'var(--green)');
                else toast('✅ 거래처 수정 완료', 'var(--green)');
            } else {
                toast('✅ 거래처 수정 완료', 'var(--green)');
            }
        }
    } else {
        clients.push({ id:_uid(), name, phone, address, note, isHidden:false, createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() });
        // ★ 로컬 변경 시각 갱신 → Firebase 리스너가 구 서버 데이터로 덮어쓰는 경쟁 방지
        _localWriteTime = Date.now();
        toast('✅ 거래처 등록 완료', 'var(--green)');
    }
    cancelClientEdit();
    saveData(); renderClients(); renderOrders(); updateInfoCounts(); renderDashboard(); updateNavBadges();
    _refreshSettlementIfActive();
}

function cancelClientEdit() {
    editingClientId = null;
    document.getElementById('clientName').value = '';
    document.getElementById('clientPhone').value = '';
    document.getElementById('clientAddress').value = '';
    document.getElementById('clientNote').value = '';
    document.getElementById('dupWarn').style.display = 'none';
    document.getElementById('clientFormTitle').textContent = '거래처 등록';
    document.getElementById('clientCancelBtn').style.display = 'none';
}

function editClient(id) {
    const c = clients.find(c => c.id === id);
    if (!c) return;
    editingClientId = id;
    document.getElementById('clientName').value    = c.name;
    document.getElementById('clientPhone').value   = c.phone || '';
    document.getElementById('clientAddress').value = c.address || '';
    document.getElementById('clientNote').value    = c.note || '';
    document.getElementById('clientFormTitle').textContent = '거래처 수정';
    document.getElementById('clientCancelBtn').style.display = 'block';
    document.getElementById('clientName').focus();
    document.getElementById('mainContent').scrollTop = 0;
}

async function deleteClient(id) {
    const c = clients.find(c => c.id === id);
    if (!c) return;
    const hasOrders = orders.some(o => o.clientId === id);
    const msg = hasOrders
        ? `'${c.name}'은 납품 내역이 있습니다.\n삭제할까요? (납품 내역은 유지됩니다)`
        : `'${c.name}'을 삭제할까요?`;
    if (!await customConfirm(msg)) return;
    clients = clients.filter(c => c.id !== id);
    saveData(); renderClients(); updateInfoCounts(); updateNavBadges();
    toast('🗑️ 삭제되었습니다');
}

function toggleClientList() {
    clientListVisible = !clientListVisible;
    document.getElementById('clientList').style.display = clientListVisible ? 'block' : 'none';
    document.getElementById('clientToggleBtn').textContent = clientListVisible ? '숨기기' : '보이기';
    renderClients();
}

function toggleShowHidden() {
    showHiddenClients = !showHiddenClients;
    const btn = document.getElementById('showHiddenBtn');
    if (btn) {
        btn.textContent = showHiddenClients ? '숨김제외' : '숨김포함';
        btn.style.color = showHiddenClients ? 'var(--orange)' : '';
        btn.style.borderColor = showHiddenClients ? 'var(--orange)' : '';
    }
    renderClients();
}

// 개별 거래처 숨기기/보이기 토글
function hideClient(id) {
    const c = clients.find(c => c.id === id);
    if (!c) return;
    c.isHidden = !c.isHidden;
    c.updatedAt = new Date().toISOString();
    saveData(); renderClients();
    toast(c.isHidden ? '🙈 거래처를 숨겼습니다' : '👁 거래처를 표시합니다');
}

let clientSortMode = 'name'; // 'name' | 'recent' | 'unpaid' | 'total'

function setClientSort(mode, btn) {
    clientSortMode = mode;
    document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderClients();
}

function renderClients() {
    const searchEl = document.getElementById('clientSearch');
    const q = searchEl ? searchEl.value : '';
    const statsMap = _buildClientStatsCache();
    const filtered = clients.filter(c => (showHiddenClients || !c.isHidden) && (matchSearch(c.name, q) || (c.phone && c.phone.includes(q))));

    filtered.sort((a,b) => {
        const sa = statsMap[a.id] || statsMap[a.name] || { count:0,total:0,unpaid:0,lastDate:'' };
        const sb = statsMap[b.id] || statsMap[b.name] || { count:0,total:0,unpaid:0,lastDate:'' };
        if (clientSortMode==='recent') return sb.lastDate.localeCompare(sa.lastDate);
        if (clientSortMode==='unpaid') return sb.unpaid - sa.unpaid;
        if (clientSortMode==='total')  return sb.total  - sa.total;
        return a.name.localeCompare(b.name, 'ko');
    });
    const el = document.getElementById('clientList');
    if (!el) return;

    if (!clientListVisible) {
        el.innerHTML = filtered.length === 0
            ? '<div class="empty"><div class="empty-icon">🏪</div><div class="empty-text">등록된 거래처가 없습니다</div></div>'
            : filtered.map(c => _clientCardHTML(c, statsMap, q)).join('');
        return;
    }

    if (!filtered.length) {
        el.innerHTML = '<div class="empty"><div class="empty-icon">🏪</div><div class="empty-text">등록된 거래처가 없습니다</div></div>';
        return;
    }
    el.innerHTML = filtered.map(c => _clientCardHTML(c, statsMap, q)).join('');
}

function _clientCardHTML(c, statsMap, q) {
    const stats     = statsMap[c.id] || statsMap[c.name] || { count:0, total:0, unpaid:0 };
    const unpaidAmt = stats.unpaid || 0;
    const safeId   = escapeAttr(c.id);
    const safeName = escapeAttr(c.name);
    // 미수금 경과일 계산 (가장 오래된 미수 전표 기준)
    let maxAgeDays = 0;
    if (unpaidAmt > 0) {
        const today = todayKST();
        orders.forEach(o => {
            if ((o.clientId === c.id || o.clientName === c.name) && !o.isPaid) {
                const days = Math.floor((new Date(today) - new Date(o.date)) / 86400000);
                if (days > maxAgeDays) maxAgeDays = days;
            }
        });
    }
    const ageCls = unpaidAmt <= 0 ? '' :
        maxAgeDays >= 90 ? 'has-unpaid unpaid-severe' :
        maxAgeDays >= 60 ? 'has-unpaid unpaid-danger' :
        maxAgeDays >= 30 ? 'has-unpaid unpaid-warn'   : 'has-unpaid unpaid-ok';
    const badgeCls = maxAgeDays >= 90 ? 'severe' : maxAgeDays >= 60 ? 'danger' : maxAgeDays >= 30 ? 'warn' : '';
    const ageLabel = unpaidAmt > 0
        ? (maxAgeDays >= 90 ? `🚨 ${maxAgeDays}일 경과` : maxAgeDays >= 60 ? `🔴 ${maxAgeDays}일 경과` : maxAgeDays >= 30 ? `🟠 ${maxAgeDays}일 경과` : `🟢 ${maxAgeDays}일 경과`)
        : '';

    // ── 오늘 납품한 거래처만: 가장 최근 메모 뱃지 ──
    const _todayStr = todayKST();
    const _hasTodayOrder = orders.some(o =>
        o.clientName === c.name && o.date === _todayStr);
    let lastMemoHtml = '';
    if (_hasTodayOrder) {
        const _lastMemo = orders
            .filter(o => o.clientName === c.name && o.note && o.note.trim())
            .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.id || '').localeCompare(a.id || ''))
            [0];
        if (_lastMemo) {
            const _dLabel  = _lastMemo.date === _todayStr ? '오늘' : _lastMemo.date;
            const _preview = _lastMemo.note.length > 30 ? _lastMemo.note.slice(0, 30) + '…' : _lastMemo.note;
            lastMemoHtml = `<div class="client-last-memo">💬 ${_dLabel} · ${escapeHtml(_preview)}</div>`;
        }
    }

    return `<div class="swipe-wrap" id="swipe-${escapeHtml(c.id)}" data-client-id="${escapeHtml(c.id)}">
        <div class="swipe-bg-left">📞</div>
        <div class="swipe-bg-right">🗑️</div>
        <div class="swipe-inner">
        <div class="client-card ${ageCls}" onclick="toggleClientTooltip(event, this)">
            ${(() => {
                // 이 거래처의 최근 메모 3개
                const memos = (orders||[])
                    .filter(o => o.clientName === c.name && o.note && o.note.trim())
                    .sort((a,b) => (b.date||'').localeCompare(a.date||''))
                    .slice(0, 3);
                if (!memos.length) return '';
                return `<div class="client-tooltip">${memos.map(o => `📅 ${o.date}\n📝 ${escapeHtml(o.note)}`).join('\n\n')}</div>`;
            })()}
            <div>
                <div class="client-name">${highlight(c.name, q)}</div>
                ${c.phone ? `<div class="client-phone">📞 ${escapeHtml(c.phone)}</div>` : ''}
                ${c.address ? `<div class="client-phone" style="font-size:11px;">📍 ${escapeHtml(c.address)}</div>` : ''}
                <div class="client-stats">거래 ${stats.count}건 · ${fmt(stats.total)}원</div>
                ${unpaidAmt > 0 ? `<div><span class="client-unpaid-badge ${badgeCls}">💸 미수 ${fmt(unpaidAmt)}원 ${ageLabel}</span></div>` : ''}
                ${c.note ? `<div class="client-stats" style="color:var(--text3);">📝 ${escapeHtml(c.note)}</div>` : ''}
                ${lastMemoHtml}
            </div>
            <div class="client-actions">
                ${c.phone ? `<a href="tel:${escapeHtml(c.phone)}" class="btn-call">📞</a>` : ''}
                <button class="btn-deliver" onclick="quickDeliver('${safeId}','${safeName}')">🚚</button>
                <button class="btn btn-ghost btn-sm" onclick="hideClient('${safeId}')" title="${c.isHidden ? '거래처 표시' : '거래처 숨기기'}">${c.isHidden ? '👁' : '🙈'}</button>
                <button class="btn btn-ghost btn-sm" onclick="editClient('${safeId}')">수정</button>
                <button class="btn btn-danger btn-sm" onclick="deleteClient('${safeId}')">삭제</button>
            </div>
        </div>
        </div>
    </div>`;
}

// ─── 빠른 납품하기 (거래처 탭에서 바로 납품 탭으로) ───

function quickDeliver(id, name) {
    showTab('delivery');
    setTimeout(() => {
        document.getElementById('selectedClientId').value = id;
        document.getElementById('deliveryClient').value   = name;
        // 미수금 힌트 표시
        const hint = document.getElementById('clientUnpaidHint');
        if (hint) {
            const unpaidOrders = orders.filter(o => o.clientId === id && !o.isPaid);
            const unpaidAmt = unpaidOrders.reduce((s,o)=>s+o.total-(o.paidAmount||0), 0);
            if (unpaidAmt > 0) {
                hint.textContent = `💸 현재 미수금: ${fmt(unpaidAmt)}원 (${unpaidOrders.length}건)`;
                hint.classList.add('visible');
            } else {
                hint.textContent = '';
                hint.classList.remove('visible');
            }
        }
        // 거래처별 최근 품목 추천 표시
        showClientItemSuggestions(id);
        updateItemDatalist(id);
        document.getElementById('itemName').focus();
    }, 100);
}

// ─── 품목명 정규화 (재고 매칭용) ───

// ─── 거래처 카드 스와이프 초기화 ───
let _clientSwipeInited = false;

function initClientSwipe() {
    // 렌더링 시마다 호출되므로 중복 등록 방지
    if (_clientSwipeInited) return;
    const list = document.getElementById('clientList');
    if (!list) return;
    _clientSwipeInited = true;

    let startX = 0, startY = 0, currentEl = null, dx = 0;
    const THRESHOLD = 55;
    const MAX_DRAG = 100;

    list.addEventListener('touchstart', e => {
        const wrap = e.target.closest('.swipe-wrap');
        if (!wrap) return;
        currentEl = wrap;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        dx = 0;
        wrap.querySelector('.swipe-inner').style.transition = 'none';
    }, { passive: true });

    list.addEventListener('touchmove', e => {
        if (!currentEl) return;
        const curX = e.touches[0].clientX;
        const curY = e.touches[0].clientY;
        const newDx = curX - startX;
        const dy = Math.abs(curY - startY);
        if (Math.abs(newDx) < 5 && dy > 10) { currentEl = null; return; }
        dx = Math.max(-MAX_DRAG, Math.min(MAX_DRAG, newDx));
        const inner = currentEl.querySelector('.swipe-inner');
        if (inner) inner.style.transform = `translateX(${dx}px)`;
        currentEl.classList.toggle('swiping-left', dx > 10);
        currentEl.classList.toggle('swiping-right', dx < -10);
    }, { passive: true });

    list.addEventListener('touchend', () => {
        if (!currentEl) return;
        const inner = currentEl.querySelector('.swipe-inner');
        const cid = currentEl.dataset.clientId;
        const c = clients.find(x => x.id === cid);

        if (dx > THRESHOLD && c && c.phone) {
            // 우로 스와이프 → 전화
            inner.style.transition = 'transform .25s ease';
            inner.style.transform = 'translateX(0)';
            currentEl.classList.remove('swiping-left','swiping-right');
            setTimeout(() => { window.location.href = 'tel:' + c.phone; }, 150);
        } else if (dx < -THRESHOLD && c) {
            // 좌로 스와이프 → 삭제
            inner.style.transition = 'transform .2s ease';
            inner.style.transform = `translateX(${-MAX_DRAG}px)`;
            setTimeout(() => {
                inner.style.transition = 'none';
                inner.style.transform = 'translateX(0)';
                currentEl.classList.remove('swiping-left','swiping-right');
                deleteClientWithAnim(cid, currentEl);
            }, 200);
        } else {
            inner.style.transition = 'transform .2s ease';
            inner.style.transform = 'translateX(0)';
            currentEl.classList.remove('swiping-left','swiping-right');
        }
        currentEl = null; dx = 0;
    });
}

async function deleteClientWithAnim(id, wrapEl) {
    const c = clients.find(c => c.id === id);
    if (!c) return;
    const hasOrders = orders.some(o => o.clientId === id);
    const msg = hasOrders
        ? `'${c.name}'은 납품 내역이 있습니다.\n삭제할까요? (납품 내역은 유지됩니다)`
        : `'${c.name}'을 삭제할까요?`;
    if (!await customConfirm(msg)) return;
    if (wrapEl) {
        wrapEl.classList.add('card-deleting');
        setTimeout(() => {
            clients = clients.filter(c => c.id !== id);
            saveData(); renderClients(); updateInfoCounts(); updateNavBadges();
            toast('🗑️ 삭제되었습니다');
        }, 350);
    } else {
        clients = clients.filter(c => c.id !== id);
        saveData(); renderClients(); updateInfoCounts(); updateNavBadges();
        toast('🗑️ 삭제되었습니다');
    }
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  § 7  납품 등록                                                  ║
// ╚══════════════════════════════════════════════════════════════╝

function normItemName(n) {
    return (n||'').trim().replace(/\s+/g,' ').toLowerCase();
}

function findStockByName(name) {
    const key = normItemName(name);
    return stockItems.find(s => normItemName(s.name) === key);
}

// ─── 납품 등록 ───

function recalcStockFromOrders(silent = false) {
    if (!stockAutoDeduct) return 0;
    let fixedCount = 0;
    orders.forEach(o => {
        if (o.isVoid || !(o.items||[]).length) return;
        o.items.forEach(it => {
            const si = findStockByName(it.name);
            if (!si) return;
            const alreadyLogged = (si.log || []).some(l =>
                l.type === 'auto' &&
                l.date === o.date &&
                l.reason && l.reason.includes(o.clientName) &&
                Math.abs(l.qty) === Number(it.qty)
            );
            if (alreadyLogged) return;
            const before = si.qty;
            si.qty = Math.max(0, si.qty - (Number(it.qty) || 0));
            (si.log = si.log || []).push({
                type: 'auto', qty: si.qty - before, before, after: si.qty,
                reason: '납품차감(' + o.clientName + ') [재계산]',
                date: o.date, at: new Date().toISOString()
            });
            si.log = _trimLogByDate(si.log);
            fixedCount++;
        });
    });
    if (fixedCount > 0) {
        if (silent) {
            saveToLocal();
        } else {
            saveData();
            _markDirty('stock');
            _refreshStockIfActive();
            toast(`🔄 재고 재계산 완료 — ${fixedCount}건 출고 반영`, 'var(--green)');
        }
    }
    return fixedCount;
}

function searchDeliveryClient(q) {
    const drop = document.getElementById('clientDropdown');
    if (!q) { drop.classList.remove('open'); return; }
    const list = clients.filter(c => matchSearch(c.name, q));
    if (!list.length) { drop.classList.remove('open'); return; }
    drop.innerHTML = list.map(c =>
        `<div class="dropdown-item" onclick="pickDeliveryClient('${escapeAttr(c.id)}','${escapeAttr(c.name)}')">
            ${escapeHtml(c.name)}${c.phone?` (${escapeHtml(c.phone)})`:''}
        </div>`).join('');
    drop.classList.add('open');
}

function pickDeliveryClient(id, name) {
    document.getElementById('selectedClientId').value = id;
    document.getElementById('deliveryClient').value   = name;
    document.getElementById('clientDropdown').classList.remove('open');
    // 미수금 표시
    const hint = document.getElementById('clientUnpaidHint');
    if (hint) {
        const unpaidOrders = orders.filter(o => o.clientId === id && !o.isPaid);
        const unpaidAmt = unpaidOrders.reduce((s,o)=>s+o.total-(o.paidAmount||0), 0);
        if (unpaidAmt > 0) {
            hint.textContent = `💸 현재 미수금: ${fmt(unpaidAmt)}원 (${unpaidOrders.length}건)`;
            hint.classList.add('visible');
        } else {
            hint.textContent = '';
            hint.classList.remove('visible');
        }
    }
    // 거래처별 최근 품목 추천 표시
    showClientItemSuggestions(id);
    updateItemDatalist(id);
}

function updateItemDatalist(clientId) {
    // clientId 인자 우선; 미전달 시 DOM에서 읽기 (동기화 콜백은 '' 전달)
    if (clientId === undefined) clientId = document.getElementById('selectedClientId')?.value || '';
    const allNames = _buildItemNamesCache();
    let names;
    if (clientId) {
        const cache = _buildClientItemsCache();
        const clientNames = (cache[clientId] || []).map(it => it.name);
        const clientSet   = new Set(clientNames);
        const otherNames  = allNames.filter(n => !clientSet.has(n));
        names = [...clientNames.sort(), ...otherNames];
    } else {
        names = allNames;
    }
    const el = document.getElementById('itemDatalist');
    if (el) el.innerHTML = names.map(n=>`<option value="${escapeHtml(n)}">`).join('');
}

// 최근 단가 캐시 빌더 (품목명 → 최근 단가 배열)

function _buildRecentPricesCache() {
    if (_recentPricesCache) return _recentPricesCache;
    const cache = {}; // name → [price, ...]  (최신 납품일 순, 중복 제거, 최대 4개)
    const sorted = [...orders].sort((a, b) => (b.date||"").localeCompare(a.date||""));
    for (const o of sorted) {
        for (const it of (o.items || [])) {
            if (!it.name || it.price <= 0) continue;
            if (!cache[it.name]) cache[it.name] = [];
            if (!cache[it.name].includes(it.price)) {
                cache[it.name].push(it.price);
            }
        }
    }
    _recentPricesCache = cache;
    return cache;
}

function getRecentPrices(name) {
    const cache = _buildRecentPricesCache();
    const matched = (cache[name] || []).slice(0, 4);
    // prices 단가 캐시에 있고 목록에 없으면 추가
    if (prices[name] && !matched.includes(prices[name])) matched.push(prices[name]);
    return matched.slice(0, 4);
}

// 거래처별 최근 품목+단가 (최근 납품일 순, 중복 품목명 제거) — 캐시 활용

function getClientRecentItems(clientId, limit=10) {
    if (!clientId) return [];
    const cache = _buildClientItemsCache();
    const list  = cache[clientId] || [];
    return limit >= list.length ? list : list.slice(0, limit);
}

function showClientItemSuggestions(clientId) {
    const box   = document.getElementById('clientItemSuggest');
    const chips = document.getElementById('cisChips');
    if (!box || !chips) return;
    const items = getClientRecentItems(clientId);
    if (!items.length) { box.classList.remove('visible'); return; }
    chips.innerHTML = items.map(it => {
        const priceLabel = it.price > 0 ? `${fmt(it.price)}원` : '단가미정';
        const safeItName = escapeAttr(it.name);
        return `<button class="cis-chip" onclick="fillItemFromSuggest('${safeItName}',${Number(it.price)||0})" title="${escapeHtml(it.date)} 납품">
            <span class="cis-chip-name">${escapeHtml(it.name)}</span>
            <span class="cis-chip-price">${priceLabel}</span>
        </button>`;
    }).join('');
    box.classList.add('visible');
}

function fillItemFromSuggest(name, price) {
    document.getElementById('itemName').value  = name;
    if (price > 0) _setMoneyVal('itemPrice', price); else document.getElementById('itemPrice').value = '';
    onItemNameInput(name);
    // 수량 입력란으로 포커스 + 화면 스크롤
    const qtyEl = document.getElementById('itemQty');
    qtyEl.focus();
    setTimeout(() => {
        qtyEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
}

function onItemNameInput(name) {
    const hint     = document.getElementById('priceHint');
    const clientId = document.getElementById('selectedClientId').value;
    if (!name) { hint.textContent=''; return; }
    // 거래처별 최근 단가 우선
    if (clientId) {
        const clientItem = getClientRecentItems(clientId).find(it => normItemName(it.name) === normItemName(name));
        if (clientItem && clientItem.price > 0) {
            hint.innerHTML = `<span style="color:var(--accent);font-weight:700;">이 거래처 최근 단가: ${fmt(clientItem.price)}원</span>`;
            return;
        }
    }
    const recent = getRecentPrices(name);
    hint.textContent = recent.length ? `최근 단가: ${recent.map(p=>fmt(p)+'원').join(' / ')}` : '';
}

function autoFillPrice(el) {
    if (el.value !== '') return;
    const name     = document.getElementById('itemName').value.trim();
    const clientId = document.getElementById('selectedClientId').value;
    if (!name) return;
    // 거래처별 최근 단가 우선
    if (clientId) {
        const clientItem = getClientRecentItems(clientId).find(it => normItemName(it.name) === normItemName(name));
        if (clientItem && clientItem.price > 0) { _setMoneyVal('itemPrice', clientItem.price); return; }
    }
    const recent = getRecentPrices(name);
    if (recent.length > 0) _setMoneyVal('itemPrice', recent[0]);
}

function addItemToGroup() {
    const name  = document.getElementById('itemName').value.trim();
    const qty   = parseInt(document.getElementById('itemQty').value)   || 0;
    const priceRaw = document.getElementById('itemPrice').value.replace(/[^0-9]/g,'');
    const price = priceRaw === '' ? null : (parseInt(priceRaw, 10) || 0);
    const date  = document.getElementById('deliveryDate').value;
    if (!name)   return toast('❗ 품목명을 입력하세요');
    if (qty<=0)  return toast('❗ 수량을 1 이상 입력하세요');
    if (price === null) return toast('❗ 단가를 입력하세요');
    if (price < 0)      return toast('❗ 단가는 0 이상이어야 합니다');
    if (!date)   return toast('❗ 납품일자를 선택하세요');
    let group = tempGroups.find(g => g.date===date);
    if (!group) { group={date,items:[]}; tempGroups.push(group); tempGroups.sort((a,b)=>(a.date||"").localeCompare(b.date||"")); }
    group.items.push({ name, qty, price, total:qty*price });

    // ── 재고 부족 경고 (자동차감 ON이고 재고 등록된 품목일 때) ──
    if (stockAutoDeduct && !_deliveryIsVoid) {
        const si = findStockByName(name);
        if (si) {
            // tempGroups 전체에서 해당 품목 누적 수량 계산
            const totalNeeded = tempGroups.reduce((s, g) =>
                s + g.items.filter(i => normItemName(i.name) === normItemName(name))
                           .reduce((ss, i) => ss + i.qty, 0), 0);
            if (totalNeeded > si.qty) {
                toast(`⚠️ ${name} 재고 부족 — 현재 ${si.qty}${si.unit||'개'}, 필요 ${totalNeeded}${si.unit||'개'}`, 'var(--orange)', 3000);
            }
        }
    }
    document.getElementById('itemName').value  = '';
    document.getElementById('itemQty').value   = '';
    document.getElementById('itemPrice').value = '';
    document.getElementById('priceHint').textContent = '';
    renderTempGroups();
    // 키보드 내리고 화면 맨 아래로 스크롤
    document.activeElement?.blur();
    setTimeout(() => {
        const content = document.getElementById('mainContent');
        if (content) content.scrollTop = content.scrollHeight;
    }, 100);
}

function removeTempGroupItem(gi, ii) {
    tempGroups[gi].items.splice(ii,1);
    if (!tempGroups[gi].items.length) tempGroups.splice(gi,1);
    renderTempGroups();
}

async function removeTempGroup(gi) {
    if (!await customConfirm(`${tempGroups[gi].date} 날짜의 품목을 모두 삭제할까요?`)) return;
    tempGroups.splice(gi,1); renderTempGroups();
}

function renderTempGroups() {
    const grand = tempGroups.reduce((s,g)=>s+g.items.reduce((ss,i)=>ss+i.total,0),0);
    const box   = document.getElementById('tempTotalBox');
    const list  = document.getElementById('tempGroupList');
    if (!tempGroups.length) {
        list.innerHTML='';
        box.style.display='none';
        const cb = document.getElementById('deliveryConfirmBtn');
        if (cb) cb.style.display = 'none';
        return;
    }
    list.innerHTML = tempGroups.map((g,gi) => {
        const gTotal = g.items.reduce((s,i)=>s+i.total,0);
        const rows = g.items.map((it,ii) => `
            <div class="temp-item-row">
                <span><strong>${escapeHtml(it.name)}</strong> | ${escapeHtml(it.qty)}개 × ${fmt(it.price)}원</span>
                <div style="display:flex;align-items:center;gap:6px;">
                    <span>${fmt(it.total)}원</span>
                    <button onclick="removeTempGroupItem(${gi},${ii})" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:16px;">✕</button>
                </div>
            </div>`).join('');
        return `<div class="date-group-card">
            <div class="date-group-header">
                <span class="date-group-label">📅 ${g.date}</span>
                <div style="display:flex;align-items:center;gap:8px;">
                    <span class="date-group-subtotal">${fmt(gTotal)}원</span>
                    <button onclick="removeTempGroup(${gi})" style="padding:3px 8px;background:var(--red);color:#fff;border:none;border-radius:5px;font-size:11px;cursor:pointer;">날짜 삭제</button>
                </div>
            </div>
            ${rows}
        </div>`;
    }).join('');
    document.getElementById('tempTotal').textContent = fmt(grand)+'원';
    document.getElementById('tempDateCount').textContent = `${tempGroups.length}일 · ${tempGroups.reduce((s,g)=>s+g.items.length,0)}품목`;
    box.style.display = 'block';
    // 확정 버튼 동적 렌더링
    let confirmBtn = document.getElementById('deliveryConfirmBtn');
    if (!confirmBtn) {
        confirmBtn = document.createElement('button');
        confirmBtn.id = 'deliveryConfirmBtn';
        confirmBtn.className = 'btn btn-success btn-full';
        confirmBtn.onclick = openDeliveryConfirm;
        box.after(confirmBtn);
    }
    confirmBtn.innerHTML = `🚚 납품 확정 — <span style="font-family:'DM Mono',monospace;">${fmt(grand)}원</span>`;
    confirmBtn.onclick = openDeliveryConfirm;
    confirmBtn.style.display = 'block';
}

async function openDeliveryConfirm() {
    const clientId = document.getElementById('selectedClientId').value;
    if (!clientId)          return toast('❗ 거래처를 선택하세요');
    if (!tempGroups.length) return toast('❗ 품목을 추가하세요');
    const client = clients.find(c => c.id === clientId);
    if (!client) return toast('❗ 거래처를 다시 선택하세요');

    // ── 재고 부족 검사 (자동차감 ON이고 타인거래 아닐 때) ──
    if (stockAutoDeduct && !_deliveryIsVoid) {
        // 품목별 총 필요 수량 집계
        const needed = {};
        tempGroups.forEach(g => {
            g.items.forEach(it => {
                const key = normItemName(it.name);
                needed[key] = (needed[key] || { name: it.name, qty: 0 });
                needed[key].qty += it.qty;
            });
        });
        const shortages = [];
        Object.values(needed).forEach(({ name, qty }) => {
            const si = findStockByName(name);
            if (si && qty > si.qty) {
                shortages.push({ name, need: qty, have: si.qty, unit: si.unit || '개' });
            }
        });
        if (shortages.length > 0) {
            const msg = shortages.map(s =>
                `· ${s.name}: 필요 ${s.need}${s.unit} / 현재 ${s.have}${s.unit} (${s.need - s.have}${s.unit} 부족)`
            ).join('\n');
            const proceed = await customConfirm(`⚠️ 재고가 부족한 품목이 있습니다.\n\n${msg}\n\n그래도 납품을 진행할까요?`, '납품 진행', 'btn-primary');
            if (!proceed) return;
        }
    }

    // 요약 정보 구성
    const totalAmt = tempGroups.reduce((s, g) => s + g.items.reduce((a, i) => a + i.total, 0), 0);
    const dateCount = tempGroups.length;
    const itemCount = tempGroups.reduce((s, g) => s + g.items.length, 0);

    document.getElementById('deliveryConfirmSub').textContent =
        `${client.name} · ${dateCount}일 · 품목 ${itemCount}개`;

    // 날짜별 품목 요약
    let html = '';
    tempGroups.forEach(g => {
        html += `<div style="font-weight:700;color:var(--accent);margin-bottom:4px;">📅 ${g.date}</div>`;
        g.items.forEach(it => {
            const si = stockAutoDeduct && !_deliveryIsVoid ? findStockByName(it.name) : null;
            const isShort = si && it.qty > si.qty;
            const stockHint = si ? `<span style="font-size:10px;color:${isShort?'var(--red)':'var(--green)'};margin-left:4px;">(재고 ${si.qty}${si.unit||'개'}${isShort?' ⚠부족':''})</span>` : '';
            html += `<div style="display:flex;justify-content:space-between;align-items:baseline;color:${isShort?'var(--red)':'var(--text2)'};padding-left:8px;margin-bottom:3px;gap:8px;">
                <span style="flex:1;min-width:0;">${it.name}${stockHint}</span>
                <span style="font-size:11px;white-space:nowrap;color:var(--text3);">${it.qty}개 × ${fmt(it.price)}원</span>
                <span style="font-family:'DM Mono',monospace;font-weight:700;color:${isShort?'var(--red)':'var(--text)'};white-space:nowrap;">= ${fmt(it.total)}원</span>
            </div>`;
        });
    });
    document.getElementById('deliveryConfirmSummary').innerHTML = html;
    document.getElementById('deliveryConfirmTotal').textContent = fmt(totalAmt) + '원';

    document.getElementById('deliveryConfirmOverlay').classList.add('open');
    document.getElementById('deliveryConfirmPopup').classList.add('open');
    // 타인거래 토글 초기화
    _deliveryIsVoid = false;
    _updateDeliveryVoidToggle();
}

function closeDeliveryConfirm() {
    document.getElementById('deliveryConfirmOverlay').classList.remove('open');
    document.getElementById('deliveryConfirmPopup').classList.remove('open');
}

// ── 타인거래 토글 ──
let _deliveryIsVoid = false;

function toggleDeliveryVoid() {
    _deliveryIsVoid = !_deliveryIsVoid;
    _updateDeliveryVoidToggle();
}

function _updateDeliveryVoidToggle() {
    const btn = document.getElementById('deliveryVoidToggle');
    if (!btn) return;
    if (_deliveryIsVoid) {
        btn.style.background = 'rgba(245,166,35,.15)';
        btn.style.borderColor = 'var(--orange)';
        btn.style.color = 'var(--orange)';
        btn.textContent = '👤 타인거래 ON — 재고 차감만 제외됨';
    } else {
        btn.style.background = 'var(--surf2)';
        btn.style.borderColor = 'var(--border)';
        btn.style.color = 'var(--text2)';
        btn.textContent = '👤 타인거래 (재고 차감만 제외)';
    }
}

async function submitOrder() {
    const clientId = document.getElementById('selectedClientId').value;
    const client = clients.find(c => c.id===clientId);
    if (!clientId || !client || !tempGroups.length) return;
    const isVoid = !!_deliveryIsVoid;
    // ── 자동 재고 차감 (타인거래면 스킵) ──
    if (stockAutoDeduct && !isVoid) {
        const today = todayKST();
        tempGroups.forEach(group => {
            (group.items||[]).forEach(it => {
                const si = findStockByName(it.name);
                if (!si) return;
                const before = si.qty;
                si.qty = Math.max(0, si.qty - (Number(it.qty)||0));
                (si.log = si.log||[]).unshift({ type:'auto', qty:si.qty-before, before, after:si.qty,
                    reason:'납품차감('+client.name+')', date:group.date, at:new Date().toISOString() });
                si.log = _trimLogByDate(si.log);
            });
        });
    }
    tempGroups.forEach(group => {
        const total = group.items.reduce((s,i)=>s+i.total,0);
        const order = {
            id: _uid(), clientId, clientName:client.name,
            date:group.date, items:[...group.items],
            total, totalAmount:total, note:'', isPaid:false,
            createdAt:new Date().toISOString()
        };
        if (isVoid) order.isVoid = true;
        orders.push(order);
        _markDirtyOrder(order.id); // delta sync 마킹
        // 단가 캐시 갱신
        (group.items||[]).forEach(it => { if (it.price > 0) prices[it.name] = it.price; });
    });
    // 거래명세서 자동 오픈을 위해 확정 직전에 거래처명·월 저장
    const _savedClientName = client.name;
    const _savedMonth = (tempGroups[0]?.date || todayKST()).slice(0, 7);
    _deliveryIsVoid = false;
    tempGroups = [];
    closeDeliveryConfirm();
    // 거래처 입력창 완전 초기화 → 새 거래처 바로 입력 가능
    document.getElementById('deliveryClient').value   = '';
    document.getElementById('selectedClientId').value = '';
    document.getElementById('deliveryDate').value     = todayKST();
    // 미수금 힌트 초기화
    const hint = document.getElementById('clientUnpaidHint');
    if (hint) { hint.textContent = ''; hint.classList.remove('visible'); }
    // 품목 추천 칩 숨기기
    const suggestBox = document.getElementById('clientItemSuggest');
    if (suggestBox) suggestBox.classList.remove('visible');
    // 단가 힌트 초기화
    const priceHint = document.getElementById('priceHint');
    if (priceHint) priceHint.textContent = '';
    renderTempGroups(); saveData(); updateInfoCounts(); updateNavBadges();
    renderDashboard();
    updateItemDatalist('');
    _refreshSettlementIfActive();
    _refreshStockIfActive();
    _refreshUnpaidIfActive();
    // 납품 확정 후: 내역 탭 전환 → 거래명세서 자동 오픈
    setTimeout(() => {
        showTab('history');
        setHistPeriod('today', document.querySelector('.chip.hist-period[data-p="today"]'));
        toast(isVoid ? '👤 타인거래로 등록 완료 (재고 차감 제외)' : '✅ 납품 등록 완료!', 'var(--green)');
        setTimeout(() => showClientStatement(_savedClientName, _savedMonth), 200);
    }, 80);
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  § 8  내역 조회                                                  ║
// ╚══════════════════════════════════════════════════════════════╝

// ─── 내역 조회 ───

function initHistPeriod() {
    const today = todayKST();
    // 이미 사용자가 설정한 날짜가 있으면 덮어쓰지 않음
    if (!document.getElementById('histStart').value)
        document.getElementById('histStart').value = today;
    if (!document.getElementById('histEnd').value)
        document.getElementById('histEnd').value = today;
    // 네비 날짜 초기화
    const navEl = document.getElementById('histNavDate');
    if (navEl && !navEl.value) navEl.value = today;
}

function clearHistPeriodActive() {
    document.querySelectorAll('.hist-period').forEach(b => b.classList.remove('active'));
}

// ─── 내역 탭 날짜 네비 ───
function histDateNav(delta) {
    const el = document.getElementById('histNavDate');
    const cur = el.value || todayKST();
    el.value = kstAddDays(cur, delta);
    histDateNavSet(el.value);
}
function histDateNavToday() {
    const today = todayKST();
    document.getElementById('histNavDate').value = today;
    histDateNavSet(today);
}
function histDateNavSet(dateStr) {
    document.getElementById('histStart').value = dateStr;
    document.getElementById('histEnd').value   = dateStr;
    clearHistPeriodActive();
    renderOrders();
}

function setHistPeriod(p, btn) {
    const todayStr = todayKST();
    let start, end = todayStr;
    if (p==='today') {
        start = todayStr;
    } else if (p==='week') {
        // KST 기준 이번 주 일요일 계산
        const dow = new Date(todayStr + 'T12:00:00+09:00').getDay();
        start = kstAddDays(todayStr, -dow);
    } else if (p==='lastweek') {
        // 지난주 일요일 ~ 토요일
        const dow = new Date(todayStr + 'T12:00:00+09:00').getDay();
        const thisSun = kstAddDays(todayStr, -dow);
        start = kstAddDays(thisSun, -7);
        end   = kstAddDays(thisSun, -1);
    } else if (p==='month') {
        start = todayStr.slice(0,7) + '-01';
    } else if (p==='lastmonth') {
        // 지난달 1일 ~ 말일
        const d = new Date(todayStr + 'T12:00:00+09:00');
        const y = d.getMonth() === 0 ? d.getFullYear() - 1 : d.getFullYear();
        const m = d.getMonth() === 0 ? 12 : d.getMonth();
        const mm = String(m).padStart(2,'0');
        const lastDay = new Date(y, m, 0).getDate();
        start = `${y}-${mm}-01`;
        end   = `${y}-${mm}-${String(lastDay).padStart(2,'0')}`;
    } else {
        start = '2000-01-01'; end = '2099-12-31';
    }
    document.getElementById('histStart').value = start;
    document.getElementById('histEnd').value   = end;
    // 네비 날짜도 시작일로 동기화
    const navEl = document.getElementById('histNavDate');
    if (navEl) navEl.value = start;
    clearHistPeriodActive();
    if (btn) btn.classList.add('active');
    renderOrders();
}

// ─── 검색어 하이라이트 ───

function highlight(text, q) {
    const safeText = escapeHtml(text);
    if (!q || !text) return safeText;
    const safeQ = escapeHtml(q);
    // 일반 문자열 매칭 시도
    const idx = safeText.toLowerCase().indexOf(safeQ.toLowerCase());
    if (idx !== -1) {
        return safeText.slice(0, idx)
            + `<mark style="background:var(--accent)33;color:var(--accent);border-radius:3px;padding:0 2px;">${safeText.slice(idx, idx + safeQ.length)}</mark>`
            + safeText.slice(idx + safeQ.length);
    }
    // 초성 매칭 — 글자 단위로 일치하는 구간 하이라이트
    const qCho = extractChosung(q);
    const tCho = extractChosung(text);
    if (qCho === q) return safeText; // 초성 없는 일반 문자열인데 위에서 못 찾은 경우 → 매칭 없음
    const choStart = tCho.indexOf(qCho);
    if (choStart !== -1) {
        return safeText.slice(0, choStart)
            + `<mark style="background:var(--accent)33;color:var(--accent);border-radius:3px;padding:0 2px;">${safeText.slice(choStart, choStart + qCho.length)}</mark>`
            + safeText.slice(choStart + qCho.length);
    }
    return safeText;
}

function setHistSort(mode, btn) {
    histSortMode = mode;
    document.querySelectorAll('#pane-history .sort-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderOrders();
}

function setHistPayFilter(f, btn) {
    histPayFilter = f;
    document.querySelectorAll('#histPayChips .chip').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderOrders();
}

// ── 거래 건수 위젯 업데이트 (선택된 기간 기준) ──
function _updateTodayCountWidget(filteredOrders, start, end) {
    const todayStr = todayKST();
    // 기간 라벨 결정
    let periodLabel = '오늘 거래';
    if (start && end) {
        if (start === end) {
            periodLabel = start === todayStr ? '오늘 거래' : `${start.slice(5).replace('-','/')} 거래`;
        } else {
            periodLabel = `${start.slice(5).replace('-','/')}~${end.slice(5).replace('-','/')} 거래`;
        }
    }
    const base = (filteredOrders || []).filter(o => !o.isVoid);
    const count = base.length;
    const amt   = base.reduce((s, o) => s + o.total, 0);

    const numEl   = document.getElementById('todayCountNum');
    const amtEl   = document.getElementById('todayCountAmt');
    const tbox    = document.getElementById('todayCountBox');
    const labelEl = document.getElementById('todayCountLabel');
    if (numEl)   numEl.textContent   = count;
    if (amtEl)   amtEl.textContent   = fmt(amt) + '원';
    if (labelEl) labelEl.textContent = periodLabel;
    if (tbox) {
        tbox.style.borderColor = count > 0 ? 'var(--accent)' : 'var(--border)';
        tbox.style.background  = count > 0 ? 'rgba(108,99,255,0.07)' : 'var(--surf3)';
    }
}

function renderOrders() {
    const q     = document.getElementById('histSearch')?.value || '';
    const start = document.getElementById('histStart')?.value || '';
    const end   = document.getElementById('histEnd')?.value || '';

    const filtered = orders.filter(o => {
        const mSearch = matchSearch(o.clientName||'',q) || (o.items||[]).some(i=>matchSearch(i.name,q));
        const mDate   = (!start||o.date>=start) && (!end||o.date<=end);
        const mPay    = histPayFilter==='all'?true:histPayFilter==='unpaid'?!o.isPaid:o.isPaid;
        return mSearch && mDate && mPay;
    });

    const _et       = o => o.isPaid && o.discount > 0 ? o.total - o.discount : o.total;
    const totalAmt  = filtered.filter(o=>!o.isVoid).reduce((s,o)=>s+_et(o),0);
    const paidAmt     = filtered.filter(o=>!o.isVoid).reduce((s,o)=>s+_actualPaid(o),0);
    const unpaidAmt   = Math.max(0, totalAmt - paidAmt);
    // 수금방법별 집계 (paidMethodDetail 우선, 없으면 paidMethod 기준)
    let cashAmt = 0, transferAmt = 0, mixedAmt = 0, otherPaidAmt = 0;
    filtered.filter(o=>!o.isVoid).forEach(o => {
        const got = _actualPaid(o);
        if (got <= 0) return;
        if (o.paidMethod === 'mixed') {
            if (o.paidMethodDetail) {
                transferAmt += (o.paidMethodDetail.transfer || 0);
                cashAmt     += (o.paidMethodDetail.cash     || 0);
            } else {
                mixedAmt += got; // 구버전 mixed: 별도 항목
            }
        } else if (o.paidMethod === 'transfer') transferAmt += got;
        else if (o.paidMethod === 'other') otherPaidAmt += got;
        else cashAmt += got;
    });
    document.getElementById('hstatTotal').textContent  = fmt(totalAmt)+'원';
    document.getElementById('hstatPaid').textContent   = fmt(paidAmt)+'원';
    document.getElementById('hstatUnpaid').textContent = fmt(unpaidAmt)+'원';
    // 수금방법 분리 표시
    const bdEl = document.getElementById('hstatBreakdown');
    if (bdEl) {
        if (paidAmt > 0) {
            document.getElementById('hstatCash').textContent     = '💵 ' + fmt(cashAmt) + '원';
            document.getElementById('hstatTransfer').textContent = '🏦 ' + fmt(transferAmt) + '원';
            // 구버전 mixed 항목이 있으면 추가 표시
            const mixedEl = document.getElementById('hstatMixed');
            if (mixedEl) mixedEl.textContent = mixedAmt > 0 ? '💳 ' + fmt(mixedAmt) + '원' : '';
            if (mixedEl) mixedEl.style.display = mixedAmt > 0 ? '' : 'none';
            bdEl.style.display = 'flex';
        } else {
            bdEl.style.display = 'none';
        }
    }

    // ── 거래 건수 위젯 업데이트 (선택된 기간 기준) ──
    _updateTodayCountWidget(filtered, start, end);

    const el = document.getElementById('orderList');
    if (!filtered.length) {
        el.innerHTML = '<div class="empty"><div class="empty-icon">📋</div><div class="empty-text">납품 내역이 없습니다</div></div>';
        return;
    }

    // ── 전표 카드 HTML ──
    const orderCardHTML = o => {
        const cName = escapeAttr(o.clientName || '');
        const cId   = escapeAttr(o.clientId   || '');
        const oId   = escapeAttr(o.id         || '');
        const voided = !!o.isVoid;
        // 타인거래도 미수/완납 상태 반영한 카드 색상
        const cardClass = `order-card ${voided ? ('voided ' + (o.isPaid ? 'paid' : 'unpaid')) : (o.isPaid ? 'paid' : 'unpaid')}`;
        // 타인거래: 👤배지 + 수금 상태 배지 같이 표시 (수금 처리 가능)
        const payBadge = `<span class="pay-badge ${o.isPaid?'paid':((o.paidAmount||0)>0?'':'unpaid')}" style="${(o.paidAmount||0)>0&&!o.isPaid?'background:#3b82f625;color:#60a5fa;':''}" onclick="${o.isPaid ? `togglePaid('${oId}')` : `openQuickPay('${oId}')` }">${o.isPaid?(o.discount>0?`✂️ 할인완납`:'✅ 완납'):(o.paidAmount||0)>0?'💳 부분':'⚠ 미수'}</span>`;
        const badgeHtml = voided
            ? `<div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;"><span class="void-badge">👤 타인거래</span>${payBadge}</div>`
            : payBadge;
        const memoLabel = o.note ? '📝 메모수정' : '📝 메모';
        const memoClass = o.note ? 'memo-btn has-memo' : 'memo-btn';

        let memoBodyHtml = '';
        if (o.note) {
            // 현재 메모 표시
            memoBodyHtml = `<div class="order-memo-body" onclick="openMemoPopup('${oId}')">${escapeHtml(o.note)}</div>`;
        } else {
            // 메모 없으면 같은 거래처의 가장 최근 이전 메모 표시
            const prevMemo = orders
                .filter(x => x.clientName === o.clientName && x.id !== o.id && x.note && x.note.trim())
                .sort((a, b) => (b.date||'').localeCompare(a.date||'') || (b.id||'').localeCompare(a.id||''))
                [0];
            if (prevMemo) {
                memoBodyHtml = `<div class="order-memo-body order-memo-prev" style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px;">
                    <div onclick="openMemoPopup('${oId}')" style="flex:1;min-width:0;">
                        <span class="order-memo-prev-label">이전 메모 · ${prevMemo.date}</span>${escapeHtml(prevMemo.note)}
                    </div>
                    <button onclick="deletePrevMemo('${escapeAttr(prevMemo.id)}')" style="flex-shrink:0;background:none;border:none;font-size:14px;color:var(--text3);padding:2px 4px;cursor:pointer;line-height:1;" title="이전 메모 삭제">🗑️</button>
                </div>`;
            }
        }
        return `<div class="${cardClass}">
            <div class="order-top">
                <div style="display:flex;flex-direction:column;gap:4px;">
                    <div class="order-client-name" onclick="showClientStatement('${cName}','${o.date.slice(0,7)}')">${highlight(o.clientName||'(거래처없음)', q)}</div>
                    <div class="order-date">${escapeHtml(o.date)}</div>
                    <button class="${memoClass}" onclick="openMemoPopup('${oId}')">📝 ${o.note ? '메모수정' : '메모'}</button>
                </div>
                ${badgeHtml}
            </div>
            <div class="order-items">${(o.items||[]).map(i=>`${highlight(i.name,q)} ${escapeHtml(i.qty)}개 × ${fmt(i.price)}원`).join('<br>')}</div>
            ${memoBodyHtml}
            <div class="order-bottom"><div class="order-total">${fmt(o.total)}원</div></div>
            <div class="order-actions">
                <button class="btn btn-ghost btn-sm" onclick="showOrderDetail('${oId}')">🔍<span class="btn-label">상세</span></button>
                ${voided
                    ? `<button class="btn btn-primary btn-sm" onclick="openOrderEdit('${oId}')">✏️<span class="btn-label">수정</span></button><button class="btn btn-ghost btn-sm" onclick="toggleVoidOrder('${oId}')" style="color:var(--green);border-color:rgba(32,192,92,.4);">↩<span class="btn-label">내거래로</span></button>`
                    : `<button class="btn btn-primary btn-sm" onclick="openOrderEdit('${oId}')">✏️<span class="btn-label">수정</span></button>`
                }
                <button class="btn btn-ghost btn-sm" onclick="openClientEditFromHistory('${cId}','${cName}')">🏪<span class="btn-label">거래처</span></button>
                <button class="btn btn-danger btn-sm" onclick="deleteOrder('${oId}')">🗑️<span class="btn-label">삭제</span></button>
            </div>
        </div>`;
    };

    // ── 날짜순 ──
    if (histSortMode === 'date') {
        const sorted = [...filtered].sort((a,b) => {
            if (b.date > a.date) return 1;
            if (b.date < a.date) return -1;
            return (b.createdAt||'') > (a.createdAt||'') ? 1 : -1;
        });
        el.innerHTML = sorted.map(orderCardHTML).join('');
        return;
    }

    // ── 거래처순 / 최근거래순: 거래처별 그룹 ──
    const groupMap = {};
    filtered.forEach(o => {
        const key = o.clientName || '(거래처없음)';
        if (!groupMap[key]) groupMap[key] = { name:key, orders:[] };
        groupMap[key].orders.push(o);
    });
    Object.values(groupMap).forEach(g => {
        // 각 그룹 내부: 날짜 내림차순, 같은 날엔 등록시각 내림차순
        g.orders.sort((a,b) => {
            if (b.date > a.date) return 1;
            if (b.date < a.date) return -1;
            return (b.createdAt||'') > (a.createdAt||'') ? 1 : -1;
        });
        // lastDate: 그룹 내 가장 최신 날짜 (정렬 후 첫 번째)
        g.lastDate = g.orders[0]?.date || '';
        g.lastAt   = g.orders[0]?.createdAt || '';
        g.unpaid   = g.orders.filter(o=>!o.isPaid).reduce((s,o)=>s+o.total,0);
        const _et  = o => o.isPaid && o.discount > 0 ? o.total - o.discount : o.total;
        g.total    = g.orders.reduce((s,o)=>s+_et(o),0);
    });
    const groups = Object.values(groupMap);
    if (histSortMode === 'recent') {
        // 최근 납품일 내림차순 → 같은 날이면 등록시각 내림차순
        groups.sort((a,b) => {
            if (b.lastDate > a.lastDate) return 1;
            if (b.lastDate < a.lastDate) return -1;
            return (b.lastAt||'') > (a.lastAt||'') ? 1 : -1;
        });
    } else {
        groups.sort((a,b) => a.name.localeCompare(b.name,'ko'));
    }
    el.innerHTML = groups.map(g => `
        <div style="margin-bottom:10px;">
            <div style="display:flex;align-items:center;justify-content:space-between;
                        padding:8px 13px;background:var(--surf2);
                        border:1px solid var(--border);border-bottom:2px solid var(--accent)44;
                        border-radius:10px 10px 0 0;">
                <div style="display:flex;align-items:center;gap:7px;">
                    <span style="font-size:13px;font-weight:800;color:var(--text1);">${highlight(g.name,q)}</span>
                    <span style="font-size:11px;color:var(--text3);background:var(--surf3);padding:1px 6px;border-radius:20px;">${g.orders.length}건</span>
                </div>
                <div style="text-align:right;line-height:1.5;">
                    <div style="font-size:12px;font-weight:700;color:var(--accent);">${fmt(g.total)}원</div>
                    ${g.unpaid>0?`<div style="font-size:11px;color:var(--red);font-weight:700;">미수 ${fmt(g.unpaid)}원</div>`:''}
                    <div style="font-size:10px;color:var(--text3);">최근납품 ${escapeHtml(g.lastDate)}</div>
                </div>
            </div>
            <div style="border:1px solid var(--border);border-top:none;border-radius:0 0 10px 10px;overflow:hidden;">
                ${g.orders.map(orderCardHTML).join('')}
            </div>
        </div>`).join('');
}

async function togglePaid(id) {
    // 완납 → 미수 복귀 전용 (미수→완납은 openQuickPay로)
    const o = orders.find(o=>o.id===id);
    if (!o) return;
    if (o.isPaid) {
        if (!await customConfirm('완납을 취소하고 미수로 되돌릴까요?')) return;
        o.isPaid = false; o.paidAmount = 0;
        delete o.paidAt; delete o.paidNote; delete o.paidMethod; delete o.discount; delete o.paidMethodDetail;
        _markDirtyOrder(id); // delta sync 마킹
        _saveAndFlush(); renderOrders(); renderDashboard(); updateInfoCounts(); updateNavBadges();
        _refreshUnpaidIfActive();
        _refreshSettlementIfActive();
        toast('🔴 미수로 변경');
    } else {
        openQuickPay(id);
    }
}

// ─── 수금방법 퀵 선택 팝업 ───
function openQuickPay(orderId) {
    const o = orders.find(x => x.id === orderId);
    if (!o) return;
    document.getElementById('qpOrderId').value = orderId;
    document.getElementById('qpTitle').textContent = o.clientName || '수금 처리';
    document.getElementById('qpSub').textContent   = o.date + ' · ' + fmt(o.total) + '원';
    const remain = o.total - (o.paidAmount || 0);
    document.getElementById('qpCashAmt').textContent     = fmt(remain) + '원';
    document.getElementById('qpTransferAmt').textContent = fmt(remain) + '원';
    // 할인 영역 초기화
    document.getElementById('qpDiscountBody').style.display = 'none';
    document.getElementById('qpDiscountToggle').classList.remove('open');
    document.getElementById('qpDiscountAmt').value = '';
    document.getElementById('qpDiscountPreview').textContent = '';
    document.getElementById('quickPayOverlay').classList.add('open');
    document.getElementById('quickPayPopup').classList.add('open');
}

function toggleQpDiscount() {
    const body   = document.getElementById('qpDiscountBody');
    const toggle = document.getElementById('qpDiscountToggle');
    const open   = body.style.display !== 'none';
    body.style.display = open ? 'none' : 'block';
    toggle.classList.toggle('open', !open);
    if (!open) setTimeout(() => document.getElementById('qpDiscountAmt')?.focus(), 80);
}

function updateQpDiscountPreview() {
    const orderId = document.getElementById('qpOrderId').value;
    const o = orders.find(x => x.id === orderId);
    if (!o) return;
    const remain  = o.total - (o.paidAmount || 0);
    const input   = _moneyVal('qpDiscountAmt');
    const preview = document.getElementById('qpDiscountPreview');
    if (input <= 0) { preview.textContent = ''; return; }
    if (input > remain) {
        preview.innerHTML = `<span style="color:var(--red);">⚠ 청구금액(${fmt(remain)}원)을 초과합니다</span>`;
        return;
    }
    const discount = remain - input;
    if (discount === 0) {
        preview.innerHTML = `<span style="color:var(--green);">할인 없음 → 전액 완납</span>`;
    } else {
        preview.innerHTML = `실수령 <strong>${fmt(input)}원</strong> · <span style="color:var(--orange);">할인 ${fmt(discount)}원</span> → ✅ 완납`;
    }
}

function confirmQuickPayDiscount(method) {
    const orderId = document.getElementById('qpOrderId').value;
    const o = orders.find(x => x.id === orderId);
    if (!o) return;
    const remain = o.total - (o.paidAmount || 0);
    const input  = _moneyVal('qpDiscountAmt');
    if (input <= 0) return toast('❗ 실수령액을 입력하세요');
    if (input > remain) return toast('❗ 실수령액이 청구금액보다 많습니다');
    const discount = remain - input;
    // 할인 완납: 실수령액만 paidAmount, 차액은 discount 필드, isPaid=true
    o.isPaid     = true;
    o.paidAmount = (o.paidAmount || 0) + input;
    o.paidAt     = new Date().toISOString();
    o.paidMethod = method;
    if (discount > 0) o.discount = (o.discount || 0) + discount;
    _markDirtyOrder(orderId); // delta sync 마킹
    closeQuickPay(true);
    _saveAndFlush(); renderOrders(); renderDashboard(); updateInfoCounts(); updateNavBadges();
    _refreshUnpaidIfActive();
    _refreshSettlementIfActive();
    const icon = method === 'transfer' ? '🏦' : '💵';
    const msg  = discount > 0
        ? `${icon} 할인 완납 (할인 ${fmt(discount)}원)`
        : `${icon} 완납 처리`;
    toast(msg, 'var(--green)');
}

// ─── 명세표에서 퀵페이 열기 (결제 후 명세표 자동 갱신) ───
let _qpStatementCtx = null; // { clientName, month }

function openQuickPayFromStatement(orderId, clientName, month) {
    const o = orders.find(x => x.id === orderId);
    if (!o) return;
    if (o.isPaid) { showOrderDetail(orderId); return; } // 완납이면 상세만
    _qpStatementCtx = { clientName, month };
    openQuickPay(orderId);
}

function closeQuickPay(paid = false) {
    document.getElementById('quickPayOverlay').classList.remove('open');
    document.getElementById('quickPayPopup').classList.remove('open');
    // 결제 완료 후 명세표가 열려있으면 갱신, 취소면 컨텍스트만 초기화
    if (_qpStatementCtx) {
        const { clientName, month } = _qpStatementCtx;
        _qpStatementCtx = null;
        if (paid && document.getElementById('statementModal')?.classList.contains('open')) {
            showClientStatement(clientName, month);
        }
    }
}

function confirmQuickPay(method) {
    const orderId = document.getElementById('qpOrderId').value;
    const o = orders.find(x => x.id === orderId);
    if (!o) return;
    o.isPaid     = true;
    o.paidAmount = o.total;
    o.paidAt     = new Date().toISOString();
    o.paidMethod = method;
    _markDirtyOrder(orderId); // delta sync 마킹
    closeQuickPay(true);
    _saveAndFlush(); renderOrders(); renderDashboard(); updateInfoCounts(); updateNavBadges();
    _refreshUnpaidIfActive();
    _refreshSettlementIfActive();
    const icon = method === 'transfer' ? '🏦' : '💵';
    toast(icon + ' ' + (method === 'transfer' ? '계좌이체' : '현금') + ' 완납 처리', 'var(--green)');
}

function toggleVoidOrder(id) {
    const o = orders.find(o => o.id === id);
    if (!o) return;
    o.isVoid = !o.isVoid;
    _markDirtyOrder(id); // delta sync 마킹
    saveData(); renderOrders(); renderDashboard(); updateInfoCounts(); updateNavBadges();
    _refreshUnpaidIfActive();
    _refreshSettlementIfActive();
    toast(o.isVoid ? '👤 타인거래로 변경 — 재고 차감 미반영' : '↩ 내 거래로 변경 — 재고는 수동 확인 필요', o.isVoid ? 'var(--orange)' : 'var(--green)');
}

async function deleteOrder(id) {
    if (!await customConfirm('전표를 삭제할까요?')) return;
    const o = orders.find(o=>o.id===id);
    if (!o) return;

    // ── 자동 재고 복구 (stockAutoDeduct ON이고 타인거래가 아니고 재고에 등록된 품목이 있을 때) ──
    if (stockAutoDeduct && !o.isVoid) {
        const matchedItems = (o.items||[]).filter(it => findStockByName(it.name));
        if (matchedItems.length > 0) {
            const doRestore = await customConfirm(
                `자동 재고 차감이 켜져 있습니다.\n\n` +
                `이 납품 전표(${o.clientName} · ${o.date})의\n` +
                `재고를 복구할까요?\n\n` +
                matchedItems.map(it => `· ${it.name} +${it.qty}${findStockByName(it.name)?.unit||''}`).join('\n'),
                '재고 복구', 'btn-primary'
            );
            if (doRestore) {
                matchedItems.forEach(it => {
                    const si = findStockByName(it.name);
                    if (!si) return;
                    const before = si.qty;
                    si.qty = before + (Number(it.qty)||0);
                    (si.log = si.log||[]).unshift({
                        type:'restore', qty: si.qty-before, before, after:si.qty,
                        reason:`납품삭제복구(${o.clientName}·${o.date})`,
                        date: todayKST(), originalDate: o.date, at: new Date().toISOString()
                    });
                    si.log = _trimLogByDate(si.log);
                });
                // 재고 갱신은 아래 공통 처리에서
                toast('↩ 재고가 복구되었습니다', 'var(--green)');
            }
        }
    }

    orders = orders.filter(o=>o.id!==id);
    _markDeletedOrder(id); // delta sync 마킹
    saveData(); renderOrders(); updateInfoCounts(); renderDashboard(); updateNavBadges();
    _refreshUnpaidIfActive();
    _refreshStockIfActive();
    _refreshSettlementIfActive();
    toast('🗑️ 전표 삭제 완료');
}

// ─── 내역탭 거래처 정보 수정 ───

function openClientEditFromHistory(clientId, clientName) {
    // clientId로 먼저 찾고, 없으면 이름으로 탐색
    const c = clients.find(c => c.id === clientId)
           || clients.find(c => c.name === clientName);
    if (!c) {
        return toast('❗ 거래처 정보를 찾을 수 없습니다\n(거래처 탭에서 먼저 등록해주세요)');
    }
    document.getElementById('ceditClientId').value  = c.id;
    document.getElementById('ceditName').value      = c.name;
    document.getElementById('ceditPhone').value     = c.phone   || '';
    document.getElementById('ceditAddress').value   = c.address || '';
    document.getElementById('ceditNote').value      = c.note    || '';
    document.getElementById('ceditNewName').value   = '';
    // 이름 변경 섹션 접기 초기화
    document.getElementById('ceditRenameBody').style.display = 'none';
    document.getElementById('ceditRenameArrow').textContent  = '▼';
    openModal('clientEditModal');
}

function toggleCeditRename() {
    const body  = document.getElementById('ceditRenameBody');
    const arrow = document.getElementById('ceditRenameArrow');
    const open  = body.style.display !== 'none';
    body.style.display  = open ? 'none' : 'block';
    arrow.textContent   = open ? '▼' : '▲';
    if (!open) setTimeout(() => document.getElementById('ceditNewName').focus(), 50);
}

function saveClientEditFromHistory() {
    const id      = document.getElementById('ceditClientId').value;
    const phone   = document.getElementById('ceditPhone').value.trim();
    const address = document.getElementById('ceditAddress').value.trim();
    const note    = document.getElementById('ceditNote').value.trim();
    const newName = document.getElementById('ceditNewName').value.trim();

    const c = clients.find(c => c.id === id);
    if (!c) return toast('❗ 거래처를 찾을 수 없습니다');

    // 이름 변경 처리
    if (newName && newName !== c.name) {
        // 중복 체크
        const dup = clients.some(x => x.name.toLowerCase() === newName.toLowerCase() && x.id !== id);
        if (dup) return toast('❗ 이미 존재하는 거래처명입니다');
        const oldName = c.name;
        c.name = newName;
        // 관련 전표에 이름 일괄 반영
        let orderCount = 0;
        const oldNameTrim = oldName.trim();
        orders.forEach(o => {
            const idMatch   = o.clientId && o.clientId === id;
            const nameMatch = (o.clientName || '').trim() === oldNameTrim;
            if (idMatch || nameMatch) {
                o.clientName = newName;
                if (!o.clientId || o.clientId !== id) {
                    o.clientId = id;
                }
                _markDirtyOrder(o.id); // delta sync 마킹
                orderCount++;
            }
        });
        toast(`✅ 거래처명 변경 완료 (전표 ${orderCount}건 반영)`, 'var(--green)');
    }

    c.phone     = phone;
    c.address   = address;
    c.note      = note;
    c.updatedAt = new Date().toISOString();

    saveData();
    renderOrders();
    renderClients();
    renderDashboard();
    updateNavBadges();
    _refreshSettlementIfActive();
    closeModal('clientEditModal');
    if (!newName) toast('✅ 거래처 정보가 수정되었습니다', 'var(--green)');
}

// ─── 전표 수정 ───
let _oeditItems = [];   // 현재 편집 중인 품목 배열

function openOrderEdit(id) {
    const o = orders.find(o => o.id === id);
    if (!o) return toast('❗ 전표를 찾을 수 없습니다');
    document.getElementById('oeditOrderId').value    = id;
    document.getElementById('oeditClientName').value = o.clientName || '';
    document.getElementById('oeditDate').value       = o.date || '';
    document.getElementById('oeditNote').value       = o.note || '';
    _oeditItems = (o.items || []).map(it => ({ ...it }));  // 깊은 복사
    // ③ 타인거래 토글 초기화
    _applyOeditVoidUI(!!o.isVoid);
    renderOeditItems();
    openModal('orderEditModal');
}

// ③ 타인거래 토글 UI 적용
function _applyOeditVoidUI(isVoid) {
    const sw   = document.getElementById('oeditVoidSwitch');
    const knob = document.getElementById('oeditVoidKnob');
    if (!sw || !knob) return;
    // data-void 속성으로 상태 관리 (DOM 스타일 비교 취약점 제거)
    sw.dataset.void = isVoid ? '1' : '0';
    if (isVoid) {
        sw.style.background   = 'rgba(245,166,35,0.25)';
        sw.style.borderColor  = 'rgba(245,166,35,0.6)';
        knob.style.background = 'var(--orange)';
        knob.style.transform  = 'translateX(20px)';
    } else {
        sw.style.background   = 'var(--surf3)';
        sw.style.borderColor  = 'var(--border)';
        knob.style.background = 'var(--text3)';
        knob.style.transform  = 'translateX(0)';
    }
}

// ③ 토글 클릭 시 상태 전환
function toggleOeditVoid() {
    const sw   = document.getElementById('oeditVoidSwitch');
    if (!sw) return;
    // 현재 ON 여부: knob이 오른쪽으로 이동해 있으면 ON
    const knob = document.getElementById('oeditVoidKnob');
    const isCurrentlyVoid = sw.dataset.void === '1';
    _applyOeditVoidUI(!isCurrentlyVoid);
}

function renderOeditItems() {
    const list = document.getElementById('oeditItemList');
    if (!_oeditItems.length) {
        // items가 없는 경우: _noItems 전표(오프라인 저장 시 압축됨)인지 일반 빈 전표인지 구분 불가
        // → 안내 메시지 표시
        list.innerHTML = '<div style="text-align:center;color:var(--text3);font-size:13px;padding:12px 0;margin-bottom:8px;">품목이 없습니다. 온라인 연결 후 앱을 재실행하면 품목이 복원됩니다.<br>직접 추가하셔도 됩니다.</div>';
    } else {
        list.innerHTML = _oeditItems.map((it, i) => {
            const isLast = i === _oeditItems.length - 1;
            const nextNameSel = isLast ? null : `.oedit-item-row:nth-child(${i+2}) .oedit-item-input`;
            const onPriceEnter = isLast
                ? `if(event.key==='Enter'){event.preventDefault();const nn=document.getElementById('oeditNewName');if(nn&&nn.value.trim()){nn.focus();}else{saveOrderEdit();}}`
                : `if(event.key==='Enter'){event.preventDefault();document.querySelectorAll('.oedit-item-row')[${i+1}].querySelectorAll('.oedit-item-input')[0].focus();}`;
            return `
            <div class="oedit-item-row">
                <div class="oedit-item-name">
                    <input class="oedit-item-input" type="text" value="${(it.name||'').replace(/"/g,'&quot;')}"
                        enterkeyhint="next"
                        oninput="_oeditItems[${i}].name=this.value;_oeditRecalc()"
                        onkeydown="if(event.key==='Enter'){event.preventDefault();this.closest('.oedit-item-row').querySelectorAll('.oedit-item-input')[1].focus();}"
                        style="width:100%;font-weight:700;">
                </div>
                <div class="oedit-qty-wrap">
                    <input class="oedit-item-input" type="number" value="${it.qty||0}" min="1"
                        enterkeyhint="next"
                        oninput="_oeditItems[${i}].qty=parseInt(this.value)||0;_oeditItems[${i}].total=_oeditItems[${i}].qty*_oeditItems[${i}].price;_oeditRecalc()"
                        onkeydown="if(event.key==='Enter'){event.preventDefault();this.closest('.oedit-item-row').querySelectorAll('.oedit-item-input')[2].focus();}">
                </div>
                <div class="oedit-price-wrap">
                    <input class="oedit-item-input" type="text" inputmode="numeric" value="${(it.price||0)>0?Number(it.price).toLocaleString('ko-KR'):0}" min="0"
                        data-oedit-price="${i}"
                        enterkeyhint="${isLast ? 'next' : 'next'}"
                        oninput="(function(el,idx){const v=parseInt(el.value.replace(/[^0-9]/g,''))||0;_oeditItems[idx].price=v;_oeditItems[idx].total=_oeditItems[idx].qty*v;_oeditRecalc();const f=v>0?v.toLocaleString('ko-KR'):el.value;if(el.value!==f){const s=el.selectionStart;el.value=f;try{el.setSelectionRange(f.length,f.length);}catch(e){}};})(this,${i})"
                        onkeydown="${onPriceEnter}">
                </div>
                <button class="oedit-del-btn" onclick="_oeditItems.splice(${i},1);renderOeditItems()">✕</button>
            </div>`;
        }).join('');
    }
    _oeditRecalc();
}

function _oeditRecalc() {
    const total = _oeditItems.reduce((s, it) => s + (Number(it.qty)||0) * (Number(it.price)||0), 0);
    const el = document.getElementById('oeditTotal');
    if (el) el.textContent = fmt(total) + '원';
}

function oeditAddItem() {
    const name  = (document.getElementById('oeditNewName').value  || '').trim();
    const qty   = parseInt(document.getElementById('oeditNewQty').value)   || 0;
    const price = _moneyVal('oeditNewPrice');
    if (!name)  return toast('❗ 품목명을 입력하세요');
    if (qty <= 0) return toast('❗ 수량을 1 이상 입력하세요');
    _oeditItems.push({ name, qty, price, total: qty * price });
    document.getElementById('oeditNewName').value  = '';
    document.getElementById('oeditNewQty').value   = '';
    document.getElementById('oeditNewPrice').value = '';
    renderOeditItems();
    document.getElementById('oeditNewName').focus();
}

function saveOrderEdit() {
    const id   = document.getElementById('oeditOrderId').value;
    const date = document.getElementById('oeditDate').value;
    const note = document.getElementById('oeditNote').value.trim();
    if (!date) return toast('❗ 납품 일자를 선택하세요');
    if (!_oeditItems.length) return toast('❗ 품목을 1개 이상 추가하세요');
    // 품목명 공백 체크
    if (_oeditItems.some(it => !(it.name||'').trim())) return toast('❗ 품목명을 모두 입력하세요');

    const o = orders.find(o => o.id === id);
    if (!o) return toast('❗ 전표를 찾을 수 없습니다');

    // ── 자동 재고 보정 (수정 전후 수량 차이 반영, 타인거래 제외) ──
    if (stockAutoDeduct && !o.isVoid) {
        // 수정 전 품목 맵 { 정규화된이름: qty }
        const oldMap = {};
        (o.items||[]).forEach(it => {
            const key = normItemName(it.name);
            oldMap[key] = (oldMap[key]||0) + (Number(it.qty)||0);
        });
        // 수정 후 품목 맵
        const newMap = {};
        _oeditItems.forEach(it => {
            const key = normItemName(it.name);
            newMap[key] = (newMap[key]||0) + (Number(it.qty)||0);
        });
        // 모든 품목명 합집합
        const allKeys = new Set([...Object.keys(oldMap), ...Object.keys(newMap)]);
        allKeys.forEach(key => {
            const oldQty = oldMap[key]||0;
            const newQty = newMap[key]||0;
            const diff   = newQty - oldQty; // 양수면 더 납품, 음수면 덜 납품
            if (diff === 0) return;
            // 품목명은 newMap에 있으면 새 이름으로, 없으면 oldMap 이름으로 탐색
            const itemName = (_oeditItems.find(it=>normItemName(it.name)===key)||o.items.find(it=>normItemName(it.name)===key)||{}).name||key;
            const si = findStockByName(itemName);
            if (!si) return;
            const before = si.qty;
            // diff > 0 → 추가 납품 → 재고 감소 / diff < 0 → 수량 감소 → 재고 증가
            si.qty = Math.max(0, before - diff);
            const actual = si.qty - before;
            // 수정보정은 증가/감소 모두 'edit_adj' 사용
            // 'in' 사용 시 입고 통계 오염 및 refreshStockCarryover todayIn 이중 합산 문제 발생
            const logType = 'edit_adj';
            (si.log = si.log||[]).unshift({
                type: logType, qty: actual, before, after: si.qty,
                reason: '납품수정보정(' + (o.clientName||'') + ')',
                date: todayKST(), at: new Date().toISOString()
            });
            si.log = _trimLogByDate(si.log);
        });
        // 재고 갱신은 아래 공통 처리에서
    }

    const items = _oeditItems.map(it => ({
        name:  (it.name||'').trim(),
        qty:   Number(it.qty)   || 0,
        price: Number(it.price) || 0,
        total: (Number(it.qty)||0) * (Number(it.price)||0)
    }));
    const total = items.reduce((s, it) => s + it.total, 0);

    o.date  = date;
    o.items = items;
    o.total = total;
    o.totalAmount = total;
    o.note  = note;
    o.updatedAt = new Date().toISOString();
    _markDirtyOrder(o.id); // delta sync 마킹
    // ③ 타인거래 토글 반영
    const oeditSw = document.getElementById('oeditVoidSwitch');
    const newIsVoid = oeditSw ? oeditSw.dataset.void === '1' : !!o.isVoid;
    const wasVoid = !!o.isVoid;
    o.isVoid = newIsVoid;
    // 타인거래 → 내거래 전환 시 자동 재고 차감 보정 (위 품목 차이 보정과 별도로 처리됨)
    // 내거래 → 타인거래 전환 시 이미 차감된 재고는 복구하지 않음 (데이터 일관성 유지)
    // ── paidAmount 캡핑: 새 합계보다 초과 지불된 경우 조정 ──
    let _autoCompleted = false;
    if (!o.isPaid) {
        if ((o.paidAmount||0) >= total && total > 0) {
            o.isPaid     = true;
            o.paidAmount = total;
            // 수정으로 완납 처리 시 discount는 의미 없으므로 초기화
            delete o.discount;
            _autoCompleted = true;
        } else if ((o.paidAmount||0) > total) {
            o.paidAmount = 0;
            delete o.discount;
        }
    } else {
        // 이미 완납 상태면 paidAmount를 새 합계로 동기화, discount 재계산
        if (o.discount > 0) {
            // 할인 완납 전표: 실수령액이 새 합계보다 크면 discount 제거
            if ((o.paidAmount||0) >= total) {
                o.paidAmount = total;
                delete o.discount;
            }
        } else {
            o.paidAmount = total;
        }
    }
    // 단가 캐시 갱신
    items.forEach(it => { if (it.price > 0) prices[it.name] = it.price; });

    saveData();
    renderOrders();
    renderDashboard();
    updateInfoCounts();
    updateNavBadges();
    updateItemDatalist(o.clientId || '');
    _refreshUnpaidIfActive();
    _refreshStockIfActive();
    _refreshSettlementIfActive();
    // 명세표가 열려 있으면 자동 갱신
    if (document.getElementById('statementModal')?.classList.contains('open')) {
        showClientStatement(o.clientName, o.date.slice(0, 7));
    }
    closeModal('orderEditModal');
    const voidMsg = newIsVoid !== wasVoid
        ? (newIsVoid ? ' · 👤 타인거래로 변경' : ' · ↩ 내거래로 변경')
        : '';
    toast(_autoCompleted
        ? '💚 수정 완료 — 단가 감소로 완납 처리되었습니다' + voidMsg
        : '✅ 납품 내역이 수정되었습니다' + voidMsg, 'var(--green)');
}

function showOrderDetail(id) {
    const o = orders.find(o=>o.id===id);
    if (!o) return;
    document.getElementById('detailContent').innerHTML = `
        <div style="margin-bottom:14px;">
            <div style="font-size:18px;font-weight:700;margin-bottom:4px;">${escapeHtml(o.clientName||'(없음)')}</div>
            <div style="font-size:13px;color:var(--text2);">납품일: ${escapeHtml(o.date)}</div>
        </div>
        <div style="overflow-x:auto;">
        <table class="detail-table">
            <thead><tr><th>품목</th><th class="text-center">수량</th><th class="text-right">단가</th><th class="text-right">금액</th></tr></thead>
            <tbody>
                ${o._noItems
                    ? `<tr><td colspan="4" style="text-align:center;color:var(--text2);padding:12px;font-size:12px;">📡 품목 상세는 온라인 연결 후 Firebase에서 조회됩니다</td></tr>`
                    : (o.items||[]).map(it=>`<tr><td>${escapeHtml(it.name)}</td><td class="text-center">${escapeHtml(it.qty)}</td><td class="text-right">${fmt(it.price)}원</td><td class="text-right">${fmt(it.qty*it.price)}원</td></tr>`).join('')
                }
            </tbody>
            <tfoot>
                <tr style="font-weight:700;"><td colspan="3">합계</td><td class="text-right">${fmt(o.total)}원</td></tr>
            </tfoot>
        </table>
        </div>
        ${o.note?`<div style="margin-top:12px;padding:10px;background:var(--surf3);border-radius:8px;font-size:13px;"><strong>메모:</strong> ${escapeHtml(o.note)}</div>`:''}`;
    openModal('detailModal');
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  § 9  정산                                                     ║
// ╚══════════════════════════════════════════════════════════════╝

// ─── 정산 ───

function setSettleUnit(btn) {
    document.querySelectorAll('.settle-unit-tab').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    settleUnit = btn.dataset.unit;
    // 컨트롤 패널 토글
    document.getElementById('settle-ctrl-monthly').style.display   = settleUnit==='monthly'   ? '' : 'none';
    document.getElementById('settle-ctrl-daily').style.display     = settleUnit==='daily'     ? '' : 'none';
    document.getElementById('settle-ctrl-quarterly').style.display = settleUnit==='quarterly' ? '' : 'none';
    // 결과 섹션 토글
    document.getElementById('settle-section-monthly').style.display   = settleUnit==='monthly'   ? '' : 'none';
    document.getElementById('settle-section-daily').style.display     = settleUnit==='daily'     ? '' : 'none';
    document.getElementById('settle-section-quarterly').style.display = settleUnit==='quarterly' ? '' : 'none';
    // 월별 탭: settlementTable display를 settleListVisible과 동기화
    if (settleUnit === 'monthly') {
        const st = document.getElementById('settlementTable');
        const sb = document.getElementById('settleToggleBtn');
        if (st) st.style.display = settleListVisible ? 'block' : 'none';
        if (sb) sb.textContent = settleListVisible ? '숨기기' : '보이기';
    }
    // 렌더
    _refreshSettlementIfActive();
}

function setSettlePeriod(btn) {
    document.querySelectorAll('#settle-ctrl-monthly .period-tab').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    const p = btn.dataset.period;
    if (p==='current') {
        document.getElementById('settlementMonth').value = todayKST().slice(0,7);
        renderSettlement();
    } else if (p==='last') {
        const cur = todayKST().slice(0,7); // 'YYYY-MM'
        const [y, m] = cur.split('-').map(Number);
        const prevM = m === 1 ? 12 : m - 1;
        const prevY = m === 1 ? y - 1 : y;
        document.getElementById('settlementMonth').value = `${prevY}-${String(prevM).padStart(2,'0')}`;
        renderSettlement();
    }
    // 'custom' → 사용자가 직접 month 인풋 조작
}

function setSettlePeriodDaily(btn) {
    document.querySelectorAll('#settle-ctrl-daily .period-tab').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    const p = btn.dataset.dperiod;
    const input = document.getElementById('settlementDateDaily');
    const today = todayKST();
    if (p === 'today') {
        input.value = today;
    } else if (p === 'yesterday') {
        input.value = kstAddDays(today, -1);
    } else if (p === 'prev') {
        input.value = kstAddDays(input.value || today, -1);
    } else if (p === 'next') {
        input.value = kstAddDays(input.value || today, +1);
    }
    renderSettlementDaily();
}

function setSettleYearQuick(btn) {
    document.querySelectorAll('#settle-ctrl-quarterly .period-tab').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    const _yr = parseInt(todayKST().slice(0, 4));
    document.getElementById('settlementYear').value = btn.dataset.qy==='current' ? _yr : _yr-1;
    renderSettlementQuarterly();
}

function setSettleFilter(f, btn) {
    settleFilter = f;
    document.querySelectorAll('#settlePayFilter .chip').forEach(b=>b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    _refreshSettlementIfActive();
}

// ── 공통 필터 적용 ──

function applyPayFilter(list) {
    // 타인거래도 모든 정산에 포함 (재고 차감만 제외)
    if (settleFilter==='unpaid') return list.filter(o=>!o.isPaid);
    if (settleFilter==='paid')   return list.filter(o=>o.isPaid);
    return list;
}

// ── 요약 박스 렌더 ──

function renderSummaryBox(totalSales, paidAmount, unpaidAmount) {
    document.getElementById('settlementSummary').innerHTML = `
        <div class="settlement-box">
            <div class="settlement-row"><span>총 매출</span><span>${fmt(totalSales)}원</span></div>
            <div class="settlement-row"><span>수금액</span><span>${fmt(paidAmount)}원</span></div>
            <div class="settlement-row"><span>미수금</span><span>${fmt(unpaidAmount)}원</span></div>
        </div>`;
}

// ── 월별 정산 ──

function renderSettlement() {
    const month = document.getElementById('settlementMonth').value;
    if (!month) return;
    let filtered = applyPayFilter(orders.filter(o=>o.date?.startsWith(month)));
    const _et = o => o.isPaid && o.discount > 0 ? o.total - o.discount : o.total;
    const totalSales   = filtered.reduce((s,o)=>s+_et(o),0);
    const paidAmount   = filtered.reduce((s,o)=>s+_actualPaid(o),0);
    const unpaidAmount = totalSales - paidAmount;
    renderSummaryBox(totalSales, paidAmount, unpaidAmount);
    // 캐시
    window._settleMap = {};
    window._settleMonth = month;
    filtered.forEach(o => {
        const key = o.clientName||'(없음)';
        if (!window._settleMap[key]) window._settleMap[key]={total:0,paid:0,count:0};
        window._settleMap[key].total += o.total;
        window._settleMap[key].paid += _actualPaid(o);
        window._settleMap[key].count++;
    });
    if (settleListVisible) renderSettleTable();
}

// ── 일별 정산 (날짜 선택 → 해당일 상세) ──

function renderSettlementDaily() {
    const date = document.getElementById('settlementDateDaily').value;
    const el = document.getElementById('settlementDailyTable');
    if (!date) {
        document.getElementById('settlementSummary').innerHTML = '';
        el.innerHTML = '<div class="empty"><div class="empty-text">날짜를 선택하세요</div></div>';
        return;
    }

    const dow = ['일','월','화','수','목','금','토'][new Date(date + 'T12:00:00+09:00').getDay()];
    const [yr, mo, dd] = date.split('-');
    const dateLabel = `${yr}년 ${parseInt(mo)}월 ${parseInt(dd)}일 (${dow})`;

    let dayOrders = applyPayFilter(orders.filter(o => o.date === date));
    const _et = o => o.isPaid && o.discount > 0 ? o.total - o.discount : o.total;
    const totalSales  = dayOrders.reduce((s,o)=>s+_et(o),0);
    const paidAmount  = dayOrders.reduce((s,o)=>s+_actualPaid(o),0);
    const unpaidAmt   = totalSales - paidAmount;

    // 요약 박스
    document.getElementById('settlementSummary').innerHTML = `
        <div class="settlement-box">
            <div style="font-size:12px;opacity:.8;margin-bottom:8px;">📅 ${dateLabel}</div>
            <div class="settlement-row"><span>총 매출</span><span>${fmt(totalSales)}원</span></div>
            <div class="settlement-row"><span>수금액</span><span>${fmt(paidAmount)}원</span></div>
            <div class="settlement-row"><span>미수금</span><span>${fmt(unpaidAmt)}원</span></div>
        </div>`;

    if (!dayOrders.length) {
        el.innerHTML = '<div class="empty"><div class="empty-text">해당 날짜 납품 내역이 없습니다</div></div>';
        return;
    }

    // 거래처별 그룹핑
    const clientMap = {};
    dayOrders.forEach(o => {
        const k = o.clientName||'(없음)';
        if (!clientMap[k]) clientMap[k] = [];
        clientMap[k].push(o);
    });

    el.innerHTML = `
        <div style="font-size:11px;color:var(--text2);margin-bottom:8px;">총 ${dayOrders.length}건 · ${Object.keys(clientMap).length}개 거래처</div>
        ${Object.entries(clientMap).map(([cname, list]) => {
            const _et = o => o.isPaid && o.discount > 0 ? o.total - o.discount : o.total;
            const cTotal  = list.reduce((s,o)=>s+_et(o),0);
            const cPaid   = list.reduce((s,o)=>s+_actualPaid(o),0);
            return `
            <div class="card" style="margin-bottom:10px;padding:12px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                    <span style="font-weight:900;font-size:15px;color:var(--accent);">${cname}</span>
                    <span style="font-size:12px;color:var(--text2);">${list.length}건</span>
                </div>
                ${list.map(o => `
                    <div style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:7px;background:var(--surf3);">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                            <span style="font-size:13px;font-weight:700;">${fmt(o.total)}원</span>
                            <span class="pay-badge ${o.isPaid?'paid':'unpaid'}" style="cursor:default;font-size:10px;">${o.isPaid?'완납':'미수'}</span>
                        </div>
                        <div style="font-size:12px;color:var(--text2);">
                            ${(o.items||[]).map(i=>`${i.name} ${i.qty}개 × ${fmt(i.price||0)}원`).join(' / ')}
                        </div>
                        ${o.note?`<div style="font-size:11px;color:var(--text3);margin-top:4px;">📝 ${o.note}</div>`:''}
                    </div>`).join('')}
                <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700;padding-top:6px;border-top:1px solid var(--border);">
                    <span>소계</span>
                    <span style="color:${cPaid<cTotal?'var(--red)':'var(--green)'};">${fmt(cTotal)}원 ${cPaid<cTotal?'(미수 '+fmt(cTotal-cPaid)+'원)':'✅'}</span>
                </div>
            </div>`;
        }).join('')}`;
}

// ── 분기별 정산 ──

function renderSettlementQuarterly() {
    const year = parseInt(document.getElementById('settlementYear').value);
    if (!year) return;

    const quarters = [
        { label:'1분기', months:['01','02','03'], emoji:'🌱' },
        { label:'2분기', months:['04','05','06'], emoji:'☀️' },
        { label:'3분기', months:['07','08','09'], emoji:'🍂' },
        { label:'4분기', months:['10','11','12'], emoji:'❄️' },
    ];

    let allYearOrders = applyPayFilter(orders.filter(o=>o.date?.startsWith(String(year))));
    const _et = o => o.isPaid && o.discount > 0 ? o.total - o.discount : o.total;
    const yearTotal  = allYearOrders.reduce((s,o)=>s+_et(o),0);
    const yearPaid   = allYearOrders.reduce((s,o)=>s+_actualPaid(o),0);
    renderSummaryBox(yearTotal, yearPaid, yearTotal-yearPaid);

    const qData = quarters.map(q => {
        const mos = q.months.map(m=>`${year}-${m}`);
        const list = applyPayFilter(orders.filter(o=> mos.some(m=>o.date?.startsWith(m))));
        const sales  = list.reduce((s,o)=>s+_et(o),0);
        const paid   = list.reduce((s,o)=>s+_actualPaid(o),0);
        // 월별 세부
        const monthRows = q.months.map(m => {
            const ml = applyPayFilter(orders.filter(o=>o.date?.startsWith(`${year}-${m}`)));
            const ms = ml.reduce((s,o)=>s+_et(o),0);
            const mp = ml.reduce((s,o)=>s+_actualPaid(o),0);
            return { month:`${year}-${m}`, sales:ms, paid:mp, count:ml.length };
        });
        return { ...q, sales, paid, unpaid:sales-paid, count:list.length, monthRows };
    });

    const maxQ = Math.max(...qData.map(q=>q.sales), 1);
    const el = document.getElementById('settlementQuarterlyTable');

    el.innerHTML = `
        <div class="quarter-grid">
            ${qData.map(q => {
                const pct = Math.round(q.sales/maxQ*100);
                const yearPct = yearTotal>0 ? Math.round(q.sales/yearTotal*100) : 0;
                return `
                <div class="quarter-card">
                    <div class="q-label">${q.emoji} ${q.label}</div>
                    <div class="q-sales">${fmt(q.sales)}원</div>
                    <div class="q-sub">${q.count}건 · 연간 ${yearPct}%</div>
                    ${q.unpaid>0?`<div class="q-unpaid">미수 ${fmt(q.unpaid)}원</div>`:'<div style="color:var(--green);font-size:11px;font-weight:700;margin-top:4px;">✅ 완납</div>'}
                    <div class="quarter-bar"><div class="quarter-bar-fill" style="width:${pct}%;"></div></div>
                </div>`;
            }).join('')}
        </div>

        <div class="card" style="margin-top:4px;">
            <div class="card-title">분기별 월 세부 내역</div>
            ${qData.map(q=>`
                <div style="margin-bottom:14px;">
                    <div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:6px;">${q.emoji} ${q.label}</div>
                    <div class="table-wrap">
                    <table class="daily-table" style="min-width:unset;">
                        <thead><tr>
                            <th>월</th><th>건수</th><th>매출</th><th>수금</th><th>미수</th>
                        </tr></thead>
                        <tbody>
                            ${q.monthRows.map(r=>`
                                <tr class="${r.sales===0?'day-zero':''}">
                                    <td>${r.month.slice(5)}월</td>
                                    <td>${r.count||'-'}</td>
                                    <td>${r.sales?fmt(r.sales)+'원':'-'}</td>
                                    <td>${r.sales?fmt(r.paid)+'원':'-'}</td>
                                    <td style="color:var(--red);">${r.sales?(r.sales-r.paid?fmt(r.sales-r.paid)+'원':'✅'):'-'}</td>
                                </tr>`).join('')}
                            <tr style="font-weight:700;background:var(--surf3);">
                                <td>소계</td>
                                <td>${q.count}</td>
                                <td>${fmt(q.sales)}원</td>
                                <td>${fmt(q.paid)}원</td>
                                <td style="color:var(--red);">${q.unpaid?fmt(q.unpaid)+'원':'✅'}</td>
                            </tr>
                        </tbody>
                    </table>
                    </div>
                </div>`).join('')}
        </div>`;
}

function toggleSettleList() {
    settleListVisible = !settleListVisible;
    const el = document.getElementById('settlementTable');
    el.style.display = settleListVisible ? 'block' : 'none';
    document.getElementById('settleToggleBtn').textContent = settleListVisible ? '숨기기' : '보이기';
    if (settleListVisible) renderSettleTable();
}

function renderSettleTable() {
    const q   = document.getElementById('settleSearch').value;
    const map = window._settleMap||{};
    const month = window._settleMonth||'';
    let entries = Object.entries(map).sort((a,b)=>a[0].localeCompare(b[0],'ko'));
    if (q) entries = entries.filter(([name])=>matchSearch(name,q));
    const el = document.getElementById('settlementTable');
    if (!entries.length) { el.innerHTML='<div class="empty"><div class="empty-text">해당 기간 내역이 없습니다</div></div>'; return; }
    el.innerHTML = `
        <p style="font-size:11px;color:var(--text2);margin-bottom:6px;">💡 거래처 클릭 시 상세 명세서 · ${entries.length}개 거래처</p>
        <div class="settle-table-wrap">
        <table class="settle-table">
            <thead><tr>
                <th>거래처</th>
                <th class="text-center">건수</th>
                <th class="text-right">매출</th>
                <th class="text-right">수금</th>
                <th class="text-right">미수</th>
            </tr></thead>
            <tbody>
                ${entries.map(([name,d])=>`
                    <tr onclick="showClientStatement('${escapeAttr(name)}','${escapeAttr(month)}')">
                        <td style="color:var(--accent);font-weight:700;">${highlight(name, q)}</td>
                        <td class="text-center">${d.count}</td>
                        <td class="text-right">${fmt(d.total)}원</td>
                        <td class="text-right">${fmt(d.paid)}원</td>
                        <td class="text-right" style="color:var(--red);">${fmt(d.total-d.paid)}원</td>
                    </tr>`).join('')}
            </tbody>
        </table>
        </div>`;
}

function onSettleSearch(q) {
    // 검색어 있을 때 테이블 자동 노출
    if (q && !settleListVisible) {
        settleListVisible = true;
        const el = document.getElementById('settlementTable');
        el.style.display = 'block';
        document.getElementById('settleToggleBtn').textContent = '숨기기';
    }
    // _settleMap이 비어있으면 renderSettlement 먼저 실행
    if (!window._settleMap || !Object.keys(window._settleMap).length) {
        renderSettlement();
    }
    renderSettleTable();
}

// ─── 거래명세표 공유 (카카오톡 / 시스템 공유 시트) ───

let _statShareText = ''; // 현재 열린 명세표 공유 텍스트 (버튼에서 참조)

async function shareStatement() {
    const text = _statShareText;
    if (!text) return;
    // 1순위: Web Share API → 안드로이드에서 카카오톡·문자·기타 앱 선택 가능
    if (navigator.share) {
        try {
            await navigator.share({ title: '거래명세표', text });
            return;
        } catch(e) {
            if (e.name === 'AbortError') return; // 사용자가 취소
            // 다른 오류면 클립보드 폴백으로 진행
        }
    }
    // 2순위: 클립보드 복사 후 안내
    try {
        await navigator.clipboard.writeText(text);
        toast('📋 내용이 복사됐습니다. 카카오톡에서 붙여넣기 하세요.', 'var(--accent)', 3000);
    } catch(e) {
        // 3순위: 구형 브라우저 폴백
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        toast('📋 내용이 복사됐습니다. 카카오톡에서 붙여넣기 하세요.', 'var(--accent)', 3000);
    }
}

function showClientStatement(clientName, month) {
    const monthStart = month+'-01';
    const filt = orders.filter(o=>o.clientName===clientName&&o.date?.startsWith(month)).sort((a,b)=>(a.date||'').localeCompare(b.date||''));
    // 할인 완납된 전표는 실청구액(total - discount)으로 집계
    const _effectiveTotal = o => o.isPaid && o.discount > 0 ? o.total - o.discount : o.total;
    const monthTotal  = filt.reduce((s,o)=>s+_effectiveTotal(o),0);
    // 수금액 = 완납전표 합산 + 부분입금 누적액
    const monthPaid   = filt.reduce((s,o)=>s+_actualPaid(o),0);
    const monthUnpaid = monthTotal - monthPaid;
    const carryOrders = orders.filter(o=>o.clientName===clientName&&o.date<monthStart&&!o.isPaid).sort((a,b)=>(a.date||"").localeCompare(b.date||""));
    const carryAmt    = carryOrders.reduce((s,o)=>s+o.total-(o.paidAmount||0),0);
    const grandUnpaid = carryAmt + monthUnpaid;
    // ── 오늘 이전까지(어제까지) 해당 거래처 전체 납품 합계 ──
    const todayStr = todayKST();
    const beforeTodayOrders = orders.filter(o=>o.clientName===clientName && o.date < todayStr && o.date?.startsWith(month));
    const beforeTodayTotal  = beforeTodayOrders.reduce((s,o)=>s+_effectiveTotal(o),0);
    const client = clients.find(c=>c.name===clientName);
    const phone  = client?.phone||'';
    const _monthLabel = (() => { const p = month.split('-'); return p.length >= 2 ? `${parseInt(p[1])}월` : month; })();
    const smsText = `[${clientName}님 ${_monthLabel} 거래명세표]\n기간: ${month}\n전월이월: ${fmt(carryAmt)}원\n당월매출: ${fmt(monthTotal)}원\n수금액: ${fmt(monthPaid)}원\n청구금액: ${fmt(grandUnpaid)}원\n\n입금계좌: 농협 916-02-055664 (이애경)`;
    // 카카오톡 / 공유용 — 품목 상세 포함
    const orderLines = filt.map(o => {
        const itemStr = (o.items||[]).length ? (o.items||[]).map(i=>`${i.name} ${i.qty}개`).join(', ') : '(품목 정보 없음)';
        const stateStr = o.isPaid ? '✅완납' : (o.paidAmount ? `💳부분(${fmt(o.paidAmount)}원)` : '🔴미수');
        return `  ${o.date}  ${itemStr}  ${fmt(o.total)}원 ${stateStr}`;
    }).join('\n');
    _statShareText = [
        `📋 [${clientName}님 ${_monthLabel} 거래명세표]`,
        `📅 기간: ${month}`,
        carryAmt > 0 ? `⏩ 전월 이월: ${fmt(carryAmt)}원` : '',
        `💰 당월 매출: ${fmt(monthTotal)}원`,
        `💳 수금액: ${fmt(monthPaid)}원`,
        `🔴 청구 금액: ${fmt(grandUnpaid)}원`,
        `\n🏦 입금계좌: 농협 916-02-055664 (이애경)`,
        orderLines ? `\n📦 납품 내역\n${orderLines}` : '',
    ].filter(Boolean).join('\n');
    const carryRows = carryOrders.map(o=>{
        const carryPartial = !o.isPaid && (o.paidAmount||0)>0;
        const carryRemain  = carryPartial ? o.total-(o.paidAmount||0) : 0;
        const carryPartialRow = carryPartial ? `
        <tr style="background:rgba(245,158,11,0.08);">
            <td colspan="4" style="padding:5px 8px 7px 22px;border-top:none;">
                <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                    <span style="font-size:10px;font-weight:700;color:#60a5fa;letter-spacing:.5px;">💳 부분 수금</span>
                    <span style="font-size:12px;font-weight:800;color:#60a5fa;">${fmt(o.paidAmount)}원</span>
                    ${o.paidAt ? `<span style="font-size:10px;color:var(--text3);">${o.paidAt.slice(0,10)}</span>` : ''}
                    ${_methodBadgeHtml(o.paidMethod)}
                    ${o.paidNote ? `<span style="font-size:10px;color:var(--text2);background:var(--surf3);padding:1px 6px;border-radius:4px;">📝 ${o.paidNote}</span>` : ''}
                    <span style="margin-left:auto;font-size:10px;color:var(--red);font-weight:700;">잔여 ${fmt(carryRemain)}원</span>
                    <button onclick="openPayEdit('${o.id||''}','${escapeAttr(clientName)}','${escapeAttr(month)}')" style="padding:3px 8px;border-radius:6px;border:1px solid #60a5fa44;background:#60a5fa18;color:#60a5fa;font-size:10px;font-weight:700;cursor:pointer;">✏️ 수정</button>
                </div>
            </td>
        </tr>` : '';
        return `
        <tr style="background:var(--surf3);cursor:pointer;" onclick="openQuickPayFromStatement('${o.id||''}','${escapeAttr(clientName)}','${escapeAttr(month)}')" title="탭하여 결제 처리">
            <td style="color:var(--orange);font-size:12px;">${o.date}</td>
            <td style="font-size:11px;">${_fmtItems(o)}</td>
            <td class="text-right" style="color:var(--orange);">${fmt(o.total)}원${carryPartial?`<br><small style="color:#60a5fa;">수금 ${fmt(o.paidAmount)}원</small>`:''}</td>
            <td class="text-center"><span class="pay-badge unpaid" style="cursor:default;font-size:9px;">이월</span></td>
        </tr>${carryPartialRow}`;
    }).join('');
    const monthRows = filt.map(o=>{
        const partial = !o.isPaid && (o.paidAmount||0)>0;
        const remain  = partial ? o.total-(o.paidAmount||0) : 0;
        const voidBadge = o.isVoid ? `<br><span style="font-size:9px;background:rgba(245,166,35,.15);color:var(--orange);border-radius:4px;padding:1px 4px;font-weight:700;">👤타인</span>` : '';
        const statBadge = o.isPaid
            ? (o.discount>0
                ? `<span class="pay-badge paid" style="cursor:default;font-size:9px;">✂️할인완납</span>${voidBadge}`
                : `<span class="pay-badge paid" style="cursor:default;font-size:9px;">완납</span>${voidBadge}`)
            : partial
            ? `<span class="pay-badge" style="cursor:default;font-size:9px;background:#3b82f625;color:#60a5fa;font-weight:800;">부분<br><small>${fmt(o.paidAmount)}원</small></span>${voidBadge}`
            : `<span class="pay-badge unpaid" style="cursor:default;font-size:9px;">미수</span>${voidBadge}`;
        // 부분 결제 세부 행
        const partialDetailRow = partial ? `
        <tr style="background:rgba(59,130,246,0.06);">
            <td colspan="4" style="padding:5px 8px 7px 22px;border-top:none;">
                <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                    <span style="font-size:10px;font-weight:700;color:#60a5fa;letter-spacing:.5px;">💳 부분 수금</span>
                    <span style="font-size:12px;font-weight:800;color:#60a5fa;">${fmt(o.paidAmount)}원</span>
                    ${o.paidAt ? `<span style="font-size:10px;color:var(--text3);">${o.paidAt.slice(0,10)}</span>` : ''}
                    ${_methodBadgeHtml(o.paidMethod)}
                    ${o.paidNote ? `<span style="font-size:10px;color:var(--text2);background:var(--surf3);padding:1px 6px;border-radius:4px;">📝 ${o.paidNote}</span>` : ''}
                    <span style="margin-left:auto;font-size:10px;color:var(--red);font-weight:700;">잔여 ${fmt(remain)}원</span>
                    <button onclick="openPayEdit('${o.id||''}','${escapeAttr(clientName)}','${escapeAttr(month)}')" style="padding:3px 8px;border-radius:6px;border:1px solid #60a5fa44;background:#60a5fa18;color:#60a5fa;font-size:10px;font-weight:700;cursor:pointer;">✏️ 수정</button>
                </div>
            </td>
        </tr>` : '';
        const rowClick = o.isPaid
            ? `showOrderDetail('${o.id||''}')`
            : `openQuickPayFromStatement('${o.id||''}','${escapeAttr(clientName)}','${escapeAttr(month)}')`;
        const rowTitle = o.isPaid ? '탭하여 상세 보기' : '탭하여 결제 처리';
        const rowAccent = !o.isPaid ? 'background:rgba(239,68,68,0.04);' : '';
        return `<tr style="cursor:pointer;${rowAccent}" onclick="${rowClick}" title="${rowTitle}">
            <td>${o.date}</td>
            <td style="font-size:11px;">${_fmtItems(o)}</td>
            <td class="text-right">${fmt(o.total)}원</td>
            <td class="text-center">${statBadge}</td>
        </tr>${partialDetailRow}`;
    }).join('');
    document.getElementById('statementContent').innerHTML = `
        <div style="margin-bottom:14px;display:flex;align-items:baseline;justify-content:space-between;gap:8px;">
            <div style="font-size:19px;font-weight:900;">${clientName}</div>
            <div style="font-size:19px;font-weight:900;white-space:nowrap;">${month} 거래명세표</div>
        </div>
        <div style="background:var(--surf2);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:14px;">
            ${carryAmt>0?`<div style="display:flex;justify-content:space-between;margin-bottom:7px;"><span style="color:var(--orange);">⏩ 전월 이월</span><strong style="color:var(--orange);">${fmt(carryAmt)}원</strong></div>`:''}
            <div style="display:flex;justify-content:space-between;margin-bottom:7px;"><span style="color:var(--text2);">이번 달 합계 (어제까지)</span><strong style="color:var(--text);">${fmt(beforeTodayTotal)}원</strong></div>
            <div style="display:flex;justify-content:space-between;margin-bottom:7px;"><span style="color:var(--text2);">당월 매출</span><strong style="color:var(--accent);">${fmt(monthTotal)}원</strong></div>
            <div style="display:flex;justify-content:space-between;margin-bottom:7px;"><span style="color:var(--text2);">수금액</span><strong style="color:var(--green);">${fmt(monthPaid)}원</strong></div>
            <div style="display:flex;justify-content:space-between;border-top:2px solid var(--red);padding-top:9px;margin-top:3px;">
                <span style="color:var(--red);font-weight:700;">청구 금액</span>
                <strong style="color:var(--red);font-size:18px;">${fmt(grandUnpaid)}원</strong>
            </div>
        </div>
        ${(()=>{
            // 부분 수금 이력이 있는 전표만 추출 (당월 + 이월 모두)
            const allMonthOrders = [...carryOrders, ...filt];
            const partialOrders = allMonthOrders.filter(o => (o.paidAmount||0) > 0);
            if (!partialOrders.length) return '';
            const rows = partialOrders.map(o => {
                const isCarry = o.date < monthStart;
                const oId = o.id || '';
                return `<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border);flex-wrap:wrap;">
                    <div style="min-width:72px;font-size:11px;color:${isCarry?'var(--orange)':'var(--text2)'};">${o.date}${isCarry?' <span style="font-size:9px;">(이월)</span>':''}</div>
                    <div style="flex:1;font-size:11px;color:var(--text2);min-width:80px;">${(o.items||[]).map(i=>i.name).join(', ')}</div>
                    <div style="text-align:right;">
                        <div style="font-size:13px;font-weight:800;color:#60a5fa;">💳 ${fmt(o.paidAmount)}원 수금</div>
                        ${o.discount>0?`<div style="font-size:11px;color:var(--orange);font-weight:700;">✂️ 할인 ${fmt(o.discount)}원</div>`:''}
                        ${_methodBadgeHtml(o.paidMethod)}
                        ${o.paidMethod==='mixed'&&o.paidMethodDetail?`<div style="font-size:10px;color:var(--text2);">🏦${fmt(o.paidMethodDetail.transfer||0)}원 + 💵${fmt(o.paidMethodDetail.cash||0)}원</div>`:''}
                        ${o.paidAt?`<div style="font-size:10px;color:var(--text3);">${o.paidAt.slice(0,10)}</div>`:''}
                        ${o.paidNote?`<div style="font-size:10px;color:var(--text2);">📝 ${o.paidNote}</div>`:''}
                        ${!o.isPaid?`<div style="font-size:10px;color:var(--red);">잔여 ${fmt(o.total-(o.paidAmount||0))}원</div>`:`<div style="font-size:10px;color:var(--green);">✅ 완납</div>`}
                    </div>
                    <button onclick="openPayEdit('${oId}','${escapeAttr(clientName)}','${escapeAttr(month)}')" style="flex-shrink:0;padding:5px 10px;border-radius:7px;border:1px solid var(--border);background:var(--surf3);color:var(--text2);font-size:11px;font-weight:700;cursor:pointer;">✏️ 수정</button>
                </div>`;
            }).join('');
            const totalPartialPaid = partialOrders.reduce((s,o)=>s+(o.paidAmount||0),0);
            return `<div style="background:rgba(59,130,246,0.07);border:1px solid rgba(59,130,246,0.25);border-radius:10px;padding:13px 14px;margin-bottom:14px;">
                <div style="font-size:11px;font-weight:700;color:#60a5fa;letter-spacing:.8px;text-transform:uppercase;margin-bottom:10px;">💳 수금 이력 (${partialOrders.length}건 · 합계 ${fmt(totalPartialPaid)}원)</div>
                ${rows}
            </div>`;
        })()}
        <div style="overflow-x:auto;">
        <table class="settle-table" style="min-width:300px;">
            <thead><tr><th>날짜</th><th>품목</th><th class="text-right">금액</th><th class="text-center">상태</th></tr></thead>
            <tbody>
                ${carryRows}
                ${monthRows||'<tr><td colspan="4" style="text-align:center;color:var(--text3);padding:14px;">당월 내역 없음</td></tr>'}
            </tbody>
        </table>
        </div>
        <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;">
            ${phone?`<a href="sms:${phone}?body=${encodeURIComponent(smsText)}" class="btn btn-success" style="flex:1;min-width:80px;text-decoration:none;text-align:center;">💬 문자</a>`:''}
            <button class="btn btn-primary" style="flex:1;min-width:80px;" onclick="saveStatementPNG('${escapeAttr(clientName)}','${escapeAttr(month)}')">🖼️ PNG 저장</button>
        </div>
        <button onclick="shareStatement()" style="width:100%;margin-top:8px;padding:13px;border-radius:var(--radius-s);border:none;background:#FEE500;color:#191919;font-size:14px;font-weight:800;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;letter-spacing:-.3px;">
            <svg width="20" height="20" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg"><ellipse cx="20" cy="18" rx="18" ry="14" fill="#191919"/><path fill="#FEE500" d="M11 18a2.5 2.5 0 1 0 5 0 2.5 2.5 0 0 0-5 0zm8.5 0a1 1 0 1 0 2 0 1 1 0 0 0-2 0zm3.5 0a2.5 2.5 0 1 0 5 0 2.5 2.5 0 0 0-5 0z"/><path fill="#191919" d="M15 25l-2 6 5-3"/></svg>
            카카오톡으로 보내기
        </button>
        ${grandUnpaid > 0 ? `
        <button class="btn-partial-pay" onclick="openPartialPay('${escapeAttr(clientName)}','${escapeAttr(month)}')">
            💳 입금 처리 (부분 · 전체)
        </button>
        <button class="btn-bulk-pay" onclick="bulkPayClient('${escapeAttr(clientName)}','${escapeAttr(month)}')">
            💚 미수금 전체 완납 (${fmt(grandUnpaid)}원)
        </button>` : `<div style="text-align:center;color:var(--green);font-weight:700;margin-top:10px;font-size:13px;">✅ 완납 완료</div>`}`;
    openModal('statementModal');
}

// ─── 거래처 명세표 JPG 저장 ───

function saveStatementPNG(clientName, month) {
    const monthStart = month + '-01';
    const filt = orders.filter(o => o.clientName === clientName && o.date?.startsWith(month))
                       .sort((a, b) => (a.date||"").localeCompare(b.date||""));
    const _effectiveTotal = o => o.isPaid && o.discount > 0 ? o.total - o.discount : o.total;
    const monthTotal  = filt.reduce((s, o) => s + _effectiveTotal(o), 0);
    const monthPaid   = filt.reduce((s,o)=>s+_actualPaid(o),0);
    const monthUnpaid = monthTotal - monthPaid;
    const carryOrders = orders.filter(o => o.clientName === clientName && o.date < monthStart && !o.isPaid)
                              .sort((a, b) => (a.date||"").localeCompare(b.date||""));
    const carryAmt    = carryOrders.reduce((s, o) => s + o.total - (o.paidAmount || 0), 0);
    const grandUnpaid = carryAmt + monthUnpaid;

    const carryRows = carryOrders.map(o => `
        <tr class="carry-row">
            <td>${o.date}</td>
            <td>${(o.items || []).map(i => `${i.name}(${i.qty})`).join(', ')}</td>
            <td class="num">${fmt(o.total)}원</td>
            <td class="center"><span class="badge carry">이월</span></td>
        </tr>`).join('');

    const monthRows = filt.map(o => {
        const partial = !o.isPaid && (o.paidAmount || 0) > 0;
        const remain  = partial ? o.total - (o.paidAmount || 0) : 0;
        const badge   = o.isPaid
            ? '<span class="badge paid">완납</span>'
            : partial
            ? `<span class="badge part">부분<br><small>${fmt(o.paidAmount)}원</small></span>`
            : '<span class="badge unpaid">미수</span>';
        return `<tr>
            <td>${o.date}</td>
            <td>${(o.items || []).map(i => `${i.name}(${i.qty})`).join(', ')}</td>
            <td class="num">${fmt(o.total)}원${partial ? `<br><small class="remain">잔여 ${fmt(remain)}원</small>` : ''}</td>
            <td class="center">${badge}</td>
        </tr>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>png_render</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    font-family: 'Apple SD Gothic Neo', 'Malgun Gothic', '맑은 고딕', sans-serif;
    font-size: 14px; color: #111; background: #fff;
    width: 480px; padding: 20px 18px 28px;
  }
  .header { display:flex; justify-content:space-between; align-items:flex-start; padding-bottom:12px; margin-bottom:14px; border-bottom:2.5px solid #111; }
  .doc-title { font-size:20px; font-weight:900; letter-spacing:-0.5px; }
  .client-name { font-size:13px; font-weight:700; color:#444; margin-top:4px; }
  .doc-meta { font-size:11px; color:#666; text-align:right; line-height:1.8; }
  .sum-grid { display:grid; grid-template-columns:${carryAmt > 0 ? 'repeat(4,1fr)' : 'repeat(3,1fr)'}; gap:6px; margin-bottom:10px; }
  .sum-card { border-radius:10px; padding:9px 6px; text-align:center; border:1.5px solid #e5e7eb; background:#fafafa; }
  .sum-label { font-size:10px; color:#888; font-weight:600; margin-bottom:4px; }
  .sum-val { font-size:14px; font-weight:900; line-height:1.2; word-break:break-all; }
  .sum-card.carry { background:#fffbeb; border-color:#fcd34d; }
  .sum-card.carry .sum-val { color:#d97706; }
  .sum-card.sales { background:#eff6ff; border-color:#93c5fd; }
  .sum-card.sales .sum-val { color:#2563eb; }
  .sum-card.paid-c { background:#f0fdf4; border-color:#86efac; }
  .sum-card.paid-c .sum-val { color:#16a34a; }
  .sum-card.charge { background:#fff1f2; border-color:#fca5a5; }
  .sum-card.charge .sum-val { color:#dc2626; }
  .charge-bar { background:#fff1f2; border:2px solid #dc2626; border-radius:10px; padding:11px 14px; margin-bottom:14px; display:flex; justify-content:space-between; align-items:center; }
  .charge-bar .c-label { font-size:13px; font-weight:700; color:#dc2626; }
  .charge-bar .c-val { font-size:22px; font-weight:900; color:#dc2626; }
  .tbl-wrap { border-radius:10px; border:1.5px solid #e5e7eb; overflow:hidden; }
  table { width:100%; border-collapse:collapse; font-size:12.5px; }
  thead th { background:#f9fafb; padding:9px 8px; border-bottom:1.5px solid #d1d5db; font-size:11px; font-weight:700; color:#555; text-align:left; }
  td { padding:9px 8px; border-bottom:1px solid #f0f0f0; vertical-align:middle; line-height:1.4; }
  tbody tr:last-child td { border-bottom:none; }
  .carry-row td { background:#fffbeb; }
  .carry-row td:first-child { color:#d97706; font-weight:600; }
  .num { text-align:right; white-space:nowrap; }
  .center { text-align:center; }
  .remain { display:block; color:#dc2626; font-size:10px; margin-top:2px; }
  .badge { display:inline-block; font-size:10px; font-weight:700; padding:3px 8px; border-radius:99px; line-height:1.3; white-space:nowrap; }
  .badge.paid { background:#dcfce7; color:#16a34a; }
  .badge.unpaid { background:#fee2e2; color:#dc2626; }
  .badge.carry { background:#fef3c7; color:#d97706; }
  .badge.part { background:#dbeafe; color:#2563eb; }
  .footer { margin-top:16px; padding-top:10px; border-top:1px solid #e5e7eb; font-size:11px; color:#aaa; text-align:center; line-height:1.8; }
/* ── 미수금 전용 탭 ── */
.unpaid-summary-bar {
    display: flex; gap: 8px; margin-bottom: 12px;
}
.unpaid-sum-card {
    flex: 1; background: var(--surf2); border: 1px solid var(--border);
    border-radius: var(--radius-s); padding: 10px 12px; text-align: center;
}
.unpaid-sum-card.danger { border-color: #ef444466; background: #ef444410; }
.unpaid-sum-label { font-size: 10px; color: var(--text2); font-weight: 700; margin-bottom: 4px; }
.unpaid-sum-val   { font-size: 17px; font-weight: 900; color: var(--text); }
.unpaid-sum-card.danger .unpaid-sum-val { color: var(--red); }

.unpaid-age-tabs { display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; }
.unpaid-age-tab  {
    padding: 5px 12px; border-radius: 20px; font-size: 11px; font-weight: 700;
    border: 1.5px solid var(--border); background: var(--surf2); color: var(--text2);
    cursor: pointer;
}
.unpaid-age-tab.active { background: var(--accent); color: #fff; border-color: var(--accent); }

.unpaid-client-card {
    background: var(--surf2); border: 1px solid var(--border);
    border-radius: var(--radius-s); padding: 12px 14px;
    margin-bottom: 8px; border-left: 4px solid var(--border);
    position: relative;
}
.unpaid-client-card.age-ok     { border-left-color: var(--accent); }
.unpaid-client-card.age-warn   { border-left-color: var(--orange); }
.unpaid-client-card.age-danger { border-left-color: #ef4444; background: #ef444408; }
.unpaid-client-card.age-severe { border-left-color: #7f1d1d; background: #ef444414; }

.unpaid-card-top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; }
.unpaid-card-name { font-size: 16px; font-weight: 900; color: var(--text); }
.unpaid-card-amt  { font-size: 18px; font-weight: 900; color: var(--red); }
.unpaid-card-meta { font-size: 11px; color: var(--text2); margin-bottom: 8px; }
.unpaid-age-badge {
    display: inline-block; font-size: 10px; font-weight: 700;
    padding: 2px 7px; border-radius: 8px; margin-left: 6px;
    background: var(--surf3); color: var(--text2);
}
.age-warn   .unpaid-age-badge { background: #f59e0b22; color: var(--orange); }
.age-danger .unpaid-age-badge { background: #ef444422; color: #ef4444; }
.age-severe .unpaid-age-badge { background: #7f1d1d33; color: #fca5a5; }
.unpaid-card-orders { font-size: 11px; color: var(--text2); margin-bottom: 10px; }
.unpaid-card-order-row {
    display: flex; justify-content: space-between; padding: 3px 0;
    border-bottom: 1px solid var(--border);
}
.unpaid-card-order-row:last-child { border-bottom: none; }
.unpaid-card-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.unpaid-card-actions a, .unpaid-card-actions button {
    flex: 1; min-width: 60px; padding: 7px 4px;
    border-radius: 7px; border: 1px solid var(--border);
    background: var(--surf3); color: var(--text2);
    font-size: 11px; font-weight: 700; cursor: pointer;
    text-align: center; text-decoration: none;
}
.unpaid-card-actions .btn-pay {
    background: var(--accent); color: #fff; border-color: var(--accent);
}
.unpaid-card-actions .btn-sms {
    background: #22c55e18; color: var(--green); border-color: #22c55e44;
}

/* 거래처 카드 미수금 강조 */
.client-card.has-unpaid { border-left: 4px solid var(--border); }
.client-card.unpaid-ok     { border-left-color: var(--accent); }
.client-card.unpaid-warn   { border-left-color: var(--orange); }
.client-card.unpaid-danger { border-left-color: #ef4444; }
.client-card.unpaid-severe { border-left-color: #7f1d1d; }
.client-unpaid-badge {
    display: inline-block; font-size: 11px; font-weight: 800;
    padding: 2px 8px; border-radius: 8px; margin-top: 4px;
    background: #ef444415; color: var(--red); border: 1px solid #ef444433;
}
.client-unpaid-badge.warn   { background: #f59e0b15; color: var(--orange); border-color: #f59e0b33; }
.client-unpaid-badge.danger { background: #ef444420; color: #ef4444; border-color: #ef444455; }
.client-unpaid-badge.severe { background: #7f1d1d30; color: #fca5a5; border-color: #7f1d1d55; }

/* 대시보드 미수 거래처 목록 */
.dash-unpaid-row {
    display: flex; justify-content: space-between; align-items: center;
    padding: 7px 0; border-bottom: 1px solid var(--border); cursor: pointer;
}
.dash-unpaid-row:last-child { border-bottom: none; }
.dash-unpaid-name { font-size: 13px; font-weight: 700; }
.dash-unpaid-info { font-size: 10px; color: var(--text2); }
.dash-unpaid-right { text-align: right; }
.dash-unpaid-amt { font-size: 14px; font-weight: 900; color: var(--red); }
.dash-unpaid-days { font-size: 10px; font-weight: 700; }
.dash-unpaid-days.warn   { color: var(--orange); }
.dash-unpaid-days.danger { color: #ef4444; }
.dash-unpaid-days.severe { color: #fca5a5; }

/* ── 수금 방법 선택 ── */
.pay-method-group { display:flex; gap:8px; margin-bottom:14px; }
.pay-method-btn {
    flex:1; padding:10px 6px; border-radius:10px;
    border:2px solid var(--border); background:var(--surf2);
    color:var(--text2); font-size:13px; font-weight:700;
    cursor:pointer; text-align:center; transition:all .15s;
}
.pay-method-btn.active {
    border-color:var(--accent); background:var(--accent);
    color:#fff;
}
.pay-method-btn.cash.active   { border-color:#22c55e; background:#22c55e; }
.pay-method-btn.transfer.active { border-color:#3b82f6; background:#3b82f6; }
.pay-method-badge {
    display:inline-block; font-size:10px; font-weight:700;
    padding:1px 7px; border-radius:6px; margin-left:5px;
    vertical-align:middle;
}
.pay-method-badge.cash     { background:#22c55e18; color:#22c55e; border:1px solid #22c55e44; }
.pay-method-badge.transfer { background:#3b82f618; color:#60a5fa; border:1px solid #3b82f644; }
.pay-method-badge.other    { background:#f59e0b18; color:var(--orange); border:1px solid #f59e0b44; }

/* ── 수금방법 퀵 팝업 ── */
.quick-pay-popup {
    position:fixed; bottom:0; left:50%; transform:translateX(-50%);
    width:100%; max-width:520px;
    background:var(--surf); border-top:2px solid var(--border);
    border-radius:20px 20px 0 0;
    padding:18px 16px 32px;
    z-index:3500;
    box-shadow:0 -8px 32px rgba(0,0,0,.35);
    transition:transform .25s cubic-bezier(.4,0,.2,1), opacity .2s;
    opacity:0; transform:translateX(-50%) translateY(100%);
}
.quick-pay-popup.open {
    opacity:1; transform:translateX(-50%) translateY(0);
}
.quick-pay-overlay {
    position:fixed; inset:0; background:rgba(0,0,0,.45);
    z-index:3499; display:none;
}
.quick-pay-overlay.open { display:block; }
.quick-pay-title {
    font-size:15px; font-weight:900; color:var(--text);
    margin-bottom:6px; text-align:center;
}
.quick-pay-sub {
    font-size:12px; color:var(--text2); margin-bottom:16px; text-align:center;
}
.quick-pay-btns { display:flex; gap:10px; }
.quick-pay-btn {
    flex:1; padding:18px 8px; border-radius:14px;
    border:2px solid var(--border); background:var(--surf2);
    color:var(--text); font-size:14px; font-weight:900;
    cursor:pointer; text-align:center; transition:all .15s;
    display:flex; flex-direction:column; align-items:center; gap:4px;
}
.quick-pay-btn:active { transform:scale(.96); }
.quick-pay-btn.cash     { border-color:#22c55e44; }
.quick-pay-btn.cash:active, .quick-pay-btn.cash:hover
                        { background:#22c55e18; border-color:#22c55e; }
.quick-pay-btn.transfer { border-color:#3b82f644; }
.quick-pay-btn.transfer:active, .quick-pay-btn.transfer:hover
                        { background:#3b82f618; border-color:#3b82f6; }
.quick-pay-btn .qp-icon { font-size:28px; }
.quick-pay-btn .qp-label { font-size:13px; font-weight:900; }
.quick-pay-btn .qp-amt  { font-size:16px; font-weight:900; color:var(--green); }
.quick-pay-cancel       { display:block; width:100%; margin-top:10px; padding:11px;
                          border-radius:10px; border:none; background:none;
                          color:var(--text2); font-size:13px; cursor:pointer; }
/* 수금 통계 분리 표시 */
.hist-sum-breakdown {
    display:flex; justify-content:center; gap:10px; margin-top:5px; flex-wrap:wrap;
}
.hist-sum-method {
    font-size:10px; font-weight:700; opacity:.9;
    background:rgba(255,255,255,.15); border-radius:6px;
    padding:2px 7px; white-space:nowrap;
}

</style>
</head>
<body>
  <div class="header">
    <div style="display:flex;justify-content:space-between;align-items:baseline;width:100%;">
      <div class="doc-title">${clientName}</div>
      <div class="doc-title">${month} 거래명세표</div>
    </div>
  </div>
  <div style="text-align:right;font-size:11px;color:#888;margin-bottom:10px;">${new Date().toLocaleDateString('ko-KR')}</div>
  <div class="sum-grid">
    ${carryAmt > 0 ? `<div class="sum-card carry"><div class="sum-label">전월이월</div><div class="sum-val">${fmt(carryAmt)}<small style="font-size:10px">원</small></div></div>` : ''}
    <div class="sum-card sales"><div class="sum-label">당월매출</div><div class="sum-val">${fmt(monthTotal)}<small style="font-size:10px">원</small></div></div>
    <div class="sum-card paid-c"><div class="sum-label">수금액</div><div class="sum-val">${fmt(monthPaid)}<small style="font-size:10px">원</small></div></div>
    <div class="sum-card charge"><div class="sum-label">청구금액</div><div class="sum-val">${fmt(grandUnpaid)}<small style="font-size:10px">원</small></div></div>
  </div>
  <div class="charge-bar">
    <span class="c-label">💳 청구 금액</span>
    <span class="c-val">${fmt(grandUnpaid)}<small style="font-size:13px">원</small></span>
  </div>
  <div class="tbl-wrap">
    <table>
      <thead><tr><th style="width:82px">날짜</th><th>품목</th><th class="num" style="width:90px">금액</th><th class="center" style="width:48px">상태</th></tr></thead>
      <tbody>
        ${carryRows}
        ${monthRows || '<tr><td colspan="4" style="text-align:center;color:#bbb;padding:20px 0;">당월 내역 없음</td></tr>'}
      </tbody>
    </table>
  </div>
  <div class="footer">DeliveryPro · ${clientName} · ${month}<br>${new Date().toLocaleString('ko-KR')} 출력</div>
</body>
</html>`;

    toast('🖼️ 이미지 생성 중...');
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:520px;height:auto;border:none;visibility:hidden;';
    document.body.appendChild(iframe);
    iframe.contentDocument.open();
    iframe.contentDocument.write(html);
    iframe.contentDocument.close();

    setTimeout(() => {
        const body = iframe.contentDocument.body;
        body.style.width = '480px';
        const h = body.scrollHeight;
        iframe.style.height = h + 'px';
        html2canvas(body, {
            scale: 2,
            useCORS: true,
            backgroundColor: '#ffffff',
            width: 480,
            height: h,
            scrollX: 0,
            scrollY: 0
        }).then(canvas => {
            document.body.removeChild(iframe);
            const link = document.createElement('a');
            link.download = `${clientName}_${month}_거래명세표.png`;
            link.href = canvas.toDataURL('image/png');
            link.click();
            toast('✅ PNG 이미지가 저장되었습니다!');
        }).catch(err => {
            document.body.removeChild(iframe);
            console.error(err);
            toast('❗ 이미지 저장 실패. 다시 시도해주세요.');
        });
    }, 800);
}

function _getUnpaidList(clientName, month) {
    // 오래된 전표부터 정렬 (이월 → 당월 순)
    const monthStart = month + '-01';
    return orders
        .filter(o => o.clientName === clientName && !o.isPaid &&
                     (o.date?.startsWith(month) || o.date < monthStart))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function openPartialPay(clientName, month) {
    const list = _getUnpaidList(clientName, month);
    if (!list.length) return toast('✅ 미수금이 없습니다');

    const total = list.reduce((s, o) => s + o.total - (o.paidAmount || 0), 0);
    const monthStart = month + '-01';
    const carry = list.filter(o => o.date < monthStart)
                      .reduce((s, o) => s + o.total - (o.paidAmount || 0), 0);

    document.getElementById('ppClientName').value        = clientName;
    document.getElementById('ppMonth').value             = month;
    document.getElementById('ppClientTitle').textContent = clientName + '  ·  ' + month;
    document.getElementById('ppTotalUnpaid').textContent = fmt(total) + '원';
    document.getElementById('ppAmount').value            = '';
    document.getElementById('ppNote').value              = '';
    document.getElementById('ppPreview').style.display   = 'none';

    // 이월 표시
    const carryRow = document.getElementById('ppCarryRow');
    if (carry > 0) {
        carryRow.style.display = 'flex';
        document.getElementById('ppCarryAmt').textContent = fmt(carry) + '원';
    } else {
        carryRow.style.display = 'none';
    }

    // 빠른 금액 버튼 생성
    const seen = new Set();
    const btns = [];
    const add = (label, val) => {
        if (val > 0 && val <= total && !seen.has(val)) {
            seen.add(val); btns.push({ label, val });
        }
    };
    add('전체 ' + fmt(total) + '원', total);
    if (carry > 0 && carry < total) add('이월 ' + fmt(carry) + '원', carry);
    const half = Math.round(total / 2 / 1000) * 1000;
    if (half > 0) add('절반 ' + fmt(half) + '원', half);
    [500000, 300000, 200000, 100000, 50000].forEach(v => add(fmt(v) + '원', v));

    document.getElementById('ppQuickBtns').innerHTML = btns.slice(0, 5).map(b =>
        '<button type="button" class="chip" style="font-size:11px;padding:5px 10px;"' +
        ' onclick="_setMoneyVal(\'ppAmount\',' + b.val + ');previewPartialPay()">' +
        b.label + '</button>'
    ).join('');

    _setPayMethod('pp', 'cash');
    // 혼합 UI 초기화
    const mixedGrp  = document.getElementById('ppMixedGroup');
    const singleGrp = document.getElementById('ppSingleAmtGroup');
    const quickBtns = document.getElementById('ppQuickBtns');
    if (mixedGrp)  { mixedGrp.style.display = 'none'; }
    if (singleGrp) { singleGrp.style.display = ''; }
    if (quickBtns) { quickBtns.style.display = ''; }
    const ppTransfer = document.getElementById('ppTransferAmt');
    const ppCash     = document.getElementById('ppCashAmt');
    const ppMixedPv  = document.getElementById('ppMixedPreview');
    if (ppTransfer) ppTransfer.value = '';
    if (ppCash)     ppCash.value = '';
    if (ppMixedPv)  ppMixedPv.style.display = 'none';
    openModal('partialPayModal');
    setTimeout(() => document.getElementById('ppAmount').focus(), 80);
}

function previewPartialPay() {
    const clientName = document.getElementById('ppClientName').value;
    const month      = document.getElementById('ppMonth').value;
    const amount     = _moneyVal('ppAmount') || 0;
    const preview    = document.getElementById('ppPreview');
    if (amount <= 0) { preview.style.display = 'none'; return; }

    const list  = _getUnpaidList(clientName, month);
    const total = list.reduce((s, o) => s + o.total - (o.paidAmount || 0), 0);
    let remain  = amount;
    const rows  = [];

    for (const o of list) {
        if (remain <= 0) break;
        const due   = o.total - (o.paidAmount || 0);
        const apply = Math.min(due, remain);
        remain -= apply;
        const full = apply >= due;
        rows.push(
            o.date + '&nbsp;&nbsp;<b>' + fmt(apply) + '원</b>&nbsp;&nbsp;' +
            (full ? '<span style="color:var(--green);">→ 완납 ✅</span>'
                  : '<span style="color:var(--orange);">→ 잔여 ' + fmt(due - apply) + '원</span>')
        );
    }
    if (remain > 0) {
        rows.push('<span style="color:var(--orange);">⚠ 미수금보다 ' + fmt(remain) + '원 초과</span>');
    }
    const after = Math.max(0, total - amount);
    rows.push('<hr style="border:none;border-top:1px solid var(--border);margin:5px 0;">');
    rows.push('입금 후 잔여 미수금: <b style="color:' +
        (after > 0 ? 'var(--red)' : 'var(--green)') + ';">' + fmt(after) + '원</b>');

    preview.innerHTML = rows.join('<br>');
    preview.style.display = 'block';
}


// ─── 수금 방법 선택 ───
function selectPayMethod(prefix, method, btn) {
    const group = document.getElementById(prefix + 'MethodGroup');
    if (!group) return;
    group.querySelectorAll('.pay-method-btn').forEach(b => {
        b.classList.remove('active');
    });
    btn.classList.add('active');
    // pp 모달: 혼합 선택 시 분리 입력 UI 표시
    if (prefix === 'pp') {
        const isMixed = method === 'mixed';
        const singleGrp = document.getElementById('ppSingleAmtGroup');
        const mixedGrp  = document.getElementById('ppMixedGroup');
        const quickBtns = document.getElementById('ppQuickBtns');
        if (singleGrp) singleGrp.style.display = isMixed ? 'none' : '';
        if (mixedGrp)  mixedGrp.style.display  = isMixed ? 'block' : 'none';
        if (quickBtns) quickBtns.style.display  = isMixed ? 'none' : '';
        if (isMixed) {
            document.getElementById('ppTransferAmt').value = '';
            document.getElementById('ppCashAmt').value = '';
            document.getElementById('ppMixedPreview').style.display = 'none';
        }
        const sheet = document.getElementById('partialPayModal')?.querySelector('.modal-sheet');
        if (sheet) setTimeout(() => sheet.scrollTo({ top: sheet.scrollHeight, behavior: 'smooth' }), 80);
    }
}

function _getPayMethod(prefix) {
    const group = document.getElementById(prefix + 'MethodGroup');
    if (!group) return 'cash';
    const active = group.querySelector('.pay-method-btn.active');
    return active ? active.dataset.method : 'cash';
}

function _setPayMethod(prefix, method) {
    const group = document.getElementById(prefix + 'MethodGroup');
    if (!group) return;
    group.querySelectorAll('.pay-method-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.method === (method || 'cash'));
    });
}

function _methodLabel(method) {
    if (method === 'transfer') return '🏦 계좌이체';
    if (method === 'other')    return '📝 기타';
    if (method === 'mixed')    return '💳 혼합결제';
    return '💵 현금';
}
function _methodBadgeHtml(method) {
    if (!method || method === 'cash')     return '<span class="pay-method-badge cash">💵현금</span>';
    if (method === 'transfer') return '<span class="pay-method-badge transfer">🏦이체</span>';
    if (method === 'mixed')    return '<span class="pay-method-badge" style="background:#7c3aed22;color:#a78bfa;">💳혼합</span>';
    return '<span class="pay-method-badge other">📝기타</span>';
}

function previewMixedPay() {
    const clientName = document.getElementById('ppClientName').value;
    const month      = document.getElementById('ppMonth').value;
    const transfer   = _moneyVal('ppTransferAmt');
    const cash       = _moneyVal('ppCashAmt');
    const total      = transfer + cash;
    const preview    = document.getElementById('ppMixedPreview');
    if (!preview) return;
    if (total <= 0) { preview.style.display = 'none'; return; }
    const list    = _getUnpaidList(clientName, month);
    const unpaid  = list.reduce((s, o) => s + o.total - (o.paidAmount || 0), 0);
    const remain  = unpaid - total;
    let html = `🏦 이체 <strong>${fmt(transfer)}원</strong> + 💵 현금 <strong>${fmt(cash)}원</strong> = 합계 <strong>${fmt(total)}원</strong><br>`;
    if (remain > 0)        html += `<span style="color:var(--orange);">잔여 미수금 ${fmt(remain)}원</span>`;
    else if (remain === 0) html += `<span style="color:var(--green);">✅ 전액 완납</span>`;
    else                   html += `<span style="color:var(--red);">⚠ 미수금(${fmt(unpaid)}원) 초과 ${fmt(-remain)}원</span>`;
    preview.innerHTML = html;
    preview.style.display = 'block';
}

function togglePpDiscount() {
    const body   = document.getElementById('ppDiscountBody');
    const toggle = document.getElementById('ppDiscountToggle');
    const open   = body.style.display !== 'none';
    body.style.display = open ? 'none' : 'block';
    toggle.classList.toggle('open', !open);
}

// 입금처리 모달 — 할인 완납: 입금액만큼 받고 나머지 차액은 할인으로 완납 처리
async function confirmPartialPayDiscount() {
    const clientName = document.getElementById('ppClientName').value;
    const month      = document.getElementById('ppMonth').value;
    const amount     = _moneyVal('ppAmount');
    const note       = document.getElementById('ppNote').value.trim();
    const method     = _getPayMethod('pp');

    if (method === 'mixed') return toast('❗ 할인 완납은 단일 수금 방법(현금/이체)으로만 가능합니다');
    if (!amount || amount <= 0) return toast('❗ 실수령액을 입력하세요');

    const list  = _getUnpaidList(clientName, month);
    if (!list.length) return toast('✅ 미수금이 없습니다');

    const total = list.reduce((s, o) => s + o.total - (o.paidAmount || 0), 0);
    if (amount > total) return toast('❗ 실수령액이 총 미수금보다 많습니다');

    if (!await customConfirm(
        `총 미수금 ${fmt(total)}원 중\n` +
        `실수령 ${fmt(amount)}원, 할인 ${fmt(total - amount)}원으로\n✅ 전체 완납 처리할까요?`,
        '완납 처리', 'btn-primary'
    )) return;

    const now = new Date().toISOString();
    let remain = amount;

    for (const o of list) {
        const due = o.total - (o.paidAmount || 0);
        if (due <= 0) continue;
        const apply = Math.min(due, remain);
        remain -= apply;
        const discountAmt = due - apply; // 이 전표에 적용된 할인액
        o.isPaid     = true;
        o.paidAmount = (o.paidAmount || 0) + apply;  // 실수령액만 저장
        o.paidAt     = now;
        o.paidMethod = method;
        if (discountAmt > 0) o.discount = (o.discount || 0) + discountAmt;
        if (note) o.paidNote = note; else delete o.paidNote;
    }

    _saveAndFlush();
    closeModal('partialPayModal');
    renderOrders(); renderDashboard(); updateInfoCounts(); updateNavBadges();
    _refreshUnpaidIfActive();
    _refreshSettlementIfActive();
    showClientStatement(clientName, month);
    const discount = total - amount;
    toast(`✂️ 할인 완납 처리 (할인 ${fmt(discount)}원)`, 'var(--green)');
}

async function confirmPartialPay() {
    const clientName = document.getElementById('ppClientName').value;
    const month      = document.getElementById('ppMonth').value;
    const note       = document.getElementById('ppNote').value.trim();
    const method     = _getPayMethod('pp');

    // ── 혼합 결제 분기 ──
    if (method === 'mixed') {
        const transferAmt = _moneyVal('ppTransferAmt');
        const cashAmt     = _moneyVal('ppCashAmt');
        const total       = transferAmt + cashAmt;
        if (total <= 0) return toast('❗ 이체/현금 금액을 입력하세요');
        if (transferAmt <= 0 && cashAmt <= 0) return toast('❗ 이체 또는 현금 금액을 입력하세요');

        const list   = _getUnpaidList(clientName, month);
        if (!list.length) return toast('✅ 미수금이 없습니다');
        const unpaid = list.reduce((s, o) => s + o.total - (o.paidAmount || 0), 0);
        if (total > unpaid) {
            if (!await customConfirm(`입금액(${fmt(total)}원)이 미수금(${fmt(unpaid)}원)보다 많습니다.\n전체 완납으로 처리할까요?`, '전체 완납')) return;
        }

        let remain = total, fullCnt = 0, partCnt = 0;
        const now  = new Date().toISOString();
        for (const o of list) {
            if (remain <= 0) break;
            const due   = o.total - (o.paidAmount || 0);
            const apply = Math.min(due, remain);
            remain -= apply;
            // 비율로 이 전표분 이체/현금 배분
            const ratio = total > 0 ? apply / total : 0;
            const applyTransfer = Math.round(transferAmt * ratio);
            const applyCash     = apply - applyTransfer;
            o.paidMethodDetail = {
                transfer: applyTransfer,
                cash:     applyCash
            };
            if (apply >= due) {
                o.isPaid = true; o.paidAmount = o.total; o.paidAt = now; o.paidMethod = 'mixed';
                if (note) o.paidNote = note; else delete o.paidNote;
                fullCnt++;
            } else {
                o.paidAmount = (o.paidAmount || 0) + apply; o.paidAt = now; o.paidMethod = 'mixed';
                if (note) o.paidNote = note; else delete o.paidNote;
                partCnt++;
            }
        }
        _saveAndFlush(); closeModal('partialPayModal');
        renderOrders(); renderDashboard(); updateInfoCounts(); updateNavBadges();
        _refreshUnpaidIfActive();
        _refreshSettlementIfActive();
        showClientStatement(clientName, month);
        toast(`💳 혼합 완납 (🏦${fmt(transferAmt)}원 + 💵${fmt(cashAmt)}원)`, 'var(--green)');
        return;
    }

    // ── 기존 단일 방법 처리 ──
    const amount = _moneyVal('ppAmount');

    if (!amount || amount <= 0) return toast('❗ 입금액을 입력하세요');

    const list  = _getUnpaidList(clientName, month);
    if (!list.length) return toast('✅ 미수금이 없습니다');

    const total = list.reduce((s, o) => s + o.total - (o.paidAmount || 0), 0);
    if (amount > total) {
        if (!await customConfirm(
            '입금액(' + fmt(amount) + '원)이 미수금(' + fmt(total) + '원)보다 많습니다.\n전체 완납으로 처리할까요?',
            '전체 완납'
        )) return;
    }

    let remain = amount, fullCnt = 0, partCnt = 0;
    const now  = new Date().toISOString();

    for (const o of list) {
        if (remain <= 0) break;
        const due   = o.total - (o.paidAmount || 0);
        const apply = Math.min(due, remain);
        remain -= apply;

        if (apply >= due) {
            // 완납
            o.isPaid     = true;
            o.paidAmount = o.total;
            o.paidAt     = now;
            o.paidMethod = (o.paidMethod && o.paidMethod !== method) ? 'mixed' : method;
            if (note) o.paidNote = note; else delete o.paidNote;
            fullCnt++;
        } else {
            // 부분 입금
            o.paidAmount = (o.paidAmount || 0) + apply;
            o.paidAt     = now;
            o.paidMethod = (o.paidMethod && o.paidMethod !== method) ? 'mixed' : method;
            if (note) o.paidNote = note; else delete o.paidNote;
            partCnt++;
        }
    }

    _saveAndFlush();
    closeModal('partialPayModal');
    renderOrders(); renderDashboard(); updateInfoCounts(); updateNavBadges();
    _refreshUnpaidIfActive();
    _refreshSettlementIfActive();
    showClientStatement(clientName, month);

    const methodLbl = _methodLabel(method);
    const msg = fullCnt > 0 && partCnt > 0
        ? methodLbl + ' ' + fullCnt + '건 완납 + 부분 입금 처리 완료'
        : fullCnt > 0
            ? methodLbl + ' ' + fullCnt + '건 완납 처리 완료'
            : methodLbl + ' 부분 입금 ' + fmt(amount) + '원 처리 완료';
    toast(msg, 'var(--green)');
}

// ─── 수금 수정 ───

function openPayEdit(orderId, clientName, month) {
    const o = orders.find(x => String(x.id) === String(orderId));
    if (!o) return toast('❗ 전표를 찾을 수 없습니다');

    document.getElementById('peOrderId').value    = orderId;
    document.getElementById('peClientName').value = clientName;
    document.getElementById('peMonth').value      = month;

    const itemNames = (o.items||[]).map(i=>`${i.name}(${i.qty})`).join(', ');
    document.getElementById('peOrderInfo').textContent  = `${o.date} · ${itemNames}`;
    document.getElementById('peOrderTotal').textContent = fmt(o.total) + '원';
    _setMoneyVal('peAmount', o.paidAmount || 0);
    document.getElementById('peNote').value   = o.paidNote || '';

    // 빠른 버튼: 0원(취소), 절반, 전액
    const seen = new Set();
    const btns = [];
    const addBtn = (label, val) => {
        if (!seen.has(val)) { seen.add(val); btns.push({ label, val }); }
    };
    addBtn('전액 ' + fmt(o.total) + '원', o.total);
    const half = Math.round(o.total / 2 / 1000) * 1000;
    if (half > 0 && half < o.total) addBtn('절반 ' + fmt(half) + '원', half);
    [500000, 300000, 200000, 100000, 50000].forEach(v => { if (v < o.total) addBtn(fmt(v) + '원', v); });
    addBtn('수금 취소 (0원)', 0);

    document.getElementById('peQuickBtns').innerHTML = btns.slice(0, 5).map(b =>
        `<button type="button" class="chip" style="font-size:11px;padding:5px 10px;"
         onclick="_setMoneyVal('peAmount',${b.val});">${b.label}</button>`
    ).join('');

    // statementModal 위에 표시
    _setPayMethod('pe', o.paidMethod || 'cash');
    openModal('payEditModal');
    setTimeout(() => document.getElementById('peAmount').focus(), 80);
}

function confirmPayEdit() {
    const orderId    = document.getElementById('peOrderId').value;
    const clientName = document.getElementById('peClientName').value;
    const month      = document.getElementById('peMonth').value;
    const amount     = _moneyVal('peAmount');
    const note       = document.getElementById('peNote').value.trim();
    const method     = _getPayMethod('pe');

    const o = orders.find(x => String(x.id) === String(orderId));
    if (!o) return toast('❗ 전표를 찾을 수 없습니다');

    if (amount < 0) return toast('❗ 0 이상의 금액을 입력하세요');

    if (amount === 0) {
        // 수금 취소 → 미수로 복귀
        o.paidAmount = 0;
        o.isPaid     = false;
        delete o.paidAt; delete o.paidNote; delete o.paidMethod; delete o.paidMethodDetail;
        toast('🔴 수금 취소 — 미수로 변경됨');
    } else if (amount >= o.total) {
        // 완납
        o.paidAmount = o.total;
        o.isPaid     = true;
        o.paidAt     = new Date().toISOString();
        o.paidMethod = method;
        if (note) o.paidNote = note; else delete o.paidNote;
        toast('💚 완납으로 수정됨 · ' + _methodLabel(method), 'var(--green)');
    } else {
        // 부분 수금 수정
        o.paidAmount = amount;
        o.isPaid     = false;
        o.paidAt     = new Date().toISOString();
        o.paidMethod = method;
        if (note) o.paidNote = note; else delete o.paidNote;
        toast(_methodLabel(method) + ' ' + fmt(amount) + '원으로 수정됨', 'var(--green)');
    }

    _saveAndFlush();
    closeModal('payEditModal');
    showClientStatement(clientName, month);
    renderOrders(); renderDashboard(); updateInfoCounts(); updateNavBadges();
    _refreshUnpaidIfActive();
    _refreshSettlementIfActive();
}

async function confirmPayEditCancel() {
    if (!await customConfirm('이 전표의 수금을 취소하고 미수로 되돌릴까요?')) return;
    document.getElementById('peAmount').value = '';
    confirmPayEdit();
}



// 전체완납 팝업 상태
let _bulkPayState = null;

function bulkPayClient(clientName, month) {
    const monthStart = month + '-01';
    const unpaidList = orders.filter(o =>
        o.clientName === clientName &&
        (o.date?.startsWith(month) || o.date < monthStart) &&
        !o.isPaid
    );
    if (!unpaidList.length) return toast('✅ 미수금이 없습니다');
    const total = unpaidList.reduce((s,o)=>s+o.total-(o.paidAmount||0),0);
    // 팝업으로 수금방법 선택
    _bulkPayState = { clientName, month, unpaidList, total };
    document.getElementById('bulkPaySub').textContent =
        `${clientName} · ${unpaidList.length}건 · ${fmt(total)}원 전체 완납`;
    document.getElementById('bulkPayOverlay').classList.add('open');
    document.getElementById('bulkPayPopup').classList.add('open');
}

function closeBulkPayPopup() {
    document.getElementById('bulkPayOverlay').classList.remove('open');
    document.getElementById('bulkPayPopup').classList.remove('open');
    _bulkPayState = null;
}

function _doBulkPay(selectedMethod) {
    if (!_bulkPayState) return;
    const { clientName, month, unpaidList } = _bulkPayState;
    closeBulkPayPopup();
    const now = new Date().toISOString();
    unpaidList.forEach(o => { o.isPaid = true; o.paidAmount = o.total; o.paidAt = now; o.paidMethod = selectedMethod; });
    _saveAndFlush();
    showClientStatement(clientName, month);
    renderOrders(); renderDashboard(); updateInfoCounts(); updateNavBadges();
    _refreshUnpaidIfActive();
    _refreshSettlementIfActive();
    toast(`💚 ${unpaidList.length}건 완납 처리 완료 · ${_methodLabel(selectedMethod)}`, 'var(--green)');
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  § 10  대시보드                                                   ║
// ╚══════════════════════════════════════════════════════════════╝

function renderDashboard() {
    const month = todayKST().slice(0,7);
    const curr  = orders.filter(o=>o.date?.startsWith(month));
    const _et   = o => o.isPaid && o.discount > 0 ? o.total - o.discount : o.total;
    const sales  = curr.reduce((s,o)=>s+_et(o),0);
    // 미수금: 전체 기간 누적 미수금
    const totalUnpaid = orders.reduce((s, o) => {
        const remain = Math.max(0, o.total - _actualPaid(o));
        return s + (o.isPaid ? 0 : remain);
    }, 0);
    document.getElementById('dashSales').textContent  = fmt(sales);
    document.getElementById('dashUnpaid').textContent = fmt(totalUnpaid);

    // ─── 최근 7일 매출 바차트 ───
    _renderWeekBarChart();

    // ─── 최근 납품 내역 (최근 7건) ───
    const recentEl = document.getElementById('dashRecentSection');
    if (!recentEl) return;
    const recent = [...orders].sort((a,b)=>(b.date||"").localeCompare(a.date||"")||b.createdAt?.localeCompare(a.createdAt||"")).slice(0,7);
    if (!recent.length) {
        recentEl.innerHTML = '';
        return;
    }
    const today = todayKST();
    recentEl.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;margin-top:4px;">
            <div style="font-size:11px;font-weight:700;color:var(--text2);letter-spacing:.7px;text-transform:uppercase;">최근 납품</div>
            <button class="btn btn-ghost btn-sm" onclick="showTab('history')" style="font-size:10px;padding:4px 9px;">전체보기</button>
        </div>
        ${recent.map(o => {
            const isToday = o.date === today;
            const isUnpaid = !o.isPaid;
            return `<div class="recent-card" onclick="showOrderDetail('${escapeAttr(o.id)}')">
                <div>
                    <div class="recent-client">${escapeHtml(o.clientName||'(없음)')}${isToday?'<span style="margin-left:5px;font-size:9px;background:var(--accent);color:#fff;padding:1px 5px;border-radius:4px;font-weight:700;">오늘</span>':''}</div>
                    <div class="recent-date">${escapeHtml(o.date)} · ${(o.items||[]).length}품목${isUnpaid?'<span style="margin-left:5px;color:var(--red);font-weight:700;">미수</span>':''}</div>
                </div>
                <div class="recent-amount">${fmt(o.total)}원</div>
            </div>`;
        }).join('')}`;

    // ── 대시보드 미수 거래처 현황 ──
    const unpaidEl = document.getElementById('dashUnpaidSection');
    if (!unpaidEl) return;
    const clientUnpaidMap = {};
    orders.forEach(o => {
        if (o.isPaid) return;
        const key = o.clientId || o.clientName;
        if (!clientUnpaidMap[key]) clientUnpaidMap[key] = { name: o.clientName||'(없음)', amt: 0, oldestDate: o.date, phone: '' };
        if (o.date < clientUnpaidMap[key].oldestDate) clientUnpaidMap[key].oldestDate = o.date;
    });
    // 연락처 보충
    clients.forEach(cl => {
        const m = clientUnpaidMap[cl.id] || clientUnpaidMap[cl.name];
        if (m && cl.phone) m.phone = cl.phone;
    });
    const unpaidList = Object.values(clientUnpaidMap).filter(x => x.amt > 0).sort((a,b) => b.amt - a.amt).slice(0,5);
    if (!unpaidList.length) { unpaidEl.innerHTML = ''; return; }
    const todayD = todayKST();
    unpaidEl.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;margin-top:12px;">
            <div style="font-size:11px;font-weight:700;color:var(--red);letter-spacing:.7px;text-transform:uppercase;">💸 미수금 현황</div>
            <button class="btn btn-ghost btn-sm" onclick="showTab('unpaid')" style="font-size:10px;padding:4px 9px;">전체보기</button>
        </div>
        <div class="card" style="padding:8px 12px;">
        ${unpaidList.map(u => {
            const days = Math.floor((new Date(todayD) - new Date(u.oldestDate)) / 86400000);
            const dayCls = days >= 90 ? 'severe' : days >= 60 ? 'danger' : days >= 30 ? 'warn' : '';
            const dayLabel = days >= 90 ? `🚨 ${days}일` : days >= 60 ? `🔴 ${days}일` : days >= 30 ? `🟠 ${days}일` : `🟢 ${days}일`;
            return `<div class="dash-unpaid-row" onclick="showTab('unpaid')">
                <div>
                    <div class="dash-unpaid-name">${escapeHtml(u.name)}</div>
                    <div class="dash-unpaid-info">최장 경과</div>
                </div>
                <div class="dash-unpaid-right">
                    <div class="dash-unpaid-amt">${fmt(u.amt)}원</div>
                    <div class="dash-unpaid-days ${dayCls}">${dayLabel}</div>
                </div>
            </div>`;
        }).join('')}
        </div>`;
}


// ─── 최근 7일 매출 바차트 ───
function _renderWeekBarChart() {
    const el = document.getElementById('dashWeekBarChart');
    const totalEl = document.getElementById('dashWeekTotal');
    if (!el) return;
    const today = todayKST();
    const days = [];
    for (let i = 6; i >= 0; i--) days.push(kstAddDays(today, -i));
    const _et = o => o.isPaid && o.discount > 0 ? o.total - o.discount : o.total;
    const data = days.map(d => ({
        label: d.slice(5),
        day: ['일','월','화','수','목','금','토'][new Date(d).getDay()],
        isToday: d === today,
        sales: orders.filter(o => o.date === d && !o.isVoid).reduce((s, o) => s + _et(o), 0)
    }));
    const maxVal = Math.max(...data.map(d => d.sales), 1);
    const weekTotal = data.reduce((s, d) => s + d.sales, 0);
    if (totalEl) totalEl.textContent = fmt(weekTotal) + '원';
    el.innerHTML = data.map(d => {
        const pct = Math.round((d.sales / maxVal) * 100);
        const barH = Math.max(pct * 0.9, d.sales > 0 ? 4 : 0); // max 90px
        const isToday = d.isToday;
        const barColor = isToday
            ? 'linear-gradient(180deg,#f87171,#ef4444)'
            : 'linear-gradient(180deg,rgba(248,113,113,.75),rgba(239,68,68,.5))';
        const labelColor = isToday ? '#fca5a5' : 'rgba(248,113,113,.85)';
        const amtLabel = d.sales >= 1000000
            ? (d.sales/1000000).toFixed(1)+'M'
            : d.sales >= 1000
            ? Math.round(d.sales/1000)+'K'
            : d.sales > 0 ? String(d.sales) : '';
        // 금액 레이블: 막대가 충분히 높으면 내부에, 낮으면 막대 위에
        const labelInside = barH >= 22 && amtLabel;
        return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;min-width:0;position:relative;">
            ${!labelInside && amtLabel ? `<div style="font-size:9px;font-weight:700;color:${labelColor};height:12px;line-height:12px;text-align:center;width:100%;overflow:visible;white-space:nowrap;">${amtLabel}</div>` : `<div style="height:12px;"></div>`}
            <div style="width:100%;flex:1;display:flex;align-items:flex-end;position:relative;">
                <div style="width:100%;height:${barH}px;background:${barColor};border-radius:4px 4px 2px 2px;transition:height .4s cubic-bezier(.4,0,.2,1);min-height:${d.sales>0?'3px':'0'};box-shadow:${isToday?'0 0 8px rgba(239,68,68,.5)':'none'};display:flex;align-items:flex-start;justify-content:center;">
                    ${labelInside ? `<span style="font-size:8px;font-weight:700;color:rgba(255,255,255,.9);margin-top:3px;line-height:1;writing-mode:vertical-rl;transform:rotate(180deg);">${amtLabel}</span>` : ''}
                </div>
            </div>
            <div style="font-size:10px;font-weight:${isToday?'900':'700'};color:${isToday?'#fca5a5':'rgba(248,113,113,.75)'};line-height:1.2;margin-top:1px;">${d.day}</div>
            <div style="font-size:9px;color:rgba(248,113,113,.55);line-height:1;">${d.label}</div>
        </div>`;
    }).join('');
}



let _unpaidAgeFilter = 'all'; // 'all' | '0' | '30' | '60' | '90'

function setUnpaidAgeFilter(age, btn) {
    _unpaidAgeFilter = age;
    document.querySelectorAll('.unpaid-age-tab').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderUnpaid();
}

function renderUnpaid() {
    const today = todayKST();

    // ── 거래처별 미수금 집계 ──
    const clientMap = {};
    orders.forEach(o => {
        if (o.isPaid) return;
        const remain = Math.max(0, o.total - (o.paidAmount || 0));
        if (remain <= 0) return;
        const key = o.clientId || o.clientName;
        if (!clientMap[key]) clientMap[key] = {
            name: o.clientName || '(없음)', amt: 0, orders: [], oldestDate: o.date, phone: '', clientId: o.clientId
        };
        clientMap[key].amt += remain;
        clientMap[key].orders.push({ ...o, _remain: remain });
        if (o.date < clientMap[key].oldestDate) clientMap[key].oldestDate = o.date;
    });
    // 연락처 보충
    clients.forEach(cl => {
        const m = clientMap[cl.id] || clientMap[cl.name];
        if (m && cl.phone) m.phone = cl.phone;
    });

    const all = Object.values(clientMap).filter(x => x.amt > 0);

    // 요약 통계
    const totalAmt = all.reduce((s, x) => s + x.amt, 0);
    const totalOrders = all.reduce((s, x) => s + x.orders.length, 0);
    const elTot = document.getElementById('upTotalAmt');
    const elCnt = document.getElementById('upClientCount');
    const elOrd = document.getElementById('upOrderCount');
    if (elTot) elTot.textContent = fmt(totalAmt) + '원';
    if (elCnt) elCnt.textContent = all.length + '곳';
    if (elOrd) elOrd.textContent = totalOrders + '건';

    // 경과일 필터
    const filtered = all.filter(u => {
        const days = Math.floor((new Date(today) - new Date(u.oldestDate)) / 86400000);
        if (_unpaidAgeFilter === 'all') return true;
        if (_unpaidAgeFilter === '0')  return days < 30;
        if (_unpaidAgeFilter === '30') return days >= 30 && days < 60;
        if (_unpaidAgeFilter === '60') return days >= 60 && days < 90;
        if (_unpaidAgeFilter === '90') return days >= 90;
        return true;
    }).sort((a, b) => {
        // 오래된 순 → 금액 순
        const da = Math.floor((new Date(today) - new Date(a.oldestDate)) / 86400000);
        const db = Math.floor((new Date(today) - new Date(b.oldestDate)) / 86400000);
        return db - da || b.amt - a.amt;
    });

    const el = document.getElementById('unpaidClientList');
    if (!el) return;

    if (!filtered.length) {
        el.innerHTML = '<div class="empty"><div class="empty-icon">✅</div><div class="empty-text">해당 조건의 미수금이 없습니다</div></div>';
        return;
    }

    el.innerHTML = filtered.map(u => {
        const days = Math.floor((new Date(today) - new Date(u.oldestDate)) / 86400000);
        const ageCls = days >= 90 ? 'age-severe' : days >= 60 ? 'age-danger' : days >= 30 ? 'age-warn' : 'age-ok';
        const badgeCls = days >= 90 ? 'severe' : days >= 60 ? 'danger' : days >= 30 ? 'warn' : '';
        const ageLabel = days >= 90 ? `🚨 최장 ${days}일 경과` : days >= 60 ? `🔴 최장 ${days}일 경과` : days >= 30 ? `🟠 최장 ${days}일 경과` : `🟢 최장 ${days}일 경과`;
        const curMonth = today.slice(0, 7);
        const sortedOrders = [...u.orders].sort((a, b) => (a.date||"").localeCompare(b.date||""));
        const orderRows = sortedOrders.slice(0, 4).map(o => {
            const d = Math.floor((new Date(today) - new Date(o.date)) / 86400000);
            const dCls = d >= 90 ? 'severe' : d >= 60 ? 'danger' : d >= 30 ? 'warn' : '';
            return `<div class="unpaid-card-order-row">
                <span style="font-size:11px;color:var(--text2);">${o.date} <span class="dash-unpaid-days ${dCls}">(${d}일)</span></span>
                <span style="font-size:12px;font-weight:700;color:var(--red);">${fmt(o._remain)}원${o.paidAmount>0?'<small style="color:#60a5fa;font-size:9px;"> 부분수금</small>':''}</span>
            </div>`;
        }).join('');
        const moreCount = sortedOrders.length - 4;
        const smsBody = encodeURIComponent(`[미수금 안내]\n${u.name}님 미수금 ${fmt(u.amt)}원이 있습니다. 확인 부탁드립니다.`);
        const safeClientName = escapeAttr(u.name);
        return `<div class="unpaid-client-card ${ageCls}">
            <div class="unpaid-card-top">
                <div>
                    <div class="unpaid-card-name">${escapeHtml(u.name)}</div>
                    <div style="margin-top:3px;"><span class="unpaid-age-badge ${badgeCls}">${ageLabel}</span></div>
                </div>
                <div class="unpaid-card-amt">${fmt(u.amt)}원</div>
            </div>
            <div class="unpaid-card-meta">${u.phone ? `📞 ${escapeHtml(u.phone)}` : '연락처 없음'} · 미수 ${u.orders.length}건</div>
            <div class="unpaid-card-orders">
                ${orderRows}
                ${moreCount > 0 ? `<div style="font-size:10px;color:var(--text3);padding-top:4px;">외 ${moreCount}건 더 있음</div>` : ''}
            </div>
            <div class="unpaid-card-actions">
                ${u.phone ? `<a href="tel:${escapeHtml(u.phone)}">📞 전화</a>` : ''}
                ${u.phone ? `<a href="sms:${escapeHtml(u.phone)}?body=${smsBody}" class="btn-sms">💬 문자</a>` : ''}
                <button onclick="showClientStatement('${safeClientName}','${escapeAttr(curMonth)}')" style="background:var(--surf3);color:var(--text2);">📋 명세표</button>
                <button class="btn-pay" onclick="openPartialPay('${safeClientName}','${escapeAttr(curMonth)}')">💳 입금처리</button>
            </div>
        </div>`;
    }).join('');
}

// ═══════════════════════════════════════════════════════════
//  재고 관리
// ═══════════════════════════════════════════════════════════

// 재고 아이템 정규화 (Firebase 수신·초기 로드 공통)

// ─── 스파크라인 SVG 생성 ───

function makeSparkline(values, color, width, height) {
    if (!values || values.length < 2) return '';
    const max = Math.max(...values, 1);
    const pts = values.map((v, i) => {
        const x = (i / (values.length - 1)) * width;
        const y = height - (v / max) * height;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
        <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity=".8"/>
        <polyline points="0,${height} ${pts} ${width},${height}" fill="${color}" fill-opacity=".12" stroke="none"/>
    </svg>`;
}

// 최근 7일 데이터 계산

function getLast7DaysData(type) {
    const today = todayKST();
    const days = [];
    for (let i = 6; i >= 0; i--) {
        const d = kstAddDays(today, -i);
        days.push(d);
    }
    return days.map(d => {
        const dayOrders = orders.filter(o => o.date === d);
        const _et = o => o.isPaid && o.discount > 0 ? o.total - o.discount : o.total;
        if (type === 'sales') return dayOrders.reduce((s, o) => s + _et(o), 0);
        if (type === 'paid')  return dayOrders.reduce((s, o) => s + _actualPaid(o), 0);
        if (type === 'unpaid') return dayOrders.filter(o => !o.isPaid).reduce((s, o) => s + o.total, 0);
        return 0;
    });
}

function renderSparklines() {
    const W = 80, H = 28;
    const setSparkline = (id, vals, color) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = makeSparkline(vals, color, W, H);
    };
    setSparkline('sparkSales',  getLast7DaysData('sales'),  '#a39fff');
    setSparkline('sparkUnpaid', getLast7DaysData('unpaid'), '#fb7185');
}

// ─── 정산 바차트 ───

function renderSettleBarChart(monthKey) {
    const el = document.getElementById('settleBarChart');
    if (!el) return;
    // 최근 6개월 데이터 (문자열 연산으로 UTC 오프셋 버그 방지)
    const months = [];
    for (let i = 5; i >= 0; i--) {
        const [baseY, baseM] = monthKey.split('-').map(Number);
        let m = baseM - i, y = baseY;
        while (m <= 0) { m += 12; y--; }
        while (m > 12) { m -= 12; y++; }
        const ym = `${y}-${String(m).padStart(2,'0')}`;
        const mos = orders.filter(o => o.date?.startsWith(ym));
        const _et  = o => o.isPaid && o.discount > 0 ? o.total - o.discount : o.total;
        const total = mos.reduce((s, o) => s + _et(o), 0);
        const paid  = mos.reduce((s, o) => s + _actualPaid(o), 0);
        const unpaid = total - paid;
        months.push({ label: ym.slice(5) + '월', total, paid, unpaid });
    }
    const maxVal = Math.max(...months.map(m => m.total), 1);
    const bars = months.map(m => {
        const h = Math.round((m.total / maxVal) * 80);
        const hasUnpaid = m.unpaid > 0;
        return `<div class="bar-col">
            <div class="bar-val">${m.total > 0 ? (m.total >= 1000000 ? (m.total/1000000).toFixed(1)+'M' : (m.total/1000).toFixed(0)+'K') : ''}</div>
            <div class="bar-fill${hasUnpaid ? ' has-unpaid' : ''}" style="height:${h}px" title="${m.label}: ${fmt(m.total)}원"></div>
            <div class="bar-label">${m.label}</div>
        </div>`;
    }).join('');
    el.innerHTML = `<div class="settle-chart-wrap">
        <div class="settle-chart-title">최근 6개월 매출</div>
        <div class="bar-chart">${bars}</div>
        <div style="font-size:10px;color:var(--text3);margin-top:8px;">■ <span style="color:var(--accent);">완납</span> &nbsp; ■ <span style="color:var(--red);">미수포함</span></div>
    </div>`;
}

// ─── 카운트업 애니메이션 ───

function animateCount(el, target) {
    if (!el) return;
    const duration = 400;
    const start = Date.now();
    const startVal = 0;
    el.classList.remove('animated');
    void el.offsetWidth; // reflow
    el.classList.add('animated');
    const tick = () => {
        const elapsed = Date.now() - start;
        const progress = Math.min(elapsed / duration, 1);
        const ease = 1 - Math.pow(1 - progress, 3);
        const val = Math.round(startVal + (target - startVal) * ease);
        el.textContent = val.toLocaleString('ko-KR');
        if (progress < 1) requestAnimationFrame(tick);
        else el.textContent = target.toLocaleString('ko-KR');
    };
    requestAnimationFrame(tick);
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  § 11  재고 관리                                                  ║
// ╚══════════════════════════════════════════════════════════════╝

function normStock(s) {
    if (!s) return null;
    const log = Array.isArray(s.log) ? s.log : [];
    // qty 보정: log가 있으면 가장 최근 log의 after 값을 신뢰
    // (Firebase 동기화 충돌로 qty 필드가 오래된 값으로 덮어써질 때 방지)
    // 단, after 값이 명확히 정의된 로그 항목만 신뢰 (after가 null/undefined인 오래된 항목 제외)
    let qty = Number(s.qty ?? 0);
    if (log.length > 0) {
        // log는 최신순(unshift) 정렬 — at 타임스탬프 기준으로 가장 최근 것 선택
        const validLogs = log.filter(l => l.at && l.after !== undefined && l.after !== null && !isNaN(Number(l.after)));
        if (validLogs.length > 0) {
            const latest = validLogs.reduce((a, b) => {
                const ta = new Date(a.at).getTime();
                const tb = new Date(b.at).getTime();
                return tb > ta ? b : a;
            });
            qty = Number(latest.after);
        }
    }
    return {
        id:      s.id      || _uid(),
        name:    s.name    || '',
        qty,
        unit:    s.unit    || '개',
        low:     Number(s.low    ?? 10),
        danger:  Number(s.danger ?? 3),
        note:    s.note    || '',
        log,
        lastCarryDate: s.lastCarryDate || '',   // 이월 중복 방지: Firebase 동기화 후에도 유지
        updatedAt: s.updatedAt || new Date().toISOString()
    };
}

// 재고 상태 등급

function stockLevel(si) {
    if (si.qty <= si.danger) return 'danger';
    if (si.qty <= si.low)    return 'low';
    return 'ok';
}

// ─── 재고 날짜 조회 상태 ───
let stockViewDate = ''; // '' = 오늘, 'YYYY-MM-DD' = 과거 조회

// 특정 날짜 기준으로 재고량 역산

function getStockAtDate(si, targetDateStr) {
    if (!targetDateStr || targetDateStr >= todayKST()) return si.qty;
    const endOfTargetUTC = new Date(targetDateStr + 'T23:59:59+09:00').getTime();
    const logs = (si.log || [])
        .filter(l => l.at && l.after !== undefined && l.after !== null)
        .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    // 대상 날짜 이전 or 당일의 가장 최근 로그 찾기
    const prevLog = logs.find(l => new Date(l.at).getTime() <= endOfTargetUTC);
    if (prevLog) {
        return Number(prevLog.after);
    }

    // 모든 로그가 대상 날짜 이후 → 전부 되돌려서 초기값 추산
    let stock = si.qty;
    for (const l of logs) {
        stock -= (Number(l.qty) || 0);
    }
    return Math.max(0, stock);
}

// 특정 날짜의 입고/출고 합산

function getInOutAtDate(si, targetDateStr) {
    if (!targetDateStr) return getTodayInOut(si);
    const startUTC = new Date(targetDateStr + 'T00:00:00+09:00').getTime();
    const endUTC   = new Date(targetDateStr + 'T23:59:59+09:00').getTime();
    const dayLogs  = (si.log || []).filter(l => {
        if (l.type === 'auto') return l.date === targetDateStr; // 납품차감은 납품날짜 기준
        const t = l.at ? new Date(l.at).getTime() : 0;
        return t >= startUTC && t <= endUTC;
    });
    const inQty  = dayLogs.filter(l => l.type === 'in').reduce((s, l) => s + Math.abs(l.qty), 0);
    const restoreQty = dayLogs.filter(l => (l.type === 'restore' && (l.originalDate || l.date) === targetDateStr)
                                        || (l.type === 'edit_adj' && (l.qty||0) > 0)).reduce((s, l) => s + Math.abs(l.qty), 0);
    const logOutQty = Math.max(0, dayLogs.filter(l => l.type === 'out' || l.type === 'auto' || (l.type === 'edit_adj' && l.qty < 0)).reduce((s, l) => s + Math.abs(l.qty), 0) - restoreQty);
    const outQty = logOutQty;
    return { inQty, outQty, logOutQty };
}

// "이전재고" (대상 날짜 기준 전날 마감)

function getPrevStockAtDate(si, targetDateStr) {
    if (!targetDateStr || targetDateStr >= todayKST()) {
        return getYesterdayClosingQty(si);
    }
    const prevDate = kstAddDays(targetDateStr, -1);
    const qty = getStockAtDate(si, prevDate);
    return { qty, date: prevDate };
}

function onStockDateChange(val) {
    const today = todayKST();
    if (!val || val >= today) {
        // 오늘이거나 미래면 오늘 모드
        stockViewDate = '';
        document.getElementById('stockViewDate').value = today;
        document.getElementById('stockHistoryBanner').classList.remove('visible');
    } else {
        stockViewDate = val;
        const sub = document.getElementById('stockHistoryBannerSub');
        if (sub) sub.textContent = val + ' 기준 재고 (읽기 전용 · 실제 데이터 변경 없음)';
        document.getElementById('stockHistoryBanner').classList.add('visible');
    }
    renderStock();
}

function resetStockToToday() {
    stockViewDate = '';
    document.getElementById('stockViewDate').value = todayKST();
    document.getElementById('stockHistoryBanner').classList.remove('visible');
    renderStock();
}

function stockDateNav(delta) {
    const input = document.getElementById('stockViewDate');
    const cur = input.value || todayKST();
    const next = kstAddDays(cur, delta);
    if (next > todayKST()) return; // 미래 날짜 이동 방지
    input.value = next;
    onStockDateChange(next);
}

// ─── 재고 목록 렌더 (사진 스타일 테이블 카드) ───
// 오늘 하루 동안의 입고/출고 합산
// - 재고 로그(in/out/auto/edit_adj) 기반
// - 자동차감 OFF일 때도 납품 전표의 출고 수량을 출고 칸에 표시 (재고 수치는 변경 없음)

function getTodayInOut(si) {
    const today = todayKST();
    const todayStartUTC    = new Date(today + 'T00:00:00+09:00').getTime();
    const tomorrowStartUTC = todayStartUTC + 86400000;
    const todayLogs = (si.log || []).filter(l => {
        if (l.type === 'auto') return l.date === today; // 납품차감은 납품날짜 기준
        const t = l.at ? new Date(l.at).getTime() : 0;
        return t >= todayStartUTC && t < tomorrowStartUTC;
    });
    // 입고: type=in (carryover는 이전재고 이월이므로 입고로 보지 않음)
    const inQty = todayLogs
        .filter(l => l.type === 'in')
        .reduce((s, l) => s + Math.abs(l.qty), 0);
    // 출고 상쇄: 납품삭제복구(restore) + 납품수정보정 증가(edit_adj>0)
    // restore는 originalDate가 오늘인 것만 상쇄 (이전 날짜 전표 삭제는 오늘 출고에 영향 없음)
    const restoreQty = todayLogs
        .filter(l => (l.type === 'restore' && (l.originalDate || l.date) === today)
                  || (l.type === 'edit_adj' && (l.qty||0) > 0))
        .reduce((s, l) => s + Math.abs(l.qty), 0);
    // 출고: type=out(수동), auto(납품차감), edit_adj(수정보정 감소)
    const logOutQty = Math.max(0, todayLogs
        .filter(l => l.type === 'out' || l.type === 'auto' || (l.type === 'edit_adj' && l.qty < 0))
        .reduce((s, l) => s + Math.abs(l.qty), 0) - restoreQty);
    let outQty = logOutQty;

    // 자동차감 OFF일 때: 납품 전표 기반 출고 수량도 출고 칸에 표시 (표시 전용, 재고 변경 없음)
    // ※ 이력이 전혀 없는 품목은 재고 관리 미시작 상태이므로 표시하지 않음
    if (!stockAutoDeduct && (si.log || []).length > 0) {
        const deliveryOut = orders
            .filter(o => o.date === today && !o.isVoid)
            .flatMap(o => o.items || [])
            .filter(item => normItemName(item.name) === normItemName(si.name))
            .reduce((sum, item) => sum + Number(item.qty || 0), 0);
        outQty += deliveryOut;
    }

    return { inQty, outQty, logOutQty };
}

function _egCardHTML(si) {
    const isHistory = !!(stockViewDate && stockViewDate < todayKST());
    // ── 날짜별 재고 계산 ──
    const displayQty = isHistory ? getStockAtDate(si, stockViewDate) : si.qty;
    const prevData   = isHistory
        ? getPrevStockAtDate(si, stockViewDate)
        : getYesterdayClosingQty(si);
    // 임시 si 복사본으로 level 계산 (과거 조회 시 과거 수량 기준)
    const siSnap = isHistory ? { ...si, qty: displayQty } : si;
    const lv     = stockLevel(siSnap);

    const { inQty, outQty, logOutQty } = isHistory
        ? getInOutAtDate(si, stockViewDate)
        : getTodayInOut(si);
    // 이전재고: 로그 이력이 있으면 로그 기반, 없으면 현재재고에서 오늘 입출고 역산
    // ※ autoDeduct OFF 시 deliveryOut은 표시용이므로 logOutQty(로그 기반)만 역산에 사용
    const _outForPrev = isHistory ? outQty : (logOutQty ?? outQty);
    const prevQty = (prevData && !prevData.isCurrent)
        ? prevData.qty
        : (isHistory
            ? getStockAtDate(si, kstAddDays(stockViewDate, -1))
            : (inQty > 0 || _outForPrev > 0)
                ? si.qty - inQty + _outForPrev   // 오늘 입출고가 있을 때만 역산
                : si.qty);                  // 오늘 입출고가 전혀 없으면 현재값 = 이전값

    const id     = si.id;
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g,'_');
    const histClass = isHistory ? ' history-mode' : '';
    const histLabel = isHistory ? `<span class="eg-history-badge">과거</span>` : '';

    const currLabel = isHistory ? `${stockViewDate} 재고` : '현재재고';

    return `<div class="eg-card level-${lv}${histClass}" id="egcard-${safeId}" data-sid="${id}">
  <!-- 헤더: 품목명 -->
  <div class="eg-header">
    <div class="eg-name">
      <span class="eg-status-dot"></span>
      ${escapeHtml(si.name)}${histLabel}
    </div>
    <div class="eg-header-right">
      ${si.note ? `<span class="eg-note">${escapeHtml(si.note)}</span>` : ''}
      <button class="eg-menu-btn" onclick="openAdj('${id}')" title="재고 조정">⚖️</button>
    </div>
  </div>
  <!-- 4칸 테이블: 이전재고 | 입고 | 출고 | 현재/과거재고 -->
  <div class="eg-table">
    <div class="eg-col col-prev">
      <div class="eg-col-label">이전재고</div>
      <div class="eg-col-val">${prevQty !== undefined ? fmt(prevQty) : '—'}</div>
      <div class="eg-col-unit">${si.unit}</div>
    </div>
    <div class="eg-col col-in" id="egcol-in-${safeId}">
      <div class="eg-col-label">📥 입고</div>
      <div class="eg-col-val">${inQty > 0 ? '+'+fmt(inQty) : '—'}</div>
      <div class="eg-col-unit">${si.unit}</div>
    </div>
    <div class="eg-col col-out" id="egcol-out-${safeId}">
      <div class="eg-col-label">📤 출고</div>
      <div class="eg-col-val">${outQty > 0 ? '-'+fmt(outQty) : '—'}</div>
      <div class="eg-col-unit">${si.unit}</div>
    </div>
    <div class="eg-col col-curr lv-${lv}">
      <div class="eg-col-label">${currLabel}</div>
      <div class="eg-col-val">${fmt(displayQty)}</div>
      <div class="eg-col-unit">${si.unit}</div>
    </div>
  </div>
  <!-- 빠른 입고/출고 바 (과거 조회 모드에서는 비활성) -->
  ${isHistory || !stockAutoDeduct ? '' : `<div class="eg-quick-bar" id="eg-qbar-${safeId}">
    <span class="eg-quick-label" id="eg-qlabel-${safeId}">입고</span>
    <input type="number" class="eg-quick-input" id="eg-qinput-${safeId}" placeholder="수량" min="1"
      onkeydown="if(event.key==='Enter')egQuickConfirm('${id}')"
      style="flex:1;">
    <button class="eg-quick-confirm in-type" id="eg-qconfirm-${safeId}" onclick="egQuickConfirm('${id}')">확인</button>
    <button class="eg-quick-cancel" onclick="egQuickClose('${id}')">✕</button>
  </div>`}
  <!-- 액션 버튼 -->
  <div class="eg-actions">
    ${isHistory ? `<div style="flex:1;text-align:center;font-size:11px;color:var(--orange);padding:8px;font-weight:700;">
      🕐 ${stockViewDate} 기준 조회 (읽기 전용)</div>
      <button class="eg-act-btn btn-log" onclick="openStockLog('${id}')">📋 이력</button>` :
    !stockAutoDeduct ? `<div style="flex:1;text-align:center;font-size:11px;color:var(--text3);padding:8px;">
      🔒 자동 차감 OFF · 재고 조정 불가</div>` :
      `<button class="eg-act-btn btn-in"  onclick="egQuickOpen('${id}','in')">📥 입고</button>
    <button class="eg-act-btn btn-out" onclick="egQuickOpen('${id}','out')">📤 출고</button>
    <button class="eg-act-btn btn-log" onclick="openStockLog('${id}')">📋 이력</button>
    <button class="eg-act-btn btn-edit" onclick="openStockEdit('${id}')">✏️ 수정</button>
    <button class="eg-act-btn btn-del" onclick="deleteStockItem('${id}')">🗑️</button>`}
  </div>
</div>`;
}

// 빠른 입고/출고 상태 관리
let _egQuickState = {}; // { [id]: 'in'|'out' }

function egQuickOpen(id, type) {
    // 다른 열린 바 닫기
    Object.keys(_egQuickState).forEach(oid => { if (oid !== id) egQuickClose(oid); });
    _egQuickState[id] = type;
    const si = stockItems.find(s => s.id === id);
    if (!si) return;
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g,'_');
    const bar     = document.getElementById('eg-qbar-' + safeId);
    const label   = document.getElementById('eg-qlabel-' + safeId);
    const input   = document.getElementById('eg-qinput-' + safeId);
    const confirm = document.getElementById('eg-qconfirm-' + safeId);
    if (!bar) return;
    label.textContent = type === 'in' ? '📥 입고 수량' : '📤 출고 수량';
    confirm.className = 'eg-quick-confirm ' + type + '-type';
    confirm.textContent = type === 'in' ? '입고' : '출고';
    input.value = '';
    bar.classList.add('visible');
    setTimeout(() => input.focus(), 80);
    if (navigator.vibrate) navigator.vibrate(6);
}

function egQuickClose(id) {
    delete _egQuickState[id];
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g,'_');
    const bar = document.getElementById('eg-qbar-' + safeId);
    if (bar) bar.classList.remove('visible');
}

async function egQuickConfirm(id) {
    if (!stockAutoDeduct) { toast('🔒 자동 차감 OFF 상태에서는 재고 조정이 불가합니다', 'var(--orange)'); return; }
    const type = _egQuickState[id];
    if (!type) return;
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g,'_');
    const input = document.getElementById('eg-qinput-' + safeId);
    if (!input) return;
    const val = parseInt(input.value);
    if (!val || val <= 0) { toast('❗ 수량을 입력하세요'); input.focus(); return; }
    const si = stockItems.find(s => s.id === id);
    if (!si) return;
    const before = si.qty;

    // ── 출고 시 재고 부족 경고 ──
    if (type === 'out' && before <= 0) {
        toast(`❗ ${si.name} 현재 재고가 0입니다. 출고할 수 없습니다.`, 'var(--red)');
        return;
    }
    if (type === 'out' && val > before) {
        if (!await customConfirm(`⚠️ ${si.name} 재고(${fmt(before)}${si.unit})보다 출고 수량(${fmt(val)}${si.unit})이 많습니다.\n재고는 0이 됩니다. 계속하시겠습니까?`)) return;
    }

    let after, logType;
    if (type === 'in')  { after = before + val; logType = 'in'; }
    else                { after = Math.max(0, before - val); logType = 'out'; }

    // 실제 변동이 없으면 처리 안 함
    if (after === before) { toast('❗ 변동 수량이 없습니다'); return; }

    si.qty = after;
    si.updatedAt = new Date().toISOString();
    (si.log = si.log || []).unshift({
        type: logType, qty: after - before, before, after,
        reason: type === 'in' ? '빠른입고' : '빠른출고',
        date: todayKST(), at: new Date().toISOString()
    });
    si.log = _trimLogByDate(si.log);
    saveData();
    egQuickClose(id);
    renderStock();
    if (navigator.vibrate) navigator.vibrate([10,20,10]);
    const diff = after - before;
    toast(`${type==='in'?'📥 입고':'📤 출고'}: ${fmt(before)} → ${fmt(after)} ${si.unit}`,
          diff < 0 ? 'var(--red)' : 'var(--green)');
}

function renderStock() {
    const q   = (document.getElementById('stockSearch')?.value || '').trim();
    let items = stockItems.filter(s => !q || matchSearch(s.name, q));
    const isHistory = !!(stockViewDate && stockViewDate < todayKST());
    // 과거 조회 시 재고량 기준으로 정렬을 위해 임시 qty 스냅샷 사용
    const snapItems = isHistory
        ? items.map(s => ({ ...s, qty: getStockAtDate(s, stockViewDate) }))
        : items;
    if (stockSortMode === 'qty-asc')  items = [...items].sort((a,b) => {
        const ai = snapItems.find(x=>x.id===a.id)||a; const bi = snapItems.find(x=>x.id===b.id)||b;
        return ai.qty - bi.qty;
    });
    else if (stockSortMode === 'qty-desc') items = [...items].sort((a,b) => {
        const ai = snapItems.find(x=>x.id===a.id)||a; const bi = snapItems.find(x=>x.id===b.id)||b;
        return bi.qty - ai.qty;
    });
    else if (stockSortMode === 'danger') items = [...items].sort((a,b) => {
        const ai = snapItems.find(x=>x.id===a.id)||a; const bi = snapItems.find(x=>x.id===b.id)||b;
        const la = stockLevel(ai), lb = stockLevel(bi);
        const rank = {danger:0,low:1,ok:2};
        return rank[la] - rank[lb] || ai.qty - bi.qty;
    });
    else items = [...items].sort((a,b) => a.name.localeCompare(b.name,'ko'));

    // 요약 카운트 (과거 조회 시 과거 기준)
    if (isHistory) {
        const el_all    = document.getElementById('sCountAll');
        const el_low    = document.getElementById('sCountLow');
        const el_danger = document.getElementById('sCountDanger');
        const allSnap   = stockItems.map(s => ({ ...s, qty: getStockAtDate(s, stockViewDate) }));
        if (el_all)    el_all.textContent    = allSnap.length;
        if (el_low)    el_low.textContent    = allSnap.filter(s=>s.qty>s.danger&&s.qty<=s.low).length;
        if (el_danger) el_danger.textContent = allSnap.filter(s=>s.qty<=s.danger).length;
    } else {
        updateInfoCounts();
    }
    const el = document.getElementById('stockList');
    // 과거 조회 시 추가 버튼 / 달걀 배너 / 새로고침 버튼 숨기기
    const addBtn = document.querySelector('#pane-stock .btn-primary.btn-sm');
    const refreshBtn = document.querySelector('#pane-stock .btn-ghost.btn-sm[title]');
    const eggBanner = document.getElementById('eggInitBanner');
    if (isHistory) {
        if (addBtn) addBtn.style.display = 'none';
        if (refreshBtn) refreshBtn.style.display = 'none';
        if (eggBanner) eggBanner.style.display = 'none';
    } else if (!stockAutoDeduct) {
        // 자동차감 OFF: 등록/새로고침 버튼 숨김 (조정 불가)
        if (addBtn) addBtn.style.display = 'none';
        if (refreshBtn) refreshBtn.style.display = 'none';
    } else {
        if (addBtn) addBtn.style.display = '';
        if (refreshBtn) refreshBtn.style.display = '';
        // eggBanner는 checkEggInitBanner()가 관리
    }
    if (!items.length) {
        el.innerHTML = '<div class="empty"><div class="empty-icon">📦</div><div class="empty-text">' +
            (stockItems.length ? (isHistory ? `${stockViewDate} 기준 재고 데이터가 없습니다` : '검색 결과가 없습니다') : '등록된 품목이 없습니다<br><small style="color:var(--text3)">+ 품목 등록 버튼으로 추가하세요</small>') +
            '</div></div>';
        _egQuickState = {};
        return;
    }
    const EGG_ORDER = ['왕란','특란','대란','중란'];
    const eggItems  = [];
    const etcItems  = [];
    if (!q && stockSortMode === 'name') {
        items.forEach(si => {
            if (EGG_ORDER.includes(si.name)) eggItems.push(si);
            else etcItems.push(si);
        });
        eggItems.sort((a,b) => EGG_ORDER.indexOf(a.name) - EGG_ORDER.indexOf(b.name));
    }
    const parts = [];
    if (!q && stockSortMode === 'name' && eggItems.length > 0) {
        parts.push('<div class="eg-section-label">🥚 달걀 품목</div>');
        parts.push(...eggItems.map(_egCardHTML));
        if (etcItems.length > 0) {
            parts.push('<div class="eg-section-label" style="margin-top:8px;">📦 기타 품목</div>');
            parts.push(...etcItems.map(_egCardHTML));
        }
    } else {
        parts.push(...items.map(_egCardHTML));
    }
    el.innerHTML = parts.join('');
    _egQuickState = {};
}

function setStockSort(mode, btn) {
    stockSortMode = mode;
    document.querySelectorAll('#pane-stock .sort-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderStock();
}

// ─── 자동 차감 토글 ───

function toggleAutoDeduct() {
    if (stockAutoDeduct) {
        // ON → OFF: 현재 재고 수치를 스냅샷으로 저장 (초기화 없음)
        const snapshot = {};
        stockItems.forEach(si => { snapshot[si.id] = si.qty; });
        localStorage.setItem('stockOffSnapshot', JSON.stringify(snapshot));
        stockAutoDeduct = false;
        localStorage.setItem('stockAutoDeduct', '0');
        applyAutoDeductUI();
        renderStock();
        toast('🔕 자동 재고 차감 비활성화 · 재고 수치 유지', 'var(--orange)');
    } else {
        // OFF → ON: 스냅샷으로 재고 복원 (OFF 기간 납품 영향 완전 차단)
        const snapshot = JSON.parse(localStorage.getItem('stockOffSnapshot') || '{}');
        if (Object.keys(snapshot).length > 0) {
            stockItems.forEach(si => {
                if (snapshot[si.id] !== undefined) {
                    const before = si.qty;
                    si.qty = snapshot[si.id];
                    // OFF 기간 로그 제거 (OFF 이후 생긴 carryover/auto 로그 삭제)
                    const offAt = localStorage.getItem('stockAutoDeductOffAt') || '';
                    if (offAt) {
                        si.log = (si.log || []).filter(l => !l.at || l.at <= offAt);
                    }
                    // lastCarryDate 오늘로 고정 → ON 복귀 후 이월이 OFF기간 주문 반영 못하게 차단
                    si.lastCarryDate = todayKST();
                }
            });
            localStorage.removeItem('stockOffSnapshot');
            localStorage.removeItem('stockAutoDeductOffAt');
        }
        _carryoverDoneThisSession = false;
        stockAutoDeduct = true;
        localStorage.setItem('stockAutoDeduct', '1');
        saveData();
        applyAutoDeductUI();
        renderStock();
        toast('✅ 자동 재고 차감 활성화 · OFF 기간 납품 영향 차단 완료', 'var(--green)');
    }
    // OFF 전환 시각 기록 (ON 복귀 시 로그 필터 기준점)
    if (!stockAutoDeduct) {
        localStorage.setItem('stockAutoDeductOffAt', new Date().toISOString());
    }
}

function applyAutoDeductUI() {
    const btn = document.getElementById('autoDeductBtn');
    if (!btn) return;
    btn.textContent    = stockAutoDeduct ? 'ON' : 'OFF';
    btn.style.color    = stockAutoDeduct ? 'var(--green)' : '';
    btn.style.borderColor = stockAutoDeduct ? 'var(--green)' : '';
}

// ─── 이전재고(어제 마감) 계산 ───

function getYesterdayClosingQty(si) {
    const today = todayKST();
    // 오늘 자정(KST) = UTC로 어제 15:00
    const todayStartUTC = new Date(today + 'T00:00:00+09:00').getTime();
    const log = (si.log || []);

    // 오늘 이전(어제 이하) 이력 중 가장 최근 것 — at 타임스탬프 기준
    const prevLog = log
        .filter(l => {
            const t = l.at ? new Date(l.at).getTime() : 0;
            return t > 0 && t < todayStartUTC;
        })
        .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    if (prevLog.length > 0) {
        // 어제까지 마지막 이력의 after가 어제 마감 재고
        const entry = prevLog[0];
        const qty   = entry.after !== undefined && entry.after !== null
                        ? Number(entry.after) : si.qty;
        const date  = (entry.at || entry.date || '').slice(0, 10) || today;
        return { qty: isNaN(qty) ? si.qty : qty, date };
    }

    // 이력이 전혀 없거나 오늘 이후 이력만 있는 경우
    return { qty: si.qty, date: today, isCurrent: true };
}

// ─── 이전재고 이월 토글 ───
// carryMode: true=이월적용, false=현재값유지
let _carryMode = false; // 모달 열릴 때마다 초기화

function setPrevCarryMode(apply) {
    _carryMode = apply;
    const bar      = document.getElementById('sePrevQtyBar');
    const btnApply = document.getElementById('btnApplyCarry');
    const btnSkip  = document.getElementById('btnSkipCarry');
    const prevQty  = bar?.dataset.prevQty;

    if (apply) {
        // 이력 없으면 이월 불가
        if (bar?.dataset.hasHistory !== '1') {
            toast('❗ 이전 납품 이력이 없어 이월할 수 없습니다');
            return;
        }
        // 이월 적용: 이전 재고값을 seQty에 채움
        if (prevQty !== undefined && prevQty !== '') {
            document.getElementById('seQty').value = prevQty;
        }
        // 버튼 스타일 — 이월 적용 활성
        btnApply.style.background   = 'var(--accent)';
        btnApply.style.color        = '#fff';
        btnApply.style.borderColor  = 'var(--accent)';
        btnSkip.style.background    = 'var(--surf2)';
        btnSkip.style.color         = 'var(--text2)';
        btnSkip.style.borderColor   = 'var(--border)';
        toast('↩ 이전 재고를 적용합니다');
    } else {
        // 현재값 유지: seQty를 원래 현재 재고값으로 복원
        const origQty = bar?.dataset.origQty;
        if (origQty !== undefined && origQty !== '') {
            document.getElementById('seQty').value = origQty;
        }
        // 버튼 스타일 — 현재값 유지 활성
        btnSkip.style.background    = 'var(--accent)';
        btnSkip.style.color         = '#fff';
        btnSkip.style.borderColor   = 'var(--accent)';
        btnApply.style.background   = 'var(--surf2)';
        btnApply.style.color        = 'var(--text2)';
        btnApply.style.borderColor  = 'var(--border)';
        toast('✓ 현재 재고값을 유지합니다');
    }
}

// ─── 세션 내 자동 이월 실행 여부 (탭 전환마다 중복 실행 방지) ───
let _carryoverDoneThisSession = false;

// ─── 재고 새로고침 (전일 마감 이월 + 변동 반영) ───

function refreshStockCarryover(silent = false) {
    // 자동차감 OFF 상태에서는 이월 계산 완전 차단 (OFF 기간 재고 수치 고정)
    if (!stockAutoDeduct) {
        if (!silent) toast('🔒 자동 차감 OFF 상태에서는 이월 계산이 실행되지 않습니다', 'var(--orange)');
        else renderStock();
        return;
    }
    if (!stockItems.length) {
        if (!silent) toast('❗ 등록된 품목이 없습니다');
        else renderStock();
        return;
    }

    const today = todayKST();

    // ── silent(자동) 모드: 세션 내 최초 1회만 실행 ──
    // 탭 전환마다 호출되던 문제를 차단. 수동 버튼(silent=false)은 항상 허용.
    if (silent && _carryoverDoneThisSession) {
        renderStock();
        return;
    }

    let updated = 0;

    stockItems.forEach(si => {
        // ① lastCarryDate 필드 기반 강력한 중복 방지
        //    Firebase 동기화 후 log가 초기화되어도 날짜 필드로 이중 이월 차단
        if (si.lastCarryDate === today) return;

        // ② 로그 기반 추가 확인 (하위 호환)
        const alreadyCarried = (si.log || []).some(l =>
            l.type === 'carryover' && (l.date || '').slice(0, 10) === today
        );
        if (alreadyCarried) {
            si.lastCarryDate = today; // 필드 동기화
            return;
        }

        // ③ 어제 마감 재고 확인
        const prev = getYesterdayClosingQty(si);
        if (!prev || prev.isCurrent) return; // 이력 없는 신규 품목 스킵

        // ④ 오늘 입출고 로그 합산
        const todayStartUTC    = new Date(today + 'T00:00:00+09:00').getTime();
        const tomorrowStartUTC = todayStartUTC + 86400000;
        const todayLogs = (si.log || []).filter(l => {
            if (l.type === 'auto') return l.date === today; // 납품차감은 납품날짜 기준
            const t = l.at ? new Date(l.at).getTime() : 0;
            return t >= todayStartUTC && t < tomorrowStartUTC;
        });
        const todayDeduct = Math.max(0, todayLogs
            .filter(l => l.type === 'auto' || l.type === 'out' || (l.type === 'edit_adj' && l.qty < 0))
            .reduce((s, l) => s + Math.abs(l.qty), 0)
            - todayLogs.filter(l => l.type === 'restore' && (l.originalDate || l.date) === today).reduce((s, l) => s + Math.abs(l.qty), 0));
        const todayIn = todayLogs
            .filter(l => l.type === 'in' || (l.type === 'edit_adj' && l.qty > 0))
            .reduce((s, l) => s + Math.abs(l.qty), 0);

        // ⑤ 자동차감 OFF이면 납품 전표 기반 차감 제외 (차감 자체를 안 하는 것이므로)
        // ※ 이전 버전에서 OFF일 때도 포함했으나, 이중차감/이전재고 왜곡 원인이 됨
        let deliveryDeduct = 0;

        // ⑥ 이전재고 기반 오늘 재고 = 이전재고 + 오늘입고 - 오늘차감
        const newQty = Math.max(0, prev.qty + todayIn - todayDeduct - deliveryDeduct);
        if (newQty === si.qty) {
            // 수치는 맞지만 lastCarryDate는 반드시 기록 (이중 이월 방지)
            si.lastCarryDate = today;
            return;
        }

        const before = si.qty;
        si.qty = newQty;
        si.lastCarryDate = today; // ← 핵심: 필드에 날짜 저장
        si.updatedAt = new Date().toISOString();
        (si.log = si.log || []).unshift({
            type: 'carryover', qty: newQty - before, before, after: newQty,
            reason: `전일(${prev.date}) 마감 이월`,
            date: today, at: new Date().toISOString()
        });
        si.log = _trimLogByDate(si.log);
        updated++;
    });

    if (silent) _carryoverDoneThisSession = true; // 세션 플래그 설정

    saveData();
    renderStock();
    if (updated > 0) {
        toast(`🔄 ${updated}개 품목 재고가 이월 반영되었습니다`, 'var(--green)');
    } else if (!silent) {
        toast('✅ 모든 품목이 최신 상태입니다');
    }
}

// ─── 품목 등록·수정 ───

function openStockEdit(id) {
    // 자동차감 OFF 시에도 품목 등록·수정은 허용 (재고 수량 변경만 제한)
    const si = id ? stockItems.find(s => s.id === id) : null;
    document.getElementById('stockEditTitle').textContent = si ? '✏️ 품목 수정' : '📦 품목 등록';
    document.getElementById('seId').value    = si ? si.id : '';
    document.getElementById('seName').value  = si ? si.name  : '';
    document.getElementById('seQty').value   = si ? si.qty   : '';
    document.getElementById('seUnit').value  = si ? si.unit  : '개';
    document.getElementById('seLow').value   = si ? si.low   : 10;
    document.getElementById('seDanger').value= si ? si.danger: 3;
    document.getElementById('seNote').value  = si ? si.note  : '';

    // ── 이전재고 이월 표시 ──
    const bar = document.getElementById('sePrevQtyBar');
    _carryMode = false; // 모달 열 때마다 "현재값 유지" 기본값
    if (si) {
        try {
            const prev = getYesterdayClosingQty(si);
            const hasHistory = !prev.isCurrent; // 오늘 이전 이력 존재 여부

            // 이력 유무와 관계없이 섹션은 항상 표시
            bar.style.display    = 'block';
            bar.dataset.prevQty  = String(prev.qty);
            bar.dataset.origQty  = String(si.qty);
            bar.dataset.hasHistory = hasHistory ? '1' : '0';

            if (hasHistory) {
                document.getElementById('sePrevQtyVal').textContent =
                    `이전: ${fmt(prev.qty)} ${si.unit}　→　현재: ${fmt(si.qty)} ${si.unit}`;
                document.getElementById('sePrevQtyDate').textContent =
                    `기준일: ${prev.date} (어제 마감)`;
            } else {
                document.getElementById('sePrevQtyVal').textContent =
                    `현재: ${fmt(si.qty)} ${si.unit}`;
                document.getElementById('sePrevQtyDate').textContent =
                    '이전 납품 이력 없음';
            }

            // 기본 상태: "현재값 유지" 활성 / 이력 없으면 이월 버튼 비활성
            const btnApply = document.getElementById('btnApplyCarry');
            const btnSkip  = document.getElementById('btnSkipCarry');
            btnSkip.style.background   = 'var(--accent)';
            btnSkip.style.color        = '#fff';
            btnSkip.style.borderColor  = 'var(--accent)';
            btnApply.style.background  = 'var(--surf2)';
            btnApply.style.color       = hasHistory ? 'var(--text2)' : 'var(--text3)';
            btnApply.style.borderColor = 'var(--border)';
            btnApply.disabled          = !hasHistory;
            btnApply.title             = hasHistory ? '' : '이전 납품 이력이 없어 이월할 수 없습니다';
            btnSkip.disabled           = false;
        } catch(e) {
            // 계산 오류 시 섹션 숨김으로 안전 처리
            console.warn('이전재고 계산 오류:', e);
            bar.style.display   = 'none';
            bar.dataset.prevQty = '';
            bar.dataset.origQty = String(si.qty);
        }
    } else {
        bar.style.display    = 'none';
        bar.dataset.prevQty  = '';
        bar.dataset.origQty  = '';
    }

    openModal('stockEditModal');
    setTimeout(() => document.getElementById('seName').focus(), 80);
}

function saveStockItem() {
    const id     = document.getElementById('seId').value;
    const name   = document.getElementById('seName').value.trim();
    const qtyRaw = document.getElementById('seQty').value;
    const qty    = qtyRaw === '' ? 0 : Number(qtyRaw);
    const unit   = document.getElementById('seUnit').value.trim() || '개';
    const low    = Number(document.getElementById('seLow').value)    || 10;
    const danger = Number(document.getElementById('seDanger').value) || 3;
    const note   = document.getElementById('seNote').value.trim();

    if (!name) return toast('❗ 품목명을 입력하세요');
    if (isNaN(qty) || qty < 0) return toast('❗ 재고는 0 이상이어야 합니다');
    if (low < danger) return toast('❗ 부족 경고 기준은 위험 기준보다 커야 합니다');

    // 정규화된 이름으로 중복 체크
    const dup = stockItems.some(s => normItemName(s.name) === normItemName(name) && s.id !== id);
    if (dup) return toast('❗ 이미 등록된 품목명입니다');

    if (id) {
        const si = stockItems.find(s => s.id === id);
        if (!si) return toast('❗ 품목을 찾을 수 없습니다');
        const before = si.qty;
        Object.assign(si, { name, qty, unit, low, danger, note, updatedAt: new Date().toISOString() });
        if (before !== qty) {
            // 이월 적용 선택 시 carryover 로그, 아니면 수동 set 로그
            const logType   = _carryMode ? 'carryover' : 'set';
            const logReason = _carryMode ? '이전 재고 이월 적용' : '수동 재고 설정';
            const diff = qty - before;
            (si.log = si.log||[]).unshift({
                type: logType, qty: diff, before, after: qty,
                reason: logReason, date: todayKST(), at: new Date().toISOString()
            });
            si.log = _trimLogByDate(si.log);

            // ── 오늘 입고 로그가 있는데 수정으로 수량이 감소한 경우 →
            //    입고 수량 표시도 보정 (in_adj 로그로 inQty 차감)
            if (!_carryMode && diff < 0) {
                const today = todayKST();
                const todayStartUTC = new Date(today + 'T00:00:00+09:00').getTime();
                const tomorrowStartUTC = todayStartUTC + 86400000;
                const todayInTotal = (si.log || []).filter(l => {
                    if (l.type !== 'in') return false;
                    const t = l.at ? new Date(l.at).getTime() : 0;
                    return t >= todayStartUTC && t < tomorrowStartUTC;
                }).reduce((s, l) => s + Math.abs(l.qty), 0);
                if (todayInTotal > 0) {
                    // 이미 쌓인 in_adj 합산
                    const todayInAdj = (si.log || []).filter(l => {
                        if (l.type !== 'in_adj') return false;
                        const t = l.at ? new Date(l.at).getTime() : 0;
                        return t >= todayStartUTC && t < tomorrowStartUTC;
                    }).reduce((s, l) => s + l.qty, 0);
                    const canAdj = Math.min(Math.abs(diff), todayInTotal + todayInAdj);
                    if (canAdj > 0) {
                        si.log.unshift({
                            type: 'in_adj', qty: -canAdj, before, after: qty,
                            reason: '입고 수량 수정 보정', date: today, at: new Date().toISOString()
                        });
                    }
                }
            }
        }
        toast('✅ 품목이 수정되었습니다', 'var(--green)');
    } else {
        // ── 신규 등록 시: 오늘 납품 전표에 동일 품목 출고가 있으면 자동 반영 ──
        const today = todayKST();
        const todayAutoOut = orders
            .filter(o => o.date === today)
            .flatMap(o => o.items || [])
            .filter(item => normItemName(item.name) === normItemName(name))
            .reduce((sum, item) => sum + Number(item.qty || 0), 0);

        const initLog = [];
        // 최초 입고 로그 (입력한 qty 기준)
        if (qty > 0) {
            initLog.push({ type:'set', qty, before:0, after:qty, reason:'최초 등록', date:today, at:new Date().toISOString() });
        }
        let finalQty = qty;
        // 오늘 이미 납품된 수량이 있으면 차감 + auto 로그 추가
        if (stockAutoDeduct && todayAutoOut > 0) {
            finalQty = Math.max(0, qty - todayAutoOut);
            initLog.unshift({ type:'auto', qty: finalQty - qty, before: qty, after: finalQty,
                reason:'등록 시 오늘 납품 자동 반영', date: today, at: new Date().toISOString() });
        }

        stockItems.push(normStock({ id:_uid(), name, qty:finalQty, unit, low, danger, note, log: initLog }));

        if (stockAutoDeduct && todayAutoOut > 0) {
            toast(`✅ 품목 등록 완료 (오늘 출고 ${fmt(todayAutoOut)}${unit} 자동 반영 → 잔고 ${fmt(finalQty)}${unit})`, 'var(--green)');
        } else {
            toast('✅ 품목이 등록되었습니다', 'var(--green)');
        }
    }
    saveData(); _markDirty('stock'); renderStock();
    closeModal('stockEditModal');
}

async function deleteStockItem(id) {
    const si = stockItems.find(s => s.id === id);
    if (!si) return;
    if (!await customConfirm(`'${si.name}' 품목을 삭제할까요?\n재고 이력도 함께 삭제됩니다.`)) return;
    stockItems = stockItems.filter(s => s.id !== id);
    saveData(); _markDirty('stock'); renderStock();
    toast('🗑️ 품목 삭제 완료');
}

// ─── 재고 조정 ───

function openAdj(id) {
    if (!stockAutoDeduct) { toast('🔒 자동 차감 OFF 상태에서는 재고 조정이 불가합니다', 'var(--orange)'); return; }
    // 열린 빠른 입고/출고 바 모두 닫기
    Object.keys(_egQuickState).forEach(oid => egQuickClose(oid));
    const si = stockItems.find(s => s.id === id);
    if (!si) return;
    document.getElementById('saId').value      = id;
    document.getElementById('saName').textContent = si.name;
    document.getElementById('saCurrent').textContent = fmt(si.qty) + ' ' + si.unit;
    document.getElementById('saQty').value     = '';
    document.getElementById('saReason').value  = '';
    document.getElementById('saPreview').textContent = '';
    _adjType = 'in';
    setAdjType('in');
    openModal('stockAdjModal');
    setTimeout(() => document.getElementById('saQty').focus(), 80);
}

function setAdjType(type) {
    _adjType = type;
    ['in','out','set'].forEach(t => {
        const btn = document.getElementById('adj' + t.charAt(0).toUpperCase() + t.slice(1));
        if (btn) btn.className = 'adj-btn' + (t === type ? ' ' + t : '');
    });
    const label = document.getElementById('saQtyLabel');
    if (label) label.textContent = type === 'in' ? '입고 수량' : type === 'out' ? '출고 수량' : '설정할 재고량';
    previewAdj();
}

function previewAdj() {
    const id  = document.getElementById('saId').value;
    const val = Number(document.getElementById('saQty').value) || 0;
    const si  = stockItems.find(s => s.id === id);
    if (!si) return;
    const prev = document.getElementById('saPreview');
    let after;
    if (_adjType === 'in')  after = si.qty + val;
    else if (_adjType === 'out') after = Math.max(0, si.qty - val);
    else after = val;
    const diff = after - si.qty;
    const sign = diff >= 0 ? '+' : '';
    prev.innerHTML = val
        ? `${fmt(si.qty)} → <strong style="color:${diff<0?'var(--red)':'var(--green)'};">${fmt(after)}</strong> ${si.unit} (${sign}${fmt(diff)})`
        : '';
}

async function applyAdj() {
    const id     = document.getElementById('saId').value;
    const valRaw = document.getElementById('saQty').value;
    const reason = document.getElementById('saReason').value.trim();
    const si     = stockItems.find(s => s.id === id);
    if (!si) return toast('❗ 품목을 찾을 수 없습니다');
    if (valRaw === '' || valRaw === null) return toast('❗ 수량을 입력하세요');
    const val = Number(valRaw);
    if (isNaN(val) || val < 0) return toast('❗ 올바른 수량을 입력하세요 (0 이상)');

    const before = si.qty;
    let after, logType;
    if (_adjType === 'in')       { after = before + val;             logType = 'in'; }
    else if (_adjType === 'out') { after = Math.max(0, before - val); logType = 'out'; }
    else                         { after = val;                       logType = 'set'; }

    si.qty = after;
    si.updatedAt = new Date().toISOString();
    // 변동이 없으면 로그 생성 안 함
    if (after === before) { closeModal('stockAdjModal'); toast('❗ 변동 수량이 없습니다'); return; }
    (si.log = si.log||[]).unshift({ type:logType, qty:after-before, before, after,
        reason: reason || (logType==='in'?'입고':logType==='out'?'출고':'직접설정'),
        date: todayKST(), at: new Date().toISOString() });
    si.log = _trimLogByDate(si.log);

    saveData(); _markDirty('stock'); renderStock();
    closeModal('stockAdjModal');
    const diff = after - before;
    toast(`✅ 재고 조정: ${fmt(before)} → ${fmt(after)} ${si.unit}`, diff < 0 ? 'var(--red)' : 'var(--green)');
}

// ─── 재고 이력 ───

function openStockLog(id) {
    const si = stockItems.find(s => s.id === id);
    if (!si) return;
    document.getElementById('slName').textContent = si.name + '  현재: ' + fmt(si.qty) + ' ' + si.unit;
    const log = (si.log || []);
    const typeLabel = { in:'📥 입고', out:'📤 출고', set:'✏️ 설정', auto:'🚚 납품차감', carryover:'🔄 이월', edit_adj:'✏️ 수정보정', restore:'↩ 납품삭제복구' };
    const typeCls   = { in:'in', out:'out', set:'set', auto:'auto', carryover:'in', edit_adj:'set', restore:'in' };

    if (!log.length) {
        document.getElementById('slList').innerHTML =
            '<div style="text-align:center;color:var(--text3);padding:20px;">이력이 없습니다</div>';
        openModal('stockLogModal');
        return;
    }

    // 날짜별 그룹핑
    const dayMap = {};
    log.forEach(l => {
        // auto(납품차감)는 납품 날짜 기준, 나머지는 등록 시각 기준
        const d = l.type === 'auto'
            ? (l.date || (l.at||'').slice(0,10) || '날짜미상')
            : ((l.at || l.date || '').slice(0, 10) || '날짜미상');
        if (!dayMap[d]) dayMap[d] = [];
        dayMap[d].push(l);
    });
    const days = Object.keys(dayMap).sort((a, b) => b.localeCompare(a));

    document.getElementById('slList').innerHTML = days.map(day => {
        const dayLogs = dayMap[day];
        // 해당 날짜 마감 재고 = 그날 마지막 이력의 after
        const lastLog = [...dayLogs].sort((a, b) =>
            (b.at || b.date || '').localeCompare(a.at || a.date || '')).find(l => l.after !== undefined);
        const dayClosing = lastLog ? lastLog.after : '?';
        const inSum  = dayLogs.filter(l => l.type === 'in').reduce((s, l) => s + Math.abs(l.qty||0), 0);
        const outSum = Math.max(0, dayLogs.filter(l => l.type === 'out' || l.type === 'auto' || (l.type === 'edit_adj' && (l.qty||0) < 0)).reduce((s, l) => s + Math.abs(l.qty||0), 0)
                     - dayLogs.filter(l => (l.type === 'restore' && (l.originalDate || l.date) === day) || (l.type === 'edit_adj' && (l.qty||0) > 0)).reduce((s, l) => s + Math.abs(l.qty||0), 0));
        return `
<div style="margin-bottom:10px;">
  <div style="display:flex;justify-content:space-between;align-items:center;
              padding:6px 8px;background:var(--surf3);border-radius:6px 6px 0 0;
              border:1px solid var(--border);border-bottom:none;">
    <span style="font-size:11px;font-weight:700;color:var(--text2);">${day}</span>
    <span style="font-size:10px;color:var(--text3);">
      ${inSum > 0 ? `<span style="color:var(--green);">+${fmt(inSum)}</span> ` : ''}
      ${outSum > 0 ? `<span style="color:var(--red);">-${fmt(outSum)}</span>` : ''}
      &nbsp;마감: <strong style="color:var(--accent);">${fmt(dayClosing)}</strong>
    </span>
  </div>
  <div style="border:1px solid var(--border);border-top:none;border-radius:0 0 6px 6px;">
    ${dayLogs.map(l => {
        const sign  = (l.qty || 0) >= 0 ? '+' : '';
        const cls   = typeCls[l.type] || 'set';
        const label = typeLabel[l.type] || l.type;
        const time  = l.at ? new Date(new Date(l.at).getTime() + 9*3600000).toISOString().slice(11, 16) : '';
        return `<div class="slog-row" style="padding:7px 10px;">
  <div>
    <div style="font-size:12px;">${escapeHtml(label)}${l.reason ? ' · ' + escapeHtml(l.reason) : ''}</div>
    <div class="slog-meta">${time ? time + ' · ' : ''}${fmt(l.before)}→${fmt(l.after)} ${escapeHtml(si.unit)}</div>
  </div>
  <div class="slog-chg ${cls}">${sign}${fmt(l.qty)}</div>
</div>`;
    }).join('')}
  </div>
</div>`;
    }).join('');
    openModal('stockLogModal');
}

// ─── 저장공간 사용량 바 업데이트 ───

function initEggItems() {
    let added = 0;
    EGG_ITEMS_DEFAULT.forEach(egg => {
        const exists = stockItems.some(s => normItemName(s.name) === normItemName(egg.name));
        if (!exists) {
            stockItems.push(normStock({
                id: _uid(), name: egg.name, qty: 0,
                unit: egg.unit, low: egg.low, danger: egg.danger, note: egg.note,
                log: []
            }));
            added++;
        }
    });
    if (added > 0) {
        saveData(); _markDirty('stock'); renderStock();
        toast(`🥚 달걀 ${added}종 등록 완료`, 'var(--green)');
    } else {
        toast('이미 모든 달걀 품목이 등록되어 있습니다');
    }
    document.getElementById('eggInitBanner').style.display = 'none';
}

function checkEggInitBanner() {
    const banner = document.getElementById('eggInitBanner');
    if (!banner) return;
    const hasAnyEgg = EGG_ITEMS_DEFAULT.some(egg =>
        stockItems.some(s => normItemName(s.name) === normItemName(egg.name))
    );
    // 달걀 품목이 하나도 없을 때만 배너 표시
    banner.style.display = hasAnyEgg ? 'none' : 'block';
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  § 12  백업 & 복원                                                ║
// ╚══════════════════════════════════════════════════════════════╝

// ─── 백업 & 복원 ───
// ─── 백업 저장 위치 (File System Access API + IndexedDB) ───
const _IDB_NAME = 'deliveryProDB';
const _IDB_STORE = 'settings';

function _idbOpen() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(_IDB_NAME, 1);
        req.onupgradeneeded = e => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(_IDB_STORE))
                db.createObjectStore(_IDB_STORE);
        };
        req.onsuccess = e => resolve(e.target.result);
        req.onerror   = e => reject(e.target.error);
    });
}

async function _idbPut(key, value) {
    const db = await _idbOpen();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(_IDB_STORE, 'readwrite');
        tx.objectStore(_IDB_STORE).put(value, key);
        tx.oncomplete = resolve; tx.onerror = e => reject(e.target.error);
    });
}

async function _idbGet(key) {
    const db = await _idbOpen();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(_IDB_STORE, 'readonly');
        const req = tx.objectStore(_IDB_STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror   = e => reject(e.target.error);
    });
}

async function _idbDel(key) {
    const db = await _idbOpen();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(_IDB_STORE, 'readwrite');
        tx.objectStore(_IDB_STORE).delete(key);
        tx.oncomplete = resolve; tx.onerror = e => reject(e.target.error);
    });
}

async function loadBackupDir() {
    try {
        const handle = await _idbGet('backupDirHandle');
        if (!handle) return;
        // 읽기 권한 확인 (조용히)
        const perm = await handle.queryPermission({ mode: 'readwrite' });
        backupDirHandle = handle;
        updateBackupDirUI(handle.name, perm === 'granted');
    } catch(e) { /* IndexedDB 미지원 또는 핸들 만료 */ }
}

async function pickBackupDir() {
    if (!('showDirectoryPicker' in window)) {
        toast('❗ 이 브라우저는 폴더 선택을 지원하지 않습니다 (Chrome·Edge 데스크톱 권장)');
        return;
    }
    try {
        const handle = await window.showDirectoryPicker({ mode: 'readwrite', startIn: 'downloads' });
        backupDirHandle = handle;
        await _idbPut('backupDirHandle', handle);
        updateBackupDirUI(handle.name, true);
        showBackupBanner('✅ 저장 위치 설정 완료: ' + handle.name, 'success');
    } catch(e) {
        if (e.name !== 'AbortError') showBackupBanner('❌ 폴더 선택 실패: ' + e.message, 'error');
    }
}

async function clearBackupDir() {
    backupDirHandle = null;
    try { await _idbDel('backupDirHandle'); } catch(e) {}
    updateBackupDirUI(null, false);
    showBackupBanner('📂 저장 위치가 기본 다운로드 폴더로 초기화되었습니다.', 'success');
}

function updateBackupDirUI(name, granted) {
    const info    = document.getElementById('backupDirInfo');
    const clearBtn= document.getElementById('clearDirBtn');
    const pickBtn = document.getElementById('pickDirBtn');
    if (!info) return;
    if (name) {
        info.innerHTML = `<span style="color:var(--accent);font-weight:700;">📂 ${name}</span>`
                       + (granted ? '' : ' <span style="color:var(--orange);font-size:11px;">(권한 재확인 필요)</span>');
        if (clearBtn) clearBtn.style.display = 'inline-flex';
        if (pickBtn)  pickBtn.textContent = '📁 폴더 변경';
    } else {
        info.innerHTML = '<span style="color:var(--text2);">📂 기본 다운로드 폴더</span>';
        if (clearBtn) clearBtn.style.display = 'none';
        if (pickBtn)  pickBtn.textContent = '📁 폴더 선택';
    }
}

async function _writeToDir(handle, filename, jsonStr) {
    // 권한 확인 → 필요 시 재요청
    const opts = { mode: 'readwrite' };
    if ((await handle.queryPermission(opts)) !== 'granted') {
        const res = await handle.requestPermission(opts);
        if (res !== 'granted') throw new Error('폴더 쓰기 권한이 거부되었습니다.');
    }
    // Blob을 파일 생성 전에 미리 준비
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const fileHandle = await handle.getFileHandle(filename, { create: true });
    let writable = null;
    try {
        // createWritable()도 try 안에 포함: 실패해도 0 byte 파일 cleanup 가능
        writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        writable = null; // close 성공 표시
        // 쓰기 검증: 실제 파일 크기 확인 (0 byte이면 실패로 처리)
        const written = await fileHandle.getFile();
        if (written.size === 0) throw new Error('파일이 0 byte로 저장됨 — 다운로드로 전환');
    } catch(e) {
        if (writable) { try { await writable.abort(); } catch(_) {} }
        // 0 byte 파일 정리 시도 (Chrome/Edge 지원)
        try { await fileHandle.remove(); } catch(_) {}
        throw e; // 상위에서 다운로드 폴백 처리
    }
}

function loadBackupSchedule() {
    return { day1:parseInt(localStorage.getItem('backupDay1')||'1'), day2:parseInt(localStorage.getItem('backupDay2')||'15') };
}

function saveBackupSchedule() {
    const d1=Math.min(28,Math.max(1,parseInt(document.getElementById('schedDay1').value)||1));
    const d2=Math.min(28,Math.max(1,parseInt(document.getElementById('schedDay2').value)||15));
    localStorage.setItem('backupDay1',d1); localStorage.setItem('backupDay2',d2);
    document.getElementById('schedDay1').value=d1; document.getElementById('schedDay2').value=d2;
    showBackupBanner('✅ 자동 백업 일정 저장 완료 (매월 '+d1+'일 · '+d2+'일)','success');
}

// 가져오기 전 안전 백업: 파일 다운로드 없이 클라우드에만 저장

async function runBackupCloudOnly(label='가져오기전') {
    if (!isConnected || !workspaceRef) return;
    const { dateStr, key } = nowKST();
    const payload= { label, backupDate:dateStr, autoTrigger:false, clients, orders, prices, stockItems,
                     clientsCount:clients.length, ordersCount:orders.length,
                     writtenBy: SESSION_ID };
    await workspaceRef.child('backups').child(key).set(payload);
    const snap=await workspaceRef.child('backups').orderByKey().once('value');
    const keys=Object.keys(snap.val()||{}).sort();
    if (keys.length>10) {
        const del={}; keys.slice(0,keys.length-10).forEach(k=>del[k]=null);
        await workspaceRef.child('backups').update(del);
    }
}

async function runBackup(label='수동', autoTrigger=false) {
    const { dateStr, key } = nowKST();
    const payload= { label, backupDate:dateStr, autoTrigger, clients, orders, prices, stockItems,
                     clientsCount:clients.length, ordersCount:orders.length,
                     writtenBy: SESSION_ID };
    // 파일 저장 (지정 폴더 우선 → 다운로드 폴백)
    const filename = `backup_${label}_${key}.json`;
    const jsonStr  = JSON.stringify(payload, null, 2);
    let savedToDir = false;
    if (backupDirHandle) {
        try {
            await _writeToDir(backupDirHandle, filename, jsonStr);
            savedToDir = true;
        } catch(e) {
            console.warn('지정 폴더 저장 실패, 다운로드로 전환:', e.message);
            updateBackupDirUI(backupDirHandle?.name, false);
        }
    }
    if (!savedToDir) {
        try {
            const blob = new Blob([jsonStr], { type:'application/json' });
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a'); a.href=url; a.download=filename;
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 2000);
        } catch(e) { console.warn('파일 저장 실패(모바일 환경일 수 있음)'); }
    }
    // 클라우드 저장
    if (isConnected && workspaceRef) {
        try {
            await workspaceRef.child('backups').child(key).set(payload);
            const snap=await workspaceRef.child('backups').orderByKey().once('value');
            const keys=Object.keys(snap.val()||{}).sort();
            if (keys.length>10) {
                const del={}; keys.slice(0,keys.length-10).forEach(k=>del[k]=null);
                await workspaceRef.child('backups').update(del);
            }
        } catch(e) { console.error('클라우드 백업 실패',e); }
    }
    if (autoTrigger) localStorage.setItem('lastAutoBackupDate', todayKST());
    localStorage.setItem('lastBackupDate', dateStr);
    return dateStr;
}

async function runManualBackup() {
    const btn = document.getElementById('manualBackupBtn');
    btn.textContent='⏳ 백업 중...'; btn.disabled=true;
    try {
        const dateStr = await runBackup('수동',false);
        showBackupBanner('✅ 백업 완료! ('+dateStr+')','success');
        if (isConnected) renderBackupTab();
    } catch(e) { showBackupBanner('❌ 백업 실패: '+e.message,'error'); }
    btn.textContent='📦 지금 백업 실행'; btn.disabled=false;
}

async function checkAutoBackup() {
    const todayStr = todayKST();
    const todayDate = new Date(todayStr + 'T12:00:00+09:00');
    const { day1, day2 } = loadBackupSchedule();
    if (todayDate.getDate()!==day1 && todayDate.getDate()!==day2) return;
    const last = localStorage.getItem('lastAutoBackupDate')||'';
    if (last===todayStr) return;
    if (!clients.length && !orders.length) return;
    try { const d=await runBackup('자동',true); showBackupBanner('⏰ 자동 백업 완료! ('+d+')','success'); }
    catch(e) { showBackupBanner('⚠️ 자동 백업 실패 — 수동 백업을 실행하세요','error'); }
}

async function renderBackupTab() {
    const {day1,day2}=loadBackupSchedule();
    document.getElementById('schedDay1').value=day1;
    document.getElementById('schedDay2').value=day2;
    document.getElementById('lastAutoBackup').textContent=localStorage.getItem('lastAutoBackupDate')||'없음';
    if (!isConnected) return;
    const el=document.getElementById('backupList');
    el.innerHTML='<div class="empty"><div class="empty-text">⏳ 로딩 중...</div></div>';
    try {
        const snap=await workspaceRef.child('backups').orderByKey().once('value');
        const data=snap.val();
        if (!data||!Object.keys(data).length) { el.innerHTML='<div class="empty"><div class="empty-icon">☁️</div><div class="empty-text">저장된 백업이 없습니다</div></div>'; return; }
        el.innerHTML = Object.entries(data).sort((a,b)=>b[0].localeCompare(a[0])).map(([key,b])=>`
            <div class="backup-item">
                <div>
                    <div class="backup-item-label">${b.backupDate}${b.autoTrigger?'<span class="auto-badge">자동</span>':''}${b.label?` <span style="font-size:10px;color:var(--text2);">[${b.label}]</span>`:''}</div>
                    <div class="backup-item-meta">거래처 ${b.clientsCount}개 · 전표 ${b.ordersCount}건</div>
                </div>
                <div class="backup-item-actions">
                    <button class="btn-restore" onclick="restoreBackup('${key}')">복원</button>
                    <button class="btn-del-backup" onclick="deleteBackup('${key}')">✕</button>
                </div>
            </div>`).join('');
    } catch(e) { el.innerHTML='<div class="empty"><div class="empty-text">목록 로드 실패</div></div>'; }
}

async function restoreBackup(key) {
    if (!isConnected||!workspaceRef) return toast('❗ Firebase 연결 후 복원 가능합니다');
    if (!await customConfirm('이 백업으로 복원하면 현재 데이터가 덮어씌워집니다. 계속하시겠습니까?')) return;
    try {
        const snap=await workspaceRef.child('backups').child(key).once('value');
        const data=snap.val();
        if (!data) return toast('❗ 백업 데이터를 찾을 수 없습니다');

        // 복원 전 현재 데이터 클라우드 백업 (파일 다운로드 없이 클라우드만)
        try {
            const { dateStr: bDateStr, key: bKey } = nowKST();
            const bPayload={ label:'복원전_자동', backupDate: bDateStr,
                autoTrigger:false, clients, orders, prices, stockItems,
                clientsCount:clients.length, ordersCount:orders.length };
            await workspaceRef.child('backups').child(bKey).set(bPayload);
        } catch(be) { console.warn('복원 전 백업 실패(무시):', be); }

        // ── 리스너 일시 중단 → 복원 데이터가 리스너로 덮어쓰이는 것 방지 ──
        workspaceRef.off('value');

        // ── 공통 정규화 함수로 복원 데이터 처리 ──
        const normalized = normalizeBackupData(data);
        clients    = normalized.clients;
        orders     = normalized.orders;
        if (data.prices)               prices     = data.prices;
        if (normalized.stockItems?.length) stockItems = normalized.stockItems;

        // lastHash 초기화 후 Firebase에 복원 데이터 업로드
        lastHash={clients:'',orders:'',prices:'',stock:''};
        saveToLocal();

        // Firebase 즉시 업로드 (debounce 없이)
        const ch=dataHash(clients), oh=dataHash(orders), ph=dataHash(prices), sh=dataHash(stockItems);
        await workspaceRef.update({
            clients, orders, prices, stockItems,
            lastUpdated: new Date().toISOString(),
            writtenBy: SESSION_ID
        });
        lastHash={clients:ch, orders:oh, prices:ph, stock:sh};

        // 리스너 재등록 — 공용 _fbValueHandler 사용
        workspaceRef.off('value');
        workspaceRef.on('value', _fbValueHandler);

        _fullRender();
        showBackupBanner('✅ 복원 완료! ('+data.backupDate+' 시점)','success');
        renderBackupTab();
        toast('✅ 복원 완료', 'var(--green)');
    } catch(e) { showBackupBanner('❌ 복원 실패: '+e.message,'error'); }
}

async function deleteBackup(key) {
    if (!await customConfirm('이 백업을 삭제하시겠습니까? 삭제 후 복구할 수 없습니다.')) return;
    try { await workspaceRef.child('backups').child(key).remove(); showBackupBanner('🗑️ 삭제 완료','success'); renderBackupTab(); }
    catch(e) { showBackupBanner('❌ 삭제 실패: '+e.message,'error'); }
}

function showBackupBanner(msg,type) {
    const el=document.getElementById('backupBanner');
    if(!el)return;
    el.textContent=msg; el.className='status-banner '+type;
    clearTimeout(el._t); el._t=setTimeout(()=>{el.className='status-banner';},5000);
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  § 13  설정                                                     ║
// ╚══════════════════════════════════════════════════════════════╝

function updateStorageBar() {
    try {
        // 전체 localStorage 키 합산
        let total = 0;
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            const v   = localStorage.getItem(key);
            if (v) total += (key.length + v.length) * 2;
        }
        // 저장 예정 크기 (경량화 기준)
        const hasWorkspace = !!(localStorage.getItem('workspaceId'));
        const useLightMode = isConnected || hasWorkspace;
        const pendingSize = (
            JSON.stringify(clients).length +
            JSON.stringify(useLightMode ? _getLightOrders() : orders).length +
            JSON.stringify(prices).length +
            JSON.stringify(useLightMode ? _getLightStock() : stockItems).length
        ) * 2;

        // content:// 환경에서는 한도가 10MB일 수 있음 → 동적 감지
        const limitBytes = total > 5 * 1024 * 1024 ? 10 * 1024 * 1024 : 5 * 1024 * 1024;
        const limitKB    = Math.round(limitBytes / 1024);
        const pct        = Math.min(100, (total / limitBytes) * 100);
        const kb         = (total / 1024).toFixed(1);
        const pendKB     = (pendingSize / 1024).toFixed(1);
        const label      = document.getElementById('storageUsedLabel');
        const bar        = document.getElementById('storageBar');
        if (label) label.textContent = `${kb} KB (저장예정 ${pendKB} KB) / ~${limitKB} KB`;
        if (bar) {
            bar.style.width = pct + '%';
            bar.style.background = pct > 85 ? 'linear-gradient(90deg,#ef4444,#f87171)'
                                 : pct > 60  ? 'linear-gradient(90deg,#f59e0b,#fbbf24)'
                                 :              'linear-gradient(90deg,#22c55e,#6c63ff)';
        }
        // 80% 초과 시 긴급 정리 버튼 자동 표시
        const emergRow = document.getElementById('emergencyCleanRow');
        if (emergRow) emergRow.style.display = pct > 80 ? 'flex' : 'none';
    } catch(e) {}
}

// ─── 🚨 긴급 localStorage 정리 (한도 초과 시) ───

async function emergencyCleanStorage() {
    if (!await customConfirm('⚠️ 로컬 저장 데이터를 모두 지우고 경량 재저장합니다.\n\nFirebase에 연결되어 있으면 데이터가 안전하게 유지됩니다.\n계속하시겠습니까?')) return;
    try {
        // 앱 데이터 키 삭제 (설정 키는 유지)
        ['p_clients','p_orders','prices','p_stock'].forEach(k => localStorage.removeItem(k));
        // 경량 재저장
        localStorage.setItem('p_clients', JSON.stringify(clients.map(_minifyClient)));
        localStorage.setItem('p_orders',  JSON.stringify(_getLightOrders()));
        localStorage.setItem('prices',    JSON.stringify(prices));
        localStorage.setItem('p_stock',   JSON.stringify(_getLightStock()));
        updateStorageBar();
        toast('✅ 긴급 정리 완료! 저장공간이 확보되었습니다.', 'var(--green)');
    } catch(e) {
        // 그래도 실패하면 설정 외 전체 클리어
        try {
            const keep = {};
            ['workspaceId','wsLocked','theme','stockAutoDeduct','backupDay1','backupDay2','lastAutoBackupDate','lastBackupDate']
                .forEach(k => { const v = localStorage.getItem(k); if (v) keep[k] = v; });
            localStorage.clear();
            Object.entries(keep).forEach(([k,v]) => localStorage.setItem(k, v));
            localStorage.setItem('p_clients', JSON.stringify(clients.map(_minifyClient)));
            localStorage.setItem('p_orders',  JSON.stringify(_getLightOrders()));
            localStorage.setItem('prices',    JSON.stringify(prices));
            localStorage.setItem('p_stock',   JSON.stringify(_getLightStock()));
            updateStorageBar();
            toast('✅ 전체 초기화 후 재저장 완료.', 'var(--green)');
        } catch(e2) {
            toast('❗ 정리 실패. 브라우저 캐시를 직접 삭제해 주세요.', 'var(--red)');
        }
    }
}

// ─── ① 즉각 해결: 재고 이력 품목당 10개로 정리 ───

function trimStockLog() {
    if (!stockItems.length) return toast('재고 품목이 없습니다');
    let trimmed = 0;
    stockItems.forEach(si => {
        if (!Array.isArray(si.log)) return;
        const before = si.log.length;
        si.log = _trimLogByDate(si.log);  // 어제·오늘 이력만 유지
        trimmed += Math.max(0, before - si.log.length);
    });
    saveData();
    updateStorageBar();
    toast(`✅ 재고 이력 ${trimmed}건 삭제 완료! 공간이 확보되었습니다`, 'var(--green)');
}

// ─── ② 오래된 전표 자동 정리 ───

async function trimOldOrders() {
    const months = parseInt(document.getElementById('autoTrimMonths').value) || 6;
    const cutoff = _kstMonthsAgo(months);
    const targets = orders.filter(o => o.isPaid && o.date < cutoff);
    if (!targets.length) return toast(`✅ ${months}개월 이상 된 완납 전표가 없습니다`);
    if (!await customConfirm(`완납된 전표 중 ${months}개월 이상 된 ${targets.length}건을 삭제합니다.\n(미수금 전표는 보존됩니다)\n\n삭제 전 JSON 백업을 권장합니다.`)) return;
    orders = orders.filter(o => !(o.isPaid && o.date < cutoff));
    invalidateOrdersCache();
    saveData();
    _fullRender();
    updateStorageBar();
    toast(`🗂️ 오래된 전표 ${targets.length}건 삭제 완료`, 'var(--green)');
}

function updateInfoCounts() {
    document.getElementById('infoClients').textContent = clients.length;
    document.getElementById('infoOrders').textContent  = orders.length;
    const el_all    = document.getElementById('sCountAll');
    const el_low    = document.getElementById('sCountLow');
    const el_danger = document.getElementById('sCountDanger');
    if (el_all)    el_all.textContent    = stockItems.length;
    if (el_low)    el_low.textContent    = stockItems.filter(s=>s.qty>s.danger&&s.qty<=s.low).length;
    if (el_danger) el_danger.textContent = stockItems.filter(s=>s.qty<=s.danger).length;
}

// ─── Excel 내보내기 ───

function exportHistoryExcel() {
    if (!orders.length) return toast('❗ 내보낼 데이터가 없습니다');
    const rows = [...orders].sort((a,b)=>(a.date||"").localeCompare(b.date||"")).flatMap(o => {
        if ((o.items||[]).length === 0) {
            return [{ 날짜: o.date, 거래처: o.clientName, 품목: '(오프라인 저장 — 품목 상세 없음)', 수량: '-', 단가: '-', 금액: o.total, 합계: o.total, 납품상태: o.isPaid?'완납':'미수', 타인거래: o.isVoid?'Y':'', 메모: o.note||'' }];
        }
        return (o.items||[]).map(it => ({
            날짜: o.date, 거래처: o.clientName, 품목: it.name,
            수량: it.qty, 단가: it.price, 금액: it.qty*it.price,
            합계: o.total, 납품상태: o.isPaid?'완납':'미수', 타인거래: o.isVoid?'Y':'',
            수금방법: o.paidMethod==='transfer'?'계좌이체':o.paidMethod==='other'?'기타':o.paidAmount>0?'현금':'',
            메모: o.note||''
        }));
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '납품내역');
    XLSX.writeFile(wb, `납품내역_${todayKST()}.xlsx`);
    toast('📥 Excel 다운로드 완료', 'var(--green)');
}

function exportSettlementExcel() {
    if (settleUnit === 'daily') {
        const date = document.getElementById('settlementDateDaily').value;
        if (!date) return toast('❗ 날짜를 선택하세요');
        const filtered = applyPayFilter(orders.filter(o=>o.date===date));
        if (!filtered.length) return toast('❗ 해당 날짜 데이터가 없습니다');
        const rows = filtered.map(o=>({ 날짜:o.date, 거래처:o.clientName, 품목:(o.items||[]).map(i=>`${i.name}(${i.qty})`).join(','), 금액:o.total, 수금상태:o.isPaid?'완납':'미수', 수금방법:o.paidMethod==='transfer'?'계좌이체':o.paidMethod==='other'?'기타':'현금', 메모:o.note||'' }));
        const ws = XLSX.utils.json_to_sheet(rows);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '일별정산');
        XLSX.writeFile(wb, `일별정산서_${date}.xlsx`);
        return toast('📥 일별 정산서 다운로드 완료', 'var(--green)');
    }
    if (settleUnit === 'quarterly') {
        const year = document.getElementById('settlementYear').value;
        if (!year) return toast('❗ 연도를 선택하세요');
        const filtered = applyPayFilter(orders.filter(o=>o.date?.startsWith(String(year))));
        if (!filtered.length) return toast('❗ 해당 연도 데이터가 없습니다');
        const qMap = { '1분기':{매출:0,수금:0,건수:0}, '2분기':{매출:0,수금:0,건수:0}, '3분기':{매출:0,수금:0,건수:0}, '4분기':{매출:0,수금:0,건수:0} };
        filtered.forEach(o => {
            const m = parseInt(o.date.slice(5,7));
            const q = m<=3?'1분기':m<=6?'2분기':m<=9?'3분기':'4분기';
            qMap[q].매출 += o.total;
            qMap[q].수금 += _actualPaid(o);
            qMap[q].건수++;
        });
        const rows = Object.entries(qMap).map(([q,v])=>({ 분기:q, 건수:v.건수, 매출:v.매출, 수금:v.수금, 미수:v.매출-v.수금 }));
        const ws = XLSX.utils.json_to_sheet(rows);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '분기별정산');
        XLSX.writeFile(wb, `분기별정산서_${year}.xlsx`);
        return toast('📥 분기별 정산서 다운로드 완료', 'var(--green)');
    }
    // 기본 월별
    const month = document.getElementById('settlementMonth').value;
    if (!month) return toast('❗ 정산 월을 선택하세요');
    const filtered = applyPayFilter(orders.filter(o=>o.date?.startsWith(month)));
    if (!filtered.length) return toast('❗ 해당 월 데이터가 없습니다');
    const rows = filtered.map(o=>({ 날짜:o.date, 거래처:o.clientName, 품목:(o.items||[]).map(i=>`${i.name}(${i.qty})`).join(','), 금액:o.total, 수금상태:o.isPaid?'완납':'미수', 수금방법:o.paidMethod==='transfer'?'계좌이체':o.paidMethod==='other'?'기타':'현금', 메모:o.note||'' }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '정산');
    XLSX.writeFile(wb, `정산서_${month}.xlsx`);
    toast('📥 정산서 다운로드 완료', 'var(--green)');
}

function exportJSON() {
    const data = { clients, orders, prices, stockItems, exportDate:new Date().toISOString(), version:'83' };
    const blob = new Blob([JSON.stringify(data,null,2)], { type:'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href=url; a.download=`delivery_backup_${todayKST()}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(()=>URL.revokeObjectURL(url),2000);
    toast('📥 JSON 백업 완료', 'var(--green)');
}

function importJSON(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 10*1024*1024) return toast('❗ 파일이 너무 큽니다 (최대 10MB)');
    const reader = new FileReader();
    reader.onload = async ev => {
        try {
            const data = JSON.parse(ev.target.result);
            if (!data || typeof data!=='object') throw new Error('올바른 JSON 형식이 아닙니다');
            // clients/orders 필드 존재 여부 확인 (toArray는 항상 배열 반환)
            if (!data.clients && !data.orders) throw new Error('clients/orders 필드가 없습니다');
            const imp_clients = toArray(data.clients);
            const imp_orders  = toArray(data.orders);
            if (!await customConfirm(`가져올 데이터:\n거래처 ${imp_clients.length}개 · 전표 ${imp_orders.length}건\n\n기존 데이터를 덮어씌웁니다. 계속하시겠습니까?`, '가져오기', 'btn-primary')) { e.target.value=''; return; }
            if (clients.length||orders.length) {
                try { await runBackupCloudOnly('가져오기전'); } catch(err) {
                    if (!await customConfirm('백업 실패. 백업 없이 계속하시겠습니까?')) { e.target.value=''; return; }
                }
            }
            // ── 공통 정규화 함수로 처리 ──
            const normalized = normalizeBackupData(data);
            clients    = normalized.clients;
            orders     = normalized.orders;
            if (data.prices)     prices     = data.prices;
            if (data.stockItems) stockItems = toArray(data.stockItems).map(normStock);
            lastHash = {clients:'',orders:'',prices:'',stock:''};
            saveData(); _fullRender();
            toast('✅ 가져오기 완료', 'var(--green)');
        } catch(err) { toast('❗ 가져오기 실패: '+err.message); }
        e.target.value='';
    };
    reader.onerror = ()=>{ toast('❗ 파일 읽기 오류'); e.target.value=''; };
    reader.readAsText(file);
}

// ─── 샘플 데이터 ───

function loadSample() {
    clients = [
        { id:'s1', name:'강남마트',  phone:'010-1234-5678', address:'서울 강남구', note:'', createdAt:new Date().toISOString() },
        { id:'s2', name:'서초상회',  phone:'010-9876-5432', address:'서울 서초구', note:'', createdAt:new Date().toISOString() },
        { id:'s3', name:'역삼식당',  phone:'010-5555-1234', address:'서울 강남구', note:'단골', createdAt:new Date().toISOString() },
        { id:'s4', name:'청담마켓',  phone:'', address:'서울 강남구', note:'', createdAt:new Date().toISOString() }
    ];
    prices = { 두부:1500, 콩나물:800, 계란:250, 감자:2000 };
    const ym = todayKST().slice(0,7);
    orders = [
        { id:'o1', clientId:'s1', clientName:'강남마트', date:`${ym}-01`, items:[{name:'두부',qty:10,price:1500,total:15000},{name:'콩나물',qty:5,price:800,total:4000}], total:19000, totalAmount:19000, isPaid:true,  note:'', createdAt:new Date().toISOString() },
        { id:'o2', clientId:'s2', clientName:'서초상회', date:`${ym}-03`, items:[{name:'계란',qty:30,price:250,total:7500}], total:7500, totalAmount:7500, isPaid:false, note:'', createdAt:new Date().toISOString() },
        { id:'o3', clientId:'s3', clientName:'역삼식당', date:`${ym}-07`, items:[{name:'감자',qty:20,price:2000,total:40000},{name:'두부',qty:5,price:1500,total:7500}], total:47500, totalAmount:47500, isPaid:true,  note:'급행', createdAt:new Date().toISOString() },
        { id:'o4', clientId:'s1', clientName:'강남마트', date:`${ym}-10`, items:[{name:'콩나물',qty:15,price:800,total:12000}], total:12000, totalAmount:12000, isPaid:false, note:'', createdAt:new Date().toISOString() },
    ];
    lastHash = {clients:'',orders:'',prices:'',stock:''};
    saveData(); _fullRender();
    toast('🎉 샘플 데이터 생성 완료', 'var(--green)');
}

async function resetAllData() {
    const total = clients.length + orders.length;
    if (!total) return toast('❗ 삭제할 데이터가 없습니다');
    if (!await customConfirm(`거래처 ${clients.length}개 · 전표 ${orders.length}건을 모두 삭제합니다.\n이 작업은 되돌릴 수 없습니다!`)) return;
    if (!await customConfirm('마지막 확인입니다. 삭제 전 백업이 실행됩니다. 계속하시겠습니까?', '백업 후 삭제')) return;
    try { await runBackup('전체초기화전',false); } catch(e) {
        if (!await customConfirm('백업 실패. 백업 없이 삭제하시겠습니까?')) return;
    }
    clients=[]; orders=[]; prices={}; stockItems=[];
    localStorage.removeItem('p_stock');
    lastHash={clients:'',orders:'',prices:'',stock:''};
    saveData(); _fullRender();
    toast('🗑️ 초기화 완료');
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  § 14  Firebase 온라인 동기화  ⚠️ 절대 수정 금지                          ║
// ║  온라인 동기화 코드는 원본과 100% 동일합니다                                  ║
// ╚══════════════════════════════════════════════════════════════╝

// ─── 워크스페이스 ID 고정 ───

function applyWsLockUI() {
    const locked = localStorage.getItem('wsLocked') === '1';
    const input  = document.getElementById('workspaceId');
    const btn    = document.getElementById('wsLockBtn');
    const badge  = document.getElementById('wsLockBadge');
    const hint   = document.getElementById('wsLockHint');
    if (!input) return;
    if (locked) {
        // 잠금 상태: localStorage에서 ID를 항상 복원 (input이 비어있어도 보장)
        const storedId = localStorage.getItem('workspaceId') || '';
        if (storedId && input.value !== storedId) input.value = storedId;
        input.readOnly = true;
        input.style.opacity = '0.7';
        if (btn)   { btn.textContent = '🔒 해제'; btn.style.color = 'var(--green)'; }
        if (badge) badge.style.display = 'inline-block';
        if (hint)  hint.style.display  = 'block';
    } else {
        input.readOnly = false;
        input.style.opacity = '';
        if (btn)   { btn.textContent = '🔓 고정'; btn.style.color = ''; }
        if (badge) badge.style.display = 'none';
        if (hint)  hint.style.display  = 'none';
    }
}

function toggleWsLock() {
    const input  = document.getElementById('workspaceId');
    const locked = localStorage.getItem('wsLocked') === '1';
    if (!locked) {
        // 고정: 현재 입력값(또는 기존 저장값)을 저장하고 잠금
        const id = input.value.trim().toLowerCase() || localStorage.getItem('workspaceId') || '';
        if (!id) return toast('❗ 먼저 워크스페이스 ID를 입력하세요');
        localStorage.setItem('workspaceId', id);
        localStorage.setItem('wsLocked', '1');
        input.value = id; // 정규화된 값(소문자) 반영
        toast('🔒 워크스페이스 ID가 고정되었습니다', 'var(--green)');
    } else {
        // 잠금 해제: wsLocked만 제거, workspaceId는 유지
        localStorage.removeItem('wsLocked');
        toast('🔓 ID 고정이 해제되었습니다');
    }
    applyWsLockUI();
}

// ─── Firebase ───

function setSyncStatus(state) {
    const el = document.getElementById('syncStatus');
    const id = localStorage.getItem('workspaceId')||'';
    el.className = ''; // reset
    if (state==='online')  { el.innerHTML=`🟢 온라인 동기화: ${id}`; el.classList.add('status-online'); }
    else if (state==='syncing') { el.innerHTML='🟡 동기화 중...'; el.classList.add('status-syncing'); }
    else if (state==='error')   { el.innerHTML='🔴 동기화 오류 — 재연결 시도 중'; el.classList.add('status-error'); }
    else                        { el.innerHTML='⬡ 오프라인 모드'; el.classList.add('status-offline'); }
    // 연결 중일 때만 "현재 워크스페이스 삭제" 버튼 표시
    const delRow = document.getElementById('deleteCurrentWsRow');
    if (delRow) delRow.style.display = (state === 'online') ? 'block' : 'none';
}

// Firebase SDK 로드 완료 대기 (defer 스크립트 타이밍 보정)

function waitFirebase(callback, retries=50, interval=200) {
    if (typeof firebase !== 'undefined' && firebase.database) {
        callback();
    } else if (retries > 0) {
        setTimeout(() => waitFirebase(callback, retries-1, interval), interval);
    } else {
        toast('❗ Firebase SDK 로드 실패. 페이지를 새로고침 해주세요.');
        setSyncStatus('error');
    }
}

function connectWorkspace(auto=false) {
    // 잠금 상태면 localStorage의 고정 ID를 우선 사용
    const locked = localStorage.getItem('wsLocked') === '1';
    const storedId = localStorage.getItem('workspaceId') || '';
    const inputId  = document.getElementById('workspaceId').value.toLowerCase().trim();
    const id = (locked && storedId) ? storedId : inputId;
    if (!id) { toast('❗ 워크스페이스 ID를 입력하세요'); return; }

    // firebase SDK 로드 대기 후 실제 연결
    waitFirebase(() => _doConnect(id, auto));
}

function _doConnect(id, auto=false) {
    try {
        if (!firebase.apps.length) {
            firebase.initializeApp(FIREBASE_CONFIG);
            // RTDB 오프라인 지속성: 디스크 캐시로 초기 로드 속도 향상
            try { firebase.database().setPersistenceEnabled(true); } catch(e) {}
        }
        if (workspaceRef) workspaceRef.off();
        workspaceRef = firebase.database().ref('workspaces/'+id);
        localStorage.setItem('workspaceId', id);

        // isConnected는 .get() 성공 후에 true로 설정 (조기 설정 방지)
        isConnected = false;
        _initialLoadDone = false;  // 재연결 시 초기화
        _connectGuard    = true;   // ★ Problem 1: .get() 완료 전까지 리스너 차단
        _syncGuard       = false;  // 재연결 시 가드 초기화
        setSyncStatus('syncing');
        document.getElementById('connectBtn').style.display    = 'none';
        document.getElementById('disconnectBtn').style.display = 'block';

        // ── 실시간 리스너를 .get() 이전에 먼저 등록 (이벤트 유실 방지) ──
        workspaceRef.on('value', _fbValueHandler);

        // ── Firebase 소켓 실제 연결 상태 추적 (.info/connected) ──
        // window.online/offline 이벤트는 WiFi 수준만 감지 → 슬립·방화벽·모바일 백그라운드 후
        // Firebase 소켓이 끊겨도 isConnected=true로 남는 문제를 해소
        firebase.database().ref('.info/connected').on('value', snap => {
            const fbConnected = snap.val() === true;
            if (fbConnected) {
                if (!isConnected) {
                    // ★ Problem 4 수정: 소켓 재연결 시 서버 최신 상태 먼저 확인 후 플러시
                    // (직접 debouncedSync 호출 시 서버에서 변경된 내용을 놓칠 수 있음)
                    isConnected = true;
                    setSyncStatus('online');
                    if (_initialLoadDone) {
                        workspaceRef.get().then(snap => {
                            const d = snap.val();
                            if (!d) { debouncedSync(); return; }
                            const serverTime = d.lastUpdated ? new Date(d.lastUpdated).getTime() : 0;
                            const lastLocalMs = (() => { const s = localStorage.getItem('lastLocalUpdated'); return s ? new Date(s).getTime() : 0; })();
                            const localWriteMs = Math.max(_localWriteTime, lastLocalMs);
                            if (localWriteMs > serverTime) {
                                // 로컬이 최신 → 서버에 올리기
                                debouncedSync();
                            } else {
                                // 서버가 최신 → 리스너가 받아서 처리 (강제 트리거)
                                _fbValueHandler(snap);
                            }
                        }).catch(() => debouncedSync()); // 실패 시 일단 올리기
                    }
                }
            } else {
                if (isConnected) {
                    isConnected = false;
                    debouncedSync.cancel();
                    setSyncStatus('error');
                }
            }
        });

        // ── 최초 1회 스냅샷: 서버↔로컬 병합 판단 ──
        workspaceRef.get().then(async snap => {
            const data = snap.val();
            // 연결 성공 확인 시점에 isConnected=true 설정
            isConnected = true;
            setTimeout(checkAutoBackup, 1500);

            // 서버에 데이터가 있는지 (어느 키 하나라도)
            const serverHasData = data && (
                toArray(data.clients).length > 0 ||
                toArray(data.orders).length > 0  ||
                toArray(data.stockItems).length > 0
            );
            const localHasData = clients.length > 0 || orders.length > 0 || stockItems.length > 0;

            if (serverHasData) {
                // ── 서버·로컬 중 더 최신 데이터 판단 ──
                // 서버의 lastUpdated vs 로컬의 최근 전표 createdAt 비교
                const serverTime = data.lastUpdated ? new Date(data.lastUpdated).getTime() : 0;
                // 주문 createdAt 뿐 아니라 updatedAt(메모 수정/삭제 등)도 함께 비교
                // localStorage의 lastLocalUpdated도 포함 (오프라인 변경 대비)
                const lastLocalUpdated = localStorage.getItem('lastLocalUpdated');
                const localLatestOrder = orders.reduce((max, o) => {
                    const t1 = o.createdAt  ? new Date(o.createdAt).getTime()  : 0;
                    const t2 = o.updatedAt  ? new Date(o.updatedAt).getTime()  : 0;
                    return Math.max(t1, t2, max);
                }, lastLocalUpdated ? new Date(lastLocalUpdated).getTime() : 0);
                const localIsNewer = localHasData && localLatestOrder > serverTime;

                if (localIsNewer) {
                    // 공통 업로드 payload 빌더 (배열 대신 map + minify로 payload 최소화)
                    const _buildUploadPayload = () => {
                        const ordersMap = {};
                        orders.forEach(o => { ordersMap[o.id] = _minifyOrder(o); });
                        return {
                            clients:    clients.map(_minifyClient),
                            orders:     ordersMap,
                            prices,
                            stockItems: _getLightStock(),
                            lastUpdated: new Date().toISOString(),
                            writtenBy:  SESSION_ID
                        };
                    };
                    if (auto) {
                        // 자동 연결에서 로컬이 더 최신 → 조용히 로컬 데이터를 서버에 업로드
                        // (오프라인 중 작업한 데이터 유실 방지)
                        const ch=dataHash(clients),oh=dataHash(orders),ph=dataHash(prices),sh=dataHash(stockItems);
                        workspaceRef.update(_buildUploadPayload())
                            .then(()=>{ lastHash.clients=ch;lastHash.orders=oh;lastHash.prices=ph;lastHash.stock=sh; setSyncStatus('online'); toast('🟢 자동 연결 완료 (로컬→서버 업로드)', 'var(--green)'); })
                            .catch(e=>{ console.error('업로드 실패:',e); setSyncStatus('error'); });
                        _connectGuard    = false; // ★ 업로드 트리거 후 리스너 해제
                        _initialLoadDone = true;
                        return;
                    } else {
                        // 수동 연결에서 로컬이 더 최신 → 사용자에게 선택 요청
                        const useLocal = await customConfirm(
                            '⚠️ 로컬 데이터가 서버보다 최신입니다.\n\n' +
                            '· 확인: 로컬 데이터를 서버에 업로드\n' +
                            '· 취소: 서버 데이터를 내려받기',
                            '로컬 업로드', 'btn-primary'
                        );
                        if (useLocal) {
                            const ch=dataHash(clients),oh=dataHash(orders),ph=dataHash(prices),sh=dataHash(stockItems);
                            workspaceRef.update(_buildUploadPayload())
                                .then(()=>{ lastHash.clients=ch;lastHash.orders=oh;lastHash.prices=ph;lastHash.stock=sh; setSyncStatus('online'); toast('☁️ 로컬 데이터를 서버에 업로드했습니다','var(--green)'); })
                                .catch(e=>{ console.error('업로드 실패:',e); setSyncStatus('error'); });
                            _connectGuard    = false;
                            _initialLoadDone = true;
                            closeModal('firebaseModal');
                            return;
                        }
                    }
                }
                const newClients = toArray(data.clients).map(_normClientFromFb);
                const newOrders = toArray(data.orders).map(_normOrderFromFb);
                const newStock = toArray(data.stockItems || []).map(normStock);

                clients    = newClients;
                orders     = newOrders;
                if (data.prices)       prices     = data.prices;
                if (newStock.length)   stockItems = newStock;

                lastHash.clients = dataHash(clients);
                lastHash.orders  = dataHash(orders);
                lastHash.prices  = dataHash(prices);
                lastHash.stock   = dataHash(stockItems);
                if (data.lastUpdated) localStorage.setItem('lastLocalUpdated', data.lastUpdated);
                saveToLocal();
                _fullRender();
                setSyncStatus('online');
                if (!auto) toast('☁️ 서버 데이터를 불러왔습니다', 'var(--green)');
                else       toast('🟢 자동 연결 완료', 'var(--green)');

            } else if (localHasData) {
                // ── 서버 비어있음 → 로컬 데이터 업로드 ──
                const ch = dataHash(clients), oh = dataHash(orders), ph = dataHash(prices), sh = dataHash(stockItems);
                workspaceRef.update({
                    clients, orders, prices, stockItems,
                    lastUpdated: new Date().toISOString(),
                    writtenBy: SESSION_ID
                }).then(() => {
                    lastHash.clients = ch; lastHash.orders = oh; lastHash.prices = ph; lastHash.stock = sh;
                    setSyncStatus('online');
                    toast('☁️ 로컬 데이터를 서버에 업로드했습니다', 'var(--green)');
                }).catch(e => { console.error('초기 업로드 실패:', e); setSyncStatus('error'); });

            } else {
                // 서버·로컬 모두 빔
                setSyncStatus('online');
                if (!auto) toast('✅ Firebase 연결 완료', 'var(--green)');
                else       toast('🟢 자동 연결 완료', 'var(--green)');
            }

            // 초기 로드 완료 → 이후부턴 실시간 리스너가 처리
            _connectGuard    = false; // ★ Problem 1: 초기 처리 완료, 리스너 차단 해제
            _initialLoadDone = true;

            // ★ 실시간 폴링 백업: 30초마다 서버 확인 (이벤트 유실 대비)
            // — 실시간 리스너(.on)와 중복 방지: hash 비교 후 실제 변경분만 처리
            if (_rtPollTimer) clearInterval(_rtPollTimer);
            _rtPollTimer = setInterval(() => {
                if (!workspaceRef || !isConnected || _syncGuard) return;
                workspaceRef.get().then(snap => {
                    const d = snap.val();
                    if (!d) return;
                    // 서버 데이터가 로컬과 동일하면 핸들러 호출 생략 (불필요한 렌더링 방지)
                    const serverOrdersHash  = dataHash(toArray(d.orders).map(_normOrderFromFb));
                    const serverClientsHash = dataHash(toArray(d.clients).map(_normClientFromFb));
                    if (serverOrdersHash === lastHash.orders &&
                        serverClientsHash === lastHash.clients) return;
                    _fbValueHandler(snap);
                }).catch(() => {});
            }, 30000);

            if (!auto) closeModal('firebaseModal');

        }).catch(err => {
            _connectGuard    = false; // 실패해도 리스너 차단 해제
            _initialLoadDone = true; // 실패해도 리스너는 활성화
            console.error('Firebase 연결 실패:', err);
            isConnected = false;
            workspaceRef.off();
            workspaceRef = null;
            setSyncStatus('error');
            document.getElementById('connectBtn').style.display    = 'block';
            document.getElementById('disconnectBtn').style.display = 'none';
            const msg = err.code === 'PERMISSION_DENIED'
                ? '❗ 권한 오류: Firebase 보안 규칙을 확인하세요'
                : '❗ 연결 실패: ' + (err.message || '네트워크 오류');
            toast(msg);
        });

    } catch(e) {
        console.error('Firebase 초기화 오류:', e);
        isConnected = false;
        setSyncStatus('error');
        toast('❗ Firebase 초기화 오류: ' + e.message);
    }
}

function disconnectWorkspace() {
    if (workspaceRef) workspaceRef.off();
    // .info/connected 리스너 해제 (연결 해제 시 불필요한 상태 변경 차단)
    try { firebase.database().ref('.info/connected').off(); } catch(e) {}
    // 실시간 폴링 백업 타이머 정리
    if (_rtPollTimer) { clearInterval(_rtPollTimer); _rtPollTimer = null; }
    debouncedSync.cancel();
    workspaceRef=null; isConnected=false;
    _syncGuard=false; _connectGuard=false; // 가드 초기화
    // 재연결 시 변경사항을 정확히 업로드하도록 lastHash 초기화
    lastHash = { clients:'', orders:'', prices:'', stock:'' };
    setSyncStatus('offline');
    document.getElementById('connectBtn').style.display   ='block';
    document.getElementById('disconnectBtn').style.display='none';
    applyWsLockUI();
    toast('🔌 연결 해제됨');
}

// ─── 워크스페이스 Firebase 데이터 삭제 ───

async function deleteWorkspaceData(targetId) {
    const id = (targetId || '').trim().toLowerCase();
    if (!id) return toast('❗ 삭제할 워크스페이스 ID를 입력하세요');

    const isCurrentWs = (id === (localStorage.getItem('workspaceId') || '').toLowerCase());

    const confirmed = await customConfirm(
        `⚠️ 워크스페이스 "${id}"의 모든 Firebase 데이터를 삭제합니다.\n\n` +
        `거래처·전표·재고·백업 등 서버에 저장된 모든 데이터가 영구 삭제됩니다.\n` +
        `이 작업은 되돌릴 수 없습니다!`,
        '삭제', 'btn-danger'
    );
    if (!confirmed) return;

    const confirmed2 = await customConfirm(
        `마지막 확인입니다.\n워크스페이스 "${id}" Firebase 데이터를 완전히 삭제합니다.`,
        '최종 삭제', 'btn-danger'
    );
    if (!confirmed2) return;

    try {
        waitFirebase(async () => {
            try {
                if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
                const ref = firebase.database().ref('workspaces/' + id);
                await ref.remove();

                toast(`🗑️ 워크스페이스 "${id}" Firebase 데이터 삭제 완료`, 'var(--green)');

                // 현재 연결된 워크스페이스였다면 자동 연결 해제
                if (isCurrentWs && isConnected) {
                    disconnectWorkspace();
                    toast(`🔌 연결 해제 및 데이터 삭제 완료`);
                }

                // 삭제 후 입력 필드 초기화
                const inp = document.getElementById('deleteWsInput');
                if (inp) inp.value = '';
            } catch(e) {
                console.error('워크스페이스 삭제 오류:', e);
                const msg = e.code === 'PERMISSION_DENIED'
                    ? '❗ 권한 오류: Firebase 보안 규칙에서 삭제가 허용되지 않습니다'
                    : '❗ 삭제 실패: ' + (e.message || '알 수 없는 오류');
                toast(msg);
            }
        });
    } catch(e) {
        toast('❗ Firebase 초기화 오류: ' + e.message);
    }
}

// ─── 현재 연결된 워크스페이스 삭제 (연결 상태 필요) ───
async function deleteCurrentWorkspaceData() {
    const id = localStorage.getItem('workspaceId') || '';
    if (!id) return toast('❗ 연결된 워크스페이스가 없습니다');
    if (!isConnected || !workspaceRef) return toast('❗ Firebase에 연결 후 삭제할 수 있습니다');
    await deleteWorkspaceData(id);
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  § 16  사용설명서                                                   ║
// ╚══════════════════════════════════════════════════════════════╝

// ─── 경량 Markdown → HTML 렌더러 ───
function _md2html(md) {
    // 코드 블록 보호
    const blocks = [];
    let s = md
        .replace(/```([\s\S]*?)```/g, (_, c) => { blocks.push(c); return `\x02CODE${blocks.length-1}\x02`; })
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // 제목
    s = s.replace(/^######\s(.+)$/gm, '<h6>$1</h6>');
    s = s.replace(/^#####\s(.+)$/gm,  '<h5>$1</h5>');
    s = s.replace(/^####\s(.+)$/gm,   '<h4>$1</h4>');
    s = s.replace(/^###\s(.+)$/gm,    '<h3>$1</h3>');
    s = s.replace(/^##\s(.+)$/gm,     '<h2>$2</h2>'.replace('$2','$1'));
    s = s.replace(/^#\s(.+)$/gm,      '<h1>$1</h1>');

    // 테이블
    s = s.replace(/(^\|.+\|\n)+/gm, t => {
        const rows = t.trim().split('\n').filter(r => !/^\|[-| :]+\|$/.test(r.trim()));
        const header = rows.shift();
        const ths = header.split('|').filter((_,i,a)=>i>0&&i<a.length-1).map(c=>`<th>${c.trim()}</th>`).join('');
        const trs = rows.map(r => '<tr>' + r.split('|').filter((_,i,a)=>i>0&&i<a.length-1).map(c=>`<td>${c.trim()}</td>`).join('') + '</tr>').join('');
        return `<table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
    });

    // 인용
    s = s.replace(/^&gt;\s(.+)$/gm, '<blockquote>$1</blockquote>');

    // 구분선
    s = s.replace(/^---$/gm, '<hr>');

    // 체크박스
    s = s.replace(/^- \[x\] (.+)$/gm, '<li class="chk done">$1</li>');
    s = s.replace(/^- \[ \] (.+)$/gm, '<li class="chk">$1</li>');

    // 리스트
    s = s.replace(/(^- .+\n?)+/gm, m => '<ul>' + m.replace(/^- (.+)$/gm,'<li>$1</li>') + '</ul>');
    s = s.replace(/(^\d+\.\s.+\n?)+/gm, m => '<ol>' + m.replace(/^\d+\.\s(.+)$/gm,'<li>$1</li>') + '</ol>');

    // 인라인
    s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*(.+?)\*\*/g,     '<strong>$1</strong>');
    s = s.replace(/\*(.+?)\*/g,         '<em>$1</em>');
    s = s.replace(/`([^`]+)`/g,         '<code>$1</code>');
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

    // 단락
    s = s.split('\n\n').map(chunk => {
        chunk = chunk.trim();
        if (!chunk) return '';
        if (/^<(h[1-6]|ul|ol|table|blockquote|hr|pre)/.test(chunk)) return chunk;
        return `<p>${chunk.replace(/\n/g,'<br>')}</p>`;
    }).join('\n');

    // 코드 블록 복원
    s = s.replace(/\x02CODE(\d+)\x02/g, (_, i) => {
        const lines = blocks[+i].split('\n');
        const lang = lines[0].trim();
        const code = lines.slice(1).join('\n');
        return `<pre><code${lang ? ` class="lang-${lang}"` : ''}>${code}</code></pre>`;
    });

    return s;
}

// ─── 앱 내 변경이력 추출 (changelog-item 파싱) ───
function _extractChangelog() {
    let md = '\n## 변경이력\n\n';
    document.querySelectorAll('#changelogList .changelog-item').forEach(el => {
        const ver  = el.querySelector('.changelog-ver')?.textContent?.trim() || '';
        const desc = el.querySelector('.changelog-desc')?.textContent?.trim() || '';
        if (ver && desc) md += `### ${ver}\n\n${desc}\n\n`;
    });
    // oldChangelogItems 안도 포함
    document.querySelectorAll('#oldChangelogItems .changelog-item').forEach(el => {
        const ver  = el.querySelector('.changelog-ver')?.textContent?.trim() || '';
        const desc = el.querySelector('.changelog-desc')?.textContent?.trim() || '';
        if (ver && desc) md += `### ${ver}\n\n${desc}\n\n`;
    });
    return md;
}

// ─── 설명서 모달 열기 ───
async function openManual() {
    const modal   = document.getElementById('manualModal');
    const content = document.getElementById('manualContent');
    const tocEl   = document.getElementById('manualToc');
    const titleEl = document.getElementById('manualTitle');
    if (!modal) return;

    modal.style.display = 'flex';
    titleEl.textContent = '사용설명서 불러오는 중...';
    content.innerHTML   = '<div style="text-align:center;padding:60px 0;color:var(--text3);"><div class="spin" style="width:32px;height:32px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite;margin:0 auto 12px;"></div>불러오는 중...</div>';
    tocEl.innerHTML = '';

    let raw = '';
    try {
        const res = await fetch(MANUAL_URL + '?t=' + Date.now(), { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        raw = await res.text();
    } catch(e) {
        // GitHub 접근 실패 시 안내 메시지
        content.innerHTML = `
            <div style="padding:24px;text-align:center;color:var(--text2);">
                <div style="font-size:32px;margin-bottom:12px;">📡</div>
                <div style="font-weight:700;margin-bottom:8px;">설명서를 불러올 수 없습니다</div>
                <div style="font-size:13px;margin-bottom:16px;">GitHub에 manual.md가 업로드되지 않았거나 네트워크 문제입니다.</div>
                <code style="font-size:11px;background:var(--surf3);padding:4px 8px;border-radius:4px;word-break:break-all;">${MANUAL_URL}</code>
                <div style="margin-top:20px;font-size:12px;color:var(--text3);">
                    app.js 상단의 <strong>MANUAL_URL</strong>을 GitHub raw 주소로 수정하세요.
                </div>
            </div>`;
        titleEl.textContent = '사용설명서';
        return;
    }

    // <!-- CHANGELOG_AUTO --> 자리에 앱 내 변경이력 주입
    raw = raw.replace('<!-- CHANGELOG_AUTO -->', _extractChangelog());

    // 현재 버전 주입
    const curVer = document.querySelector('.changelog-ver[style*="green"]')?.textContent || 'v82';
    raw = raw.replace('납품 관리 Pro — 사용설명서', `납품 관리 Pro — 사용설명서  \n<span style="font-size:12px;color:var(--text3);">현재 버전: ${curVer}</span>`);

    const html = _md2html(raw);
    content.innerHTML = `<div class="manual-body">${html}</div>`;

    // ★ PWA 재실행 방지: 앵커 클릭 가로채기 → scrollIntoView로 교체
    content.addEventListener('click', e => {
        const a = e.target.closest('a');
        if (!a) return;
        const href = a.getAttribute('href');
        if (!href || !href.startsWith('#')) return;
        e.preventDefault();
        e.stopPropagation();

        const id = href.slice(1); // '#시작하기' → '시작하기'

        // 1순위: 동적으로 부여된 mh-N id로 직접 탐색
        let target = document.getElementById(id);

        // 2순위: 헤딩 텍스트와 매칭 (한글 앵커)
        if (!target) {
            const normalize = s => s.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\w가-힣-]/g, '');
            const needle = normalize(id);
            target = [...content.querySelectorAll('h1,h2,h3,h4,h5,h6')]
                .find(h => h.dataset.slug === needle ||
                           normalize(h.textContent) === needle ||
                           normalize(h.textContent) === id.replace(/-/g, ' '));
        }

        if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }, true); // capture phase — a 태그보다 먼저 처리

    // 목차 자동 생성 + 헤딩에 한글 슬러그 id 부여
    const headings = content.querySelectorAll('h2, h3');
    if (headings.length) {
        const normalize = s => s.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\w가-힣-]/g, '');
        let tocHtml = '<div style="font-size:11px;font-weight:700;color:var(--text2);letter-spacing:.5px;margin-bottom:8px;">목차</div>';
        headings.forEach((h, idx) => {
            h.id = 'mh-' + idx;
            // 한글 앵커 id도 data 속성으로 추가 (클릭 매칭용)
            h.dataset.slug = normalize(h.textContent);
            const indent = h.tagName === 'H3' ? 'padding-left:12px;font-size:12px;color:var(--text3);' : 'font-size:13px;font-weight:700;';
            tocHtml += `<div style="${indent}margin:4px 0;cursor:pointer;" onclick="document.getElementById('mh-${idx}').scrollIntoView({behavior:'smooth'})">${h.textContent.trim()}</div>`;
        });
        tocEl.innerHTML = tocHtml;
    }

    titleEl.textContent = '사용설명서';
}

function closeManual() {
    const modal = document.getElementById('manualModal');
    if (modal) modal.style.display = 'none';
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  § 17  앱 초기화 (DOMContentLoaded)                               ║
// ╚══════════════════════════════════════════════════════════════╝

// ─── 시스템 다크모드 자동 감지 ───

function initSystemTheme() {
    // 이미 사용자가 직접 설정한 경우는 그대로
    if (localStorage.getItem('theme')) return;
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.body.classList.toggle('light', !isDark);
    document.getElementById('themeBtn').textContent = isDark ? '☀️' : '🌙';
}

// ─── 대시보드 렌더 후 sparklines & count-up 실행 ───
let _dashSparkTimer = null;
renderDashboard = _safeWrap(renderDashboard, function() {
    if (_dashSparkTimer) clearTimeout(_dashSparkTimer);
    _dashSparkTimer = setTimeout(() => {
        _dashSparkTimer = null;
        renderSparklines();
        ['dashSales','dashUnpaid'].forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            const raw = el.textContent.replace(/,/g,'');
            const num = parseFloat(raw);
            if (!isNaN(num) && num > 0) animateCount(el, num);
        });
    }, 50);
});

// ─── renderSettlement 후킹 (바차트 추가) ───
renderSettlement = _safeWrap(renderSettlement, function() {
    const month = document.getElementById('settlementMonth')?.value || todayKST().slice(0,7);
    renderSettleBarChart(month);
});
renderSettlementDaily = _safeWrap(renderSettlementDaily, function() {
    const date = document.getElementById('settlementDateDaily')?.value || todayKST();
    renderSettleBarChart(date.slice(0,7));
});
renderSettlementQuarterly = _safeWrap(renderSettlementQuarterly, function() {
    const year = document.getElementById('settlementYear')?.value || todayKST().slice(0,4);
    renderSettleBarChart(year + '-01');
});

// ─── updateInfoCounts 후킹 (배지 갱신) ───
updateInfoCounts = _safeWrap(updateInfoCounts, function() { updateNavBadges(); });

// ─── renderClients 후킹 (스와이프 초기화) ───
renderClients = _safeWrap(renderClients, function() { initClientSwipe(); });


// ─── 달걀 품목 초기 등록 ───
const EGG_ITEMS_DEFAULT = [
    { name:'왕란', unit:'판', low:5, danger:2, note:'왕란' },
    { name:'특란', unit:'판', low:5, danger:2, note:'특란' },
    { name:'대란', unit:'판', low:5, danger:2, note:'대란' },
    { name:'중란', unit:'판', low:5, danger:2, note:'중란' },
];

// ─── 초기화 ───

// ─── 스와이프 제스처 ───

function initSwipeGestures() {
    let startX=0, startY=0, blocked=false;
    const content = document.getElementById('mainContent');
    content.addEventListener('touchstart', e=>{
        blocked = !!e.target.closest('.table-wrap') ||
                  !!e.target.closest('#settlementTable');
        startX = e.changedTouches[0].screenX;
        startY = e.changedTouches[0].screenY;
    }, {passive:true});
    content.addEventListener('touchend', e=>{
        if (blocked) return;
        const dx = e.changedTouches[0].screenX - startX;
        const dy = e.changedTouches[0].screenY - startY;
        // 수평 이동이 수직 이동의 1.5배 이상이어야 탭 전환 (대각선 스크롤 방지)
        if (Math.abs(dx) < 60) return;
        if (Math.abs(dy) > Math.abs(dx) * 0.7) return;
        const active = document.querySelector('.pane.active');
        const id = active?.id?.replace('pane-','');
        const idx = TAB_ORDER.indexOf(id);
        if (idx===-1) return;
        if (dx>0 && idx>0) showTab(TAB_ORDER[idx-1]);
        if (dx<0 && idx<TAB_ORDER.length-1) showTab(TAB_ORDER[idx+1]);
    }, {passive:true});
}

// ─── Pull-to-Refresh ───

function initPullToRefresh() {
    const content   = document.getElementById('mainContent');
    const indicator = document.getElementById('pullIndicator');
    const pullText  = document.getElementById('pullText');
    const THRESHOLD = 65;   // 놓을 때 새로고침 발동 기준 (px)
    const MAX_PULL  = 110;  // 최대 당김 거리 (px)

    let startY = 0;
    let pulling = false;
    let isRefreshing = false;
    let startScrollTop = 0;

    content.addEventListener('touchstart', e => {
        if (isRefreshing) return;
        startScrollTop = content.scrollTop;
        // 스크롤이 최상단일 때만 pull 시작
        if (startScrollTop > 2) return;
        startY = e.touches[0].clientY;
        pulling = false;
    }, { passive: true });

    content.addEventListener('touchmove', e => {
        if (isRefreshing) return;
        if (content.scrollTop > 2) return; // 스크롤 내려가 있으면 무시
        const dy = e.touches[0].clientY - startY;
        if (dy < 10) return; // 아래 방향 최소 이동

        pulling = true;

        const pull = Math.min(dy * 0.6, MAX_PULL); // 저항감 0.6배

        indicator.style.height = pull + 'px';
        indicator.classList.toggle('releasing', pull >= THRESHOLD);
        indicator.classList.remove('refreshing');

        if (pull >= THRESHOLD) {
            pullText.textContent = '놓으면 새로고침';
        } else {
            pullText.textContent = '당겨서 새로고침';
        }
    }, { passive: true });

    content.addEventListener('touchend', e => {
        if (!pulling || isRefreshing) { pulling = false; return; }
        pulling = false;
        const currentH = parseInt(indicator.style.height || '0');

        if (currentH >= THRESHOLD) {
            // 새로고침 발동
            isRefreshing = true;
            indicator.style.height = '52px';
            indicator.classList.remove('releasing');
            indicator.classList.add('refreshing', 'visible');
            pullText.textContent = '새로고침 중…';

            // 실제 새로고침 실행
            setTimeout(() => {
                try {
                    _fullRender();
                    // Firebase 연결 중이면 서버 최신 데이터 받아서 반영
                    if (isConnected && workspaceRef) {
                        workspaceRef.get().then(async snap => {
                            const d = snap.val();
                            if (!d) return;
                            if (d.clients)    { clients    = toArray(d.clients).map(_normClientFromFb); }
                            if (d.orders)     { orders     = toArray(d.orders).map(_normOrderFromFb); }
                            if (d.prices)     { prices     = d.prices; }
                            if (d.stockItems) { stockItems = toArray(d.stockItems).map(normStock); }
                            lastHash = { clients:dataHash(clients), orders:dataHash(orders), prices:dataHash(prices), stock:dataHash(stockItems) };
                            saveToLocal();
                            _fullRender();
                        }).catch(()=>{});
                    }
                } catch(e) { console.warn('pull-to-refresh 오류', e); }

                // 인디케이터 숨기기
                setTimeout(() => {
                    indicator.style.height = '0';
                    indicator.classList.remove('refreshing', 'visible', 'releasing');
                    pullText.textContent = '당겨서 새로고침';
                    isRefreshing = false;
                }, 600);
            }, 300);
        } else {
            // 미달 → 원위치
            indicator.style.transition = 'height 0.25s ease';
            indicator.style.height = '0';
            indicator.classList.remove('releasing', 'visible');
            setTimeout(() => { indicator.style.transition = ''; }, 250);
        }
    }, { passive: true });
}

// ─── 변경 이력 접기/펼치기 ───

function toggleOldChangelog() {
    const items = document.getElementById('oldChangelogItems');
    const icon  = document.getElementById('changelogToggleIcon');
    const label = document.getElementById('changelogToggleLabel');
    const isOpen = items.style.display === 'flex';
    // 첫 번째 이전 이력 버전명을 DOM에서 동적으로 읽어 레이블 구성
    const firstOldVer = items.querySelector('.changelog-ver')?.textContent?.trim() || '';
    const lastOldVer  = [...items.querySelectorAll('.changelog-ver')].pop()?.textContent?.trim() || '';
    const rangeLabel  = firstOldVer && lastOldVer ? `(${firstOldVer} ~ ${lastOldVer})` : '';
    if (isOpen) {
        items.style.display = 'none';
        icon.textContent  = '▼';
        label.textContent = `이전 이력 보기 ${rangeLabel}`;
    } else {
        items.style.display = 'flex';
        icon.textContent  = '▲';
        label.textContent = `이전 이력 접기 ${rangeLabel}`;
    }
}

// ─── 전체 렌더 ───

function _fullRender() {
    invalidateOrdersCache();
    // 캐시 사전 빌드 (첫 입력 시 딜레이 제거)
    _buildRecentPricesCache();
    // 모든 탭 더티 마킹 → 탭 진입 시 각자 렌더링
    _markDirty();
    // 거래처 목록 display 상태 보장
    const cl = document.getElementById('clientList');
    const tb = document.getElementById('clientToggleBtn');
    if (cl) cl.style.display = clientListVisible ? 'block' : 'none';
    if (tb) tb.textContent   = clientListVisible ? '숨기기' : '보이기';
    // 납품 autocomplete 갱신 (탭 무관)
    updateItemDatalist('');
    // 탭 무관 항상 갱신 (원본 동작 보존)
    updateInfoCounts();
    renderDashboard();
    // 배지 갱신
    updateNavBadges();
    // 현재 활성 탭만 즉시 렌더링 (dashboard는 이미 위에서 갱신됐으므로 dirty 해제)
    _dirty['dashboard'] = false;
    _renderActiveIfDirty();
}

// ─── 드롭다운 외부 클릭 닫기: 위 통합 document click 핸들러에서 처리 ───

// ─── 더블탭 전체선택 (모바일 터치 지원) ───
// PC: ondblclick="this.select()" 으로 처리
// 모바일: 300ms 이내 두 번 터치 → select() 전체 선택
function _initDoubleTapSelect(el) {
    if (!el) return;
    let _lastTap = 0;
    el.addEventListener('touchend', e => {
        const now = Date.now();
        if (now - _lastTap < 300) {
            e.preventDefault();
            el.select();
        }
        _lastTap = now;
    }, { passive: false });
}

// ─── Escape 키로 열린 모달 닫기 ───
document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const mp = document.getElementById('memoPopup');
    if (mp && mp.classList.contains('open')) { closeMemoPopup(); return; }
    const qp = document.getElementById('quickPayPopup');
    if (qp && qp.classList.contains('open')) { closeQuickPay(); return; }
    const bp = document.getElementById('bulkPayPopup');
    if (bp && bp.classList.contains('open')) { closeBulkPayPopup(); return; }
    const modals = [
        'firebaseModal','detailModal','statementModal','partialPayModal','payEditModal',
        'clientEditModal','orderEditModal','stockEditModal','stockAdjModal','stockLogModal'
    ];
    for (const id of modals) {
        const el = document.getElementById(id);
        if (el && el.classList.contains('open')) { closeModal(id); break; }
    }
});

// ─── Enter 키 포커스 체인 ───

function focusNext(nextId, action) {
    if (action) { action(); return; }
    const el = document.getElementById(nextId);
    if (el) el.focus();
}

function bindEnter(id, nextId, action) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        // textarea: Enter는 줄바꿈, Ctrl+Enter로 다음 이동
        if (el.tagName === 'TEXTAREA') {
            if (e.ctrlKey || e.metaKey) { e.preventDefault(); focusNext(nextId, action); }
            return;
        }
        e.preventDefault();
        focusNext(nextId, action);
    });
}

function initKeyHandlers() {
    // ── 거래처 탭 ──
    bindEnter('clientName',    'clientPhone');
    bindEnter('clientPhone',   'clientAddress');
    bindEnter('clientAddress', 'clientNote');
    bindEnter('clientNote',    null, saveClient);   // Ctrl+Enter → 등록

    // ── 납품 탭 ──
    bindEnter('deliveryClient', 'deliveryDate');
    bindEnter('deliveryDate',   'itemName');
    bindEnter('itemName',       'itemQty');
    bindEnter('itemQty',        'itemPrice');
    bindEnter('itemPrice',      null, addItemToGroup);

    // ── Firebase 모달 ──
    bindEnter('workspaceId', null, () => connectWorkspace(false));

    // ── 백업 탭 ──
    bindEnter('schedDay1', 'schedDay2');
    bindEnter('schedDay2', null, saveBackupSchedule);
}

// ─── 달걀 품목 초기 등록 ───

// ─── 초기화 ───
window.addEventListener('DOMContentLoaded', () => {
    // 테마
    applyTheme();
    // 날짜 기본값
    const today = todayKST();
    document.getElementById('deliveryDate').value = today;
    document.getElementById('settlementMonth').value = today.slice(0,7);
    document.getElementById('settlementDateDaily').value = today;
    document.getElementById('settlementYear').value = today.slice(0,4);
    initHistPeriod();
    // 탭 & 스와이프
    initTabs();
    _initAllMoneyInputs(); // 금액 입력 필드 콤마 포매터 초기화
    initSwipeGestures();
    initPullToRefresh();
    initKeyHandlers();
    // 검색 입력창 더블탭 전체선택 (모바일)
    ['deliveryClient','clientSearch','histSearch','settleSearch'].forEach(id => {
        _initDoubleTapSelect(document.getElementById(id));
    });
    // 거래처 목록 초기 display 상태 동기화 (clientListVisible 기본값 false에 맞춤)
    const clInit = document.getElementById('clientList');
    const tbInit = document.getElementById('clientToggleBtn');
    if (clInit) clInit.style.display = clientListVisible ? 'block' : 'none';
    if (tbInit) tbInit.textContent = clientListVisible ? '숨기기' : '보이기';
    // 초기 렌더
    renderDashboard();
    updateInfoCounts();
    updateItemDatalist();
    // 워크스페이스 ID 복원 및 잠금 UI 적용
    const savedWs  = localStorage.getItem('workspaceId');
    const isLocked = localStorage.getItem('wsLocked') === '1';
    // 잠금 상태면 input 값을 localStorage에서 복원 (applyWsLockUI 내부에서도 처리하지만 안전망)
    if (savedWs) {
        document.getElementById('workspaceId').value = savedWs;
    }
    applyWsLockUI(); // 잠금 여부와 무관하게 항상 UI 동기화
    // 자동 재연결: workspaceId가 저장돼 있으면 연결 시도
    if (savedWs) {
        waitFirebase(() => _doConnect(savedWs, true));
    }
    // 자동 백업 체크
    setTimeout(checkAutoBackup, 2000);
    // 백업 저장 위치 복원
    loadBackupDir();
    // 네트워크 끊김/복구 감지
    // ※ .info/connected 리스너가 Firebase 소켓 수준 감지를 담당
    //   window.online/offline은 .info/connected가 미동작하는 엣지 케이스 보완용으로 유지
    window.addEventListener('online', () => {
        const sid = localStorage.getItem('workspaceId');
        if (workspaceRef) {
            // ── 서버 먼저 읽기 → 시간 비교 → 로컬이 더 최신일 때만 업로드 ──
            // (기존: 무조건 업로드 후 서버 재로드 → 멀티기기 경쟁 조건 발생)
            debouncedSync.cancel();
            workspaceRef.get().then(async snap => {
                const d = snap.val();
                isConnected = true;
                setSyncStatus('online');
                if (!d) {
                    // 서버 비어있음 → 로컬 업로드
                    const ch=dataHash(clients),oh=dataHash(orders),ph=dataHash(prices),sh=dataHash(stockItems);
                    const ordersMap = {}; orders.forEach(o => { ordersMap[o.id] = _minifyOrder(o); });
                    workspaceRef.update({
                        clients: clients.map(_minifyClient),
                        orders: ordersMap, prices, stockItems,
                        lastUpdated: new Date().toISOString(), writtenBy: SESSION_ID
                    }).then(() => {
                        lastHash.clients=ch; lastHash.orders=oh; lastHash.prices=ph; lastHash.stock=sh;
                        _clearOrderDelta();
                    }).catch(() => {});
                    return;
                }
                // 서버·로컬 시간 비교
                const serverTime = d.lastUpdated ? new Date(d.lastUpdated).getTime() : 0;
                const lastLocalUpdated = localStorage.getItem('lastLocalUpdated');
                const localTime = Math.max(
                    _localWriteTime,
                    lastLocalUpdated ? new Date(lastLocalUpdated).getTime() : 0
                );
                if (localTime > serverTime) {
                    // 로컬이 더 최신 → minify 적용 후 업로드
                    const ch=dataHash(clients),oh=dataHash(orders),ph=dataHash(prices),sh=dataHash(stockItems);
                    const ordersMap = {}; orders.forEach(o => { ordersMap[o.id] = _minifyOrder(o); });
                    workspaceRef.update({
                        clients: clients.map(_minifyClient),
                        orders: ordersMap, prices, stockItems,
                        lastUpdated: new Date().toISOString(), writtenBy: SESSION_ID
                    }).then(() => {
                        lastHash.clients=ch; lastHash.orders=oh; lastHash.prices=ph; lastHash.stock=sh;
                        _clearOrderDelta();
                    }).catch(() => {});
                } else {
                    // 서버가 더 최신 (오프라인 중 다른 기기가 변경) → 서버 데이터 적용
                    if (d.clients)    clients    = toArray(d.clients).map(_normClientFromFb);
                    if (d.orders)     orders     = toArray(d.orders).map(_normOrderFromFb);
                    if (d.prices)     prices     = d.prices;
                    if (d.stockItems) stockItems = toArray(d.stockItems).map(normStock);
                    lastHash.clients=dataHash(clients); lastHash.orders=dataHash(orders);
                    lastHash.prices=dataHash(prices);   lastHash.stock=dataHash(stockItems);
                    _clearOrderDelta();
                    invalidateOrdersCache();
                    saveToLocal();
                    _fullRender();
                }
            }).catch(() => {
                // .get() 실패 시 .info/connected가 재연결 후 debouncedSync() 트리거
            });
        } else {
            if (sid) {
                document.getElementById('workspaceId').value = sid;
                waitFirebase(() => _doConnect(sid, true));
            }
        }
    });
    window.addEventListener('offline', () => {
        // .info/connected 리스너가 주 처리 담당 — 여기서는 즉각 UI 반영만
        if (isConnected) {
            isConnected = false;
            debouncedSync.cancel();
            setSyncStatus('error');
        }
    });
    applyAutoDeductUI();
    // 재고 탭 날짜 인풋 초기값 설정
    const sdInit = document.getElementById('stockViewDate');
    if (sdInit) sdInit.value = todayKST();
    initSystemTheme();
    updateNavBadges();

    // ─── PWA 설치 프롬프트 ───
    let _pwaInstallPrompt = null;
    window.addEventListener('beforeinstallprompt', e => {
        e.preventDefault();
        _pwaInstallPrompt = e;
        // 설치 안내 배너 표시
        const banner = document.createElement('div');
        banner.id = 'pwaBanner';
        banner.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);' +
            'width:calc(100% - 32px);max-width:488px;' +
            'background:linear-gradient(135deg,#4e54c8,#6c63ff);color:#fff;' +
            'border-radius:14px;padding:13px 16px;display:flex;align-items:center;' +
            'justify-content:space-between;gap:10px;z-index:9999;' +
            'box-shadow:0 4px 20px rgba(108,99,255,.5);font-size:13px;font-weight:700;';
        banner.innerHTML =
            '<span>📲 홈화면에 앱으로 추가할 수 있습니다</span>' +
            '<div style="display:flex;gap:8px;flex-shrink:0;">' +
            '<button onclick="installPWA()" style="background:#fff;color:#6c63ff;border:none;border-radius:8px;padding:7px 14px;font-weight:900;font-size:12px;cursor:pointer;">설치</button>' +
            '<button onclick="document.getElementById(\'pwaBanner\').remove()" style="background:rgba(255,255,255,.2);color:#fff;border:none;border-radius:8px;padding:7px 10px;font-size:12px;cursor:pointer;">✕</button>' +
            '</div>';
        document.body.appendChild(banner);
        // 10초 후 자동 숨김
        setTimeout(() => banner?.remove(), 10000);
    });

    window.installPWA = async function() {
        if (!_pwaInstallPrompt) return;
        _pwaInstallPrompt.prompt();
        const { outcome } = await _pwaInstallPrompt.userChoice;
        _pwaInstallPrompt = null;
        document.getElementById('pwaBanner')?.remove();
        if (outcome === 'accepted') toast('✅ 홈화면에 추가되었습니다!', 'var(--green)');
    };

    // 이미 설치된 경우 (standalone 모드)
    if (window.matchMedia('(display-mode: standalone)').matches) {
        console.log('PWA 모드로 실행 중');
    }
});

// ═══════════════════════════════════════
// ── 메모 모아보기 ─────────────────────────────────────────────
// ═══════════════════════════════════════
let _memoViewUnit   = 'cycle'; // 'cycle' | 'week' | 'month'
let _memoViewOffset = 0;       // 오늘 기준 n주/월 전후
let _memoDetailClient = '';    // 상세 팝업에 표시 중인 거래처명

function openMemoView() {
    _memoViewOffset = 0;
    document.getElementById('memoViewPopup').classList.add('open');
    if (!_modalHistoryPushed) { history.pushState({ modalOpen: true }, ''); _modalHistoryPushed = true; }
    renderMemoView();
}
function closeMemoView() {
    document.getElementById('memoViewPopup').classList.remove('open');
}

function setMemoUnit(unit, btn) {
    _memoViewUnit   = unit;
    _memoViewOffset = 0;
    document.querySelectorAll('.memo-unit-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderMemoView();
}

function moveMemoViewPeriod(dir) {
    _memoViewOffset += dir;
    renderMemoView();
}

function _getMemoViewRange() {
    const fmt = d => {
        const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), dd = String(d.getDate()).padStart(2,'0');
        return `${y}-${m}-${dd}`;
    };
    const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
    // todayKST()로 정확한 KST 날짜 구함 (기기 시간대 무관)
    const todayStr = todayKST();
    const today = new Date(todayStr + 'T00:00:00');

    if (_memoViewUnit === 'month') {
        const d    = new Date(today.getFullYear(), today.getMonth() + _memoViewOffset, 1);
        const endD = new Date(d.getFullYear(), d.getMonth() + 1, 0);
        const pad  = n => String(n).padStart(2,'0');
        const start = `${d.getFullYear()}-${pad(d.getMonth()+1)}-01`;
        const end   = `${endD.getFullYear()}-${pad(endD.getMonth()+1)}-${pad(endD.getDate())}`;
        const label = `${d.getFullYear()}년 ${d.getMonth()+1}월`;
        return { start, end, label };

    } else if (_memoViewUnit === 'cycle') {
        // 납품 주기: 오늘(+offset일) 기준 두 날짜 반환
        // 월/화/수 → D-7, D-4 / 목/금/토 → D-7, D-3
        const base = addDays(today, _memoViewOffset);
        const dow  = base.getDay(); // 0=일,1=월...6=토
        const gap  = (dow >= 4 && dow <= 6) ? 3 : 4; // 목·금·토=3, 나머지=4
        const d1   = addDays(base, -7);
        const d2   = addDays(base, -gap);
        const dayNames = ['일','월','화','수','목','금','토'];
        const shortFmt = d => `${d.getMonth()+1}/${d.getDate()}(${dayNames[d.getDay()]})`;
        const label = `${shortFmt(d1)}, ${shortFmt(d2)} 메모`;
        return { dates: [fmt(d1), fmt(d2)], label, base: fmt(base) };

    } else {
        // 주단위: 월요일 기준
        const day    = today.getDay();
        const monday = new Date(today);
        monday.setDate(today.getDate() - (day === 0 ? 6 : day - 1) + _memoViewOffset * 7);
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        const label = `${monday.getMonth()+1}/${monday.getDate()}(월) ~ ${sunday.getMonth()+1}/${sunday.getDate()}(일)`;
        return { start: fmt(monday), end: fmt(sunday), label };
    }
}

async function deleteAllMemoInView() {
    const range = _getMemoViewRange();
    const targets = (orders || []).filter(o => {
        if (!o.note || !o.note.trim()) return false;
        if (range.dates) return range.dates.includes(o.date);
        return o.date >= range.start && o.date <= range.end;
    });
    if (!targets.length) return toast('삭제할 메모가 없습니다', 'var(--text3)');
    const clientNames = [...new Set(targets.map(o => o.clientName))].join(', ');
    if (!await customConfirm(`📋 현재 기간의 메모 ${targets.length}건을 모두 삭제할까요?\n\n대상: ${clientNames}`)) return;
    const now = new Date().toISOString();
    targets.forEach(o => { o.note = ''; o.updatedAt = now; });
    _saveAndFlush();
    renderMemoView();
    renderOrders();
    toast(`🗑️ 메모 ${targets.length}건 삭제됨`, 'var(--text3)');
}

function renderMemoView() {
    const range = _getMemoViewRange();
    document.getElementById('memoViewPeriodLabel').textContent = range.label;

    // cycle 모드: 두 날짜 / 그 외: start~end 범위
    const filtered = (orders || []).filter(o => {
        if (!o.note || !o.note.trim()) return false;
        if (range.dates) return range.dates.includes(o.date);
        return o.date >= range.start && o.date <= range.end;
    });

    const groups = {};
    filtered.forEach(o => {
        if (!groups[o.clientName]) groups[o.clientName] = [];
        groups[o.clientName].push(o);
    });

    const list = document.getElementById('memoViewClientList');
    if (!Object.keys(groups).length) {
        list.innerHTML = `<div style="text-align:center;padding:36px 0;color:var(--text3);font-size:14px;">📭 이 기간에 메모가 없습니다</div>`;
        return;
    }

    list.innerHTML = Object.entries(groups)
        .sort((a, b) => a[0].localeCompare(b[0], 'ko'))
        .map(([name, ords]) => {
            const cnt     = ords.length;
            const preview = ords[0].note.length > 24 ? ords[0].note.slice(0, 24) + '…' : ords[0].note;
            const safeName = escapeHtml(name);
            return `<div class="memo-view-client-card" onclick="openMemoDetail('${safeName}')">
                <div class="memo-view-client-name">${safeName} <span class="memo-count-badge">${cnt}건</span></div>
                <div class="memo-view-preview">${escapeHtml(preview)}</div>
            </div>`;
        }).join('');
}

function openMemoDetail(clientName) {
    const range = _getMemoViewRange();
    _memoDetailClient = clientName;

    const ords = (orders || [])
        .filter(o => {
            if (o.clientName !== clientName || !o.note || !o.note.trim()) return false;
            if (range.dates) return range.dates.includes(o.date);
            return o.date >= range.start && o.date <= range.end;
        })
        .sort((a, b) => (b.date||"").localeCompare(a.date||""));

    document.getElementById('memoDetailTitle').textContent = `📋 ${clientName}`;
    document.getElementById('memoDetailPeriodLabel').textContent = range.label;

    document.getElementById('memoDetailList').innerHTML = ords.length
        ? ords.map(o => {
            const paidBadge = o.isPaid ? '✅ 완납' : '🔴 미수';
            const amount    = o.total ? `${o.total.toLocaleString()}원 · ${paidBadge}` : '';
            return `<div class="memo-detail-item" id="mdi-${o.id}">
                <div class="memo-detail-header">
                    <div class="memo-detail-date">📅 ${o.date}</div>
                    <button class="memo-delete-btn" onclick="deleteMemoById('${o.id}')" title="메모 삭제">🗑️</button>
                </div>
                <div class="memo-detail-text">${escapeHtml(o.note)}</div>
                ${amount ? `<div class="memo-detail-amount">${amount}</div>` : ''}
            </div>`;
        }).join('')
        : `<div style="text-align:center;padding:36px 0;color:var(--text3);font-size:14px;">📭 메모가 없습니다</div>`;

    document.getElementById('memoDetailPopup').classList.add('open');
    if (!_modalHistoryPushed) { history.pushState({ modalOpen: true }, ''); _modalHistoryPushed = true; }
}

async function deletePrevMemo(orderId) {
    const o = orders.find(x => x.id === orderId);
    if (!o || !o.note) return;
    if (!await customConfirm(`📅 ${o.date} 이전 메모를 삭제할까요?\n\n"${o.note}"`)) return;
    o.note = '';
    o.updatedAt = new Date().toISOString();
    _saveAndFlush();
    renderOrders();
    toast('🗑️ 이전 메모 삭제됨', 'var(--text3)');
}

async function deleteMemoById(orderId) {
    const o = orders.find(x => x.id === orderId);
    if (!o) return;
    if (!await customConfirm(`📅 ${o.date} 메모를 삭제할까요?\n\n"${o.note}"`)) return;

    o.note = '';
    o.updatedAt = new Date().toISOString();
    _saveAndFlush();
    toast('🗑️ 메모 삭제됨', 'var(--text3)');

    // 현재 항목 제거 (애니메이션)
    const el = document.getElementById(`mdi-${orderId}`);
    if (el) {
        el.style.transition = 'opacity .25s, max-height .3s';
        el.style.opacity = '0';
        el.style.overflow = 'hidden';
        el.style.maxHeight = el.offsetHeight + 'px';
        setTimeout(() => { el.style.maxHeight = '0'; el.style.marginBottom = '0'; }, 10);
        setTimeout(() => {
            el.remove();
            // 남은 항목 없으면 목록 탭에도 반영
            const list = document.getElementById('memoDetailList');
            if (!list.querySelector('.memo-detail-item')) {
                list.innerHTML = `<div style="text-align:center;padding:36px 0;color:var(--text3);font-size:14px;">📭 메모가 없습니다</div>`;
                // 메모 목록 뷰도 갱신
                renderMemoView();
            }
        }, 320);
    }

    // 납품 내역 카드 메모 버튼도 갱신
    renderOrders();
}

function closeMemoDetail() {
    document.getElementById('memoDetailPopup').classList.remove('open');
}

// 메모 팝업
// ═══════════════════════════════════════
let _memoTargetId = null;

function openMemoPopup(orderId) {
    const o = orders.find(x => x.id === orderId);
    if (!o) return;
    _memoTargetId = orderId;
    document.getElementById('memoPopupClient').textContent = o.clientName || '';
    document.getElementById('memoTextarea').value = o.note || '';
    document.getElementById('memoPopup').classList.add('open');
    setTimeout(() => document.getElementById('memoTextarea').focus(), 120);
}
function closeMemoPopup() {
    document.getElementById('memoPopup').classList.remove('open');
    _memoTargetId = null;
}
function saveMemoPopup() {
    if (!_memoTargetId) return;
    const o = orders.find(x => x.id === _memoTargetId);
    if (!o) return;
    const text = document.getElementById('memoTextarea').value.trim();
    o.note = text;
    o.updatedAt = new Date().toISOString();
    _saveAndFlush();
    closeMemoPopup();
    renderOrders();
    toast(text ? '📝 메모 저장됨' : '🗑️ 메모 삭제됨', 'var(--accent)');
}

// ═══ 거래처 카드 툴팁 토글 ═══
function toggleClientTooltip(e, card) {
    // 버튼(수정/삭제/전화/납품) 클릭 시 툴팁 무시
    if (e.target.closest('button,a')) return;
    const tooltip = card.querySelector('.client-tooltip');
    if (!tooltip) return;
    // 다른 열린 툴팁 먼저 닫기
    document.querySelectorAll('.client-card.show-tooltip').forEach(el => {
        if (el !== card) el.classList.remove('show-tooltip');
    });
    card.classList.toggle('show-tooltip');
    e.stopPropagation();
}
// 외부 클릭 시 툴팁 닫기

// ─── 핀치줌 / 더블탭 줌 완전 차단 ───
// (Android Chrome은 viewport user-scalable=no를 무시하므로 JS로 강제 차단)
(function preventZoom() {
    // 핀치줌 차단 (멀티터치)
    document.addEventListener('touchstart', e => {
        if (e.touches.length > 1) e.preventDefault();
    }, { passive: false });

    // 더블탭 줌 차단
    let _lastTap = 0;
    document.addEventListener('touchend', e => {
        const now = Date.now();
        if (now - _lastTap < 300) e.preventDefault();
        _lastTap = now;
    }, { passive: false });

    // gesturestart 차단 (iOS Safari 핀치줌)
    document.addEventListener('gesturestart', e => e.preventDefault(), { passive: false });

    // Ctrl+휠 줌 차단 (데스크탑/키보드 연결 시)
    document.addEventListener('wheel', e => {
        if (e.ctrlKey) e.preventDefault();
    }, { passive: false });
})();

// ─── 앱 종료/백그라운드 시 즉시 강제 동기화 ───
// 자주 껐다 켜는 환경에서 debounce 대기 중 종료로 인한 데이터 유실 방지
function _flushSync() {
    if (!workspaceRef || !isConnected) return;
    const ch = dataHash(clients);
    const oh = dataHash(orders);
    const ph = dataHash(prices);
    const sh = dataHash(stockItems);
    let changed = false;
    const updates = {};
    if (ch !== lastHash.clients) { updates.clients    = clients.map(_minifyClient); changed = true; }
    if (oh !== lastHash.orders)  {
        // flushSync는 항상 full map (비상 저장 — delta 미사용)
        const ordersMap = {};
        orders.forEach(o => { ordersMap[o.id] = _minifyOrder(o); });
        updates.orders = ordersMap;
        _clearOrderDelta();
        changed = true;
    }
    if (ph !== lastHash.prices)  { updates.prices     = prices;     changed = true; }
    if (sh !== lastHash.stock)   { updates.stockItems = _getLightStock(); changed = true; }
    if (!changed) return;
    updates.lastUpdated = new Date().toISOString();
    updates.writtenBy   = SESSION_ID;
    if (updates.clients)    lastHash.clients = ch;
    if (updates.orders)     lastHash.orders  = oh;
    if (updates.prices)     lastHash.prices  = ph;
    if (updates.stockItems) lastHash.stock   = sh;
    debouncedSync.cancel(); // 대기 중인 debounce 취소 (중복 방지)
    workspaceRef.update(updates).then(() => {
        localStorage.setItem('lastLocalUpdated', updates.lastUpdated);
    }).catch(() => {
        // 롤백 — 다음 실행 시 재시도
        if (updates.clients)    lastHash.clients = '';
        if (updates.orders)     lastHash.orders  = '';
        if (updates.prices)     lastHash.prices  = '';
        if (updates.stockItems) lastHash.stock   = '';
    });
}

// 화면 꺼짐 / 다른 앱으로 전환 시
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') _flushSync();
});

// 브라우저 탭 닫기 / PWA 종료 시
window.addEventListener('pagehide', _flushSync);
