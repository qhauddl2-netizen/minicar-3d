import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { PIECES, PRESETS, PRESET_LEVEL, ROAD_HALF, K, FLIP, buildTrack, sampleAt, waveSlope } from './track.js';
import { mod8, rot, pinfo, endPos, worldPts, collides, neighborsOf, openConns, allConns, match, poseForAttach, traverse, newId, setIdBase, layoutFromSeq } from './layout.js';
import { TIME_SCALE, CRASH_TIME, MOTORS, TIRES, makeCar, stepCar, vcrit, launchSpeed, laneLatAt, laneLiftAt, laneGroundE, laneBridgeE, laneBridgeLift, LANE_LAT, BRIDGE_H } from './sim.js';
import { backend, courseKey, rng, setSeedCourses, FIXED_ROOM } from './backend.js';
import { KIT_PRESETS, DEFAULT_KIT, partOf, normalizeKit, encodeKit, deriveSpec, lockKit, unlocksAt, nextUnlock, GARAGE_UNLOCK } from './parts.js';
import { createGarage } from './garage.js';

const WALL_H = 1.6;
const KMH = 0.5;
const STYLES = [
  { name: '블루', main: 0x1e6bff, accent: 0x22d3c5 },
  { name: '레드', main: 0xe5252a, accent: 0xffb020 },
  { name: '그린', main: 0x22c55e, accent: 0xd8ff3a },
];
const LAPS_FIXED = 3;                // 레이스는 항상 3바퀴 (랩 수 선택 없음)
const LANES = LANE_LAT;              // 3레인 (왼쪽 → 오른쪽), 차선 폭 5
const DIV_LAT = 2.5;                 // 레인 칸막이 위치
const GRID = 5, SNAP_R = 38;
const $ = id => document.getElementById(id);
const wrapAngle = a => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };
const fmtS = t => fmt(t == null ? t : t / TIME_SCALE);      // 시뮬레이션 시간 → 화면에 보이는 실제 시간
const fmt = t => { if (t == null || !isFinite(t)) return '--'; const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s.toFixed(2).padStart(5, '0')}`; };
const store = { get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } } };
const hexs = n => '#' + n.toString(16).padStart(6, '0');

/* ====================================================================
 *  렌더러 / 씬
 * ==================================================================== */
const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xcfe6ff, 260, 1000);
/** 세로 그라데이션 하늘 (위 → 지평선) */
function skyTex(stops) {
  const c = document.createElement('canvas'); c.width = 4; c.height = 256;
  const g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 0, 256);
  stops.forEach(([o, col]) => gr.addColorStop(o, col));
  g.fillStyle = gr; g.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const SKY_DAY = skyTex([[0, '#3f86e8'], [0.6, '#9cc9f5'], [1, '#dcecff']]);
const SKY_NIGHT = skyTex([[0, '#01030b'], [0.45, '#071030'], [0.8, '#13224d'], [1, '#22346a']]);
scene.background = SKY_DAY;
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;
const camera = new THREE.PerspectiveCamera(55, 1, 0.5, 2500);
camera.position.set(80, 140, 120);
const hemi = new THREE.HemisphereLight(0xdff0ff, 0x4a7a3a, 0.7); scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2dd, 2.4);
sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
const SH = 70; Object.assign(sun.shadow.camera, { left: -SH, right: SH, top: SH, bottom: -SH, near: 1, far: 300 });
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.05;
scene.add(sun, sun.target);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.maxPolarAngle = Math.PI / 2.05; controls.minDistance = 15; controls.maxDistance = 900;
controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };

function resize() {
  renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  const k = camera.aspect < 1 ? Math.min(2, 1 + (1 - camera.aspect) * 0.95) : 1;      // 세로 화면은 카메라가 멀어지므로 안개 거리도 같이 늘린다
  scene.fog.near = 260 * k; scene.fog.far = 1000 * k;
}
addEventListener('resize', () => { resize(); syncView(); }); resize();
/** 모바일 편집: 하단 편집 바가 가린 만큼 화면 중심을 위로 옮겨, 트랙이 보이는 영역의 한가운데에 오게 한다 */
function syncView() {
  const w = innerWidth, h = innerHeight;
  let occ = 0;
  const ed = document.getElementById('editor');
  if (mode === 'build' && V.screen === 'room' && ed && !ed.classList.contains('hide') && matchMedia('(max-width:820px), (max-height:560px)').matches) {
    let top = h;
    for (const id of ['mobBottom', 'left', 'right']) { const el = document.getElementById(id); if (el && getComputedStyle(el).display !== 'none') top = Math.min(top, el.getBoundingClientRect().top); }
    occ = Math.max(0, Math.min(h - top, h * 0.6));
  }
  if (occ > 0) camera.setViewOffset(w, h, 0, Math.round(occ / 2), w, h); else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}

/* ====================================================================
 *  텍스처 / 재질
 * ==================================================================== */
const maxAniso = renderer.capabilities.getMaxAnisotropy();
function canvasTex(w, h, draw, repeat = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = maxAniso;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
}
const roadTex = canvasTex(256, 256, (g, w, h) => {      // 타미야 코스: 무광 흰색 플라스틱 (색은 부품별 vertexColor 로 입힘)
  g.fillStyle = '#f4f6fa'; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 3500; i++) { g.fillStyle = `rgba(${Math.random() < .5 ? '0,0,0' : '255,255,255'},${Math.random() * .05})`; g.fillRect(Math.random() * w, Math.random() * h, 2, 2); }
  g.fillStyle = 'rgba(0,0,0,.07)'; g.fillRect(0, 0, 6, h); g.fillRect(w - 6, 0, 6, h);                 // 바깥 벽 아래 그림자 느낌
  for (const f of [1 / 3, 2 / 3]) { g.fillStyle = 'rgba(0,0,0,.05)'; g.fillRect(w * f - 5, 0, 10, h); }   // 레인 칸막이 아래
});
const grassTex = canvasTex(256, 256, (g, w, h) => {
  g.fillStyle = '#4f8f3c'; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 6000; i++) { const v = 60 + Math.random() * 60; g.fillStyle = `rgba(${v * .6},${v * 1.6},${v * .5},.25)`; g.fillRect(Math.random() * w, Math.random() * h, 2, 3); }
});
grassTex.repeat.set(200, 200);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshStandardMaterial({ map: grassTex, roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.position.y = -0.02; ground.receiveShadow = true; scene.add(ground);

/* ---- 낮 / 밤 (방을 만들 때 방장이 고른다) ----
 * 밤: 남색 하늘 + 반짝이는 별 + 달, 해 대신 푸른 달빛, 미니카는 헤드라이트를 켠다. */
let night = false;
const stars = (() => {
  const N = 1600, pos = new Float32Array(N * 3), ph = new Float32Array(N), sz = new Float32Array(N), tint = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const y = 0.03 + Math.pow(Math.random(), 0.8) * 0.97, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - y * y);   // 지평선 위 반구
    pos.set([Math.cos(a) * r, y, Math.sin(a) * r], i * 3);
    ph[i] = Math.random() * 100; sz[i] = 1.3 + Math.pow(Math.random(), 4) * 3.4; tint[i] = Math.random();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('aPh', new THREE.BufferAttribute(ph, 1));
  geo.setAttribute('aSz', new THREE.BufferAttribute(sz, 1)); geo.setAttribute('aTint', new THREE.BufferAttribute(tint, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uT: { value: 0 }, uPx: { value: renderer.getPixelRatio() } },
    vertexShader: `attribute float aPh; attribute float aSz; attribute float aTint; uniform float uT; uniform float uPx;
      varying float vA; varying vec3 vC;
      void main() {
        vec4 p = modelViewMatrix * vec4(position * 1500.0, 1.0); gl_Position = projectionMatrix * p;
        float tw = 0.5 + 0.5 * sin(uT * (1.3 + fract(aPh * 0.37) * 3.2) + aPh);      // 별마다 다른 속도로 반짝
        tw = mix(tw, tw * tw * tw, step(0.82, fract(aPh * 0.73)));                  // 일부는 크게 깜빡
        vA = (0.35 + 0.65 * tw) * smoothstep(0.02, 0.18, position.y);               // 지평선 근처는 흐리게
        vC = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.93, 0.78), aTint);
        gl_PointSize = aSz * uPx * (0.8 + 0.35 * tw);
      }`,
    fragmentShader: `varying float vA; varying vec3 vC;
      void main() { vec2 d = gl_PointCoord - 0.5; float r = length(d); float a = smoothstep(0.5, 0.0, r); a *= a; gl_FragColor = vec4(vC, a * vA); }`,
    transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, fog: false,
  });
  const pts = new THREE.Points(geo, mat); pts.frustumCulled = false; pts.renderOrder = -10; pts.visible = false; scene.add(pts);
  return pts;
})();
const MOON_DIR = new THREE.Vector3(-0.55, 0.42, -0.72).normalize();
const moon = new THREE.Sprite(new THREE.SpriteMaterial({
  map: canvasTex(256, 256, (g, w, h) => {
    const gl = g.createRadialGradient(w / 2, h / 2, 20, w / 2, h / 2, w / 2);
    gl.addColorStop(0, 'rgba(210,225,255,.55)'); gl.addColorStop(0.35, 'rgba(150,175,235,.18)'); gl.addColorStop(1, 'rgba(120,150,220,0)');
    g.fillStyle = gl; g.fillRect(0, 0, w, h);
    const d = g.createRadialGradient(w / 2 - 8, h / 2 - 8, 4, w / 2, h / 2, 34);
    d.addColorStop(0, '#fffdf2'); d.addColorStop(1, '#e6e9f2'); g.fillStyle = d;
    g.beginPath(); g.arc(w / 2, h / 2, 34, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(160,170,195,.35)';                                    // 크레이터
    for (const [x, y, r] of [[-10, -6, 7], [9, 8, 5], [12, -12, 4], [-4, 14, 4]]) { g.beginPath(); g.arc(w / 2 + x, h / 2 + y, r, 0, Math.PI * 2); g.fill(); }
  }, false), transparent: true, depthWrite: false, depthTest: false, fog: false,
}));
moon.scale.set(260, 260, 1); moon.renderOrder = -9; moon.visible = false; scene.add(moon);
/** 별·달은 카메라를 따라다녀서 무한히 먼 하늘처럼 보인다 */
function skyTick(dt) {
  if (!night) return;
  stars.position.copy(camera.position); stars.material.uniforms.uT.value += dt;
  moon.position.copy(camera.position).addScaledVector(MOON_DIR, 1400);
}
function setNight(on) {
  on = !!on; if (night === on) return; night = on;
  scene.background = on ? SKY_NIGHT : SKY_DAY;
  scene.fog.color.setHex(on ? 0x101d42 : 0xcfe6ff);
  hemi.color.setHex(on ? 0x5b70b8 : 0xdff0ff); hemi.groundColor.setHex(on ? 0x0b1020 : 0x4a7a3a); hemi.intensity = on ? 0.42 : 0.7;
  sun.color.setHex(on ? 0x8aa4ff : 0xfff2dd); sun.intensity = on ? 0.5 : 2.4;          // 밤에는 해 대신 달빛
  scene.environmentIntensity = on ? 0.12 : 0.55; renderer.toneMappingExposure = on ? 0.6 : 1;
  stars.visible = moon.visible = on;
  document.body.classList.toggle('night', on);
  vis.forEach(v => v.setLights(on));
}

const roadMat = new THREE.MeshStandardMaterial({ map: roadTex, vertexColors: true, roughness: 0.55, side: THREE.DoubleSide });
const plasticMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, side: THREE.DoubleSide });     // 벽 · 칸막이 · 옆면
const ghostRoadMat = new THREE.MeshStandardMaterial({ map: roadTex, vertexColors: true, roughness: 0.55, side: THREE.DoubleSide, transparent: true, opacity: 0.72 });
const ghostWallMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, side: THREE.DoubleSide, transparent: true, opacity: 0.72 });
const seamMat = new THREE.MeshStandardMaterial({ color: 0x8e98ac, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, side: THREE.DoubleSide });

/* ====================================================================
 *  스트립 지오메트리
 * ==================================================================== */
const C = hex => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };      // sRGB → 선형
const COL = {
  white: [C(0xeef1f6), C(0xdfe4ec)], red: C(0xd8232a), blue: C(0x1c5fc9),
  up: C(0xd3f0de), down: C(0xf6e3c6), jump: C(0xffe9a0), brake: C(0x464a58), lane: C(0x7d8aa6),
};
const isCurve = type => /^(c45|c90|b90)/.test(type);
/** 연속된 코너 묶음마다 번호를 매긴다 (직선 사이의 코너 = 한 묶음). 짝수=빨강, 홀수=파랑 */
function curveClusters(seq) {
  const n = seq.length, cl = new Array(n).fill(-1); let c = -1, prev = false;
  seq.forEach((tp, i) => { const cv = isCurve(tp); if (cv && !prev) c++; prev = cv; if (cv) cl[i] = c; });
  if (n > 1 && cl[0] >= 0 && cl[n - 1] >= 0 && cl[n - 1] !== cl[0]) { const last = cl[n - 1]; for (let i = 0; i < n; i++) if (cl[i] === last) cl[i] = cl[0]; }
  return cl;
}
function pieceColor(tr, pi) {
  const type = tr.seq[pi];
  if (isCurve(type)) {
    if (tr.seq.length === 1) return /R$/.test(type) ? COL.blue : COL.red;      // 편집 중 단일 부품: 우코너=파랑, 좌코너=빨강
    const cl = (tr.cluster || (tr.cluster = curveClusters(tr.seq)))[pi];
    return cl % 2 === 0 ? COL.red : COL.blue;
  }
  if (COL[type]) return COL[type];
  return COL.white[pi % 2];
}
const tintFor = (tr, idx) => pieceColor(tr, tr.PI[idx]);

/** 단면(section)을 트랙 따라 쭉 뽑은 지오메트리.
 *  - 단면이 3점 이상이면 변마다 정점을 따로 둬서 모서리가 각지게(법선 분리) 보이고,
 *  - useTint 면 부품이 바뀌는 지점에서 색이 번지지 않고 칼같이 바뀌도록 행을 한 줄 복제한다. */
function buildStrip(tr, section, swapUV, uvScaleV, useTint, mask) {
  const n = tr.n, crisp = section.length > 2;
  const cols = []; if (crisp) { for (let k = 0; k < section.length - 1; k++) cols.push(section[k], section[k + 1]); } else cols.push(...section);
  const K2 = cols.length, segs = crisp ? section.length - 1 : 1;
  const info = []; let prevIdx = -1;
  for (let i = 0; i <= n; i++) {
    const ci = i < n ? i : n - 1;
    if (useTint && prevIdx >= 0 && i < n && tr.PI[ci] !== tr.PI[prevIdx]) info.push({ i, ci: prevIdx, dup: true });
    info.push({ i, ci, dup: false }); prevIdx = ci;
  }
  const rows = info.length;
  const pos = new Float32Array(rows * K2 * 3), uv = new Float32Array(rows * K2 * 2), col = new Float32Array(rows * K2 * 3);
  const valid = [], skip = [];
  for (let r = 0; r < rows; r++) {
    const i = info[r].i, idx = i % n, last = i === n;
    const h = last ? tr.end.h : tr.H[idx], ok = !isNaN(h); valid.push(ok); skip.push(!!mask && !mask(info[r].ci));
    const dist = last ? tr.Ltot : tr.S[i];
    const tx = last ? Math.cos(tr.end.a) : tr.DX[idx], tz = last ? Math.sin(tr.end.a) : tr.DZ[idx], nx = tz, nz = -tx;
    const bx = last ? tr.end.x : tr.X[idx], bz = last ? tr.end.z : tr.Z[idx];
    const tt = useTint ? tintFor(tr, info[r].ci) : [1, 1, 1];
    for (let k = 0; k < K2; k++) {
      const s = cols[k], o = (r * K2 + k) * 3, q = (r * K2 + k) * 2;
      pos[o] = bx + nx * s.lat; pos[o + 1] = (ok ? h : 0) + s.y; pos[o + 2] = bz + nz * s.lat;
      const v = dist / uvScaleV;
      if (swapUV) { uv[q] = v; uv[q + 1] = s.u; } else { uv[q] = s.u; uv[q + 1] = v; }
      col[o] = tt[0]; col[o + 1] = tt[1]; col[o + 2] = tt[2];
    }
  }
  const index = [];
  for (let r = 0; r < rows - 1; r++) {
    if (info[r].dup || skip[r] || !valid[r] || !valid[r + 1]) continue;      // 복제 행 → 실제 행 사이는 넓이 0 이라 건너뜀 / skip: 마스크 구간 안에서 시작하는 사각형
    for (let sg = 0; sg < segs; sg++) { const a = r * K2 + sg * 2, b = a + 1, c = (r + 1) * K2 + sg * 2, d = c + 1; index.push(a, c, b, b, c, d); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(index); g.computeVertexNormals(); return g;
}
const DIV_H = 1.5;       // 레인 칸막이 높이 (타미야처럼 솟은 벽)
const DIV_SEC = lat => [{ lat: lat - 0.22, y: 0, u: 0 }, { lat: lat - 0.22, y: DIV_H, u: 1 }, { lat: lat + 0.22, y: DIV_H, u: 2 }, { lat: lat + 0.22, y: 0, u: 3 }];
const WALL_SEC = sg => [{ lat: sg * ROAD_HALF, y: 0, u: 0 }, { lat: sg * ROAD_HALF, y: WALL_H, u: 1 }, { lat: sg * (ROAD_HALF + 0.7), y: WALL_H, u: 2 }, { lat: sg * (ROAD_HALF + 0.7), y: -1.3, u: 3 }];

/* ====================================================================
 *  완성된 3D 트랙(루프 완성 시) + 소품 : root 그룹
 * ==================================================================== */
const root = new THREE.Group(); scene.add(root);
const trackGroup = new THREE.Group(); root.add(trackGroup);
const pillars = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.9, 1.1, 1, 10), new THREE.MeshStandardMaterial({ color: 0x8c98b8, roughness: .7 }), 700);
pillars.castShadow = true; pillars.count = 0; root.add(pillars);
const gate = new THREE.Group(); root.add(gate); gate.visible = false;

/* ---- 트랙 옆 입간판: "글로벌 유리 동탄점" ---- */
const SIGN_TEXT = '글로벌 유리 동탄점', SIGN = { W: 32, H: 10, POST_H: 13, CY: 12 };
const signCanvas = document.createElement('canvas'); signCanvas.width = 1024; signCanvas.height = 320;
const signTex = new THREE.CanvasTexture(signCanvas); signTex.colorSpace = THREE.SRGBColorSpace; signTex.anisotropy = maxAniso;
function drawSign() {
  const g = signCanvas.getContext('2d'), w = signCanvas.width, h = signCanvas.height, r = 36;
  g.clearRect(0, 0, w, h);
  const rr = (x, y, ww, hh, rad) => { g.beginPath(); g.moveTo(x + rad, y); g.arcTo(x + ww, y, x + ww, y + hh, rad); g.arcTo(x + ww, y + hh, x, y + hh, rad); g.arcTo(x, y + hh, x, y, rad); g.arcTo(x, y, x + ww, y, rad); g.closePath(); };
  rr(0, 0, w, h, r); g.fillStyle = '#ffffff'; g.fill();                                           // 흰 테두리
  rr(14, 14, w - 28, h - 28, r - 10); const bg = g.createLinearGradient(0, 0, w, h); bg.addColorStop(0, '#0a2a78'); bg.addColorStop(1, '#1e6bff'); g.fillStyle = bg; g.fill();
  g.save(); rr(14, 14, w - 28, h - 28, r - 10); g.clip();                                         // 유리 느낌의 비스듬한 빛 줄무늬
  g.fillStyle = 'rgba(255,255,255,.13)'; g.beginPath(); g.moveTo(150, 0); g.lineTo(330, 0); g.lineTo(150, h); g.lineTo(-30, h); g.fill();
  g.fillStyle = 'rgba(255,255,255,.08)'; g.beginPath(); g.moveTo(380, 0); g.lineTo(430, 0); g.lineTo(250, h); g.lineTo(200, h); g.fill(); g.restore();
  const face = '"Noto Sans KR","Malgun Gothic","Apple SD Gothic Neo",sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `800 100px ${face}`; const fit = Math.min(1, 840 / g.measureText(SIGN_TEXT).width);       // 글자 폭이 판을 넘지 않게
  g.font = `800 ${Math.round(110 * fit)}px ${face}`;
  g.lineJoin = 'round'; g.lineWidth = 14; g.strokeStyle = '#06164a'; g.strokeText(SIGN_TEXT, w / 2, h / 2 + 6);
  g.fillStyle = '#ffffff'; g.fillText(SIGN_TEXT, w / 2, h / 2 + 6);
  signTex.needsUpdate = true;
}
drawSign();
if (document.fonts && document.fonts.load) document.fonts.load('800 100px "Noto Sans KR"', SIGN_TEXT).then(drawSign).catch(() => { });       // 글꼴이 로드되면 다시 그린다
const sign = new THREE.Group(); root.add(sign); sign.visible = false;
{
  const face = new THREE.MeshBasicMaterial({ map: signTex, transparent: true, alphaTest: 0.05 }), steel = new THREE.MeshStandardMaterial({ color: 0x3a4766, roughness: 0.5, metalness: 0.4 });
  const board = new THREE.Mesh(new THREE.BoxGeometry(SIGN.W, SIGN.H, 0.9), [steel, steel, steel, steel, face, face]);       // 앞뒤(±z) 양면에서 읽힌다
  board.position.y = SIGN.CY; board.castShadow = true; sign.add(board);
  for (const sx of [-1, 1]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.9, SIGN.CY + 1, 10), steel); post.position.set(sx * (SIGN.W / 2 - 3), (SIGN.CY + 1) / 2 - 1, 0); post.castShadow = true; sign.add(post); }
}
let signSpot = null;       // 트랙 좌표계에서 간판 자리 {x, z, yaw}. 나무는 이 주변에 심지 않는다
/** 출발선 근처부터 트랙을 따라가며, 트랙 바깥쪽으로 띄운 자리 중 다른 구간과 겹치지 않는 곳을 고른다 */
function placeSign(tr) {
  let cx = 0, cz = 0; for (let i = 0; i < tr.n; i++) { cx += tr.X[i]; cz += tr.Z[i]; } cx /= tr.n; cz /= tr.n;
  const HALF = SIGN.W / 2 + 2, OFF = ROAD_HALF + 0.7 + 24;
  const clear = (x, z) => { let mn = 1e9; for (let i = 0; i < tr.n; i += 2) mn = Math.min(mn, Math.hypot(tr.X[i] - x, tr.Z[i] - z)); return mn; };
  for (let s = 6; s < tr.Ltot; s += 10) {
    const p = sampleAt(tr, s); if (isNaN(p.h)) continue;
    const nx = p.tz, nz = -p.tx, out = Math.sign((p.x - cx) * nx + (p.z - cz) * nz) || 1;
    for (const sg of [out, -out]) {
      const x = p.x + nx * sg * OFF, z = p.z + nz * sg * OFF;
      if (Math.min(clear(x, z), clear(x + p.tx * HALF, z + p.tz * HALF), clear(x - p.tx * HALF, z - p.tz * HALF)) >= 18) return { x, z, yaw: Math.atan2(-p.tz, p.tx), y: 0 };
    }
  }
  return null;
}
{
  const pm = new THREE.MeshStandardMaterial({ color: 0x1e6bff, roughness: .4, metalness: .3 });
  for (const sx of [-1, 1]) { const p = new THREE.Mesh(new THREE.BoxGeometry(1.2, 11, 1.2), pm); p.position.set(sx * (ROAD_HALF + 1.6), 5.5, 0); p.castShadow = true; gate.add(p); }
  const banner = canvasTex(512, 96, (g, w, h) => {
    g.fillStyle = '#0b1a44'; g.fillRect(0, 0, w, h); g.fillStyle = '#22d3c5'; g.fillRect(0, 0, w, 8); g.fillRect(0, h - 8, w, 8);
    g.fillStyle = '#fff'; g.font = 'italic 800 60px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('START / GOAL', w / 2, h / 2 + 2);
  }, false);
  const bm = new THREE.MeshStandardMaterial({ map: banner });
  const bar = new THREE.Mesh(new THREE.BoxGeometry(ROAD_HALF * 2 + 4, 3.2, 1), [pm, pm, pm, pm, bm, bm]);
  bar.position.set(0, 11, 0); bar.castShadow = true; gate.add(bar);
  const checker = canvasTex(128, 32, (g, w, h) => { for (let x = 0; x < 16; x++) for (let y = 0; y < 4; y++) { g.fillStyle = (x + y) % 2 ? '#111' : '#fff'; g.fillRect(x * w / 16, y * h / 4, w / 16, h / 4); } }, false);
  const line = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_HALF * 2, 3), new THREE.MeshBasicMaterial({ map: checker }));
  line.rotation.x = -Math.PI / 2; line.position.y = 0.08; gate.add(line);
}
const TREES = 320;
const trunkMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.5, 0.7, 4, 6), new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 1 }), TREES);
const leafMesh = new THREE.InstancedMesh(new THREE.ConeGeometry(3.2, 9, 8), new THREE.MeshStandardMaterial({ color: 0x2f8f46, roughness: .9 }), TREES);
trunkMesh.castShadow = leafMesh.castShadow = true; root.add(trunkMesh, leafMesh);
function scatterTrees(points) {
  const pts = points.filter((_, i) => i % 3 === 0);
  let cx = 0, cz = 0; pts.forEach(p => { cx += p[0]; cz += p[1]; }); cx /= pts.length || 1; cz /= pts.length || 1;
  const ext = Math.max(60, ...pts.map(p => Math.hypot(p[0] - cx, p[1] - cz))) + 180;
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), ps = new THREE.Vector3();
  let n = 0, tries = 0;
  while (n < TREES && tries++ < 8000) {
    const x = cx + (rnd() * 2 - 1) * ext, z = cz + (rnd() * 2 - 1) * ext;
    let md = 1e9; for (const p of pts) { const d = (p[0] - x) ** 2 + (p[1] - z) ** 2; if (d < md) md = d; }
    if (md < 30 * 30) continue;
    if (signSpot && (x - signSpot.x) ** 2 + (z - signSpot.z) ** 2 < 26 * 26) continue;          // 간판 주변은 나무 없이 비워 둔다
    const s = 0.8 + rnd() * 1.1;
    ps.set(x, 2 * s, z); sc.set(s, s, s); m4.compose(ps, q, sc); trunkMesh.setMatrixAt(n, m4);
    ps.set(x, 8.2 * s, z); m4.compose(ps, q, sc); leafMesh.setMatrixAt(n, m4); n++;
  }
  trunkMesh.count = leafMesh.count = n; trunkMesh.instanceMatrix.needsUpdate = leafMesh.instanceMatrix.needsUpdate = true;
}
function clearGroup(g) { while (g.children.length) { const c = g.children.pop(); c.geometry && c.geometry.dispose(); } }

let track = null;     // 완성된 트랙 데이터 (loop.track)
/** 레인체인지 채널: 바닥 + 양쪽 벽(난간)이 경로를 따라 휘는 레일 하나. 높이(lift)가 있으면 고가 도로가 된다.
 *  latOf(t): 구간 진행률 t 에서의 좌우 위치, liftOf(t): 지면 위 높이 */
const LC_HW = 2.5, LC_TK = 0.7, LC_RAIL = 1.5;
/** sampleAt 은 마지막 샘플과 첫 샘플 사이를 보간해서(루프 가정) 마지막 샘플 이후 구간이 시작점 쪽으로 되감긴다.
 *  마지막 샘플을 넘어가면 접선 방향으로 연장해서 부품 끝(s1)까지 정확히 가도록 한다. */
function samplePt(tr, s) {
  const sLast = tr.S[tr.n - 1];
  if (s <= sLast) return sampleAt(tr, s);
  const p = sampleAt(tr, sLast), d = s - sLast;
  return { ...p, x: p.x + p.tx * d, z: p.z + p.tz * d };
}
function laneChannelGeo(tr, s0, s1, latOf, liftOf, floorK, wallSkip) {
  const HW = LC_HW, TK = LC_TK, RAIL = LC_RAIL, WT = 0.22, m = 36, pos = [], col = [];
  const quad = (a, b, c, d, k) => { for (const q of [a, b, c, a, c, d]) { pos.push(q[0], q[1], q[2]); col.push(k, k, k); } };
  const rows = [];
  for (let j = 0; j <= m; j++) {
    const tt = j / m, p = samplePt(tr, s0 + (s1 - s0) * tt);
    const lat = latOf(tt), y = (isNaN(p.h) ? 0 : p.h) + liftOf(tt) + 0.06, nx = p.tz, nz = -p.tx;
    rows.push({ P: (d, yy) => [p.x + nx * (lat + d), yy, p.z + nz * (lat + d)], y });
  }
  for (let j = 0; j < m; j++) {
    const A = rows[j], B = rows[j + 1], I = HW - WT;
    quad(A.P(-I, A.y), A.P(I, A.y), B.P(I, B.y), B.P(-I, B.y), floorK);                                    // 바닥(상판)
    quad(A.P(-HW, A.y - TK), A.P(HW, A.y - TK), B.P(HW, B.y - TK), B.P(-HW, B.y - TK), 0.7);                // 밑면
    for (const sg of [-1, 1]) {
      if (wallSkip && wallSkip((j + 0.5) / m, latOf((j + 0.5) / m) + sg * HW)) continue;       // 고가 경사로와 겹치는 구간의 벽은 뺀다
      quad(A.P(sg * HW, A.y - TK), A.P(sg * HW, A.y + RAIL), B.P(sg * HW, B.y + RAIL), B.P(sg * HW, B.y - TK), 0.42);   // 벽 바깥면 (회색: 위에서 봐도 휘는 레일이 보이게)
      quad(A.P(sg * I, A.y), A.P(sg * I, A.y + RAIL), B.P(sg * I, B.y + RAIL), B.P(sg * I, B.y), 0.5);        // 벽 안쪽면
      quad(A.P(sg * I, A.y + RAIL), A.P(sg * HW, A.y + RAIL), B.P(sg * HW, B.y + RAIL), B.P(sg * I, B.y + RAIL), 0.36);   // 벽 윗면
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.computeVertexNormals(); return g;
}
/** 고가 도로 재질: 따라가는 차가 고가 아래 지상 레인을 지날 때만 반투명 (차가 가려지지 않게) */
const bridgeMat = plasticMat.clone(); bridgeMat.transparent = true;
/** 레인체인지 한 구간의 채널 3개: 지상 1→2, 2→3 (오른쪽으로 휘며 이동) + 고가 3→1 (올라갔다 내려오며 왼쪽으로) */
function laneChannels(tr, s0, s1) {
  // 고가가 아직 낮아서(벽 높이+밑면 두께+여유보다 낮음) 폭 안에 걸치는 지상 벽은 고가 경사로를 뚫고 서 있게 되므로 그 구간에서는 뺀다.
  // 그 자리는 고가 자신의 난간이 같은 위치에서 칸막이 역할을 이어받는다.
  const bLat = t => LANES[2] + (LANES[0] - LANES[2]) * laneBridgeE(t);
  const cut = (t, wLat) => Math.abs(wLat - bLat(t)) < LC_HW + 0.4 && laneBridgeLift(t) < LC_RAIL + LC_TK + 0.4;
  const ground = i => laneChannelGeo(tr, s0, s1, t => LANES[i] + (LANES[i + 1] - LANES[i]) * laneGroundE(t), () => 0, 0.95, cut);
  return [ground(0), ground(1), laneChannelGeo(tr, s0, s1, t => LANES[2] + (LANES[0] - LANES[2]) * laneBridgeE(t), laneBridgeLift, 0.98)];
}

/** 트랙을 따라가는 띠 모양 장식(이음새·스티커). bands: [[s0,s1],…] */
function bandsGeo(tr, bands, lat0, lat1, y, vScale) {
  const pos = [], uv = [], idx = [];
  for (const [s0, s1] of bands) {
    const m = Math.max(1, Math.ceil((s1 - s0) / 3)), base = pos.length / 3; let ok = true;
    for (let j = 0; j <= m; j++) {
      const p = sampleAt(tr, s0 + (s1 - s0) * j / m); if (isNaN(p.h)) { ok = false; break; }
      const nx = p.tz, nz = -p.tx, v = (s1 - s0) * j / m / vScale;
      pos.push(p.x + nx * lat0, p.h + y, p.z + nz * lat0, p.x + nx * lat1, p.h + y, p.z + nz * lat1); uv.push(0, v, 4, v);
    }
    if (!ok) { pos.length = base * 3; uv.length = base * 2; continue; }
    for (let j = 0; j < m; j++) { const a = base + j * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals(); return g;
}
function buildBuiltMesh(tr) {
  clearGroup(trackGroup);
  const THK = 1.3, W = ROAD_HALF, OW = 0.7;     // THK: 플라스틱 본체 두께, OW: 바깥 벽 두께
  const road = new THREE.Mesh(buildStrip(tr, [{ lat: ROAD_HALF, y: 0.03, u: 0 }, { lat: -ROAD_HALF, y: 0.03, u: 1 }], false, 16, true), roadMat);
  road.receiveShadow = true; trackGroup.add(road);
  for (const sg of [1, -1]) {
    const wall = new THREE.Mesh(buildStrip(tr, [{ lat: sg * W, y: 0, u: 0 }, { lat: sg * W, y: WALL_H, u: 1 }, { lat: sg * (W + OW), y: WALL_H, u: 2 }, { lat: sg * (W + OW), y: -THK, u: 3 }], true, 8, true), plasticMat);
    wall.castShadow = wall.receiveShadow = true; trackGroup.add(wall);
  }
  const notLane = i => tr.seq[tr.PI[i]] !== 'lane';             // 레인체인지 구간에는 칸막이가 없다 (차가 옆 레인으로 넘어감)
  for (const lat of [DIV_LAT, -DIV_LAT]) { const dv = new THREE.Mesh(buildStrip(tr, DIV_SEC(lat), true, 8, true, notLane), plasticMat); dv.castShadow = dv.receiveShadow = true; trackGroup.add(dv); }
  trackGroup.add(new THREE.Mesh(buildStrip(tr, [{ lat: W + OW, y: -THK, u: 0 }, { lat: -(W + OW), y: -THK, u: 1 }], false, 16, true), plasticMat));
  for (const seg of tr.lc || []) {
    laneChannels(tr, seg.s0, seg.s1).forEach((geo, i) => { const ch = new THREE.Mesh(geo, i === 2 ? bridgeMat : plasticMat); ch.castShadow = ch.receiveShadow = true; trackGroup.add(ch); });     // i=2: 고가
  }
  // 부품 이음새
  const seams = tr.pieceStart.map(s => [s - 0.18, s + 0.18]);
  trackGroup.add(new THREE.Mesh(bandsGeo(tr, seams, W, -W, 0.07, 1), seamMat));
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), ps = new THREE.Vector3();
  let pc = 0;
  // 고가가 아래 코스를 넘어가는 곳(8자 코스)에서는 아래 도로 위에 기둥을 세우지 않는다
  const onLowerRoad = (x, z, h) => { for (let j = 0; j < tr.n; j++) { const hj = tr.H[j]; if (!isNaN(hj) && hj < h - 2 && Math.hypot(tr.X[j] - x, tr.Z[j] - z) < ROAD_HALF + 2) return true; } return false; };
  for (let i = 0; i < tr.n && pc < 690; i += 4) {
    const h = tr.H[i]; if (isNaN(h) || h < 1.2) continue;
    for (const sg of [-1, 1]) {
      const x = tr.X[i] + tr.DZ[i] * sg * 4.5, z = tr.Z[i] - tr.DX[i] * sg * 4.5;
      if (onLowerRoad(x, z, h)) continue;
      sc.set(1, h - 0.9, 1); ps.set(x, (h - 0.9) / 2, z); m4.compose(ps, q, sc); pillars.setMatrixAt(pc++, m4);
    }
  }
  pillars.count = pc; pillars.instanceMatrix.needsUpdate = true;
  gate.visible = true; gate.position.set(tr.X[0], 0, tr.Z[0]); gate.rotation.y = Math.atan2(tr.DX[0], tr.DZ[0]);
}

/* ====================================================================
 *  편집용 평면 부품 (조립 중 표시)
 * ==================================================================== */
const flatCache = {};
function flatGeo(type) {
  if (flatCache[type]) return flatCache[type];
  const tr = buildTrack([type]);
  if (!(type === 'up' || type === 'down' || type === 'jump')) { tr.H = tr.H.map(h => (isNaN(h) ? NaN : 0)); tr.end = { ...tr.end, h: 0 }; }     // 경사 부품만 편집 중에도 경사로 그린다 (기준 높이는 그룹 위치로)
  return (flatCache[type] = {
    samp: { n: tr.n, X: tr.X, Z: tr.Z, DX: tr.DX, DZ: tr.DZ, H: tr.H.slice() },
    road: buildStrip(tr, [{ lat: ROAD_HALF, y: 0.03, u: 0 }, { lat: -ROAD_HALF, y: 0.03, u: 1 }], false, 16, true),
    walls: [buildStrip(tr, WALL_SEC(1), true, 8, true), buildStrip(tr, WALL_SEC(-1), true, 8, true)],
    divs: type === 'lane' ? [] : [buildStrip(tr, DIV_SEC(DIV_LAT), true, 8, true), buildStrip(tr, DIV_SEC(-DIV_LAT), true, 8, true)],
    chans: type === 'lane' ? laneChannels(tr, 0, tr.Ltot) : [],
    hi: buildStrip(tr, [{ lat: ROAD_HALF + 0.9, y: 0.4, u: 0 }, { lat: -(ROAD_HALF + 0.9), y: 0.4, u: 1 }], false, 16, false),
  });
}
const pierGeo = new THREE.CylinderGeometry(0.9, 1.1, 1, 10), pierMat = new THREE.MeshStandardMaterial({ color: 0x8c98b8, roughness: .7 });
function makePieceGroup(type, ghost = false) {
  const g = flatGeo(type), grp = new THREE.Group();
  const road = new THREE.Mesh(g.road, ghost ? ghostRoadMat : roadMat); road.receiveShadow = !ghost; grp.add(road);
  for (const w of g.walls) { const m = new THREE.Mesh(w, ghost ? ghostWallMat : plasticMat); m.castShadow = !ghost; grp.add(m); }
  for (const d of g.divs) grp.add(new THREE.Mesh(d, ghost ? ghostWallMat : plasticMat));
  for (const geo of g.chans) { const ch = new THREE.Mesh(geo, ghost ? ghostWallMat : plasticMat); ch.castShadow = !ghost; grp.add(ch); }
  return grp;
}
function poseGroup(grp, p, y = 0) { grp.position.set(p.x, y, p.z); grp.rotation.y = -p.k * K; }

/* ---- 편집 중 높이: 이어진 조각끼리 끝점 높이가 연속되도록 기준 높이를 전파한다 (덩어리마다 가장 낮은 곳이 0) ---- */
const pieceY = new Map();                                       // id -> 조각 시작점 높이
const DH = type => (type === 'up' ? PIECES.up.dh : type === 'down' ? PIECES.down.dh : 0);
function computePieceHeights() {
  pieceY.clear();
  const byId = new Map(pieces.map(p => [p.id, p])), all = allConns(pieces), by = new Map();
  all.forEach(c => { if (!by.has(c.pid)) by.set(c.pid, []); by.get(c.pid).push(c); });
  for (const root of pieces) {
    if (pieceY.has(root.id)) continue;
    const comp = [root]; pieceY.set(root.id, 0);
    for (let i = 0; i < comp.length; i++) {
      const p = comp[i], y0 = pieceY.get(p.id);
      for (const c of by.get(p.id) || []) {
        const nb = all.find(o => match(c, o)); if (!nb || pieceY.has(nb.pid)) continue;
        const q = byId.get(nb.pid), H = c.w === 'S' ? y0 : y0 + DH(p.type);
        pieceY.set(q.id, nb.w === 'S' ? H : H - DH(q.type)); comp.push(q);
      }
    }
    let mn = Infinity; comp.forEach(p => { const y = pieceY.get(p.id); mn = Math.min(mn, y, y + DH(p.type)); });
    comp.forEach(p => pieceY.set(p.id, pieceY.get(p.id) - mn));
  }
}
const connHeight = c => { const p = pieces.find(q => q.id === c.pid); return (pieceY.get(c.pid) || 0) + (c.w === 'E' && p ? DH(p.type) : 0); };
function updatePiers(o, p) {                                    // 높은 구간 아래 받침 기둥
  for (let i = o.grp.children.length - 1; i >= 0; i--) if (o.grp.children[i].userData.pier) o.grp.remove(o.grp.children[i]);
  const y0 = pieceY.get(p.id) || 0, g = flatGeo(p.type).samp;
  for (const f of [0.1, 0.9]) {
    const i = Math.round(f * (g.n - 1)), h = g.H[i]; if (isNaN(h)) continue;
    const top = y0 + h; if (top < 1.2) continue;
    const nx = g.DZ[i], nz = -g.DX[i];
    for (const s of [-4.5, 4.5]) {
      const [wx, wz] = rot(p.k, g.X[i] + nx * s, g.Z[i] + nz * s);           // 고가 교차: 아래 지나는 다른 부품 위에는 기둥을 세우지 않는다
      if (pieces.some(q => q.id !== p.id && (pieceY.get(q.id) || 0) + Math.max(0, DH(q.type)) < top - 2 && worldPts(q).some(w => Math.hypot(w.x - p.x - wx, w.z - p.z - wz) < ROAD_HALF + 2))) continue;
      const mesh = new THREE.Mesh(pierGeo, pierMat); mesh.userData.pier = true; mesh.scale.set(1, top - 0.9, 1);
      mesh.position.set(g.X[i] + nx * s, (top - 0.9) / 2 - y0, g.Z[i] + nz * s); mesh.castShadow = true; o.grp.add(mesh);
    }
  }
}

const layoutGroup = new THREE.Group(); scene.add(layoutGroup);
const pieceGroups = new Map();          // id -> {grp,type}
const markerGroup = new THREE.Group(); scene.add(markerGroup);
const hiMat = new THREE.MeshBasicMaterial({ color: 0x22d3c5, transparent: true, opacity: 0.5, depthTest: false, side: THREE.DoubleSide });
const selMesh = new THREE.Mesh(new THREE.BufferGeometry(), hiMat); selMesh.renderOrder = 10; selMesh.visible = false; scene.add(selMesh);
const ghostHiMat = new THREE.MeshBasicMaterial({ color: 0x35d07f, transparent: true, opacity: 0.45, depthTest: false, side: THREE.DoubleSide });
const ghostRoot = new THREE.Group(); scene.add(ghostRoot);
const ghostHi = new THREE.Mesh(new THREE.BufferGeometry(), ghostHiMat); ghostHi.renderOrder = 11; scene.add(ghostHi);
ghostRoot.visible = ghostHi.visible = false;
let ghostType = null;

const arrowMat = new THREE.MeshStandardMaterial({ color: 0xff8a1a, emissive: 0xff8a1a, emissiveIntensity: .6 });
const arrowGeo = { shaft: new THREE.BoxGeometry(2, 1, 7), head: new THREE.ConeGeometry(3.2, 5, 4) };
function arrowMesh() {
  const g = new THREE.Group();
  const shaft = new THREE.Mesh(arrowGeo.shaft, arrowMat); shaft.position.z = -1;
  const head = new THREE.Mesh(arrowGeo.head, arrowMat); head.rotation.x = Math.PI / 2; head.position.z = 4.5;
  g.add(shaft, head); return g;
}

/* ====================================================================
 *  편집 상태
 * ==================================================================== */
let pieces = [];
let loop = { valid: false, reason: 'empty' };
const E = { tool: 'select', armed: null, rot: 0, flipAttach: false, ghost: null, selId: null, drag: null, mouse: null, anchor: null, anchorMode: false, anchorPx: null, lastPx: null, hist: [], hi: -1 };
let mode = 'build';
/** 화면 상태: home(방 목록) | room(방). role: host(트랙 커스텀 가능) | guest(보기 전용) */
const V = { screen: 'home', role: null, code: null, spin: false };
const isFixedRoom = () => V.screen === 'room' && V.code === FIXED_ROOM.code;        // 고정 방: 코스(윈터컵) 편집 불가
const canEdit = () => mode === 'build' && V.screen === 'room' && V.role === 'host' && !isFixedRoom();
const cloneP = p => ({ id: p.id, type: p.type, x: p.x, z: p.z, k: p.k });

function loadInitial() {
  const saved = store.get('mini4wd.layout2', null);
  if (Array.isArray(saved) && saved.length && saved.every(p => PIECES[p.type] && Number.isFinite(p.x))) { setIdBase(Math.max(...saved.map(p => p.id)) + 1); return saved.map(p => (p.type === 'brake' ? { ...p, type: 'straight' } : p)); }     // 브레이크는 없앴으므로 예전 저장 코스의 브레이크는 같은 길이의 직선으로
  return layoutFromSeq(PRESETS['점프 서킷']);
}
let toastT = 0;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.remove('hide'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hide'), 1800); }

function pushHist() { E.hist = E.hist.slice(0, E.hi + 1); E.hist.push(JSON.stringify(pieces)); if (E.hist.length > 80) E.hist.shift(); E.hi = E.hist.length - 1; }
function undo(d) { const n = E.hi + d; if (n < 0 || n >= E.hist.length) return; E.hi = n; pieces = JSON.parse(E.hist[n]); E.selId = null; E.anchorMode = false; recompute(); }

const selected = () => pieces.find(p => p.id === E.selId) || null;

function syncPieceGroups() {
  computePieceHeights();
  const ids = new Set(pieces.map(p => p.id));
  for (const [id, o] of pieceGroups) if (!ids.has(id)) { layoutGroup.remove(o.grp); pieceGroups.delete(id); }
  for (const p of pieces) {
    let o = pieceGroups.get(p.id);
    if (!o || o.type !== p.type) { if (o) layoutGroup.remove(o.grp); o = { grp: makePieceGroup(p.type), type: p.type }; pieceGroups.set(p.id, o); layoutGroup.add(o.grp); }
    poseGroup(o.grp, p, pieceY.get(p.id) || 0); updatePiers(o, p);
  }
}

function updateMarkers() {
  while (markerGroup.children.length) markerGroup.remove(markerGroup.children[0]);
  if (!canEdit()) return;
  for (const c of openConns(pieces, E.drag && E.drag.moved ? E.drag.id : null)) {
    const a = arrowMesh(); a.scale.setScalar(0.7);
    a.position.set(c.x, connHeight(c) + 1.2, c.z); a.rotation.y = Math.atan2(Math.cos(c.d * K), Math.sin(c.d * K)); markerGroup.add(a);
  }
}

function updateSelection() {
  const p = selected();
  if (!p || !canEdit()) { selMesh.visible = false; return; }
  selMesh.geometry = flatGeo(p.type).hi; poseGroup(selMesh, p, pieceY.get(p.id) || 0); selMesh.visible = true;
}

function applyBuilt() {
  const showBuilt = loop.valid && !(E.drag && E.drag.moved);
  layoutGroup.visible = !showBuilt && mode === 'build';
  if (showBuilt) {
    track = loop.track; buildBuiltMesh(track);
    root.position.set(loop.startPose.x, 0, loop.startPose.z); root.rotation.y = -loop.startPose.k * K;
    signSpot = placeSign(track);
    if (signSpot) { sign.position.set(signSpot.x, signSpot.y, signSpot.z); sign.rotation.y = signSpot.yaw; } sign.visible = !!signSpot;
    scatterTrees(track.X.map((x, i) => [x, track.Z[i]]));
  } else {
    clearGroup(trackGroup); pillars.count = 0; gate.visible = false; sign.visible = false; signSpot = null;
    root.position.set(0, 0, 0); root.rotation.y = 0;
    scatterTrees(pieces.flatMap(p => worldPts(p).map(q => [q.x, q.z])));
    track = null;
  }
}

const REASONS = {
  empty: '부품을 골라 코스를 만들어 보세요.', few: '부품이 4개 이상 필요해요.',
  ambiguous: '한 지점에 부품 끝이 3개 이상 만나요.', branch: '코스가 하나의 고리로 이어지지 않아요.',
  jumpdir: '점프 방향이 통일되지 않아요. 점프를 회전(Z/X)시켜 같은 방향으로 맞춰 주세요.',
};
let statusKey = null, popTimer = 0;
/** 화면 가운데 레이어 팝업: 코스 상태 문구 등. 클릭을 가리지 않고 잠시 뒤 사라진다. */
function showCenterPop(ok, title, sub) {
  const el = $('statusPop');
  el.className = 'show ' + (ok ? 'ok' : 'bad');
  el.innerHTML = `<div class="pt">${ok ? '✔' : '✖'} ${title}</div>${sub ? `<div class="ps">${sub}</div>` : ''}`;
  clearTimeout(popTimer); popTimer = setTimeout(() => { el.className = 'hide'; }, 2600);
}
function hideCenterPop() { clearTimeout(popTimer); $('statusPop').className = 'hide'; }
function updateStatus() {
  let ok = false, title = '', sub = '', key = '';
  const ups = pieces.filter(p => p.type === 'up').length, downs = pieces.filter(p => p.type === 'down').length;
  if (loop.valid) { ok = true; key = 'ok'; title = '코스 완성!'; sub = `${pieces.length}개 · ${loop.track.Ltot.toFixed(0)}m — 레이스를 시작할 수 있어요.`; }
  else if (loop.reason === 'open') { key = 'open'; title = `열린 끝이 ${loop.open}개 있어요`; sub = '주황 화살표 위치에 부품을 이어 붙여 닫아 주세요.'; }
  else if (loop.reason === 'height') { key = 'height'; title = `오르막/내리막 개수가 달라요 (${ups}/${downs})`; sub = '오르막과 내리막의 수를 같게 맞춰 주세요.'; }
  else { key = loop.reason || 'none'; title = REASONS[loop.reason] || ''; }
  $('startBtn').disabled = !ok; $('mtRight').classList.toggle('ready', ok && V.role === 'host');       // 코스가 완성되면 '방 정보' 탭에 초록 점
  // 상태가 바뀔 때만 한 번 띄운다 (부품을 놓을 때마다 뜨지 않게). 방장이 편집 중일 때만.
  if (!(V.screen === 'room' && V.role === 'host')) { statusKey = null; hideCenterPop(); return; }
  if (statusKey !== null && key !== statusKey && title) showCenterPop(ok, title, sub);
  statusKey = key;
}
function updateToolUI() {
  $('tSelect').classList.toggle('on', E.tool === 'select' && !E.armed); $('tDelete').classList.toggle('on', E.tool === 'delete');
  [...$('pal').children].forEach(b => b.classList.toggle('on', b.dataset.type === palType(E.armed)));
  const sel = selected();
  const mob = matchMedia('(max-width:820px), (max-height:560px)').matches;
  $('modeInfo').textContent = mob
    ? (E.armed ? `배치 중: ${PIECES[E.armed].label} — 놓을 곳을 탭 · 회전/반전 버튼`
      : E.tool === 'delete' ? '지울 부품을 탭하세요'
      : sel ? `선택됨: ${PIECES[sel.type].label} — 드래그로 이동 · 아래 버튼으로 회전/반전/삭제` : '')
    : E.armed ? `배치 중: ${PIECES[E.armed].label} — 클릭으로 놓기 · Z/X 회전 · F 반전 · Esc 취소`
    : E.tool === 'delete' ? '삭제 도구: 지울 부품을 클릭하세요'
    : sel ? `선택됨: ${PIECES[sel.type].label} — 드래그 이동 · Z/X 회전 · F 반전 · Del 삭제` : '';
  canvas.style.cursor = E.armed ? 'crosshair' : E.tool === 'delete' ? 'not-allowed' : 'default';
}

function recompute(save = true) {
  loop = traverse(pieces);
  syncPieceGroups(); applyBuilt(); updateMarkers(); updateStatus(); updateSelection(); updateToolUI(); updateGhost();
  if (save) store.set('mini4wd.layout2', pieces);
  onLoopChanged();
}
function commit() { pushHist(); recompute(); }

/* ---------------------------------------------------------------- 고스트 / 스냅 */
const snapG = v => Math.round(v / GRID) * GRID;
const candidate = (type, pose) => ({ id: -1, type, x: pose.x, z: pose.z, k: pose.k });
function attachCandidates(type, c) {
  const opts = [{ o: poseForAttach(type, c, false), useEnd: false }, { o: poseForAttach(type, c, true), useEnd: true }];
  if (E.flipAttach) opts.reverse();
  for (const x of opts) if (!collides(candidate(type, x.o), pieces)) return { pose: x.o, valid: true, useEnd: x.useEnd, conn: c };
  return { pose: opts[0].o, valid: false, useEnd: opts[0].useEnd, conn: c };
}
function nearestOpen(m, R) {
  let best = null, bd = R;
  for (const c of openConns(pieces)) { const d = Math.hypot(c.x - m.x, c.z - m.z); if (d < bd) { bd = d; best = c; } }
  return best;
}
function computeGhost() {
  const type = E.armed; if (!type) return null;
  let r = null, snapped = false;
  if (E.anchorMode && E.anchor) { r = attachCandidates(type, E.anchor); snapped = true; }
  else if (E.mouse) {
    const near = pieces.length ? nearestOpen(E.mouse, SNAP_R) : null;
    if (near) { r = attachCandidates(type, near); snapped = true; }
    else { const pose = { x: snapG(E.mouse.x), z: snapG(E.mouse.z), k: mod8(E.rot) }; r = { pose, valid: !collides(candidate(type, pose), pieces) }; }
  }
  return r ? { ...r, snapped, type } : null;
}
function updateGhost() {
  if (!canEdit() || !E.armed) { ghostRoot.visible = ghostHi.visible = false; E.ghost = null; return; }
  const g = computeGhost(); E.ghost = g;
  if (!g) { ghostRoot.visible = ghostHi.visible = false; return; }
  if (ghostType !== g.type) { while (ghostRoot.children.length) ghostRoot.remove(ghostRoot.children[0]); ghostRoot.add(makePieceGroup(g.type, true)); ghostType = g.type; ghostHi.geometry = flatGeo(g.type).hi; }
  let gy = 0; if (g.snapped && g.conn) { const H = connHeight(g.conn); gy = g.useEnd ? H - DH(g.type) : H; }     // 붙는 끝점의 높이에 맞춤
  poseGroup(ghostRoot, g.pose, gy); poseGroup(ghostHi, g.pose, gy);
  ghostHiMat.color.setHex(g.valid ? 0x35d07f : 0xff4d4d);
  ghostRoot.visible = ghostHi.visible = true;
}
function placeGhost() {
  const g = E.ghost; if (!g) return;
  if (!g.valid) { toast('도로가 겹쳐서 놓을 수 없어요'); return; }
  const p = { id: newId(), type: g.type, x: g.pose.x, z: g.pose.z, k: g.pose.k };
  pieces.push(p); pushHist();
  const opens = openConns(pieces).filter(c => c.pid === p.id);
  E.anchor = opens.find(c => c.w === 'E') || opens[0] || null;
  E.anchorMode = !!E.anchor; E.anchorPx = E.lastPx ? { ...E.lastPx } : null;
  recompute();
}

/* ---------------------------------------------------------------- 선택/이동/회전/삭제 */
const centroid = p => { const w = worldPts(p); let x = 0, z = 0; w.forEach(q => { x += q.x; z += q.z; }); return { x: x / w.length, z: z / w.length }; };
function snapCompat(p, ignoreId) {
  const e = endPos(p);
  const ends = [{ x: p.x, z: p.z, d: mod8(p.k + 4) }, { x: e.x, z: e.z, d: mod8(p.k + pinfo(p.type).endK) }];
  let best = null, bd = 14;
  for (const c of openConns(pieces, ignoreId)) for (const en of ends) {
    const d = Math.hypot(c.x - en.x, c.z - en.z);
    if (d < bd && c.d === mod8(en.d + 4)) { bd = d; best = { dx: c.x - en.x, dz: c.z - en.z }; }
  }
  return best ? { ...p, x: p.x + best.dx, z: p.z + best.dz } : p;
}
function pickPiece(m) {
  let best = null, bd = 9.5;
  for (const p of pieces) for (const q of worldPts(p)) { const d = Math.hypot(q.x - m.x, q.z - m.z); if (d < bd) { bd = d; best = p; } }
  return best;
}
function tryApply(p, np, errMsg) {
  // 회전/반전 직전까지 이어져 있던 이웃과는 겹침 검사를 하지 않는다 (끝이 어긋나 열린 끝으로 남음)
  if (collides(np, pieces, p.id, neighborsOf(p, pieces))) { toast(errMsg); return false; }
  Object.assign(p, { x: np.x, z: np.z, k: np.k, type: np.type }); return true;
}
function rotateSelected(dir) {
  const p = selected(); if (!p) return;
  const c = centroid(p), [rx, rz] = rot(dir, p.x - c.x, p.z - c.z);
  const np = snapCompat({ ...p, x: c.x + rx, z: c.z + rz, k: mod8(p.k + dir) }, p.id);
  if (tryApply(p, np, '회전하면 도로가 겹쳐요')) commit();
}
function flipSelected() {
  const p = selected(); if (!p) return;
  if (!FLIP[p.type]) { toast('이 부품은 좌우반전이 필요 없어요'); return; }
  if (tryApply(p, { ...p, type: FLIP[p.type] }, '반전하면 도로가 겹쳐요')) commit();
}
function deleteSelected() {
  const p = selected();
  if (!p) { if (pieces.length) { pieces.pop(); E.anchorMode = false; commit(); } return; }
  pieces = pieces.filter(q => q.id !== p.id); E.selId = null; E.anchorMode = false; commit();
}

/* ---------------------------------------------------------------- 포인터 */
const ray = new THREE.Raycaster(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit = new THREE.Vector3();
function groundPoint(ev) {
  const r = canvas.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), camera);
  return ray.ray.intersectPlane(plane, hit) ? { x: hit.x, z: hit.z } : null;
}
const tch = { ids: new Set(), cam: null, place: null };      // 터치 편집: ids=눌린 손가락, cam=카메라 회전 중, place=배치 대기(탭이면 배치)
canvas.addEventListener('pointerdown', ev => { if (ev.pointerType === 'touch') tch.ids.add(ev.pointerId); }, true);
function rotateCamBy(dx, dy) {
  const off = camera.position.clone().sub(controls.target), sp = new THREE.Spherical().setFromVector3(off);
  sp.theta -= dx * 0.008; sp.phi = clampN(sp.phi - dy * 0.006, 0.06, Math.PI / 2.05);
  camera.position.copy(controls.target).add(off.setFromSpherical(sp)); camera.lookAt(controls.target);
}
canvas.addEventListener('pointermove', ev => {
  if (!canEdit()) return;
  if (ev.pointerType === 'touch') {
    if (tch.ids.size > 1) { tch.cam = tch.place = null; return; }                      // 두 손가락: OrbitControls 가 확대/이동 처리
    if (tch.place && ev.pointerId === tch.place.id && Math.hypot(ev.clientX - tch.place.x, ev.clientY - tch.place.y) > 10) { tch.cam = { id: tch.place.id, x: tch.place.x, y: tch.place.y }; tch.place = null; }     // 탭이 아니라 드래그 → 회전
    if (tch.cam && ev.pointerId === tch.cam.id) { rotateCamBy(ev.clientX - tch.cam.x, ev.clientY - tch.cam.y); tch.cam.x = ev.clientX; tch.cam.y = ev.clientY; return; }
  }
  const m = groundPoint(ev); if (!m) return;
  E.mouse = m; E.lastPx = { x: ev.clientX, y: ev.clientY };
  if (E.anchorMode && E.anchorPx && Math.hypot(ev.clientX - E.anchorPx.x, ev.clientY - E.anchorPx.y) > 12) E.anchorMode = false;
  if (E.drag) {
    const d = E.drag;
    if (!d.moved && Math.hypot(ev.clientX - d.px.x, ev.clientY - d.px.y) > 4) { d.moved = true; applyBuilt(); updateMarkers(); }
    if (d.moved) {
      const p = pieces.find(q => q.id === d.id);
      const np = snapCompat({ ...p, x: snapG(m.x + d.off.x), z: snapG(m.z + d.off.z) }, p.id);
      p.x = np.x; p.z = np.z; d.bad = collides(p, pieces, p.id);
      syncPieceGroups(); updateSelection(); hiMat.color.setHex(d.bad ? 0xff4d4d : 0x22d3c5);
    }
  } else updateGhost();
});
canvas.addEventListener('pointerdown', () => { if (V.role === 'host') V.spin = false; }, true);
canvas.addEventListener('pointerdown', ev => {
  if (!canEdit() || ev.button !== 0) return;
  const touch = ev.pointerType === 'touch';
  if (touch && tch.ids.size > 1) { tch.cam = tch.place = null; return; }
  const m = groundPoint(ev); if (!m) return; E.mouse = m; E.lastPx = { x: ev.clientX, y: ev.clientY };
  if (E.armed) { if (touch) { tch.place = { id: ev.pointerId, x: ev.clientX, y: ev.clientY }; return; } updateGhost(); placeGhost(); return; }     // 터치는 손가락을 뗄 때 배치 (드래그면 회전)
  const p = pickPiece(m);
  if (E.tool === 'delete') { if (p) { pieces = pieces.filter(q => q.id !== p.id); E.selId = null; commit(); } else if (touch) tch.cam = { id: ev.pointerId, x: ev.clientX, y: ev.clientY }; return; }
  E.selId = p ? p.id : null; updateSelection(); updateToolUI();
  if (!p && touch) tch.cam = { id: ev.pointerId, x: ev.clientX, y: ev.clientY };           // 빈 땅을 드래그하면 카메라 회전
  if (p) { E.drag = { id: p.id, orig: cloneP(p), off: { x: p.x - m.x, z: p.z - m.z }, px: { x: ev.clientX, y: ev.clientY }, moved: false, bad: false }; canvas.setPointerCapture(ev.pointerId); }
});
canvas.addEventListener('pointerup', ev => {
  const d = E.drag; if (!d) return; E.drag = null;
  try { canvas.releasePointerCapture(ev.pointerId); } catch { /* */ }
  hiMat.color.setHex(0x22d3c5);
  if (d.moved) {
    const p = pieces.find(q => q.id === d.id);
    if (d.bad || collides(p, pieces, p.id)) { Object.assign(p, d.orig); toast('도로가 겹쳐서 원래 자리로 되돌렸어요'); recompute(); }
    else commit();
  } else recompute(false);
});
const touchUp = ev => {
  tch.ids.delete(ev.pointerId); const pl = tch.place; tch.place = null;
  if (tch.cam && tch.cam.id === ev.pointerId) tch.cam = null;
  if (pl && pl.id === ev.pointerId && ev.type === 'pointerup' && canEdit()) { const m = groundPoint(ev); if (m) { E.mouse = m; E.lastPx = { x: ev.clientX, y: ev.clientY }; updateGhost(); placeGhost(); } }
};
canvas.addEventListener('pointerup', touchUp); canvas.addEventListener('pointercancel', touchUp);
canvas.addEventListener('pointerleave', () => { if (!E.drag) { E.mouse = null; if (!E.anchorMode) { ghostRoot.visible = ghostHi.visible = false; E.ghost = null; } } });

/* ---------------------------------------------------------------- UI 연결 */
function icon(type) {
  const s = inner => `<svg viewBox="0 0 46 40" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round">${inner}</svg>`;
  switch (type) {
    case 'straight': return s('<path d="M5 20H41"/>');
    case 'half': return s('<path d="M15 20H31"/>');
    case 'c45R': return s('<path d="M5 12C22 12 30 16 38 30"/>'); case 'c45L': return s('<path d="M5 28C22 28 30 24 38 10"/>');
    case 'c90R': return s('<path d="M7 7A24 24 0 0 1 31 31"/>'); case 'c90L': return s('<path d="M7 33A24 24 0 0 0 31 9"/>');
    case 'b90R': return s('<path d="M5 5A36 36 0 0 1 41 35"/>'); case 'b90L': return s('<path d="M5 35A36 36 0 0 0 41 5"/>');
    case 'up': return s('<path d="M4 31H13L31 11H42" stroke="#6dffa8"/><path d="M13 31V35M31 11V35" stroke="#6dffa8" stroke-width="2.5" opacity=".6"/>');
    case 'down': return s('<path d="M4 11H15L33 31H42" stroke="#ffd36b"/><path d="M15 11V35M33 31V35" stroke="#ffd36b" stroke-width="2.5" opacity=".6"/>');
    case 'jump': return s('<path d="M5 26H15L25 12" stroke="#ffd23f"/><path d="M33 22H41" stroke="#ffd23f"/>');
    case 'brake': return s('<path d="M5 20H41" stroke="#ff6b6b" stroke-dasharray="4 6"/>');
    case 'wave': return s('<path d="M4 24C9 24 9 15 15 15S21 24 26 24 32 15 37 15 42 24 42 24" stroke="#c9a6ff"/>');
    case 'lane': return s('<g stroke-width="4"><path d="M4 11H13C20 11 26 29 33 29H42"/><path d="M4 29H13C20 29 26 11 33 11H42" stroke="#9fd0ff"/></g>');
  }
}
/* 팔레트: 코너는 45° 하나만 (좌우는 F 반전, 방향은 Z/X 회전으로). 다른 부품(반 직선·90°·큰코너·브레이크)은 이미 만든 코스/추천 코스에서만 쓰인다. */
const PAL_ORDER = ['straight', 'c45R', 'up', 'down', 'jump', 'lane', 'wave'];     // 반 직선도 뺐다: 모든 부품 길이가 20의 배수라 양 끝이 항상 맞물려 닫힌 코스를 만들 수 있음
const PAL_LABEL = { c45R: '45° 코너' };
const palType = t => (t === 'c45L' ? 'c45R' : t);          // 반전된 코너도 같은 타일로 취급
PAL_ORDER.forEach(type => {
  const b = document.createElement('button'); b.className = 'pbtn'; b.dataset.type = type; b.innerHTML = icon(type) + `<span>${PAL_LABEL[type] || PIECES[type].label}</span>`;
  b.onclick = () => arm(palType(E.armed) === type ? null : type); $('pal').appendChild(b);
});
function arm(type) {
  E.armed = type; E.tool = 'select'; E.flipAttach = false; E.selId = null;
  if (type) {
    const last = pieces[pieces.length - 1], opens = openConns(pieces);
    const pref = last ? (opens.find(c => c.pid === last.id && c.w === 'E') || opens.find(c => c.pid === last.id)) : null;
    E.anchor = pref || opens[opens.length - 1] || null; E.anchorMode = !!E.anchor; E.anchorPx = E.lastPx ? { ...E.lastPx } : { x: -999, y: -999 };
  } else E.anchorMode = false;
  recompute(false);
}
/** 화면에 보이는 추천 코스 순서: 시즌 코스(2026년 윈터컵)를 맨 앞에. PRESETS 자체 순서는 더미 방 등에서 쓰므로 그대로 둔다 */
const FEATURED = ['2026년 윈터컵 코스'];
const presetNames = [...FEATURED.filter(n => PRESETS[n]), ...Object.keys(PRESETS).filter(n => !FEATURED.includes(n))];
const nFeat = FEATURED.filter(n => PRESETS[n]).length;
presetNames.forEach((name, i) => {
  const b = document.createElement('button'); b.className = 'btn preset'; b.textContent = name;
  if (i < nFeat) b.style.gridColumn = 'span 3';                                 // 시즌 코스: 첫 줄 전체 폭 (이름이 길어도 잘리지 않게)
  else {
    const n = presetNames.length - nFeat, rest = n % 3, left = presetNames.length - i;   // 마지막 줄이 3칸을 못 채우면 남은 칸만큼 넓혀서 빈 곳이 없게
    if (rest && left <= rest) b.style.gridColumn = left === 1 ? `span ${3 - rest + 1}` : '';
  }
  b.onclick = () => { pieces = layoutFromSeq(PRESETS[name]); E.selId = null; E.armed = null; E.anchorMode = false; commit(); fitCamera(false); }; $('presets').appendChild(b);
});
$('tSelect').onclick = () => { E.tool = 'select'; E.armed = null; E.anchorMode = false; recompute(false); };
$('tDelete').onclick = () => { E.tool = 'delete'; E.armed = null; E.anchorMode = false; recompute(false); };
$('bRotL').onclick = () => rotateKey(-1); $('bRotR').onclick = () => rotateKey(1);
$('bFlip').onclick = () => flipKey(); $('bDel').onclick = deleteSelected;
$('undo').onclick = () => undo(-1); $('redo').onclick = () => undo(1);
$('clear').onclick = () => { if (!pieces.length) return; pieces = []; E.selId = null; E.anchorMode = false; commit(); };
$('fit').onclick = () => fitCamera(true);

function rotateKey(d) {
  if (E.armed) { const g = E.ghost; if (g && g.snapped) E.flipAttach = !E.flipAttach; else E.rot = mod8(E.rot + d); updateGhost(); }
  else rotateSelected(d);
}
function flipKey() {
  if (E.armed) { if (FLIP[E.armed]) { E.armed = FLIP[E.armed]; updateToolUI(); updateGhost(); } return; }
  flipSelected();
}

function fitCamera(keepDir = true, home = false) {
  let mnx = -30, mxx = 30, mnz = -30, mxz = 30;
  const wp = pieces.flatMap(p => worldPts(p));
  if (wp.length) { mnx = Math.min(...wp.map(p => p.x)) - 20; mxx = Math.max(...wp.map(p => p.x)) + 20; mnz = Math.min(...wp.map(p => p.z)) - 20; mxz = Math.max(...wp.map(p => p.z)) + 20; }
  const cx = (mnx + mxx) / 2, cz = (mnz + mxz) / 2, r = Math.hypot(mxx - mnx, mxz - mnz) / 2;
  if (home) {            // 인트로: 낮은 각도에서 트랙이 화면 좌우로 크게 보이게 가까이
    controls.target.set(cx, 0, cz); camera.position.set(cx, r * 0.70 * Math.max(1, 0.9 / camera.aspect), cz + r * 0.82 * Math.max(1, 0.9 / camera.aspect)); controls.update(); return;
  }
  const dir = keepDir ? camera.position.clone().sub(controls.target).normalize() : new THREE.Vector3(0.1, 1, 0.45).normalize();
  if (dir.y < 0.5) { dir.y = 0.5; dir.normalize(); }
  controls.target.set(cx, 0, cz); camera.position.copy(controls.target).addScaledVector(dir, Math.max(110, r * 2.3) * Math.max(1, 0.85 / camera.aspect)); controls.update();
}

/* ====================================================================
 *  사운드 / 파티클
 * ==================================================================== */
let actx = null, engOsc, engGain, muted = false;
function initAudio() {
  if (actx) { if (actx.state === 'suspended') actx.resume(); return; }
  try {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    engOsc = actx.createOscillator(); engOsc.type = 'sawtooth';
    const f = actx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1200;
    engGain = actx.createGain(); engGain.gain.value = 0; engOsc.connect(f).connect(engGain).connect(actx.destination); engOsc.start();
  } catch { actx = null; }
}
function beep(f, d = 0.18, type = 'square', vol = 0.1) {
  if (!actx || muted) return;
  const o = actx.createOscillator(), g = actx.createGain(); o.type = type; o.frequency.value = f;
  g.gain.setValueAtTime(vol, actx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + d);
  o.connect(g).connect(actx.destination); o.start(); o.stop(actx.currentTime + d);
}
const MAXP = 300, pPos = new Float32Array(MAXP * 3), pVel = new Float32Array(MAXP * 3), pLife = new Float32Array(MAXP);
const pGeo = new THREE.BufferGeometry(); pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
const sparkPts = new THREE.Points(pGeo, new THREE.PointsMaterial({ color: 0xffb040, size: 0.8, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
sparkPts.frustumCulled = false; scene.add(sparkPts); let pHead = 0; for (let i = 0; i < MAXP; i++) pPos[i * 3 + 1] = -100;
function emit(x, y, z, vx, vy, vz, life = .5) { const i = pHead++ % MAXP; pPos.set([x, y, z], i * 3); pVel.set([vx, vy, vz], i * 3); pLife[i] = life; }
function updateParticles(dt) {
  for (let i = 0; i < MAXP; i++) {
    if (pLife[i] <= 0) { pPos[i * 3 + 1] = -100; continue; }
    pLife[i] -= dt; pVel[i * 3 + 1] -= 25 * dt;
    pPos[i * 3] += pVel[i * 3] * dt; pPos[i * 3 + 1] += pVel[i * 3 + 1] * dt; pPos[i * 3 + 2] += pVel[i * 3 + 2] * dt;
  }
  pGeo.attributes.position.needsUpdate = true;
}

/* ====================================================================
 *  차량 비주얼 / 세팅
 * ==================================================================== */
let carModel = null;
const blobMat = new THREE.MeshBasicMaterial({ map: canvasTex(128, 128, (g, w, h) => { const gr = g.createRadialGradient(w / 2, h / 2, 6, w / 2, h / 2, w / 2); gr.addColorStop(0, 'rgba(0,0,0,.6)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, w, h); }, false), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
class CarVis {
  constructor(style, kit) {
    this.group = new THREE.Group(); this.group.rotation.order = 'YXZ';
    const m = carModel.clone(true); m.rotation.y = Math.PI;
    m.traverse(o => {
      if (!o.isMesh) return; o.castShadow = true;
      o.material = o.material.clone(); const n = o.material.name;
      if (n === 'Chassis') o.material.color.setHex(style.main);
      if (n === 'Accent') { o.material.color.setHex(style.accent); o.material.emissive.setHex(style.accent).multiplyScalar(0.18); }
    });
    this.model = m; this.group.add(m); scene.add(this.group);
    this.wheelsF = ['wheel_FL', 'wheel_FR'].map(n => m.getObjectByName(n));
    this.wheelsR = ['wheel_RL', 'wheel_RR'].map(n => m.getObjectByName(n));
    this.rollers = ['roller_FL', 'roller_FR', 'roller_RL', 'roller_RR'].map(n => m.getObjectByName(n));
    // 커스텀 세팅을 모델에 반영: 타이어 지름(바퀴 크기·차고), 롤러 지름
    const sp = deriveSpec(kit || DEFAULT_KIT), wk = sp.tireMM / 26, rk = partOf(sp.kit, 'roller').mm / 11;
    this.wk = wk;
    [...this.wheelsF, ...this.wheelsR].forEach(w => w && w.scale.multiplyScalar(wk));
    this.rollers.forEach(r => r && r.scale.set(r.scale.x * rk, r.scale.y, r.scale.z * rk));
    m.position.y += (wk - 1) * 0.72;
    this.rollers = this.rollers.filter(Boolean); this.wheelsF = this.wheelsF.filter(Boolean); this.wheelsR = this.wheelsR.filter(Boolean);
    this.latVis = 0; this.roll = 0; this.yaw = 0; this.spin = { x: 0, y: 0, z: 0 };
    // 바닥 접지 그림자 (차와 함께 움직이고 기울어짐)
    this.blob = new THREE.Mesh(new THREE.PlaneGeometry(6.6, 8.8), blobMat);
    this.blob.rotation.x = -Math.PI / 2; this.blob.position.y = 0.06; this.blob.renderOrder = 2; this.group.add(this.blob);
    // 항공뷰에서 차를 구별하는 색 마커
    this.marker = new THREE.Group();
    const disc = new THREE.Mesh(new THREE.CircleGeometry(3.2, 28), new THREE.MeshBasicMaterial({ color: style.main, depthTest: false, transparent: true, opacity: 0.9 }));
    const ring = new THREE.Mesh(new THREE.RingGeometry(3.2, 4.2, 28), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.95 }));
    for (const o of [disc, ring]) { o.rotation.x = -Math.PI / 2; o.renderOrder = 6; this.marker.add(o); }
    this.marker.visible = false; scene.add(this.marker);
    // 차체 크기 (헤드라이트 위치용): 그룹이 아직 원점·무회전이라 로컬 좌표 그대로
    this.box = new THREE.Box3().setFromObject(m);
    this.lights = null; this.setLights(night);
  }
  /** 밤: 헤드라이트(렌즈 + 빛 번짐 + 노면을 비추는 빛 + 실제 스포트라이트) · 빨간 후미등 */
  setLights(on) {
    if (!on) { if (this.lights) this.lights.visible = false; return; }
    if (!this.lights) {
      const b = this.box, L = new THREE.Group(), fz = b.max.z - 0.15, hw = (b.max.x - b.min.x) / 2, ly = b.min.y + (b.max.y - b.min.y) * 0.42;
      for (const sx of [-1, 1]) {
        const lens = new THREE.Mesh(LAMP_GEO, LAMP_MAT); lens.position.set(sx * hw * 0.5, ly, fz); L.add(lens);
        const glow = new THREE.Sprite(GLOW_MAT); glow.position.set(sx * hw * 0.5, ly, fz + 0.3); glow.scale.set(3.2, 3.2, 1); L.add(glow);
        const tail = new THREE.Mesh(LAMP_GEO, TAIL_MAT); tail.position.set(sx * hw * 0.32, ly + 0.25, b.min.z + 0.6); tail.scale.setScalar(0.45); L.add(tail);
        const tg = new THREE.Sprite(TAILGLOW_MAT); tg.position.set(sx * hw * 0.32, ly + 0.25, b.min.z + 0.4); tg.scale.set(1.1, 1.1, 1); L.add(tg);
      }
      const beam = new THREE.Mesh(BEAM_GEO, BEAM_MAT); beam.rotation.x = -Math.PI / 2; beam.position.set(0, 0.08, fz + BEAM_LEN / 2 - 0.5); beam.renderOrder = 3; L.add(beam);
      const spot = new THREE.SpotLight(0xffedc4, 160, 70, 0.55, 0.65, 1.3); spot.position.set(0, ly + 0.6, fz);
      spot.target.position.set(0, 0, fz + 22); L.add(spot, spot.target);
      this.lights = L; this.group.add(L);
    }
    this.lights.visible = true;
  }
  dispose() { scene.remove(this.group); scene.remove(this.marker); }
}
/* 헤드라이트 공용 재질 */
const LAMP_GEO = new THREE.SphereGeometry(0.3, 12, 8);
const LAMP_MAT = new THREE.MeshBasicMaterial({ color: 0xfff7e0 });
const TAIL_MAT = new THREE.MeshBasicMaterial({ color: 0xff2a2a });
const glowTex = rgb => canvasTex(64, 64, (g, w, h) => { const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2); gr.addColorStop(0, `rgba(${rgb},1)`); gr.addColorStop(0.25, `rgba(${rgb},.45)`); gr.addColorStop(1, `rgba(${rgb},0)`); g.fillStyle = gr; g.fillRect(0, 0, w, h); }, false);
const GLOW_MAT = new THREE.SpriteMaterial({ map: glowTex('255,240,205'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
const TAILGLOW_MAT = new THREE.SpriteMaterial({ map: glowTex('255,40,30'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.55 });
const BEAM_LEN = 17;
const BEAM_GEO = new THREE.PlaneGeometry(10, BEAM_LEN);
/* 노면에 비치는 빛: 차 앞에서 시작해 부채꼴로 퍼지며 멀어질수록 흐려진다 (캔버스 위쪽 = 차 쪽) */
const BEAM_MAT = new THREE.MeshBasicMaterial({
  map: canvasTex(128, 256, (g, w, h) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h; const q = c.getContext('2d');
    q.beginPath(); q.moveTo(w * 0.36, 0); q.lineTo(w * 0.64, 0); q.lineTo(w * 0.98, h); q.lineTo(w * 0.02, h); q.closePath(); q.clip();
    const gr = q.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, 'rgba(255,238,200,.75)'); gr.addColorStop(0.45, 'rgba(255,232,190,.35)'); gr.addColorStop(1, 'rgba(255,228,185,0)');
    q.fillStyle = gr; q.fillRect(0, 0, w, h);
    g.filter = 'blur(7px)'; g.drawImage(c, 0, 0);
  }, false),
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
});

/* ---- 내 미니카 세팅 (커스텀 kit: 모터·기어·타이어·롤러·매스댐퍼·브레이크·바디) ---- */
const _oldSetups = store.get('mini4wd.setups', null);
/* 레이스 완주 횟수: 결과 화면이 뜰 때마다 +1 (관전 제외). 횟수에 따라 커스텀 부품이 해금된다 */
let races = Math.max(0, store.get('mini4wd.races', 0) | 0);
let myKit = lockKit(store.get('mini4wd.kit', null) || store.get('mini4wd.mySetup', (_oldSetups && _oldSetups[0]) || DEFAULT_KIT), races);   // 아직 잠긴 부품은 키트 기본으로
/** 홈의 커스텀 버튼: 아직 확인하지 않은 새 해금이 있으면 NEW 표시 */
const garageLocked = () => races < GARAGE_UNLOCK;
function updateUnlockDot() {
  const seen = store.get('mini4wd.racesSeen', 0), locked = garageLocked();
  $('carSetup').classList.toggle('locked', locked); $('carSetup').setAttribute('aria-disabled', locked ? 'true' : 'false');
  $('carSetupLabel').textContent = locked ? '🔒 미니카 커스텀' : '🔧 미니카 커스텀';
  $('carSetup').classList.toggle('newdot', !locked && races > seen && (seen < GARAGE_UNLOCK || unlocksSince(seen)));   // 커스텀이 처음 열렸거나 새 부품이 생기면 NEW
}
const unlocksSince = n => { for (let i = n + 1; i <= races; i++) if (unlocksAt(i).length) return true; return false; };
/** 커스텀 열기: 아직 잠겼으면 남은 횟수 안내 */
function openGarage(btn) {
  if (!garageLocked()) { garage.open(); return; }
  toast(`레이스 ${GARAGE_UNLOCK}회 완주 후 풀려요 (앞으로 ${GARAGE_UNLOCK - races}회)`);
  if (btn) { btn.classList.remove('shake'); void btn.offsetWidth; btn.classList.add('shake'); }
}
const myPayload = () => ({ motor: myKit.motor, tire: myKit.tire, kit: encodeKit(myKit) });
function setMyKit(k) {
  myKit = normalizeKit(k); store.set('mini4wd.kit', myKit); renderMyCar();
  if (V.code) backend.setMySetup(V.code, myPayload());
  toast('미니카 세팅을 적용했어요');
}
const garage = createGarage({
  getKit: () => myKit,
  getRaces: () => races,
  onOpen: () => { store.set('mini4wd.racesSeen', races); updateUnlockDot(); },
  onApply: setMyKit,
  getCourse: () => (loop.valid ? { track: loop.track, name: V.screen === 'room' ? '이 방의 코스' : '현재 코스' } : null),
});
function renderMyCar() {
  const sp = deriveSpec(myKit), P = k => partOf(myKit, k);
  $('myCar').innerHTML = `<div class="hd"><span class="dot" style="background:${hexs(STYLES[0].main)}"></span>🙋 내 미니카<button class="btn blue mini ${garageLocked() ? 'locked' : ''}" id="myCarEdit" title="${garageLocked() ? `레이스 ${GARAGE_UNLOCK}회 완주후 풀림` : ''}">${garageLocked() ? '🔒' : '🔧'} 커스텀</button></div>
    <div class="kitline"><b>${P('motor').name}</b> · ${P('gear').name.split(' ')[0]} · ${P('tire').name} ${P('dia').mm}mm</div>
    <div class="kitline">${P('roller').name} ×${P('rlay').n} · ${P('plate').name}</div>
    <div class="kitline">${P('damper').id === 'none' ? '매스댐퍼 없음' : P('damper').name} · ${P('brake').id === 'none' ? '브레이크 없음' : P('brake').name}</div>
    <div class="st">최고 ${(sp.vmax * KMH).toFixed(1)}km/h · 전폭 ${sp.width}mm · ${Math.round(sp.mass)}g</div>`;
  $('myCarEdit').onclick = () => openGarage($('myCarEdit'));
}
$('carSetup').onclick = () => openGarage($('carSetup'));
updateUnlockDot();

/* ====================================================================
 *  레이스
 * ==================================================================== */
let cars = [], vis = [], raceT = 0, countT = 0, lastCount = 4, camMode = 0, selCar = 0, finishAt = 0, resultShown = false;
let LAPS = 3, camH = 0, shake = 0, msgT = 0, standTimer = 0;
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
/* 카메라는 '차 기준 상대 위치'를 부드럽게 바꾼다 → 차가 빨라도 뒤로 처지지 않고 일정한 거리에서 따라간다 */
const camOff = new THREE.Vector3(); let camOffOk = false;

function ranking() {
  return [...cars].sort((a, b) => { if (a.finished && b.finished) return a.finishTime - b.finishTime; if (a.finished) return -1; if (b.finished) return 1; return b.s - a.s; });
}
function say(text, color = '#fff') { const m = $('msg'); m.textContent = text; m.style.color = color; msgT = 2.6; }

/* roster: 레이스 참가자 목록. [{ name, motor, tire, lane(0~2), speedMul }] — 0번이 "나" (색/단축키 1번) */
let roster = [], roomRoster = null, simAcc = 0;
function startRace(opts) {
  if (!carModel || !loop.valid) return;
  if (opts && opts.roster) roomRoster = { list: opts.roster, laps: opts.laps };     // 경기종료 때까지 이번 경기의 참가자 목록 유지
  if (!roomRoster) return;
  initAudio(); garage.close();
  roster = roomRoster.list; LAPS = LAPS_FIXED;
  if (!track) { track = loop.track; buildBuiltMesh(track); }
  vis.forEach(v => v.dispose()); vis = []; cars = [];
  roster.forEach((r, i) => { const kit = normalizeKit(r.kit || { motor: r.motor, tire: r.tire }), c = makeCar({ kit, seed: r.seed || i + 1 }, LANES[r.lane], r.name, i); c.speedMul = r.speedMul; c.s = 0; c.laps = 0; cars.push(c); vis.push(new CarVis(STYLES[i], kit)); });     // 출발선에서 시작 (GO 와 함께 초기 속도를 받는다)
  mode = 'countdown'; countT = (opts && opts.countT0) || 0; raceT = 0; simAcc = 0; lastCount = 4; finishAt = 0; resultShown = false; selCar = 0;
  $('editor').classList.add('hide'); $('home').classList.add('hide'); $('race').classList.remove('hide'); $('camMenu').classList.add('hide'); $('result').classList.add('hide'); $('toast').classList.add('hide');
  $('msg').textContent = ''; $('center').textContent = ''; syncView();
  controls.enabled = false; controls.autoRotate = false; camMode = 0; resetLook(); controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE; controls.touches.ONE = THREE.TOUCH.ROTATE;
  root.position.set(0, 0, 0); root.rotation.y = 0;               // 레이스는 트랙 좌표계 그대로
  layoutGroup.visible = false; markerGroup.visible = false; selMesh.visible = false; ghostRoot.visible = ghostHi.visible = false;
  poseCars(0); camH = Math.atan2(track.DX[0], track.DZ[0]); camera.fov = 58; camera.updateProjectionMatrix(); setCamMode(0);
  const lastCam = store.get(CAM_KEY, 0);                      // 마지막에 고른 카메라 버튼을 한 번 더 눌러 준다
  if (lastCam) { const b = document.querySelector(`.camb[data-m="${lastCam}"]`); if (b) b.click(); }
}
let pendingClose = false;
function toEditor() {       // 경기종료: 레이스 → 방으로 돌아가기
  bridgeMat.opacity = 1; bridgeMat.depthWrite = true;
  roomRoster = null; mode = 'build'; vis.forEach(v => v.dispose()); vis = []; cars = [];
  $('race').classList.add('hide'); $('result').classList.add('hide');
  controls.enabled = true; camera.fov = 55; camera.updateProjectionMatrix(); markerGroup.visible = true;
  if (engGain) engGain.gain.value = 0;
  if (pendingClose) { pendingClose = false; toast('방장이 방을 닫았어요'); showHome(); return; }
  if (V.code) backend.resetRoom(V.code);
  applyScreen(); fitCamera(false);
}

function poseCars(dt) {
  cars.forEach((c, i) => {
    const v = vis[i], g = v.group;
    v.model.visible = c.invul > 0 ? (Math.floor(performance.now() / 90) % 2 === 0) : true;
    if (c.state === 'crash') {
      g.position.set(c.c.x, c.c.y, c.c.z);
      const sd = dt * TIME_SCALE * CRASH_TIME; v.spin.x += c.c.rx * sd; v.spin.y += c.c.ry * sd; v.spin.z += c.c.rz * sd;
      g.rotation.set(v.spin.x, v.yaw + v.spin.y, v.spin.z); return;
    }
    const p = sampleAt(track, c.s);
    v.latVis += ((c.scrape ? c.scrapeSide * 0.7 : 0) - v.latVis) * Math.min(1, 8 * dt);
    const lat = laneLatAt(c, track, c.s) + v.latVis, nx = p.tz, nz = -p.tx;
    g.position.set(p.x + nx * lat, (isNaN(c.y) ? 0 : c.y) + 0.03, p.z + nz * lat);
    if (track.seq[p.piece] === 'wave') { const k = waveSlope(p.s - track.pieceStart[p.piece], PIECES.wave.len); v.yaw = Math.atan2(p.tx - p.tz * k, p.tz + p.tx * k); }   // 웨이브: 물결 따라 차 머리도 좌우로
    else v.yaw = Math.atan2(p.tx, p.tz);
    v.spin = { x: 0, y: 0, z: 0 };
    const pitch = c.state === 'air' ? Math.atan2(c.vy, Math.max(1, c.v)) : Math.atan(p.slope + laneLiftAt(c, track, c.s).slope);
    v.roll += ((c.scrape ? -c.scrapeSide * 0.08 : 0) - v.roll) * Math.min(1, 10 * dt);
    g.rotation.set(-pitch, v.yaw, v.roll);
    const dist = c.v * dt * TIME_SCALE;
    v.wheelsF.forEach(w => w.rotation.x -= dist / (0.66 * v.wk)); v.wheelsR.forEach(w => w.rotation.x -= dist / (0.76 * v.wk));
    v.rollers.forEach(r => r.rotation.y += dist * 0.9);
    if (c.scrape && dt > 0) for (let k = 0; k < 2; k++) {
      const ox = p.x + nx * (lat + c.scrapeSide * 2.4), oz = p.z + nz * (lat + c.scrapeSide * 2.4);
      emit(ox, c.y + 0.9, oz, (Math.random() - .5) * 8 + nx * c.scrapeSide * 5, 3 + Math.random() * 5, (Math.random() - .5) * 8 + nz * c.scrapeSide * 5, 0.4);
    }
  });
  cars.forEach((c, i) => { const v = vis[i], p = v.group.position; v.marker.position.set(p.x, p.y + 5, p.z); v.blob.visible = c.state === 'ground'; });
}
function handleEvents(c, i) {
  for (const e of c.events) {
    const col = hexs(STYLES[i].main);
    if (e.type === 'land') { say(`${c.name} 점프 성공! 🚀`, '#6dffa8'); beep(660, .12, 'triangle'); if (i === selCar) shake = 0.4; }
    else if (e.type === 'fall') { say(`${c.name} 점프 실패… 추락! 💥`, '#ff8d8d'); beep(140, .35, 'sawtooth', .12); }
    else if (e.type === 'wallhit') { beep(95, .12, 'square', .1); if (i === selCar) shake = Math.max(shake, 0.5); }
    else if (e.type === 'caught') { say(`${c.name} 벽에 걸렸다! 🧱`, '#ffd36b'); beep(180, .2, 'triangle', .1); }
    else if (e.type === 'hop') { beep(420, .07, 'triangle', .07); if (i === selCar) shake = Math.max(shake, 0.25); }
    else if (e.type === 'bounceout') { say(`${c.name} 착지에서 튕겨 나갔다! 💥`, '#ff8d8d'); beep(120, .4, 'sawtooth', .12); if (i === selCar) shake = 0.8; }
    else if (e.type === 'flyoff') { say(`${c.name} 코스 아웃! 💥`, '#ff8d8d'); beep(120, .4, 'sawtooth', .12); if (i === selCar) shake = 0.8; }
    else if (e.type === 'lap' && i === selCar && e.n < LAPS) say(`${c.name} LAP ${e.n} · ${fmtS(e.time)}`, col);
    else if (e.type === 'finish') { say(`🏁 ${c.name} 골인!`, col); beep(880, .4, 'triangle', .14); if (!finishAt) finishAt = raceT; }
  }
}
/** 세로(좁은) 화면에서는 가로 시야가 좁으므로 카메라를 그만큼 뒤로 뺀다 (비율 1 이상이면 1) */
const portraitK = () => (camera.aspect < 1 ? Math.min(2.0, 1 + (1 - camera.aspect) * 0.95) : 1);
const camDefs = () => [11 * portraitK(), 5.5 * portraitK()];
const AERIAL_OFF = new THREE.Vector3(0, 66, 24);
function snapCam() {
  const c = cars[selCar], p = sampleAt(track, c.s), y = isNaN(c.y) ? 0 : c.y;
  if (camMode === 1) { const k = portraitK(); camPos.set(p.x + AERIAL_OFF.x * k, y + AERIAL_OFF.y * k, p.z + AERIAL_OFF.z * k); camLook.set(p.x, y, p.z); }
  else { const [d, h] = camDefs(); camPos.set(p.x - p.tx * d, y + h, p.z - p.tz * d); camLook.set(p.x + p.tx * 6, y + 1, p.z + p.tz * 6); }
  camera.position.copy(camPos); camera.lookAt(camLook); camOffOk = false;
}
function fitAerial() {
  let mnx = 1e9, mxx = -1e9, mnz = 1e9, mxz = -1e9;
  for (let i = 0; i < track.n; i++) { mnx = Math.min(mnx, track.X[i]); mxx = Math.max(mxx, track.X[i]); mnz = Math.min(mnz, track.Z[i]); mxz = Math.max(mxz, track.Z[i]); }
  const cx = (mnx + mxx) / 2, cz = (mnz + mxz) / 2, r = Math.hypot(mxx - mnx, mxz - mnz) / 2 + 25;
  camera.fov = 50; camera.updateProjectionMatrix();
  const h = r / Math.tan(THREE.MathUtils.degToRad(25)) * 1.02 * Math.max(1, 0.85 / camera.aspect);
  controls.target.set(cx, 0, cz); camera.position.set(cx, h, cz + h * 0.18); controls.update();
}
const CAM_KEY = 'mini4wd.camMode';
function pickCam(m) { setCamMode(m); store.set(CAM_KEY, m); }     // 사용자가 고른 카메라 모드만 저장
function setCamMode(m) {
  camMode = m; controls.enabled = m >= 2;
  document.querySelectorAll('.camb').forEach(b => b.classList.toggle('on', +b.dataset.m === m));
  vis.forEach(v => { v.marker.visible = m === 1 || m === 2; });
  if (!cars.length) return;
  if (m === 2) fitAerial(); else if (m === 3) controls.target.copy(vis[selCar].group.position); else snapCam();
}
/** 레인체인지 근처에서는 추적 카메라가 고가 도로 속에 묻히지 않도록 고가 난간보다 높게 */
function laneCamMinY(c) {
  const lc = track && track.lc; if (!lc || !lc.length) return -Infinity;
  const L = track.Ltot, x = ((c.s % L) + L) % L;
  for (const seg of lc) if (x > seg.s0 - 16 && x < seg.s1 + 4) { const h = sampleAt(track, seg.s0).h; return (isNaN(h) ? 0 : h) + BRIDGE_H + 3.6; }
  return -Infinity;
}
function updateCamera(dt) {
  const c = cars[selCar], g = vis[selCar].group;
  if (camMode === 2) { controls.update(); return; }
  if (camMode === 3) { controls.target.lerp(g.position, 1 - Math.exp(-6 * dt)); controls.update(); return; }
  const base = g.position, k = 1 - Math.exp(-8 * dt);
  let tx, ty, tz;
  if (!camOffOk) { camOff.copy(camPos).sub(base); camOffOk = true; }
  const follow = () => { camOff.x += (tx - base.x - camOff.x) * k; camOff.y += (ty - base.y - camOff.y) * k; camOff.z += (tz - base.z - camOff.z) * k; camPos.copy(base).add(camOff); };
  if (camMode === 1) {   // 항공 추적: 방위 고정(북), 시점 회전은 lookYaw/lookPitch/lookZoom
    const len = AERIAL_OFF.length() * lookZoom * portraitK(), e = THREE.MathUtils.clamp(Math.atan2(AERIAL_OFF.y, AERIAL_OFF.z) + lookPitch, 0.15, 1.5);
    tx = base.x + Math.sin(lookYaw) * len * Math.cos(e); ty = base.y + len * Math.sin(e); tz = base.z + Math.cos(lookYaw) * len * Math.cos(e);
    follow();
    camera.position.copy(camPos); camera.lookAt(base.x, base.y, base.z);
    camera.fov += (55 - camera.fov) * Math.min(1, 5 * dt); camera.updateProjectionMatrix(); return;
  }
  // 추적: 차 뒤 기본 위치에서 lookYaw(좌우)·lookPitch(상하)·lookZoom(거리) 만큼 차 주위를 회전
  const p = sampleAt(track, c.s), yaw = c.state === 'crash' ? camH : Math.atan2(p.tx, p.tz);
  camH += wrapAngle(yaw - camH) * (1 - Math.exp(-5 * dt));
  const [d, h] = camDefs(), back = d + c.v * 0.05;
  const len = Math.hypot(back, h) * lookZoom, e = THREE.MathUtils.clamp(Math.atan2(h, back) + lookPitch, 0.03, 1.45), az = camH + Math.PI + lookYaw;
  tx = base.x + Math.sin(az) * len * Math.cos(e); ty = Math.max(base.y + len * Math.sin(e), laneCamMinY(c)); tz = base.z + Math.cos(az) * len * Math.cos(e);
  follow(); camPos.y = Math.max(camPos.y, laneCamMinY(c));
  const fw = Math.max(0, 1 - (Math.abs(lookYaw) + Math.abs(lookPitch)) * 2);      // 시점을 돌리면 차 자체를 바라봄
  camLook.set(base.x + Math.sin(camH) * 6 * fw, base.y + 1.2, base.z + Math.cos(camH) * 6 * fw);
  camera.position.copy(camPos);
  if (shake > 0) { camera.position.x += (Math.random() - .5) * shake; camera.position.y += (Math.random() - .5) * shake; shake = Math.max(0, shake - dt * 2); }
  camera.lookAt(camLook);
  const fov = Math.min(76, 58 + c.v * 0.17); camera.fov += (fov - camera.fov) * Math.min(1, 5 * dt); camera.updateProjectionMatrix();
}

/* ---- 시점 조작: 방향키 / 마우스 드래그 / 휠 (편집 화면과 주행 화면 공통) ---- */
let lookYaw = 0, lookPitch = 0, lookZoom = 1;
const held = new Set(), CAM_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract'];
const clampN = (v, a, b) => Math.max(a, Math.min(b, v));
function resetLook() { lookYaw = 0; lookPitch = 0; lookZoom = 1; }
function applyKeyCam(dt) {
  if (!held.size) return;
  const az = ((held.has('ArrowRight') ? 1 : 0) - (held.has('ArrowLeft') ? 1 : 0)) * 1.7 * dt;
  const el = ((held.has('ArrowUp') ? 1 : 0) - (held.has('ArrowDown') ? 1 : 0)) * 1.2 * dt;
  const zm = ((held.has('Equal') || held.has('NumpadAdd')) ? 1 : 0) - ((held.has('Minus') || held.has('NumpadSubtract')) ? 1 : 0);
  if (mode === 'build' || camMode >= 2) {          // 궤도 카메라: 대상 주위를 돈다
    const off = camera.position.clone().sub(controls.target), sp = new THREE.Spherical().setFromVector3(off);
    sp.theta += az; sp.phi = clampN(sp.phi - el, 0.06, Math.PI / 2.05); sp.radius = clampN(sp.radius * Math.exp(-zm * 1.2 * dt), 15, 900);
    camera.position.copy(controls.target).add(off.setFromSpherical(sp)); camera.lookAt(controls.target);
  } else {                                          // 추적/항공 추적: 차 주위 시점 오프셋
    lookYaw += az; lookPitch = clampN(lookPitch + el, -0.6, 1.2); lookZoom = clampN(lookZoom * Math.exp(-zm * 1.2 * dt), 0.4, 3);
  }
}
addEventListener('keydown', e => {
  if (e.target && ['SELECT', 'INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
  if (modalOpen()) return;
  if (CAM_KEYS.includes(e.code)) { if (e.code.startsWith('Arrow')) e.preventDefault(); held.add(e.code); }
});
addEventListener('keyup', e => held.delete(e.code));
addEventListener('blur', () => held.clear());
let lookDrag = null, pinchDist = 0;
const lookPts = new Map();                                   // 터치 중인 포인터들: 한 손가락 = 시점 회전, 두 손가락 = 핀치 확대
canvas.addEventListener('pointerdown', ev => {
  if (mode === 'build' || camMode >= 2) return;
  lookPts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY }); canvas.setPointerCapture(ev.pointerId);
  if (lookPts.size === 2) { const [a, b] = [...lookPts.values()]; pinchDist = Math.hypot(a.x - b.x, a.y - b.y); lookDrag = null; }
  else lookDrag = { x: ev.clientX, y: ev.clientY };
});
canvas.addEventListener('pointermove', ev => {
  if (lookPts.has(ev.pointerId)) lookPts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (lookPts.size === 2 && pinchDist > 0) {
    const [a, b] = [...lookPts.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
    if (d > 4) { lookZoom = clampN(lookZoom * pinchDist / d, 0.4, 3); pinchDist = d; }
    return;
  }
  if (!lookDrag) return;
  lookYaw -= (ev.clientX - lookDrag.x) * 0.006; lookPitch = clampN(lookPitch + (ev.clientY - lookDrag.y) * 0.005, -0.6, 1.2);
  lookDrag.x = ev.clientX; lookDrag.y = ev.clientY;
});
const endLookDrag = ev => {
  lookPts.delete(ev.pointerId); pinchDist = 0;
  if (lookPts.size === 1) { const [p] = [...lookPts.values()]; lookDrag = { x: p.x, y: p.y }; }       // 두 손가락 중 하나를 떼면 남은 손가락으로 계속 회전
  else if (lookDrag) { lookDrag = null; }
  try { canvas.releasePointerCapture(ev.pointerId); } catch { /* */ }
};
canvas.addEventListener('pointerup', endLookDrag); canvas.addEventListener('pointercancel', endLookDrag);
canvas.addEventListener('wheel', ev => { if (mode === 'build' || camMode >= 2) return; ev.preventDefault(); lookZoom = clampN(lookZoom * Math.exp(ev.deltaY * 0.001), 0.4, 3); }, { passive: false });
function updateStandings() {
  const rk = ranking(), el = $('stand');
  let h = `<div class="head">🏁 ${LAPS}랩 · ${fmtS(raceT)}</div>`;
  rk.forEach((c, i) => {
    const st = c.state === 'crash' ? '💥' : c.state === 'air' ? '🚀' : c.scrape ? '🔥' : '';
    const info = c.finished ? fmtS(c.finishTime) : `LAP ${Math.max(1, Math.min(LAPS, c.laps + 1))}/${LAPS} · ${Math.round(c.v * KMH)}km/h`;
    h += `<div class="r ${c.colorIdx === selCar ? 'sel' : ''}" data-i="${c.colorIdx}"><b>${i + 1}</b><span class="dot" style="background:${hexs(STYLES[c.colorIdx].main)};width:13px;height:13px"></span>${c.name} ${st}<span class="t">${info}</span></div>`;
  });
  el.innerHTML = h; el.querySelectorAll('.r').forEach(r => r.onclick = () => { selCar = +r.dataset.i; });
}
function showResult() {
  resultShown = true;
  const rk = ranking(), win = rk[0];
  $('resTitle').textContent = `🏆 ${win.name} 우승!`;
  $('resTable').innerHTML = '<tr><th>순위</th><th>차</th><th>기록</th><th>베스트 랩</th><th>코스아웃</th></tr>' + rk.map((c, i) =>
    `<tr><td>${i + 1}</td><td style="color:${hexs(STYLES[c.colorIdx].main)};font-weight:800">${c.name}</td><td>${c.finished ? fmtS(c.finishTime) : '주행 중'}</td><td>${fmtS(c.bestLap)}</td><td>${c.crashes}</td></tr>`).join('');
  $('result').classList.remove('hide');
  startConfetti();
  countRace();
  submitMyRecord();
}
/** 레이스 1회 완주 → 해금 확인. 새로 열린 부품을 결과 화면에 보여 준다 */
function countRace() {
  const el = $('resUnlock'); el.innerHTML = ''; el.classList.add('hide');
  if (V.role === 'spectator') return;
  races++; store.set('mini4wd.races', races); updateUnlockDot(); renderMyCar();
  // 어떤 부품이 열렸는지는 커스텀 화면에서 확인 — 결과 팝업에는 해금 사실만 알린다
  const newParts = unlocksAt(races).length > 0, newGarage = races === GARAGE_UNLOCK, nx = nextUnlock(races);
  const next = garageLocked() ? `<div class="ru-next">미니카 커스텀까지 레이스 <b>${GARAGE_UNLOCK - races}회</b></div>`
    : nx ? `<div class="ru-next">다음 해금까지 레이스 <b>${nx.at - races}회</b></div>` : '<div class="ru-next">🎉 모든 부품을 해금했어요!</div>';
  const got = newGarage || newParts;
  el.innerHTML = got
    ? `<div class="ru-h">🔓 ${newGarage ? '미니카 커스텀이 열렸어요!' : '새 부품 해금!'} <small>(레이스 ${races}회 완주)</small></div><div class="ru-sub">미니카 커스텀에서 확인해 보세요</div>${next}`
    : `<div class="ru-h sm">🏁 레이스 ${races}회 완주</div>${next}`;
  el.classList.toggle('got', got); el.classList.remove('hide');
}
/* 우승 팝업: 색종이가 위에서 떨어지는 효과 (팝업이 닫히면 멈춘다) */
let confettiRaf = 0;
function startConfetti() {
  const cv = $('confetti'), g = cv.getContext('2d'), dpr = Math.min(2, devicePixelRatio || 1);
  cv.width = Math.round(innerWidth * dpr); cv.height = Math.round(innerHeight * dpr);
  const W = cv.width, H = cv.height, COLORS = ['#ffd23f', '#ff5d5d', '#4da0ff', '#6dffa8', '#ff9ad5', '#ffffff', '#ff9f43'];
  const N = innerWidth < 600 ? 90 : 160, rnd = (a, b) => a + Math.random() * (b - a);
  const mk = (initial) => ({ x: rnd(0, W), y: initial ? rnd(-H, 0) : rnd(-60, -10) * dpr, w: rnd(6, 12) * dpr, h: rnd(10, 18) * dpr, vy: rnd(120, 260) * dpr, vx: rnd(-40, 40) * dpr,
    rot: rnd(0, 6.28), vr: rnd(-6, 6), ph: rnd(0, 6.28), sw: rnd(0.8, 2), c: COLORS[(Math.random() * COLORS.length) | 0] });
  const ps = Array.from({ length: N }, () => mk(true));
  cancelAnimationFrame(confettiRaf);
  let last = performance.now();
  const tick = now => {
    if ($('result').classList.contains('hide')) { g.clearRect(0, 0, W, H); return; }
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    g.clearRect(0, 0, W, H);
    for (let i = 0; i < ps.length; i++) {
      let p = ps[i];
      p.y += p.vy * dt; p.ph += p.sw * dt * 3; p.x += (p.vx + Math.sin(p.ph) * 40 * dpr) * dt; p.rot += p.vr * dt;
      if (p.y > H + 30 * dpr) p = ps[i] = mk(false);
      g.save(); g.translate(p.x, p.y); g.rotate(p.rot); g.scale(1, Math.cos(p.ph * 1.7)); g.fillStyle = p.c; g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); g.restore();
    }
    confettiRaf = requestAnimationFrame(tick);
  };
  confettiRaf = requestAnimationFrame(tick);
}

/* ====================================================================
 *  키보드
 * ==================================================================== */
addEventListener('keydown', e => {
  if (garage.isOpen()) { if (e.code === 'Escape') garage.close(); return; }
  if (modalOpen()) { if (e.code === 'Escape') closeModal(); return; }
  if (e.target && ['SELECT', 'INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
  if (mode === 'build') {
    if (!canEdit()) return;
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') { e.preventDefault(); undo(e.shiftKey ? 1 : -1); return; }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyY') { e.preventDefault(); undo(1); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'KeyZ') rotateKey(-1);
    else if (e.code === 'KeyX') rotateKey(1);
    else if (e.code === 'KeyF') flipKey();
    else if (e.code === 'KeyQ') { E.tool = 'select'; E.armed = null; E.anchorMode = false; recompute(false); }
    else if (e.code === 'KeyW') { E.tool = 'delete'; E.armed = null; E.anchorMode = false; recompute(false); }
    else if (e.code === 'KeyA') fitCamera(true);
    else if (e.code === 'Delete' || e.code === 'Backspace') { e.preventDefault(); deleteSelected(); }
    else if (e.code === 'Escape') { E.armed = null; E.tool = 'select'; E.selId = null; E.anchorMode = false; recompute(false); }
    else if (e.code === 'Enter' && E.armed) placeGhost();
    else if (/^Digit\d$/.test(e.code)) { const i = e.code === 'Digit0' ? 9 : +e.code.slice(-1) - 1; if (PAL_ORDER[i]) arm(PAL_ORDER[i]); }
    return;
  }
  if (e.repeat) return;
  if (e.code === 'KeyE') toEditor();
  if (e.code === 'KeyM') { muted = !muted; if (engGain) engGain.gain.value = 0; }
  if (e.code === 'KeyC') pickCam((camMode + 1) % 4);
  if (e.code === 'KeyV') pickCam(camMode === 2 ? 0 : 2);
  if (e.code === 'Digit0') resetLook();
  if (['Digit1', 'Digit2', 'Digit3'].includes(e.code) && +e.code.slice(-1) - 1 < cars.length) selCar = +e.code.slice(-1) - 1;
});
/* 카메라 변경 버튼 하나 → 누르면 나머지 카메라 버튼이 펼쳐진다 */
const closeCamMenu = () => $('camMenu').classList.add('hide');
$('camToggle').onclick = () => $('camMenu').classList.toggle('hide');
document.querySelectorAll('.camb').forEach(b => { b.onclick = () => { if (mode !== 'build' && cars.length) pickCam(+b.dataset.m); closeCamMenu(); }; });
$('camReset').onclick = () => { resetLook(); if (camMode >= 2 && cars.length) setCamMode(camMode); closeCamMenu(); };
$('toEditor').onclick = toEditor; $('editBtn').onclick = toEditor;

/* ====================================================================
 *  화면 흐름 (홈 → 방) / 랭킹 — 백엔드는 src/backend.js (현재는 더미)
 * ==================================================================== */
setSeedCourses(Object.entries(PRESETS).map(([name, seq]) => ({ name, seq })));
const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const mName = id => (MOTORS.find(m => m.id === id) || {}).name || id;
const tName = id => (TIRES.find(t => t.id === id) || {}).name || id;
const modalOpen = () => !$('modal').classList.contains('hide');
let modalCleanup = null;
function openModal(title, html) { $('modalTitle').textContent = title; $('modalBody').innerHTML = html; $('modal').classList.remove('hide'); }
function closeModal() { $('modal').classList.add('hide'); const f = modalCleanup; modalCleanup = null; if (f) f(); }
$('modalClose').onclick = closeModal;
/** 랭킹 보드 키: 코스(부품 순서) + ~v2(속도 조정 이후 실제 시간 기준). hint: 더미 기록 생성용 대략적 소요 시간 */
const boardKey = seq => courseKey(seq) + '~v2';
const boardHint = tr => l => tr.Ltot * l / 52 / TIME_SCALE;
const courseInfo = () => loop.valid ? { key: boardKey(loop.seq), hint: boardHint(loop.track) } : null;   // ~v2: 실제 시간 기준 기록(속도 조정 이후) — 예전 기록과 섞이지 않게 보드 분리   // hint: 더미 기록 생성용 대략적 소요 시간
const DUMMY_NOTE = backend.rankKind === 'firebase' ? '' : '<div class="hint">※ 지금은 더미 데이터예요. 기록은 이 브라우저에만 저장됩니다.</div>';

/* ---- 랭킹 창 (홈 메뉴): 내 기록 + 코스별 전체 랭킹 ----
 * 코스별 랭킹은 사람마다 최고 기록 1개 → 새 사람이 완주할수록 참가자가 계속 늘어난다.
 * 서버 읽기를 아끼려고 탭을 누를 때만 불러오고, 창이 열려 있는 동안은 결과를 기억한다. */
const rankTr = (x, rank) => `<tr class="${x.me ? 'me' : ''}"><td>${rank <= 3 ? ['🥇', '🥈', '🥉'][rank - 1] : rank}</td><td>${esc(x.name)}${x.me ? ' <b>(나)</b>' : ''}</td><td>${fmt(x.time)}</td><td>${fmt(x.best)}</td><td class="rk-set">${mName(x.motor)} / ${tName(x.tire)}</td></tr>`;
function rankCourses() {
  const list = presetNames.map(name => ({ id: 'p:' + name, name, seq: PRESETS[name], level: PRESET_LEVEL[name] || 0 }));
  if (loop.valid && !list.some(c => courseKey(c.seq) === courseKey(loop.seq))) list.push({ id: 'cur', name: V.screen === 'room' ? '이 방의 코스' : '내가 만든 코스', seq: loop.seq.slice(), level: 0 });
  return list.map(c => { const tr = buildTrack(c.seq); return { ...c, key: boardKey(c.seq), hint: boardHint(tr), len: tr.Ltot }; });
}
async function showRankingHome(startId) {
  const courses = rankCourses(), cache = new Map(), laps = LAPS_FIXED;
  let cur = startId || 'me', token = 0;
  openModal('🏆 랭킹', '');
  const tabs = () => `<div class="rk-tabs">${[{ id: 'me', name: '👤 내 기록' }, ...courses].map(c => `<button class="btn rk-tab ${c.id === cur ? 'on' : ''}" data-id="${esc(c.id)}">${esc(c.name)}</button>`).join('')}</div>`;
  const render = html => {
    if (!modalOpen()) return;
    const sc = $('modalBody').querySelector('.rk-tabs'), x = sc ? sc.scrollLeft : 0;
    $('modalBody').innerHTML = tabs() + `<div class="rk-body">${html}</div>` + DUMMY_NOTE;
    const nt = $('modalBody').querySelector('.rk-tabs'); nt.scrollLeft = x;
    const on = nt.querySelector('.on'); if (on && !sc) on.scrollIntoView({ block: 'nearest', inline: 'center' });
    nt.querySelectorAll('[data-id]').forEach(b => b.onclick = () => { cur = b.dataset.id; show(); });
  };
  const load = c => { if (!cache.has(c.id)) cache.set(c.id, backend.topRecords({ courseKey: c.key, laps, hint: c.hint(laps), limit: c.lim || 10 }).catch(() => null)); return cache.get(c.id); };
  async function show() {
    const my = ++token;
    render('<div class="hint" style="padding:18px 0;text-align:center">불러오는 중…</div>');
    if (cur === 'me') {
      const rs = await Promise.all(courses.map(c => load(c)));
      if (my !== token) return;
      const done = rs.filter(r => r && r.myBest).length;
      render(`<div class="rk-sum">🏁 레이스 완주 <b>${races}회</b> · 기록이 있는 코스 <b>${done}/${courses.length}</b></div>
        <table class="rk"><tr><th>코스</th><th>내 최고 기록</th><th>순위</th></tr>${courses.map((c, i) => { const r = rs[i];
          return `<tr class="rk-row" data-go="${esc(c.id)}"><td>${esc(c.name)}${c.level ? ` <small class="rk-lv">${'★'.repeat(c.level)}</small>` : ''}</td><td>${r && r.myBest ? fmt(r.myBest.time) : '<span class="hint">—</span>'}</td><td>${r && r.myRank ? `<b>${r.myRank}</b>/${r.total}` : r ? `<span class="hint">${r.total}명 참가</span>` : '<span class="hint">오류</span>'}</td></tr>`; }).join('')}</table>
        <div class="hint" style="margin-top:6px">코스 이름을 누르면 그 코스의 전체 랭킹을 볼 수 있어요.</div>`);
      $('modalBody').querySelectorAll('[data-go]').forEach(t => t.onclick = () => { cur = t.dataset.go; show(); });
      return;
    }
    const c = courses.find(x => x.id === cur); if (!c) return;
    const r = await load(c);
    if (my !== token) return;
    if (!r) { render('<div class="hint" style="padding:18px 0;text-align:center">랭킹을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.</div>'); return; }
    const mine = r.myBest && !r.rows.some(x => x.me) ? `<tr class="rk-gap"><td colspan="5">⋯</td></tr>${rankTr({ ...r.myBest, me: true }, r.myRank)}` : '';
    render(`<div class="rk-sum"><b>${esc(c.name)}</b>${c.level ? ` <span class="rk-lv">${'★'.repeat(c.level)}</span>` : ''} · ${c.seq.length}개 부품 · ${laps}랩<br>
        참가자 <b>${r.total}명</b> · ${r.myRank ? `내 순위 <b>${r.myRank}위</b> (${fmt(r.myBest.time)})` : '아직 내 기록이 없어요'}</div>
      ${r.rows.length ? `<table class="rk"><tr><th>#</th><th>이름</th><th>기록</th><th>베스트 랩</th><th>세팅</th></tr>${r.rows.map(x => rankTr(x, x.rank)).join('')}${mine}</table>`
        : '<div class="hint" style="padding:14px 0;text-align:center">아직 기록이 없어요. 첫 기록의 주인공이 되어 보세요!</div>'}`);
  }
  show();
}

/* ---- 랭킹 (결과 화면에서 열기) ---- */
async function showRanking() {
  const ci = courseInfo(), laps = LAPS_FIXED;
  if (!ci) { openModal('🏆 코스 랭킹', '<div class="hint">완성된 코스가 있어야 랭킹을 볼 수 있어요.</div>'); return; }
  openModal(`🏆 코스 랭킹 · ${laps}랩`, '<div class="hint">불러오는 중…</div>');
  const r = await backend.topRecords({ courseKey: ci.key, laps, hint: ci.hint(laps), limit: 10 });
  if (!modalOpen()) return;
  $('modalBody').innerHTML = `<div class="hint" style="margin:0 0 6px">코스 ${ci.key} · ${loop.seq.length}개 부품 · ${loop.track.Ltot.toFixed(0)}m ${r.myRank ? `· <b>내 순위 ${r.myRank}/${r.total}위</b>` : '· 아직 내 기록이 없어요'}</div>
    <table class="rk"><tr><th>#</th><th>이름</th><th>기록</th><th>베스트 랩</th><th>세팅</th></tr>${r.rows.map(x =>
      `<tr class="${x.me ? 'me' : ''}"><td>${x.rank}</td><td>${esc(x.name)}${x.me ? ' <b>(나)</b>' : ''}</td><td>${fmt(x.time)}</td><td>${fmt(x.best)}</td><td>${mName(x.motor)}/${tName(x.tire)}</td></tr>`).join('')}</table>${DUMMY_NOTE}`;
}
async function submitMyRecord() {
  const el = $('resRank'); el.textContent = '';
  const me = cars[0], ci = courseInfo();
  if (V.role === 'spectator' || !me || !me.finished || !ci) return;
  const best = isFinite(me.bestLap) && me.bestLap > 0 ? me.bestLap : me.finishTime / LAPS;
  const r = await backend.submitRecord({ courseKey: ci.key, laps: LAPS, hint: ci.hint(LAPS), time: me.finishTime / TIME_SCALE, best: best / TIME_SCALE, motor: roster[0].motor, tire: roster[0].tire });
  el.innerHTML = r.improved ? `🏅 기록 저장! 이 코스(${LAPS}랩) <b>${r.rank}위 / ${r.total}명</b>` : `이 코스(${LAPS}랩) 내 최고 기록보다 느려요 · 현재 순위 ${r.rank}위 / ${r.total}명`;
}
$('resRankBtn').onclick = () => showRanking();
$('homeRank').onclick = () => showRankingHome();

/* ---- 배경음악: 접속하면 바로 재생 (브라우저가 막으면 첫 터치/키 입력에서 시작), 버튼으로 끄고 켜기 ---- */
const bgm = new Audio('assets/sounds/bgm.mp3'); bgm.loop = true; bgm.volume = 0.35; bgm.preload = 'auto';   // 음원은 최대 -1.7dB 로 키워 둠(원본은 -20dB 로 너무 작았음)
let bgmOn = store.get('mini4wd.bgm', true) !== false, bgmWait = false;
function bgmUI() { const b = $('bgmBtn'); b.textContent = bgmOn ? '🔊' : '🔇'; b.title = bgmOn ? '배경음악 끄기' : '배경음악 켜기'; b.classList.toggle('off', !bgmOn); }
function bgmPlay() {
  if (!bgmOn || document.hidden) return;
  bgm.play().catch(() => {
    if (matchMedia('(max-width:820px), (max-height:560px)').matches) return;     // 모바일: 방 만들기 / 참여하기 버튼을 누를 때 시작
    if (bgmWait) return; bgmWait = true;                    // PC: 자동 재생이 막히면 처음 누르는 순간 시작
    const go = () => { bgmWait = false; removeEventListener('pointerdown', go, true); removeEventListener('keydown', go, true); bgmPlay(); };
    addEventListener('pointerdown', go, true); addEventListener('keydown', go, true);
  });
}
$('bgmBtn').onclick = () => { bgmOn = !bgmOn; store.set('mini4wd.bgm', bgmOn); if (bgmOn) bgmPlay(); else bgm.pause(); bgmUI(); };
document.addEventListener('visibilitychange', () => { if (document.hidden) bgm.pause(); else bgmPlay(); });
/* PC 경기 화면: 소리 버튼을 오른쪽 위 '카메라 변경' 왼쪽으로 옮긴다 (그 밖의 화면/모바일은 원래 자리) */
function placeBgm() {
  const b = $('bgmBtn'), rb = $('rbtns'), inRace = !$('race').classList.contains('hide') && !matchMedia('(max-width:820px), (max-height:560px)').matches;
  if (inRace && b.parentNode !== rb) rb.insertBefore(b, rb.firstChild);
  else if (!inRace && b.parentNode !== document.body) document.body.appendChild(b);
}
new MutationObserver(placeBgm).observe($('race'), { attributes: true, attributeFilter: ['class'] });
matchMedia('(max-width:820px), (max-height:560px)').addEventListener('change', placeBgm);
bgmUI(); bgmPlay();

/* ---- 화면 전환 ---- */
let roomUnsub = null, listUnsub = null, lastStartAt = 0, savedPieces = null, roomSnap = null, lastSyncKey = undefined;
/* ---- 모바일: 좌/우 패널을 아래 시트로 바꾸고 탭으로 전환 (데스크톱에서는 CSS 가 무시) ---- */
let mobTab = 'left';
function setMobTab(tab) {
  mobTab = tab; $('editor').dataset.tab = tab;           // 'left' | 'right' | 'none'(둘 다 닫음)
  $('mtLeft').classList.toggle('on', tab === 'left'); $('mtRight').classList.toggle('on', tab === 'right');
  syncView();
}
$('presetsTitle').onclick = () => { $('left').classList.toggle('showPresets'); syncView(); };
$('mtLeft').onclick = () => setMobTab(mobTab === 'left' ? 'none' : 'left');          // 같은 탭을 다시 누르면 닫힘
$('mtRight').onclick = () => setMobTab(mobTab === 'right' ? 'none' : 'right');
$('xLeft').onclick = $('xRight').onclick = () => setMobTab('none');
/* 모바일: 참여 인원 / 시작 버튼은 방 정보 시트 밖의 고정 영역으로 옮기고, 데스크톱으로 돌아가면 원래 패널 자리로 되돌린다 */
const mqMobile = matchMedia('(max-width:820px), (max-height:560px)');
{
  const plist = $('plist'), startBox = $('startBox'), plNext = plist.nextSibling, sbNext = startBox.nextSibling, right = $('right'), leaveBtn = $('leaveBtn'), leaveRow = $('leaveRow');
  const relayout = () => {
    if (mqMobile.matches) { $('mobPlist').appendChild(plist); $('mobStart').appendChild(startBox); $('mobLeave').appendChild(leaveBtn); leaveRow.classList.add('hide'); }
    else { right.insertBefore(plist, plNext); right.insertBefore(startBox, sbNext); leaveRow.appendChild(leaveBtn); leaveRow.classList.remove('hide'); }
  };
  relayout(); mqMobile.addEventListener('change', relayout);
  new ResizeObserver(es => { for (const e of es) document.documentElement.style.setProperty('--mbh', Math.ceil(e.contentRect.height) + 'px'); syncView(); }).observe($('mobBottom'));
  new ResizeObserver(() => syncView()).observe($('left'));
}
function applyScreen() {
  const home = V.screen === 'home', host = V.role === 'host', editHost = host && !isFixedRoom();
  $('home').classList.toggle('hide', !home);
  $('editor').classList.toggle('hide', home);
  $('title').classList.toggle('hide', home);
  $('left').classList.toggle('hide', !editHost);
  $('startBox').classList.toggle('hide', !host);
  $('waitMsg').classList.toggle('hide', host || home);
  const spec = V.role === 'spectator';
  $('myCar').classList.toggle('hide', spec);
  $('waitMsg').textContent = spec ? '방장이 시작하면 경기를 볼 수 있어요…' : '방장이 시작하길 기다리는 중…';
  V.spin = editHost;                   // 방장은 코스를 만지기 시작하면 회전이 멈춘다
  controls.autoRotate = true; controls.autoRotateSpeed = 0.8;
  controls.mouseButtons.LEFT = canEdit() ? null : THREE.MOUSE.ROTATE;       // 방장이 아니면 왼쪽 드래그로 시점 회전
  controls.touches.ONE = canEdit() ? null : THREE.TOUCH.ROTATE;             // 터치도 마찬가지 (두 손가락: 확대/이동은 항상)
  $('editor').classList.toggle('noleft', !editHost); setMobTab(editHost ? mobTab : 'right');
  if (!editHost) { E.armed = null; E.tool = 'select'; E.selId = null; E.anchorMode = false; }
  recompute(false);
}

/* ---- 홈: 방 목록 ---- */
function showHome() {
  if (roomUnsub) { roomUnsub(); roomUnsub = null; }
  if (savedPieces) { pieces = JSON.parse(savedPieces); savedPieces = null; E.selId = null; E.armed = null; E.anchorMode = false; pushHist(); }
  V.screen = 'home'; V.role = null; V.code = null; roomSnap = null; roomRoster = null; lastSyncKey = undefined; setNight(false);
  applyScreen(); fitCamera(false, true);
  if (listUnsub) listUnsub();
  listUnsub = backend.subscribeRoomList(renderRoomList);
}
function renderRoomList(rows) {
  if (V.screen !== 'home') return;
  const fx = rows.find(r => r.code === FIXED_ROOM.code) || { code: FIXED_ROOM.code, players: 0, max: 3, status: 'lobby' };
  rows = [{ ...fx, fixed: true, title: FIXED_ROOM.title, night: false, hasCourse: true, courseName: '2026 윈터컵 코스', seqLen: PRESETS[FIXED_ROOM.course].length }, ...rows.filter(r => r.code !== FIXED_ROOM.code)];
  $('roomList').innerHTML = rows.length ? rows.map(r => {
    const full = r.players >= r.max, busy = r.status !== 'lobby' && !(r.fixed && !r.players);      // 고정 방이 빈 채로 '시작' 상태면 들어가면서 되돌린다
    const joinBtn = `<button class="btn go2" data-code="${r.code}" ${full || busy ? 'disabled' : ''}>${full ? '참여불가' : busy ? '진행 중' : '참여하기'}</button>`;
    const watchBtn = full ? `<button class="btn blue" data-watch="${r.code}" ${busy ? 'disabled' : ''} title="${busy ? '진행 중인 방은 관전할 수 없어요' : ''}">👀 관전하기</button>` : '';
    return `<div class="crow"><div><b>${esc(r.title || r.hostName + '의 방')}</b>${r.night ? ' <span class="nightTag">🌙 밤</span>' : ''}<br><span class="hint">방장 ${r.fixed && !r.players ? '-' : esc(r.hostName)} · ${r.hasCourse ? `${esc(r.courseName || '커스텀 코스')} · 부품 ${r.seqLen}개` : '코스 만드는 중…'} · ${LAPS_FIXED}랩 · ${r.players}/${r.max}명</span></div>
      <div class="row" style="margin:0;flex-wrap:nowrap">${watchBtn}${joinBtn}</div></div>`;
  }).join('') : '<div class="hint empty" style="padding:10px 0">열려 있는 방이 없어요. 방을 만들어 보세요!</div>';
  $('roomList').querySelectorAll('[data-watch]').forEach(b => b.onclick = async () => {
    bgmPlay();
    try { enterRoom(await backend.spectateRoom(b.dataset.watch), 'spectator'); } catch (e) { toast(e.message); }
  });
  $('roomList').querySelectorAll('[data-code]').forEach(b => b.onclick = async () => {
    bgmPlay();
    try { enterRoom(await backend.joinRoom(b.dataset.code, myPayload()), 'guest'); } catch (e) { toast(e.message); }
  });
}
$('nick').value = backend.userSync().name;
$('nick').onchange = async () => { const u = await backend.setName($('nick').value); $('nick').value = u.name; };
/** 방 만들기: 방 제목을 입력받는 팝업 → 확인하면 방을 만들고 입장 */
function showCreateRoom() {
  const u = backend.userSync(), def = `${u.name}의 방`;
  let tod = 'day';                     // 기본은 항상 낮
  openModal('방 만들기', `<div class="hint" style="margin:0 0 10px">친구들이 방 목록에서 보게 될 방 제목을 입력하세요.</div>
    <div class="rtRow"><input id="rtInput" class="rtinput" maxlength="20" placeholder="${esc(def)}" autocomplete="off">
      <button type="button" class="todSw" id="todSw" role="switch"><span class="lb"></span><span class="tk"></span></button></div>
    <div class="row" style="margin-top:16px;flex-wrap:nowrap;gap:10px"><button class="btn green big half" id="rtOk"><span class="plus">＋</span>방 만들기</button><button class="btn big half" id="rtCancel">취소</button></div>
    <div class="hint" id="rtErr" style="color:#ff8d8d"></div>`);
  const input = $('rtInput'); input.focus();
  const todUI = () => { const sw = $('todSw'), n = tod === 'night'; sw.classList.toggle('on', n); sw.setAttribute('aria-checked', n); sw.title = n ? '밤 레이스 (누르면 낮)' : '낮 레이스 (누르면 밤)'; sw.querySelector('.tk').textContent = n ? '☾' : '☀'; sw.querySelector('.lb').textContent = n ? '밤' : '낮'; };
  $('todSw').onclick = () => { tod = tod === 'night' ? 'day' : 'night'; todUI(); };
  todUI();
  const go = async () => {
    $('rtOk').disabled = true;
    try { const s = await backend.createRoom({ title: input.value.trim() || def, laps: LAPS_FIXED, night: tod === 'night', ...myPayload() }); closeModal(); enterRoom(s, 'host'); }
    catch (e) { $('rtErr').textContent = e.message; $('rtOk').disabled = false; }
  };
  $('rtOk').onclick = go; $('rtCancel').onclick = closeModal;
  input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
}
$('makeRoom').onclick = () => { bgmPlay(); showCreateRoom(); };

/* ---- 방 ---- */
function enterRoom(s, role) {
  if (listUnsub) { listUnsub(); listUnsub = null; }
  const fixed = s.code === FIXED_ROOM.code;
  if (fixed && role !== 'spectator') role = s.hostUid === backend.userSync().uid ? 'host' : 'guest';
  statusKey = null; hideCenterPop(); mobTab = role === 'host' && !fixed ? 'left' : 'right';
  V.screen = 'room'; V.role = role; V.code = s.code; roomSnap = s; lastStartAt = 0; pendingClose = false; lastSyncKey = undefined;
  if (fixed) {                      // 고정 방: 내 편집 코스는 보관하고 윈터컵 코스로
    savedPieces = JSON.stringify(pieces); loadSeq(PRESETS[FIXED_ROOM.course], false);
  } else if (role !== 'host') {            // 방장이 만든 코스를 그대로 보여주기 위해 내 편집 중인 코스는 잠시 보관
    savedPieces = JSON.stringify(pieces); pieces = []; E.selId = null; E.armed = null; E.anchorMode = false; pushHist();
  } else { E.tool = 'select'; E.armed = null; E.anchorMode = false; }
  $('rTitle').textContent = roomTitleOf(s); $('startErr').textContent = ''; setNight(s.night);
  resetStartChoice(); renderMyCar(); applyScreen(); fitCamera(false);
  roomUnsub = backend.subscribeRoom(s.code, onRoomSnap);
}
/** 방장: 코스가 완성/변경되면 방에 알려 참여자 화면에 반영 */
function onLoopChanged() {
  if (!(V.screen === 'room' && V.role === 'host' && V.code)) return;
  const key = loop.valid ? courseKey(loop.seq) : null;
  if (key !== lastSyncKey) { lastSyncKey = key; backend.setRoomCourse(V.code, loop.valid ? loop.seq : null); }
}
function onRoomSnap(s) {
  if (s.status === 'closed') { if (mode === 'build') { toast('방장이 방을 닫았어요'); showHome(); } else pendingClose = true; return; }
  roomSnap = s; setNight(s.night);
  if (isFixedRoom() && V.role !== 'spectator') {      // 고정 방: 방장이 바뀌면 시작 버튼을 넘겨받는다
    const want = s.hostUid === backend.userSync().uid ? 'host' : 'guest';
    if (want !== V.role) {
      V.role = want;
      if (mode === 'build') { resetStartChoice(); applyScreen(); }
      if (want === 'host') { toast('👑 방장이 되었어요! 시작 버튼으로 레이스를 시작할 수 있어요'); lastSyncKey = undefined; onLoopChanged(); }
    }
  }
  if (isFixedRoom()) { /* 코스는 항상 윈터컵: 방장의 코스를 따라 바꾸지 않는다 */ }
  else if (V.role !== 'host') {           // 방장 화면과 똑같이: 방장의 코스를 불러와서 보여준다
    if (s.seq && (!loop.valid || courseKey(loop.seq) !== courseKey(s.seq))) loadSeq(s.seq, false);
    else if (!s.seq && pieces.length) { pieces = []; recompute(false); }
  }
  if (s.status === 'starting' && s.startAt !== lastStartAt && mode === 'build') { lastStartAt = s.startAt; startFromRoom(s); return; }
  if (mode === 'build') renderRoomPanel(s);
}
const roomTitleOf = s => { const hp = (s.players || []).find(p => p.uid === s.hostUid); return (s.title || `${hp ? hp.name : '?'}의 방`) + (s.night ? ' 🌙' : ''); };     // 방 목록과 같은 제목
function renderRoomPanel(s) {
  const me = backend.userSync().uid, host = V.role === 'host';
  $('rTitle').textContent = roomTitleOf(s);
  $('rInfo').textContent = host ? (s.seq ? `부품 ${s.seq.length}개 · ${loop.valid ? loop.track.Ltot.toFixed(0) + 'm' : ''}` : '왼쪽에서 코스를 만들어 주세요')
    : (s.seq ? `부품 ${s.seq.length}개 · ${LAPS_FIXED}랩` : '방장이 코스를 만드는 중이에요…') + (s.spectators && s.spectators.length ? ` · 👀 관전 ${s.spectators.length}명` : '');
  if (V.role === 'spectator') $('rInfo').textContent = '👀 관전 중 · ' + $('rInfo').textContent;
  const ps = s.players.slice().sort((x, y) => x.lane - y.lane);
  $('plist').innerHTML = `<div class="pl-head"><span>참여 인원</span><span class="cnt">${ps.length}/3</span></div>`
    + ps.map(p => `<div class="pl-row ${p.uid === me ? 'me' : ''}"><span class="pl-no" title="${p.lane + 1}레인">${p.lane + 1}</span><div><div class="pl-name">${p.uid === s.hostUid ? '👑 ' : ''}${esc(p.name)}${p.uid === me ? '<span class="pl-me">나</span>' : ''}</div><div class="pl-sub">${mName(p.motor)} / ${tName(p.tire)}</div></div></div>`).join('')
    + Array.from({ length: 3 - ps.length }, () => '<div class="pl-empty">빈 자리</div>').join('');
  if (host && s.players.length > 1) resetStartChoice();       // 참여자가 들어오면 선택 창을 닫고 일반 시작으로
}
function resetStartChoice() { $('startBtn').classList.remove('hide'); $('startChoice').classList.add('hide'); }
$('leaveBtn').onclick = async () => { const code = V.code; if (roomUnsub) { roomUnsub(); roomUnsub = null; } if (code) await backend.leaveRoom(code); showHome(); };

/* ---- 시작 (방장) ---- */
$('startBtn').onclick = () => {
  if (!loop.valid || !roomSnap) return;
  $('startErr').textContent = '';
  if (roomSnap.players.length > 1) hostStart(false);                      // 참여자가 있으면 바로 시작 (AI 없음)
  else { $('startBtn').classList.add('hide'); $('startChoice').classList.remove('hide'); }   // 혼자면 혼자하기 / AI와 하기 선택
};
$('soloBtn').onclick = () => hostStart(false);
$('aiBtn').onclick = () => hostStart(true);
$('choiceCancel').onclick = resetStartChoice;
async function hostStart(ai) {
  resetStartChoice();
  try { await backend.setRoomCourse(V.code, loop.seq); await backend.startRoom(V.code, { ai }); }
  catch (e) { $('startErr').textContent = e.message; }
}
/** 방 스냅샷 → 참가자 목록. 모든 접속자가 같은 snap(seed)으로 만들므로 AI 도 동일하게 나온다. */
function rosterFromRoom(snap) {
  const me = backend.userSync().uid, r = rng(snap.seed), used = new Set(snap.players.map(p => p.lane));
  const players = snap.players.map(p => ({ name: p.name, motor: p.motor, tire: p.tire, kit: p.kit || null, lane: p.lane, speedMul: 1, uid: p.uid }));
  if (snap.fillAI) {                 // 혼자 + "AI와 하기" 일 때만 빈 레인을 AI 가 채운다
    const ai = ['AI 레드', 'AI 그린']; let k = 0;
    for (const lane of [0, 1, 2]) {
      if (used.has(lane)) continue;
      const kit = normalizeKit(KIT_PRESETS[1 + Math.floor(r() * (KIT_PRESETS.length - 1))].kit);      // AI 는 추천 세팅 중 하나 (키트 기본 제외)
      players.push({ name: ai[k++], motor: kit.motor, tire: kit.tire, kit, lane, speedMul: 0.97 + r() * 0.03 });
    }
  }
  players.forEach(p => { p.seed = ((snap.seed || 1) * 31 + p.lane * 7919 + 1) >>> 0; });     // 코너 흔들림 난수: 방 시드 + 레인 → 모든 접속자에서 같다
  players.sort((a, b) => (b.uid === me) - (a.uid === me) || a.lane - b.lane);   // 나를 0번(파란 차)으로
  return players;
}
function startFromRoom(snap) {
  closeModal();
  if (!loop.valid || courseKey(loop.seq) !== courseKey(snap.seq)) loadSeq(snap.seq, false);
  const remain = (snap.startAt - snap.serverNow) / 1000;
  startRace({ roster: rosterFromRoom(snap), laps: LAPS_FIXED, countT0: Math.max(0, Math.min(3.1, 3.2 - remain)) });
}
function loadSeq(seq, save) {
  pieces = layoutFromSeq(seq); E.selId = null; E.armed = null; E.anchorMode = false;
  if (save) commit(); else { pushHist(); recompute(false); }
  fitCamera(false);
}
/** 테스트/바로가기용: 홈을 건너뛰고 방을 만들어 혼자(또는 AI와) 바로 시작 */
async function quickStart(ai) {
  const s = await backend.createRoom({ laps: LAPS_FIXED, ...myPayload() });
  enterRoom(s, 'host'); await hostStart(ai);
}

/* ====================================================================
 *  메인 루프
 * ==================================================================== */
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (!carModel) return;
  applyKeyCam(dt);
  if (mode === 'build') {
    if (V.role === 'host' && V.spin && (E.armed || E.selId != null || E.drag)) V.spin = false;
    controls.autoRotate = V.screen === 'home' || V.role !== 'host' || V.spin;
    controls.update();
    sun.position.set(controls.target.x + 60, 110, controls.target.z + 40); sun.target.position.copy(controls.target);
    Object.assign(sun.shadow.camera, { left: -260, right: 260, top: 260, bottom: -260, far: 520 }); sun.shadow.camera.updateProjectionMatrix();
  } else {
    if (mode === 'countdown') {
      countT += dt; const c = Math.ceil(3.2 - countT);
      if (c !== lastCount) { lastCount = c; if (c > 0 && c <= 3) { $('center').textContent = c; beep(520); } else if (c <= 0) { $('center').textContent = 'GO!'; beep(1040, .5); mode = 'race'; cars.forEach(car => { car.v = launchSpeed(car, track); }); setTimeout(() => { $('center').textContent = ''; }, 900); } }
    }
    if (mode === 'race') {
      // 고정 시간 간격(1/120초) 시뮬레이션 — 프레임 속도와 무관하게 모든 접속자에서 같은 결과
      const H = 1 / 120; simAcc += dt * TIME_SCALE;
      let n = 0;
      while (simAcc >= H && n < 48) { simAcc -= H; raceT += H; n++; cars.forEach((c, i) => { stepCar(c, track, H, raceT, LAPS); if (c.events.length) handleEvents(c, i); }); }
      if (n >= 48) simAcc = 0;
      if (!resultShown && (cars.every(c => c.finished) || (finishAt && raceT - finishAt > 8 * TIME_SCALE))) showResult();
    }
    poseCars(dt); updateCamera(dt);
    { const sc = cars[selCar], under = camMode === 0 && laneCamMinY(sc) > -Infinity && laneLiftAt(sc, track, sc.s).lift < 0.5;
      bridgeMat.opacity += ((under ? 0.32 : 1) - bridgeMat.opacity) * Math.min(1, 6 * dt); bridgeMat.depthWrite = bridgeMat.opacity > 0.97; }
    if (msgT > 0) { msgT -= dt; if (msgT <= 0) $('msg').textContent = ''; }
    standTimer -= dt; if (standTimer <= 0) { updateStandings(); standTimer = 0.1; }
    const sc = cars[selCar]; $('spdV').textContent = Math.round(sc.v * KMH); $('spdName').textContent = `${sc.name} · ${sc.motor.name}`;
    const g = vis[selCar].group.position;
    if (camMode === 2) {
      sun.position.set(controls.target.x + 60, 140, controls.target.z + 40); sun.target.position.copy(controls.target);
      Object.assign(sun.shadow.camera, { left: -260, right: 260, top: 260, bottom: -260, far: 520 });
    } else {
      sun.position.set(g.x + 45, 90, g.z + 30); sun.target.position.set(g.x, 0, g.z);
      Object.assign(sun.shadow.camera, { left: -SH, right: SH, top: SH, bottom: -SH, far: 300 });
    }
    sun.shadow.camera.updateProjectionMatrix();
    if (actx && engGain) {
      engOsc.frequency.setTargetAtTime(60 + sc.v * 5, actx.currentTime, 0.05);
      engGain.gain.setTargetAtTime(muted || mode !== 'race' ? 0 : 0.03, actx.currentTime, 0.1);
    }
  }
  updateParticles(dt); skyTick(dt);
  renderer.render(scene, camera);
}

/* ====================================================================
 *  초기화
 * ==================================================================== */
new GLTFLoader().load('assets/minicar.glb', gltf => {
  carModel = gltf.scene; $('loading').style.display = 'none';
  pieces = loadInitial();
  const qs = new URLSearchParams(location.search);
  if (qs.get('course') && PRESETS[qs.get('course')]) pieces = layoutFromSeq(PRESETS[qs.get('course')]);
  pushHist(); recompute(false); showHome();
  if (qs.has('autostart')) setTimeout(async () => { await quickStart(qs.get('ai') === '1'); if (qs.get('cam')) setTimeout(() => setCamMode(+qs.get('cam')), 400); }, 300);
  window.__game = { camera, get look() { return { lookYaw, lookPitch, lookZoom }; }, get mode() { return mode; }, get pieces() { return pieces; }, get loop() { return loop; }, get screen() { return V; }, get cars() { return cars; }, get groups() { return { layoutGroup, trackGroup, pieceGroups }; }, get scene() { return scene; }, get controls() { return controls; },  E, startRace, toEditor, recompute, quickStart, toScreen(x, z) { const v = new THREE.Vector3(x, 0, z).project(camera), r = canvas.getBoundingClientRect(); return { x: (v.x + 1) / 2 * r.width + r.left, y: (1 - v.y) / 2 * r.height + r.top }; } };
}, undefined, err => { $('loading').textContent = '모델 로드 실패: ' + err.message; });
requestAnimationFrame(frame);
