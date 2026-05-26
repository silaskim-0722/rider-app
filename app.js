/* ── 라이더 루틴 · app.js ── */

const DB_KEY = 'rider_sessions';
// 1분 이상 정지 = 매장 픽업 대기 or 고객 배달 중 = "바쁜 시간"
// 계속 이동 중 = 배달 간 이동 (주문 없음) = "한가한 시간"
const STOP_THRESHOLD_MS = 1 * 60 * 1000;
const MOVE_SPEED_KMPH = 2; // 2km/h 미만 = 정지로 판단
const WORK_START = 9;
const WORK_END = 21;

/* ── State ── */
let tracking = false;
let watchId = null;
let positions = [];
let segments = [];
let segStart = null;
let segType = null;
let lastPos = null;
let todayKey = '';

/* ── Storage ── */
function loadSessions() {
  try { return JSON.parse(localStorage.getItem(DB_KEY) || '{}'); } catch { return {}; }
}
function saveSession(key, data) {
  const all = loadSessions();
  all[key] = data;
  localStorage.setItem(DB_KEY, JSON.stringify(all));
}
function getTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

/* ── GPS ── */
function startTracking() {
  if (!navigator.geolocation) { showToast('GPS를 지원하지 않는 기기입니다'); return; }
  todayKey = getTodayKey();
  const saved = loadSessions()[todayKey];
  if (saved) { positions = saved.positions || []; segments = saved.segments || []; }
  tracking = true;
  updateTrackBtn();
  watchId = navigator.geolocation.watchPosition(onPosition, onGpsError, {
    enableHighAccuracy: true, maximumAge: 5000, timeout: 15000
  });
  showToast('GPS 추적 시작!');
  startClock();
}

function stopTracking() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  tracking = false;
  if (segStart && segType) segments.push({ start: segStart, end: Date.now(), type: segType });
  segStart = null; segType = null;
  saveSession(todayKey, { positions, segments });
  updateTrackBtn();
  renderAll();
  showToast('추적 종료 · 데이터 저장됨');
}

function onPosition(pos) {
  const { latitude: lat, longitude: lng, speed } = pos.coords;
  const ts = Date.now();
  const kmph = (speed || 0) * 3.6;
  const type = kmph < MOVE_SPEED_KMPH ? 'stop' : 'move';

  positions.push({ lat, lng, ts, speed: kmph });

  if (!segStart) { segStart = ts; segType = type; }
  else if (segType !== type) {
    segments.push({ start: segStart, end: ts, type: segType });
    segStart = ts; segType = type;
  }

  lastPos = { lat, lng, ts };
  saveSession(todayKey, { positions, segments });
  renderAll();
}

function onGpsError(err) {
  const msgs = { 1: 'GPS 권한을 허용해 주세요', 2: 'GPS 신호를 찾을 수 없어요', 3: 'GPS 응답 시간 초과' };
  showToast(msgs[err.code] || 'GPS 오류 발생');
}

/* ── Analysis ──
   핵심 로직:
   - 1분 이상 정지 → 매장 픽업 대기 or 배달 완료 대기 → "바쁜 시간"
   - 계속 이동 중 (정지 없음) → 주문 없이 대기 이동 → "한가한 시간"
   - 따라서 "정지 건수가 가장 적은 연속 2시간"이 휴식 추천 구간
*/
function analyzeToday() {
  const total = (WORK_END - WORK_START) * 2; // 30분 슬롯 × 24개
  const busyMins = new Array(total).fill(0);  // 슬롯별 "바쁜 정지" 누적 분
  const moveMins = new Array(total).fill(0);  // 슬롯별 이동 누적 분

  segments.forEach(seg => {
    const durMs = seg.end - seg.start;
    const isBusy = seg.type === 'stop' && durMs >= STOP_THRESHOLD_MS;
    const isMove = seg.type === 'move';
    if (!isBusy && !isMove) return;

    const sH = new Date(seg.start).getHours() + new Date(seg.start).getMinutes() / 60;
    const eH = new Date(seg.end).getHours() + new Date(seg.end).getMinutes() / 60;
    for (let i = 0; i < total; i++) {
      const ss = WORK_START + i * 0.5, se = ss + 0.5;
      const overlap = Math.min(eH, se) - Math.max(sH, ss);
      if (overlap > 0) {
        if (isBusy) busyMins[i] += overlap * 60;
        if (isMove) moveMins[i] += overlap * 60;
      }
    }
  });

  // 연속 2시간(4슬롯) 중 "바쁜 정지"가 가장 적은 구간 → 휴식 추천
  const WINDOW = 4;
  let best = { score: Infinity, idx: Math.floor((13 - WORK_START) * 2) };
  for (let i = 0; i <= total - WINDOW; i++) {
    const busySum = busyMins.slice(i, i + WINDOW).reduce((a, b) => a + b, 0);
    if (busySum < best.score) best = { score: busySum, idx: i };
  }

  const startHr = WORK_START + best.idx * 0.5;
  const endHr = startHr + 2;
  // 바쁜 정도가 낮을수록 한가한 것 (0분 = 완전 한가)
  const pct = Math.max(0, Math.round(100 - (best.score / (WINDOW * 30)) * 100));

  return { startHr, endHr, busyMins, moveMins, pct };
}

function calcStats() {
  let moveMs = 0, stopMs = 0, totalDist = 0;
  segments.forEach(s => {
    const d = s.end - s.start;
    if (s.type === 'move') moveMs += d; else stopMs += d;
  });
  for (let i = 1; i < positions.length; i++) {
    const a = positions[i-1], b = positions[i];
    const dx = (b.lng - a.lng) * 111320 * Math.cos(a.lat * Math.PI / 180);
    const dy = (b.lat - a.lat) * 110540;
    totalDist += Math.sqrt(dx*dx + dy*dy);
  }
  return {
    moveH: Math.floor(moveMs / 3600000),
    moveM: Math.floor((moveMs % 3600000) / 60000),
    stopH: Math.floor(stopMs / 3600000),
    stopM: Math.floor((stopMs % 3600000) / 60000),
    distKm: (totalDist / 1000).toFixed(1)
  };
}

function getWeeklyData() {
  const all = loadSessions();
  const days = ['일','월','화','수','목','금','토'];
  return Object.entries(all).slice(-7).map(([key, data]) => {
    const segs = data.segments || [];
    // 바쁜 정지 시간이 적을수록 한가한 날 → 주간 차트는 "바쁜 정지" 건수로 표시
    let busyCount = 0;
    segs.forEach(s => {
      if (s.type === 'stop' && (s.end - s.start) >= STOP_THRESHOLD_MS) busyCount++;
    });
    const d = new Date(key);
    return { label: days[d.getDay()], busyCount, key };
  });
}

function getRegions() {
  const all = loadSessions();
  const grid = {};
  Object.values(all).forEach(data => {
    (data.positions || []).forEach(p => {
      const cell = `${(p.lat * 100).toFixed(0)}_${(p.lng * 100).toFixed(0)}`;
      grid[cell] = (grid[cell] || 0) + 1;
    });
  });
  return Object.entries(grid).sort((a,b) => b[1]-a[1]).slice(0, 50);
}

/* ── Render ── */
function renderAll() {
  renderHeader();
  renderTimeline();
  renderRestCard();
  renderBarChart();
  if (document.getElementById('page-stats').classList.contains('active')) renderStats();
  if (document.getElementById('page-regions').classList.contains('active')) renderRegions();
}

function renderHeader() {
  const s = calcStats();
  document.getElementById('h-work').textContent = `${s.moveH}:${String(s.moveM).padStart(2,'0')}`;
  document.getElementById('h-rest').textContent = `${s.stopH}:${String(s.stopM).padStart(2,'0')}`;
  document.getElementById('h-dist').textContent = `${s.distKm}km`;
}

function renderRestCard() {
  const { startHr, endHr, pct } = analyzeToday();
  const fmt = h => `${Math.floor(h)}:${h % 1 === 0.5 ? '30' : '00'}`;
  document.getElementById('rest-start').textContent = fmt(startHr);
  document.getElementById('rest-end').textContent = fmt(endHr);
  const msg = pct > 0
    ? `이 시간대 배달 정지 <span>${pct}% 적음</span> — 가장 한가한 구간`
    : '추적을 시작하면 분석이 시작돼요';
  document.getElementById('rest-pct').innerHTML = msg;
}

function renderTimeline() {
  const canvas = document.getElementById('timeline-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const totalMs = (WORK_END - WORK_START) * 3600000;
  const dayStart = new Date(); dayStart.setHours(WORK_START, 0, 0, 0);
  const origin = dayStart.getTime();

  ctx.fillStyle = '#1e1e30';
  ctx.roundRect(0, 0, W, H, 6);
  ctx.fill();

  segments.forEach(seg => {
    const x1 = ((seg.start - origin) / totalMs) * W;
    const x2 = ((seg.end - origin) / totalMs) * W;
    const durMs = seg.end - seg.start;
    // 이동 = 파란색(한가함), 바쁜 정지(1분 이상) = 빨간색, 짧은 정지 = 회색
    if (seg.type === 'move') ctx.fillStyle = '#378ADD';
    else if (durMs >= STOP_THRESHOLD_MS) ctx.fillStyle = '#ff4d6d';
    else ctx.fillStyle = '#2a3a5a';
    ctx.fillRect(Math.max(0, x1), 0, Math.max(2, x2 - x1), H);
  });

  // 휴식 추천 구간 오버레이
  const { startHr, endHr } = analyzeToday();
  const rx1 = ((startHr - WORK_START) / (WORK_END - WORK_START)) * W;
  const rx2 = ((endHr - WORK_START) / (WORK_END - WORK_START)) * W;
  ctx.fillStyle = 'rgba(255, 180, 0, 0.25)';
  ctx.fillRect(rx1, 0, rx2 - rx1, H);
}

function renderBarChart() {
  const canvas = document.getElementById('bar-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const { busyMins } = analyzeToday();
  const max = Math.max(...busyMins, 1);
  const bw = W / busyMins.length;

  // 막대가 높을수록 = 그 시간대에 배달(정지)이 많음 = 바쁜 시간
  // 막대가 낮을수록 = 정지 없이 이동만 함 = 한가한 시간
  busyMins.forEach((v, i) => {
    const bh = (v / max) * (H - 4);
    const x = i * bw + 1;
    const isBusy = v > max * 0.6;
    ctx.fillStyle = isBusy ? '#ff4d6d' : '#2a3a5a';
    ctx.roundRect(x, H - bh, bw - 2, Math.max(bh, 2), 2);
    ctx.fill();
  });
}

function renderStats() {
  const weekly = getWeeklyData();
  const el = document.getElementById('weekly-bars');
  if (!el) return;
  const maxC = Math.max(...weekly.map(d => d.busyCount), 1);
  el.innerHTML = weekly.map(d => `
    <div class="wbar-item">
      <div class="wbar-wrap">
        <div class="wbar-fill" style="height:${Math.round((d.busyCount/maxC)*60)}px"></div>
      </div>
      <div class="wbar-label">${d.label}</div>
      <div class="wbar-val">${d.busyCount}건</div>
    </div>
  `).join('');
}

function renderRegions() {
  const el = document.getElementById('region-map');
  if (!el || !positions.length) {
    if (el) el.innerHTML = '<p style="color:var(--muted);text-align:center;padding:2rem 0;font-size:14px">추적 데이터가 쌓이면 지도가 표시돼요</p>';
    return;
  }
  const canvas = document.getElementById('map-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const lats = positions.map(p => p.lat);
  const lngs = positions.map(p => p.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const pad = 20;

  positions.forEach(p => {
    const x = pad + ((p.lng - minLng) / (maxLng - minLng + 0.0001)) * (W - pad*2);
    const y = H - pad - ((p.lat - minLat) / (maxLat - minLat + 0.0001)) * (H - pad*2);
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 229, 160, 0.5)';
    ctx.fill();
  });
}

/* ── UI helpers ── */
function updateTrackBtn() {
  const btn = document.getElementById('track-btn');
  if (!btn) return;
  if (tracking) { btn.textContent = '■  추적 종료'; btn.classList.add('stop'); }
  else { btn.textContent = '▶  GPS 추적 시작'; btn.classList.remove('stop'); }
}

function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2800);
}

let clockTimer = null;
function startClock() {
  if (clockTimer) return;
  clockTimer = setInterval(() => { if (tracking) renderHeader(); }, 10000);
}

function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + id).classList.add('active');
  const idx = { today: 0, stats: 1, regions: 2, settings: 3 }[id];
  document.querySelectorAll('.nav-btn')[idx].classList.add('active');
  if (id === 'stats') renderStats();
  if (id === 'regions') renderRegions();
}

/* ── Settings ── */
function loadSettings() {
  try { return JSON.parse(localStorage.getItem('rider_settings') || '{}'); } catch { return {}; }
}
function saveSettings() {
  const s = {
    workStart: document.getElementById('set-start').value,
    workEnd: document.getElementById('set-end').value,
    restGoal: document.getElementById('set-rest').value,
    stopMin: document.getElementById('set-stop').value,
  };
  localStorage.setItem('rider_settings', JSON.stringify(s));
  showToast('설정 저장됨');
}
function applySettings() {
  const s = loadSettings();
  if (s.workStart) document.getElementById('set-start').value = s.workStart;
  if (s.workEnd) document.getElementById('set-end').value = s.workEnd;
  if (s.restGoal) document.getElementById('set-rest').value = s.restGoal;
  if (s.stopMin) document.getElementById('set-stop').value = s.stopMin;
}

/* ── Init ── */
window.addEventListener('DOMContentLoaded', () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  todayKey = getTodayKey();
  const saved = loadSessions()[todayKey];
  if (saved) { positions = saved.positions || []; segments = saved.segments || []; }
  applySettings();
  renderAll();

  document.getElementById('track-btn').addEventListener('click', () => {
    tracking ? stopTracking() : startTracking();
  });
  document.getElementById('save-settings').addEventListener('click', saveSettings);

  function resizeCanvases() {
    ['timeline-canvas', 'bar-canvas', 'map-canvas'].forEach(id => {
      const c = document.getElementById(id);
      if (c) { c.width = c.offsetWidth; c.height = c.offsetHeight; }
    });
    renderAll();
  }
  window.addEventListener('resize', resizeCanvases);
  setTimeout(resizeCanvases, 100);
});

window.showPage = showPage;
