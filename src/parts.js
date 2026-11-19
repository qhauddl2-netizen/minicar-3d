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
  { id: 'normal', name: '노멀 모터',  vmax: 31, acc: 17, desc: '키트 동봉 기본 모터 — 아주 느림, 점프는 힘들다' },
  { id: 'torque', name: '토크 튠',    vmax: 41, acc: 24, desc: '느리지만 안정적' },
  { id: 'hyper',  name: '하이퍼 대시', vmax: 47, acc: 26, desc: '키트 기본 · 균형형' },
  { id: 'power',  name: '파워 대시',  vmax: 54, acc: 31, desc: '힘 좋은 가속형' },
  { id: 'atomic', name: '아토믹 튠',  vmax: 61, acc: 36, desc: '빠름 — 코너 주의' },
  { id: 'mach',   name: '마하 대시',  vmax: 74, acc: 44, desc: '최고속 — 코스아웃 위험' },
];
/* 타이어 컴파운드: grip = 롤러 없이 타이어만으로 코너를 도는 한계, mul = 직선 속도 배율, wall = 벽을 타고 돌 때 마찰 배율
 * 코너: 타이어 그립 한계(vc)까지는 벽에 닿지 않고 돈다. 그 이상은 롤러가 벽을 타며 감속(wall)하고, 코스아웃 한계는 롤러 세팅(hold)이 정한다.
 * 실제처럼 그립이 강한 타이어는 벽에서 버텨 차가 벽을 타고 오르기 쉽고(q↓), 미끄러운 타이어는 벽을 따라 매끄럽게 돈다. */
export const TIRES = [
  { id: 'soft', name: '소프트',       grip: 190, mul: 0.95,  wall: 1.3,  q: 0.90, desc: '그립↑ — 저속 코너 강함, 벽에 걸려 튀기 쉬움' },
  { id: 'mid',  name: '미디엄',       grip: 135, mul: 0.98,  wall: 1.0,  q: 1.0,   desc: '무난한 기본 타이어' },
  { id: 'hard', name: '하드',         grip: 90,  mul: 1.0,   wall: 0.85, q: 1.03,  desc: '그립↓ 직선↑ — 롤러로 돌리는 세팅' },
  { id: 'low',  name: '로우 프릭션',  grip: 60,  mul: 1.02,  wall: 0.7,  q: 1.05,  desc: '벽을 미끄러지듯 돈다 — 롤러 세팅 필수' },
];
export const WALL_G = 135;           // 롤러로 벽을 탈 때의 기준 횡가속 (키트 기본 = 미디엄 타이어 그립과 같아서 예전 밸런스 유지)

/** 슬롯별 선택지. stat 은 deriveSpec 이 읽는 값 */
export const PARTS = {
  gear: [
    { id: 'g50', name: '5:1 초기 기어',      v: 0.85, a: 1.25, desc: '가속 최강, 최고속 낮음' },
    { id: 'g42', name: '4.2:1 기본 기어',    v: 1.0,  a: 1.0,  desc: '키트 기본' },
    { id: 'g40', name: '4:1 기어',           v: 1.04, a: 0.95, desc: '약간 최고속 쪽' },
    { id: 'g37', name: '3.7:1 하이스피드',   v: 1.09, a: 0.89, desc: '최고속↑ 가속↓' },
    { id: 'g35', name: '3.5:1 초속 기어',    v: 1.14, a: 0.83, desc: '최고속 최강, 출발·오르막 약함' },
  ],
  bearing: [ // 구동계 마찰: 키트의 플라스틱 부싱 → 볼베어링으로 바꾸면 같은 모터로도 눈에 띄게 빨라진다 (실제 첫 업그레이드)
    { id: 'bush',  name: '플라스틱 부싱',            w: 0,   v: 1.0,  a: 1.0,  desc: '키트 기본 — 마찰이 커서 느리다' },
    { id: 'b1150', name: '1150 볼베어링 (휠)',        w: 1.2, v: 1.07, a: 1.03, desc: '바퀴 회전 마찰↓' },
    { id: 'b620',  name: '620 볼베어링 + 기어 베어링', w: 2.2, v: 1.12, a: 1.06, desc: '휠·카운터기어까지 베어링 — 최고 효율' },
  ],
  dia: [   // 소경은 가속, 대경은 최고속 (공식 셋업 가이드). 대경은 차 전체가 올라가 무게중심이 높아지고 착지가 튄다
    { id: 'd24', name: '소경 24mm',  mm: 24, w: 7,  v: 0.93, a: 1.10, rest: -0.03, desc: '가속↑ 무게중심↓' },
    { id: 'd26', name: '중경 26mm',  mm: 26, w: 8,  v: 1.0,  a: 1.0,  rest: 0,     desc: '기본 지름' },
    { id: 'd31', name: '대경 31mm',  mm: 31, w: 11, v: 1.10, a: 0.86, rest: 0.05,  desc: '최고속↑ 무게중심↑' },
  ],
  roller: [ // q: 벽을 매끄럽게 타는 정도(벽 타기 한계 배율), fric: 벽을 타고 돌 때 감속 계수, w: 개당 무게(g)
    { id: 'p9',  name: '9mm 플라스틱 롤러',            mm: 9,  w: 0.5, q: 0.95, fric: 3.0, desc: '키트 기본 — 마찰 큼' },
    { id: 'a13', name: '13mm 알루미 베어링 롤러',       mm: 13, w: 1.4, q: 1.0,  fric: 1.8, desc: '베어링으로 마찰↓' },
    { id: 'a17', name: '17mm 알루미 베어링 롤러',       mm: 17, w: 1.8, q: 1.03, fric: 1.7, desc: '지름↑ 벽 넘기 어려움' },
    { id: 'a19', name: '19mm 알루미 베어링 롤러',       mm: 19, w: 2.1, q: 1.05, fric: 1.6, desc: '가장 크고 매끄러움' },
    { id: 'r19', name: '19mm 플라스틱 링 롤러',         mm: 19, w: 2.4, q: 1.08, fric: 2.0, desc: '벽 충격 흡수 — 안정 최강' },
  ],
  rlay: [
    { id: 'f2r2', name: '앞2 · 뒤2 (4개)',         n: 4, fric: 1.0,  desc: '기본 배치' },
    { id: 'f2r4', name: '앞2 · 뒤2단 (6개)',       n: 6, fric: 1.07, desc: '뒤 윗단 롤러가 벽을 받쳐 접점↑' },
    { id: 'f4r4', name: '앞뒤 2단 (8개)',           n: 8, fric: 1.14, desc: '앞뒤 모두 윗단 — 벽 타기 최소, 무겁고 마찰↑' },
  ],
  rheight: [ // 롤러 높이(mm, 지면 기준 · 26mm 타이어일 때). 무게중심에 가까울수록 코너에서 차가 바깥으로 기울지 않는다
    { id: 'low',  name: '낮게 (7mm)',  h: 7,  desc: '키트 기본 — 무게중심보다 한참 낮아 코너에서 바깥으로 기운다' },
    { id: 'mid',  name: '중간 (11mm)', h: 11, desc: '무게중심 가까이 — 벽 타기↓' },
    { id: 'high', name: '높게 (15mm)', h: 15, desc: '코너 최강 — 롤러 무게가 위로 가고, 점프 착지 때 벽을 넘기 쉽다' },
  ],
  plate: [ // span: 좌우 롤러 중심 사이 거리(mm) → 전폭 = span + 롤러 지름. len: 전장 증가(mm)
    { id: 'std',    name: '기본 스테이',          span: 78, len: 2,  w: 3, q: 1.0,  desc: '폭이 좁아 규정 여유' },
    { id: 'frp',    name: 'FRP 와이드 플레이트',  span: 85, len: 8,  w: 5, q: 1.03, desc: '폭↑ 코너 안쪽 주행' },
    { id: 'carbon', name: '카본 와이드 플레이트', span: 88, len: 10, w: 4, q: 1.05, desc: '가볍고 단단함 — 큰 롤러는 규정 초과 주의' },
  ],
  damper: [ // rest: 착지 반발 계수 감소량 (클수록 덜 튐), cg: 장착 높이(차축 기준 mm) — 사이드는 낮게 달려 무게중심을 낮춘다
    { id: 'none',   name: '없음',                     w: 0,  rest: 0,    cg: 0,  desc: '가볍지만 점프 착지가 튄다' },
    { id: 'side',   name: '사이드 매스댐퍼 (경량)',   w: 6,  rest: 0.10, cg: -6, desc: '반발 감소 · 낮게 달려 무게중심↓' },
    { id: 'heavy',  name: '사이드 매스댐퍼 (헤비)',   w: 12, rest: 0.19, cg: -6, desc: '착지 안정 최강 · 무게중심↓↓ · 무겁다' },
    { id: 'rotary', name: '회전형 매스댐퍼 (리어)',   w: 9,  rest: 0.15, cg: 3,  desc: '착지 + 코너 흔들림 흡수 (조금 높게 달림)' },
  ],
  brake: [ // k: 경사로에서의 감속 강도, drop: 스펀지가 차체 바닥보다 내려오는 높이(mm, 지상고 감소)
    { id: 'none', name: '없음',               k: 0,   drop: 0,   w: 0, desc: '감속 없음 — 점프에서 날아가기 쉽다' },
    { id: 'b1',   name: '브레이크 스펀지 (약)', k: 0.3, drop: 0.5, w: 1, desc: '내리막·점프대에서 살짝 감속' },
    { id: 'b2',   name: '브레이크 스펀지 (중)', k: 0.6, drop: 1.0, w: 1, desc: '점프 진입 속도 안정' },
    { id: 'b3',   name: '브레이크 스펀지 (강)', k: 1.0, drop: 1.5, w: 1, desc: '강한 감속 — 느린 모터는 점프 실패' },
  ],
  body: [
    { id: 'std',   name: '표준 플라스틱 바디',      w: 14, cg: 15, h: 40, desc: '튼튼한 기본 바디' },
    { id: 'light', name: '경량 폴리카보네이트 바디', w: 7,  cg: 13, h: 38, desc: '가볍고 무게중심↓' },
  ],
};

/** 커스텀 화면 구성: 그룹 → 슬롯 */
export const SLOTS = [
  { key: 'motor',  group: 'power',  label: '모터' },
  { key: 'gear',   group: 'power',  label: '기어비' },
  { key: 'bearing', group: 'power', label: '베어링' },
  { key: 'tire',   group: 'tire',   label: '타이어 컴파운드' },
  { key: 'dia',    group: 'tire',   label: '타이어 지름' },
  { key: 'roller', group: 'roller', label: '롤러' },
  { key: 'rlay',   group: 'roller', label: '롤러 배치' },
  { key: 'rheight', group: 'roller', label: '롤러 높이' },
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

export const DEFAULT_KIT = { motor: 'normal', gear: 'g42', bearing: 'bush', tire: 'mid', dia: 'd26', roller: 'p9', rlay: 'f2r2', plate: 'std', damper: 'none', brake: 'none', body: 'std', rheight: 'low' };
// 동기화 문자열 순서: 새 슬롯은 항상 맨 뒤에 붙인다 (예전 문자열도 그대로 읽히게)
const ORDER = ['motor', 'gear', 'tire', 'dia', 'roller', 'rlay', 'plate', 'damper', 'brake', 'body', 'bearing', 'rheight'];

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

/* ---------------------------------------------------------------- 해금 (레이스 완주 횟수)
 * 미니카 커스텀 화면 자체는 GARAGE_UNLOCK 회 완주 후 열리고, 부품은 5회부터 단계적으로 열린다.
 * 처음에는 키트에 든 부품만 쓸 수 있고, 레이스를 끝낼 때마다 단계적으로 상위 부품이 열린다.
 * 쉬운 업그레이드(기어·타이어·베어링)는 일찍, 강한 부품(아토믹/마하 대시, 2단 롤러, 카본, 링 롤러)은 늦게. 키트 기본 부품은 모두 0. */
export const GARAGE_UNLOCK = 3;      // 미니카 커스텀 버튼이 열리는 레이스 완주 횟수
const UNLOCK = {
  motor:   { normal: 0, torque: 0, hyper: 0, power: 6, atomic: 9, mach: 14 },
  gear:    { g42: 0, g50: 5, g40: 5, g37: 8, g35: 12 },
  bearing: { bush: 0, b1150: 5, b620: 9 },
  tire:    { mid: 0, soft: 5, hard: 5, low: 9 },
  dia:     { d26: 0, d24: 5, d31: 7 },
  roller:  { p9: 0, a13: 6, a17: 8, a19: 11, r19: 14 },
  rlay:    { f2r2: 0, f2r4: 7, f4r4: 11 },
  rheight: { low: 0, mid: 6, high: 10 },
  plate:   { std: 0, frp: 7, carbon: 10 },
  damper:  { none: 0, side: 6, rotary: 8, heavy: 10 },
  brake:   { none: 0, b1: 5, b2: 7, b3: 10 },
  body:    { std: 0, light: 7 },
};
/** 이 부품을 쓰려면 필요한 레이스 완주 횟수 */
export const unlockOf = (key, id) => (UNLOCK[key] && UNLOCK[key][id]) || 0;
/** 세팅 전체를 쓰려면 필요한 횟수 (가장 늦게 열리는 부품 기준) */
export const kitUnlock = kit => { const k = normalizeKit(kit); return SLOTS.reduce((m, s) => Math.max(m, unlockOf(s.key, k[s.key])), 0); };
/** 아직 잠긴 부품은 키트 기본 부품으로 되돌린다 */
export function lockKit(kit, races) {
  const k = normalizeKit(kit);
  for (const s of SLOTS) if (unlockOf(s.key, k[s.key]) > races) k[s.key] = DEFAULT_KIT[s.key];
  return k;
}
/** 정확히 n 회째에 열리는 부품들 [{ key, label, id, name }] */
export const unlocksAt = n => SLOTS.flatMap(s => slotList(s.key).filter(o => unlockOf(s.key, o.id) === n).map(o => ({ key: s.key, label: s.label, id: o.id, name: o.name })));
/** races 다음으로 해금되는 단계 (없으면 null) */
export function nextUnlock(races) {
  const steps = [...new Set(Object.values(UNLOCK).flatMap(m => Object.values(m)))].filter(n => n > races).sort((a, b) => a - b);
  return steps.length ? { at: steps[0], items: unlocksAt(steps[0]) } : null;
}
export const UNLOCK_MAX = Math.max(...Object.values(UNLOCK).flatMap(m => Object.values(m)));

/** 추천 세팅 (AI 와 '추천 세팅' 버튼이 쓴다) */
export const KIT_PRESETS = [
  { name: '키트 기본',   desc: '처음 조립한 그대로',                kit: { ...DEFAULT_KIT } },
  { name: '밸런스',      desc: '어느 코스나 무난하게',              kit: { motor: 'power',  gear: 'g42', bearing: 'b1150', tire: 'mid',  dia: 'd26', roller: 'a13', rlay: 'f2r4', plate: 'frp',    damper: 'side',   brake: 'b1',   body: 'std' , rheight: 'mid'} },
  { name: '코너 특화',   desc: '코너가 많은 테크니컬 코스 · 전폭 105mm 꽉 채움', kit: { motor: 'atomic', gear: 'g37', bearing: 'b620', tire: 'soft', dia: 'd26', roller: 'a17', rlay: 'f2r4', plate: 'carbon', damper: 'rotary', brake: 'b1',   body: 'light' , rheight: 'mid'} },
  { name: '점프 안정',   desc: '점프·슬로프에서 튀지 않게',          kit: { motor: 'atomic', gear: 'g42', bearing: 'b620', tire: 'mid',  dia: 'd26', roller: 'a17', rlay: 'f2r4', plate: 'frp',    damper: 'heavy',  brake: 'b2',   body: 'std' , rheight: 'low'} },
  { name: '풀 스피드',   desc: '가볍게 깎은 마하 대시 — 가장 빠르지만 코너에서 가끔 튀어 나감 (고수용)', kit: { motor: 'mach', gear: 'g42', bearing: 'b620', tire: 'hard', dia: 'd26', roller: 'a19', rlay: 'f2r4', plate: 'frp', damper: 'side', brake: 'b1', body: 'light' } },
];

/* ---------------------------------------------------------------- 성능 계산 */
export const M_REF = 125;            // 키트 기본 세팅의 무게(g). 이 무게일 때 모터 가속이 표에 적힌 값
const BASE_W = { chassis: 32, battery: 46, motor: 17, brakeMount: 0 };   // 섀시+기어+샤프트 / AA 알칼리 2개 / 모터
export const REST_BASE = 0.55;       // 매스댐퍼 없을 때 착지 반발 계수
export const FLY_BASE = 1.3;         // 키트 기본 세팅일 때 코너 코스아웃 한계 (횡가속 기준 속도의 배수)
export const BOUNCE_BASE = 9;        // 착지 후 튀어 오르는 속도가 이 이상이면 벽을 넘어 코스아웃 (롤러 접점이 높으면 낮아진다)

/* ---- 벽 타기(코너 코스아웃) 물리 ----
 * 코너에서 롤러가 바깥 벽에 기대 돌 때, 원심력은 무게중심 높이에, 벽이 밀어 주는 힘은 롤러 접점 높이에 걸린다.
 * 무게중심이 접점보다 Δh 만큼 높으면 그 차이만큼 차를 바깥으로 기울이는 회전력이 생기고(안쪽 바퀴가 들림),
 * 기울어진 차는 벽을 타고 올라 넘어간다. 버틸 수 있는 횡가속 ≈ (트레드/2) ÷ Δh → Δh 가 작을수록(롤러가 높을수록, 무게중심이 낮을수록) 강하다.
 * 실제 차는 서스펜션·벽 휨 때문에 Δh 가 0 에 가까워져도 무한히 버티지는 못하므로 완만하게 포화시킨다. */
const TIER_UP = 12;                  // 2단 롤러 윗단이 아랫단보다 높은 정도(mm)
const TIP_MIN = 3.5, TIP_MAX = 8.6;  // 무게중심이 롤러보다 아주 높을 때 / 롤러가 무게중심 높이 이상일 때의 벽 타기 한계(G, 롤러·타이어·플레이트 보정 전)
/** 무게중심 높이 · 롤러 접점 높이 · 벽 타기 한계(G) */
export function tipGeometry(kit, mass) {
  const P = key => partOf(kit, key);
  const di = P('dia'), ro = P('roller'), rl = P('rlay'), pl = P('plate'), da = P('damper'), br = P('brake'), bo = P('body'), be = P('bearing'), rh = P('rheight'), ti = P('tire');
  const axle = di.mm / 2, rollerH = rh.h, upper = rl.n - 4;        // 롤러는 높이 조절 볼트로 지면 기준 높이를 맞춘다 (대경 타이어면 차체만 올라감)
  const items = [                        // [무게(g), 높이(mm, 지면 기준)]
    [BASE_W.chassis, axle - 3], [BASE_W.battery, axle - 2], [BASE_W.motor, axle], [di.w, axle], [be.w, axle],
    [bo.w, axle + bo.cg], [ro.w * 4, rollerH], [ro.w * upper, rollerH + TIER_UP], [pl.w * 2, rollerH - 2], [da.w, axle + da.cg], [br.w, 3],
  ];
  const cgH = items.reduce((a, [m, h]) => a + m * h, 0) / mass;
  const contactH = rollerH + TIER_UP * upper / 8;          // 2단이면 윗단까지 벽을 받쳐 유효 접점이 올라간다 (앞뒤 중 2단 비율만큼)
  const dh = cgH - contactH;
  const tipG = (TIP_MIN + (TIP_MAX - TIP_MIN) / (1 + Math.exp((dh - 5) / 2.2))) * ro.q * ti.q * pl.q;   // Δh 가 클수록 TIP_MIN, 접점이 무게중심 이상이면 TIP_MAX 로 완만하게
  return { cgH, contactH, dh, tipG };
}
function massOf(kit) {
  const P = key => partOf(kit, key);
  return BASE_W.chassis + BASE_W.battery + BASE_W.motor + P('dia').w + P('roller').w * P('rlay').n + P('plate').w * 2 + P('damper').w + P('brake').w + P('body').w + P('bearing').w;
}
let TIP_REF = 0;                     // 키트 기본 세팅의 벽 타기 한계(G) — 이때 한계 배율이 FLY_BASE

export function deriveSpec(kitIn) {
  if (!TIP_REF) { const k0 = normalizeKit(DEFAULT_KIT); TIP_REF = tipGeometry(k0, massOf(k0)).tipG; }
  const kit = normalizeKit(kitIn), P = key => partOf(kit, key);
  const mo = P('motor'), ge = P('gear'), be = P('bearing'), ti = P('tire'), di = P('dia'), ro = P('roller'), rl = P('rlay'), pl = P('plate'), da = P('damper'), br = P('brake'), bo = P('body');
  const mass = massOf(kit);
  const massA = Math.pow(M_REF / mass, 1.0), massV = Math.pow(M_REF / mass, 0.3);       // 무거우면 가속이 크게, 최고속도 조금 떨어진다
  const vmax = mo.vmax * ge.v * di.v * ti.mul * be.v * massV;
  const acc = mo.acc * ge.a * di.a * be.a * massA;
  const geo = tipGeometry(kit, mass);
  const hold = FLY_BASE * Math.sqrt(geo.tipG / TIP_REF);       // 버티는 횡가속 ∝ 속도² → 한계 속도는 그 제곱근에 비례
  const fric = ro.fric * rl.fric * ti.wall;
  const rest = Math.max(0.2, REST_BASE - da.rest + di.rest);
  // 코너 흔들림: 코너에 들어갈 때마다 롤러가 버티는 한계가 이만큼까지 랜덤하게 낮아질 수 있다 (한계 근처로 달리는 세팅만 가끔 코스아웃)
  // 2단 롤러·회전형 매스댐퍼·단단한 플레이트·링 롤러가 흔들림을 줄인다
  const wobble = Math.max(0.03, 0.12 - (rl.n - 4) * 0.01 - { none: 0, side: 0.005, heavy: 0.01, rotary: 0.03 }[da.id] - { std: 0, frp: 0.01, carbon: 0.02 }[pl.id] - (ro.id === 'r19' ? 0.02 : 0));
  const width = pl.span + ro.mm, length = 146 + pl.len, height = bo.h + (di.mm - 26) / 2 + 2;
  const chassisClear = di.mm / 2 - 10.5, clear = chassisClear - br.drop;
  return {
    kit, mass, vmax, acc, grip: ti.grip, hold, fric, rest, wobble, brakeK: br.k,
    cgH: geo.cgH, contactH: geo.contactH, tipG: geo.tipG,
    // 롤러 접점이 높으면 점프 착지 때 롤러가 벽 위로 올라타 넘어가기 쉽다 (튕겨 나가는 기준 ↓)
    bounceOut: BOUNCE_BASE * (1 - Math.max(0, geo.contactH - 10) * 0.025),
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
