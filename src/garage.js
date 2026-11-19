// 미니카 커스텀(차고) 화면: 부품 선택 · 설계도 · 성능 비교 · 공식 규정 검사 · 테스트 주행(예상 기록)
import { buildTrack, PRESETS } from './track.js';
import { makeCar, stepCar, launchSpeed, LANE_LAT, TIME_SCALE } from './sim.js';
import { SLOTS, GROUPS, KIT_PRESETS, slotList, partOf, normalizeKit, deriveSpec, checkRegs, isLegal, WALL_G, unlockOf, kitUnlock, nextUnlock, UNLOCK_MAX } from './parts.js';

const KMH = 0.5;
const $ = id => document.getElementById(id);
const fmt = t => { if (t == null || !isFinite(t)) return '--'; t /= TIME_SCALE; const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s.toFixed(2).padStart(5, '0')}`; };     // 시뮬레이션 시간 → 실제 시간
const sameKit = (a, b) => SLOTS.every(s => a[s.key] === b[s.key]);

/* ---------------------------------------------------------------- 성능 지표 (화면 표시용) */
const cornerKmh = sp => Math.sqrt(WALL_G * 15) * sp.hold * KMH;        // 안쪽 레인 45° 코너에서 롤러로 버티는 한계
/** 막대 그래프 항목: v = 값, lo~hi = 막대 범위, better = 1(클수록 좋음) / -1(작을수록 좋음) */
const STATS = [
  { key: 'speed',  label: '최고속도',  unit: 'km/h', v: sp => sp.vmax * KMH,        lo: 10, hi: 54, better: 1, dp: 1 },
  { key: 'accel',  label: '가속',      unit: '',     v: sp => sp.acc,               lo: 10, hi: 72, better: 1, dp: 0 },
  { key: 'corner', label: '코너 한계', unit: 'km/h', v: cornerKmh,                  lo: 24, hi: 40, better: 1, dp: 1, tip: '안쪽 레인 45° 코너에서 벽을 타고 넘지 않고 버티는 속도 (무게중심·롤러 높이로 결정)' },
  { key: 'jump',   label: '착지 반발', unit: '%',    v: sp => sp.rest * 100,        lo: 20, hi: 62, better: -1, dp: 0, tip: '점프 착지 때 튀어 오르는 정도 — 낮을수록 안정' },
  { key: 'mass',   label: '무게',      unit: 'g',    v: sp => sp.mass,              lo: 110, hi: 170, better: -1, dp: 0 },
];

/* ---------------------------------------------------------------- 테스트 주행 (헤드리스 시뮬레이션) */
/** 3랩 × 1·2·3레인 출발을 돌려 평균 기록과 사고 횟수를 낸다. 모든 접속자와 같은 sim 코드라 실제 레이스와 같은 결과 */
function testRun(kit, tr) {
  let time = 0, crash = 0, out = 0, bounce = 0, fall = 0, hop = 0, dnf = 0;
  const SEEDS = [11, 23, 37], N = 3 * SEEDS.length;            // 코너 흔들림이 있어 여러 번 돌려 평균을 낸다
  for (let l = 0; l < 3; l++) for (const seed of SEEDS) {
    const c = makeCar({ kit, seed: seed * 101 + l }, LANE_LAT[l], 'test', 0); c.v = launchSpeed(c, tr);
    let t = 0; const H = 1 / 120;
    while (!c.finished && t < 240) {
      t += H; stepCar(c, tr, H, t, 3);
      for (const e of c.events) { if (e.type === 'flyoff') out++; else if (e.type === 'bounceout') bounce++; else if (e.type === 'fall') fall++; else if (e.type === 'hop') hop++; }
    }
    if (!c.finished) dnf++;
    time += c.finished ? c.finishTime : 240; crash += c.crashes;
  }
  return { time: time / N, crash: crash / N, out: out / N, bounce: bounce / N, fall: fall / N, hop: hop / N, dnf };
}

/* ---------------------------------------------------------------- 설계도 (위에서 본 모습, 단위 mm) */
function blueprint(sp) {
  const k = sp.kit, P = key => partOf(k, key);
  const ro = P('roller'), rl = P('rlay'), pl = P('plate'), da = P('damper'), br = P('brake'), bo = P('body');
  const L = sp.length, W = sp.width, half = pl.span / 2, rr = ro.mm / 2, tireL = sp.tireMM, tireW = 10;
  const yF = -L / 2 + rr, yR = L / 2 - rr, axF = -38, axR = 42, cx = 29;      // 롤러/차축 위치
  const okW = W <= 105, okL = L <= 165;
  const plateCol = { std: '#9aa6bd', frp: '#6fa8ff', carbon: '#2b2f3a' }[pl.id];
  const plateStroke = { std: '#5c6780', frp: '#2c5fae', carbon: '#7b8394' }[pl.id];
  const roller = (x, y, dbl) => `<g><circle cx="${x}" cy="${y}" r="${rr}" class="bp-roller ${ro.id[0] === 'p' ? 'pl' : ro.id === 'r19' ? 'ring' : 'al'}"/>`
    + (ro.id === 'r19' ? `<circle cx="${x}" cy="${y}" r="${rr - 1.6}" fill="none" stroke="#1d2340" stroke-width="1.6"/>` : '')
    + `<circle cx="${x}" cy="${y}" r="${Math.min(2.4, rr * 0.3)}" fill="#1d2340"/>`
    + (dbl ? `<circle cx="${x}" cy="${y}" r="${rr + 1.8}" fill="none" stroke="#ffd23f" stroke-width="1" stroke-dasharray="2.5 2"/>` : '') + '</g>';
  const plate = (y, front) => {
    const h = pl.id === 'std' ? 7 : 9, y0 = front ? y - h / 2 : y - h / 2;
    return `<rect x="${-half}" y="${y0}" width="${pl.span}" height="${h}" rx="3" fill="${plateCol}" stroke="${plateStroke}" stroke-width="1"/>`
      + (pl.id === 'carbon' ? `<path d="M${-half + 4} ${y0 + 2}h${pl.span - 8}M${-half + 4} ${y0 + h - 2}h${pl.span - 8}" stroke="#4a5163" stroke-width=".8" stroke-dasharray="1.5 1.5"/>` : '')
      + `<path d="M${-half + 2} ${y} L${-12} ${front ? axF + 8 : axR - 8} M${half - 2} ${y} L12 ${front ? axF + 8 : axR - 8}" stroke="${plateStroke}" stroke-width="3" opacity=".55"/>`;
  };
  const tire = (x, y) => `<rect x="${x - tireW / 2}" y="${y - tireL / 2}" width="${tireW}" height="${tireL}" rx="3" class="bp-tire t-${k.tire}"/>`
    + `<path d="M${x - tireW / 2 + 1.5} ${y - tireL / 2 + 3}v${tireL - 6}M${x + tireW / 2 - 1.5} ${y - tireL / 2 + 3}v${tireL - 6}" stroke="rgba(255,255,255,.12)" stroke-width="1"/>`;
  let damp = '';
  if (da.id === 'side' || da.id === 'heavy') {
    const s = da.id === 'heavy' ? 9 : 6.5;
    for (const sx of [-1, 1]) damp += `<rect x="${sx * 36 - s / 2}" y="${-s * 1.3}" width="${s}" height="${s * 2.6}" rx="2.2" class="bp-damper"/>`;
  } else if (da.id === 'rotary') damp = `<circle cx="0" cy="${yR - 13}" r="7.5" class="bp-damper"/><circle cx="0" cy="${yR - 13}" r="2.4" fill="#1d2340"/>`;
  const brake = br.id === 'none' ? '' : `<rect x="-17" y="${yR - 5.5 - (br.id === 'b3' ? 1.5 : 0)}" width="34" height="${3 + ['b1', 'b2', 'b3'].indexOf(br.id) * 1.6}" rx="1.4" class="bp-brake"/>`;
  const body = bo.id === 'light'
    ? `<path d="M-22 ${axF - 16} Q0 ${axF - 30} 22 ${axF - 16} L26 ${axR + 10} Q0 ${axR + 20} -26 ${axR + 10} Z" class="bp-body light"/>`
    : `<path d="M-24 ${axF - 18} Q0 ${axF - 32} 24 ${axF - 18} L28 ${axR + 12} Q0 ${axR + 22} -28 ${axR + 12} Z" class="bp-body"/>`;
  const dim = (x1, y1, x2, y2, label, ok, vert) => {
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    return `<g class="bp-dim ${ok ? 'ok' : 'bad'}"><path d="M${x1} ${y1}L${x2} ${y2}"/>`
      + (vert ? `<path d="M${x1 - 3} ${y1}h6M${x2 - 3} ${y2}h6"/>` : `<path d="M${x1} ${y1 - 3}v6M${x2} ${y2 - 3}v6"/>`)
      + `<text x="${vert ? mx + 4 : mx}" y="${vert ? my : my - 3.5}" ${vert ? 'text-anchor="start" dominant-baseline="middle"' : 'text-anchor="middle"'}>${label}</text></g>`;
  };
  return `<svg viewBox="-70 -104 160 208" class="bp" role="img" aria-label="미니카 설계도">
    <defs><pattern id="bpGrid" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M10 0H0V10" fill="none" stroke="rgba(120,170,255,.10)" stroke-width=".6"/></pattern></defs>
    <rect x="-70" y="-104" width="160" height="208" fill="url(#bpGrid)"/>
    <path d="M-52.5 -96V96M52.5 -96V96" class="bp-limit ${okW ? '' : 'bad'}"/>
    <text x="54" y="-92" class="bp-limtx">105mm 한계</text>
    ${dim(-W / 2, -L / 2 - 6, W / 2, -L / 2 - 6, `전폭 ${W}mm`, okW, false)}
    ${dim(W / 2 + 10, -L / 2, W / 2 + 10, L / 2, `${L}mm`, okL, true)}
    <rect x="-${cx}" y="${axF - 14}" width="${cx * 2}" height="${axR - axF + 28}" rx="10" class="bp-chassis"/>
    <rect x="-9" y="-6" width="18" height="26" rx="4" class="bp-motor"/><text x="0" y="10" class="bp-mtx">${partOf(k, 'motor').name.split(' ')[0]}</text>
    ${tire(-cx - 6, axF)}${tire(cx + 6, axF)}${tire(-cx - 6, axR)}${tire(cx + 6, axR)}
    ${body}${damp}
    ${plate(yF, true)}${plate(yR, false)}${brake}
    ${roller(-half, yF, rl.n === 8)}${roller(half, yF, rl.n === 8)}${roller(-half, yR, rl.n >= 6)}${roller(half, yR, rl.n >= 6)}
    <path d="M0 -${L / 2 + 16}l-4 7h8z" fill="#22d3c5"/>
  </svg>`;
}

/* ---------------------------------------------------------------- 단면도 (뒤에서 본 모습): 무게중심 vs 롤러 접점 → 벽 타기 */
function sideview(sp) {
  const k = 1.6, G = 94, cx = 92, P = key => partOf(sp.kit, key);
  const ro = P('roller'), pl = P('plate'), rl = P('rlay'), y = mm => G - mm * k;
  const axle = sp.tireMM / 2, half = 33, rx = cx + (pl.span / 2) * k, rw = ro.mm * k, wallX = rx + rw / 2;
  const cg = sp.cgH, ct = sp.contactH, dh = cg - ct, risk = dh > 4 ? 'bad' : dh > 1.5 ? 'mid' : 'ok';
  const roller = h => `<rect x="${rx - rw / 2}" y="${y(h) - 4}" width="${rw}" height="8" rx="2" class="sv-roller"/>`;
  const lowH = P('rheight').h, upper = rl.n > 4;
  return `<svg viewBox="0 0 ${wallX + 64} 100" class="sv" role="img" aria-label="무게중심과 롤러 높이 단면도">
    <path d="M0 ${G}H${wallX + 64}" class="sv-ground"/>
    <rect x="${wallX}" y="${y(50)}" width="8" height="${50 * k}" class="sv-wall"/><text x="${wallX + 4}" y="${y(50) - 3}" class="sv-t" text-anchor="middle">벽 50mm</text>
    <rect x="${cx - half * k - 7}" y="${y(sp.tireMM)}" width="14" height="${sp.tireMM * k}" rx="4" class="sv-tire"/>
    <rect x="${cx + half * k - 7}" y="${y(sp.tireMM)}" width="14" height="${sp.tireMM * k}" rx="4" class="sv-tire"/>
    <rect x="${cx - 26 * k}" y="${y(axle + 5)}" width="${52 * k}" height="${12 * k}" rx="5" class="sv-chassis"/>
    <path d="M${cx - 22 * k} ${y(axle + 5)} Q${cx} ${y(axle + 24)} ${cx + 22 * k} ${y(axle + 5)}Z" class="sv-body"/>
    <path d="M${cx + 24 * k} ${y(lowH)}H${rx}" class="sv-arm"/>${upper ? `<path d="M${rx} ${y(lowH)}V${y(lowH + 12)}" class="sv-arm"/>` : ''}
    ${roller(lowH)}${upper ? roller(lowH + 12) : ''}
    <path d="M${cx + 8} ${y(cg)}H${wallX + 18}" class="sv-guide"/><path d="M${rx + rw / 2} ${y(ct)}H${wallX + 18}" class="sv-guide ct"/>
    <path d="M${wallX + 16} ${y(cg)}V${y(ct)}" class="sv-dh ${risk}"/>
    <text x="${wallX + 21}" y="${(y(cg) + y(ct)) / 2 + 3}" class="sv-t ${risk}">Δh ${dh.toFixed(1)}</text>
    <circle cx="${cx}" cy="${y(cg)}" r="5" class="sv-cg"/><path d="M${cx - 5} ${y(cg)}h10M${cx} ${y(cg) - 5}v10" stroke="#1d2340" stroke-width="1.4"/>
    <path d="M${cx - 34} ${y(cg)}h22" class="sv-force"/><path d="M${cx - 12} ${y(cg)}l-5 -3v6z" class="sv-forcehead"/>
    <text x="${cx - 36}" y="${y(cg) - 5}" class="sv-t">원심력</text>
  </svg>
  <div class="sv-info"><span>무게중심 <b>${cg.toFixed(1)}mm</b></span><span>롤러 접점 <b>${ct.toFixed(1)}mm</b></span><span class="${risk}">벽 타기 한계 <b>${sp.tipG.toFixed(1)}G</b></span></div>
  <div class="sv-hint">무게중심이 롤러 접점보다 높을수록(Δh↑) 코너에서 차가 바깥으로 기울어 벽을 타고 넘어간다 · 롤러를 올리거나 2단으로, 무게는 아래로</div>`;
}

/* ---------------------------------------------------------------- 화면 */
export function createGarage({ getKit, onApply, getCourse, getRaces = () => 99, onOpen = () => { } }) {
  let races = 0, draft = null, applied = null, group = 'power', testTimer = 0, cache = new Map(), courseTr = null, courseName = '';

  const statRow = (st, sp, spA) => {
    const v = st.v(sp), va = st.v(spA), pct = x => Math.max(0, Math.min(100, (x - st.lo) / (st.hi - st.lo) * 100));
    const d = v - va, good = d * st.better > 0, show = Math.abs(d) >= (st.dp ? 0.05 : 0.5);
    return `<div class="gs-row" title="${st.tip || ''}"><span class="gs-l">${st.label}</span>
      <span class="gs-bar ${st.better < 0 ? 'inv' : ''}"><i style="width:${pct(v)}%"></i><b style="left:${pct(va)}%"></b></span>
      <span class="gs-v">${v.toFixed(st.dp)}<small>${st.unit}</small>${show ? `<em class="${good ? 'up' : 'dn'}">${d > 0 ? '+' : ''}${d.toFixed(st.dp)}</em>` : ''}</span></div>`;
  };
  /** 이 부품으로 바꾸면 무엇이 달라지는지 (지금 고른 세팅 대비) */
  function deltaChips(key, id) {
    const a = deriveSpec(draft), b = deriveSpec({ ...draft, [key]: id }), out = [];
    for (const st of STATS) {
      const d = st.v(b) - st.v(a); if (Math.abs(d) < (st.dp ? 0.15 : 0.6)) continue;
      out.push({ w: Math.abs(d) / (st.hi - st.lo), html: `<span class="chip ${d * st.better > 0 ? 'up' : 'dn'}">${st.label.replace(' 한계', '').replace('최고속도', '최고속')} ${d > 0 ? '+' : ''}${d.toFixed(st.dp)}${st.unit === '%' ? '%' : st.unit === 'g' ? 'g' : ''}</span>` });
    }
    if (b.width !== a.width) out.push({ w: 0.01, html: `<span class="chip ${b.width > 105 ? 'dn' : 'mid'}">전폭 ${b.width}mm</span>` });
    if (Math.abs(b.bounceOut - a.bounceOut) > 0.05) out.push({ w: 0.15, html: `<span class="chip ${b.bounceOut < a.bounceOut ? 'dn' : 'up'}">착지 때 벽 넘기 ${b.bounceOut < a.bounceOut ? '↑' : '↓'}</span>` });
    if (b.brakeK !== a.brakeK) out.push({ w: 0.2, html: `<span class="chip mid">경사 감속 ${b.brakeK > a.brakeK ? '↑' : '↓'}</span>` });
    return out.sort((x, y) => y.w - x.w).slice(0, 3).map(x => x.html).join('') + (isLegal(b) ? '' : '<span class="chip bad">규정 위반</span>');
  }

  function renderSlots() {
    $('gTabs').innerHTML = GROUPS.map(g => `<button class="btn gtab ${g.id === group ? 'on' : ''}" data-g="${g.id}">${g.label}</button>`).join('');
    $('gTabs').querySelectorAll('[data-g]').forEach(b => b.onclick = () => { group = b.dataset.g; renderSlots(); $('gSlots').scrollTop = 0; });
    $('gSlots').innerHTML = SLOTS.filter(s => s.group === group).map(s => `<div class="gslot"><h3>${s.label}${draft[s.key] !== applied[s.key] ? '<i class="chg">변경</i>' : ''}</h3><div class="gopts">`
      + slotList(s.key).map(o => {
        const need = unlockOf(s.key, o.id), locked = need > races;
        return `<button class="gopt ${draft[s.key] === o.id ? 'on' : ''} ${locked ? 'locked' : ''}" data-k="${s.key}" data-id="${o.id}" ${locked ? 'aria-disabled="true"' : ''}>
          <span class="go-n">${locked ? '🔒 ' : ''}${o.name}${applied[s.key] === o.id ? '<i class="cur">사용 중</i>' : ''}</span><span class="go-d">${o.desc || ''}</span>
          ${locked ? `<span class="go-lock">레이스 ${need}회 완주 시 해금 · 앞으로 ${need - races}회</span>` : ''}
          <span class="go-c">${draft[s.key] === o.id ? '' : deltaChips(s.key, o.id)}</span></button>`;
      }).join('') + '</div></div>').join('');
    $('gSlots').querySelectorAll('.gopt').forEach(b => b.onclick = () => { if (b.classList.contains('locked')) return; draft[b.dataset.k] = b.dataset.id; refresh(); });
  }
  function renderPresets() {
    $('gPresets').innerHTML = KIT_PRESETS.map((p, i) => {
      const need = kitUnlock(p.kit), locked = need > races;
      return `<button class="btn preset gp ${sameKit(draft, normalizeKit(p.kit)) ? 'on' : ''} ${locked ? 'locked' : ''}" data-i="${i}" title="${locked ? `레이스 ${need}회 완주 시 사용 가능` : p.desc}">${locked ? '🔒 ' : ''}${p.name}</button>`;
    }).join('');
    $('gPresets').querySelectorAll('[data-i]').forEach(b => b.onclick = () => { if (b.classList.contains('locked')) return; draft = normalizeKit(KIT_PRESETS[+b.dataset.i].kit); refresh(); });
    const nx = nextUnlock(races);      // 진행 막대: 전체 해금(UNLOCK_MAX 회) 중 얼마나 왔는지
    $('gProg').innerHTML = nx
      ? `🏁 레이스 완주 <b>${races}회</b> · 다음 해금까지 <b>${nx.at - races}회</b><div class="gp-bar"><i style="width:${Math.round(races / UNLOCK_MAX * 100)}%"></i></div><small>${nx.at}회: ${nx.items.map(x => x.name).join(', ')}</small>`
      : `🏁 레이스 완주 <b>${races}회</b> · 🎉 모든 부품 해금 완료 (${UNLOCK_MAX}회)`;
  }
  function renderSpec() {
    const sp = deriveSpec(draft), spA = deriveSpec(applied), regs = checkRegs(sp), legal = regs.every(r => r.ok);
    $('gBp').innerHTML = blueprint(sp); $('gSide').innerHTML = sideview(sp);
    $('gStats').innerHTML = STATS.map(st => statRow(st, sp, spA)).join('') + '<div class="gs-note"><b></b> 지금 적용된 세팅</div>';
    $('gRegs').innerHTML = `<div class="greg-h ${legal ? 'ok' : 'bad'}">${legal ? '✔ 타미야 공식 규정 통과' : '✖ 공식 규정 위반 — 레이스에 나갈 수 없어요'}</div>`
      + regs.map(r => `<div class="greg ${r.ok ? '' : 'bad'}"><span>${r.ok ? '✔' : '✖'} ${r.label}</span><b>${+r.value.toFixed(1)}${r.unit}</b><small>${r.rule}</small></div>`).join('');
    const dirty = !sameKit(draft, applied);
    $('gApply').disabled = !legal || !dirty;
    $('gApply').innerHTML = !legal ? '규정 위반' : dirty ? '✔ 적용' : '적용됨';
    $('gUndo').disabled = !dirty;
  }
  function scheduleTest() {
    clearTimeout(testTimer);
    $('gTest').classList.add('busy');
    testTimer = setTimeout(runTest, 140);
  }
  function runTest() {
    if (!courseTr) return;
    const key = SLOTS.map(s => draft[s.key]).join('.'), keyA = SLOTS.map(s => applied[s.key]).join('.');
    const get = (k, kit) => { if (!cache.has(k)) cache.set(k, testRun(kit, courseTr)); return cache.get(k); };
    const r = get(key, draft), ra = get(keyA, applied), d = (r.time - ra.time) / TIME_SCALE;
    const issues = [];
    if (r.out >= 0.34) issues.push(`코너 코스아웃 ${r.out.toFixed(1)}회 <small>→ 롤러·플레이트 보강 또는 기어/모터 낮추기</small>`);
    if (r.bounce >= 0.34) issues.push(`착지 튕김 코스아웃 ${r.bounce.toFixed(1)}회 <small>→ 매스댐퍼·브레이크</small>`);
    if (r.fall >= 0.34) issues.push(`점프 실패(추락) ${r.fall.toFixed(1)}회 <small>→ 속도 부족: 브레이크 약하게·모터 올리기</small>`);
    if (!issues.length && r.hop >= 1) issues.push(`착지할 때 ${r.hop.toFixed(1)}번 통통 튐 <small>→ 매스댐퍼로 줄이면 감속이 줄어요</small>`);
    $('gTest').classList.remove('busy');
    $('gTest').innerHTML = `<div class="gt-h">🏁 테스트 주행 <small>${courseName} · 3랩 · 1~3레인 × 3회 평균</small></div>
      <div class="gt-t">${r.dnf ? '완주 실패' : fmt(r.time)}${sameKit(draft, applied) ? '' : `<em class="${d < -0.005 ? 'up' : d > 0.005 ? 'dn' : ''}">${d < 0 ? '▼' : d > 0 ? '▲' : ''} ${Math.abs(d).toFixed(2)}초 ${d < -0.005 ? '빨라짐' : d > 0.005 ? '느려짐' : '같음'}</em>`}</div>
      <div class="gt-i ${issues.length && !/통통/.test(issues[0]) ? 'bad' : 'ok'}">${issues.length ? issues.map(x => `<div>${x}</div>`).join('') : '<div>코스아웃 없이 깔끔하게 완주!</div>'}</div>`;
  }
  function refresh() { renderPresets(); renderSlots(); renderSpec(); scheduleTest(); }

  function open() {
    races = getRaces(); onOpen();
    applied = normalizeKit(getKit()); draft = { ...applied };
    const c = getCourse && getCourse();
    if (c && c.track) { courseTr = c.track; courseName = c.name; } else { courseTr = buildTrack(PRESETS['점프 서킷']); courseName = '점프 서킷'; }
    cache = new Map();
    $('garage').classList.remove('hide'); refresh();
  }
  function close() { clearTimeout(testTimer); $('garage').classList.add('hide'); }
  $('gClose').onclick = close;
  $('gUndo').onclick = () => { draft = { ...applied }; refresh(); };
  $('gApply').onclick = () => { if (!isLegal(deriveSpec(draft))) return; applied = { ...draft }; onApply({ ...draft }); refresh(); };
  return { open, close, isOpen: () => !$('garage').classList.contains('hide') };
}
