/* ══ firebase.js ══ */
/* ════════════════════════════════════════
   IndexedDB 백업
   localStorage 삭제 시에도 IndexedDB에서 복원
════════════════════════════════════════ */
const DB_NAME    = 'kr-radio-db';
const DB_VERSION = 1;
const DB_STORE   = 'settings';

let _idbInstance = null; // ★ 싱글턴 — 매 호출마다 새 커넥션 생성 방지

function openDB() {
  if (_idbInstance) return Promise.resolve(_idbInstance);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore(DB_STORE, { keyPath: 'key' });
    };
    req.onsuccess = e => { _idbInstance = e.target.result; resolve(_idbInstance); };
    req.onerror   = e => reject(e.target.error);
  });
}

async function idbSet(key, value) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(DB_STORE, 'readwrite');
      const st  = tx.objectStore(DB_STORE);
      st.put({ key, value });
      tx.oncomplete = () => resolve();
      tx.onerror    = e => reject(e.target.error);
    });
  } catch(e) { console.warn('IndexedDB 저장 실패:', e); }
}

async function idbGet(key) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(DB_STORE, 'readonly');
      const req = tx.objectStore(DB_STORE).get(key);
      req.onsuccess = e => resolve(e.target.result?.value ?? null);
      req.onerror   = e => reject(e.target.error);
    });
  } catch(e) { return null; }
}

async function saveProtected(key, value) {
  try { localStorage.setItem(key, value); } catch(e) {}
  await idbSet(key, value);
}

async function loadProtected(key) {
  const local = localStorage.getItem(key);
  if (local !== null) return local;
  const idb = await idbGet(key);
  if (idb !== null) {
    try { localStorage.setItem(key, idb); } catch(e) {}
    console.info(`[복원] ${key} → IndexedDB에서 복구됨`);
  }
  return idb;
}

async function restoreFromIDB() {
  const favs = await loadProtected('radio_favs');
  if (favs) {
    try {
      const parsed = JSON.parse(favs);
      if (Array.isArray(parsed)) {
        S.favorites = new Set(parsed);
        updateFavCount(); renderAllList(); updateFavList();
      }
    } catch(e) {}
  }

  const locked = await loadProtected('radio_fav_locked');
  if (locked !== null) {
    favLocked = locked === '1';
    applyFavLock();
  }

  const custom = await loadProtected('radio_custom_stations');
  if (custom) {
    try {
      const parsed = JSON.parse(custom);
      if (Array.isArray(parsed)) {
        parsed.forEach(s => {
          if (!STATIONS.find(x => x.id === s.id)) STATIONS.push(s);
        });
        renderAllList();
      }
    } catch(e) {}
  }
}

/* ════════════════════════════════════════
   사용자 UUID — IndexedDB에만 저장
   인터넷 기록 삭제 후에도 유지됨
════════════════════════════════════════ */
let _userUUID = null;

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

/* ──────────────────────────────────────
   UUID 쿠키 헬퍼
   인터넷 기록 삭제(방문기록+캐시)로는 쿠키가 지워지지 않으므로
   UUID를 쿠키에도 백업해 IndexedDB 소실에 대비
─────────────────────────────────────── */
function setCookieUUID(uuid) {
  try {
    // 10년 유효기간
    const expires = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000).toUTCString();
    document.cookie = `kr_radio_uuid=${uuid}; expires=${expires}; path=/; SameSite=Lax`;
  } catch(e) {}
}

function getCookieUUID() {
  try {
    const m = document.cookie.match(/(?:^|;\s*)kr_radio_uuid=([^;]+)/);
    return m ? m[1] : null;
  } catch(e) { return null; }
}

async function getUserUUID() {
  if (_userUUID) return _userUUID;

  // 1순위: IndexedDB
  let uuid = await idbGet('user_uuid');

  // 2순위: 쿠키 (IDB가 지워진 경우 복원)
  if (!uuid) {
    uuid = getCookieUUID();
    if (uuid) {
      await idbSet('user_uuid', uuid);
      console.info('[UUID] 쿠키에서 복원 → IndexedDB 재저장:', uuid);
    }
  }

  // 없으면 신규 생성 후 양쪽에 저장
  if (!uuid) {
    uuid = generateUUID();
    await idbSet('user_uuid', uuid);
    console.info('[UUID] 새 UUID 생성:', uuid);
  } else {
    console.info('[UUID] 복원 완료:', uuid);
  }

  // 항상 쿠키에도 동기화
  setCookieUUID(uuid);

  _userUUID = uuid;
  return uuid;
}

/* ════════════════════════════════════════
   Firebase 설정 및 상태
════════════════════════════════════════ */
const FB_CONFIG = {
  apiKey:            'AIzaSyBma41vUE5uNmz_klRxK2B-jtKvcHQRbxI',
  authDomain:        'my-kr-radio.firebaseapp.com',
  databaseURL:       'https://my-kr-radio-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId:         'my-kr-radio',
  storageBucket:     'my-kr-radio.firebasestorage.app',
  messagingSenderId: '995302347935',
  appId:             '1:995302347935:web:c8348fe1bbaabc9c96beaa'
};

let fbDb       = null;
let fbReady    = false;
let fbListener = null;
let syncMode   = false;
let myNick     = localStorage.getItem('radio_nick') || '';
let _fbIgnore  = 0; // ★ boolean → 타임스탬프로 변경: 300ms 이내 이벤트만 무시

function initFirebase() {
  if (fbReady) return;
  try {
    firebase.initializeApp(FB_CONFIG);
    fbDb    = firebase.database();
    fbReady = true;
    initUserData();
  } catch(e) {
    console.warn('Firebase 초기화 실패:', e);
    restoreFromIDB();
  }
}

/* ════════════════════════════════════════
   Firebase 사용자 데이터 동기화
════════════════════════════════════════ */
async function fbSaveUserData() {
  if (!fbReady || !fbDb) return;
  try {
    const uuid = await getUserUUID();
    await fbDb.ref(`users/${uuid}`).set({
      favorites:      [...S.favorites],
      favLocked:      favLocked,
      customStations: JSON.parse(localStorage.getItem('radio_custom_stations') || '[]'),
      updatedAt:      Date.now(),
    });
  } catch(e) { console.warn('Firebase 사용자 데이터 저장 실패:', e); }
}

async function fbLoadUserData() {
  if (!fbReady || !fbDb) return false;
  try {
    const uuid = await getUserUUID();
    const snap = await fbDb.ref(`users/${uuid}`).once('value');
    const data = snap.val();
    if (!data) return false;

    if (Array.isArray(data.favorites) && data.favorites.length > 0) {
      S.favorites = new Set(data.favorites);
      // ★ saveFav() 대신 직접 저장 — Firebase 복원 데이터를 다시 Firebase로 쓰는 불필요한 루프 방지
      try { localStorage.setItem('radio_favs', JSON.stringify([...S.favorites])); } catch(e) {}
      idbSet('radio_favs', JSON.stringify([...S.favorites])).catch(() => {});
      updateFavCount(); renderAllList(); updateFavList();
    }

    if (typeof data.favLocked === 'boolean') {
      favLocked = data.favLocked;
      const lockVal = favLocked ? '1' : '0';
      try { localStorage.setItem('radio_fav_locked', lockVal); } catch(e) {}
      await idbSet('radio_fav_locked', lockVal);
      applyFavLock();
    }

    if (Array.isArray(data.customStations) && data.customStations.length > 0) {
      const existing = JSON.parse(localStorage.getItem('radio_custom_stations') || '[]');
      const merged = [...existing];
      data.customStations.forEach(s => {
        if (!merged.find(x => x.id === s.id)) merged.push(s);
      });
      saveCustomStations(merged);
      merged.forEach(s => {
        if (!STATIONS.find(x => x.id === s.id)) STATIONS.push(s);
      });
      renderAllList();
    }

    console.info('[Firebase] 사용자 데이터 복원 완료');
    return true;
  } catch(e) {
    console.warn('Firebase 사용자 데이터 불러오기 실패:', e);
    return false;
  }
}

async function initUserData() {
  const fbRestored = await fbLoadUserData();
  if (!fbRestored) await restoreFromIDB();
  console.info('[초기화] 사용자 데이터 로드 완료');
}

/* ════════════════════════════════════════
   계정 관리 (ID 기반 즐겨찾기 클라우드 백업)
   — 인터넷 기록 삭제 후에도 로그인으로 복원 가능
════════════════════════════════════════ */
let _accountId  = localStorage.getItem('radio_account_id')  || null;
let _accountPin = localStorage.getItem('radio_account_pin') || '';
let _accTab     = 'login'; // 'login' | 'register'

/* 계정 데이터를 Firebase 계정 경로에 저장 */
async function saveAccountData() {
  if (!_accountId || !fbReady || !fbDb) return;
  try {
    await fbDb.ref(`accounts/${_accountId}`).update({
      pin:            _accountPin,
      favorites:      [...S.favorites],
      favLocked:      favLocked,
      customStations: JSON.parse(localStorage.getItem('radio_custom_stations') || '[]'),
      updatedAt:      Date.now(),
    });
  } catch(e) { console.warn('[계정] 저장 실패:', e); }
}

/* Firebase 계정 데이터로 로컬 상태 복원 */
function _restoreFromAccount(data) {
  if (Array.isArray(data.favorites)) {
    S.favorites = new Set(data.favorites);
    saveProtected('radio_favs', JSON.stringify([...S.favorites])).catch(() => {});
    updateFavCount(); renderAllList(); updateFavList();
  }
  if (typeof data.favLocked === 'boolean') {
    favLocked = data.favLocked;
    saveProtected('radio_fav_locked', favLocked ? '1' : '0').catch(() => {});
    applyFavLock();
  }
  if (Array.isArray(data.customStations) && data.customStations.length > 0) {
    const existing = loadCustomStations();
    const merged   = [...existing];
    data.customStations.forEach(s => {
      if (!merged.find(x => x.id === s.id)) merged.push(s);
    });
    saveCustomStations(merged);
    merged.forEach(s => {
      if (!STATIONS.find(x => x.id === s.id)) STATIONS.push(s);
    });
    renderAllList();
  }
}

/* 계정 상태를 로컬에 저장 + 버튼 UI 갱신 */
function _setAccount(id, pin) {
  _accountId  = id;
  _accountPin = pin;
  try { localStorage.setItem('radio_account_id',  id);  } catch(e) {}
  try { localStorage.setItem('radio_account_pin', pin); } catch(e) {}
  idbSet('radio_account_id',  id).catch(() => {});
  idbSet('radio_account_pin', pin).catch(() => {});
  // 쿠키에도 백업 (IDB+localStorage 동시 삭제 대비)
  try {
    const exp = new Date(Date.now() + 10 * 365 * 86400000).toUTCString();
    document.cookie = `kr_radio_acct=${encodeURIComponent(id)}|${encodeURIComponent(pin)}; expires=${exp}; path=/; SameSite=Lax`;
  } catch(e) {}
  _updateAccountBtn();
}

/* 헤더 버튼 UI 갱신 */
function _updateAccountBtn() {
  const btn = document.getElementById('accountBtn');
  if (!btn) return;
  if (_accountId) {
    btn.classList.add('logged-in');
    btn.innerHTML = `👤 <span class="acc-name">${esc(_accountId)}</span>`;
    btn.title = '계정 정보';
  } else {
    btn.classList.remove('logged-in');
    btn.innerHTML = '👤';
    btn.title = '로그인 / 회원가입';
  }
}

/* 모달 열기 */
function openAccountModal() {
  const formWrap   = document.getElementById('accFormWrap');
  const loggedWrap = document.getElementById('accLoggedWrap');
  if (_accountId) {
    formWrap.style.display               = 'none';
    loggedWrap.style.display             = 'flex';
    document.getElementById('accUserName').textContent = _accountId;
  } else {
    formWrap.style.display               = 'flex';
    loggedWrap.style.display             = 'none';
    document.getElementById('acc-id').value  = '';
    document.getElementById('acc-pin').value = '';
    switchAccountTab('login');
    setTimeout(() => document.getElementById('acc-id').focus(), 120);
  }
  document.getElementById('accountModalBg').classList.add('show');
}

/* 모달 닫기 */
function closeAccountModal(e) {
  if (e && e.target !== document.getElementById('accountModalBg')) return;
  document.getElementById('accountModalBg').classList.remove('show');
}

/* 탭 전환 */
function switchAccountTab(tab) {
  _accTab = tab;
  document.getElementById('accTabLogin').classList.toggle('active',    tab === 'login');
  document.getElementById('accTabRegister').classList.toggle('active', tab === 'register');
  document.getElementById('accConfirmBtn').textContent = tab === 'login' ? '로그인' : '회원가입';
  document.getElementById('accHint').innerHTML =
    tab === 'login'
      ? '아이디를 기억해두면 인터넷 기록을 삭제해도<br>어느 기기에서든 즐겨찾기를 복원할 수 있습니다.'
      : '새 계정을 만들면 현재 즐겨찾기가 클라우드에<br>저장되고 어디서든 복원할 수 있습니다.';
}

/* 로그인 또는 회원가입 실행 */
async function doAccountAction() {
  // Firebase가 아직 준비 안 됐으면 직접 초기화 시도
  // (페이지 로드 직후 모달을 빠르게 열었을 때 대비)
  if (!fbReady || !fbDb) {
    try {
      try { firebase.initializeApp(FB_CONFIG); } catch(e) {} // 이미 초기화됐으면 무시
      fbDb    = firebase.database();
      fbReady = true;
    } catch(e) {
      showToast('⚠️ Firebase에 연결할 수 없습니다.'); return;
    }
  }

  const id  = document.getElementById('acc-id').value.trim().toLowerCase();
  const pin = document.getElementById('acc-pin').value.trim();

  if (!id || id.length < 3) {
    showToast('⚠️ 아이디를 3자 이상 입력해주세요.'); return;
  }
  if (id.length > 12 || !/^[a-z0-9_\-가-힣]+$/.test(id)) {
    showToast('⚠️ 아이디는 영문·숫자·한글·_·- 만 사용 가능합니다.'); return;
  }
  if (pin && !/^\d{4}$/.test(pin)) {
    showToast('⚠️ PIN은 숫자 4자리로 입력해주세요.'); return;
  }

  if (_accTab === 'register') await _doRegister(id, pin);
  else                          await _doLogin(id, pin);
}

async function _doRegister(id, pin) {
  try {
    const snap = await fbDb.ref(`accounts/${id}`).once('value');
    if (snap.exists()) {
      showToast('⚠️ 이미 사용 중인 아이디입니다.'); return;
    }
    await fbDb.ref(`accounts/${id}`).set({
      pin,
      favorites:      [...S.favorites],
      favLocked:      favLocked,
      customStations: JSON.parse(localStorage.getItem('radio_custom_stations') || '[]'),
      updatedAt:      Date.now(),
    });
    _setAccount(id, pin);
    closeAccountModal();
    showToast(`✅ "${id}" 계정이 생성됐습니다`);
  } catch(e) {
    console.error('[계정] 등록 실패:', e);
    if (e && e.code === 'PERMISSION_DENIED') {
      showToast('⚠️ Firebase 규칙 오류: accounts 경로 쓰기 권한이 없습니다');
    } else {
      showToast(`⚠️ 등록 실패: ${e?.message || e}`);
    }
  }
}

async function _doLogin(id, pin) {
  try {
    const snap = await fbDb.ref(`accounts/${id}`).once('value');
    if (!snap.exists()) {
      showToast('⚠️ 존재하지 않는 아이디입니다.'); return;
    }
    const data = snap.val();
    if (data.pin && data.pin !== pin) {
      showToast('⚠️ PIN 번호가 올바르지 않습니다.'); return;
    }
    _setAccount(id, pin);
    _restoreFromAccount(data);
    closeAccountModal();
    showToast(`🔓 "${id}" 계정으로 로그인됐습니다`);
  } catch(e) {
    console.error('[계정] 로그인 실패:', e);
    if (e && e.code === 'PERMISSION_DENIED') {
      showToast('⚠️ Firebase 규칙 오류: accounts 경로 읽기 권한이 없습니다');
    } else {
      showToast(`⚠️ 로그인 실패: ${e?.message || e}`);
    }
  }
}

function doLogout() {
  _accountId  = null;
  _accountPin = '';
  try { localStorage.removeItem('radio_account_id');  } catch(e) {}
  try { localStorage.removeItem('radio_account_pin'); } catch(e) {}
  idbSet('radio_account_id',  '').catch(() => {});
  idbSet('radio_account_pin', '').catch(() => {});
  try { document.cookie = 'kr_radio_acct=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'; } catch(e) {}
  _updateAccountBtn();
  closeAccountModal();
  showToast('로그아웃됐습니다');
}

/* ════════════════════════════════════════
   함께 듣기 (실시간 채널 동기화)
════════════════════════════════════════ */
function startSync() {
  if (!fbReady) return;
  fbListener = fbDb.ref('shared/station').on('value', snap => {
    const data = snap.val();
    if (!data) return;
    // ★ 타임스탬프 기반 무시 — 이 기기가 300ms 이내에 쓴 이벤트만 스킵
    // boolean 방식은 타이밍에 따라 다른 사용자 이벤트를 잘못 무시할 수 있음
    if (Date.now() - _fbIgnore < 300) return;
    const s = STATIONS.find(x => x.id === data.id);
    if (!s || (S.current && S.current.id === s.id)) return;
    if (data.nick === myNick) return;
    playStation(s, true);
    showToast(`📻 ${data.nick || '누군가'}님이 ${s.name}으로 변경했습니다`);
  });
}

function stopSync() {
  if (fbDb && fbListener) {
    fbDb.ref('shared/station').off('value', fbListener);
    fbListener = null;
  }
}

function toggleSync() {
  if (syncMode) {
    syncMode = false; stopSync();
    document.getElementById('syncBtn').classList.remove('on');
    showToast('함께 듣기가 종료되었습니다');
  } else {
    if (myNick) confirmSync();
    else {
      document.getElementById('nickModalBg').classList.add('show');
      setTimeout(() => document.getElementById('nickInput').focus(), 100);
    }
  }
}

function closeNickModal() {
  document.getElementById('nickModalBg').classList.remove('show');
}

function confirmSync() {
  stopSync();
  const inp = document.getElementById('nickInput').value.trim();
  if (inp) { myNick = inp; localStorage.setItem('radio_nick', myNick); }
  if (!myNick) myNick = '익명';
  closeNickModal();
  initFirebase();
  if (!fbReady) { showToast('⚠️ Firebase 연결에 실패했습니다'); return; }
  syncMode = true;
  document.getElementById('syncBtn').classList.add('on');
  startSync();
  showToast(`🔗 함께 듣기 시작 (${myNick})`);
}

document.getElementById('nickInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') confirmSync();
});
