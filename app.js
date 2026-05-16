// ══════════════════════════════════════════
// 앱 버전
// ══════════════════════════════════════════
const APP_VERSION = "3.19";
const APP_BUILD   = "2026.05.04";

// ══════════════════════════════════════════
// 서비스 워커 (Web Push + 백그라운드 알림)
// ─────────────────────────────────────────
// 단일 HTML 파일에서 SW를 등록하는 유일하게
// 작동하는 방법: 페이지 자신의 URL에 ?sw=1을
// 붙여 등록. 이 스크립트 맨 위(head script)에서
// SW 컨텍스트일 때 SW 코드 실행 후 종료.
// (head script에 SW 감지 코드 주입 필요 — 아래)
// ══════════════════════════════════════════
let swReg = null;

// 페이지네이션 쿨다운 (연속 로드 방지)

// ══════════════════════════════════════════
// 상수
// ══════════════════════════════════════════
const PROMPTS = [
  "오늘 가장 감사했던 순간은?",
  "오늘 감사한 사람이 있다면?",
  "오늘 나에게 일어난 좋은 일은?",
];

// ── 랜덤 힌트 문장 풀 ──
const HINT_POOL = [
  ["오늘 맛있는 걸 먹었나요? 🍚", "나를 위해 시간 써준 사람이 있나요?", "작은 행운이 있었나요?"],
  ["따뜻한 말 한 마디를 들었나요? 🌸", "도움받은 순간이 있었나요?", "오늘 몸이 건강했던 것에 감사해요"],
  ["좋아하는 걸 즐긴 순간이 있나요? ☕", "오늘 내가 잘 해낸 일은?", "주변에 있어줘서 고마운 사람은?"],
  ["날씨나 자연에서 느낀 아름다움은? 🌤", "오늘 배운 것이 있나요?", "나 자신에게 고마운 점이 있나요?"],
  ["오늘 웃었던 순간은? 😊", "힘든 일을 이겨낸 나 자신에게", "소소하지만 기분 좋았던 것은?"],
];

const MOODS = [
  { emoji: "😊", label: "좋음" },
  { emoji: "😌", label: "평온" },
  { emoji: "🥰", label: "행복" },
  { emoji: "😤", label: "힘듦" },
  { emoji: "😴", label: "피곤" },
];
const DAY_LABELS = ["일","월","화","수","목","금","토"];

// ══════════════════════════════════════════
// 상태
// ══════════════════════════════════════════
let currentView = "write";
let state = { gratitude: [""], mood: null, note: "" };
let saved = false;
let firebaseReady = false;

// 내 기록 탭 상태
let histMode = "day";
let histSelectedDate = "";
let histCalYear  = 0;
let histCalMonth = 0;
let histEditMode = false;
let rewindYear = new Date().getFullYear(); // 연간 리와인드 연도

// 🙏 기도노트 상태
let prayerFilter = "active";  // "active" | "answered"
let prayerEditId = null;       // 수정 중인 기도 ID
let prayerRef = null;          // Firebase ref: grateful-users/{nick}/prayers
let prayerListener = null;     // 실시간 리스너

// 오늘 사용할 힌트 세트
let todayHints = HINT_POOL[new Date().getDay() % HINT_POOL.length];

// ══════════════════════════════════════════
// 날짜 헬퍼 (로컬 기준)
// ══════════════════════════════════════════
function localDateStr(date) {
  const d = date || new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function todayKey() { return localDateStr(); }
function formatDate(str) {
  return new Date(str+"T00:00:00").toLocaleDateString("ko-KR",{year:"numeric",month:"long",day:"numeric",weekday:"long"});
}
function formatDateShort(str) {
  return new Date(str+"T00:00:00").toLocaleDateString("ko-KR",{month:"long",day:"numeric"});
}
function timeAgo(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1)  return "방금 전";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  const day = Math.floor(h / 24);
  return `${day}일 전`;
}

// ══════════════════════════════════════════
// 저장소
// ══════════════════════════════════════════
function getHistory() {
  try { return JSON.parse(localStorage.getItem("grateful-history") || "{}"); } catch { return {}; }
}
function saveHistory(h) { localStorage.setItem("grateful-history", JSON.stringify(h)); }
function getNickname()   { return localStorage.getItem("grateful-nickname") || ""; }
function setNicknameLS(n){ localStorage.setItem("grateful-nickname", n); }

// ══════════════════════════════════════════
// Firebase 경로용 닉네임 인코딩
// ══════════════════════════════════════════
function encodeNick(nick) {
  return nick.replace(/[.#$\[\]\/]/g, "_").trim() || "user";
}

// ══════════════════════════════════════════
// 클라우드 동기화 — 내 기록
// ══════════════════════════════════════════
function isPermissionError(e) {
  if (!e) return false;
  const msg = (e.message || e.code || String(e)).toLowerCase();
  return msg.includes("permission") || msg.includes("denied") || e.code === "PERMISSION_DENIED";
}

function setSyncStatus(status) {
  syncStatus = status;
  const el = document.getElementById("syncBadge");
  if (!el) return;
  const map = {
    idle:    { text: "",            cls: "",        title: "" },
    syncing: { text: "☁ 동기화 중…", cls: "syncing", title: "" },
    synced:  { text: "✓ 동기화됨",  cls: "synced",  title: "" },
    // 권한 오류 — 눈에 띄지 않게, 클릭하면 안내
    rules:   { text: "☁ 규칙 설정 필요", cls: "rules", title: "Firebase 보안 규칙을 설정해야 동기화가 활성화돼요. 탭하면 안내를 볼 수 있어요." },
    // 네트워크 등 기타 오류 — 조용히 표시
    error:   { text: "☁ 오프라인",  cls: "offline", title: "네트워크 연결을 확인해주세요." },
  };
  const m = map[status] || map.idle;
  el.textContent = m.text;
  el.className   = "sync-badge " + m.cls;
  el.title       = m.title;
  el.onclick     = (status === "rules") ? showSyncRulesGuide : null;
  el.style.cursor = (status === "rules") ? "pointer" : "default";
  if (status === "synced") {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => setSyncStatus("idle"), 2500);
  }
}

function showSyncRulesGuide() {
  showToast("Firebase Console → Realtime Database → 규칙 탭에서 .read/.write를 true로 설정하세요", 6000);
}

function updateUserRef(nick) {
  if (userListener && userRef) { userRef.off("value", userListener); userListener = null; }
  if (prayerListener && prayerRef) { prayerRef.off("value", prayerListener); prayerListener = null; }
  if (!firebaseReady || !db || !nick) { userRef = null; prayerRef = null; return; }
  userRef   = db.ref(`grateful-users/${encodeNick(nick)}/history`);
  prayerRef = db.ref(`grateful-users/${encodeNick(nick)}/prayers`);
  // feedRef는 전역 공유 경로 (닉 무관)
  if (!feedRef && db) feedRef = db.ref("grateful-feed");
}

// 특정 날짜 기록 → 클라우드 업로드
async function syncDayToCloud(dateKey, entry) {
  if (!firebaseReady || !userRef) return;
  setSyncStatus("syncing");
  try {
    await userRef.child(dateKey).set({
      gratitude: entry.gratitude || [],
      mood:      entry.mood || null,
      note:      entry.note || "",
      updatedAt: Date.now(),
    });
    setSyncStatus("synced");
  } catch(e) {
    console.warn("클라우드 저장 실패:", e);
    setSyncStatus(isPermissionError(e) ? "rules" : "error");
  }
}

// 클라우드 → 로컬 병합 (앱 시작 / 로그인 시)
async function loadHistoryFromCloud() {
  if (!firebaseReady || !userRef) return;
  setSyncStatus("syncing");
  try {
    const snap = await userRef.once("value");
    const cloudData = snap.exists() ? snap.val() : {};
    const local = getHistory();

    // gratitude 정규화 (Firebase 숫자키 객체 → 배열)
    function normG(g) {
      if (Array.isArray(g)) return g.filter(Boolean);
      if (g && typeof g === "object")
        return Object.keys(g).sort((a,b)=>Number(a)-Number(b)).map(k=>g[k]).filter(Boolean);
      return [];
    }
    // 클라우드와 로컬을 updatedAt 기준으로 병합 (더 최신 우선)
    const merged = { ...local };
    Object.keys(cloudData).forEach(k => {
      const lTs = (local[k] && local[k].updatedAt) || 0;
      const cTs = cloudData[k].updatedAt || 0;
      if (cTs > lTs) merged[k] = { ...cloudData[k], gratitude: normG(cloudData[k].gratitude) };
    });
    saveHistory(merged);

    // 오늘 클라우드 기록이 있고 아직 미저장이면 state 반영
    const today = todayKey();
    if (merged[today] && !saved) {
      const raw = merged[today];
      state = {
        gratitude: Array.isArray(raw.gratitude) && raw.gratitude.length > 0
          ? [...raw.gratitude].concat([""])
          : [""],
        mood: raw.mood ?? null,
        note: raw.note ?? "",
      };
      if (state.gratitude.length > 5) state.gratitude = state.gratitude.slice(0, 5);
      saved = true;
    }
    setSyncStatus("synced");
    updateStreak();
    syncChallengeWithHistory();
    if (currentView === "history" || currentView === "write") render();

    // 기도 데이터도 클라우드에서 로드
    await loadPrayersFromCloud();

    // 로컬에만 있는 날은 클라우드에 업로드 (양방향)
    const toUpload = Object.keys(local).filter(k =>
      !cloudData[k] || (local[k].updatedAt || 0) > (cloudData[k].updatedAt || 0)
    );
    for (const k of toUpload) {
      const e = local[k];
      if (e && Array.isArray(e.gratitude) && e.gratitude.some(Boolean)) {
        await userRef.child(k).set({ ...e, updatedAt: e.updatedAt || Date.now() }).catch(()=>{});
      }
    }
  } catch(e) {
    console.warn("클라우드 로드 실패:", e);
    setSyncStatus(isPermissionError(e) ? "rules" : "error");
  }
}

// 실시간 리스너 — 다른 기기에서 저장하면 자동 반영
function startUserHistoryListener() {
  if (!firebaseReady || !userRef) return;
  if (userListener) { userRef.off("value", userListener); userListener = null; }
  userListener = userRef.on("value", snap => {
    if (!snap.exists()) return;
    const cloudData = snap.val();
    const local = getHistory();
    let changed = false;
    Object.keys(cloudData).forEach(k => {
      const cTs = cloudData[k].updatedAt || 0;
      const lTs = (local[k] && local[k].updatedAt) || 0;
      if (cTs > lTs) {
        const g = cloudData[k].gratitude;
        const normG = Array.isArray(g) ? g.filter(Boolean)
          : (g && typeof g === "object")
            ? Object.keys(g).sort((a,b)=>Number(a)-Number(b)).map(k=>g[k]).filter(Boolean)
            : [];
        local[k] = { ...cloudData[k], gratitude: normG };
        changed = true;
      }
    });
    if (changed) {
      saveHistory(local);
      updateStreak();
      syncChallengeWithHistory();
      setSyncStatus("synced");
      if (currentView === "history") render();
    }
  }, err => {
    console.warn("실시간 동기화 오류:", err);
    setSyncStatus(isPermissionError(err) ? "rules" : "error");
  });
}

// ══════════════════════════════════════════
// 연속일
// ══════════════════════════════════════════
function calcStreak() {
  const h = getHistory();
  let streak = 0;
  const today = new Date();
  for (let i = 0; i < 365; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const k = localDateStr(d);
    if (h[k] && Array.isArray(h[k].gratitude) && h[k].gratitude.some(Boolean)) streak++;
    else if (i > 0) break;
  }
  return streak;
}

// ══════════════════════════════════════════
// 테마 시스템 (라이트/다크/세피아/오로라/블루 나이트)
// ══════════════════════════════════════════
const THEME_META = {
  light:  { bgColor: "#f9f5ef", dark: false, icon: "🌙",  label: "라이트" },
  dark:   { bgColor: "#100a05", dark: true,  icon: "☀️",  label: "다크" },
  sepia:  { bgColor: "#f2e3c6", dark: false, icon: "🌅",  label: "웜 세피아" },
  aurora: { bgColor: "#050508", dark: true,  icon: "🌌",  label: "오로라 다크" },
  blue:   { bgColor: "#0a0d14", dark: true,  icon: "🌃",  label: "블루 나이트" },
};
const THEMES = {
  sepia:       { bgColor: "#f2e3c6", dark: false, icon: "🌿", label: "웜 세피아" },
  "ios-white": { bgColor: "#f2f2f7", dark: false, icon: "☁️", label: "iOS 화이트" },
  "matcha":    { bgColor: "#e8ede0", dark: false, icon: "🍵", label: "말차 그린" },
  "sunset":    { bgColor: "#fae4cc", dark: false, icon: "🍊", label: "선셋 오렌지" },
};

const THEME_CLASSES = ["theme-sepia","theme-ios-white","theme-matcha","theme-sunset"];

function getSystemDark() { return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches; }

function applyTheme(theme) {
  const html = document.documentElement;
  html.classList.remove("light","dark","theme-sepia","theme-aurora","theme-blue","theme-ios-white","theme-ios-dark","theme-matcha","theme-sunset"); // cleanup
  const t = THEMES[theme] || THEMES["sepia"];
  if (theme === "ios-white")     html.classList.add("theme-ios-white");
  else if (theme === "matcha")   html.classList.add("theme-matcha");
  else if (theme === "sunset")   html.classList.add("theme-sunset");
  else                           html.classList.add("theme-sepia");
  const meta = document.getElementById("metaThemeColor");
  if (meta) meta.content = t.bgColor;
  updateThemeSwatches(theme);
}

function updateThemeSwatches(theme) {
  ["sepia","ios-white","matcha","sunset"].forEach(t => {
    const el = document.getElementById("swatch-" + t);
    if (el) el.classList.toggle("active", t === theme);
  });
}

function selectTheme(theme) {
  const valid = ["sepia","ios-white","matcha","sunset"];
  const t = valid.includes(theme) ? theme : "sepia";
  localStorage.setItem("grateful-theme", t);
  applyTheme(t);
  closeThemePicker();
}

function showThemePicker() {
  const modal = document.getElementById("themePickerModal");
  if (modal) { modal.style.display = "flex"; }
  // 현재 테마 표시
  const cur = localStorage.getItem("grateful-theme") || "sepia";
  updateThemeSwatches(cur);
  // 폰트·패턴 스와치도 최신 반영
  updateFontSwatches(localStorage.getItem("grateful-font") || "default");
  updatePatternSwatches(localStorage.getItem("grateful-pattern") || "none");
  // 항상 테마 탭으로 시작
  switchDecorTab("theme");
  // AI 결과 초기화
  const res = document.getElementById("themeAiResult");
  if (res) { res.classList.remove("show"); }
}

function closeThemePicker() {
  const modal = document.getElementById("themePickerModal");
  if (modal) modal.style.display = "none";
}

function onThemeModalOverlayClick(e) {
  if (e.target.id === "themePickerModal") closeThemePicker();
}

function initTheme() {
  const pref = localStorage.getItem("grateful-theme") || "sepia";
  applyTheme(pref);
}

// ══════════════════════════════════════════
// 폰트 & 배경 패턴
// ══════════════════════════════════════════
const FONT_CLASSES = ["font-nanum-m","font-nanum-g","font-gowun-d","font-gowun-b","font-gaegu","font-sunflower"];
const PATTERN_CLASSES = ["bg-floral","bg-stars","bg-dots","bg-grid","bg-wave"];

function applyFont(font) {
  const html = document.documentElement;
  html.classList.remove(...FONT_CLASSES);
  if (font && font !== "default") html.classList.add("font-" + font);
  updateFontSwatches(font || "default");
}

function applyPattern(pattern) {
  const html = document.documentElement;
  html.classList.remove(...PATTERN_CLASSES);
  if (pattern && pattern !== "none") html.classList.add("bg-" + pattern);
  updatePatternSwatches(pattern || "none");
}

function selectFont(font) {
  applyFont(font);
  localStorage.setItem("grateful-font", font);
  showToast(`✍️ 글꼴을 변경했어요`);
}

function selectPattern(pattern) {
  applyPattern(pattern);
  localStorage.setItem("grateful-pattern", pattern);
  const labels = { none:"기본", floral:"꽃잎", stars:"별빛", dots:"점선", grid:"격자", wave:"물결" };
  showToast(`🌸 ${labels[pattern]||pattern} 배경으로 꾸몄어요`);
}

function updateFontSwatches(font) {
  ["default","nanum-m","nanum-g","gowun-d","gowun-b","gaegu"].forEach(f => {
    const el = document.getElementById("fswatch-" + f);
    if (el) el.classList.toggle("active", f === font);
  });
}

function updatePatternSwatches(pattern) {
  ["none","floral","stars","dots","grid","wave"].forEach(p => {
    const el = document.getElementById("pswatch-" + p);
    if (el) el.classList.toggle("active", p === pattern);
  });
}

function initFontDecor() {
  const font    = localStorage.getItem("grateful-font")    || "default";
  const pattern = localStorage.getItem("grateful-pattern") || "none";
  applyFont(font);
  applyPattern(pattern);
}

// 탭 전환
function switchDecorTab(tab) {
  ["theme","font","bg"].forEach(t => {
    document.getElementById("dtab-" + t)?.classList.toggle("active", t === tab);
    document.getElementById("dpanel-" + t)?.classList.toggle("active", t === tab);
  });
  // 현재 선택 반영
  if (tab === "font") {
    updateFontSwatches(localStorage.getItem("grateful-font") || "default");
  } else if (tab === "bg") {
    updatePatternSwatches(localStorage.getItem("grateful-pattern") || "none");
  }
}

// ── AI 테마 추천 (Claude API) ──
let aiThemeLoading = false; // 중복 호출 방지
async function recommendTheme() {
  if (aiThemeLoading) return; // Bug 2 fix: 중복 탭 방지
  aiThemeLoading = true;
  const btn = document.getElementById("aiThemeBtn");
  if (btn) btn.classList.add("loading");

  // 추천 컨텍스트 수집
  const hour = new Date().getHours();
  const streak = calcStreak();
  const history = getHistory();
  const totalDays = Object.keys(history).length;
  const currentTheme   = localStorage.getItem("grateful-theme") || "sepia";
  const currentFont    = localStorage.getItem("grateful-font")    || "default";
  const currentPattern = localStorage.getItem("grateful-pattern") || "none";
  const recentMoods = Object.entries(history)
    .sort((a,b) => b[0].localeCompare(a[0]))
    .slice(0, 7)
    .map(([,v]) => v.mood).filter(Boolean);
  const moodSummary = recentMoods.length > 0
    ? recentMoods.slice(0,3).join(", ")
    : "기록 없음";

  const timeOfDay = hour < 6 ? "새벽" : hour < 11 ? "오전" : hour < 14 ? "점심" : hour < 18 ? "오후" : hour < 22 ? "저녁" : "밤";
  const fontLabels = { default:"기본(노토세리프)", "nanum-m":"나눔명조", "nanum-g":"나눔고딕", "gowun-d":"고운돋움", "gowun-b":"고운바탕", gaegu:"개구체(손글씨)" };
  const patternLabels = { none:"없음", floral:"꽃잎", stars:"별빛", dots:"점선", grid:"격자", wave:"물결" };

  const prompt = `당신은 감성 UX 디자이너입니다. 사용자의 상황을 분석하고 감사노트 앱의 테마, 폰트, 배경 패턴을 종합적으로 추천해주세요.

현재 상황:
- 시각: ${hour}시 (${timeOfDay})
- 연속 기록: ${streak}일 / 총 기록일: ${totalDays}일
- 최근 기분: ${moodSummary}
- 현재 설정: 테마=${THEME_META[currentTheme]?.label||currentTheme}, 폰트=${fontLabels[currentFont]||currentFont}, 패턴=${patternLabels[currentPattern]||currentPattern}

선택 가능한 옵션:
테마: sepia(웜세피아), ios-white(iOS화이트), matcha(말차그린), sunset(선셋오렌지)
폰트: default(기본), nanum-m(나눔명조), nanum-g(나눔고딕), gowun-d(고운돋움), gowun-b(고운바탕), gaegu(손글씨)
패턴: none(없음), floral(꽃잎), stars(별빛), dots(점선), grid(격자), wave(물결)

JSON 형식으로만 응답하세요:
{"theme":"값","font":"값","pattern":"값","reason":"2~3문장 한국어 추천 이유 (감성·눈건강 관점)"}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }]
      })
    });

    if (!response.ok) throw new Error("API 오류");
    const data = await response.json();
    const raw = data.content?.map(c => c.text || "").join("").trim();
    const clean = raw.replace(/```json|```/g,"").trim();
    const result = JSON.parse(clean);

    // 유효성 검증
    const validThemes   = ["sepia","ios-white","matcha","sunset"];
    const validFonts    = ["default","nanum-m","nanum-g","gowun-d","gowun-b","gaegu"];
    const validPatterns = ["none","floral","stars","dots","grid","wave"];
    const safeTheme = validThemes.includes(result.theme) ? result.theme : "sepia";
    const safeFont    = validFonts.includes(result.font)     ? result.font    : "default";
    const safePattern = validPatterns.includes(result.pattern) ? result.pattern : "none";

    // 모달 열기 (테마 탭)
    showThemePicker();
    switchDecorTab("theme");

    // AI 추천 결과 표시
    const res = document.getElementById("themeAiResult");
    const txt = document.getElementById("themeAiResultText");
    if (res && txt) {
      const fl = fontLabels[safeFont] || safeFont;
      const pl = patternLabels[safePattern] || safePattern;
      txt.innerHTML = `${escHtml(result.reason || "현재 상황에 맞는 설정을 추천드려요.")}<br>
        <span style="font-size:11px;color:var(--ink-faint);margin-top:6px;display:block">
          ✦ 폰트: ${fl} &nbsp;·&nbsp; 배경: ${pl}
        </span>`;
      res.classList.add("show");
    }
    // 스와치 하이라이트
    updateThemeSwatches(safeTheme);
    // 추천 폰트·패턴을 실제로 적용하지는 않고 안내만 (사용자 선택 우선)
    // 폰트·패턴 탭 스와치 미리 선택 표시만
    updateFontSwatches(safeFont);
    updatePatternSwatches(safePattern);

  } catch(e) {
    console.error("AI 추천 실패:", e);
    showToast("✦ 잠깐 — 테마를 직접 골라보세요!");
    showThemePicker();
  } finally {
    aiThemeLoading = false; // Bug 2 fix: 로딩 상태 초기화
    if (btn) btn.classList.remove("loading");
  }
}

// ══════════════════════════════════════════
// 닉네임 모달
// ══════════════════════════════════════════
function showNicknameModal() {
  document.getElementById("nicknameModal").style.display = "flex";
  setTimeout(() => document.getElementById("nicknameInput").focus(), 300);
}
function saveNickname() {
  const val = (document.getElementById("nicknameInput").value || "").trim();
  if (!val) { showToast("이름을 입력해주세요 😊"); return; }
  setNicknameLS(val);
  document.getElementById("nicknameModal").style.display = "none";
  document.getElementById("nicknameInput").value = "";
  // userRef 갱신 후 클라우드 동기화
  updateUserRef(val);
  if (firebaseReady) {
    loadHistoryFromCloud().then(() => startUserHistoryListener());
  }
  render();
  showToast(`${val}님, 환영해요! 🌿`);
}
// 엔터키로 닉네임 저장
document.getElementById("nicknameInput").addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); saveNickname(); }
});

// 그룹 나가기 모달 — 바깥 클릭 시 닫기
document.getElementById("leaveGroupModal").addEventListener("click", function(e) {
  if (e.target === this) closeLeaveModal();
});

// ESC 키로 모달 닫기 + 수정 모드 취소
document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    closeLeaveModal();
    closeReminderModal();
    closeThemePicker();
    // 내 기록 수정 모드 취소
    if (histEditMode) cancelHistEdit();
  }
});


// 리마인더 모달 바깥 클릭 닫기
document.getElementById("reminderModal").addEventListener("click", function(e) {
  if (e.target === this) closeReminderModal();
});

// ══════════════════════════════════════════
// 토스트
// ══════════════════════════════════════════
let toastTimer = null;
let renderTimer = null; // render() 경쟁 조건 방지용 타이머
function showToast(msg, duration) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  if (msg.length > 20) t.classList.add("wrap");
  else t.classList.remove("wrap");
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), duration || 2800);
}

// ══════════════════════════════════════════
// ══════════════════════════════════════════
// 초기화
// ══════════════════════════════════════════
function init() {
  initTheme();
  initFontDecor();
  firebaseReady = initFirebase();
  if (firebaseReady) {
    // 닉네임이 있으면 즉시 클라우드 동기화 시작
    const nick = getNickname();
    // feedRef 초기화 (전역 공유 경로)
    feedRef = db.ref("grateful-feed");
    if (nick) {
      loadHistoryFromCloud().then(() => {
        startUserHistoryListener();
        startPrayerListener();
      });
    }
    // 오늘 공유 여부 복원
    sharedToday = getSharedKeys().includes(todayKey());
    startFeedListener();
  }

  const today = todayKey();
  document.getElementById("headerDate").textContent = formatDate(today);
  const vBadge = document.getElementById("headerVersion");
  if (vBadge) vBadge.textContent = `v${APP_VERSION}`;

  if (!getNickname()) showNicknameModal();

  const h = getHistory();
  if (h[today]) {
    const raw = h[today];
    state = {
      gratitude: Array.isArray(raw.gratitude) && raw.gratitude.length > 0
        ? [...raw.gratitude].filter((g,i,arr) => g || i < arr.length - 1).concat([""])
        : [""],
      mood: raw.mood ?? null,
      note: raw.note ?? "",
    };
    // 최소 1개, 최대 5개 유지
    if (state.gratitude.length === 0) state.gratitude = [""];
    if (state.gratitude.length > 5)  state.gratitude = state.gratitude.slice(0, 5);
    saved = true;
  }
    histSelectedDate = today;
  histCalYear  = new Date().getFullYear();
  histCalMonth = new Date().getMonth();

  // 데이터 가져오기 파일 선택 이벤트
  const importInput = document.getElementById("importFileInput");
  if (importInput) importInput.addEventListener("change", importData);

  updateStreak();
  ensureChallengeStarted(); // ← 챌린지 자동 시작 (7일부터)
  syncChallengeWithHistory(); // ← 기존 기록으로 챌린지 상태 동기화
  render();

  // PWA 설치 (Manifest 주입 + 설치 배너)
  initPwa();

  // 서비스 워커 초기화 (Web Push + 백그라운드 알림)
  initServiceWorker();

  // 매일 리마인더 스케줄 (SW 없을 때 폴백)
  scheduleReminder();
}

function updateStreak() {
  document.getElementById("streakBadge").textContent = `🔥 ${calcStreak()}일 연속`;
}

// ══════════════════════════════════════════
// 뷰 전환
// ══════════════════════════════════════════
function setView(v) {
  // 다른 탭으로 이동할 때 수정 모드 초기화
  if (v !== "history") histEditMode = false;
  currentView = v;
  document.querySelectorAll(".tab-btn").forEach((b, i) => {
    b.classList.toggle("active",
      (i===0 && v==="write") || (i===1 && v==="history") ||
      (i===2 && v==="prayer") || (i===3 && v==="feed")
    );
  });
  render();
}

function render() {
  const el = document.getElementById("mainContent");
  // CSS class 방식 전환 (JS 인라인 transition 제거 → 더 빠른 GPU 처리)
  el.classList.add("view-exit");
  el.classList.remove("view-enter");

  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
      if (currentView === "write")          el.innerHTML = renderWrite();
      else if (currentView === "history")   el.innerHTML = renderHistory();
      else if (currentView === "prayer")    el.innerHTML = renderPrayer();
      else if (currentView === "feed")      el.innerHTML = renderFeed();
      // 공통 하단 버전 푸터
      el.innerHTML += `<div class="app-footer">Grateful <span>v${APP_VERSION}</span> · ${APP_BUILD}<br>Made with 🌿 for a more thankful day</div>`;
      attachListeners();
      updateSwipeHints();
      renderNotifBtn();
      // exit class 제거 후 enter → requestAnimationFrame으로 repaint 보장
      el.classList.remove("view-exit");
      requestAnimationFrame(() => {
        el.classList.add("view-enter");
      });
    }, 40);
}

// ══════════════════════════════════════════
// 스와이프 탭 전환
// ══════════════════════════════════════════
const VIEWS = ["write", "history", "prayer", "feed"];

function updateSwipeHints() {
  const idx = VIEWS.indexOf(currentView);
  const hintL = document.getElementById("swipeLeft");
  const hintR = document.getElementById("swipeRight");
  if (hintL) hintL.style.display = idx > 0 ? "block" : "none";
  if (hintR) hintR.style.display = idx < VIEWS.length - 1 ? "block" : "none";
}

(function initSwipe() {
  let startX = 0, startY = 0, startTime = 0;
  let tracking = false; // 스와이프 추적 중 여부
  let hintTimer = null;

  function showHint(dir) {
    const id = dir === "left" ? "swipeLeft" : "swipeRight";
    const el = document.getElementById(id);
    if (!el || el.style.display === "none") return;
    el.classList.add("show");
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => el.classList.remove("show"), 600);
  }

  document.addEventListener("touchstart", e => {
    // 모달이 열려있으면 스와이프 무시
    const modals = ["nicknameModal","leaveGroupModal","reminderModal","themePickerModal"];
    if (modals.some(id => {
      const el = document.getElementById(id);
      return el && el.style.display !== "none";
    })) { tracking = false; return; }

    // SELECT는 완전 차단 (드롭다운 오작동 방지)
    if (e.target.tagName === "SELECT") { tracking = false; return; }

    // INPUT, TEXTAREA도 터치 시작 좌표는 기록 (수평 스와이프면 탭 전환)
    startX    = e.touches[0].clientX;
    startY    = e.touches[0].clientY;
    startTime = Date.now();
    tracking  = true;
  }, { passive: true });

  document.addEventListener("touchmove", e => {
    if (!tracking) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    // 수직 스크롤이 더 크면 스와이프 추적 중단
    if (Math.abs(dy) > Math.abs(dx) * 1.5) { tracking = false; return; }
    // 힌트 표시 (15px부터)
    if (Math.abs(dx) > 15) showHint(dx < 0 ? "right" : "left");
  }, { passive: true });

  document.addEventListener("touchend", e => {
    if (!tracking) return;
    tracking = false;

    const dx  = e.changedTouches[0].clientX - startX;
    const dy  = e.changedTouches[0].clientY - startY;
    const dt  = Date.now() - startTime;
    const tag = e.target.tagName;

    const fast = dt < 600;           // 600ms 이내 → 빠른 스와이프
    const far  = Math.abs(dx) > 40;  // 40px 이상 → 충분히 먼 스와이프

    // 수직 이동이 수평보다 1.5배 이상 크면 스크롤로 판단, 무시
    if (Math.abs(dy) > Math.abs(dx) * 1.5) return;
    if (!fast && !far) return;
    if (Math.abs(dx) < 25) return; // 절대 최소 25px

    // INPUT/TEXTAREA 위에서는 수평 이동이 확실할 때만 (50px 이상) 탭 전환
    // → 커서 이동과 스와이프 혼동 방지
    if ((tag === "INPUT" || tag === "TEXTAREA") && Math.abs(dx) < 50) return;

    const idx = VIEWS.indexOf(currentView);
    if (dx < 0 && idx < VIEWS.length - 1) {
      setView(VIEWS[idx + 1]); // 왼쪽 스와이프 → 다음 탭
    } else if (dx > 0 && idx > 0) {
      setView(VIEWS[idx - 1]); // 오른쪽 스와이프 → 이전 탭
    }
  }, { passive: true });

  // 터치 취소 시 추적 초기화
  document.addEventListener("touchcancel", () => { tracking = false; }, { passive: true });
})();

// ══════════════════════════════════════════
// 오늘 쓰기
// ══════════════════════════════════════════
function renderWrite() {
  const filled = state.gratitude.filter(Boolean).length;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "오늘 하루도 따뜻하게 시작해요 ☀️"
                 : hour < 18 ? "오늘 하루 어땠나요? 🌿"
                 : "오늘 하루 수고 많았어요 🌙";

  const moodBtns = MOODS.map(m =>
    `<button class="mood-btn ${state.mood===m.label?"selected":""}" onclick="selectMood('${m.label}')">
      <span class="mood-emoji">${m.emoji}</span>
      <span class="mood-label">${m.label}</span>
    </button>`
  ).join("");

  // 동적 감사 항목 (1개 시작, +추가 버튼으로 최대 5개)
  const gItems = state.gratitude.map((val, i) => {
    const hint = todayHints[i] || PROMPTS[i % PROMPTS.length];
    return `<div class="g-item" id="gitem${i}" style="animation:fadeSlideIn 0.3s ease ${i*0.06}s both">
      <div class="g-num ${val?"filled":""}" id="gnum${i}">${i+1}</div>
      <textarea class="g-textarea" id="gtext${i}" rows="2" placeholder="${hint}">${escHtml(val)}</textarea>
    </div>`;
  }).join("");

  const canAdd = state.gratitude.length < 5;
  const addBtn = canAdd
    ? `<button class="add-item-btn" onclick="addGratitudeItem()">＋ 하나 더 추가하기</button>`
    : "";

  const totalSlots = state.gratitude.length;
  const dots = Array.from({length: totalSlots}, (_,i) =>
    `<div class="dot ${i<filled?"filled":""}"></div>`).join("");

  // 공유 버튼 상태 결정
  const alreadyShared = sharedToday || getSharedKeys().includes(todayKey());
  const hasContent    = state.gratitude.some(g => g && g.trim());
  let shareBtnHtml = "";
  if (alreadyShared) {
    shareBtnHtml = `<button class="share-btn shared" onclick="showToast('오늘은 이미 공유했어요 ✦')">✦ 오늘 그룹에 공유됨</button>`;
  } else if (!firebaseReady) {
    shareBtnHtml = `<button class="share-btn share-btn-dim" onclick="showToast('Firebase 연결 중이에요. 잠시 후 다시 시도해주세요 🌿')">🌿 그룹에 공유하기</button>`;
  } else if (!hasContent) {
    shareBtnHtml = `<button class="share-btn share-btn-dim" onclick="showToast('감사한 내용을 먼저 입력해주세요 ✦')">🌿 그룹에 공유하기</button>`;
  } else {
    shareBtnHtml = `<button class="share-btn" onclick="openShareModal()">🌿 그룹에 공유하기</button>`;
  }

  return `
    <div style="text-align:center;font-size:12.5px;color:var(--brown-faint);margin:2px 0 14px;font-style:italic;letter-spacing:0.3px;animation:fadeSlideIn 0.4s ease">${greeting}</div>
    ${renderThrowback()}
    <div class="card">
      <div class="card-label">오늘 기분은?</div>
      <div class="mood-row">${moodBtns}</div>
    </div>
    <div class="card">
      <div class="card-label">오늘 감사한 것 <span style="color:var(--brown-faint);font-weight:400">(최대 5가지)</span></div>
      ${gItems}
      ${addBtn}
      <div class="dots" style="margin-top:16px">${dots}</div>
    </div>
    <div class="card">
      <div class="card-label">한 줄 메모 <span class="card-label-opt">(선택)</span></div>
      <textarea class="note-textarea" id="noteText" rows="2" placeholder="오늘 하루를 한 줄로...">${escHtml(state.note)}</textarea>
    </div>
    <button class="save-btn ${saved?"saved":""}" id="saveBtn" onclick="doSave()">
      ${saved ? "✓  저장됨" : "저장하기"}
    </button>
    ${shareBtnHtml}
  `;
}

// ══════════════════════════════════════════
// 내 기록 — 캘린더 + 일별/주별 뷰
// ══════════════════════════════════════════
function renderHistory() {
  const h       = getHistory();
  const today   = todayKey();
  const selDate = histSelectedDate || today;

  // ── 통계 ──
  const allDays = Object.keys(h).sort().reverse();
  const days    = allDays.filter(d => h[d] && Array.isArray(h[d].gratitude) && h[d].gratitude.some(Boolean));
  const total   = days.length;
  const streak  = calcStreak();
  const moodCounts = {};
  allDays.forEach(d => { if (h[d]?.mood) moodCounts[h[d].mood] = (moodCounts[h[d].mood]||0)+1; });
  const topMood = Object.entries(moodCounts).sort((a,b)=>b[1]-a[1])[0];
  const topMoodEmoji = topMood ? (MOODS.find(m=>m.label===topMood[0])?.emoji||"—") : "—";

  // ── 데이터 이전 배너 (기록이 없을 때만 표시) ──
  const transferBanner = days.length === 0 ? `
    <div class="data-transfer-banner">
      <div class="data-transfer-title">📦 기존 기록을 가져오려면?</div>
      <div class="data-transfer-desc">
        브라우저/기기가 바뀌면 기록이 보이지 않아요.<br>
        이전 환경에서 <b>내보내기</b>로 저장 후,<br>여기서 <b>가져오기</b>로 불러오세요.
      </div>
      <div class="data-transfer-btns">
        <button class="data-export-btn" onclick="exportData()">⬇ 내보내기</button>
        <button class="data-import-btn" onclick="document.getElementById('importFileInput').click()">⬆ 가져오기</button>
      </div>
    </div>` : `
    <div style="display:flex;justify-content:flex-end;margin-bottom:8px;gap:6px">
      <button onclick="exportData()" style="background:transparent;border:1.5px solid var(--border);border-radius:10px;padding:5px 12px;font-size:11px;color:var(--brown-light);font-family:inherit;cursor:pointer;">⬇ 내보내기</button>
      <button onclick="document.getElementById('importFileInput').click()" style="background:transparent;border:1.5px solid var(--border);border-radius:10px;padding:5px 12px;font-size:11px;color:var(--brown-light);font-family:inherit;cursor:pointer;">⬆ 가져오기</button>
    </div>`;

  const statsHtml = `
    <div class="stats-row">
      <div class="stat-card"><div class="stat-num">${total}</div><div class="stat-label">총 기록일</div></div>
      <div class="stat-card"><div class="stat-num">${streak}</div><div class="stat-label">연속일</div></div>
      <div class="stat-card"><div class="stat-num">${topMoodEmoji}</div><div class="stat-label">자주 느끼는 기분</div></div>
    </div>`;

  // ── 월 캘린더 (월 이동 가능) ──
  const year  = histCalYear;
  const month = histCalMonth;
  const firstDay    = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  let calCells = "";
  DAY_LABELS.forEach(l => { calCells += `<div class="cal-day-label">${l}</div>`; });
  for (let i = 0; i < firstDay; i++) calCells += `<div class="cal-dot empty"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const k        = `${year}-${String(month+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    const hasEntry = !!(h[k] && Array.isArray(h[k].gratitude) && h[k].gratitude.some(Boolean));
    const isToday  = k === today;
    const isSel    = k === selDate;
    calCells += `<div class="cal-dot ${hasEntry?"has-entry":""} ${isToday?"today":""} ${isSel?"selected":""}"
      onclick="selectHistDay('${k}')">${d}</div>`;
  }

  const calHtml = `
    <div class="card">
      <div class="cal-nav">
        <button class="cal-nav-btn" onclick="moveCalMonth(-1)">‹</button>
        <div class="card-label">${year}년 ${month+1}월</div>
        <button class="cal-nav-btn" onclick="moveCalMonth(1)">›</button>
      </div>
      <div class="cal-grid">${calCells}</div>
    </div>`;

  // ── 모드 토글 ──
  const modeToggle = `
    <div class="hist-mode-row" id="histContent">
      <button class="hist-mode-btn ${histMode==="day"?"active":""}" onclick="setHistMode('day')">일별 보기</button>
      <button class="hist-mode-btn ${histMode==="week"?"active":""}" onclick="setHistMode('week')">주별 보기</button>
    </div>`;

  // ── 콘텐츠 ──
  const contentHtml = histMode === "day" ? renderDayDetail(h, selDate) : renderWeekView(h, selDate);

  return transferBanner + statsHtml + renderRewind(h) + calHtml + modeToggle + contentHtml + `
    <div class="card" style="margin-top:14px">
      <div class="card-label" style="margin-bottom:12px;display:flex;justify-content:space-between;align-items:center">
        <span>📅 챌린지 현황</span>
        <button onclick="setView('prayer')" style="font-size:11px;color:var(--terra);background:none;border:none;cursor:pointer;font-family:inherit;">🙏 기도노트 →</button>
      </div>
      ${renderChallengeCompact()}
    </div>`;
}

// ── 일별 상세 ──
function renderDayDetail(h, dateKey) {
  const e = h[dateKey];
  const hasEntry = e && Array.isArray(e.gratitude) && e.gratitude.some(Boolean);

  if (!hasEntry) {
    const isToday = dateKey === todayKey();
    return `
      <div class="card">
        <div class="day-detail-header">
          <div class="day-detail-date">${formatDate(dateKey)}</div>
        </div>
        <div class="day-empty">
          ${isToday ? "오늘 아직 기록이 없어요.<br>감사한 것을 적어보세요 ✦" : "이날은 기록이 없어요."}
        </div>
      </div>`;
  }

  const moodEmoji = e.mood ? (MOODS.find(m=>m.label===e.mood)?.emoji||"") : "";

  // ── 수정 모드 ──
  if (histEditMode && histSelectedDate === dateKey) {
    const moodBtns = MOODS.map(m =>
      `<button class="mood-btn ${e.mood === m.label ? "selected" : ""}" style="flex:1;padding:7px 2px"
        onclick="histEditMood('${dateKey}','${m.label}')">
        <span class="mood-emoji" style="font-size:18px">${m.emoji}</span>
        <span class="mood-label" style="font-size:9px">${m.label}</span>
      </button>`
    ).join("");
    const gTas = e.gratitude.filter(Boolean).map((g, i) =>
      `<div class="g-item">
        <div class="g-num filled">${i+1}</div>
        <textarea class="g-textarea hist-edit-ta" id="hedit_g${i}" rows="2">${escHtml(g)}</textarea>
      </div>`
    ).join("");
    const noteTa = `<textarea class="note-textarea" id="hedit_note" rows="2" placeholder="한 줄 메모...">${escHtml(e.note||"")}</textarea>`;
    return `
      <div class="card" style="border-color:var(--terra)">
        <div class="day-detail-header">
          <div class="day-detail-date">${formatDate(dateKey)}</div>
          <button class="edit-btn" onclick="cancelHistEdit()">✕ 취소</button>
        </div>
        <div style="margin-bottom:8px">
          <div class="card-label" style="margin-bottom:8px">기분</div>
          <div style="display:flex;gap:6px">${moodBtns}</div>
        </div>
        <div class="card-label" style="margin:14px 0 0">감사한 것</div>
        ${gTas}
        <div class="card-label" style="margin:14px 0 4px">메모</div>
        ${noteTa}
        <button class="edit-save-btn" onclick="saveHistEdit('${dateKey}')">✓ 수정 저장</button>
      </div>`;
  }

  // ── 읽기 모드 ──
  const gRows = e.gratitude.filter(Boolean).map(g =>
    `<div class="h-g-item"><span class="h-bullet">✦</span><span class="h-text">${escHtml(g)}</span></div>`
  ).join("");
  const noteRow = e.note ? `<div class="h-note">"${escHtml(e.note)}"</div>` : "";

  return `
    <div class="card">
      <div class="day-detail-header">
        <div class="day-detail-date">${formatDate(dateKey)}</div>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="day-detail-mood">${moodEmoji}</span>
          <button class="edit-btn" onclick="startHistEdit('${dateKey}')">✏️ 수정</button>
        </div>
      </div>
      ${gRows}${noteRow}
    </div>`;
}

function startHistEdit(dateKey) {
  histEditMode = true;
  histSelectedDate = dateKey;
  render();
}
function cancelHistEdit() {
  histEditMode = false;
  render();
}
function histEditMood(dateKey, moodLabel) {
  const h = getHistory();
  if (!h[dateKey]) return;
  h[dateKey].mood = h[dateKey].mood === moodLabel ? null : moodLabel;
  h[dateKey].updatedAt = Date.now(); // ✅ 수정: updatedAt 갱신
  saveHistory(h);
  syncDayToCloud(dateKey, h[dateKey]); // ✅ 수정: 클라우드 동기화
  // 버튼 UI만 갱신
  document.querySelectorAll(".mood-btn").forEach(btn => {
    btn.classList.toggle("selected", btn.querySelector(".mood-label")?.textContent === h[dateKey].mood);
  });
}
function saveHistEdit(dateKey) {
  const h = getHistory();
  if (!h[dateKey]) return;
  // 감사 항목
  const newG = [];
  document.querySelectorAll(".hist-edit-ta").forEach(ta => { if(ta.value.trim()) newG.push(ta.value.trim()); });
  if (newG.length === 0) { showToast("감사 항목을 하나 이상 입력해주세요 ✦"); return; }
  const noteEl = document.getElementById("hedit_note");
  h[dateKey].gratitude = newG;
  h[dateKey].note = noteEl ? noteEl.value.trim() : h[dateKey].note;
  h[dateKey].updatedAt = Date.now(); // ✅ 수정: updatedAt 갱신
  saveHistory(h);
  syncDayToCloud(dateKey, h[dateKey]); // ✅ 수정: 클라우드 동기화
  histEditMode = false;
  showToast("수정했어요 ✦");
  render();
}

// ── 주별 뷰 ──
function renderWeekView(h, selDate) {
  // selDate가 속한 주의 일요일 구하기
  const sel  = new Date(selDate + "T00:00:00");
  const dow  = sel.getDay(); // 0=일
  const sun  = new Date(sel); sun.setDate(sel.getDate() - dow);
  const sat  = new Date(sun); sat.setDate(sun.getDate() + 6);
  const today = todayKey();

  const sunStr = localDateStr(sun);
  const satStr = localDateStr(sat);

  // 주간 날짜 7개
  const weekDays = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(sun); d.setDate(sun.getDate() + i);
    weekDays.push(localDateStr(d));
  }

  const weekLabel = `${formatDateShort(sunStr)} ~ ${formatDateShort(satStr)}`;

  // 7일 버튼 스트립
  const strip = weekDays.map(k => {
    const dayNum   = new Date(k+"T00:00:00").getDate();
    const dayLabel = DAY_LABELS[new Date(k+"T00:00:00").getDay()];
    const hasEntry = !!(h[k] && Array.isArray(h[k].gratitude) && h[k].gratitude.some(Boolean));
    const isSel    = k === selDate;
    const isTdy    = k === today;
    return `
      <button class="week-day-btn ${hasEntry?"has-entry":""} ${isSel?"selected":""} ${isTdy?"is-today":""}"
        onclick="selectHistDay('${k}')">
        <span class="wdb-label">${dayLabel}</span>
        <span class="wdb-num">${dayNum}</span>
        <span class="wdb-dot ${hasEntry?"":"hidden"}"></span>
      </button>`;
  }).join("");

  // 이 주의 기록된 날들 전부 표시
  const entries = weekDays
    .filter(k => h[k] && Array.isArray(h[k].gratitude) && h[k].gratitude.some(Boolean))
    .map(k => {
      const e = h[k];
      const moodEmoji = e.mood ? (MOODS.find(m=>m.label===e.mood)?.emoji||"") : "";
      const gRows = e.gratitude.filter(Boolean).map(g =>
        `<div class="h-g-item"><span class="h-bullet">✦</span><span class="h-text">${escHtml(g)}</span></div>`
      ).join("");
      const noteRow = e.note ? `<div class="h-note">"${escHtml(e.note)}"</div>` : "";
      const isSelDay = k === selDate;
      return `
        <div class="card" style="${isSelDay?"border-color:var(--terra);":""}" onclick="selectHistDay('${k}')">
          <div class="h-date">
            <span>${formatDate(k)}</span>
            <span class="h-mood">${moodEmoji}</span>
          </div>
          ${gRows}${noteRow}
        </div>`;
    });

  const entriesHtml = entries.length === 0
    ? `<div class="day-empty" style="padding:30px 0">이번 주에는 아직 기록이 없어요. ✦</div>`
    : entries.join("");

  return `
    <div class="week-nav">
      <button class="week-nav-btn" onclick="moveWeek(-1)">← 이전 주</button>
      <div class="week-label">${weekLabel}</div>
      <button class="week-nav-btn" onclick="moveWeek(1)">다음 주 →</button>
    </div>
    <div class="week-strip">${strip}</div>
    ${entriesHtml}`;
}

function selectHistDay(dateKey) {
  histEditMode = false; // 다른 날짜 클릭 시 수정 모드 초기화
  histSelectedDate = dateKey;
  // 캘린더 월도 선택된 날짜의 달로 이동
  const d = new Date(dateKey + "T00:00:00");
  histCalYear  = d.getFullYear();
  histCalMonth = d.getMonth();
  render();
  // 컨텐츠 영역으로 부드럽게 스크롤
  setTimeout(() => {
    const el = document.getElementById("histContent");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 50);
}

function setHistMode(mode) {
  histMode = mode;
  render();
}

function moveCalMonth(delta) {
  const now = new Date();
  // ✅ 수정: 연도 롤오버를 양방향으로 정확히 계산
  let nextYear  = histCalYear;
  let nextMonth = histCalMonth + delta;
  if (nextMonth > 11) { nextMonth = 0;  nextYear++; }
  if (nextMonth < 0)  { nextMonth = 11; nextYear--; }
  // 미래 달 이동 차단
  if (nextYear > now.getFullYear() || (nextYear === now.getFullYear() && nextMonth > now.getMonth())) return;
  histCalYear  = nextYear;
  histCalMonth = nextMonth;
  render();
}

function moveWeek(delta) {
  const d = new Date(histSelectedDate + "T00:00:00");
  d.setDate(d.getDate() + delta * 7);
  // 미래 주 이동 차단
  const todayDate = new Date(todayKey() + "T00:00:00");
  if (d > todayDate) return;
  histSelectedDate = localDateStr(d);
  histCalYear  = d.getFullYear();
  histCalMonth = d.getMonth();
  render();
}


function getWeekRange(offset) {
  const today = new Date();
  const dow = today.getDay();
  const sun = new Date(today);
  sun.setDate(today.getDate() - dow + offset * 7);
  const sat = new Date(sun);
  sat.setDate(sun.getDate() + 6);
  return { start: localDateStr(sun), end: localDateStr(sat) };
}// ══════════════════════════════════════════
// 이벤트
// ══════════════════════════════════════════
function attachListeners() {
  state.gratitude.forEach((_, i) => {
    const ta = document.getElementById(`gtext${i}`);
    if (!ta) return;
    ta.addEventListener("input", () => {
      state.gratitude[i] = ta.value;
      saved = false;
      const num = document.getElementById(`gnum${i}`);
      if (num) num.className = `g-num ${ta.value?"filled":""}`;
      const filled = state.gratitude.filter(Boolean).length;
      document.querySelectorAll(".dot").forEach((d,idx) => d.classList.toggle("filled", idx<filled));
      // 저장 버튼 초기화
      const saveBtn = document.getElementById("saveBtn");
      if (saveBtn && saveBtn.classList.contains("saved")) {
        saveBtn.textContent = "저장하기"; saveBtn.classList.remove("saved");
      }
    });
  });
  const noteEl = document.getElementById("noteText");
  if (noteEl) noteEl.addEventListener("input", () => {
    state.note = noteEl.value.trim(); saved = false;
    const saveBtn = document.getElementById("saveBtn");
    if (saveBtn && saveBtn.classList.contains("saved")) {
      saveBtn.textContent = "저장하기"; saveBtn.classList.remove("saved");
    }
  });
}

// ══════════════════════════════════════════
function addGratitudeItem() {
  if (state.gratitude.length >= 5) return;
  state.gratitude.push("");
  
  // 저장 버튼만 "저장하기"로 복원 (추가 항목이 미저장 상태임을 표시)
  const prevSaved = saved;
  saved = false;
  const el = document.getElementById("mainContent");
  if (el) {
    el.innerHTML = renderWrite();
    el.innerHTML += `<div class="app-footer">Grateful <span>v${APP_VERSION}</span> · ${APP_BUILD}<br>Made with 🌿 for a more thankful day</div>`;
    attachListeners();
    
    // 새로 추가된 마지막 textarea에 포커스
    const last = document.getElementById(`gtext${state.gratitude.length - 1}`);
    if (last) setTimeout(() => last.focus(), 50);
  }
}

function selectMood(label) {
  state.mood = state.mood === label ? null : label;
  saved = false;
  document.querySelectorAll(".mood-btn").forEach((btn,i) => {
    btn.classList.toggle("selected", MOODS[i].label === state.mood);
  });
  // 저장버튼 텍스트 초기화 (저장됨 → 저장하기)
  const btn = document.getElementById("saveBtn");
  if (btn) { btn.textContent = "저장하기"; btn.classList.remove("saved"); }
}

function doSave() {
  // ✅ 수정: 저장 직전 DOM에서 최신 값 동기화 (빠른 입력 후 즉시 저장 시 stale state 방지)
  const noteEl = document.getElementById("noteText");
  if (noteEl) state.note = noteEl.value.trim();
  state.gratitude.forEach((_, i) => {
    const ta = document.getElementById(`gtext${i}`);
    if (ta) state.gratitude[i] = ta.value;
  });

  // 빈 항목 정리 (마지막 빈 칸 제외하고 중간 빈 칸만 정리)
  const trimmed = state.gratitude.filter((g, i, arr) => g || i === arr.length - 1);
  if (trimmed.length === 0) trimmed.push("");

  const h = getHistory();
  h[todayKey()] = { gratitude: trimmed, mood: state.mood, note: state.note, updatedAt: Date.now() };
  saveHistory(h);
  state.gratitude = trimmed;
  saved = true;
  updateStreak();
  syncChallengeWithHistory();

  // ☁ 클라우드 동기화
  syncDayToCloud(todayKey(), h[todayKey()]);
  const btn = document.getElementById("saveBtn");
  if (btn) { btn.textContent = "✓  저장됨"; btn.classList.add("saved"); }

  spawnHearts();

  // 챌린지 체크인 완료 알림
  const cState = getChallengeState();
  const wasChecked = (cState.checkins||[]).includes(todayKey());
  if (wasChecked) {
    const cStage = getCurrentStage(cState);
    const doneCount = (cState.checkins||[]).length;
    showToast(`저장됨 ✦  챌린지 ${doneCount}/${cStage.days}일 체크!`);
  } else {
    showToast("저장했어요 ✦");
  }
}

// ── 하트 파티클 ──
function spawnHearts() {
  const btn = document.getElementById("saveBtn");
  if (!btn) return;
  const rect = btn.getBoundingClientRect();
  const emojis = ["🌸","✦","🌿","♡","✿"];
  for (let i = 0; i < 7; i++) {
    setTimeout(() => {
      const el = document.createElement("div");
      el.className = "heart-particle";
      el.textContent = emojis[Math.floor(Math.random() * emojis.length)];
      const x = rect.left + Math.random() * rect.width;
      const y = rect.top + Math.random() * 20;
      el.style.left = x + "px";
      el.style.top  = y + "px";
      el.style.animationDelay = (Math.random() * 0.3) + "s";
      el.style.fontSize = (14 + Math.random() * 12) + "px";
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 1000);
    }, i * 70);
  }
}

// ══════════════════════════════════════════
// 그룹 나가기
// ══════════════════════════════════════════
function closeLeaveModal() {
  const m = document.getElementById("leaveGroupModal");
  if (m) m.style.display = "none";
}

function showLeaveGroupModal() {
  const myNick = getNickname();
  if (!myNick) { showToast("그룹에 참여 중이 아니에요."); return; }
  const nickEl = document.getElementById("leaveNickDisplay");
  if (nickEl) nickEl.textContent = myNick;
  document.getElementById("leaveGroupModal").style.display = "flex";
}

async function confirmLeaveGroup() {
  const btn = document.querySelector("#leaveGroupModal .modal-btn-danger");
  if (btn) { btn.disabled = true; btn.textContent = "처리 중…"; }
  try {
    // Firebase 실시간 리스너 및 ref 정리
    if (userListener && userRef) { userRef.off("value", userListener); userListener = null; }
    if (prayerListener && prayerRef) { prayerRef.off("value", prayerListener); prayerListener = null; }
    if (feedListener && feedRef) { feedRef.off("child_added", feedListener); feedListener = null; }
    userRef = null; prayerRef = null;
    localStorage.removeItem("grateful-shared");
    sharedToday = false;
    feedEntries = [];

    // 로컬 데이터 초기화
    localStorage.removeItem("grateful-nickname");
    localStorage.removeItem("grateful-history");
    localStorage.removeItem("grateful-prayer");

    closeLeaveModal();
    showToast("기록을 삭제하고 그룹을 나왔어요.");
    setView("write");
    setTimeout(() => showNicknameModal(), 600);
  } catch (err) {
    console.error("그룹 나가기 실패:", err);
    if (btn) { btn.disabled = false; btn.textContent = "나가기"; }
    showToast("삭제 중 오류가 발생했어요. 다시 시도해주세요.");
  }
}

// ══════════════════════════════════════════
function getNotifPref()    { return localStorage.getItem("grateful-notif") || "default"; }
function setNotifPref(val) { localStorage.setItem("grateful-notif", val); }

function isNotifSupported() {
  return "Notification" in window;
}

// content:// 또는 file:// 에서는 알림 불가 — 안내 메시지용
function isNotifBlocked() {
  const proto = location.protocol;
  return proto === "file:" || proto === "content:" || proto === "blob:";
}

function notifPermission() {
  if (!isNotifSupported()) return "denied";
  return Notification.permission;
}

// 알림 토글 버튼 클릭
async function toggleNotification() {
  if (!isNotifSupported()) {
    showToast("이 브라우저는 알림을 지원하지 않아요.");
    return;
  }

  // content:// / file:// 환경 — 배포 안내
  if (isNotifBlocked()) {
    showToast("🌐 알림은 웹서버 배포 후 사용 가능해요", 4000);
    return;
  }

  const perm = notifPermission();

  if (perm === "granted" && getNotifPref() === "on") {
    setNotifPref("off");
    showToast("알림을 껐어요.");
    renderNotifBtn();
    return;
  }

  if (perm === "denied") {
    showToast("브라우저 설정 → 사이트 권한에서 알림을 허용해주세요.", 4000);
    return;
  }

  try {
    const result = await Notification.requestPermission();
    if (result === "granted") {
      setNotifPref("on");
      showToast("🔔 새 공유 글 알림이 켜졌어요!");
      renderNotifBtn();
    } else {
      setNotifPref("off");
      showToast("알림 권한이 거부됐어요.");
      renderNotifBtn();
    }
  } catch(e) {
    console.error("알림 권한 요청 실패:", e);
  }
}

function renderNotifBtn() {
  const btn = document.getElementById("notifBtn");
  if (!btn) return;
  const on = notifPermission() === "granted" && getNotifPref() === "on";
  btn.classList.toggle("on", on);
  btn.title = on ? "알림 켜짐 (탭하면 끄기)" : "알림 받기";
  // 선 표시: off 상태에서만
  const line = btn.querySelector(".notif-off-line");
  if (line) line.style.display = on ? "none" : "block";
}// ══════════════════════════════════════════
// PWA 홈 화면 추가 배너
// ══════════════════════════════════════════
// ══════════════════════════════════════════
// PWA — Manifest 동적 주입 + 설치 흐름
// ══════════════════════════════════════════
let _deferredInstallPrompt = null; // Android beforeinstallprompt 이벤트
let _isPwaInstalled = false;

// SVG 아이콘 (192, 512 두 사이즈)
const _PWA_ICON_192 = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 192 192'%3E%3Crect width='192' height='192' rx='44' fill='%23f9f5ef'/%3E%3Ctext x='96' y='136' text-anchor='middle' font-size='110'%3E🌿%3C/text%3E%3C/svg%3E";
const _PWA_ICON_512 = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'%3E%3Crect width='512' height='512' rx='116' fill='%23f9f5ef'/%3E%3Ctext x='256' y='360' text-anchor='middle' font-size='300'%3E🌿%3C/text%3E%3C/svg%3E";
const _PWA_ICON_MASK = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'%3E%3Crect width='512' height='512' fill='%23f9f5ef'/%3E%3Ctext x='256' y='360' text-anchor='middle' font-size='300'%3E🌿%3C/text%3E%3C/svg%3E";

function injectPwaManifest() {
  // 정적 manifest.json 사용 (GitHub Pages PWA 설치 호환)
  // head의 <link rel="manifest" href="./manifest.json"> 가 이미 존재함
}

function initPwa() {
  // Manifest 주입
  injectPwaManifest();

  // Standalone 감지
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
  _isPwaInstalled = isStandalone;

  if (isStandalone) {
    // 설치된 앱 모드 — 상태바 색상 테마에 맞게 조정
    _updatePwaThemeColor();
    return; // 설치 배너 불필요
  }

  // Android Chrome: beforeinstallprompt 대기
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    _deferredInstallPrompt = e;
    // 첫 방문이거나 배너 미닫음이면 3초 후 표시
    if (!localStorage.getItem('grateful-pwa-dismissed')) {
      setTimeout(() => _showInstallBanner('android'), 3000);
    }
  });

  // 설치 완료 감지
  window.addEventListener('appinstalled', () => {
    _isPwaInstalled = true;
    _deferredInstallPrompt = null;
    _hideInstallBanner();
    showToast('🌿 Grateful이 홈 화면에 설치됐어요!');
    // SW에 알림 발송 요청
    if (swReg?.active) swReg.active.postMessage({ type: 'PWA_INSTALLED' });
    localStorage.removeItem('grateful-pwa-dismissed');
  });

  // iOS Safari 감지 (standalone 아님)
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const dismissed = localStorage.getItem('grateful-pwa-dismissed');
  if (isIos && !dismissed) {
    setTimeout(() => _showInstallBanner('ios'), 3500);
  }
}

function _showInstallBanner(platform) {
  if (localStorage.getItem('grateful-pwa-dismissed')) return;
  const banner  = document.getElementById('pwaInstallBanner');
  const title   = document.getElementById('pwaBannerTitle');
  const desc    = document.getElementById('pwaBannerDesc');
  const btn     = document.getElementById('pwaInstallBtn');
  if (!banner) return;

  if (platform === 'ios') {
    if (title) title.textContent = '홈 화면에 추가하기';
    if (desc)  desc.textContent  = '하단 공유 버튼 → "홈 화면에 추가" 탭하세요';
    if (btn)   btn.textContent   = '방법 보기';
    btn?.addEventListener('click', _showIosGuide, { once: true });
  } else {
    if (title) title.textContent = '앱으로 설치하기';
    if (desc)  desc.textContent  = '홈 화면에 추가하면 더 빠르고 오프라인도 돼요';
    if (btn)   btn.textContent   = '설치';
  }
  banner.style.display = 'block';
}

function _hideInstallBanner() {
  const banner = document.getElementById('pwaInstallBanner');
  if (!banner) return;
  const inner = banner.querySelector('.pwa-install-banner');
  if (inner) {
    inner.style.opacity = '0';
    inner.style.transform = 'translateX(-50%) translateY(24px)';
    inner.style.transition = 'all 0.28s ease';
  }
  setTimeout(() => { banner.style.display = 'none'; }, 300);
}

async function triggerPwaInstall() {
  if (_deferredInstallPrompt) {
    _deferredInstallPrompt.prompt();
    const { outcome } = await _deferredInstallPrompt.userChoice;
    _deferredInstallPrompt = null;
    if (outcome === 'accepted') _hideInstallBanner();
  }
}

function dismissPwaBanner() {
  _hideInstallBanner();
  localStorage.setItem('grateful-pwa-dismissed', '1');
  // 7일 후 재표시
  setTimeout(() => localStorage.removeItem('grateful-pwa-dismissed'), 7 * 24 * 60 * 60 * 1000);
}

function _showIosGuide() {
  showToast('하단 □↑ 공유 버튼 → "홈 화면에 추가" 탭하세요', 5000);
}

// 테마에 맞춰 theme-color 메타 업데이트
function _updatePwaThemeColor() {
  const colors = {
    light: '#f9f5ef', dark: '#100a05',
    sepia: '#f2e3c6', aurora: '#050508', blue: '#0a0d14',
  };
  const cur = localStorage.getItem('grateful-theme') || 'light';
  const color = colors[cur] || '#f9f5ef';
  const meta = document.getElementById('metaThemeColor');
  if (meta) meta.content = color;
  // apple-touch-icon 아이콘 배경도 테마 반영
  const isDark = ['dark','aurora','blue'].includes(cur);
  const iconBg = isDark ? '%23100a05' : '%23f9f5ef';
  const iconEmoji = '🌿';
  const iconSvg = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 180 180'%3E%3Crect width='180' height='180' rx='40' fill='${iconBg}'/%3E%3Ctext x='90' y='125' text-anchor='middle' font-size='100'%3E${iconEmoji}%3C/text%3E%3C/svg%3E`;
  const appleIcon = document.getElementById('appleTouchIcon');
  if (appleIcon) appleIcon.href = iconSvg;
}

// ══════════════════════════════════════════
// 서비스 워커 등록 + Web Push
// ══════════════════════════════════════════
async function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  try {
    swReg = await navigator.serviceWorker.register('./sw.js', {
      scope: './',
      type: 'classic',
    });
    console.log('[SW] sw.js 등록됨:', swReg.scope);

    // 현재 페이지 URL을 SW에 캐시하도록 요청
    const sw = swReg.active || swReg.installing || swReg.waiting;
    if (sw) sw.postMessage({ type: 'CACHE_URL', url: location.href });

    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data?.type === 'CHECK_TODAY') {
        const today = todayKey();
        const h = getHistory();
        const hasRecord = !!(h[today]?.gratitude?.some(Boolean));
        e.ports[0]?.postMessage({ hasRecord });
      }
    });

    // Periodic Background Sync (Chrome Android)
    if ('periodicSync' in swReg) {
      try {
        const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
        if (status.state === 'granted') {
          await swReg.periodicSync.register('grateful-daily-reminder', {
            minInterval: 23 * 60 * 60 * 1000,
          });
        }
      } catch (_) { /* 미지원 무시 */ }
    }

    const pref = getReminderPref();
    if (pref.on) _postReminderToSW(pref);

    updateSwStatusBadge();
  } catch(e) {
    console.warn('[SW] 등록 실패, setTimeout 폴백 사용:', e.message);
    swReg = null;
    updateSwStatusBadge();
  }
}

// SW가 활성화될 때까지 대기 후 메시지 전송
function _getSWTarget() {
  if (!swReg) return null;
  return swReg.active || swReg.installing || swReg.waiting;
}

function _postReminderToSW(schedule) {
  const sw = _getSWTarget();
  if (!sw) return false;
  sw.postMessage({ type: schedule?.on ? 'SET_REMINDER' : 'CANCEL_REMINDER', schedule });
  return true;
}

async function testReminderNotif() {
  // 먼저 권한 확인
  if (!isNotifSupported()) { showToast("이 브라우저는 알림을 지원하지 않아요."); return; }
  if (notifPermission() !== 'granted') { showToast("알림 권한을 먼저 허용해주세요."); return; }

  // SW로 테스트 알림 전송
  const sw = _getSWTarget();
  if (sw) {
    sw.postMessage({ type: 'TEST_REMINDER' });
    showToast("🔔 테스트 알림을 보냈어요!");
  } else {
    // SW 없으면 Notification API 직접 사용
    try {
      new Notification('테스트 알림 🌿', { body: '알림이 정상 작동해요 ✦', tag: 'grateful-test' });
      showToast("🔔 테스트 알림을 보냈어요!");
    } catch(e) { showToast("알림 전송에 실패했어요."); }
  }
}

function updateSwStatusBadge() {
  const badge = document.getElementById('swStatusBadge');
  if (!badge) return;
  const active = !!(swReg?.active);
  badge.className = `sw-status-badge ${active ? 'active' : 'inactive'}`;
  badge.innerHTML = `<span class="sw-status-dot"></span>${
    active ? '백그라운드 알림 활성' : '백그라운드 알림 비활성'
  }`;
}

// ══════════════════════════════════════════
// 매일 리마인더
// ══════════════════════════════════════════
function getReminderPref() {
  try { return JSON.parse(localStorage.getItem("grateful-reminder") || "{}"); } catch { return {}; }
}
function saveReminderPref(obj) { localStorage.setItem("grateful-reminder", JSON.stringify(obj)); }

function showReminderModal() {
  const pref = getReminderPref();
  const toggle = document.getElementById("reminderToggle");
  const timeInput = document.getElementById("reminderTime");
  const timeRow = document.getElementById("reminderTimeRow");
  const testRow = document.getElementById("reminderTestRow");
  const blockedNotice = document.getElementById("notifBlockedNotice");
  if (toggle) toggle.checked = !!pref.on;
  if (timeInput) timeInput.value = pref.time || "21:00";
  if (timeRow) {
    timeRow.style.opacity = pref.on ? "1" : "0.4";
    timeRow.style.pointerEvents = pref.on ? "auto" : "none";
  }
  if (testRow) testRow.style.display = pref.on ? "block" : "none";
  if (blockedNotice) blockedNotice.style.display = isNotifBlocked() ? "block" : "none";
  updateSwStatusBadge();
  document.getElementById("reminderModal").style.display = "flex";
}

function closeReminderModal() {
  document.getElementById("reminderModal").style.display = "none";
  scheduleReminder();
}

function onReminderToggle(checked) {
  const pref = getReminderPref();
  pref.on = checked;
  saveReminderPref(pref);
  const timeRow = document.getElementById("reminderTimeRow");
  const testRow = document.getElementById("reminderTestRow");
  if (timeRow) {
    timeRow.style.opacity = checked ? "1" : "0.4";
    timeRow.style.pointerEvents = checked ? "auto" : "none";
  }
  if (testRow) testRow.style.display = checked ? "block" : "none";

  if (checked) {
    // content:// / file:// 환경 — 알림 불가 안내
    if (isNotifBlocked()) {
      showToast("🌐 알림은 웹서버 배포 후 사용 가능해요", 4000);
      document.getElementById("reminderToggle").checked = false;
      pref.on = false; saveReminderPref(pref);
      if (testRow) testRow.style.display = "none";
      if (timeRow) { timeRow.style.opacity = "0.4"; timeRow.style.pointerEvents = "none"; }
      return;
    }

    if (isNotifSupported() && notifPermission() !== "granted") {
      Notification.requestPermission().then(async result => {
        if (result !== "granted") {
          showToast("알림 권한을 허용해주세요");
          document.getElementById("reminderToggle").checked = false;
          pref.on = false; saveReminderPref(pref);
          if (testRow) testRow.style.display = "none";
          return;
        }
        if (!swReg) await initServiceWorker();
        _postReminderToSW(getReminderPref());
        scheduleReminder();
        updateSwStatusBadge();
      });
    } else {
      if (swReg) _postReminderToSW(pref);
      else initServiceWorker().then(() => _postReminderToSW(getReminderPref()));
      scheduleReminder();
    }
  } else {
    _postReminderToSW({ on: false });
    scheduleReminder();
  }
}

function saveReminderTime(val) {
  const pref = getReminderPref();
  pref.time = val;
  saveReminderPref(pref);
  // SW에 업데이트된 스케줄 전달
  if (pref.on) _postReminderToSW(pref);
  scheduleReminder();
}

let reminderTimer = null;
function scheduleReminder() {
  clearTimeout(reminderTimer);
  const pref = getReminderPref();
  if (!pref.on || !pref.time) return;
  if (!isNotifSupported() || notifPermission() !== "granted") return;

  // SW가 활성화된 경우 — SW에 스케줄 위임 (이미 _postReminderToSW에서 전달됨)
  // setTimeout 폴백은 항상 실행 (SW가 있어도 앱 열려있을 때 추가 보장)
  const [h, m] = (pref.time || "21:00").split(":").map(Number);
  const now = new Date();
  const target = new Date(now);
  target.setHours(h, m, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);

  reminderTimer = setTimeout(() => {
    const todayEntry = getHistory()[todayKey()];
    const hasRecord = todayEntry && Array.isArray(todayEntry.gratitude) && todayEntry.gratitude.some(Boolean);
    if (!hasRecord) {
      try {
        // SW가 있으면 SW로 알림 (더 신뢰성 있음)
        if (swReg?.active) {
          swReg.active.postMessage({ type: 'TEST_REMINDER' }); // TEST_REMINDER → 실제 알림
        } else {
          new Notification("오늘 감사 기록을 남겨보세요 🌿", {
            body: "하루의 따뜻한 순간들을 기억해요 ✦",
            icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><text y='26' font-size='28'>🌿</text></svg>",
            tag: "grateful-reminder",
          });
        }
      } catch(e) { console.error("리마인더 전송 실패:", e); }
    }
    scheduleReminder();
  }, target - now);
}

// ══════════════════════════════════════════
// 과거 회상 (Throwback)
// ══════════════════════════════════════════
function renderThrowback() {
  const h = getHistory();
  const today = new Date();
  const results = [];

  // 1년 전, 2년 전, 3년 전 체크
  [1, 2, 3].forEach(yearsAgo => {
    const d = new Date(today);
    d.setFullYear(d.getFullYear() - yearsAgo);
    const key = localDateStr(d);
    const e = h[key];
    if (e && Array.isArray(e.gratitude) && e.gratitude.some(Boolean)) {
      results.push({ key, entry: e, yearsAgo });
    }
  });

  if (results.length === 0) return "";

  const { key, entry, yearsAgo } = results[0]; // 가장 가까운 회상만 표시
  const moodEmoji = entry.mood ? (MOODS.find(m => m.label === entry.mood)?.emoji || "") : "";
  const items = entry.gratitude.filter(Boolean).slice(0, 3).map(g =>
    `<div class="throwback-item"><span class="throwback-dot">✦</span><span>${escHtml(g)}</span></div>`
  ).join("");
  const noteHtml = entry.note
    ? `<div class="throwback-note">"${escHtml(entry.note)}"</div>` : "";

  return `
    <div class="throwback-card">
      <div class="throwback-label">📅 ${yearsAgo}년 전 오늘 ${moodEmoji}</div>
      <div class="throwback-date">${formatDate(key)}</div>
      ${items}
      ${noteHtml}
    </div>`;
}

// ══════════════════════════════════════════
// 챌린지 데이터 (7일 → 21일 → 30일 순차 진행)
// ══════════════════════════════════════════
const CHALLENGE_STAGES = [
  {
    id: "week7",
    icon: "🌱",
    name: "7일 감사 씨앗",
    days: 7,
    desc: "일주일 동안 매일 감사를 기록해요",
    themes: [
      { title: "하나님께 감사", desc: "오늘 하나님께서 주신 은혜와 축복에 감사해요" },
      { title: "몸과 건강", desc: "건강하게 숨쉬고 움직일 수 있는 내 몸에 감사해요" },
      { title: "작은 기쁨", desc: "오늘 느낀 소소한 행복과 미소 짓게 한 순간을 찾아요" },
      { title: "배움과 성장", desc: "오늘 배운 것, 깨달은 것, 조금 더 나아진 나를 기록해요" },
      { title: "자연과 환경", desc: "바람, 햇살, 계절… 오늘 자연이 준 선물에 감사해요" },
      { title: "나 자신", desc: "오늘 잘 해낸 나, 노력한 나, 존재하는 나에게 감사해요" },
      { title: "7일 총정리", desc: "일주일 동안 가장 기억에 남는 감사 3가지를 돌아봐요" },
    ]
  },
  {
    id: "season21",
    icon: "🍂",
    name: "21일 습관 챌린지",
    days: 21,
    desc: "21일이면 습관이 만들어져요",
    themes: Array.from({length: 21}, (_, i) => ({
      title: `${i+1}일차 감사`,
      desc: ["가족", "친구", "건강", "음식", "날씨", "배움", "일/공부", "취미", "집", "자연",
             "과거", "현재", "미래", "나 자신", "선물", "웃음", "시간", "용기", "친절", "회복", "완주"][i] + "에 감사해요"
    }))
  },
  {
    id: "month30",
    icon: "🌸",
    name: "30일 감사 꽃길",
    days: 30,
    desc: "한 달 동안 감사 습관을 완성해요",
    themes: Array.from({length: 30}, (_, i) => {
      const t = [
        "첫날, 오늘 가장 감사한 것", "나를 웃게 만든 것",
        "내가 가진 것에 감사", "힘든 일에서 배운 것",
        "좋아하는 음식/공간", "소중한 사람 한 명",
        "내 몸이 해준 것", "작은 사치와 여유",
        "날씨/계절", "오늘의 우연한 행운",
        "예상치 못한 친절", "나의 강점",
        "좋아하는 취미", "가족",
        "지금 이 순간", "안전한 집",
        "배움의 기회", "오래된 추억",
        "내가 이겨낸 어려움", "친구",
        "무료로 누리는 것들", "꿈과 희망",
        "웃음을 준 것", "포용받은 경험",
        "자연의 아름다움", "나의 노력",
        "지금 건강", "용기 낸 순간",
        "영감을 준 것", "30일 완주! 나에게"
      ];
      return { title: `Day ${i+1}: ${t[i]}`, desc: "오늘의 테마로 감사를 기록해요 🌸" };
    })
  }
];

function getChallengeState() {
  try { return JSON.parse(localStorage.getItem("grateful-challenge") || "{}"); } catch { return {}; }
}
function saveChallengeState(s) { localStorage.setItem("grateful-challenge", JSON.stringify(s)); }

// 현재 진행 중인 스테이지 객체 반환
function getCurrentStage(s) {
  return CHALLENGE_STAGES.find(c => c.id === s.id) || CHALLENGE_STAGES[0];
}

// 챌린지 자동 시작 (앱 최초 실행 시)
function ensureChallengeStarted() {
  const s = getChallengeState();
  if (!s.id) {
    // 7일부터 자동 시작
    saveChallengeState({ id: "week7", startDate: todayKey(), checkins: [], stageHistory: [] });
  }
}

// 하루 빠짐 감지 및 리셋 로직
// 감사 기록 저장 시 및 앱 로드 시 호출
function syncChallengeWithHistory() {
  let s = getChallengeState();
  if (!s.id) return;

  const h = getHistory();
  const today = todayKey();
  const startDate = new Date(s.startDate + "T00:00:00");
  const todayDate = new Date(today + "T00:00:00");
  const daysPassed = Math.floor((todayDate - startDate) / 86400000); // 시작일부터 오늘까지 경과일수

  // ── 오늘 감사 기록이 있으면 자동 체크인 ──
  const e = h[today];
  const hasToday = e && Array.isArray(e.gratitude) && e.gratitude.some(Boolean);
  if (hasToday && !(s.checkins || []).includes(today)) {
    s.checkins = [...(s.checkins || []), today];
    saveChallengeState(s);
    s = getChallengeState();
  }

  // ── 빠진 날 감지: 시작일 ~ 어제 사이에 기록 없는 날이 있으면 리셋 ──
  if (daysPassed > 0) {
    for (let d = 0; d < daysPassed; d++) {
      const checkDate = new Date(startDate);
      checkDate.setDate(startDate.getDate() + d);
      const k = localDateStr(checkDate);
      const entry = h[k];
      const hasRecord = entry && Array.isArray(entry.gratitude) && entry.gratitude.some(Boolean);
      if (!hasRecord) {
        // 빠진 날 발견 → 7일부터 재시작
        const stageHistory = s.stageHistory || [];
        stageHistory.push({ id: s.id, startDate: s.startDate, checkins: s.checkins, resetAt: today, reason: "missed:" + k });
        saveChallengeState({ id: "week7", startDate: today, checkins: [], stageHistory });
        return; // 리셋 후 종료
      }
    }
  }

  // ── 현재 스테이지 완료 시 다음 스테이지로 ──
  s = getChallengeState();
  const stage = getCurrentStage(s);
  const checkins = s.checkins || [];
  if (checkins.length >= stage.days) {
    const stageIdx = CHALLENGE_STAGES.findIndex(c => c.id === s.id);
    const nextStage = CHALLENGE_STAGES[stageIdx + 1];
    if (nextStage) {
      const stageHistory = s.stageHistory || [];
      stageHistory.push({ id: s.id, startDate: s.startDate, checkins: s.checkins, completedAt: today });
      saveChallengeState({ id: nextStage.id, startDate: today, checkins: [], stageHistory });
    }
    // 30일도 완주하면 그냥 유지 (완주 상태 표시)
  }
}

function resetChallenge() {
  if (!confirm("챌린지를 초기화할까요? 7일부터 다시 시작돼요.")) return;
  localStorage.removeItem("grateful-challenge");
  ensureChallengeStarted();
  showToast("챌린지를 초기화했어요. 7일부터 다시 시작해요 🌱");
  render();
}

// ══════════════════════════════════════════
// 챌린지 렌더 (7일→21일→30일 순차 자동 진행)
// ══════════════════════════════════════════
function renderChallenge() {
  syncChallengeWithHistory(); // 저장 기록 반영 & 빠진 날 감지
  const s = getChallengeState();
  const stage = getCurrentStage(s);

  const checkins  = s.checkins || [];
  const startDate = new Date(s.startDate + "T00:00:00");
  const today     = todayKey();
  const todayDate = new Date(today + "T00:00:00");
  const daysPassed = Math.max(0, Math.floor((todayDate - startDate) / 86400000));
  const currentDay = Math.min(daysPassed + 1, stage.days);
  const doneCount  = checkins.length;
  const isDoneToday = checkins.includes(today);
  const isComplete  = doneCount >= stage.days;

  // ── 전체 여정 스테이지 표시 ──
  const stageLabels = CHALLENGE_STAGES.map((c, i) => {
    const currentStageIdx = CHALLENGE_STAGES.findIndex(x => x.id === s.id);
    const stageHistory = s.stageHistory || [];
    const isDone = stageHistory.some(h => h.id === c.id && h.completedAt);
    const isCur  = i === currentStageIdx;
    const locked = i > currentStageIdx;
    const bg = isDone ? "background:var(--terra);color:#fff;"
             : isCur  ? "background:var(--terra-dark);color:#fff;border:2px solid rgba(255,255,255,0.4);"
             : "background:rgba(255,255,255,0.15);color:rgba(255,255,255,0.5);";
    return `<div style="flex:1;text-align:center;padding:7px 4px;border-radius:12px;font-size:11px;font-weight:700;${bg}">
      ${isDone?"✓ ":""}${c.icon} ${c.days}일${isDone?" 완료":isCur?" 진행중":""}
    </div>`;
  }).join(`<div style="align-self:center;color:rgba(255,255,255,0.4);font-size:13px;padding:0 2px">›</div>`);

  // ── 히어로 카드 ──
  const pct = Math.round((doneCount / stage.days) * 100);

  const heroHtml = `
    <div class="challenge-hero">
      <div style="display:flex;gap:5px;margin-bottom:14px;">${stageLabels}</div>
      <div class="challenge-hero-label">${stage.icon} ${stage.name}</div>
      <div style="display:flex;align-items:baseline;gap:8px">
        <div class="challenge-hero-day">${doneCount}<span style="font-size:18px;opacity:0.7">/${stage.days}</span></div>
        <div style="font-size:13px;opacity:0.75">일 완료</div>
      </div>
      <div class="challenge-hero-title">${isComplete ? "🎉 단계 완주!" : (stage.themes[currentDay-1]?.title || "오늘의 감사")}</div>
      <div class="challenge-hero-desc">${
        isComplete
          ? (CHALLENGE_STAGES.findIndex(c=>c.id===s.id) < CHALLENGE_STAGES.length-1
              ? "대단해요! 다음 단계로 자동으로 넘어가요 🚀"
              : "🏆 모든 챌린지를 완주했어요!")
          : isDoneToday
            ? "✓ 오늘 감사 기록 완료! 내일도 기록해요"
            : (stage.themes[currentDay-1]?.desc || "오늘 감사 노트를 작성하면 자동으로 체크돼요")
      }</div>
      <div class="challenge-progress-bar"><div class="challenge-progress-fill" style="width:${pct}%"></div></div>
      <div class="challenge-progress-text">${pct}% 완료 · ${isComplete ? "완주!" : stage.days - doneCount + "일 남음"}</div>
    </div>`;

  // ── 오늘 상태 안내 ──
  const todayBanner = isDoneToday
    ? `<div style="display:flex;align-items:center;gap:10px;background:var(--green-bg);border:1.5px solid var(--green);border-radius:16px;padding:13px 16px;margin-bottom:13px;animation:fadeSlideUp 0.3s ease">
        <span style="font-size:22px">✅</span>
        <div>
          <div style="font-size:13px;font-weight:700;color:var(--green)">오늘 기록 완료!</div>
          <div style="font-size:11.5px;color:var(--brown-light);margin-top:2px">감사 노트 저장과 동시에 자동으로 체크됐어요 ✦</div>
        </div>
      </div>`
    : `<div style="display:flex;align-items:center;gap:10px;background:var(--mood-bg);border:1.5px dashed var(--border);border-radius:16px;padding:13px 16px;margin-bottom:13px;cursor:pointer" onclick="setView('write')">
        <span style="font-size:22px">📝</span>
        <div>
          <div style="font-size:13px;font-weight:700;color:var(--brown)">오늘 아직 기록 전이에요</div>
          <div style="font-size:11.5px;color:var(--brown-light);margin-top:2px">감사 노트를 저장하면 자동으로 체크돼요 → 탭해서 작성하기</div>
        </div>
      </div>`;

  // ── 도트 그리드 ──
  const gridDots = Array.from({length: stage.days}, (_, i) => {
    const d = new Date(startDate); d.setDate(startDate.getDate() + i);
    const k = localDateStr(d);
    const done = checkins.includes(k);
    const isToday = k === today;
    return `<div class="challenge-dot ${done?"done":""} ${isToday&&!done?"today-ch":""}" title="${i+1}일차">${i+1}</div>`;
  }).join("");

  const gridHtml = `
    <div class="card">
      <div class="card-label" style="margin-bottom:12px">진행 현황</div>
      <div class="challenge-grid">${gridDots}</div>
    </div>`;

  // ── 최근 5일 목록 ──
  const listItems = stage.themes.slice(0, Math.min(currentDay, stage.days)).reverse().slice(0, 5).map((theme, ri) => {
    const idx = Math.min(currentDay, stage.days) - 1 - ri;
    const d = new Date(startDate); d.setDate(startDate.getDate() + idx);
    const k = localDateStr(d);
    const done = checkins.includes(k);
    const isToday = k === today;
    return `
      <div class="challenge-list-item ${isToday?"active-day":""} ${idx > daysPassed?"locked":""}">
        <div class="challenge-list-num ${done?"done":""} ${isToday&&!done?"today-num":""}">${idx+1}</div>
        <div class="challenge-list-content">
          <div class="challenge-list-title">${theme.title}</div>
          <div class="challenge-list-desc">${done?"✅ 완료 (감사 노트 연동)":"📝 "+theme.desc}</div>
        </div>
      </div>`;
  }).join("");

  // ── 리셋 이력 ──
  const resets = (s.stageHistory||[]).filter(h=>h.reason && h.reason.startsWith("missed"));
  const resetHistHtml = resets.length > 0
    ? `<div style="text-align:center;margin-top:4px;margin-bottom:2px">
        <div style="font-size:11px;color:var(--brown-faint)">※ 빠진 날이 있어 총 ${resets.length}번 7일부터 재시작했어요</div>
      </div>` : "";

  const resetBtn = `
    <div style="text-align:center;margin-top:8px">
      <button onclick="resetChallenge()" style="background:transparent;border:none;font-size:12px;color:var(--brown-faint);cursor:pointer;font-family:inherit;text-decoration:underline">챌린지 초기화 (7일부터 다시 시작)</button>
    </div>`;

  return heroHtml + todayBanner + gridHtml + `<div class="card"><div class="card-label" style="margin-bottom:12px">일별 기록</div>${listItems}</div>` + resetHistHtml + resetBtn;
}

// ══════════════════════════════════════════
// 연간 리와인드
// ══════════════════════════════════════════
function renderRewind(h) {
  const yr = rewindYear;
  const yearStr = `${yr}-`;
  const yearDays = Object.keys(h).filter(k => k.startsWith(yearStr) && h[k]?.gratitude?.some(Boolean));

  if (yearDays.length === 0) return "";

  // 통계 계산
  const totalCount = yearDays.length;
  const totalGratitude = yearDays.reduce((sum, d) => sum + (h[d].gratitude?.filter(Boolean).length || 0), 0);

  // 월별 기록 수
  const monthCounts = Array(12).fill(0);
  yearDays.forEach(d => { const m = parseInt(d.split("-")[1]) - 1; monthCounts[m]++; });
  const maxMonth = Math.max(...monthCounts, 1);

  // 기분 통계
  const moodC = {};
  yearDays.forEach(d => { if (h[d].mood) moodC[h[d].mood] = (moodC[h[d].mood]||0)+1; });
  const topMoodEntry = Object.entries(moodC).sort((a,b) => b[1]-a[1])[0];
  const topMoodEmoji = topMoodEntry ? (MOODS.find(m => m.label === topMoodEntry[0])?.emoji || "—") : "—";

  // 가장 많이 기록한 달
  const bestMonthIdx = monthCounts.indexOf(Math.max(...monthCounts));
  const MONTHS = ["1월","2월","3월","4월","5월","6월","7월","8월","9월","10월","11월","12월"];

  // 월별 막대 차트
  const bars = monthCounts.map((cnt, i) => {
    const barH = cnt === 0 ? 3 : Math.round((cnt / maxMonth) * 44);
    return `<div class="rewind-bar-wrap">
      <div class="rewind-bar" style="height:${barH}px"></div>
      <div class="rewind-bar-label">${i+1}월</div>
    </div>`;
  }).join("");

  // 연도 선택 (앞뒤 이동)
  const canPrev = Object.keys(h).some(k => k.startsWith(`${yr-1}-`));
  const canNext = yr < new Date().getFullYear();
  const yearNav = `
    <div class="rewind-header">
      <div class="rewind-title">✦ ${yr}년 리와인드</div>
      <div style="display:flex;gap:5px">
        <button class="rewind-year-btn" onclick="moveRewindYear(-1)" ${canPrev?"":'style="opacity:0.3;pointer-events:none"'}>‹ ${yr-1}</button>
        ${canNext?`<button class="rewind-year-btn" onclick="moveRewindYear(1)">${yr+1} ›</button>`:""}
      </div>
    </div>`;

  return `
    <div class="rewind-section">
      ${yearNav}
      <div class="rewind-cards">
        <div class="rewind-card">
          <div class="rewind-card-icon">📓</div>
          <div class="rewind-card-num">${totalCount}</div>
          <div class="rewind-card-label">기록한 날</div>
        </div>
        <div class="rewind-card">
          <div class="rewind-card-icon">✦</div>
          <div class="rewind-card-num">${totalGratitude}</div>
          <div class="rewind-card-label">총 감사 문장</div>
        </div>
        <div class="rewind-card">
          <div class="rewind-card-icon">${topMoodEmoji}</div>
          <div class="rewind-card-num">${topMoodEntry?.[1] || 0}</div>
          <div class="rewind-card-label">가장 많은 기분<br>${topMoodEntry?.[0] || "—"}</div>
        </div>
        <div class="rewind-card">
          <div class="rewind-card-icon">📅</div>
          <div class="rewind-card-num">${monthCounts[bestMonthIdx]}</div>
          <div class="rewind-card-label">최다 기록월<br>${MONTHS[bestMonthIdx]}</div>
        </div>
      </div>
      <div class="card" style="margin-top:9px">
        <div class="card-label" style="margin-bottom:10px">월별 기록</div>
        <div class="rewind-month-chart">${bars}</div>
      </div>
    </div>`;
}

function moveRewindYear(delta) {
  rewindYear += delta;
  render();
}

// ══════════════════════════════════════════
// 데이터 내보내기 / 가져오기
// ══════════════════════════════════════════
function exportData() {
  const data = {
    version: APP_VERSION,
    exportedAt: new Date().toISOString(),
    history:   localStorage.getItem("grateful-history")   || "{}",
    challenge: localStorage.getItem("grateful-challenge") || "{}",
    nickname:  localStorage.getItem("grateful-nickname")  || "",
    reminder:  localStorage.getItem("grateful-reminder")  || "{}",
    theme:     localStorage.getItem("grateful-theme")     || "",
    font:      localStorage.getItem("grateful-font")      || "default",
    pattern:   localStorage.getItem("grateful-pattern")   || "none",
    prayer:    localStorage.getItem("grateful-prayer")    || "{}",
    shared:    localStorage.getItem("grateful-shared")   || "[]",
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  const date = localDateStr();
  a.href     = url;
  a.download = `grateful-backup-${date}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast("📦 기록을 내보냈어요!");
}

function importData() {
  const input = document.getElementById("importFileInput");
  if (!input || !input.files || !input.files[0]) return;

  const file = input.files[0];
  const reader = new FileReader();

  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);

      // gratitude를 항상 배열로 정규화 (Firebase 숫자키 객체 대응)
      function normalizeGratitude(g) {
        if (Array.isArray(g)) return g.filter(Boolean);
        if (g && typeof g === "object") {
          return Object.keys(g).sort((a,b)=>Number(a)-Number(b)).map(k=>g[k]).filter(Boolean);
        }
        return [];
      }

      // ── 형식 감지 ──
      let imported = {};

      if (data["grateful-users"]) {
        // Firebase 내보내기 형식: { "grateful-users": { "닉네임": { history: {...} } } }
        const usersNode = data["grateful-users"];
        const nick = localStorage.getItem("grateful-nickname") || "";
        const encNick = nick.replace(/[.#$[\]\/]/g, "_").trim() || "user";
        const userNode = usersNode[encNick] || usersNode[Object.keys(usersNode)[0]];
        if (!userNode || !userNode.history) throw new Error("Firebase 내보내기에 history가 없어요.");
        for (const [date, entry] of Object.entries(userNode.history)) {
          imported[date] = { ...entry, gratitude: normalizeGratitude(entry.gratitude) };
        }
      } else if (data.history) {
        // 앱 백업 형식: { history: "...(stringified)..." }
        const raw = JSON.parse(data.history);
        for (const [date, entry] of Object.entries(raw)) {
          imported[date] = { ...entry, gratitude: normalizeGratitude(entry.gratitude) };
        }
      } else {
        throw new Error("올바른 백업 파일이 아니에요.");
      }

      // 기존 기록과 합치기 (덮어쓰지 않고 병합)
      const existing = JSON.parse(localStorage.getItem("grateful-history") || "{}");
      const merged   = { ...imported, ...existing }; // 현재 기기 기록 우선

      const importedCount = Object.keys(imported).length;
      const mergedCount   = Object.keys(merged).length;

      localStorage.setItem("grateful-history", JSON.stringify(merged));

      // 챌린지·닉네임은 현재 값이 없을 때만 가져오기
      if (!localStorage.getItem("grateful-challenge") && data.challenge)
        localStorage.setItem("grateful-challenge", data.challenge);
      if (!localStorage.getItem("grateful-nickname") && data.nickname)
        localStorage.setItem("grateful-nickname", data.nickname);
      if (!localStorage.getItem("grateful-reminder") && data.reminder)
        localStorage.setItem("grateful-reminder", data.reminder);
      // 테마·폰트·패턴: 현재 값이 없을 때만 복원
      if (!localStorage.getItem("grateful-theme") && data.theme)
        localStorage.setItem("grateful-theme", data.theme);
      if (data.font && data.font !== "default") {
        localStorage.setItem("grateful-font", data.font);
        applyFont(data.font);
      }
      if (data.pattern && data.pattern !== "none") {
        localStorage.setItem("grateful-pattern", data.pattern);
        applyPattern(data.pattern);
      }
      // 기도노트 복원
      if (data.prayer) {
        try {
          const existingPrayer = JSON.parse(localStorage.getItem("grateful-prayer") || "{}");
          const importedPrayer = JSON.parse(data.prayer);
          const mergedPrayer = { ...importedPrayer, ...existingPrayer };
          localStorage.setItem("grateful-prayer", JSON.stringify(mergedPrayer));
        } catch(e) { /* 무시 */ }
      }

      // shared 복원
      if (data.shared) {
        try {
          const existShared = getSharedKeys();
          const impShared   = JSON.parse(data.shared);
          const merged = [...new Set([...existShared, ...impShared])];
          localStorage.setItem("grateful-shared", JSON.stringify(merged));
          sharedToday = merged.includes(todayKey());
        } catch(e) { /* 무시 */ }
      }
      // input 초기화
      input.value = "";

      showToast(`✅ ${importedCount}일 가져옴 → 총 ${mergedCount}일`);

      // 상태 재초기화 후 렌더
      histCalYear  = new Date().getFullYear();
      histCalMonth = new Date().getMonth();
      histSelectedDate = todayKey();
      updateStreak();
      syncChallengeWithHistory();
      render();

      // ✅ 수정: 가져온 기록을 Firebase에도 업로드 (닉네임 있을 때)
      if (firebaseReady && userRef) {
        loadHistoryFromCloud().then(() => startUserHistoryListener());
      }

    } catch(err) {
      input.value = "";
      showToast("❌ 파일을 읽지 못했어요: " + err.message);
    }
  };

  reader.onerror = () => {
    input.value = "";
    showToast("❌ 파일 읽기 실패");
  };

  reader.readAsText(file);
}

// ══════════════════════════════════════════
// XSS 방지
// ══════════════════════════════════════════
function escHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#039;");
}


// ══════════════════════════════════════════
// 🙏 기도노트 — 데이터
// ══════════════════════════════════════════
const PRAYER_CATS = ["개인","가족","교회","감사","중보기도"];

function getPrayers() {
  try { return JSON.parse(localStorage.getItem("grateful-prayer") || "{}"); } catch { return {}; }
}
function savePrayers(p) {
  localStorage.setItem("grateful-prayer", JSON.stringify(p));
}

// ── 기도 클라우드 동기화 ──
async function syncPrayerToCloud(id, prayer) {
  if (!firebaseReady || !prayerRef) return;
  try {
    await prayerRef.child(id).set(prayer);
  } catch(e) { console.warn("기도 클라우드 저장 실패:", e); }
}

async function deletePrayerFromCloud(id) {
  if (!firebaseReady || !prayerRef) return;
  try {
    await prayerRef.child(id).remove();
  } catch(e) { console.warn("기도 클라우드 삭제 실패:", e); }
}

async function loadPrayersFromCloud() {
  if (!firebaseReady || !prayerRef) return;
  try {
    const snap = await prayerRef.once("value");
    if (!snap.exists()) return;
    const cloudPrayers = snap.val();
    const local = getPrayers();
    // 클라우드 우선 병합 (createdAt 기준)
    const merged = { ...local };
    Object.keys(cloudPrayers).forEach(id => {
      const cp = cloudPrayers[id];
      if (!merged[id] || (cp.createdAt || 0) >= (merged[id].createdAt || 0)) {
        merged[id] = cp;
      }
    });
    savePrayers(merged);
    if (currentView === "prayer") render();
  } catch(e) { console.warn("기도 클라우드 로드 실패:", e); }
}

function startPrayerListener() {
  if (!firebaseReady || !prayerRef) return;
  if (prayerListener) { prayerRef.off("value", prayerListener); prayerListener = null; }
  prayerListener = prayerRef.on("value", snap => {
    if (!snap.exists()) return;
    const cloudPrayers = snap.val();
    const local = getPrayers();
    let changed = false;
    Object.keys(cloudPrayers).forEach(id => {
      const cp = cloudPrayers[id];
      if (!local[id] || (cp.createdAt || 0) > (local[id].createdAt || 0)) {
        local[id] = cp; changed = true;
      }
    });
    if (changed) {
      savePrayers(local);
      if (currentView === "prayer") render();
    }
  });
}

function genPrayerId() {
  return "p" + Date.now() + Math.random().toString(36).slice(2,6);
}


// ══════════════════════════════════════════
// 🙏 기도 수정
// ══════════════════════════════════════════
function editPrayer(id) {
  prayerEditId = id;
  render(); // 수정 모드로 재렌더
}

function cancelPrayerEdit() {
  prayerEditId = null;
  render();
}

async function savePrayerEdit(id) {
  const titleEl   = document.getElementById(`pedit-title-${id}`);
  const contentEl = document.getElementById(`pedit-content-${id}`);
  const catBtns   = document.querySelectorAll(`#pedit-cats-${id} .prayer-cat-btn`);

  const title   = (titleEl?.value || "").trim();
  const content = (contentEl?.value || "").trim();
  if (!title) { showToast("기도 제목을 입력해주세요 🙏"); return; }

  let cat = "개인";
  catBtns.forEach(b => { if (b.classList.contains("sel")) cat = b.dataset.cat; });

  const prayers = getPrayers();
  if (!prayers[id]) return;
  prayers[id] = { ...prayers[id], title, content, category: cat };
  savePrayers(prayers);
  await syncPrayerToCloud(id, prayers[id]);

  prayerEditId = null;
  showToast("기도 제목을 수정했어요 ✦");
  render();
}

function addPrayer() {
  const titleEl   = document.getElementById("prayerTitle");
  const contentEl = document.getElementById("prayerContent");
  const title   = (titleEl?.value || "").trim();
  const content = (contentEl?.value || "").trim();
  if (!title) { showToast("기도 제목을 입력해주세요 🙏"); return; }

  // 선택된 카테고리
  const catBtns = document.querySelectorAll(".prayer-cat-btn");
  let cat = "개인";
  catBtns.forEach(b => { if (b.classList.contains("sel")) cat = b.dataset.cat; });

  const prayers = getPrayers();
  const id = genPrayerId();
  prayers[id] = { id, title, content, category: cat,
                  answered: false, answeredAt: null,
                  date: todayKey(), createdAt: Date.now() };
  savePrayers(prayers);
  syncPrayerToCloud(id, prayers[id]);  // ← 클라우드 업로드
  if (titleEl) titleEl.value = "";
  if (contentEl) contentEl.value = "";
  // 카테고리 기본으로 리셋
  catBtns.forEach(b => { b.classList.toggle("sel", b.dataset.cat === "개인"); });
  showToast("기도 제목을 기록했어요 🙏");
  render();
}

function markAnswered(id) {
  const prayers = getPrayers();
  if (!prayers[id]) return;
  prayers[id].answered = true;
  prayers[id].answeredAt = Date.now();
  savePrayers(prayers);
  syncPrayerToCloud(id, prayers[id]);  // ← 클라우드 업데이트
  showToast("✅ 응답받은 기도로 표시했어요!");
  render();
}

function deletePrayer(id) {
  const prayers = getPrayers();
  if (!prayers[id]) return;
  if (!confirm("이 기도 기록을 삭제할까요?")) return;
  delete prayers[id];
  savePrayers(prayers);
  deletePrayerFromCloud(id);  // ← 클라우드 삭제
  showToast("삭제했어요.");
  render();
}

function setPrayerFilter(f) {
  prayerFilter = f;
  render();
}

function selectPrayerCat(cat) {
  document.querySelectorAll(".prayer-cat-btn").forEach(b => {
    b.classList.toggle("sel", b.dataset.cat === cat);
  });
}

// ── 챌린지 컴팩트 (기록 탭용) ──
function renderChallengeCompact() {
  const s = getChallengeState();
  const stage = getCurrentStage(s);
  const checkins = s.checkins || [];
  const pct = Math.round((checkins.length / stage.days) * 100);
  const isDoneToday = checkins.includes(todayKey());
  return `
    <div class="challenge-compact-bar" onclick="showChallengeModal()">
      <div>
        <div class="challenge-compact-label">${stage.icon} ${stage.name}</div>
        <div class="challenge-compact-sub">${isDoneToday?"✓ 오늘 체크 완료!":checkins.length+"/"+stage.days+"일 완료"}</div>
      </div>
      <div class="challenge-compact-pct">${pct}%</div>
    </div>`;
}

// 챌린지 상세 모달 (간단)
function showChallengeModal() {
  // 현재는 챌린지 풀 뷰를 별도 오버레이로 보여줌
  // 기존 renderChallenge()를 활용
  const overlay = document.createElement("div");
  overlay.id = "challengeOverlay";
  overlay.style.cssText = "position:fixed;inset:0;z-index:200;background:var(--overlay-bg);display:flex;flex-direction:column;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:max(20px,env(safe-area-inset-top)) 0 40px;";
  overlay.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:0 20px 14px;position:sticky;top:0;background:var(--header-bg);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-bottom:1px solid var(--border);z-index:1">
      <div style="font-family:'DM Serif Display',serif;font-size:17px;color:var(--ink)">📅 챌린지</div>
      <button onclick="document.getElementById('challengeOverlay').remove()" style="background:var(--surface);border:1.5px solid var(--border);border-radius:50%;width:36px;height:36px;font-size:18px;cursor:pointer;color:var(--ink-soft);">✕</button>
    </div>
    <div style="padding:16px 16px 0">${renderChallenge()}</div>`;
  document.body.appendChild(overlay);
}

// ══════════════════════════════════════════
// 🙏 기도노트 — 렌더
// ══════════════════════════════════════════
function renderPrayer() {
  const prayers = getPrayers();
  const all = Object.values(prayers).sort((a,b) => b.createdAt - a.createdAt);
  const active   = all.filter(p => !p.answered);
  const answered = all.filter(p => p.answered);
  const display  = prayerFilter === "answered" ? answered : active;

  const stats = `
    <div class="prayer-hero">
      <span class="prayer-hero-emoji">🙏</span>
      <div class="prayer-hero-title">기도노트</div>
      <div class="prayer-hero-sub">하나님께 올려드리는<br>기도 제목을 기록해요</div>
      <div class="prayer-hero-stats">
        <div class="prayer-stat">
          <div class="prayer-stat-num">${active.length}</div>
          <div class="prayer-stat-label">기도 중</div>
        </div>
        <div class="prayer-stat">
          <div class="prayer-stat-num">${answered.length}</div>
          <div class="prayer-stat-label">응답받음</div>
        </div>
        <div class="prayer-stat">
          <div class="prayer-stat-num">${all.length}</div>
          <div class="prayer-stat-label">전체</div>
        </div>
      </div>
    </div>`;

  // 입력 폼
  const form = `
    <div class="prayer-form-card">
      <div class="prayer-form-label">새 기도 제목</div>
      <div class="prayer-cat-row">
        ${PRAYER_CATS.map(c =>
          '<button class="prayer-cat-btn ' + (c==="개인"?"sel":"") + '" data-cat="' + c + '" onclick="selectPrayerCat(\'' + c + '\')">' + c + '</button>'
        ).join("")}
      </div>
      <input class="prayer-input" id="prayerTitle" type="text" placeholder="기도 제목을 적어요" maxlength="60" />
      <textarea class="prayer-textarea" id="prayerContent" rows="3" placeholder="구체적인 기도 내용 (선택)"></textarea>
      <button class="prayer-add-btn" onclick="addPrayer()">🙏 기도 제목 올리기</button>
    </div>`;

  // 필터 탭
  const filterRow = `
    <div class="prayer-filter-row">
      <button class="prayer-filter-btn ${prayerFilter==="active"?"active":""}" onclick="setPrayerFilter('active')">🙏 기도 중 (${active.length})</button>
      <button class="prayer-filter-btn ${prayerFilter==="answered"?"active":""}" onclick="setPrayerFilter('answered')">✅ 응답받음 (${answered.length})</button>
    </div>`;

  // 카드 목록
  let cards = "";
  if (display.length === 0) {
    cards = `<div class="prayer-empty">
      ${prayerFilter === "answered"
        ? "아직 응답받은 기도가 없어요.<br>기도하고 응답받으면 여기 표시돼요 🌿"
        : "등록된 기도 제목이 없어요.<br>위에서 기도 제목을 적어 올려보세요 🙏"}
    </div>`;
  } else {
    cards = display.map(p => {
      const dateStr = formatDateShort(p.date);
      const isEditing = (prayerEditId === p.id);

      // ── 수정 모드 ──
      if (isEditing) {
        const catRow = PRAYER_CATS.map(c =>
          '<button class="prayer-cat-btn ' + (c === p.category ? 'sel' : '') + '" data-cat="' + c + '" ' +
          'onclick="this.closest(\'.prayer-edit-cats\').querySelectorAll(\'.prayer-cat-btn\').forEach(b=>b.classList.remove(\'sel\')); this.classList.add(\'sel\')">' + c + '</button>'
        ).join("");
        return `
          <div class="prayer-card editing">
            <div class="prayer-form-label" style="margin-bottom:8px">기도 제목 수정</div>
            <div class="prayer-edit-cats prayer-cat-row" id="pedit-cats-${p.id}" style="margin-bottom:10px">
              ${catRow}
            </div>
            <input class="prayer-input" id="pedit-title-${p.id}" type="text"
              value="${escHtml(p.title)}" maxlength="60" placeholder="기도 제목" />
            <textarea class="prayer-textarea" id="pedit-content-${p.id}" rows="3"
              placeholder="구체적인 기도 내용 (선택)">${escHtml(p.content || "")}</textarea>
            <div style="display:flex;gap:8px;margin-top:4px">
              <button class="prayer-add-btn" style="flex:1" onclick="savePrayerEdit('${p.id}')">✓ 저장</button>
              <button class="prayer-del-btn" style="padding:12px 18px;border-radius:14px" onclick="cancelPrayerEdit()">취소</button>
            </div>
          </div>`;
      }

      // ── 일반 보기 모드 ──
      const contentHtml = p.content
        ? `<div class="prayer-card-content">${escHtml(p.content)}</div>` : "";
      const footer = p.answered
        ? `<div class="prayer-card-footer">
            <span class="prayer-answered-tag">✅ 응답받음 · ${p.answeredAt ? formatDateShort(localDateStr(new Date(p.answeredAt))) : ""}</span>
            <button class="prayer-del-btn" onclick="deletePrayer('${p.id}')">삭제</button>
          </div>`
        : `<div class="prayer-card-footer">
            <button class="prayer-answered-btn" onclick="markAnswered('${p.id}')">✅ 응답됨</button>
            <button class="prayer-del-btn" onclick="editPrayer('${p.id}')">✏️ 수정</button>
            <button class="prayer-del-btn" onclick="deletePrayer('${p.id}')">삭제</button>
          </div>`;
      return `
        <div class="prayer-card ${p.answered?"answered":""}">
          <div class="prayer-card-top">
            <span class="prayer-card-cat">${escHtml(p.category)}</span>
            <span class="prayer-card-date">${dateStr}</span>
          </div>
          <div class="prayer-card-title">${escHtml(p.title)}</div>
          ${contentHtml}
          ${footer}
        </div>`;
    }).join("");
  }

  return stats + form + filterRow + cards;
}

// ══════════════════════════════════════════
// 그룹 공유 — localStorage 키 관리
// ══════════════════════════════════════════
function getSharedKeys() {
  try { return JSON.parse(localStorage.getItem("grateful-shared") || "[]"); } catch { return []; }
}
function addSharedKey(dateKey) {
  const keys = getSharedKeys();
  if (!keys.includes(dateKey)) {
    keys.push(dateKey);
    localStorage.setItem("grateful-shared", JSON.stringify(keys));
  }
}

// ══════════════════════════════════════════
// 피드 실시간 리스너
// ══════════════════════════════════════════
function startFeedListener() {
  if (!firebaseReady || !db) return;
  if (!feedRef) feedRef = db.ref("grateful-feed");
  // 기존 리스너 정리
  if (feedListener && feedRef) {
    feedRef.off("child_added", feedListener);
    feedListener = null;
  }
  feedEntries = [];

  // 최근 30일치 데이터만 로드
  const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const query = feedRef.orderByChild("timestamp").startAt(since).limitToLast(50);

  feedListener = query.on("child_added", snap => {
    const entry = { id: snap.key, ...snap.val() };
    // 중복 방지
    if (!feedEntries.find(e => e.id === entry.id)) {
      feedEntries.unshift(entry); // 최신순
      feedEntries.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    }
    // 피드 탭 아닐 때 새 항목이면 빨간 점 표시
    const myNick = getNickname();
    const isMyPost = entry.origNick === myNick || (!entry.anon && entry.nickname === myNick);
    if (currentView !== "feed" && !isMyPost) {
      _feedNewCount++;
      const dot = document.getElementById("feedDot");
      if (dot) dot.style.display = "inline-block";
    }
    if (currentView === "feed") render();
  });

  // 삭제 감지
  feedRef.on("child_removed", snap => {
    feedEntries = feedEntries.filter(e => e.id !== snap.key);
    if (currentView === "feed") render();
  });
}

// ══════════════════════════════════════════
// 그룹 공유 — 공유 모달 열기
// ══════════════════════════════════════════
function openShareModal() {
  // 내용 동기화 (미저장 상태 포함)
  const noteEl = document.getElementById("noteText");
  if (noteEl) state.note = noteEl.value.trim();
  state.gratitude.forEach((_, i) => {
    const ta = document.getElementById(`gtext${i}`);
    if (ta) state.gratitude[i] = ta.value;
  });

  const hasContent = state.gratitude.some(g => g && g.trim());
  if (!hasContent) { showToast("감사한 내용을 먼저 입력해주세요 ✦"); return; }
  if (!firebaseReady) { showToast("Firebase 연결 중이에요. 잠시 후 다시 시도해주세요 🌿"); return; }
  if (sharedToday || getSharedKeys().includes(todayKey())) {
    showToast("오늘은 이미 공유했어요 ✦"); return;
  }
  const nick = getNickname();
  if (!nick) { showNicknameModal(); return; }

  // 미저장이면 자동 저장
  if (!saved) doSave();

  // 항목 선택 목록 렌더
  const items = state.gratitude.filter(g => g && g.trim());
  const itemListEl = document.getElementById("shareItemList");
  if (itemListEl) {
    itemListEl.innerHTML = items.map((g, i) => `
      <div class="share-item-row selected" id="shareRow${i}" onclick="toggleShareItem(${i})">
        <div class="share-item-check" id="shareChk${i}">✓</div>
        <div class="share-item-text">${escHtml(g)}</div>
      </div>`).join("");
  }
  // 닉네임 표시
  const nickLabel = document.getElementById("shareNickLabel");
  if (nickLabel) nickLabel.textContent = `${nick}님으로 공유`;

  const modal = document.getElementById("shareOptionModal");
  if (modal) modal.style.display = "flex";
}

function closeShareModal() {
  const modal = document.getElementById("shareOptionModal");
  if (modal) modal.style.display = "none";
}

function toggleShareItem(idx) {
  const row = document.getElementById(`shareRow${idx}`);
  const chk = document.getElementById(`shareChk${idx}`);
  if (!row) return;
  const sel = row.classList.toggle("selected");
  if (chk) chk.textContent = sel ? "✓" : "";
}

function doShareToFeed(isAnon) {
  const items = state.gratitude.filter(g => g && g.trim());
  const selectedGratitude = items.filter((_, i) => {
    const row = document.getElementById(`shareRow${i}`);
    return row && row.classList.contains("selected");
  });
  if (selectedGratitude.length === 0) {
    showToast("공유할 항목을 하나 이상 선택해주세요 ✦"); return;
  }

  closeShareModal();

  const nick = getNickname();
  const today = todayKey();
  const entry = {
    nickname:  isAnon ? "익명" : nick,
    date:      today,
    gratitude: selectedGratitude,
    mood:      state.mood,
    note:      state.note || "",
    timestamp: Date.now(),
    anon:      isAnon,
    origNick:  nick,  // 항상 실명 저장 (중복 방지용)
  };

  if (!feedRef) { showToast("Firebase 연결 오류예요 🔥"); return; }

  feedRef.push(entry)
    .then(() => {
      addSharedKey(today);
      sharedToday = true;
      showToast("그룹에 공유됐어요 🌿");
      render(); // 공유 버튼 상태 업데이트
    })
    .catch(err => {
      console.error("공유 실패:", err);
      showToast("공유에 실패했어요. Firebase 규칙을 확인해주세요 🔥");
    });
}

// ══════════════════════════════════════════
// 피드 렌더
// ══════════════════════════════════════════
const MOOD_EMOJI = { "좋음":"😊","평온":"😌","행복":"🥰","힘듦":"😮‍💨","피곤":"😴" };

function renderFeed() {
  // 빨간 점 제거
  _feedNewCount = 0;
  const dot = document.getElementById("feedDot");
  if (dot) dot.style.display = "none";

  if (!firebaseReady) return `
    <div class="card" style="text-align:center;padding:40px 20px">
      <div style="font-size:32px;margin-bottom:12px">🔥</div>
      <div style="font-size:14px;color:var(--ink-soft);line-height:1.8">
        Firebase가 연결되지 않았어요.<br>인터넷 연결을 확인해주세요.
      </div>
    </div>`;

  if (feedLoading && feedEntries.length === 0) return `
    <div style="text-align:center;padding:60px 20px">
      <div class="feed-spinner"></div>
      <div style="color:var(--ink-faint);font-size:13px">피드 불러오는 중...</div>
    </div>`;

  if (feedEntries.length === 0) return `
    <div class="card" style="text-align:center;padding:40px 20px">
      <div style="font-size:40px;margin-bottom:12px">🌿</div>
      <div style="font-size:14px;color:var(--ink-soft);line-height:1.9">
        아직 공유된 감사 기록이 없어요.<br>
        오늘 탭에서 감사를 기록하고<br>
        그룹에 공유해보세요!
      </div>
    </div>`;

  const myNick = getNickname();
  const cards = feedEntries.map(entry => {
    const isMe = entry.origNick === myNick || (!entry.anon && entry.nickname === myNick);
    const moodEmoji = MOOD_EMOJI[entry.mood] || "";
    const timeStr = entry.timestamp
      ? formatDateShort(localDateStr(new Date(entry.timestamp)))
      : entry.date || "";
    const items = (entry.gratitude || []).map(g =>
      `<div class="feed-item">✦ ${escHtml(g)}</div>`).join("");
    const noteHtml = entry.note
      ? `<div class="feed-note">"${escHtml(entry.note)}"</div>` : "";
    const anonBadge = entry.anon
      ? `<span class="feed-anon-badge">익명</span>` : "";

    return `
      <div class="feed-card ${isMe ? "feed-card-mine" : ""}">
        <div class="feed-card-header">
          <div class="feed-card-nick">
            ${moodEmoji ? `<span style="margin-right:5px">${moodEmoji}</span>` : ""}
            <strong>${escHtml(entry.nickname)}</strong>${anonBadge}
          </div>
          <div class="feed-card-date">${timeStr}</div>
        </div>
        <div class="feed-items">${items}</div>
        ${noteHtml}
      </div>`;
  }).join("");

  return `
    <div class="feed-header-row">
      <div style="font-family:'DM Serif Display',serif;font-size:17px;color:var(--ink)">
        🌿 그룹 피드
      </div>
      <div style="font-size:11px;color:var(--ink-faint)">${feedEntries.length}개의 감사 기록</div>
    </div>
    ${cards}`;
}

// init()은 Firebase SDK 로드 완료 후 자동 호출됨 (head의 DOMContentLoaded 참고)