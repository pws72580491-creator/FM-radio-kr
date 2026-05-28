# KOREA FM 라디오 PWA

한국 FM 라디오 스트리밍 앱

## 파일 구조

```
├── index.html      # 앱 본체
├── manifest.json   # PWA 매니페스트
├── sw.js           # Service Worker
├── vercel.json     # Vercel 배포 설정
└── README.md
```

## Vercel 배포 방법 (권장)

### 방법 1 — Vercel CLI (터미널)
```bash
npm i -g vercel
vercel deploy
```

### 방법 2 — GitHub 연동 (자동 배포)
1. GitHub에 새 레포지토리 생성 후 파일 4개 업로드
2. [vercel.com](https://vercel.com) → New Project → GitHub 레포 선택
3. Deploy 클릭 → 완료

### 방법 3 — Vercel 드래그 앤 드롭
1. [vercel.com/new](https://vercel.com/new) 접속
2. 이 폴더를 브라우저 창에 드래그
3. Deploy 클릭

배포 후 `https://<project>.vercel.app` 으로 접속하면 PWA 설치 가능.
