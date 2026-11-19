/* ====================================================================
 *  backend.js — 더미 백엔드 (localStorage + 메모리 + 가짜 플레이어)
 *
 *  게임 코드는 이 파일의 `backend` 객체만 사용합니다.
 *  나중에 Firebase로 바꿀 때는 같은 메서드 시그니처로 이 파일만 교체하세요.
 *    - 모든 메서드는 Promise를 반환 (subscribeRoom 제외: 구독 해제 함수를 반환)
 *    - 사용자  : getUser / setName
 *    - 랭킹    : topRecords / submitRecord                  → Firestore `records`
 *    - 코스    : listCourses / saveCourse / deleteCourse    → Firestore `courses`
 *    - 방      : subscribeRoomList / createRoom / joinRoom / subscribeRoom /
 *                spectateRoom / setRoomCourse / setRoomLaps / setMySetup /
 *                startRoom / resetRoom / leaveRoom          → Realtime DB `rooms/{code}`
 *  시간은 모두 backend.now() (서버 시각 기준 ms) 를 사용합니다.
 * ==================================================================== */

export const BACKEND_KIND = 'dummy';

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } },
};
const wait = (v, ms = 140) => new Promise(r => setTimeout(() => r(v), ms));
const clone = o => JSON.parse(JSON.stringify(o));

/* ---- 공용 유틸 (결정적 난수) ---- */
export function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
export function rng(seed) {   // mulberry32
  let a = seed | 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** 코스 식별자: 부품 순서를 회전해도 같은 값이 되도록 정규화한 뒤 해시 */
export function courseKey(seq) {
  let best = null;
  for (let i = 0; i < seq.length; i++) { const s = seq.slice(i).concat(seq.slice(0, i)).join(','); if (best === null || s < best) best = s; }
  return 'c' + hash(best || '').toString(36);
}

const MOTOR_IDS = ['torque', 'hyper', 'power', 'atomic', 'mach'], TIRE_IDS = ['soft', 'mid', 'hard'];
/** 「우리는 챔피언」(SBS 더빙판) 캐릭터 이름 — 닉네임 / 가짜 참여자 이름으로 사용 */
export const CHAMP_NAMES = ['남궁열', '남궁호', '독고진', '독고민', '나원승', '나치티', '공진수'];
const FAKE_NAMES = CHAMP_NAMES;

/* ---------------------------------------------------------------- 사용자 */
let user = null;
function loadUser() {
  if (user) return user;
  let uid = LS.get('mini4wd.uid', null), name = LS.get('mini4wd.name', null);
  if (!uid) { uid = 'u' + Math.random().toString(36).slice(2, 10); LS.set('mini4wd.uid', uid); }
  // 이름 없음 / 예전 자동 닉네임(레이서123)이면 캐릭터 이름 + 숫자로 새로 정한다
  if (!name || /^레이서\d+$/.test(name)) { name = CHAMP_NAMES[Math.floor(Math.random() * CHAMP_NAMES.length)] + Math.floor(1 + Math.random() * 99); LS.set('mini4wd.name', name); }
  user = { uid, name }; return user;
}

/* ---------------------------------------------------------------- 랭킹 */
const REC_KEY = 'mini4wd.dummy.records';
const recKey = (ck, laps) => ck + '|' + laps;
function ensureSeeded(db, ck, laps, hint) {
  const k = recKey(ck, laps);
  if (db[k]) return;
  const r = rng(hash(k)), list = [];
  const base = hint || 40 * laps;
  for (let i = 0; i < 9; i++) {
    const time = base * (0.93 + i * 0.04 + r() * 0.03);
    list.push({ uid: 'bot' + i, name: FAKE_NAMES[(hash(k) + i * 5) % FAKE_NAMES.length] + (i % 3 ? '' : '💨'), time, best: time / laps * (0.96 + r() * 0.03), motor: MOTOR_IDS[Math.floor(r() * MOTOR_IDS.length)], tire: TIRE_IDS[Math.floor(r() * 3)], at: Date.now() - Math.floor(r() * 20) * 86400000, bot: true });
  }
  db[k] = list;
}
const sortRec = l => l.sort((a, b) => a.time - b.time);

/* ---------------------------------------------------------------- 코스 */
const COURSE_KEY = 'mini4wd.dummy.courses';
/** 더미 공유 코스: 앱이 처음 실행될 때 seed 로 채울 수 있도록 main 에서 setSeedCourses 로 주입 */
let seedCourses = [];
export function setSeedCourses(list) { seedCourses = list; }
function allCourses() {
  const mine = LS.get(COURSE_KEY, []);
  const seeds = seedCourses.map((c, i) => ({ id: 'seed' + i, name: c.name, owner: 'bot' + i, ownerName: FAKE_NAMES[(i * 3 + 1) % FAKE_NAMES.length], seq: c.seq, at: Date.now() - (i + 1) * 3 * 86400000, likes: 3 + ((i * 7) % 11), seed: true }));
  return mine.concat(seeds);
}

/* ---------------------------------------------------------------- 방 (온라인 대전 더미) */
const rooms = new Map();         // code → { room, subs:Set, timers:[], fake }
const listSubs = new Set();
const LANE_ORDER = [1, 0, 2];    // 입장 순서대로 가운데 → 왼쪽 → 오른쪽
const snap = r => { const o = clone(r); o.serverNow = Date.now(); return o; };
const roomRow = h => { const r = h.room, host = r.players.find(p => p.uid === r.hostUid); return { code: r.code, title: r.title || '', night: !!r.night, hostName: host ? host.name : '?', laps: r.laps, hasCourse: !!r.seq, seqLen: r.seq ? r.seq.length : 0, courseName: r.courseName || '', players: r.players.length, max: 3, status: r.status }; };
const listSync = () => { seedFakeRooms(); return [...rooms.values()].map(roomRow); };
const notifyList = () => { if (!listSubs.size) return; const l = listSync(); listSubs.forEach(cb => cb(l)); };
const notify = h => { const s2 = snap(h.room); h.subs.forEach(cb => cb(s2)); notifyList(); };
const makeCode = () => { const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let c = ''; for (let i = 0; i < 4; i++) c += A[Math.floor(Math.random() * A.length)]; return c; };
function botPlayer(room) {
  const used = new Set(room.players.map(p => p.name)), pool = FAKE_NAMES.filter(n => !used.has(n));
  const r = Math.random;
  return { uid: 'bot' + Math.random().toString(36).slice(2, 7), name: pool[Math.floor(r() * pool.length)], motor: MOTOR_IDS[Math.floor(r() * MOTOR_IDS.length)], tire: TIRE_IDS[Math.floor(r() * 3)], lane: 0, bot: true };
}
function addPlayer(h, p) {
  if (h.room.players.length >= 3) return false;
  p.lane = LANE_ORDER[h.room.players.length]; h.room.players.push(p); notify(h); return true;
}
function doStart(h, ai) {
  if (h.room.status !== 'lobby' || !h.room.seq) return false;
  h.room.fillAI = h.room.players.length === 1 && !!ai;      // 혼자일 때만 AI 선택 가능. 참여자가 있으면 AI 없음
  h.room.seed = Math.floor(Math.random() * 1e9);
  h.room.startAt = Date.now() + 3200;
  h.room.status = 'starting'; notify(h); return true;
}
/** 더미 방 목록: 앱이 처음 목록을 볼 때 가짜 방장이 연 방 3개를 만든다 */
let fakeSeeded = false;
function seedFakeRooms() {
  if (fakeSeeded) return; fakeSeeded = true;
  const spec = [{ code: 'K7M2', n: 1, laps: 3, title: '초보 환영! 오벌에서 한판' }, { code: 'R4TX', n: 2, laps: 2, title: '점프 서킷 같이 달려요' }, { code: 'B9QA', n: 3, laps: 1, title: '슬로프 챌린지 (가득 참)' }];
  spec.forEach((sp, i) => {
    const c = seedCourses[i % Math.max(1, seedCourses.length)]; if (!c) return;
    const h = { subs: new Set(), timers: [], fake: true, armed: false, room: { code: sp.code, title: sp.title, hostUid: 'bothost' + i, seq: c.seq, courseName: c.name, laps: sp.laps, status: 'lobby', startAt: 0, seed: 0, fillAI: false, players: [], spectators: [] } };
    rooms.set(sp.code, h);
    for (let k = 0; k < sp.n; k++) { const b = botPlayer(h.room); if (k === 0) b.uid = 'bothost' + i; p2(h, b); }
  });
}
function p2(h, p) { p.lane = LANE_ORDER[h.room.players.length]; h.room.players.push(p); }
/** 가짜 방장이 사람이 입장한 뒤 잠시 후 자동 시작 */
function armFakeStart(h) {
  if (!h.fake || h.armed) return; h.armed = true;
  h.timers.push(setTimeout(() => { h.armed = false; doStart(h, false); }, 11000));
}

/** Firebase 익명 로그인 uid 를 내 uid 로 사용 (backend-firebase.js 가 호출) */
export function setUserUid(uid) { loadUser().uid = uid; }
export { MOTOR_IDS, TIRE_IDS, FAKE_NAMES, LANE_ORDER, loadUser };

const dummy = {
  kind: BACKEND_KIND,
  now: () => Date.now(),
  getUser: () => wait({ ...loadUser() }, 30),
  userSync: () => ({ ...loadUser() }),
  setName(name) { const u = loadUser(); u.name = String(name).trim().slice(0, 12) || u.name; LS.set('mini4wd.name', u.name); return wait({ ...u }, 30); },

  /* ---- 랭킹 ---- */
  async topRecords({ courseKey: ck, laps, hint, limit = 10 }) {
    const db = LS.get(REC_KEY, {}); ensureSeeded(db, ck, laps, hint); LS.set(REC_KEY, db);
    const list = sortRec(db[recKey(ck, laps)].slice()), me = loadUser().uid;
    const rows = list.slice(0, limit).map((r, i) => ({ ...r, rank: i + 1, me: r.uid === me }));
    const mine = list.findIndex(r => r.uid === me);
    return wait({ rows, total: list.length, myRank: mine < 0 ? null : mine + 1, myBest: mine < 0 ? null : list[mine] }, 160);
  },
  /** 내 기록 제출. 사용자별 최고 기록 1개만 유지. */
  async submitRecord({ courseKey: ck, laps, hint, time, best, motor, tire }) {
    const u = loadUser(), db = LS.get(REC_KEY, {}); ensureSeeded(db, ck, laps, hint);
    const k = recKey(ck, laps), list = db[k], i = list.findIndex(r => r.uid === u.uid);
    let improved = false;
    if (i < 0) { list.push({ uid: u.uid, name: u.name, time, best, motor, tire, at: Date.now() }); improved = true; }
    else if (time < list[i].time) { list[i] = { uid: u.uid, name: u.name, time, best: Math.min(best, list[i].best), motor, tire, at: Date.now() }; improved = true; }
    else { list[i].name = u.name; list[i].best = Math.min(list[i].best, best); }
    LS.set(REC_KEY, db);
    const sorted = sortRec(list.slice());
    return wait({ improved, rank: sorted.findIndex(r => r.uid === u.uid) + 1, total: sorted.length }, 160);
  },

  /* ---- 방 목록 ---- */
  /** 열린 방 목록 구독. 바뀔 때마다 cb(rows). 해제 함수를 반환 */
  subscribeRoomList(cb) { listSubs.add(cb); setTimeout(() => listSubs.has(cb) && cb(listSync()), 120); return () => listSubs.delete(cb); },

  /* ---- 방 ---- */
  async createRoom({ title, laps, night, motor, tire, kit }) {
    const u = loadUser(); let code; do { code = makeCode(); } while (rooms.has(code));
    const h = { subs: new Set(), timers: [], fake: false, armed: false, room: { code, title: (String(title || '').trim().slice(0, 20)) || (u.name + '의 방'), night: !!night, hostUid: u.uid, seq: null, laps, status: 'lobby', startAt: 0, seed: 0, fillAI: false, players: [], spectators: [] } };
    rooms.set(code, h); addPlayer(h, { uid: u.uid, name: u.name, motor, tire, kit, lane: 0, bot: false });
    // 더미: 방장이 코스를 만드는 동안 가짜 참여자가 한참 뒤에 한 명씩 들어온다 (그 전에 시작하면 혼자하기/AI와하기)
    [20000, 45000].forEach(ms => h.timers.push(setTimeout(() => { if (h.room.status === 'lobby' && rooms.get(code) === h) addPlayer(h, botPlayer(h.room)); }, ms)));
    return wait(snap(h.room), 200);
  },
  async joinRoom(code, { motor, tire, kit }) {
    const u = loadUser(); seedFakeRooms();
    const h = rooms.get(String(code).toUpperCase());
    if (!h) throw new Error('사라진 방이에요.');
    if (h.room.status !== 'lobby') throw new Error('이미 시작된 방이에요.');
    if (!h.room.players.some(p => p.uid === u.uid)) { if (!addPlayer(h, { uid: u.uid, name: u.name, motor, tire, kit, lane: 0, bot: false })) throw new Error('방이 가득 찼어요 (최대 3명).'); }
    armFakeStart(h);
    return wait(snap(h.room), 200);
  },
  /** 관전: 인원 제한 없이 입장. 차도 레인도 없고 레이스를 보기만 한다 */
  async spectateRoom(code) {
    const u = loadUser(); seedFakeRooms();
    const h = rooms.get(String(code).toUpperCase());
    if (!h) throw new Error('사라진 방이에요.');
    if (h.room.status !== 'lobby') throw new Error('이미 시작된 방이라 관전할 수 없어요.');
    if (!h.room.spectators.some(p => p.uid === u.uid)) { h.room.spectators.push({ uid: u.uid, name: u.name }); notify(h); }
    armFakeStart(h);
    return wait(snap(h.room), 200);
  },
  subscribeRoom(code, cb) {
    const h = rooms.get(code); if (!h) { setTimeout(() => cb({ code, status: 'closed' }), 0); return () => { }; }
    h.subs.add(cb); setTimeout(() => h.subs.has(cb) && cb(snap(h.room)), 0);
    return () => h.subs.delete(cb);
  },
  setRoomCourse(code, seq) { const h = rooms.get(code); if (h && h.room.hostUid === loadUser().uid) { h.room.seq = seq ? seq.slice() : null; notify(h); } return wait(true, 20); },
  setRoomLaps(code, laps) { const h = rooms.get(code); if (h && h.room.hostUid === loadUser().uid) { h.room.laps = laps; notify(h); } return wait(true, 20); },
  setMySetup(code, { motor, tire, kit }) {
    const h = rooms.get(code), u = loadUser(); if (!h || h.room.status !== 'lobby') return wait(false, 30);
    const p = h.room.players.find(q => q.uid === u.uid); if (p) { p.motor = motor; p.tire = tire; p.kit = kit; notify(h); }
    return wait(true, 30);
  },
  /** 방장만. opts.ai: 혼자일 때 AI와 함께할지 (참여자가 있으면 무시) */
  startRoom(code, opts = {}) {
    const h = rooms.get(code), u = loadUser(); if (!h) return Promise.reject(new Error('사라진 방이에요.'));
    if (h.room.hostUid !== u.uid) return Promise.reject(new Error('방장만 시작할 수 있어요.'));
    if (!h.room.seq) return Promise.reject(new Error('코스를 먼저 완성하세요.'));
    doStart(h, opts.ai); return wait(true, 30);
  },
  /** 레이스가 끝나고 방으로 돌아올 때: 다시 대기 상태로 */
  resetRoom(code) {
    const h = rooms.get(code); if (!h) return wait(false, 20);
    if (h.room.status !== 'lobby') { h.room.status = 'lobby'; h.room.startAt = 0; notify(h); }
    if (h.fake && (h.room.players.some(p => !p.bot) || h.room.spectators.length)) armFakeStart(h);
    return wait(true, 20);
  },
  leaveRoom(code) {
    const h = rooms.get(code), u = loadUser(); if (!h) return wait(true, 30);
    if (h.room.hostUid === u.uid) { h.timers.forEach(clearTimeout); h.room.status = 'closed'; notify(h); rooms.delete(code); notifyList(); }
    else {
      h.room.spectators = h.room.spectators.filter(p => p.uid !== u.uid);
      h.room.players = h.room.players.filter(p => p.uid !== u.uid); h.room.players.forEach((p, i) => { p.lane = LANE_ORDER[i]; });
      if (h.fake && !h.room.players.some(p => !p.bot) && !h.room.spectators.length) { h.timers.forEach(clearTimeout); h.timers = []; h.armed = false; if (h.room.status !== 'lobby') { h.room.status = 'lobby'; h.room.startAt = 0; } }
      notify(h);
    }
    return wait(true, 30);
  },
};

/* ---------------------------------------------------------------- 백엔드 선택
 * src/firebase-config.js 에 설정값이 채워져 있고 로그인까지 성공하면 방(실시간)은 Firebase,
 * 그 외(랭킹/코스)는 더미를 그대로 쓴다. 값이 비었거나 실패하면 전부 더미. */
async function pick() {
  try {
    const { firebaseConfig } = await import('./firebase-config.js');
    if (!firebaseConfig || !firebaseConfig.apiKey || !firebaseConfig.projectId) return dummy;
    const { createFirebaseBackend } = await import('./backend-firebase.js');
    return await createFirebaseBackend(dummy, firebaseConfig, { setUserUid, loadUser, LANE_ORDER });
  } catch (e) { console.warn('[backend] Firebase 사용 불가 → 더미로 동작:', e); return dummy; }
}
export const backend = await pick();
