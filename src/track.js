// 트랙 기하 (three.js 의존 없음).
// 좌표: x 오른쪽, z 아래(화면 기준). 진행 각도 a: (cos a, sin a). a 가 증가하면 우회전(시계방향).
export const ROAD_HALF = 7.5;
export const CELL = 20;
const STEP = 2;
export const K = Math.PI / 4;

// sign: +1 = 좌코너, -1 = 우코너
export const PIECES = {
  straight: { label: '직선',        len: 20 },
  half:     { label: '반 직선',     len: 10 },
  c45R:     { label: '45° 우코너',  R: 20, ang: K,         sign: -1 },
  c45L:     { label: '45° 좌코너',  R: 20, ang: K,         sign: 1 },
  c90R:     { label: '90° 우코너',  R: 20, ang: 2 * K,     sign: -1 },
  c90L:     { label: '90° 좌코너',  R: 20, ang: 2 * K,     sign: 1 },
  b90R:     { label: '큰 90° 우코너', R: 40, ang: 2 * K,   sign: -1 },
  b90L:     { label: '큰 90° 좌코너', R: 40, ang: 2 * K,   sign: 1 },
  up:       { label: '오르막',      len: 20, dh: 5 },
  down:     { label: '내리막',      len: 20, dh: -5 },
  jump:     { label: '점프',        len: 60 },
  brake:    { label: '브레이크',    len: 20 },
  lane:     { label: '레인체인지',  len: 40 },     // 지나면 한 칸 옆 레인으로 이동 (1→2→3→1)
  wave:     { label: '웨이브',      len: 20 },     // 노면이 물결처럼 오르내린다: 차가 흔들려 감속 (매스댐퍼가 줄여 줌)
};
// 부품을 반대 방향으로 지날 때의 형태 (jump 는 방향성이 있어 null)
export const REVERSE = { straight: 'straight', half: 'half', c45R: 'c45L', c45L: 'c45R', c90R: 'c90L', c90L: 'c90R', b90R: 'b90L', b90L: 'b90R', up: 'down', down: 'up', brake: 'brake', lane: 'lane', wave: 'wave', jump: null };
export const FLIP = { c45R: 'c45L', c45L: 'c45R', c90R: 'c90L', c90L: 'c90R', b90R: 'b90L', b90L: 'b90R' };

export const JUMP = { rampEnd: 20, gapEnd: 34, height: 3, len: 60 };
export const WAVE = { amp: 0.7, humps: 2 };

function heightAt(type, u, len, h0) {
  const def = PIECES[type];
  if (def.dh) return h0 + def.dh * (0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, u / len)));
  if (type === 'jump') {
    if (u <= JUMP.rampEnd + 1e-6) return h0 + JUMP.height * (u / JUMP.rampEnd);
    if (u < JUMP.gapEnd - 1e-6) return NaN;
    return h0 + JUMP.height * (1 - (u - JUMP.gapEnd) / (JUMP.len - JUMP.gapEnd));
  }
  if (type === 'wave') return h0 + WAVE.amp * 0.5 * (1 - Math.cos(2 * Math.PI * WAVE.humps * Math.min(1, u / len)));
  return h0;
}

// 한 부품을 (x,z,a,h) 에서 출발해 걸어간다.
export function stepPiece(type, x, z, a, h) {
  const def = PIECES[type], curve = !!def.R;
  const len = curve ? def.R * def.ang : def.len;
  const n = Math.max(1, Math.round(len / STEP));
  const dx = Math.cos(a), dz = Math.sin(a);
  const nrm = def.sign > 0 ? [Math.sin(a), -Math.cos(a)] : [-Math.sin(a), Math.cos(a)];
  const samples = [];
  for (let k = 0; k < n; k++) {
    const u = len * k / n;
    let px, pz, tx, tz;
    if (curve) {
      const phi = u / def.R, sn = Math.sin(phi), cs = Math.cos(phi);
      px = x + def.R * (sn * dx + (1 - cs) * nrm[0]); pz = z + def.R * (sn * dz + (1 - cs) * nrm[1]);
      tx = cs * dx + sn * nrm[0]; tz = cs * dz + sn * nrm[1];
    } else { px = x + dx * u; pz = z + dz * u; tx = dx; tz = dz; }
    samples.push({ x: px, z: pz, h: heightAt(type, u, len, h), tx, tz, R: curve ? def.R : 0, sign: curve ? def.sign : 0, br: type === 'brake' ? 1 : 0, u });
  }
  let ex, ez, ea;
  if (curve) {
    const sn = Math.sin(def.ang), cs = Math.cos(def.ang);
    ex = x + def.R * (sn * dx + (1 - cs) * nrm[0]); ez = z + def.R * (sn * dz + (1 - cs) * nrm[1]);
    ea = a - def.sign * def.ang;
  } else { ex = x + dx * len; ez = z + dz * len; ea = a; }
  return { samples, len, end: { x: ex, z: ez, a: ea, h: h + (def.dh || 0) } };
}

export function buildTrack(seq) {
  const X = [], Z = [], H = [], DX = [], DZ = [], RAD = [], SG = [], BR = [], PI = [], S = [], pieceStart = [], lc = [];
  let x = 0, z = 0, a = 0, h = 0, s = 0;
  seq.forEach((type, pi) => {
    pieceStart.push(s);
    const r = stepPiece(type, x, z, a, h);
    for (const p of r.samples) {
      X.push(p.x); Z.push(p.z); H.push(p.h); DX.push(p.tx); DZ.push(p.tz); RAD.push(p.R); SG.push(p.sign); BR.push(p.br); PI.push(pi); S.push(s + p.u);
    }
    if (type === 'lane') lc.push({ s0: s, s1: s + r.len });          // 레인체인지 구간 (진행 거리)
    x = r.end.x; z = r.end.z; a = r.end.a; h = r.end.h; s += r.len;
  });
  const n = X.length;
  const da = Math.abs(Math.atan2(Math.sin(a), Math.cos(a)));
  const closed = seq.length >= 4 && Math.hypot(x, z) < 0.05 && da < 1e-4 && Math.abs(h) < 1e-6;
  return { seq: seq.slice(), n, X, Z, H, DX, DZ, RAD, SG, BR, PI, S, Ltot: s, pieceStart, lc, closed, overlap: false, end: { x, z, a, h } };
}

export function findIndex(tr, s) {
  let lo = 0, hi = tr.n - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (tr.S[mid] <= s) lo = mid; else hi = mid - 1; }
  return lo;
}

export function sampleAt(tr, sTot) {
  const L = tr.Ltot, s = ((sTot % L) + L) % L;
  const i = findIndex(tr, s), j = (i + 1) % tr.n;
  const s0 = tr.S[i], s1 = i + 1 < tr.n ? tr.S[i + 1] : L, t = (s - s0) / Math.max(1e-9, s1 - s0);
  const x = tr.X[i] + (tr.X[j] - tr.X[i]) * t, z = tr.Z[i] + (tr.Z[j] - tr.Z[i]) * t;
  let tx = tr.DX[i] + (tr.DX[j] - tr.DX[i]) * t, tz = tr.DZ[i] + (tr.DZ[j] - tr.DZ[i]) * t;
  const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
  const hi = tr.H[i], hj = tr.H[j];
  const h = (isNaN(hi) || isNaN(hj)) ? NaN : hi + (hj - hi) * t;
  const slope = (isNaN(hi) || isNaN(hj)) ? 0 : (hj - hi) / Math.max(1e-9, s1 - s0);
  return { i, x, z, tx, tz, h, slope, R: tr.RAD[i], sign: tr.SG[i], brake: tr.BR[i], piece: tr.PI[i], s };
}
export const groundH = (tr, s) => sampleAt(tr, s).h;

// 추천 코스 (닫힌 루프): 쉬운 순서. 팔레트 부품(직선·45°코너·오르막·내리막·점프·레인체인지)만으로 만들 수 있고, 모두 레인체인지가 1개 들어 있다.
// 각 코스는 "반쪽(H)"을 두 번 이은 형태(180° 회전 대칭)라 항상 닫힌다. 레인체인지는 직선 2개(길이 40)와 같은 길이라서 두 번째 반쪽에서는 직선 2개로 바꿔 한 바퀴에 1번만 지나게 한다
// → 레인이 한 바퀴마다 한 칸씩 옮겨 가서, 3랩이면 3개 레인을 정확히 한 번씩 돈다.
const S = 'straight', L = 'c45L', R = 'c45R', U = 'up', D = 'down', J = 'jump', LC = 'lane', W = 'wave', HF = 'half';
const twice = h => [...h, ...h.flatMap(x => (x === LC ? [S, S] : [x]))];
export const PRESETS = {
  '입문 오벌':     twice([S, S, S, LC, S, S, L, L, L, L]),
  '점프 서킷':     twice([S, L, L, U, S, S, LC, S, D, J, L, L]),
  '슬로프 챌린지': twice([S, L, L, L, U, U, S, LC, S, D, L, D]),
  '지그재그':      twice([S, S, LC, S, R, L, L, L, S, L, S, L]),
  '헤어핀':        twice([S, S, LC, S, S, L, R, S, S, L, L, L, L, S, R, L]),
  '챔피언 서킷':   twice([S, S, LC, S, U, L, L, L, J, R, D, S, L, R, L, L]),
  /* 2026년 윈터컵: Pimentoso 트랙 에디터 코스(BFFEML)를 부품 연결점으로 순서를 복원해 옮긴 것.
   * 8자 코스 — 오르막 2개로 올라간 고가 구간이 아래 코스를 넘어간다. 레인체인저(162cm)=레인체인지+직선, 뱅크 연결부(28cm)=반 직선, 웨이브 5개 */
  '2026년 윈터컵 코스': [S, R, R, R, R, LC, S, S, W, HF, R, R, R, R, HF, L, L, L, L, R, R, U, S, S, S, R, R, U, D, D, S, S, W, R, R, R, R, LC, S, S, L, L, W, L, L, U, S, S, S, W, L, L, L, L, U, D, S, S, L, L, S, D, S, L, L, S],
};
// 난이도(★ 개수): 시뮬레이션에서 모터·타이어 12조합이 낸 평균 코스아웃 수를 기준으로 정함
export const PRESET_LEVEL = { '입문 오벌': 1, '점프 서킷': 2, '슬로프 챌린지': 2, '지그재그': 3, '헤어핀': 4, '챔피언 서킷': 5, '2026년 윈터컵 코스': 5 };
