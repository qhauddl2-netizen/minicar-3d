/* ====================================================================
 *  backend-firebase.js — 방(실시간) 기능을 Firebase Realtime Database 로 처리
 *  랭킹/코스/사용자 이름 등 나머지는 더미 백엔드(dummy)를 그대로 사용한다.
 *
 *  DB 구조 (무료 플랜 다운로드량을 아끼려고 목록용/상세용을 분리)
 *    roomList/{code}            목록용 요약 (제목, 방장, 랩수, 코스 유무, 상태, p/{uid}=true → 인원수)
 *    rooms/{code}/meta          title, hostUid, laps, status, startAt, seed, fillAI, created
 *    rooms/{code}/seq           코스 (JSON 문자열) — 코스가 바뀔 때만 갱신됨
 *    rooms/{code}/players/{lane} 레인이 곧 자리: {uid, name, motor, tire}  (최대 3자리)
 *    rooms/{code}/spectators/{uid} = true
 *  방장/참가자 접속이 끊기면 onDisconnect 로 자동 정리한다 (서버 함수 없이 유령 방 방지).
 *  고정 방(FIXED_ROOM): 지워지지 않는다. 방장이 자리에 없으면 남은 참가자(또는 새로 들어온 사람)가
 *  meta/hostUid 를 트랜잭션으로 가져간다 (규칙에서 '방장이 자리에 없을 때만' 허용).
 *  보안 규칙: database.rules.json
 * ==================================================================== */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getDatabase, ref, get, set, update, remove, onValue, onDisconnect, runTransaction,
  query, orderByChild, limitToLast,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js';
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, updateDoc,
  query as fsQuery, orderBy as fsOrderBy, limit as fsLimit, where, getCountFromServer,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

// 주의: backend.js 를 import 하면 순환(교착)이 생기므로, 필요한 것은 인자(helpers)로 받는다.
const MAX = 3, STALE_MS = 6 * 3600 * 1000;      // 6시간 넘은 방은 목록에서 숨김
const makeCode = () => { const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let c = ''; for (let i = 0; i < 4; i++) c += A[Math.floor(Math.random() * A.length)]; return c; };

/** 익명 로그인 → 랭킹(Firestore) → databaseURL 이 있으면 방(Realtime DB). 나머지는 더미 그대로. */
export async function createFirebaseBackend(dummy, cfg, h) {
  const app = initializeApp(cfg);
  const cred = await signInAnonymously(getAuth(app));
  h.setUserUid(cred.user.uid);
  const api = { ...dummy, kind: 'firebase', rankKind: 'firebase', ...buildRanking(app, dummy, h) };
  if (cfg.databaseURL) Object.assign(api, await buildRooms(app, dummy, h));
  return api;
}

/* ---------------------------------------------------------------- 랭킹 (Firestore)
 *  boards/{코스키|랩}/records/{uid} = { name, time, best, motor, tire, at }  (사용자별 최고 기록 1개)
 *  - 하위 컬렉션 구조라 복합 인덱스 없이 time 단일 필드 정렬만 쓴다.
 *  - 한 번 보기 = 상위 10개 + 내 문서 + 집계 2회 ≈ 읽기 13회 (무료 일 5만 회)
 *  - 실패하면(Firestore 미생성/규칙 거부/네트워크) 더미로 대체한다. */
function buildRanking(app, dummy, { loadUser }) {
  const fs = getFirestore(app);
  const col = (ck, laps) => collection(fs, 'boards', `${ck}|${laps}`, 'records');
  const within = (p, ms = 7000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('시간 초과')), ms))]);
  const count = q => getCountFromServer(q).then(s => s.data().count);

  return {
    async topRecords(args) {
      const { courseKey: ck, laps, limit: lim = 10 } = args;
      try {
        const c = col(ck, laps), me = loadUser().uid;
        const [snap, total, mine] = await within(Promise.all([getDocs(fsQuery(c, fsOrderBy('time'), fsLimit(lim))), count(c), getDoc(doc(c, me))]));
        const rows = snap.docs.map((d, i) => ({ ...d.data(), uid: d.id, rank: i + 1, me: d.id === me }));
        let myRank = null, myBest = null;
        if (mine.exists()) { myBest = mine.data(); myRank = (await within(count(fsQuery(c, where('time', '<', myBest.time))))) + 1; }
        return { rows, total, myRank, myBest };
      } catch (e) { console.warn('[ranking] 불러오기 실패 → 더미 사용:', e); return dummy.topRecords(args); }
    },
    async submitRecord(args) {
      const { courseKey: ck, laps, time, best, motor, tire } = args;
      try {
        const u = loadUser(), c = col(ck, laps), ref = doc(c, u.uid);
        const cur = await within(getDoc(ref)), old = cur.exists() ? cur.data() : null;
        const bestLap = old && isFinite(old.best) ? Math.min(best, old.best) : best;
        let improved = false;
        if (!old) { await within(setDoc(ref, { name: u.name, time, best, motor, tire, at: Date.now() })); improved = true; }
        else if (time < old.time) { await within(setDoc(ref, { name: u.name, time, best: bestLap, motor, tire, at: Date.now() })); improved = true; }
        else await within(updateDoc(ref, { name: u.name, best: bestLap }));
        const myTime = improved ? time : old.time;
        const [ahead, total] = await within(Promise.all([count(fsQuery(c, where('time', '<', myTime))), count(c)]));
        return { improved, rank: ahead + 1, total };
      } catch (e) { console.warn('[ranking] 저장 실패 → 더미 사용:', e); return dummy.submitRecord(args); }
    },
  };
}

/* ---------------------------------------------------------------- 방 (Realtime Database) */
async function buildRooms(app, dummy, { loadUser, LANE_ORDER, FIXED_ROOM }) {
  const FX = FIXED_ROOM.code;
  const db = getDatabase(app);
  /* 서버 시각 보정: 서버시각 ≈ Date.now() + offset */
  let offset = 0;
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('Realtime Database 에 연결할 수 없어요 (databaseURL 확인)')), 8000);
    onValue(ref(db, '.info/serverTimeOffset'), s => { offset = s.val() || 0; clearTimeout(to); resolve(); });
  });
  const srvNow = () => Date.now() + offset;

  const R = code => ref(db, 'rooms/' + code);
  const L = code => ref(db, 'roomList/' + code);
  const me = () => loadUser();
  const roles = new Map();          // code → 'host' | 'guest' | 'spectator'
  const myLane = new Map();         // code → 내 레인
  const handles = new Map();        // code → onDisconnect 핸들들
  const hold = (code, od) => { if (!handles.has(code)) handles.set(code, []); handles.get(code).push(od); };
  const release = code => { (handles.get(code) || []).forEach(od => od.cancel().catch(() => { })); handles.delete(code); };
  const bad = msg => Promise.reject(new Error(msg));

  /** rooms/{code} 의 값 → 게임 코드가 쓰는 스냅샷 모양 */
  function buildSnap(code, v) {
    const m = v.meta;
    let seq = null; try { seq = v.seq ? JSON.parse(v.seq) : null; } catch { /* */ }
    const players = Object.entries(v.players || {}).map(([lane, p]) => ({ uid: p.uid, name: p.name, motor: p.motor, tire: p.tire, kit: typeof p.kit === 'string' ? p.kit : null, lane: +lane, bot: false }));
    const spectators = Object.keys(v.spectators || {}).map(uid => ({ uid, name: '' }));
    return { code, title: m.title || '', night: !!m.night, hostUid: m.hostUid, seq, courseName: '', laps: m.laps, status: m.status, startAt: m.startAt || 0, seed: m.seed || 0, fillAI: !!m.fillAI, players, spectators, serverNow: srvNow() };
  }
  async function fetchSnap(code) {
    const s = await get(R(code)), v = s.val();
    if (!v || !v.meta) throw new Error('사라진 방이에요.');
    return buildSnap(code, v);
  }
  async function claimSlot(code, motor, tire, kit) {
    const u = me();
    for (const lane of LANE_ORDER) {
      const r = await runTransaction(ref(db, `rooms/${code}/players/${lane}`), cur => cur ? undefined : { uid: u.uid, name: u.name, motor, tire, kit: kit || null });
      if (r.committed) return lane;
    }
    return -1;
  }

  /* ---- 고정 방 ---- */
  /** 고정 방이 아직 없으면 만든다 (처음 들어온 사람이 방장) */
  async function ensureFixed() {
    const m = (await get(ref(db, `rooms/${FX}/meta`))).val();
    if (m) return m;
    const u = me(), created = srvNow();
    const meta = { title: FIXED_ROOM.title, night: false, fixed: true, hostUid: u.uid, laps: FIXED_ROOM.laps, status: 'lobby', startAt: 0, seed: 0, fillAI: false, created };
    await update(ref(db), { [`rooms/${FX}/meta`]: meta, [`roomList/${FX}`]: { code: FX, title: FIXED_ROOM.title, fixed: true, hostUid: u.uid, hostName: u.name, laps: FIXED_ROOM.laps, hasCourse: false, seqLen: 0, status: 'lobby', created } });
    return meta;
  }
  /** 방장이 자리에 없으면 내가 방장이 된다. 성공하면 true */
  let claiming = false;
  async function claimHost() {
    if (claiming) return false; claiming = true;
    try {
      const u = me(), players = (await get(ref(db, `rooms/${FX}/players`))).val() || {};
      const present = new Set(Object.values(players).map(p => p.uid));
      const r = await runTransaction(ref(db, `rooms/${FX}/meta/hostUid`), cur => (cur && cur !== u.uid && present.has(cur)) ? undefined : u.uid);
      if (!r.committed || r.snapshot.val() !== u.uid) return false;
      if (roles.get(FX) !== 'spectator') roles.set(FX, 'host');
      await update(ref(db), { [`roomList/${FX}/hostUid`]: u.uid, [`roomList/${FX}/hostName`]: u.name }).catch(e => console.warn('[fixed] 목록 갱신 실패', e));
      return true;
    } catch (e) { console.warn('[fixed] 방장 승계 실패', e); return false; }
    finally { claiming = false; }
  }

  const api = {
    now: srvNow,

    /* ---- 방 목록: 요약 노드만, 최근 30개만 구독 ---- */
    subscribeRoomList(cb) {
      const row = r => ({ code: r.code, title: r.title || '', fixed: !!r.fixed, night: !!r.night, hostName: r.hostName || '?', laps: r.laps, hasCourse: !!r.hasCourse, seqLen: r.seqLen || 0, courseName: '', players: Object.keys(r.p || {}).length, max: MAX, status: r.status, created: r.created || 0 });
      let rows = [], fixed = null;
      const emit = () => cb(fixed ? [row(fixed), ...rows] : rows.slice());
      const off1 = onValue(query(ref(db, 'roomList'), orderByChild('created'), limitToLast(30)), snap => {
        const t = srvNow(); rows = [];
        snap.forEach(c => { const r = c.val(); if (!r || c.key === FX || t - (r.created || 0) > STALE_MS) return; rows.push(row(r)); });
        rows.sort((a, b) => b.created - a.created);
        emit();
      });
      const off2 = onValue(L(FX), s => { fixed = s.val(); emit(); });         // 고정 방은 오래돼도 항상 보인다
      return () => { off1(); off2(); };
    },

    async createRoom({ title, laps, night, motor, tire, kit }) {
      const u = me(); let code, tries = 0;
      do { code = makeCode(); if (++tries > 20) throw new Error('방 코드를 만들지 못했어요. 다시 시도해 주세요.'); } while ((await get(ref(db, `rooms/${code}/meta`))).exists());
      const created = srvNow(), t = (String(title || '').trim().slice(0, 20)) || (u.name + '의 방');
      const meta = { title: t, night: !!night, hostUid: u.uid, laps, status: 'lobby', startAt: 0, seed: 0, fillAI: false, created };
      // 1단계: 방 + 목록 항목 (규칙상 방이 먼저 있어야 자리를 잡을 수 있음)
      await update(ref(db), { [`rooms/${code}/meta`]: meta, [`roomList/${code}`]: { code, title: t, night: !!night, hostUid: u.uid, hostName: u.name, laps, hasCourse: false, seqLen: 0, status: 'lobby', created } });
      // 2단계: 방장은 가운데 레인(1)
      const lane = LANE_ORDER[0];
      const slot = { uid: u.uid, name: u.name, motor, tire, kit: kit || null };
      await update(ref(db), { [`rooms/${code}/players/${lane}`]: slot, [`roomList/${code}/p/${u.uid}`]: true });
      roles.set(code, 'host'); myLane.set(code, lane);
      const od1 = onDisconnect(R(code)); od1.remove(); hold(code, od1);       // 방장이 끊기면 방 삭제
      const od2 = onDisconnect(L(code)); od2.remove(); hold(code, od2);       // 목록에서도 삭제
      return { code, title: t, night: !!night, hostUid: u.uid, seq: null, courseName: '', laps, status: 'lobby', startAt: 0, seed: 0, fillAI: false, players: [{ ...slot, lane, bot: false }], spectators: [], serverNow: srvNow() };
    },

    async joinRoom(code, { motor, tire, kit }) {
      code = String(code).toUpperCase(); const u = me();
      const fixed = code === FX;
      if (fixed) {
        const m = await ensureFixed();
        if (m.status !== 'lobby') {           // 모두 나간 채로 '시작' 상태에 멈춰 있으면 대기 상태로 되돌린다
          const ps = (await get(ref(db, `rooms/${FX}/players`))).val();
          if (ps && Object.keys(ps).length) throw new Error('지금 레이스 중이에요. 잠시 후 다시 들어와 주세요.');
          if (await claimHost()) await update(ref(db), { [`rooms/${FX}/meta/status`]: 'lobby', [`rooms/${FX}/meta/startAt`]: 0, [`roomList/${FX}/status`]: 'lobby' });
        }
      }
      const ms = (await get(ref(db, `rooms/${code}/meta`))).val();
      if (!ms) throw new Error('사라진 방이에요.');
      if (ms.status !== 'lobby') throw new Error('이미 시작된 방이에요.');
      let lane = -1;
      const cur = (await get(ref(db, `rooms/${code}/players`))).val() || {};
      for (const [l, p] of Object.entries(cur)) if (p.uid === u.uid) lane = +l;
      if (lane < 0) { lane = await claimSlot(code, motor, tire, kit); if (lane < 0) throw new Error('방이 가득 찼어요 (최대 3명).'); }
      roles.set(code, 'guest'); myLane.set(code, lane);
      const od1 = onDisconnect(ref(db, `rooms/${code}/players/${lane}`)); od1.remove(); hold(code, od1);
      const od2 = onDisconnect(ref(db, `roomList/${code}/p/${u.uid}`)); od2.remove(); hold(code, od2);
      await set(ref(db, `roomList/${code}/p/${u.uid}`), true).catch(() => { });
      if (fixed) await claimHost();               // 방장이 자리에 없으면 내가 방장
      return fetchSnap(code);
    },

    async spectateRoom(code) {
      code = String(code).toUpperCase(); const u = me();
      const ms = (await get(ref(db, `rooms/${code}/meta`))).val();
      if (!ms) throw new Error('사라진 방이에요.');
      if (ms.status !== 'lobby') throw new Error('이미 시작된 방이라 관전할 수 없어요.');
      roles.set(code, 'spectator');
      const od = onDisconnect(ref(db, `rooms/${code}/spectators/${u.uid}`)); od.remove(); hold(code, od);
      await set(ref(db, `rooms/${code}/spectators/${u.uid}`), true);
      return fetchSnap(code);
    },

    /** meta / players / spectators / seq 를 따로 구독 → 코스(seq)는 바뀔 때만 다시 내려온다 */
    subscribeRoom(code, cb) {
      const v = {}, got = new Set(); let closed = false;
      const emit = key => {
        got.add(key);
        if (got.size < 4 || closed) return;
        if (!v.meta) { closed = true; cb({ code, status: 'closed' }); return; }
        if (code === FX) syncFixedHost(v);
        cb(buildSnap(code, v));
      };
      // 고정 방: 방장이 나갔으면 남은 사람 중 레인 순서가 빠른 사람부터 이어받는다 (동시에 시도해도 트랜잭션이 하나만 통과)
      let tmr = 0;
      const syncFixedHost = val => {
        const u = me(), ps = Object.entries(val.players || {}).sort((a, b) => LANE_ORDER.indexOf(+a[0]) - LANE_ORDER.indexOf(+b[0])).map(([, p]) => p.uid);
        const host = val.meta.hostUid, role = roles.get(code);
        if (role === 'spectator' || !ps.includes(u.uid)) return;
        if (host === u.uid) { roles.set(code, 'host'); return; }
        if (role === 'host') roles.set(code, 'guest');
        if (ps.includes(host)) return;
        clearTimeout(tmr); tmr = setTimeout(() => claimHost(), 300 + ps.indexOf(u.uid) * 900);
      };
      const offs = [
        onValue(ref(db, `rooms/${code}/meta`), s => { v.meta = s.val(); emit('meta'); }),
        onValue(ref(db, `rooms/${code}/players`), s => { v.players = s.val(); emit('players'); }),
        onValue(ref(db, `rooms/${code}/spectators`), s => { v.spectators = s.val(); emit('spectators'); }),
        onValue(ref(db, `rooms/${code}/seq`), s => { v.seq = s.val(); emit('seq'); }),
      ];
      return () => { clearTimeout(tmr); offs.forEach(f => f()); };
    },

    /* ---- 방장 전용 쓰기 ---- */
    async setRoomCourse(code, seq) {
      if (roles.get(code) !== 'host') return true;
      await update(ref(db), { [`rooms/${code}/seq`]: seq ? JSON.stringify(seq) : null, [`roomList/${code}/hasCourse`]: !!seq, [`roomList/${code}/seqLen`]: seq ? seq.length : 0 }).catch(e => console.warn('[setRoomCourse]', e));
      return true;
    },
    async setRoomLaps(code, laps) {
      if (roles.get(code) !== 'host') return true;
      await update(ref(db), { [`rooms/${code}/meta/laps`]: laps, [`roomList/${code}/laps`]: laps }).catch(e => console.warn('[setRoomLaps]', e));
      return true;
    },
    async setMySetup(code, { motor, tire, kit }) {
      const lane = myLane.get(code); if (lane == null || roles.get(code) === 'spectator') return false;
      await update(ref(db, `rooms/${code}/players/${lane}`), { motor, tire, kit: kit || null }).catch(() => { });
      return true;
    },
    async startRoom(code, opts = {}) {
      if (roles.get(code) !== 'host') return bad('방장만 시작할 수 있어요.');
      const v = (await get(R(code))).val();
      if (!v || !v.meta) return bad('사라진 방이에요.');
      if (!v.seq) return bad('코스를 먼저 완성하세요.');
      if (v.meta.status !== 'lobby') return true;
      const n = Object.keys(v.players || {}).length;
      await update(ref(db), {
        [`rooms/${code}/meta/fillAI`]: n === 1 && !!opts.ai,       // 혼자일 때만 AI 선택 가능
        [`rooms/${code}/meta/seed`]: Math.floor(Math.random() * 1e9),
        [`rooms/${code}/meta/startAt`]: srvNow() + 3200,
        [`rooms/${code}/meta/status`]: 'starting',
        [`roomList/${code}/status`]: 'starting',
      });
      return true;
    },
    /** 레이스 후 대기 상태로 복귀. 방장만 기록한다 (참가자는 방장의 변경을 구독으로 받는다) */
    async resetRoom(code) {
      if (roles.get(code) !== 'host') return true;
      const st = (await get(ref(db, `rooms/${code}/meta/status`))).val();
      if (st && st !== 'lobby') await update(ref(db), { [`rooms/${code}/meta/status`]: 'lobby', [`rooms/${code}/meta/startAt`]: 0, [`roomList/${code}/status`]: 'lobby' }).catch(() => { });
      return true;
    },

    async leaveRoom(code) {
      const role = roles.get(code), u = me();
      try {
        if (role === 'host' && code !== FX) await Promise.all([remove(R(code)), remove(L(code))]);
        else if (role === 'spectator') await remove(ref(db, `rooms/${code}/spectators/${u.uid}`));
        else if (role === 'guest' || role === 'host') {      // 고정 방의 방장은 자리만 비운다 (남은 사람이 방장을 이어받음)
          const lane = myLane.get(code);
          await Promise.all([lane != null ? remove(ref(db, `rooms/${code}/players/${lane}`)) : null, remove(ref(db, `roomList/${code}/p/${u.uid}`))]);
        }
      } catch (e) { console.warn('[leaveRoom]', e); }
      release(code); roles.delete(code); myLane.delete(code);
      return true;
    },
  };
  return api;
}
