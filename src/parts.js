// 미니카 커스텀: 부품 카탈로그 · 세팅(kit) → 주행 성능 계산 · 타미야 공식 규정 검사 (three.js 의존 없음)
//
// 타미야 미니4WD 공식 레이스 규정 (tamiya.com/english/mini4wd/regulation.htm, 2025.12 기준)
//   전폭 105mm 이하(롤러 포함) · 전고 70mm 이하 · 전장 165mm 이하 · 최저지상고 1mm 이상
//   중량 90g 이상(배터리·모터 포함) · 타이어 지름 22~35mm, 폭 8~26mm · 롤러 개수/지름 제한 없음
//   회전형 매스댐퍼 장착 위치 제한 없음 · 타이어 표면 재질 변경 금지 · 4WD 유지
//
// 게임 단위: 속도는 시뮬레이션 단위(×0.5 = km/h), 길이·무게는 실제 mm / g.

/* ---------------------------------------------------------------- 부품 카탈로그 */
/* 모터 등급이 올라갈수록 최고속도와 가속이 함께 크게 오른다. 빠른 모터는 코너 한계를 넘기 쉬워서 코스아웃 위험도 같이 커진다. */
export const MOTORS = [
  { id: 'torque', name: '토크 튠',    vmax: 44, acc: 22, desc: '느리지만 안정적' },
  { id: 'hyper',  name: '하이퍼 대시', vmax: 56, acc: 30, desc: '균형형' },
  { id: 'power',  name: '파워 대시',  vmax: 63, acc: 35, desc: '힘 좋은 가속형' },
  { id: 'atomic', name: '아토믹 튠',  vmax: 70, acc: 40, desc: '빠름 — 코너 주의' },
  { id: 'mach',   name: '마하 대시',  vmax: 90, acc: 54, desc: '최고속 — 코스아웃 위험' },
];
/* 타이어 컴파운드: grip = 롤러 없이 타이어만으로 코너를 도는 한계, mul = 직선 속도 배율, wall = 벽을 타고 돌 때 마찰 배율
 * 코너: 타이어 그립 한계(vc)까지는 벽에 닿지 않고 돈다. 그 이상은 롤러가 벽을 타며 감속(wall)하고, 코스아웃 한계는 롤러 세팅(hold)이 정한다.
 * 실제처럼 그립이 강한 타이어는 벽에서 버텨 차가 벽을 타고 오르기 쉽고(hold↓), 미끄러운 타이어는 벽을 따라 매끄럽게 돈다. */
export const TIRES = [
  { id: 'soft', name: '소프트',       grip: 190, mul: 0.96,  wall: 1.3,  hold: -0.08, desc: '그립↑ — 저속 코너 강함, 벽에 걸려 튀기 쉬움' },
  { id: 'mid',  name: '미디엄',       grip: 135, mul: 0.985, wall: 1.0,  hold: 0,     desc: '무난한 기본 타이어' },
  { id: 'hard', name: '하드',         grip: 90,  mul: 1.0,   wall: 0.85, hold: 0.03,  desc: '그립↓ 직선↑ — 롤러로 돌리는 세팅' },
  { id: 'low',  name: '로우 프릭션',  grip: 60,  mul: 1.015, wall: 0.7,  hold: 0.05,  desc: '벽을 미끄러지듯 돈다 — 롤러 세팅 필수' },
];
export const WALL_G = 135;           // 롤러로 벽을 탈 때의 기준 횡가속 (키트 기본 = 미디엄 타이어 그립과 같아서 예전 밸런스 유지)

/** 슬롯별 선택지. stat 은 deriveSpec 이 읽는 값 */
export const PARTS = {
  gear: [
    { id: 'g50', name: '5:1 초기 기어',      v: 0.88, a: 1.18, desc: '가속 최강, 최고속 낮음' },
    { id: 'g42', name: '4.2:1 기본 기어',    v: 1.0,  a: 1.0,  desc: '키트 기본' },
    { id: 'g40', name: '4:1 기어',           v: 1.03, a: 0.96, desc: '약간 최고속 쪽' },
    { id: 'g37', name: '3.7:1 하이스피드',   v: 1.07, a: 0.91, desc: '최고속↑ 가속↓' },
    { id: 'g35', name: '3.5:1 초속 기어',    v: 1.11, a: 0.86, desc: '최고속 최강, 출발·오르막 약함' },
  ],
  dia: [   // 소경은 가속, 대경은 최고속 (공식 셋업 가이드). 대경은 무게중심이 높아 착지가 튀고 벽을 타기 쉽다
    { id: 'd24', name: '소경 24mm',  mm: 24, w: 7,  v: 0.95, a: 1.07, hold: 0.03,  rest: -0.03, desc: '가속↑ 무게중심↓' },
    { id: 'd26', name: '중경 26mm',  mm: 26, w: 8,  v: 1.0,  a: 1.0,  hold: 0,     rest: 0,     desc: '기본 지름' },
    { id: 'd31', name: '대경 31mm',  mm: 31, w: 11, v: 1.08, a: 0.88, hold: -0.05, rest: 0.05,  desc: '최고속↑ 무게중심↑' },
  ],
  roller: [ // hold: 코너에서 벽을 버티는 힘(코스아웃 한계 배율 가산), fric: 벽을 타고 돌 때 감속 계수, w: 개당 무게(g)
    { id: 'p9',  name: '9mm 플라스틱 롤러',            mm: 9,  w: 0.5, hold: 0,    fric: 3.0, desc: '키트 기본 — 마찰 큼' },
    { id: 'a13', name: '13mm 알루미 베어링 롤러',       mm: 13, w: 1.4, hold: 0.06, fric: 1.8, desc: '베어링으로 마찰↓' },
    { id: 'a17', name: '17mm 알루미 베어링 롤러',       mm: 17, w: 1.8, hold: 0.10, fric: 1.7, desc: '지름↑ 벽 넘기 어려움' },
    { id: 'a19', name: '19mm 알루미 베어링 롤러',       mm: 19, w: 2.1, hold: 0.13, fric: 1.6, desc: '가장 크고 매끄러움' },
    { id: 'r19', name: '19mm 플라스틱 링 롤러',         mm: 19, w: 2.4, hold: 0.17, fric: 2.0, desc: '벽 충격 흡수 — 안정 최강' },
  ],
  rlay: [
    { id: 'f2r2', name: '앞2 · 뒤2 (4개)',         n: 4, hold: 0,    fric: 1.0,  desc: '기본 배치' },
    { id: 'f2r4', name: '앞2 · 뒤2단 (6개)',       n: 6, hold: 0.08, fric: 1.07, desc: '뒤가 벽을 덜 탄다' },
    { id: 'f4r4', name: '앞뒤 2단 (8개)',           n: 8, hold: 0.14, fric: 1.14, desc: '벽 타기 최소, 무겁고 마찰↑' },
  ],
  plate: [ // span: 좌우 롤러 중심 사이 거리(mm) → 전폭 = span + 롤러 지름. len: 전장 증가(mm)
    { id: 'std',    name: '기본 스테이',          span: 78, len: 2,  w: 3, hold: 0,    desc: '폭이 좁아 규정 여유' },
    { id: 'frp',    name: 'FRP 와이드 플레이트',  span: 85, len: 8,  w: 5, hold: 0.05, desc: '폭↑ 코너 안쪽 주행' },
    { id: 'carbon', name: '카본 와이드 플레이트', span: 88, len: 10, w: 4, hold: 0.08, desc: '가볍고 단단함 — 큰 롤러는 규정 초과 주의' },
  ],
  damper: [ // rest: 착지 반발 계수 감소량 (클수록 덜 튐)
    { id: 'none',   name: '없음',                     w: 0,  rest: 0,    hold: 0,    desc: '가볍지만 점프 착지가 튄다' },
    { id: 'side',   name: '사이드 매스댐퍼 (경량)',   w: 6,  rest: 0.10, hold: 0,    desc: '가볍게 반발 감소' },
    { id: 'heavy',  name: '사이드 매스댐퍼 (헤비)',   w: 12, rest: 0.19, hold: 0.02, desc: '착지 안정 최강, 무겁다' },
    { id: 'rotary', name: '회전형 매스댐퍼 (리어)',   w: 9,  rest: 0.15, hold: 0.04, desc: '착지 + 코너 흔들림 흡수' },
  ],
  brake: [ // k: 경사로에서의 감속 강도, drop: 스펀지가 차체 바닥보다 내려오는 높이(mm, 지상고 감소)
    { id: 'none', name: '없음',               k: 0,   drop: 0,   w: 0, desc: '감속 없음 — 점프에서 날아가기 쉽다' },
    { id: 'b1',   name: '브레이크 스펀지 (약)', k: 0.3, drop: 0.5, w: 1, desc: '내리막·점프대에서 살짝 감속' },
    { id: 'b2',   name: '브레이크 스펀지 (중)', k: 0.6, drop: 1.0, w: 1, desc: '점프 진입 속도 안정' },
    { id: 'b3',   name: '브레이크 스펀지 (강)', k: 1.0, drop: 1.5, w: 1, desc: '강한 감속 — 느린 모터는 점프 실패' },
  ],
  body: [
    { id: 'std',   name: '표준 플라스틱 바디',      w: 14, hold: 0,    h: 40, desc: '튼튼한 기본 바디' },
    { id: 'light', name: '경량 폴리카보네이트 바디', w: 7,  hold: 0.03, h: 38, desc: '가볍고 무게중심↓' },
  ],
};

/** 커스텀 화면 구성: 그룹 → 슬롯 */
export const SLOTS = [
  { key: 'motor',  group: 'power',  label: '모터' },
  { key: 'gear',   group: 'power',  label: '기어비' },
  { key: 'tire',   group: 'tire',   label: '타이어 컴파운드' },
  { key: 'dia',    group: 'tire',   label: '타이어 지름' },
  { key: 'roller', group: 'roller', label: '롤러' },
  { key: 'rlay',   group: 'roller', label: '롤러 배치' },
  { key: 'plate',  group: 'roller', label: '스테이 / 플레이트' },
  { key: 'damper', group: 'stable', label: '매스댐퍼' },
  { key: 'brake',  group: 'stable', label: '브레이크' },
  { key: 'body',   group: 'stable', label: '바디' },
];
export const GROUPS = [
  { id: 'power',  label: '⚡ 구동' },
  { id: 'tire',   label: '🛞 타이어' },
  { id: 'roller', label: '⚙️ 롤러' },
  { id: 'stable', label: '🪂 안정' },
];
export const slotList = key => (key === 'motor' ? MOTORS : key === 'tire' ? TIRES : PARTS[key]);
export const partOf = (kit, key) => slotList(key).find(x => x.id === kit[key]);

export const DEFAULT_KIT = { motor: 'hyper', gear: 'g42', tire: 'mid', dia: 'd26', roller: 'p9', rlay: 'f2r2', plate: 'std', damper: 'none', brake: 'none', body: 'std' };
const ORDER = SLOTS.map(s => s.key);

/** 저장/동기화된 값 → 올바른 kit (모르는 값은 기본값). 예전 {motor, tire} 만 있는 세팅도 그대로 받아들인다 */
export function normalizeKit(k) {
  if (typeof k === 'string') k = decodeKit(k);
  const out = {};
  for (const key of ORDER) { const v = k && k[key]; out[key] = slotList(key).some(x => x.id === v) ? v : DEFAULT_KIT[key]; }
  return out;
}
/** 방 동기화용 짧은 문자열: "hyper.g42.mid.d26.p9.f2r2.std.none.none.std" */
export const encodeKit = k => ORDER.map(key => normalizeKit(k)[key]).join('.');
export function decodeKit(s) { const a = String(s || '').split('.'), o = {}; ORDER.forEach((key, i) => { o[key] = a[i]; }); return o; }

/** 추천 세팅 (AI 와 '추천 세팅' 버튼이 쓴다) */
export const KIT_PRESETS = [
  { name: '키트 기본',   desc: '처음 조립한 그대로',                kit: { ...DEFAULT_KIT } },
  { name: '밸런스',      desc: '어느 코스나 무난하게',              kit: { motor: 'power',  gear: 'g42', tire: 'mid',  dia: 'd26', roller: 'a13', rlay: 'f2r4', plate: 'frp',    damper: 'side',   brake: 'b1',   body: 'std' } },
  { name: '코너 특화',   desc: '코너가 많은 테크니컬 코스 · 전폭 105mm 꽉 채움', kit: { motor: 'atomic', gear: 'g37', tire: 'soft', dia: 'd26', roller: 'a17', rlay: 'f2r4', plate: 'carbon', damper: 'rotary', brake: 'b1',   body: 'light' } },
  { name: '점프 안정',   desc: '점프·슬로프에서 튀지 않게',          kit: { motor: 'atomic', gear: 'g42', tire: 'mid',  dia: 'd26', roller: 'a17', rlay: 'f2r4', plate: 'frp',    damper: 'heavy',  brake: 'b2',   body: 'std' } },
  { name: '풀 스피드',   desc: '마하 대시 + 최강 롤러 (고수용)',     kit: { motor: 'mach',   gear: 'g42', tire: 'hard', dia: 'd26', roller: 'r19', rlay: 'f4r4', plate: 'frp',    damper: 'heavy',  brake: 'b2',   body: 'light' } },
];

/* ---------------------------------------------------------------- 성능 계산 */
export const M_REF = 125;            // 키트 기본 세팅의 무게(g). 이 무게일 때 모터 가속이 표에 적힌 값
const BASE_W = { chassis: 32, battery: 46, motor: 17, brakeMount: 0 };   // 섀시+기어+샤프트 / AA 알칼리 2개 / 모터
export const REST_BASE = 0.55;       // 매스댐퍼 없을 때 착지 반발 계수
export const FLY_BASE = 1.3;         // 키트 기본 롤러일 때 코너 코스아웃 한계 (타이어 한계속도의 배수)

export function deriveSpec(kitIn) {
  const kit = normalizeKit(kitIn), P = key => partOf(kit, key);
  const mo = P('motor'), ge = P('gear'), ti = P('tire'), di = P('dia'), ro = P('roller'), rl = P('rlay'), pl = P('plate'), da = P('damper'), br = P('brake'), bo = P('body');
  const mass = BASE_W.chassis + BASE_W.battery + BASE_W.motor + di.w + ro.w * rl.n + pl.w * 2 + da.w + br.w + bo.w;
  const massA = Math.pow(M_REF / mass, 0.8), massV = Math.pow(M_REF / mass, 0.12);
  const vmax = mo.vmax * ge.v * di.v * ti.mul * massV;
  const acc = mo.acc * ge.a * di.a * massA;
  const hold = FLY_BASE + ro.hold + rl.hold + pl.hold + da.hold + di.hold + bo.hold + ti.hold;
  const fric = ro.fric * rl.fric * ti.wall;
  const rest = Math.max(0.2, REST_BASE - da.rest + di.rest);
  const width = pl.span + ro.mm, length = 146 + pl.len, height = bo.h + (di.mm - 26) / 2 + 2;
  const chassisClear = di.mm / 2 - 10.5, clear = chassisClear - br.drop;
  return {
    kit, mass, vmax, acc, grip: ti.grip, hold, fric, rest, brakeK: br.k,
    width, length, height, clear, tireMM: di.mm, tireW: 11,
    motor: mo, tire: ti,
    // 넓은 차는 코너에서 레인 안쪽을 돌아 경로가 짧아진다 (공식 셋업 가이드). 1 레인폭 5 단위 ≈ 115mm
    wideIn: Math.max(0, (width - 92)) / 23 * 0.5,
  };
}

/** 공식 규정 검사 → [{ key, label, value, unit, rule, ok }] */
export function checkRegs(sp) {
  const r = (key, label, value, unit, rule, ok) => ({ key, label, value, unit, rule, ok });
  return [
    r('width',  '전폭 (롤러 포함)', sp.width,  'mm', '105mm 이하',  sp.width <= 105),
    r('length', '전장',             sp.length, 'mm', '165mm 이하',  sp.length <= 165),
    r('height', '전고',             sp.height, 'mm', '70mm 이하',   sp.height <= 70),
    r('clear',  '최저지상고',       sp.clear,  'mm', '1mm 이상',    sp.clear >= 1 - 1e-9),
    r('mass',   '중량 (배터리 포함)', sp.mass, 'g',  '90g 이상',    sp.mass >= 90),
    r('tire',   '타이어 지름',      sp.tireMM, 'mm', '22~35mm',     sp.tireMM >= 22 && sp.tireMM <= 35),
  ];
}
export const isLegal = sp => checkRegs(sp).every(x => x.ok);

/** 화면 표시용 0~100 점수 (대략적인 비교용) */
export function ratings(sp) {
  const cl = (x, a, b) => Math.round(Math.max(0, Math.min(1, (x - a) / (b - a))) * 100);
  return {
    speed: cl(sp.vmax, 38, 100),
    accel: cl(sp.acc, 16, 64),
    corner: cl(Math.sqrt(WALL_G * 15) * sp.hold, 50, 85),       // 안쪽 레인 45° 코너에서 롤러로 버틸 수 있는 속도
    jump: cl(0.6 - sp.rest + sp.brakeK * 0.12, 0, 0.55),
    light: cl(170 - sp.mass, 0, 60),
  };
}
