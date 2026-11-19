// 미니4WD 자동 주행 시뮬레이션 (three.js 의존 없음). 운전 없음: 모터 + 세팅 + 코스가 결과를 결정한다.
import { sampleAt, groundH, findIndex, JUMP, ROAD_HALF } from './track.js';
import { MOTORS, TIRES, WALL_G, REST_BASE, deriveSpec } from './parts.js';

/* 모터·타이어 표와 세팅 → 성능 계산은 parts.js (미니카 커스텀) */
export { MOTORS, TIRES };

/* 시간 배율: 트랙 1단위 = 2.7cm (직선 20 = 실제 54cm). 시뮬레이션 단위 그대로면 중력이 실제의 1/9 이라 전체가 슬로모션처럼 보인다.
 * 시뮬레이션 시간을 실제 시간의 3배로 흘리면 중력 40×3² = 360 단위/s² ≈ 9.7m/s² (실제와 같음), 속도도 실제 미니4WD 체감에 가까워진다.
 * 물리·밸런스(모터/롤러/점프)는 그대로이고, 화면에 보이는 기록만 실제 시간(= 시뮬레이션 시간 / TIME_SCALE)으로 바꿔 표시한다. */
export const TIME_SCALE = 3;
export const CRASH_TIME = 0.5;  // 코스아웃 장면은 절반 속도(슬로모션)로 재생해 날아가는 모습이 보이게 한다 (복귀까지 실제 약 1.3초)
export const G = 40;
const RESPAWN_T = 1.9;
export const BOUNCE_OUT = 9;   // 착지 후 튀어 오르는 속도가 이 이상이면 벽을 넘어 코스아웃
const JUMP_KICK_MAX = 10;      // 점프대가 더해 줄 수 있는 최대 수직 속도 (v≈24 이하면 못 넘음)
const BOUNCE_HOP = 3.2;        // 이 이상이면 한 번 더 통통 튄다 (속도 손실)
const BRAKE_SLOPE = 0.02;
const WAVE_LOSS = 0.5;         // 웨이브 구간 감속 (착지 반발이 작을수록 = 매스댐퍼가 좋을수록 덜 흔들려 덜 느려진다)      // 이보다 기울어진 경사(오르막·내리막·점프대)에서 브레이크 스펀지가 노면에 닿는다

/* ---- 코스아웃 시 충돌 물리 ----
 * 트랙 기준 좌표(lat: 중심선에서 좌우 거리, h: 노면 높이)로 벽/칸막이/노면과 충돌한다.
 * 수치는 main.js 의 트랙 모델(WALL_H, DIV_H, DIV_LAT, ROAD_HALF)과 맞춰 둘 것. 난수를 쓰지 않으므로 모든 접속자에서 결과가 같다. */
export const WALL = { H: 1.6, T: 0.7, DIV_LAT: 2.5, DIV_H: 1.5, DIV_T: 0.44, BODY: 1.3 };
const CAR_HW = 1.5, CAR_H = 1.2, FLOOR = 0.02;
const VAULT_VN = 11;       // 벽에 부딪히는 수직 속도가 이 이상이면 벽을 타고 올라간다 (충분히 높이 오르면 넘어가고, 모자라면 벽 위에 얹힌다)
const OBST = [
  { a: ROAD_HALF, b: ROAD_HALF + WALL.T, top: WALL.H, wall: true },
  { a: -ROAD_HALF - WALL.T, b: -ROAD_HALF, top: WALL.H, wall: true },
  { a: WALL.DIV_LAT - WALL.DIV_T / 2, b: WALL.DIV_LAT + WALL.DIV_T / 2, top: WALL.DIV_H, wall: false },
  { a: -WALL.DIV_LAT - WALL.DIV_T / 2, b: -WALL.DIV_LAT + WALL.DIV_T / 2, top: WALL.DIV_H, wall: false },
];

function crashStep(car, tr, dt) {
  const c = car.c, n = tr.n;
  c.vy -= G * dt; c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt;
  if (car.vaultT > 0) car.vaultT -= dt;
  if (car.launchT > 0) car.launchT -= dt;
  // 가장 가까운 중심선 샘플
  let bi = car.ci, bd = Infinity;
  for (let k = -6; k <= 6; k++) { const i = (car.ci + k + n * 4) % n, dx = c.x - tr.X[i], dz = c.z - tr.Z[i], d = dx * dx + dz * dz; if (d < bd) { bd = d; bi = i; } }
  car.ci = bi;
  const nx = tr.DZ[bi], nz = -tr.DX[bi], h = tr.H[bi];
  let lat = (c.x - tr.X[bi]) * nx + (c.z - tr.Z[bi]) * nz;
  if (car.launchT > 0 && car.crashT > 0.25 && Math.abs(lat) > ROAD_HALF + WALL.T + CAR_HW) car.launchT = 0;   // 벽을 완전히 넘어서면 튀어 나가기 끝
  let vn = c.vx * nx + c.vz * nz;
  let supported = false;
  const shift = (newLat, newVn) => { c.x += nx * (newLat - lat); c.z += nz * (newLat - lat); c.vx += nx * (newVn - vn); c.vz += nz * (newVn - vn); lat = newLat; vn = newVn; };

  if (!isNaN(h) && !(car.launchT > 0)) {             // 점프 공백(h=NaN)에는 노면·벽이 없다. 코스아웃으로 튀어 나가는 중(launchT)에는 칸막이·벽을 넘어간다
    for (const o of OBST) {
      if (!o.wall && tr.seq[tr.PI[bi]] === 'lane') continue;          // 레인체인지 구간에는 칸막이가 없다
      const top = h + o.top, bot = h - WALL.BODY;
      if (lat <= o.a - CAR_HW || lat >= o.b + CAR_HW || c.y + CAR_H <= bot) continue;
      const mid = (o.a + o.b) / 2;
      if (car.vaultT > 0 && o === car.vaultObst && c.vy > 0) {      // 벽면을 타고 오르는 중: 중심이 벽 중앙에 닿기 전에 바닥이 벽 높이까지 올라온다
        const d = car.vaultSign < 0 ? lat - (o.a - CAR_HW) : (o.b + CAR_HW) - lat, frac = Math.min(1, Math.max(0, d / (CAR_HW + (o.b - o.a) / 2)));
        if (c.y < h + o.top * frac) c.y = h + o.top * frac;
        if (car.vaultCaught && frac >= 1) { c.y = top; c.vy = 0; supported = true; if (!car.caught) { car.caught = true; car.events.push({ type: 'caught' }); } }
        continue;
      }
      const overTop = lat > o.a - 0.9 && lat < o.b + 0.9;                       // 차의 중심이 벽 윗면 위
      const rising = car.vaultT > 0 && c.vy < 0 && c.y >= top - 0.6;          // 벽을 타고 오르다 내려오는 중이면 윗면에 얹힘
      if (c.y >= top - 0.05 || (rising && overTop)) {   // 벽 위: 윗면에 얹힌다
        if (overTop && c.vy <= 0 && c.y <= top + 0.4) {
          c.y = top; c.vy = 0; supported = true;
          if (o.wall && !car.caught) { car.caught = true; car.events.push({ type: 'caught' }); }     // 중심이 벽 위에 실리면 걸려서 멈춘다
        }
        continue;
      }
      const sideSign = lat < mid ? -1 : 1, into = sideSign < 0 ? vn : -vn;      // into>0: 벽쪽으로 향하는 속도
      if (into > 0 && o.wall && into > VAULT_VN) {     // 빠르게 들이받으면 벽면을 타고 올라 넘어간다
        // 올라타는 힘(수직 속도)이 벽 중앙까지 가는 동안 벽 높이를 넘기에 충분하면 넘어가고, 모자라면 벽 위에 걸린다
        const dtot = CAR_HW + (o.b - o.a) / 2, tm = dtot / (into * 0.85), vy0 = into * 1.05, req = o.top / tm + 0.5 * G * tm;
        car.vaultSign = sideSign; car.vaultObst = o; car.vaultT = 0.7; car.vaultCaught = vy0 < req * 1.1;
        c.vy = Math.max(c.vy, vy0); shift(lat, vn * 0.85);
        car.events.push({ type: 'wallhit', speed: into }); continue;
      }
      shift(sideSign < 0 ? o.a - CAR_HW : o.b + CAR_HW, into > 0 ? -vn * 0.3 : vn);   // 튕겨 나온다
      if (into > 0) { c.vx *= 0.9; c.vz *= 0.9; c.ry += sideSign * into * 0.15; if (into > 4) car.events.push({ type: 'wallhit', speed: into }); }
    }
    if (Math.abs(lat) <= ROAD_HALF && c.y <= h && c.y > h - 1.2) {     // 노면에 닿음
      c.y = h; supported = true;
      if (c.vy < 0) c.vy = c.vy < -3 ? -c.vy * 0.3 : 0;
    }
  }
  if (c.y <= FLOOR) { c.y = FLOOR; supported = true; if (c.vy < 0) c.vy = c.vy < -3 ? -c.vy * 0.25 : 0; }
  if (supported) {                                    // 바닥/벽 위에서 미끄러지며 멈춘다 (트랙 밖 잔디는 더 빨리 멈춤)
    const grass = c.y <= FLOOR + 0.01 && Math.abs(lat) > ROAD_HALF + WALL.T;
    const f = Math.exp(-(car.caught ? 14 : grass ? 6 : 2.6) * dt), g = Math.exp(-4 * dt);
    c.vx *= f; c.vz *= f; c.rx *= g; c.rz *= g; c.ry *= g;
  }
}


export const vcrit = (tire, R) => Math.sqrt(tire.grip * R);

/* ---- 레인 ----
 * 차의 좌우 위치는 고정값이 아니라 "트랙 위 진행 거리 s" 의 함수다. 레인체인지 구간을 지날 때마다 레인 번호가 한 칸 순환(0→1→2→0)하고,
 * 구간 안에서는 부드럽게 옆 레인으로 옮겨 간다. s 만으로 결정되므로 코스아웃 후 복구해도, 어느 접속자에서도 같은 결과가 나온다. */
export const LANE_LAT = [5, 0, -5];          // 1·2·3 레인의 중심선 기준 좌우 거리 (main.js 의 LANES 와 동일)
export const BRIDGE_H = 4.0;                 // 레인체인지의 고가 구간 높이 (3레인 → 1레인으로 건너가는 경로)
/** 진행 거리 s 에서 이 차의 레인 번호(idx)와 레인체인지 구간 안 진행률(t, 0~1) */
function laneState(car, tr, s) {
  const lc = tr.lc;
  if (!lc || !lc.length) return { idx: car.laneIdx0, t: 0, len: 1 };
  const L = tr.Ltot, lap = Math.floor(s / L), x = s - lap * L;
  let idx = car.laneIdx0 + lap * lc.length, t = 0, len = 1;
  for (const seg of lc) { if (x >= seg.s1) idx++; else if (x > seg.s0) { len = seg.s1 - seg.s0; t = (x - seg.s0) / len; break; } else break; }
  return { idx: ((idx % 3) + 3) % 3, t, len };
}
/* 이동 곡선(구간 진행률 t 0~1): 지상 두 레인은 30% 지점부터 오른쪽으로 이동하고, 고가는 먼저 올라가 70%까지 높이를 유지한 채 왼쪽으로 건너간다.
 * 그래서 어느 순간에도 지상 차가 고가 밑면에 닿지 않는다(검색으로 찾은 값). 화면(main.js)도 같은 함수를 써서 모양이 일치한다. */
const ss = x => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
// bA~bB: 고가가 좌우로 건너가는 구간, r 까지 올라가 f 까지 높이 유지, gA~gB: 지상 채널이 휘는 구간 (양 끝은 직선 — 실제 부품(OBJ)과 같은 배치)
export const LANE_PROF = { bA: 0.06, bB: 0.94, gA: 0.25, gB: 0.75, r: 0.3, f: 0.7 };
export const laneGroundE = t => ss((t - LANE_PROF.gA) / (LANE_PROF.gB - LANE_PROF.gA));
export const laneBridgeE = t => ss((t - LANE_PROF.bA) / (LANE_PROF.bB - LANE_PROF.bA));
export const laneBridgeLift = t => BRIDGE_H * ss((t - LANE_PROF.bA) / (LANE_PROF.r - LANE_PROF.bA)) * (1 - ss((t - LANE_PROF.f) / (LANE_PROF.bB - LANE_PROF.f)));
export function laneLatAt(car, tr, s) {
  const { idx, t } = laneState(car, tr, s);
  if (idx === 2) return LANE_LAT[2] + (LANE_LAT[0] - LANE_LAT[2]) * laneBridgeE(t);          // 3레인 → 1레인 (고가)
  return LANE_LAT[idx] + (LANE_LAT[idx + 1] - LANE_LAT[idx]) * laneGroundE(t);                // 1→2, 2→3 (지상)
}
/** 고가 구간: 3레인 차(오른쪽 끝)가 1레인(왼쪽 끝)으로 건너갈 때만 위로 솟았다 내려온다. 나머지 두 레인은 지상에서 오른쪽으로 한 칸 이동. */
export function laneLiftAt(car, tr, s) {
  const { idx, t, len } = laneState(car, tr, s);
  if (idx !== 2 || t <= 0) return { lift: 0, slope: 0 };
  const d = 1e-3;
  return { lift: laneBridgeLift(t), slope: (laneBridgeLift(Math.min(1, t + d)) - laneBridgeLift(Math.max(0, t - d))) / ((Math.min(1, t + d) - Math.max(0, t - d)) * len) };
}

/** 출발선에서 GO 와 동시에 내보내는 초기 속도: 점프/코너 앞에서 가속이 모자라 실패하는 걸 막는다.
 *  모터 최고속도의 60% 이하, 출발 직후가 코너면 그 코너 한계속도의 90% 이하로 제한한다. */
export const V_LAUNCH = 20;
export function launchSpeed(car, tr) {
  const info = sampleAt(tr, car.s), vmaxE = car.spec.vmax * (car.speedMul || 1);
  let v = Math.min(V_LAUNCH, vmaxE * 0.6);
  if (info.R > 0) v = Math.min(v, vcrit(car.tire, Math.max(8, info.R - info.sign * laneLatAt(car, tr, car.s))) * 0.9);
  return v;
}

/** setup: 커스텀 세팅(kit 객체/문자열) 또는 예전 { motor, tire }. 성능은 deriveSpec 이 부품 조합으로 계산한다 */
/** 레이스마다 같은 시드 → 모든 접속자에서 같은 난수열 (코너 흔들림) */
function seeded(seed) { let a = (seed >>> 0) || 1; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function makeCar(setup, lane, name, colorIdx) {
  const spec = deriveSpec((setup && setup.kit) || setup);
  return {
    rng: seeded((setup && setup.seed) || 12345 + Math.round((lane || 0) * 7)), jitPiece: -1, jit: 1,
    name, colorIdx, lane, laneIdx0: Math.max(0, LANE_LAT.indexOf(lane)),
    spec, motor: spec.motor, tire: spec.tire, bounces: 0,
    s: 0, v: 0, y: 0, vy: 0, state: 'ground', crashT: 0, invul: 0,
    laps: 0, finished: false, finishTime: null, lapStart: 0, lapTimes: [], bestLap: null,
    crashes: 0, scrape: false, events: [],
    // crash 상태 월드 좌표
    c: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, rx: 0, rz: 0, ry: 0 },
    pieceAtCrash: 0, maxV: 0, jumpFrom: -1, ci: 0, vaultT: 0, vaultSign: 0, vaultObst: null, vaultCaught: false, caught: false,
  };
}

function startCrash(car, tr, kind, bounceV) {
  const p = sampleAt(tr, car.s);
  // 레인 오프셋 반영
  const nx = p.tz, nz = -p.tx; // 왼쪽 법선
  car.state = 'crash'; car.crashT = 0; car.crashes++;
  car.pieceAtCrash = p.piece; car.crashKind = kind;
  const c = car.c;
  const lat0 = laneLatAt(car, tr, car.s);
  c.x = p.x + nx * lat0; c.z = p.z + nz * lat0; c.y = isNaN(car.y) ? 0 : car.y;
  car.ci = findIndex(tr, ((car.s % tr.Ltot) + tr.Ltot) % tr.Ltot); car.vaultT = 0; car.vaultObst = null; car.vaultCaught = false; car.caught = false; car.launchT = 0;
  c.rx = (Math.random() - .5) * 9; c.rz = (Math.random() - .5) * 9; c.ry = (Math.random() - .5) * 6;
  if (kind === 'flyoff' || kind === 'bounce') {
    // 코스아웃: 실제 미니4WD처럼 바깥 벽을 타고 올라 트랙 밖으로 튀어 나간다.
    // 코너면 코너 바깥쪽, 착지 튕김이면 레인이 치우친 쪽(가운데 레인은 오른쪽) — 난수를 쓰지 않아 모든 접속자에서 같은 궤적.
    const out = kind === 'flyoff' && p.sign ? -p.sign : (lat0 > 0.1 ? 1 : -1);
    const dWall = ROAD_HALF + WALL.T + CAR_HW - lat0 * out;            // 바깥 벽을 완전히 넘어설 때까지의 옆 거리
    const t = Math.min(0.55, Math.max(0.3, dWall / 14)), vOut = dWall / t;
    const need = WALL.H + 1.4;                                            // 벽 꼭대기보다 넉넉히 높게 넘는다
    const vy = Math.max(kind === 'bounce' ? bounceV : 0, (need + 0.5 * G * t * t) / t);
    const fwd = car.v * (kind === 'flyoff' ? 0.62 : 0.55);
    c.vx = p.tx * fwd + nx * out * vOut; c.vz = p.tz * fwd + nz * out * vOut; c.vy = vy;
    car.launchT = 1.2;                                                      // 벽 바깥에 닿을 때까지(최대 1.2초) 칸막이·벽 충돌 없음
    c.rz = out * -(5 + Math.min(6, car.v * 0.06)); c.rx = (Math.random() - .5) * 4;     // 바깥으로 구르며 떨어진다
  } else { // 'gap' 추락
    c.vx = p.tx * car.v * 0.4; c.vz = p.tz * car.v * 0.4; c.vy = Math.min(car.vy, 0);
  }
  car.events.push({ type: kind === 'flyoff' ? 'flyoff' : kind === 'bounce' ? 'bounceout' : 'fall' });
  car.v = 0;
}

export function stepCar(car, tr, dt, raceT, laps) {
  car.events.length = 0; car.scrape = false;
  if (car.invul > 0) car.invul -= dt;

  if (car.state === 'crash') {
    car.crashT += dt * CRASH_TIME; crashStep(car, tr, dt * CRASH_TIME);
    if (car.crashT > RESPAWN_T + (car.caught ? 0.6 : 0)) {
      const base = Math.floor(car.s / tr.Ltot) * tr.Ltot;
      // 코스 아웃: 해당 코너 입구로 / 점프 추락: 착지대 쪽으로 복구(무한 실패 방지)
      car.s = base + tr.pieceStart[car.pieceAtCrash] + (car.crashKind === 'gap' ? JUMP.gapEnd + 1 : 0);
      car.v = 0; car.state = 'ground'; car.invul = 1.2;
      car.y = groundH(tr, car.s) || 0;
      car.events.push({ type: 'respawn' });
    }
    return;
  }

  if (car.state === 'air') {
    car.vy -= G * dt; car.y += car.vy * dt; car.s += car.v * dt;
    const g = groundH(tr, car.s);
    if (!isNaN(g) && car.y <= g) {
      if (car.y < g - 0.5) { startCrash(car, tr, 'gap'); return; }
      // 착지 충격 = 노면에 수직으로 부딪히는 속도. 착지대 경사 위에 내리면 부드럽고, 착지대를 넘겨 평지에 떨어지면 세다.
      // 반발(rest)만큼 다시 튀어 오르고, 너무 높이 튀면 벽을 넘어 코스아웃. 매스댐퍼가 반발을 줄인다.
      const gs = sampleAt(tr, car.s).slope, imp = Math.max(0, car.v * gs - car.vy), b = imp * car.spec.rest;
      car.y = g; car.v *= 0.93;
      if (car.invul <= 0 && b > car.spec.bounceOut) { car.bounces++; startCrash(car, tr, 'bounce', b); return; }
      if (b > BOUNCE_HOP) { car.vy = b + car.v * gs; car.y = g + 0.01; car.events.push({ type: 'hop', speed: b }); return; }      // 통통 튀고 다시 착지
      car.state = 'ground'; car.events.push({ type: 'land', speed: car.v });
    } else if (car.y < -8) startCrash(car, tr, 'gap');
    return;
  }

  // ---- ground
  const info = sampleAt(tr, car.s), sp = car.spec, vmaxE = sp.vmax * (car.speedMul || 1);
  let ds = 1;                                   // 레인에 따른 중심선 진행 비율
  let acc;
  if (car.v < vmaxE) acc = sp.acc * (1 - car.v / vmaxE); else acc = -(car.v - vmaxE) * 1.5;
  acc -= 25 * (info.slope + laneLiftAt(car, tr, car.s).slope);     // 고가 구간의 오르내림도 속도에 영향
  if (tr.seq[info.piece] === 'lane') acc -= 4;       // 레인체인지 구간에서는 옆으로 옮겨 가느라 조금 느려진다
  if (tr.seq[info.piece] === 'wave') acc -= car.v * WAVE_LOSS * (sp.rest / REST_BASE);
  if (info.brake && car.v > 14) acc -= car.v * 1.1;
  // 브레이크 스펀지: 내리막과 점프대(차가 앞으로 기울거나 들리는 곳)에서 노면에 끌려 속도를 줄인다
  car.braking = sp.brakeK > 0 && (info.slope < -BRAKE_SLOPE || (info.slope > BRAKE_SLOPE && tr.seq[info.piece] === 'jump'));
  if (car.braking) acc -= sp.brakeK * car.v;
  if (info.R > 0) {
    // 내 레인의 실제 반경: 안쪽 레인은 짧지만 한계속도가 낮고, 바깥 레인은 멀리 돌지만 더 빨리 돌 수 있다
    const Rc = Math.max(8, info.R - info.sign * laneLatAt(car, tr, car.s)), vc = vcrit(car.tire, Rc);
    ds = info.R / Rc;
    // 타이어 한계(vc)를 넘으면 롤러가 바깥 벽을 타고 돈다: 롤러 마찰만큼 감속, 롤러 세팅이 버틸 수 있는 한계(hold)를 넘으면 코스아웃
    if (info.piece !== car.jitPiece) { car.jitPiece = info.piece; car.jit = 1 - sp.wobble * car.rng(); }     // 코너 부품마다 한 번: 이번 코너에서 롤러가 버티는 정도
    if (car.invul <= 0 && car.v > Math.sqrt(WALL_G * Rc) * sp.hold * car.jit) { startCrash(car, tr, 'flyoff'); return; }
    if (car.v > vc) { acc -= (car.v - vc) * sp.fric; car.scrape = true; car.scrapeSide = -info.sign; ds = info.R / Math.max(8, Rc - sp.wideIn); }
  }
  car.v = Math.max(0, car.v + acc * dt);
  if (car.v > car.maxV) car.maxV = car.v;
  const sNext = car.s + car.v * dt * ds, gNext = groundH(tr, sNext);
  if (isNaN(gNext) && !isNaN(info.h)) {           // 도약
    car.state = 'air'; car.vy = car.v * info.slope; car.y = info.h; car.s = sNext;
    // 점프대 킥: 느린 차(노멀 모터 등)도 갭을 넘도록 점프대가 위로 더 튕겨 준다. 너무 느리면(상한 초과) 그대로 갭에 떨어진다
    if (tr.seq[info.piece] === 'jump' && car.v > 0) car.vy = Math.max(car.vy, Math.min(JUMP_KICK_MAX, G * (JUMP.gapEnd - JUMP.rampEnd + 1) / (2 * car.v)));
    car.events.push({ type: 'jump', speed: car.v });
    return;
  }
  car.s = sNext; car.y = isNaN(gNext) ? car.y : gNext + laneLiftAt(car, tr, sNext).lift;

  // 랩/골인
  const lapNow = Math.floor(car.s / tr.Ltot);
  if (lapNow > car.laps) {
    car.laps = lapNow;
    if (lapNow >= 1) {
      const lt = raceT - car.lapStart; car.lapTimes.push(lt);
      if (car.bestLap == null || lt < car.bestLap) car.bestLap = lt;
      car.events.push({ type: 'lap', n: lapNow, time: lt });
      if (lapNow >= laps && !car.finished) { car.finished = true; car.finishTime = raceT; car.events.push({ type: 'finish' }); }
    }
    car.lapStart = raceT;
  }
}
