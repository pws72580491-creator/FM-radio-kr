// ── Firebase 설정 ──
const firebaseConfig = {
  apiKey:            "AIzaSyAsdBSNUDMtiJA82eA9B5x0DwJ2oswmo2k",
  authDomain:        "grateful-c4abc.firebaseapp.com",
  databaseURL:       "https://grateful-c4abc-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId:         "grateful-c4abc",
  storageBucket:     "grateful-c4abc.firebasestorage.app",
  messagingSenderId: "277854504673",
  appId:             "1:277854504673:web:2ac2e7799a7574420c99a0",
  measurementId:     "G-6E5QSWYHKT"
};

let db = null;
let userRef = null;          // 내 기록 클라우드 ref
let userListener = null;     // 내 기록 실시간 리스너
let feedRef = null;          // 피드 공유 ref (전역 경로)

// ── 동기화 상태 ──
let syncStatus = 'idle';     // 'idle' | 'syncing' | 'synced' | 'error'
let syncTimer  = null;



// 스크립트를 순서대로 동적 로드 (Android/iOS 로딩 순서 보장)
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload  = resolve;
    s.onerror = () => reject(new Error("스크립트 로드 실패: " + src));
    document.head.appendChild(s);
  });
}

function initFirebase() {
  try {
    if (typeof firebase === "undefined") {
      console.warn("Firebase SDK 미로드");
      return false;
    }
    // 이미 초기화된 경우 재사용 (중복 초기화 에러 방지)
    if (firebase.apps && firebase.apps.length > 0) {
      db      = firebase.app().database();
    } else {
      firebase.initializeApp(firebaseConfig);
      db      = firebase.database();
    }
    // 내 기록 ref — 닉네임이 있으면 바로 연결
    const _nick = getNickname ? getNickname() : (localStorage.getItem("grateful-nickname") || "");
    if (_nick) {
      // encodeNick이 app.js에 있으므로 직접 인라인 처리
      const _enc = _nick.replace(/[.#$[\]\/]/g, "_").trim();
      if (_enc) {
        userRef   = db.ref(`grateful-users/${_enc}/history`);
        prayerRef = db.ref(`grateful-users/${_enc}/prayers`);
      }
    // 피드는 전역 공유 경로
    feedRef = db.ref("grateful-feed");
    }
    return true;
  } catch(e) {
    console.error("Firebase 초기화 실패:", e);
    return false;
  }
}

// Firebase SDK를 순서대로 로드한 뒤 앱 시작
// DOMContentLoaded 이후에 실행되도록 보장
window.addEventListener("DOMContentLoaded", () => {
  loadScript("https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js")
    .then(() => loadScript("https://www.gstatic.com/firebasejs/9.23.0/firebase-database-compat.js"))
    .then(() => { /* Firebase SDK 로드 완료 */ })
    .catch(err => {
      console.warn("Firebase SDK 로드 실패 (오프라인 모드로 실행):", err);
      // 로컬 파일로 실행 시 안내 메시지 표시
      if (location.protocol === "file:") {
        setTimeout(() => {
          const t = document.getElementById("toast");
          if (t) {
            t.textContent = "⚠️ 그룹 피드는 웹서버 배포 후 사용 가능해요";
            t.style.whiteSpace = "normal";
            t.style.textAlign  = "center";
            t.style.maxWidth   = "80vw";
            t.classList.add("show");
            setTimeout(() => t.classList.remove("show"), 5000);
          }
        }, 800);
      }
    })
    .finally(() => { if (typeof init === "function") init(); });
});