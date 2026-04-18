# 📋 변경 내역 (Changelog)

---

## v1.4.0 — 전체 점검 & 버그 수정
> 2025

### 🐛 버그 수정
- **수동 정지 후 자동 재개 버그 수정**
  - `togglePlay()` 및 MediaSession ⏸ 핸들러에서 `playing = false`를 `audio.pause()` **이전에** 설정
  - 기존: 수동 정지 후 화면 ON/OFF 또는 블루투스 재연결 시 방송이 자동으로 재개되는 오작동
- **iOS 네이티브 HLS 재생 실패 시 재시도 없음 수정**
  - `audio.play().catch(() => onFail(false))` → `onFail(true)` 로 변경, 실패 시 재시도 수행
- **재생 실패 시 `_wasPlaying` 초기화 추가**
  - `onFail()` 시 `_wasPlaying = false` 초기화 → 재시도 중 중복 재연결 방지

### 🔧 코드 정리
- 사용되지 않던 `.loading` CSS 클래스 제거 (스피너는 인라인 스타일로 제어)

---

## v1.3.0 — 블루투스 자동 재연결
> 2025

### ✨ 신규 기능
- **블루투스 자동 재연결 지원**
  - `navigator.mediaDevices.devicechange` 이벤트 감지 (Android Chrome)
  - `AudioContext statechange` 감지 (iOS Safari)
  - 블루투스 재연결 시 300ms 딜레이 후 라이브 시점 자동 재연결

---

## v1.2.2 — 전화 인터럽트 처리 개선
> 2025

### 🐛 버그 수정
- **전화 통화 후 방송 종료 버그 수정**
  - `_wasPlaying` / `_needReconnect` 플래그 분리
  - 통화 중 HLS 재시도(`scheduleRetry`)가 `_wasPlaying` 플래그를 초기화하던 문제 수정
  - `playStation()` 진입 시 `_needReconnect`만 초기화, `_wasPlaying`은 유지
- **수동 정지 후 재시작 시 버퍼 재생 제거**
  - `hls.startLoad()` 버퍼 재개 방식 완전 제거
  - 모든 재생 경로에서 `playStation()` 호출 → 항상 라이브 시점 재연결

### 🔧 개선
- MediaSession ▶ 핸들러도 `playStation()` 으로 통일 (라이브 재연결)
- MediaSession ⏸ 핸들러에 `radio_playing = '0'` 저장 추가

---

## v1.2.1 — 앱 강제 종료 후 자동 재개
> 2025

### ✨ 신규 기능
- **앱 재시작 시 자동 재개**
  - `localStorage.radio_playing` 에 재생 상태 저장
  - 재생 성공 시 `'1'`, 수동 정지 시 `'0'` 저장
  - 앱 재시작(Android 강제 종료 포함) 시 마지막 재생 중이었으면 자동 재개

---

## v1.2.0 — 전화 인터럽트 처리
> 2025

### ✨ 신규 기능
- **전화 통화 후 라이브 시점 자동 재연결**
  - `audio pause` 이벤트: 외부 인터럽트 감지 → `_wasPlaying = true`
  - `visibilitychange visible`: 화면 복귀 시 재연결 (전화로 멈춘 경우만)
  - `audio play` 이벤트: 시스템 자동 재개 차단 → 라이브 재연결 (Android 일부)
  - `playStation()` 진입 시 이전 인터럽트 플래그 초기화

### 🗑 제거
- 기존 `visibilitychange` 화면 ON/OFF 재연결 로직 제거 (불편함 유발)

---

## v1.1.2 — 극동방송 백그라운드 재생
> 2025

### 🐛 버그 수정
- **서울극동방송 백그라운드 전환 시 끊김 수정**
  - 원인: `streamApi` 동적 URL 방식 → 백그라운드에서 `fetch` 실패
  - 해결: 최초 해석된 URL을 `s._resolvedUrl`에 캐시, 백그라운드 복귀 시 재사용
  - 직접 채널 선택 시(`forceRefresh=true`)만 새 URL 받아옴

---

## v1.1.1 — Firebase 함께 듣기
> 2025

### ✨ 신규 기능
- **실시간 채널 공유 (함께 듣기)**
  - Firebase Realtime Database 기반
  - 닉네임 입력 후 시작, 닉네임 localStorage 저장
  - 채널 변경 시 연결된 모든 사용자 자동 전환
  - 토스트 알림: `"홍길동님이 KBS 쿨FM으로 변경했습니다"`
  - `_fbIgnore` 플래그로 자신이 바꾼 것을 리스너가 중복 처리하는 현상 방지

---

## v1.1.0 — 스와이프 전환
> 2025

### ✨ 신규 기능
- **전체채널 ↔ 즐겨찾기 스와이프 전환**
  - 터치 드래그 시 실시간 슬라이드
  - 플릭(250ms 내 40px↑) 또는 화면 35% 이상 드래그 시 탭 전환
  - 조건 미충족 시 원래 탭으로 복귀
  - 수직 스크롤과 충돌 없이 분리 처리

---

## v1.0.0 — 최초 출시
> 2025

### ✨ 기능
- 한국 FM 라디오 15개 채널 HLS 스트리밍
- 즐겨찾기 (localStorage 저장)
- 다크 / 라이트 테마 (FOUC 방지)
- 파형 애니메이션, 볼륨 슬라이더
- 재연결 실패 시 지수 백오프 자동 재시도 (최대 5회)
- MediaSession API (잠금화면 컨트롤, 이전/다음 트랙)
- PWA: Service Worker, manifest.json, 홈 화면 설치
- Safe area 대응 (노치/홈바)

---

*버전 번호는 의미 기반 관리 (major.minor.patch)*
- **major**: 구조적 변경
- **minor**: 신규 기능 추가
- **patch**: 버그 수정
