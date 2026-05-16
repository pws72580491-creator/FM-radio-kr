# 🌿 Grateful — 감사노트

매일 감사한 것을 기록하는 감성 PWA 앱

---

## 배포 방법 (GitHub Pages)

1. 이 폴더의 모든 파일을 GitHub 저장소 **루트**에 올리기
2. `Settings → Pages → Source: main branch / root` 설정
3. 배포 완료 후 `https://<username>.github.io/<repo>/` 접속
4. **Android**: Chrome 주소창 아래 "앱 설치" 배너 → 설치
5. **iPhone**: 공유 → "홈 화면에 추가"

---

## 파일 구조

```
/
├── index.html           # 메인 HTML
├── app.css              # 스타일시트
├── app.js               # 앱 로직
├── firebase-init.js     # Firebase 설정 + 초기화
├── sw.js                # 서비스 워커 (오프라인 + 알림)
├── manifest.json        # PWA 메타정보
├── apple-touch-icon.png
├── favicon.png
└── icons/               # PWA 아이콘 모음 (72~512px)
```

---

## 기능

- ✦ 매일 감사 노트 기록 (최대 5가지)
- 🙏 기도노트 (기도 중 / 응답받음 / Firebase 동기화)
- 📅 챌린지 (7일 → 21일 → 30일)
- 🔔 매일 리마인더 알림 (Service Worker)
- 🎨 테마 / 폰트 / 배경 패턴 커스터마이징
- ☁️ Firebase 클라우드 동기화 (감사기록 + 기도)

---

## 📋 버전 변경 이력

---

### v3.19 · 2026.05.04

**버그 수정**
- `closeLeaveModal()` 함수 누락 수정 → 나가기 모달 닫기 버튼 정상화
- 헤더 버전 하드코딩(`v3.18`) 수정
- 닉네임 모달 문구 수정 ("그룹에서 불릴 이름" → "앱에서 사용할 이름")

**기능 제거**
- 그룹 피드 공유 기능 전체 제거 (관련 함수 19개, CSS 섹션, 모달 HTML 삭제)
- `localStorage: grateful-shared` 키 제거

**기도노트 Firebase 동기화 추가**
- `grateful-users/{닉네임}/prayers` 경로에 실시간 저장/로드
- 기기 간 기도 데이터 동기화 (추가 / 응답됨 / 삭제 모두 반영)

**PWA 개선**
- `sw.js` 오프라인 캐시 파일 목록 추가 (이전엔 비어있어 오프라인 미작동)
- SW 캐시 버전 `grateful-v3` → `grateful-v4`

---

### v3.18 · 2026.03.15

**신규 기능**
- 🙏 기도노트 탭 추가 (오늘 / 기록 / 기도 3탭 구조)
- 기도 제목 + 내용 + 카테고리 (개인 / 가족 / 교회 / 감사 / 중보기도)
- 응답됨 표시 / 기도 중·응답받음 필터
- 챌린지를 기록 탭 하단 컴팩트 뷰로 이동

**버그 수정**
- 그룹 공유 버튼이 GitHub Pages 배포 시 보이지 않는 문제 수정
  - 원인: `firebaseReady` 조건으로 버튼 렌더 차단됨
  - 수정: Firebase 연결 상태와 무관하게 항상 렌더, 상태별 4단계 분기

**파일 분리 (단일 HTML → PWA 멀티파일)**
- `index.html` / `app.css` / `app.js` / `firebase-init.js` / `sw.js` 분리
- `sw.js` 실제 파일 분리로 GitHub Pages MIME 오류 해결 → 홈 화면 설치 정상화
- `manifest.json` + 아이콘 8종 (72~512px) 생성
