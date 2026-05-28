document.getElementById('btnPlay').addEventListener('click', togglePlay);
document.getElementById('volSlider').addEventListener('input', function() {
  handleVolume(this.value);
});
document.querySelectorAll('.tab-btn').forEach(b =>
  b.addEventListener('click', () => switchTab(b.dataset.tab))
);

mergeCustomStations();
applyFavLock();
_updateAccountBtn(); // ★ 계정 버튼 초기 상태
handleVolume(S.volume);

// 업데이트 토스트
(function checkUpdate() {
  const lastSeen = localStorage.getItem('radio_seen_version');
  if (lastSeen && lastSeen !== APP_VERSION) {
    const latest  = CHANGELOG[0];
    const summary = latest.changes.slice(0, 2).join(', ');
    setTimeout(() => showToast(`🆕 ${APP_VERSION} 업데이트: ${summary}`), 1500);
  }
  localStorage.setItem('radio_seen_version', APP_VERSION);
})();

// 1. 즉시 렌더링
updateFavCount();
renderAllList();
updateFavList();

// 2. 마지막 방송국 즉시 복원
// PWA 바로가기(?autoplay=id) 우선, 없으면 마지막 채널 복원
const _autoplayId = parseInt(new URLSearchParams(location.search).get('autoplay'));
const _lastId = _autoplayId || parseInt(localStorage.getItem('radio_last'));
if (_lastId) {
  S.current = STATIONS.find(s => s.id === _lastId) || null;
  if (S.current) {
    updateNowPlaying(); renderStations();
    if (localStorage.getItem('radio_playing') === '1') {
      playStation(S.current);
      const resumeOnGesture = () => {
        if (!S.playing && !S.loading && S.current) playStation(S.current);
        document.removeEventListener('touchstart', resumeOnGesture);
        document.removeEventListener('click', resumeOnGesture);
      };
      document.addEventListener('touchstart', resumeOnGesture, { once: true, passive: true });
      document.addEventListener('click', resumeOnGesture, { once: true, passive: true }); // ★ passive 추가
    }
  }
}

// 3. Firebase/IndexedDB 복원 — 백그라운드
(async function initData() {
  // ★ Firebase를 최우선으로 초기화 — 사용자가 즉시 계정 모달을 열어도 동작하도록
  try {
    if (!fbReady) {
      firebase.initializeApp(FB_CONFIG);
      fbDb    = firebase.database();
      fbReady = true;
    }
  } catch(e) {
    console.warn('Firebase 사전 초기화 실패:', e);
  }

  // ★ localStorage가 비어있으면(인터넷 기록 삭제 등) 반드시 IndexedDB 먼저 복원
  const localFavs   = localStorage.getItem('radio_favs');
  const localLocked = localStorage.getItem('radio_fav_locked');
  if (!localFavs || localLocked === null) {
    await restoreFromIDB().catch(() => {});
  }

  try {
    await initUserData();

    // ★ 계정 ID 복원: localStorage → IDB → 쿠키 순으로 확인 후 Firebase에서 데이터 로드
    if (!_accountId) {
      // IDB에서 계정 ID 확인
      const savedId  = await idbGet('radio_account_id').catch(() => null);
      const savedPin = await idbGet('radio_account_pin').catch(() => '');
      let   restoredId  = savedId  || '';
      let   restoredPin = savedPin || '';

      // IDB도 없으면 쿠키에서 확인
      if (!restoredId) {
        try {
          const m = document.cookie.match(/(?:^|;\s*)kr_radio_acct=([^;]+)/);
          if (m) {
            const parts = decodeURIComponent(m[1]).split('|');
            restoredId  = parts[0] || '';
            restoredPin = parts[1] || '';
          }
        } catch(e) {}
      }

      if (restoredId) {
        try {
          const snap = await fbDb.ref(`accounts/${restoredId}`).once('value');
          if (snap.exists()) {
            _setAccount(restoredId, restoredPin);
            _restoreFromAccount(snap.val());
            console.info(`[계정] "${restoredId}" 자동 복원 완료`);
          }
        } catch(e) { console.warn('[계정] 자동 복원 실패:', e); }
      }
    }
  } catch(e) {
    console.warn('Firebase 데이터 복원 실패:', e);
    // Firebase 실패 시 IndexedDB로만 복원
    if (!localFavs) await restoreFromIDB().catch(() => {});
  }
  updateFavCount();
  updateFavList();
  applyFavLock();

  // ★ 로그 시스템 초기화 — IDB에서 기존 로그 로드
  RLog.load().then(() => {
    RLog.info('앱 시작', `v${APP_VERSION}`);
  });
})();
