# 📻 KOREA FM 라디오

한국 FM 라디오를 스마트폰에서 앱처럼 즐길 수 있는 PWA 웹앱입니다.

[![GitHub Pages](https://img.shields.io/badge/GitHub%20Pages-배포중-22c55e?style=flat-square&logo=github)](https://github.com)

---

## ✨ 주요 기능

| 기능 | 설명 |
|------|------|
| 📡 15개 채널 | KBS·MBC·SBS·CBS·TBS·EBS·YTN·극동방송 등 |
| 📲 PWA 설치 | 홈 화면에 앱으로 설치 (Android / iOS) |
| ⭐ 즐겨찾기 | 자주 듣는 채널 저장 |
| 👆 스와이프 | 전체채널 ↔ 즐겨찾기 슬라이드 전환 |
| 🔗 함께 듣기 | Firebase 기반 실시간 채널 공유 |
| 🌙 다크/라이트 테마 | 시스템 무관 수동 전환 |
| 📞 통화 후 자동 복귀 | 전화 종료 후 라이브 시점 재연결 |
| 🎵 잠금화면 컨트롤 | MediaSession API (이전/다음/재생/일시정지) |

---

## 📁 파일 구조

```
📦 my-kr-radio
├── index.html        # 앱 본체 (단일 파일)
├── manifest.json     # PWA 매니페스트
├── sw.js             # 서비스 워커 (오프라인 캐시)
├── .nojekyll         # GitHub Pages Jekyll 비활성화
└── icons/            # 앱 아이콘 (72 ~ 512px)
    ├── icon-72.png
    ├── icon-96.png
    ├── icon-128.png
    ├── icon-144.png
    ├── icon-152.png
    ├── icon-192.png
    ├── icon-384.png
    └── icon-512.png
```

---

## 🚀 GitHub Pages 배포

### 1. 레포지토리 생성
```
GitHub → New repository → my-kr-radio → Create
```

### 2. 파일 업로드
위 파일 구조 그대로 업로드 (icons 폴더 포함)

### 3. Pages 설정
```
Settings → Pages → Source: Deploy from a branch
Branch: main / (root) → Save
```

### 4. 접속
```
https://{GitHub아이디}.github.io/my-kr-radio/
```

---

## 🔗 함께 듣기 (Firebase)

여러 명이 같은 채널을 실시간으로 공유하는 기능입니다.

### Firebase 설정 (이미 적용됨)
`index.html` 내 `FB_CONFIG` 에 Firebase 프로젝트 정보가 설정되어 있습니다.

### Firebase 보안 규칙
Firebase 콘솔 → Realtime Database → 규칙 탭에서 아래와 같이 설정:

```json
{
  "rules": {
    "shared": {
      ".read": true,
      ".write": true
    }
  }
}
```

### 사용 방법
1. 앱 상단 **함께 듣기** 버튼 탭
2. 닉네임 입력 후 시작
3. URL을 공유 → 상대방도 동일하게 함께 듣기 활성화
4. 한 명이 채널을 변경하면 → 모두 자동 전환

---

## 📱 홈 화면 설치 방법

**Android (Chrome)**
1. 앱 접속 후 상단 **📲 홈 화면 추가** 버튼 탭
2. 또는 Chrome 메뉴 → 홈 화면에 추가

**iOS (Safari)**
1. Safari로 접속
2. 하단 공유 버튼 → 홈 화면에 추가

---

## 📡 지원 채널

| # | 채널명 | 주파수 | 장르 |
|---|--------|--------|------|
| 1 | KBS 1라디오 | 97.3 MHz | 종합 |
| 2 | KBS 해피FM | 106.1 MHz | 종합 |
| 3 | KBS 쿨FM | 89.1 MHz | 음악/예능 |
| 4 | KBS 클래식FM | 93.1 MHz | 클래식 |
| 5 | MBC 표준FM | 95.9 MHz | 종합 |
| 6 | MBC FM4U | 91.9 MHz | 음악 |
| 7 | SBS 러브FM | 103.5 MHz | 종합 |
| 8 | SBS 파워FM | 107.7 MHz | 음악/예능 |
| 9 | CBS 음악FM | 93.9 MHz | 기독교음악 |
| 10 | TBS 교통방송 | 95.1 MHz | 교통/정보 |
| 11 | YTN 라디오 | AM 1305 | 뉴스 |
| 12 | EBS FM | 104.5 MHz | 교육 |
| 13 | 서울극동방송 | 106.9 MHz | 기독교 |
| 14 | CBS 표준FM | 98.1 MHz | 기독교종합 |
| 15 | Joy4U | 99.1 MHz | 기독교음악 |

---

## 🛠 기술 스택

- **HLS.js** – HLS 스트리밍
- **Firebase Realtime Database** – 함께 듣기 실시간 동기화
- **Service Worker** – PWA 오프라인 캐시
- **MediaSession API** – 잠금화면 미디어 컨트롤
- 단일 HTML 파일 구조 (외부 CSS/JS 프레임워크 없음)

---

## 📄 라이선스

개인 사용 목적으로 제작되었습니다.  
스트리밍 소스는 각 방송사의 공개 HLS 엔드포인트를 사용합니다.
