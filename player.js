/* ══ player.js ══ */
/* ════════════════════════════════════════
   오디오 엘리먼트
════════════════════════════════════════ */
const audio = document.getElementById('audioEl');

/* ════════════════════════════════════════
   에러 박스
════════════════════════════════════════ */
function showError(msg) {
  const box = document.getElementById('errorBox');
  if (!msg) { box.style.display = 'none'; return; }
  box.querySelector('.err-msg').textContent = msg;
  box.style.display = 'flex';
}

/* ════════════════════════════════════════
   재생 감시 워치독
   onOK() 이후 audio.currentTime이 멈추면
   UI 강제 동기화 + 재연결
════════════════════════════════════════ */
function startWatchdog() {
  stopWatchdog();
  let lastTime  = audio.currentTime;
  let stallTick = 0;
  S.watchdogTimer = setInterval(() => {
    if (!S.playing || S.loading) { stopWatchdog(); return; }

    // ★ 백그라운드 상태에서는 OS가 currentTime 갱신을 지연시킬 수 있음
    // → hidden 상태에서는 오작동 판정을 완전히 건너뜀
    if (document.visibilityState === 'hidden') {
      lastTime  = audio.currentTime; // 기준값 갱신 (복귀 후 오작동 방지)
      stallTick = 0;
      return;
    }

    const cur = audio.currentTime;
    if (audio.paused || cur === lastTime) {
      // ★ HLS 모드에서 audio.paused 상태는 recoverMediaError() 복구 중일 수 있음
      // → paused이면 바로 stallTick 누적 전에 play() 재시도 (1회만)
      if (audio.paused && S.hls && stallTick === 0) {
        audio.play().catch(() => {});
      }
      stallTick++;
      // ★ 포그라운드 기준 8초(4틱×2초), 백그라운드는 위에서 스킵
      if (stallTick >= 4) {
        RLog.warn('워치독: 스트림 멈춤 감지 → 재연결', `paused=${audio.paused}, cur=${audio.currentTime.toFixed(2)}`);
        stopWatchdog();
        S.playing = false;
        updateNowPlaying(); renderStations();
        scheduleRetry();
      }
    } else {
      stallTick = 0;
      lastTime  = cur;
    }
  }, 2000);
}

function stopWatchdog() {
  if (S.watchdogTimer) { clearInterval(S.watchdogTimer); S.watchdogTimer = null; }
}

/* ════════════════════════════════════════
   재생 로그 시스템
   중단 원인 추적을 위해 주요 이벤트를 IndexedDB에 저장
════════════════════════════════════════ */
const LOG_DB_KEY  = 'radio_play_log';
const LOG_MAX     = 500; // 최대 500개 유지

const RLog = (() => {
  let _buf = [];   // 메모리 버퍼
  let _loaded = false;

  // IDB에서 기존 로그 로드
  async function load() {
    try {
      const r = await idbGet(LOG_DB_KEY);
      _buf = r ? JSON.parse(r) : [];
    } catch(e) { _buf = []; }
    _loaded = true;
  }

  // IDB에 저장
  async function persist() {
    try { await idbSet(LOG_DB_KEY, JSON.stringify(_buf)); } catch(e) {}
  }

  // 로그 기록
  function write(level, msg, detail = '') {
    const now  = new Date();
    const time = now.toLocaleTimeString('ko-KR', { hour12: false })
                 + '.' + String(now.getMilliseconds()).padStart(3,'0');
    const date = now.toLocaleDateString('ko-KR');
    const entry = { level, time, date, msg, detail,
      station: window.S?.current?.name || '-',
      ts: now.getTime() };
    _buf.unshift(entry);             // 최신이 위
    if (_buf.length > LOG_MAX) _buf.pop();
    persist();
    // 에러·경고 발생 시 로그 버튼 강조
    if (level === 'ERROR' || level === 'WARN' || level === 'STOP') {
      document.getElementById('logBtn')?.classList.add('has-error');
    }
    // 콘솔에도 출력
    const fn = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.info;
    fn(`[RLog][${level}] ${msg}`, detail || '');
  }

  return {
    load,
    info    : (m, d) => write('INFO',      m, d),
    play    : (m, d) => write('PLAY',      m, d),
    stop    : (m, d) => write('STOP',      m, d),
    warn    : (m, d) => write('WARN',      m, d),
    error   : (m, d) => write('ERROR',     m, d),
    reconnect:(m,d)  => write('RECONNECT', m, d),
    getAll  : ()     => [..._buf],
    clear   : async () => { _buf = []; await persist(); },
  };
})();

// 로그 뷰어 UI
function openLog() {
  renderLogUI();
  document.getElementById('logBg').classList.add('show');
  document.getElementById('logBtn').classList.remove('has-error');
}
function closeLog(e) {
  if (e && e.target !== document.getElementById('logBg')) return;
  document.getElementById('logBg').classList.remove('show');
}
function renderLogUI() {
  const logs = RLog.getAll();
  const body = document.getElementById('logBody');
  if (!logs.length) {
    body.innerHTML = '<div class="log-empty">기록된 로그가 없습니다.</div>';
    return;
  }
  body.innerHTML = logs.map(e => `
    <div class="log-entry ${e.level}">
      <span class="log-time">${e.date} ${e.time}</span>
      <span class="log-tag">[${e.level}]</span>
      <span class="log-msg"> [${e.station}] ${e.msg}${e.detail ? ' — ' + e.detail : ''}</span>
    </div>`).join('');
}
function exportLog() {
  const logs = RLog.getAll();
  const lines = logs.map(e =>
    `${e.date} ${e.time} [${e.level}] [${e.station}] ${e.msg}${e.detail ? ' — '+e.detail : ''}`
  ).join('\n');
  const blob = new Blob([lines], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `radio-log-${new Date().toISOString().slice(0,10)}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}
async function clearLog() {
  if (!confirm('로그를 모두 삭제할까요?')) return;
  await RLog.clear();
  renderLogUI();
  showToast('🗑️ 로그가 초기화됐습니다.');
}

/* ════════════════════════════════════════
   재시도
════════════════════════════════════════ */
function clearRetryTimer() {
  if (S.retryTimer) { clearTimeout(S.retryTimer); S.retryTimer = null; }
}

function scheduleRetry() {
  if (S.retryTimer) { clearTimeout(S.retryTimer); S.retryTimer = null; }

  S.playing = false;
  S.loading = false; // ★ 영구 로딩 UI 방지
  updateNowPlaying(); renderStations();

  // ★ 백그라운드 상태에서는 재시도 루프 없이 즉시 종료
  // → 포그라운드 복귀 시 visibilitychange에서 자동 재연결
  if (document.visibilityState === 'hidden') {
    if (S.current) S.wasPlaying = true; // 복귀 시 재연결 트리거
    S.retryCount = 0;
    if (S.hls) { S.hls.destroy(); S.hls = null; } // HLS 인스턴스 정리
    audio.src = '';
    RLog.info('백그라운드 재시도 건너뜀 — 포그라운드 복귀 시 재연결');
    return;
  }

  if (S.retryCount >= 5) {
    RLog.error('재연결 5회 실패 — 방송 중단');
    showError('연결 실패 (5회). 재연결 버튼을 눌러주세요.');
    return;
  }
  S.retryCount++;
  const delay = Math.min(2000 * Math.pow(2, S.retryCount - 1), 30000);
  RLog.warn(`재연결 대기 ${S.retryCount}회차`, `${Math.round(delay/1000)}초 후 재시도`);
  showError(`연결이 끊겼습니다. ${Math.round(delay/1000)}초 후 재연결 (${S.retryCount}/5)`);
  S.retryTimer = setTimeout(() => { if (S.current) playStation(S.current, false, true); }, delay);
}

function retryPlay() {
  if (!S.current) return;
  clearRetryTimer(); S.retryCount = 0;
  playStation(S.current, true);
}

/* ════════════════════════════════════════
   재생 엔진
════════════════════════════════════════ */
function playStation(s, forceRefresh = false, isRetry = false) {
  const thisCall = ++S.callId;
  S.needReconnect = false;
  S.wasPlaying    = false;   // 채널 전환 시 오작동 재연결 방지

  // ★ 수동 채널 선택 시 자동 재연결 락·인터벌 즉시 해제 (중복 실행 차단)
  reconnectingCall = false;
  stopCallWatch();

  showError(null); clearRetryTimer(); stopWatchdog();
  // ★ 수동 채널 선택 시에만 retryCount 리셋 — scheduleRetry 재시도 경로에서는 유지 (지수 백오프 작동)
  if (!isRetry) S.retryCount = 0;
  S.loading = true; S.playing = false; S.current = s;
  localStorage.setItem('radio_last', s.id);
  updateNowPlaying(); renderStations();
  RLog.play(`채널 선택: ${s.name}`, `${s.freq} / forceRefresh=${forceRefresh}`);

  if (S.hls) { S.hls.destroy(); S.hls = null; }
  S.userPaused = true;
  audio.pause(); audio.src = '';

  // Firebase 동기화
  if (typeof syncMode !== 'undefined' && syncMode && typeof fbDb !== 'undefined' && fbDb) {
    _fbIgnore = Date.now(); // ★ 이 기기가 쓴 이벤트임을 타임스탬프로 표시
    fbDb.ref('shared/station').set({ id: s.id, nick: myNick, at: Date.now() });
  }

  resolveStreamUrl(s, forceRefresh).then(url => {
    if (thisCall !== S.callId) return;

    function onOK() {
      if (thisCall !== S.callId) return;
      S.playing    = true; S.loading = false; S.retryCount = 0;
      S.userPaused = false; // ★ pause 이벤트가 발생하지 않은 경우(이미 정지 상태에서 재생)에도 반드시 초기화
      RLog.play('재생 시작 성공');

      // ★ 재생 시작 시 라이브 엣지 강제 동기화
      // HLS.js가 backBufferLength:0 + startPosition:-1 을 적용했지만
      // 혹시라도 오래된 위치에서 시작되는 경우를 대비한 최종 안전장치
      // ★ onOK 내 강제 currentTime 점프 제거 — startPosition:-1 로 이미 라이브 엣지 시작 보장

      localStorage.setItem('radio_playing', '1');
      updateNowPlaying(); renderStations(); updateMediaSession();
      startWatchdog();   // 실제 재생 감시 시작
    }
    function onFail(retry) {
      if (thisCall !== S.callId) return;
      S.loading = false; S.playing = false;
      updateNowPlaying(); renderStations(); updateMediaSession();
      RLog.error('재생 실패(onFail)', `retry=${retry}`);
      if (retry) scheduleRetry();
    }

    if (window.Hls && window.Hls.isSupported()) {
      const hls = new window.Hls({
        // ★ 라이브 엣지 즉시 재생 설정 — 버퍼를 최소화해 항상 현재 시점 방송 재생
        maxBufferLength:              10,  // ★ 5→10: bufferStalledError 반복 방지 (Joy4U 세그먼트 여유)
        maxMaxBufferLength:           15,  // ★ 8→15: 버퍼 자동 확장 상한
        backBufferLength:             1,   // ★ 0→1: 완전 제거 시 세그먼트 경계 미세 끊김 발생
        liveSyncDurationCount:        2,   // ★ 1→2: 라이브 엣지 2세그먼트 뒤 재생 (bufferStall 방지)
        liveMaxLatencyDurationCount:  4,   // ★ 2→4: 급격한 엣지 점프 억제
        liveDurationInfinity:        true, // 라이브 스트림 duration을 Infinity로 유지
        startPosition:               -1,   // 항상 라이브 엣지에서 시작 (-1 = 최신 위치)
        enableWorker:                true,
      });
      S.hls = hls;
      hls.loadSource(url); hls.attachMedia(audio);
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        // ★ 매니페스트 파싱 후 명시적으로 라이브 엣지 위치에서 로드 시작
        hls.startLoad(-1);
        audio.volume = S.volume;
        audio.play().then(onOK).catch(() => {
          showToast('▶ 화면을 탭하면 재생됩니다');
          onFail(false);
        });
      });
      // ★ LEVEL_LOADED에서 audio.currentTime 강제 점프 제거
      // → currentTime 강제 변경은 버퍼 플러시를 유발해 재생 중 주기적 끊김의 직접 원인
      // → 라이브 엣지 동기화는 HLS.js 자체(liveMaxLatencyDurationCount)에 완전히 위임
      let mediaErrorCount = 0;
      let netErrCount = 0;    // ★ 비치명 네트워크 오류 누적 카운트
      let netErrTimer = null; // ★ startLoad 디바운스 타이머 (runaway 루프 방지)
      hls.on(window.Hls.Events.ERROR, (_, d) => {
        if (thisCall !== S.callId) { hls.destroy(); return; } // 구 채널 에러 조용히 폐기
        if (d.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
          if (d.fatal) {
            RLog.error('HLS 네트워크 오류(치명)', `${d.details || ''}`);
            if (netErrTimer) { clearTimeout(netErrTimer); netErrTimer = null; }
            if (S.hls === hls) S.hls = null;
            hls.destroy(); onFail(true);
          } else {
            netErrCount++;
            if (netErrCount > 10) {
              // ★ 비치명 오류가 10회를 초과하면 복구 불가로 판단해 치명 처리
              RLog.error('HLS 네트워크 오류(복구 한계 초과)', `${d.details || ''}`);
              if (netErrTimer) { clearTimeout(netErrTimer); netErrTimer = null; }
              if (S.hls === hls) S.hls = null;
              hls.destroy(); onFail(true);
              return;
            }
            RLog.warn('HLS 네트워크 오류(복구 시도)', `${d.details || ''} [${netErrCount}/10]`);
            // ★ startLoad를 500ms 디바운스로 제한 — 연속 오류 시 폭주 방지
            if (!netErrTimer) {
              netErrTimer = setTimeout(() => {
                netErrTimer = null;
                hls.startLoad();
              }, 500);
            }
          }
          return;
        }
        if (d.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
          if (mediaErrorCount < 2) {
            RLog.warn(`HLS 미디어 오류(복구 ${mediaErrorCount+1}회)`, `${d.details || ''}`);
            mediaErrorCount++;
            hls.recoverMediaError();
            // ★ recoverMediaError() 후 audio가 paused 상태로 방치되는 문제 해결
            // HLS.js 스펙상 recoverMediaError 이후 명시적으로 play()를 재호출해야 함
            setTimeout(() => { if (S.hls === hls && audio.paused) audio.play().catch(() => {}); }, 100);
          } else {
            RLog.error('HLS 미디어 오류(복구 한계 초과)', `${d.details || ''}`);
            if (S.hls === hls) S.hls = null;
            hls.destroy(); onFail(true);
          }
          return;
        }
        if (d.fatal) {
          if (S.hls === hls) S.hls = null;
          hls.destroy(); onFail(true);
        }
      });
    } else if (audio.canPlayType('application/vnd.apple.mpegurl')) {
      audio.src = url; audio.volume = S.volume;
      audio.play().then(onOK).catch(() => onFail(true));
    } else {
      showError('이 브라우저는 HLS를 지원하지 않습니다.');
      S.loading = false; updateNowPlaying(); renderStations();
    }
  }).catch(() => {
    if (thisCall !== S.callId) return;
    S.loading = false; S.playing = false;
    updateNowPlaying(); renderStations(); updateMediaSession();
    showError('스트림 주소를 가져오지 못했습니다.');
  });
}

function togglePlay() {
  if (!S.current || S.loading) return;
  if (S.playing) {
    clearRetryTimer(); stopWatchdog();
    if (S.hls) S.hls.stopLoad();
    S.userPaused = true; S.wasPlaying = false; S.needReconnect = false;
    audio.pause(); S.playing = false;
    localStorage.setItem('radio_playing', '0');
    RLog.stop('사용자 정지 (일시정지 버튼)');
    updateNowPlaying(); renderStations(); updateMediaSession();
  } else {
    playStation(S.current);
  }
}

/* ════════════════════════════════════════
   오디오 이벤트 (전화/인터럽트 처리)
════════════════════════════════════════ */
audio.addEventListener('ended',   () => { if (S.current && S.playing) scheduleRetry(); });
audio.addEventListener('error',   () => { if (S.current && S.playing && !S.loading && !S.hls) scheduleRetry(); });
// ★ stalled: 데이터 수신 중단 감지
// HLS.js 활성 상태에서는 HLS.js 내부가 자체 복구하므로 외부 개입 금지
// native <audio> 전용으로만 scheduleRetry 호출
audio.addEventListener('stalled', () => {
  if (!S.current || !S.playing || S.loading) return;
  if (S.hls) return; // ★ HLS.js가 자체 복구 처리 중 — 외부 재시작 금지
  scheduleRetry();
});

/* ════════════════════════════════════════
   네트워크 전환 감지 (WiFi ↔ 데이터)
   — Android에서 online/offline 이벤트 없이
     IP만 바뀌는 경우를 Network Information API로 감지
════════════════════════════════════════ */
(function initNetworkSwitchDetect() {
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!conn) return; // 미지원 브라우저 (iOS 등)는 워치독으로 처리

  let lastType = conn.effectiveType || conn.type || '';

  conn.addEventListener('change', () => {
    const newType = conn.effectiveType || conn.type || '';
    if (newType === lastType) return;
    console.info(`[네트워크] 전환 감지: ${lastType} → ${newType}`); // ★ lastType 갱신 전에 로그
    lastType = newType;
    if (!S.current || (!S.wasPlaying && !S.playing)) return; // ★ 연산자 우선순위 명확화

    // 네트워크 전환 직후 잠깐 대기 후 재연결
    // (새 인터페이스에 IP 할당되기 전에 재연결하면 또 실패하므로 500ms 대기)
    setTimeout(() => {
      if (S.current && (S.wasPlaying || S.playing)) {
        console.info('[네트워크] 전환 후 재연결 실행');
        S.wasPlaying = false;
        S.needReconnect = false;
        stopWatchdog();
        clearRetryTimer();
        playStation(S.current);
      }
    }, 500);
  });
})();

audio.addEventListener('pause', () => {
  if (S.userPaused) { S.userPaused = false; return; }
  if (S.playing && S.current && !S.loading) {
    RLog.stop('외부 원인으로 재생 중단 (OS/통화/음성입력)');
    S.wasPlaying = true;
    S.needReconnect = true;
    S.playing = false;
    updateNowPlaying(); renderStations();
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused';
    }
  }
});

audio.addEventListener('play', () => {
  // ★ 통화/음성입력 중 OS가 잠깐 play를 시도할 때 오발동 차단
  // needReconnect: 통화/음성입력으로 인한 외부 중단 상태
  if (S.needReconnect && S.current && !reconnectingCall) {
    S.needReconnect = false;
    S.wasPlaying    = true;  // ★ false → true: 재연결 트리거가 wasPlaying을 필요로 함
    S.userPaused    = true;
    audio.pause();
    // ★ 백그라운드 상태에서는 playStation 호출 금지
    // wasPlaying=true가 이미 세팅됐으므로 포그라운드 복귀 시 visibilitychange가 재연결
    if (document.visibilityState === 'hidden') return;
    // ★ 즉시 재시작 대신 공유 AudioContext resume → statechange 흐름에 위임
    // AudioContext가 이미 running이면 바로 재연결
    const ctx = getSharedAudioCtx ? getSharedAudioCtx() : null;
    if (ctx && ctx.state === 'running') {
      S.wasPlaying = false; S.needReconnect = false;
      playStation(S.current);
    } else if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {}); // statechange → ensureAudioCtxWatch가 재연결
    } else {
      playStation(S.current); // 폴백
    }
  }
});

/* ════════════════════════════════════════
   공유 AudioContext 싱글턴
   통화·음성입력 종료 감지를 위해
   initCallReconnect + initBluetoothReconnect가 공통으로 사용
════════════════════════════════════════ */
let _sharedAudioCtx  = null;
let _ctxStateWatched = false; // statechange 리스너 중복 등록 방지

function getSharedAudioCtx() {
  if (_sharedAudioCtx && _sharedAudioCtx.state !== 'closed') return _sharedAudioCtx;
  try {
    _sharedAudioCtx  = new (window.AudioContext || window.webkitAudioContext)();
    _ctxStateWatched = false; // 새 인스턴스 → 리스너 재등록 필요
  } catch(e) {}
  return _sharedAudioCtx;
}

function ensureAudioCtxWatch() {
  if (_ctxStateWatched) return;
  const ctx = getSharedAudioCtx();
  if (!ctx) return;
  _ctxStateWatched = true;
  ctx.addEventListener('statechange', () => {
    // 오래된 컨텍스트의 이벤트 무시
    if (ctx !== _sharedAudioCtx || ctx.state === 'closed') return;
    // play 이벤트 중 suspended → resume 시도
    if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); return; }
    // running 복귀 = 통화/음성입력 종료 → 재연결
    if (ctx.state === 'running' && S.wasPlaying && S.current && !S.playing && !S.loading) {
      // ★ 백그라운드 상태에서는 playStation 호출 금지 — visibilitychange가 처리
      if (document.visibilityState === 'hidden') return;
      console.info('[AudioCtx] running 복귀 → 재연결');
      S.wasPlaying = false; S.needReconnect = false;
      playStation(S.current);
    }
  });
}

// ★ 앱 시작 즉시 AudioContext 생성 + statechange 등록
// 사용자 첫 터치 전이라 suspended 상태지만, 상태 변화는 감지 가능
try { getSharedAudioCtx(); ensureAudioCtxWatch(); } catch(e) {}

/* ════════════════════════════════════════
   통화 종료 자동 재연결
════════════════════════════════════════ */
// ★ play 이벤트 오발동 차단용으로 외부에서 참조
let reconnectingCall = false;

// ★ playStation 내부에서 통화감지 인터벌을 즉시 멈추기 위한 외부 참조
let stopCallWatch = () => {};

(function initCallReconnect() {
  let watchTimer  = null;
  let callSuspect = false;

  function tryReconnect() {
    if (reconnectingCall || !S.current || !S.wasPlaying) return;
    // ★ 백그라운드에서는 재연결 시도하지 않음 — 포그라운드 복귀 시 visibilitychange가 처리
    if (document.visibilityState === 'hidden') return;
    // ★ 수동 재생/로딩 중이면 중복 실행 방지
    if (S.playing || S.loading) { S.wasPlaying = false; return; }
    reconnectingCall = true;
    S.wasPlaying     = false;
    S.needReconnect  = false;
    callSuspect      = false;
    stopWatch();
    showError(null);

    // ★ 소프트 재연결 먼저 시도 — HLS가 살아있으면 play()만 재호출
    // 알림음·짧은 인터럽트는 HLS 스트림이 유효하므로 전체 재연결(2~3초 침묵) 불필요
    if (S.hls && audio.src) {
      RLog.reconnect('인터럽트 종료 → play() 재시도 (소프트 재연결)');
      S.userPaused = true; // pause 핸들러 오발동 방지
      setTimeout(() => {
        audio.play().then(() => {
          // ★ 소프트 재연결 성공 — HLS 인스턴스 재사용, 끊김 최소화
          reconnectingCall = false;
          S.playing = true; S.loading = false; S.userPaused = false;
          RLog.play('소프트 재연결 성공 (play() 재시도)');
          updateNowPlaying(); renderStations(); updateMediaSession();
          startWatchdog();
        }).catch(() => {
          // ★ play() 실패 → 전체 재연결로 폴백
          reconnectingCall = false;
          RLog.reconnect('소프트 재연결 실패 → 전체 재연결');
          _fullReconnect();
        });
      }, 600); // 인터럽트 해제까지 최소 대기
      return;
    }

    // HLS가 없거나 src가 비어있으면 바로 전체 재연결
    RLog.reconnect('통화/음성입력 종료 → 전체 재연결');
    _fullReconnect();
  }

  function _fullReconnect() {
    reconnectingCall = true;
    // ★ pause 핸들러 오발동 방지 — 반드시 상태 먼저 초기화
    S.userPaused = true;
    S.playing    = false;

    // ★ 대기 전에 기존 스트림 즉시 정리
    try {
      audio.pause();
      if (S.hls) { S.hls.destroy(); S.hls = null; }
      audio.src = '';
    } catch(e) {
      console.warn('[fullReconnect] 기존 스트림 정리 실패:', e);
    }

    setTimeout(() => {
      // ★ 백그라운드 진입 시 전체 재연결 취소 — 포그라운드 복귀 시 자동 재연결
      if (document.visibilityState === 'hidden') {
        reconnectingCall = false;
        if (S.current) S.wasPlaying = true;
        RLog.info('백그라운드 상태 — 전체 재연결 연기 (포그라운드 복귀 시 재연결)');
        return;
      }
      playStation(S.current, true);  // 긴 통화 후 URL 강제 갱신
      setTimeout(() => { reconnectingCall = false; }, 2000);
    }, 1200);
  }

  function startWatch() {
    if (watchTimer || reconnectingCall) return;
    callSuspect = true;
    // ★ AudioContext statechange가 주 감지 수단이지만,
    //    suspended 상태가 지속될 경우를 대비한 폴백 폴링
    watchTimer = setInterval(() => {
      if (!S.wasPlaying || !S.current || reconnectingCall) { stopWatch(); return; }
      if (!audio.paused || !navigator.onLine) return;
      // ★ 매번 새 컨텍스트 생성 금지 — 공유 싱글턴 재사용
      const ctx = getSharedAudioCtx();
      if (!ctx) return;
      // suspended면 resume 시도 → statechange → tryReconnect 흐름으로 이어짐
      if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); return; }
      if (ctx.state === 'running') { tryReconnect(); }
    }, 2000);
  }

  function stopWatch() {
    if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
    callSuspect = false;
  }
  stopCallWatch = stopWatch; // ★ playStation에서 인터벌 경쟁 차단용으로 외부 노출

  audio.addEventListener('pause', () => {
    setTimeout(() => {
      if (S.wasPlaying && S.current && !reconnectingCall) startWatch();
    }, 500);
  });

  audio.addEventListener('play', () => stopWatch());

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      RLog.info('앱 백그라운드 진입', `playing=${S.playing}, wasPlaying=${S.wasPlaying}`);

      // ★ 재생/로딩 중이면 wasPlaying 보존 (복귀 시 재연결 트리거)
      if (S.playing || S.loading) S.wasPlaying = true;

      // ★ 백그라운드 진입 시 모든 재시도·폴링 즉시 중단
      // → 백그라운드에서 manifestLoadError 루프 완전 차단
      clearRetryTimer();
      stopCallWatch(); // 통화감지 폴링 중단
      stopWatchdog();
      S._watchdogPaused = S.playing; // 재생 중이었으면 복귀 시 워치독 재시작

      // ★ 로딩/재연결 중이면 HLS 인스턴스 즉시 정리 (백그라운드 manifest 요청 중단)
      // 이미 재생 성공 중인 경우는 오디오를 유지해 백그라운드 재생 허용
      if (S.loading) {
        if (S.hls) { S.hls.destroy(); S.hls = null; }
        audio.pause(); audio.src = '';
        S.loading = false;
        S.retryCount = 0;
        updateNowPlaying(); renderStations();
      }
      return;
    }

    // ★ 포그라운드 복귀
    RLog.info('앱 포그라운드 복귀', `playing=${S.playing}, wasPlaying=${S.wasPlaying}`);

    // 1) 워치독 재시작
    if (S._watchdogPaused && S.playing && !S.loading) {
      S._watchdogPaused = false;
      startWatchdog();
    }

    // 2) 이미 재생/로딩 중이면 스킵
    if (S.playing || S.loading) return;
    if (reconnectingCall) {
      RLog.info('visibilitychange 재연결 스킵 (tryReconnect 진행 중)');
      return;
    }

    // ★ wasPlaying이면 즉시 재연결 (forceRefresh=true — 백그라운드 중 CDN URL 교체 대비)
    // retryCount·scheduleRetry 잔재와 무관하게 wasPlaying이 최우선 트리거
    if (S.wasPlaying && S.current) {
      RLog.reconnect('포그라운드 복귀 → 재연결');
      S.wasPlaying = false;
      S.retryCount = 0;
      clearRetryTimer();
      playStation(S.current, true);
    }
  });

  window.addEventListener('online', () => {
    if (!S.current) return;
    // ★ wasPlaying 뿐 아니라 playing 상태(스트림이 끊긴 경우)도 재연결
    if (S.wasPlaying || S.playing) {
      RLog.reconnect('네트워크 온라인 복귀 → 재연결 시도');
      setTimeout(() => {
        stopWatchdog(); clearRetryTimer();
        S.wasPlaying = false; S.needReconnect = false;
        playStation(S.current);
      }, 500);
    }
  });
})();

/* ════════════════════════════════════════
   블루투스 재연결
════════════════════════════════════════ */
(function initBluetoothReconnect() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.addEventListener) return;

  // ★ 독립 AudioContext 제거 — 공유 싱글턴(getSharedAudioCtx) 사용
  //    앱 시작 시 이미 statechange 리스너 등록됨 (ensureAudioCtxWatch)

  navigator.mediaDevices.addEventListener('devicechange', async () => {
    if (!S.current) return;
    let hasAudioOut = true;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      hasAudioOut = devices.some(d => d.kind === 'audiooutput');
    } catch(e) {}
    if (S.wasPlaying && hasAudioOut) {
      setTimeout(() => {
        if (S.wasPlaying && S.current) {
          S.wasPlaying = false; S.needReconnect = false;
          playStation(S.current);
        }
      }, 300);
    }
  });

  // ★ play 이벤트 시 공유 AudioContext가 suspended면 resume 시도
  audio.addEventListener('play', () => {
    const ctx = getSharedAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    ensureAudioCtxWatch(); // statechange 리스너 확실히 등록
  }, { once: false });

  // ★ 첫 터치 시 공유 AudioContext resume 시도 + 리스너 보장
  document.addEventListener('click', () => {
    const ctx = getSharedAudioCtx();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    ensureAudioCtxWatch();
  }, { once: true, passive: true });
  document.addEventListener('touchstart', () => {
    const ctx = getSharedAudioCtx();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    ensureAudioCtxWatch();
  }, { once: true, passive: true });
})();

/* ════════════════════════════════════════
   네트워크 오프라인 감지
════════════════════════════════════════ */
// ★ 백그라운드 진입 시각 기록 — offline 오감지 필터링에 사용
let _bgHiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') _bgHiddenAt = Date.now();
  else _bgHiddenAt = 0;
}, true); // capture 단계로 등록 — 다른 핸들러보다 먼저 실행

window.addEventListener('offline', () => {
  if (!S.current) return;
  if (!S.playing && !S.wasPlaying) return;

  // ★ 백그라운드 진입 직후 500ms 이내 offline은 OS 절전 오감지로 무시
  if (_bgHiddenAt && Date.now() - _bgHiddenAt < 500) {
    RLog.warn('offline 이벤트 무시 (백그라운드 진입 직후 OS 절전 오감지)');
    return;
  }

  RLog.error('네트워크 오프라인 감지 — 방송 중단');
  if (S.playing) { S.wasPlaying = true; S.playing = false; }
  clearRetryTimer(); stopWatchdog(); // ★ 워치독 즉시 정리
  if (S.hls) S.hls.stopLoad();
  updateNowPlaying(); renderStations();
  showError('네트워크가 끊겼습니다. 연결을 확인 중...');
});

/* ════════════════════════════════════════
   음성입력(마이크) 종료 후 재생 복원
   visibilitychange가 발생하지 않는 음성입력 UI 오버레이 대응
════════════════════════════════════════ */
(function initVoiceInputReconnect() {
  let _voiceTimer = null;

  function stopVoiceTimer() {
    if (_voiceTimer) { clearInterval(_voiceTimer); _voiceTimer = null; }
  }

  // ★ 핵심 재연결 함수 — 호출 시 즉시 재연결 or AudioContext resume 위임
  function doReconnect(reason) {
    if (!S.current || S.playing || S.loading || !S.wasPlaying) return;
    stopVoiceTimer();
    console.info('[VoiceInput]', reason, '→ 재연결');
    const ctx = getSharedAudioCtx();
    if (ctx && ctx.state === 'suspended') {
      // AudioContext가 아직 suspended면 resume → statechange → ensureAudioCtxWatch 흐름
      ctx.resume().catch(() => {
        // resume 실패 시 직접 재연결
        S.wasPlaying = false; S.needReconnect = false;
        playStation(S.current);
      });
    } else {
      S.wasPlaying = false; S.needReconnect = false;
      playStation(S.current);
    }
  }

  // ① pause 이벤트 — userPaused 여부와 무관하게 wasPlaying 강제 보존
  //    기존 pause 핸들러가 userPaused=true일 때 wasPlaying을 세팅하지 않는 문제를 여기서 보완
  audio.addEventListener('pause', () => {
    // 외부 중단(통화/음성입력)으로 인한 pause인지 판단:
    // S.playing=true 였고, userPaused가 아직 소비되지 않은 상태가 아닐 때
    if (!S.current) return;
    // playing이었거나, 로딩 중에 OS가 pause를 걸었을 때 wasPlaying 보존
    if (S.playing || S.loading) {
      S.wasPlaying = true;
    }
    // pause 후 폴링 시작 — 음성입력/통화 종료 감지 (주 감지 실패 대비 폴백)
    stopVoiceTimer();
    let tick = 0;
    _voiceTimer = setInterval(() => {
      tick++;
      if (S.playing || S.loading || !S.current) { stopVoiceTimer(); return; }
      if (!S.wasPlaying) { stopVoiceTimer(); return; }
      if (tick > 60) { stopVoiceTimer(); return; } // 최대 2분 감지
      // AudioContext가 running이면 마이크 사용이 종료된 것
      const ctx = getSharedAudioCtx();
      if (!ctx) return;
      if (ctx.state === 'running') {
        doReconnect('폴링 감지(AudioCtx running)');
      } else if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {}); // resume 시도 → statechange로 처리
      }
    }, 2000);
  });

  // play 이벤트 시 폴링 종료
  audio.addEventListener('play', () => stopVoiceTimer());

  // ② visibilitychange — 탭 전환이 발생하는 경우(전화, 일부 음성입력)
  // ★ initCallReconnect의 visibilitychange와 중복되므로
  //    재생이 완전히 끊긴 경우(wasPlaying=true, playing=false)만 처리
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    // 이미 재생 중이거나 initCallReconnect가 처리 중이면 스킵
    if (S.playing || S.loading || reconnectingCall) return;
    doReconnect('visibilitychange(voice)');
  });

  // ③ pageshow — 백/포워드 캐시로 복귀 시 (bfcache)
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    doReconnect('pageshow(bfcache)');
  });

})();

/* ════════════════════════════════════════
   볼륨
════════════════════════════════════════ */
function handleVolume(val) {
  const parsed = parseFloat(val);
  if (isNaN(parsed)) return;
  S.volume = Math.min(1, Math.max(0, parsed));
  audio.volume = S.volume;
  const c  = (S.current && S.current.color) || 'var(--red)';
  const sl = document.getElementById('volSlider');
  if (sl) {
    sl.style.background =
      `linear-gradient(to right,${c} ${S.volume*100}%,var(--bg3) ${S.volume*100}%)`;
  }
}

/* ════════════════════════════════════════
   MediaSession (잠금화면 컨트롤)
════════════════════════════════════════ */
function updateMediaSession() {
  if (!('mediaSession' in navigator) || !S.current) return;

  navigator.mediaSession.metadata = new MediaMetadata({
    title:  S.current.name,
    artist: `${S.current.freq} · ${S.current.genre}`,
    album:  'KOREA FM 라디오'
  });

  navigator.mediaSession.setActionHandler('play', () => {
    playStation(S.current);
  });

  navigator.mediaSession.setActionHandler('pause', () => {
    S.userPaused = true; S.wasPlaying = false; S.needReconnect = false;
    if (S.hls) S.hls.stopLoad();
    audio.pause(); S.playing = false;
    localStorage.setItem('radio_playing', '0');
    updateNowPlaying(); renderStations();
    navigator.mediaSession.playbackState = 'paused';
  });

  navigator.mediaSession.setActionHandler('stop', () => {
    S.userPaused = true;
    if (S.hls) S.hls.stopLoad();
    audio.pause(); S.playing = false;
    localStorage.setItem('radio_playing', '0');
    updateNowPlaying(); renderStations();
    navigator.mediaSession.playbackState = 'paused';
  });

  ['previoustrack', 'nexttrack', 'seekbackward', 'seekforward'].forEach(a => {
    try { navigator.mediaSession.setActionHandler(a, null); } catch(e) {}
  });

  navigator.mediaSession.playbackState =
    (S.playing || S.loading) ? 'playing' : 'paused';
}
