/* ══ ui.js ══ */
/* 뷰포트 높이 동기화 — 스크롤 분리 방식으로 변경되어 불필요 (no-op 유지) */
function syncViewportHeight() {
  const vp = document.getElementById('swipeViewport');
  if (!vp) return;
  const panels = vp.querySelectorAll('.swipe-panel');
  const idx    = S.activeTab === 'all' ? 0 : 1;
  const target = panels[idx];
  if (target) {
    // 콘텐츠 높이만큼만 설정 → 빈 영역 터치/스크롤 방지
    vp.style.height = target.scrollHeight + 'px';
  }
}

/* ════════════════════════════════════════
   탭 전환
════════════════════════════════════════ */
function switchTab(tab) {
  if (S.activeTab === tab) return;
  S.activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab)
  );
  const track = document.getElementById('swipeTrack');
  track.style.transform = tab === 'all' ? 'translateX(0%)' : 'translateX(-50%)';
  const label = document.getElementById('ch-label');
  if (label) label.textContent = tab === 'all' ? '전체 채널' : '⭐ 즐겨찾기';
  syncViewportHeight(); // ★ 탭 전환 시 높이 동기화
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ════════════════════════════════════════
   즐겨찾기
════════════════════════════════════════ */
function saveFav() {
  const data = JSON.stringify([...S.favorites]);
  // ★ saveProtected: localStorage + IndexedDB 동시 저장 (인터넷 기록 삭제 대비)
  saveProtected('radio_favs', data).catch(() => {
    showToast('⚠️ 즐겨찾기 저장에 실패했습니다.');
  });
  fbSaveUserData();
  saveAccountData(); // ★ 계정 클라우드 백업
}

function toggleFav(id, e) {
  e.stopPropagation();
  if (favLocked) { showToast('🔒 즐겨찾기가 잠겨있습니다.'); return; }
  if (S.favorites.has(id)) S.favorites.delete(id);
  else                      S.favorites.add(id);
  saveFav();
  updateFavCount();
  document.querySelectorAll(`.s-fav-btn[data-id="${id}"]`).forEach(btn => {
    btn.textContent = S.favorites.has(id) ? '★' : '☆';
    btn.classList.toggle('on', S.favorites.has(id));
  });
  updateFavList();
}

function updateFavCount() {
  const el = document.getElementById('fav-count');
  if (el) el.textContent = S.favorites.size > 0 ? `(${S.favorites.size})` : '';
}

function updateEmptyState() {
  const empty = document.getElementById('fav-empty');
  if (!empty) return;
  const hasFav = [...S.favorites].some(id => STATIONS.find(s => s.id === id));
  empty.style.display = hasFav ? 'none' : 'block';
}

/* ════════════════════════════════════════
   채널 카드
════════════════════════════════════════ */
function createCard(s) {
  const isActive = S.current && S.current.id === s.id;
  const isFav    = S.favorites.has(s.id);
  const freqShort = s.freq.replace(' MHz','').replace(' ','');
  const div = document.createElement('div');
  div.className = `station-card${isActive ? ' active' : ''}`;
  div.dataset.id = s.id;
  div.innerHTML = `
    <div class="st-badge" style="background:${s.color}22;color:${s.color}">
      ${esc(freqShort)}
    </div>
    <div class="st-info">
      <div class="st-name">
        ${esc(s.name)}${s.custom ? '<span class="custom-station-badge">MY</span>' : ''}
      </div>
      <div class="st-desc">${esc(s.genre)}</div>
    </div>
    <div class="st-freq">${esc(s.freq)}</div>
    <div class="live-dot"></div>
    <button class="s-fav-btn${isFav?' on':''}" data-id="${s.id}" aria-label="즐겨찾기">
      ${isFav ? '★' : '☆'}
    </button>
    ${s.custom ? `<button class="st-delete-btn" data-id="${s.id}" aria-label="삭제">✕</button>` : ''}
  `;
  div.addEventListener('click', () => {
    if (S.current && S.current.id === s.id && !S.loading) togglePlay();
    else playStation(s, true);
  });
  div.querySelector('.s-fav-btn').addEventListener('click', e => toggleFav(s.id, e));
  if (s.custom) {
    div.querySelector('.st-delete-btn').addEventListener('click', e => deleteCustomStation(s.id, e));
  }
  return div;
}

function renderAllList() {
  const list = document.getElementById('list-all');
  if (!list) return;
  list.innerHTML = '';
  STATIONS.forEach(s => list.appendChild(createCard(s)));
  syncViewportHeight(); // ★
}

function updateFavList() {
  const list = document.getElementById('list-fav');
  if (!list) return;
  list.innerHTML = '';
  STATIONS.filter(s => S.favorites.has(s.id)).forEach(s => list.appendChild(createCard(s)));
  updateEmptyState();
  syncViewportHeight(); // ★
}

function renderStations() {
  renderAllList();
  updateFavList();
}

/* ════════════════════════════════════════
   Now Playing 패널
════════════════════════════════════════ */
function updateNowPlaying() {
  const np     = document.getElementById('nowPlaying');
  const wave   = document.getElementById('waveform');
  const btnSvg = document.getElementById('iconPlay');
  const status = document.getElementById('npStatus');
  const spin   = document.getElementById('spinner');

  document.getElementById('npStation').textContent =
    S.current ? S.current.name : '채널을 선택하세요';
  document.getElementById('npFreq').textContent =
    S.current ? `${S.current.freq} · ${S.current.genre}` : '—';

  if (S.current && S.current.color) {
    // ★ 채널 색상은 패널 배경에만 적용 — --red(재생버튼/UI)는 항상 고정
    const hex = S.current.color;
    const r = parseInt(hex.slice(1,3),16);
    const g = parseInt(hex.slice(3,5),16);
    const b = parseInt(hex.slice(5,7),16);
    np.style.setProperty('--station-glow', `rgba(${r},${g},${b},0.45)`);
  } else {
    np.style.removeProperty('--station-glow');
  }

  if (S.loading) {
    wave.className = 'waveform paused';
    spin.style.display = 'block';
    btnSvg.innerHTML = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
    status.className = 'np-status';
    status.textContent = '연결 중...';
  } else if (S.playing) {
    wave.className = 'waveform playing';
    spin.style.display = 'none';
    btnSvg.innerHTML = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
    status.className = 'np-status live';
    status.textContent = '● LIVE';
  } else {
    wave.className = 'waveform paused';
    spin.style.display = 'none';
    btnSvg.innerHTML = '<path d="M8 5v14l11-7z"/>';
    status.className = 'np-status';
    status.textContent = S.current ? '일시정지' : '재생 중인 채널이 없습니다';
  }

  // 슬라이더 색상 갱신
  handleVolume(S.volume);
}

/* ════════════════════════════════════════
   토스트
════════════════════════════════════════ */
let _toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

/* ════════════════════════════════════════
   테마
════════════════════════════════════════ */
function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(next); localStorage.setItem('radio_theme', next);
}
function applyTheme(theme) {
  if (theme === 'light') {
    document.documentElement.dataset.theme = 'light';
    document.getElementById('themeBtn').textContent = '☀️';
  } else {
    delete document.documentElement.dataset.theme;
    document.getElementById('themeBtn').textContent = '🌙';
  }
}
applyTheme(localStorage.getItem('radio_theme') || 'dark');

/* ════════════════════════════════════════
   PWA
════════════════════════════════════════ */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => {
        console.log('[SW]', reg.scope);
        // 새 SW 대기 중이면 업데이트 토스트 표시
        reg.addEventListener('updatefound', () => {
          const newSW = reg.installing;
          newSW.addEventListener('statechange', () => {
            if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
              showToast('🔄 새 버전이 준비됐습니다. 앱을 다시 시작해주세요.');
            }
          });
        });
      })
      .catch(e => console.warn('[SW] 실패:', e));
  });
}
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); deferredPrompt = e;
  document.getElementById('installBtn').style.display = 'flex';
});
window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  document.getElementById('installBtn').style.display = 'none';
});
function installApp() {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  deferredPrompt.userChoice.then(() => { deferredPrompt = null; });
}

/* ════════════════════════════════════════
   뒤로가기 — 항상 백그라운드 유지
════════════════════════════════════════ */
(function initBackHandler() {
  history.pushState({ page: 'radio' }, '', location.href);
  history.pushState({ page: 'radio' }, '', location.href);
  window.addEventListener('popstate', () => {
    history.pushState({ page: 'radio' }, '', location.href);
    history.pushState({ page: 'radio' }, '', location.href);
    if (S.playing || S.loading) {
      showToast('🎵 방송이 백그라운드에서 계속 재생됩니다');
    }
  });
})();

/* ════════════════════════════════════════
   즐겨찾기 잠금
════════════════════════════════════════ */
function applyFavLock() {
  const btn = document.getElementById('favLockBtn');
  if (!btn) return;
  if (favLocked) {
    btn.classList.add('locked');
    btn.innerHTML = '<span class="lock-icon">🔒</span>';
    btn.title = '즐겨찾기 잠금 해제';
  } else {
    btn.classList.remove('locked');
    btn.innerHTML = '<span class="lock-icon">🔓</span>';
    btn.title = '즐겨찾기 잠금';
  }
}

function toggleFavLock() {
  favLocked = !favLocked;
  const lockVal = favLocked ? '1' : '0';
  try { localStorage.setItem('radio_fav_locked', lockVal); } catch(e) {}
  idbSet('radio_fav_locked', lockVal);
  fbSaveUserData();
  saveAccountData(); // ★ 계정 클라우드 백업
  applyFavLock();
  showToast(favLocked ? '🔒 즐겨찾기가 잠겼습니다' : '🔓 즐겨찾기 잠금이 해제됐습니다');
}

/* ════════════════════════════════════════
   방송 추가 (커스텀 채널)
════════════════════════════════════════ */
function loadCustomStations() {
  try {
    const saved = localStorage.getItem('radio_custom_stations');
    if (!saved) return [];
    const parsed = JSON.parse(saved);
    return Array.isArray(parsed) ? parsed : [];
  } catch(e) { return []; }
}

function saveCustomStations(list) {
  const data = JSON.stringify(list);
  try { localStorage.setItem('radio_custom_stations', data); } catch(e) {
    showToast('⚠️ 저장 공간이 부족합니다.');
  }
  idbSet('radio_custom_stations', data).catch(e => // ★ 오류 무시 방지
    console.warn('[IndexedDB] 커스텀 채널 저장 실패:', e)
  );
  fbSaveUserData();
  saveAccountData();
}

function mergeCustomStations() {
  const custom = loadCustomStations();
  custom.forEach(s => {
    if (!STATIONS.find(x => x.id === s.id)) STATIONS.push(s);
  });
}

function openAddStation() {
  ['asi-name','asi-freq','asi-genre','asi-url'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('asi-color').value = '#e74c3c';
  document.getElementById('addStationBg').classList.add('show');
}

function closeAddStation(e) {
  if (e && e.target !== document.getElementById('addStationBg')) return;
  document.getElementById('addStationBg').classList.remove('show');
}

function confirmAddStation() {
  const name  = document.getElementById('asi-name').value.trim();
  const freq  = document.getElementById('asi-freq').value.trim() || '—';
  const genre = document.getElementById('asi-genre').value.trim() || '기타';
  const url   = document.getElementById('asi-url').value.trim();
  const color = document.getElementById('asi-color').value;

  if (!name) { showToast('⚠️ 방송국 이름을 입력해주세요.'); return; }
  if (!url)  { showToast('⚠️ 스트림 URL을 입력해주세요.'); return; }
  if (!url.startsWith('http')) { showToast('⚠️ URL은 http로 시작해야 합니다.'); return; }

  const custom    = loadCustomStations();
  // ★ Date.now() + 랜덤값 조합 — 빠른 연속 추가나 장기 사용 시에도 ID 충돌 방지
  const newId      = 1000000 + Math.floor(Math.random() * 900000);
  const newStation = { id: newId, name, freq, genre, color, stream: url, custom: true };

  custom.push(newStation);
  saveCustomStations(custom);
  STATIONS.push(newStation);
  renderAllList(); updateFavCount();
  closeAddStation();
  showToast(`✅ "${name}" 채널이 추가됐습니다.`);
}

function deleteCustomStation(id, e) {
  e.stopPropagation();
  const s = STATIONS.find(x => x.id === id);
  if (!s || !s.custom) return;
  if (S.current && S.current.id === id) {
    showToast('⚠️ 재생 중인 채널은 삭제할 수 없습니다.'); return;
  }
  const custom = loadCustomStations().filter(x => x.id !== id);
  saveCustomStations(custom);
  const idx = STATIONS.findIndex(x => x.id === id);
  if (idx > -1) STATIONS.splice(idx, 1);
  S.favorites.delete(id); saveFav();
  renderAllList(); updateFavCount();
  updateFavList(); // ★ 즐겨찾기 탭에서 삭제된 채널 즉시 제거
  showToast('🗑️ 채널이 삭제됐습니다.');
}

/* ════════════════════════════════════════
   변경 이력
════════════════════════════════════════ */
function openChangelog() {
  const body = document.getElementById('changelogBody');
  body.innerHTML = '';
  CHANGELOG.forEach((entry, i) => {
    const div = document.createElement('div');
    div.className = 'changelog-entry';
    div.innerHTML = `
      <div class="changelog-ver">
        <span class="changelog-ver-badge${i > 0 ? ' old' : ''}">${entry.version}</span>
        <span class="changelog-date">${entry.date}</span>
      </div>
      <div class="changelog-list">
        ${entry.changes.map(c => `<div class="changelog-item">${c}</div>`).join('')}
      </div>`;
    body.appendChild(div);
  });
  document.getElementById('changelogBg').classList.add('show');
}

function closeChangelog(e) {
  if (e && e.target !== document.getElementById('changelogBg')) return;
  document.getElementById('changelogBg').classList.remove('show');
}

/* ════════════════════════════════════════
   스와이프 제스처
════════════════════════════════════════ */
(function() {
  const vp    = document.getElementById('swipeViewport');
  const track = document.getElementById('swipeTrack');
  let sx = 0, sy = 0, st = 0, dragging = false, base = 0;

  vp.addEventListener('touchstart', e => {
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    st = Date.now(); dragging = false;
    base = S.activeTab === 'all' ? 0 : -50;
    track.style.transition = 'none';
  }, { passive: true });

  vp.addEventListener('touchmove', e => {
    const dx = e.touches[0].clientX - sx;
    const dy = e.touches[0].clientY - sy;
    if (!dragging && Math.abs(dy) > Math.abs(dx)) return;
    dragging = true;
    const next = Math.max(-50, Math.min(0, base + (dx / vp.clientWidth) * 100));
    track.style.transform = `translateX(${next}%)`;
  }, { passive: true });

  vp.addEventListener('touchend', e => {
    if (!dragging) return;
    track.style.transition = '';
    const dx   = e.changedTouches[0].clientX - sx;
    const fast = Date.now() - st < 250 && Math.abs(dx) > 40;
    const far  = Math.abs(dx) > vp.clientWidth * 0.35;
    if (fast || far) switchTab(dx < 0 ? 'fav' : 'all');
    else track.style.transform = `translateX(${base}%)`;
  }, { passive: true });
})();

/* ════════════════════════════════════════
   초기화
════════════════════════════════════════ */
