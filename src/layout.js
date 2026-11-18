// 자유 배치 레이아웃: 커넥터 스냅, 겹침 검사, 루프 순회. (three.js 의존 없음)
import { PIECES, REVERSE, K, stepPiece, buildTrack } from './track.js';

export const mod8 = n => ((n % 8) + 8) % 8;
const info = {};
export function pinfo(type) {
  if (!info[type]) {
    const r = stepPiece(type, 0, 0, 0, 0);
    const pts = r.samples.map(s => ({ x: s.x, z: s.z })); pts.push({ x: r.end.x, z: r.end.z });
    const us = r.samples.map(s => s.u); us.push(r.len);
    info[type] = { endX: r.end.x, endZ: r.end.z, endK: Math.round(r.end.a / K), pts, us, len: r.len };
  }
  return info[type];
}
export function rot(k, x, z) { const a = k * K, c = Math.cos(a), s = Math.sin(a); return [x * c - z * s, x * s + z * c]; }
export function endPos(p) { const i = pinfo(p.type), [rx, rz] = rot(p.k, i.endX, i.endZ); return { x: p.x + rx, z: p.z + rz }; }
export function conns(p) {
  const e = endPos(p), i = pinfo(p.type);
  return [{ pid: p.id, w: 'S', x: p.x, z: p.z, d: mod8(p.k + 4) }, { pid: p.id, w: 'E', x: e.x, z: e.z, d: mod8(p.k + i.endK) }];
}
export function worldPts(p) { return pinfo(p.type).pts.map(q => { const [rx, rz] = rot(p.k, q.x, q.z); return { x: p.x + rx, z: p.z + rz }; }); }
export const match = (a, b) => a.pid !== b.pid && Math.hypot(a.x - b.x, a.z - b.z) < 0.6 && b.d === mod8(a.d + 4);

const TH = 16.6, NEAR_ARC = 45;
// cand 의 각 끝(S/E) 에서 다른 부품 q 의 끝(S/E)까지, 사이 부품 길이의 합 (최대 3개 경유)
function chainLinks(cand, nbrs, byId, maxMid = 3) {
  const out = new Map();
  for (const e of ['S', 'E']) {
    const walk = (pid, exitW, acc, depth, visited) => {
      for (const m of nbrs.get(pid + exitW) || []) {
        const X = byId.get(m.pid); if (!X || visited.has(X.id)) continue;
        let rec = out.get(X.id); if (!rec) { rec = new Map(); out.set(X.id, rec); }
        const key = e + '|' + m.w; if (!rec.has(key) || rec.get(key) > acc) rec.set(key, acc);
        if (depth < maxMid) { const v2 = new Set(visited); v2.add(X.id); walk(X.id, m.w === 'S' ? 'E' : 'S', acc + pinfo(X.type).len, depth + 1, v2); }
      }
    };
    walk(cand.id, e, 0, 0, new Set([cand.id]));
  }
  return out;
}

export function collides(cand, pieces, ignoreId = null, extraIgnore = []) {
  const others = pieces.filter(q => q.id !== ignoreId && q.id !== cand.id && !extraIgnore.includes(q.id));
  const byId = new Map(others.map(q => [q.id, q])); byId.set(cand.id, cand);
  const all = [...others, cand].flatMap(conns), nbrs = new Map();
  for (const c of all) nbrs.set(c.pid + c.w, all.filter(o => match(c, o)));
  const links = chainLinks(cand, nbrs, byId);
  const ci = pinfo(cand.type), cp = worldPts(cand);
  let mnx = 1e9, mxx = -1e9, mnz = 1e9, mxz = -1e9;
  for (const p of cp) { mnx = Math.min(mnx, p.x); mxx = Math.max(mxx, p.x); mnz = Math.min(mnz, p.z); mxz = Math.max(mxz, p.z); }
  for (const q of others) {
    const qp = worldPts(q), qi = pinfo(q.type);
    let qn = 1e9, qx = -1e9, zn = 1e9, zx = -1e9;
    for (const p of qp) { qn = Math.min(qn, p.x); qx = Math.max(qx, p.x); zn = Math.min(zn, p.z); zx = Math.max(zx, p.z); }
    if (qx < mnx - TH || qn > mxx + TH || zx < mnz - TH || zn > mxz + TH) continue;
    const rec = links.get(q.id);
    for (let i = 0; i < cp.length; i++) for (let j = 0; j < qp.length; j++) {
      if (Math.hypot(cp[i].x - qp[j].x, cp[i].z - qp[j].z) >= TH) continue;
      if (rec) {
        let near = false;
        for (const [key, L] of rec) {
          const [e, f] = key.split('|');
          const da = e === 'S' ? ci.us[i] : ci.len - ci.us[i], db = f === 'S' ? qi.us[j] : qi.len - qi.us[j];
          if (da + L + db < NEAR_ARC) { near = true; break; }
        }
        if (near) continue;
      }
      return true;
    }
  }
  return false;
}

// p 와 끝점이 이어진 이웃 부품 id 들
export function neighborsOf(p, pieces) {
  const mine = conns(p), out = [];
  for (const q of pieces) if (q.id !== p.id && conns(q).some(c => mine.some(m => match(m, c)))) out.push(q.id);
  return out;
}

export function allConns(pieces) { return pieces.flatMap(conns); }
export function openConns(pieces, ignoreId = null) {
  const all = allConns(pieces);
  return all.filter(c => c.pid !== ignoreId && !all.some(o => o.pid !== ignoreId && match(c, o)));
}

// 커넥터 c 에 부품 type 의 한쪽 끝을 붙이는 포즈
export function poseForAttach(type, c, useEnd) {
  const i = pinfo(type);
  if (!useEnd) return { type, x: c.x, z: c.z, k: c.d };
  const k = mod8(c.d + 4 - i.endK), [rx, rz] = rot(k, i.endX, i.endZ);
  return { type, x: c.x - rx, z: c.z - rz, k };
}

// 루프 순회: 모든 부품이 하나의 닫힌 고리인지, 진행 순서/방향/시작 포즈를 구한다.
export function traverse(pieces) {
  const n = pieces.length;
  if (n < 4) return { valid: false, reason: n === 0 ? 'empty' : 'few' };
  const all = allConns(pieces), byId = new Map(pieces.map(p => [p.id, p]));
  const adj = new Map(); let open = 0;
  for (const c of all) {
    const m = all.filter(o => match(c, o));
    adj.set(c.pid + c.w, m);
    if (m.length === 0) open++;
    if (m.length > 1) return { valid: false, reason: 'ambiguous', open };
  }
  if (open > 0) return { valid: false, reason: 'open', open };

  const walk = (enterW) => {
    const start = pieces[0], seq = [], order = [], seen = new Set();
    let cur = start, w = enterW;
    for (;;) {
      if (seen.has(cur.id)) break;
      seen.add(cur.id);
      const fwd = w === 'S'; order.push({ id: cur.id, fwd });
      seq.push(fwd ? cur.type : REVERSE[cur.type]);
      const nx = adj.get(cur.id + (fwd ? 'E' : 'S'))[0];
      cur = byId.get(nx.pid); w = nx.w;
      if (cur === start) break;
    }
    return { seq, order, ok: seen.size === n && cur === start && w === enterW };
  };
  let res = walk('S'), rev = false;
  if (!res.ok) return { valid: false, reason: 'branch', open: 0 };
  if (res.seq.some(t => t == null)) { res = walk('E'); rev = true; if (res.seq.some(t => t == null)) return { valid: false, reason: 'jumpdir', open: 0 }; }
  const p0 = pieces[0], i0 = pinfo(p0.type), e0 = endPos(p0);
  const startPose = rev ? { x: e0.x, z: e0.z, k: mod8(p0.k + i0.endK + 4) } : { x: p0.x, z: p0.z, k: p0.k };
  const track = buildTrack(res.seq);
  if (!track.closed) return { valid: false, reason: 'height', open: 0, track };
  return { valid: true, reason: 'ok', open: 0, seq: res.seq, order: res.order, startPose, track };
}

let _id = 1;
export const newId = () => _id++;
export function setIdBase(v) { _id = Math.max(_id, v); }

export function layoutFromSeq(seq) {
  const pieces = []; let x = 0, z = 0, k = 0;
  for (const type of seq) {
    const p = { id: newId(), type, x, z, k }; pieces.push(p);
    const e = endPos(p); x = e.x; z = e.z; k = mod8(k + pinfo(type).endK);
  }
  return pieces;
}
export const labelOf = t => PIECES[t].label;
