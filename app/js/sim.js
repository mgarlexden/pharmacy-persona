// 시뮬레이터 탭.
// 기본 보기: 1~2층 건물. 날짜·독감·기온·비를 바꾸면 하루 손님 수가 바뀌고, 재생하면 3D에서 손님이 띄엄띄엄 들어온다.
// 시뮬레이션: 약사 시점(1인칭). 시나리오 고르기 → AI 판단 따라가기 → 약사 답과 비교 → 근거에 추가할지 정하기.
// 판단은 AI(저장된 실행 결과)가 한다. 화면에서 답을 고르지 않는다. 약사 답은 data/5_validation/pharmacist_answers.csv 에서 읽는다.
import { lookup, obsLines, CARDS, cardById, OBJ_INFO, SCENE_LABELS, parseCSV, registerAnswerIds, KIND_KO, DB } from './data.js';
import * as E from './engine.js';
import { loadDemand, computeDay, forecast, flowHours, dayDefaults, model as dmodel, BASE_VISITS, ITEM_BASE, HOURS } from './demand.js';
import { createScene } from '../design/building3d.js';
import { $, $$, esc, store, badge, VIRT, PUB, INTV, ASSUME, chip, chips, toast, reduceMotion, ACTION_LABEL, qidOf, qtyOf, layerName, srcTag, flagText } from './ui.js';

const ROUTE = { oth: { c: '#d4881f', t: '1층 의원 처방' }, ent: { c: '#0f9b8c', t: '같은 층 이비인후과 처방' }, walk: { c: '#8b5cf6', t: '일반약 구매' }, inq: { c: '#3b82f6', t: '문의만 하고 감' } };
const SRC_BADGE = { interview: INTV, public: PUB, assume: ASSUME, user: badge('neutral', '직접 조절') };
const SPEED = { normal: 90000, fast: 30000 };
const D0 = E.CAL[0];

const S = {
  mode: 'basic', step: 1, cardId: 'C01', layer: 'P1',
  env: { date: D0, ili: null, temp: null, rain: null, dust: false },
  playing: false, speed: 'normal', checked: false,
  replay: { i: -1, timer: 0 }, ready: false,
};
let sc = null, RUNS = null, ANSWERS = [], tick = 0;
const card = () => cardById(S.cardId);

/* ---------- 데이터 ---------- */
async function loadRuns() {
  try { const r = await fetch('../runs/latest.json', { cache: 'no-store' }); RUNS = r.ok ? await r.json() : null; } catch (e) { RUNS = null; }
}
async function loadAnswers() {
  try {
    const r = await fetch('../data/5_validation/pharmacist_answers.csv', { cache: 'no-store' });
    if (!r.ok) throw new Error();
    const rows = parseCSV(await r.text());
    registerAnswerIds(rows);
    ANSWERS = rows.filter((x) => x.card_id);
  } catch (e) { ANSWERS = []; }
}
const aiRuns = (cardId, layer) => (RUNS ? RUNS.results.filter((r) => r.card === cardId && r.layer === layer) : []);
const aiRun = (cardId, layer = S.layer) => aiRuns(cardId, layer).sort((a, b) => a.rep - b.rep)[0] || null;
const answerOf = (cardId) => ANSWERS.filter((a) => a.card_id === cardId).sort((a, b) => Number(a.round) - Number(b.round))[0] || null;
const finalOf = (run) => { const l = run.steps[run.steps.length - 1]; return qidOf(l.action, l.qty_packs); };

/* ---------- 3D ---------- */
function ensureScene() {
  if (sc) return sc;
  sc = createScene($('#stage'), { labels: SCENE_LABELS });
  if (!sc) { $('#stage-fallback').hidden = false; return null; }
  sc.onPick((key) => showObj(key));
  sc.setSpeed(SPEED[S.speed]);
  return sc;
}
export const scene = () => sc;
function showObj(key) {
  const o = OBJ_INFO[key]; if (!o) return;
  const TAG = { 인터뷰: 'interview', 가상: 'virtual', 개념: 'concept', 미반영: 'unknown' };
  $('#obj-detail').innerHTML = `<h3>${esc(o.title)} ${badge(TAG[o.tag] || 'neutral', o.tag)}</h3><p class="small">${esc(o.body)}</p>${o.refs.length ? `<p class="xs muted" style="margin:8px 0 4px">근거가 된 인터뷰 번호</p>${chips(o.refs)}` : ''}`;
  $('#obj-card').hidden = false;
}
$('#obj-close').addEventListener('click', () => { $('#obj-card').hidden = true; });

function stockState() {
  const c = card().cond;
  if (S.mode === 'basic') return { ghost: c.book, solid: 0, truck: 'away', drop: 0, fulfilled: 0, unmet: 0 };
  return { ghost: c.book, solid: S.checked ? Math.min(10, c.physical) : 0, truck: 'away', drop: 0, fulfilled: 0, unmet: 0 };
}
function applyScene() {
  if (!sc) return;
  const day = curDay();
  sc.setState(stockState());
  sc.setDemand({ hours: flowHours(day), open: day.open, ili: day.ili, perFigure: 2 });
  sc.setEnv({ rain: day.rain, dust: S.env.dust });
  const c = card().cond;
  sc.setScreen({ big: `${c.book}팩`, lines: [`전산 재고 · ${c.ageH}시간 전 기록`, '최근 하루 5팩 판매 (가상)', `도매 입고 가능: ${E.dayLabel(c.arrival)} 아침`, c.prior ? '미입고 주문 5팩 있음' : '미입고 주문 없음'] });
  renderDropdown();
}

/* ---------- 기본 보기: 환경과 손님 ---------- */
const curDay = () => computeDay({ date: S.env.date, ili: S.env.ili, temp: S.env.temp, rain: S.env.rain });
function dayOptions() {
  return dmodel().dates.map((d) => {
    const x = dayDefaults(d);
    return `<option value="${d}" ${d === S.env.date ? 'selected' : ''}>${E.dayLabel(d)} (${esc(x.dow)})${x.holiday ? ` · ${esc(x.holiday)}` : ''}${d === D0 ? ' · 시나리오 날' : ''}</option>`;
  }).join('');
}
function hourSVG(day) {
  const W = 320, H = 120, L = 24, B = 22, T = 8, bw = (W - L - 4) / 10;
  const tot = day.hours.map((x) => x.oth + x.ent + x.walk + x.inq);
  const ymax = Math.max(12, Math.ceil(Math.max(...tot) / 4) * 4);
  const Y = (v) => T + (1 - v / ymax) * (H - T - B);
  let g = '';
  [0, ymax / 2, ymax].forEach((v) => { g += `<line class="grid" x1="${L}" x2="${W}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 4}" y="${Y(v) + 3}" text-anchor="end">${Math.round(v)}</text>`; });
  day.hours.forEach((x, i) => {
    const x0 = L + 2 + i * bw;
    if (!x.open) { g += `<rect x="${x0}" y="${T}" width="${bw - 3}" height="${H - T - B}" class="closed"><title>${x.h}시: 약국 영업 안 함 (가상 영업시간)</title></rect>`; }
    let y = H - B;
    ['oth', 'ent', 'walk', 'inq'].forEach((k) => {
      const h = (x[k] / ymax) * (H - T - B); if (h <= 0) return;
      y -= h;
      g += `<rect x="${x0}" y="${y}" width="${bw - 3}" height="${Math.max(0, h - 1)}" rx="1.5" fill="${ROUTE[k].c}"><title>${x.h}시 ${ROUTE[k].t} 약 ${x[k].toFixed(1)}명</title></rect>`;
    });
    if (day.entH && x.open && !x.entOpen) g += `<text x="${x0 + (bw - 3) / 2}" y="${H - B - 3}" text-anchor="middle" class="tiny">휴진</text>`;
    g += `<text x="${x0 + (bw - 3) / 2}" y="${H - 6}" text-anchor="middle">${x.h}</text>`;
  });
  return `<svg class="hour-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="시간대별 예상 손님. 막대 색은 3D 손님 옷 색과 같습니다.">${g}</svg>`;
}
function forecastSVG(fc, sel) {
  const W = 320, H = 150, L = 26, B = 34, T = 10, n = fc.list.length, bw = (W - L - 4) / n;
  const ymax = Math.max(40, Math.ceil(Math.max(...fc.list.map((x) => x.hi)) / 20) * 20);
  const Y = (v) => T + (1 - v / ymax) * (H - T - B);
  let g = '';
  [0, ymax / 2, ymax].forEach((v) => { g += `<line class="grid" x1="${L}" x2="${W}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 4}" y="${Y(v) + 3}" text-anchor="end">${Math.round(v)}</text>`; });
  fc.list.forEach((x, i) => {
    const x0 = L + 2 + i * bw, cx = x0 + (bw - 4) / 2, md = x.date.slice(5).replace(/^0/, '').replace('-', '/');
    if (!x.open) g += `<rect x="${x0}" y="${T}" width="${bw - 4}" height="${H - T - B}" class="closed"><title>${md}: 약국 쉬는 날 (가상 달력)</title></rect><text x="${cx}" y="${H - B - 4}" text-anchor="middle" class="tiny">휴무</text>`;
    else {
      g += `<rect x="${x0}" y="${Y(x.base)}" width="${bw - 4}" height="${H - B - Y(x.base)}" rx="2" class="${x.date === sel ? 'fc-bar sel' : 'fc-bar'}"><title>${md}(${x.dow}) 기준 약 ${Math.round(x.base)}명 · 범위 ${Math.round(x.lo)}~${Math.round(x.hi)}명</title></rect>`;
      g += `<line class="fc-range" x1="${cx}" x2="${cx}" y1="${Y(x.hi)}" y2="${Y(x.lo)}"/><line class="fc-range" x1="${cx - 3}" x2="${cx + 3}" y1="${Y(x.hi)}" y2="${Y(x.hi)}"/><line class="fc-range" x1="${cx - 3}" x2="${cx + 3}" y1="${Y(x.lo)}" y2="${Y(x.lo)}"/>`;
      g += `<text x="${cx}" y="${Y(x.hi) - 3}" text-anchor="middle" class="val">${Math.round(x.base)}</text>`;
    }
    g += `<text x="${cx}" y="${H - 20}" text-anchor="middle">${md}</text><text x="${cx}" y="${H - 8}" text-anchor="middle" class="${x.holiday || x.dow === '일' ? 'red' : ''}">${x.holiday ? '휴일' : x.dow}</text>`;
  });
  return `<svg class="hour-chart fc-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="앞으로 ${n}일 예상 손님. 막대는 기준값, 세로선은 가정한 반응 크기를 흔든 범위입니다.">${g}</svg>`;
}
function forecastSection(fc) {
  const it = fc.item;
  return `<section class="side-sec">
    <h2 class="side-h">앞으로 일주일 수요 예측 ${ASSUME}</h2>
    <p class="small">고른 날부터 하루 예상 손님입니다. 막대는 기준값, 세로선은 범위입니다.</p>
    ${forecastSVG(fc, S.env.date)}
    <div class="fc-item">
      <span>판단 품목 수요 ${VIRT} <small>(고른 날부터 영업 ${fc.itemDays}일)</small></span>
      <b>약 ${it.base}팩</b><small>범위 ${it.lo}~${it.hi}팩</small>
    </div>
    <p class="xs muted" style="margin-top:6px">위 독감·기온 막대 값이 일주일 전체에 적용됩니다(기온은 바꾼 만큼 모든 날에 더합니다). 요일별 날씨는 그날 공공 값입니다. 범위는 독감·기온·연휴·비가 손님을 얼마나 늘리는지(가정한 값)를 절반~1.5배로 바꿔 계산했습니다. 통계로 만든 예측이 아닙니다. 품목 수요는 하루 ${ITEM_BASE}팩을 손님 수에 비례시킨 값입니다.</p>
  </section>`;
}
function slider(id, label, unit, val, min, max, step, pub, pubNote) {
  const changed = pub != null && Math.abs(val - pub) > 1e-9;
  return `<div class="sl">
    <div class="sl-top"><label for="${id}">${label}</label><output for="${id}" id="${id}-out">${val.toFixed(1)}<small>${unit}</small></output></div>
    <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}" aria-describedby="${id}-hint">
    <div class="sl-hint" id="${id}-hint"><span>${pub != null ? `그날 공공 값 ${pub.toFixed(1)}${unit} ${esc(pubNote || '')}` : '그날 공공 값 없음 (기준값 사용)'}</span>${changed ? `<button type="button" class="lk" data-reset-env="${id}">공공 값으로</button>` : ''}</div>
  </div>`;
}
function basicSide() {
  const day = curDay(), def = day.def, M = dmodel();
  const tags = [esc(def.dow) + '요일'];
  if (def.holiday) tags.push(esc(def.holiday));
  if (day.after) tags.push('연휴 다음 첫 영업일');
  tags.push(day.open ? `약국 영업 ${9}–${9 + day.openH}시 ${VIRT}` : `약국 쉬는 날 ${VIRT}`);
  if (day.entH) tags.push(`이비인후과 ${day.entH[0]}–${day.entH[1]}시`);
  const parts = ['oth', 'ent', 'walk', 'inq'].map((k) => ({ k, v: k === 'oth' ? day.rxOth : k === 'ent' ? day.rxEnt : day[k] }));
  const total = day.total;
  const bar = total > 0 ? `<div class="mix-bar" role="img" aria-label="손님 구성">${parts.map((p) => `<i style="flex:${p.v.toFixed(2)};background:${ROUTE[p.k].c}" title="${ROUTE[p.k].t} 약 ${Math.round(p.v)}명"></i>`).join('')}</div>` : '';
  const legend = `<ul class="mix-legend">${parts.map((p) => `<li><i style="background:${ROUTE[p.k].c}"></i><span>${ROUTE[p.k].t}</span><b>${Math.round(p.v)}명</b></li>`).join('')}</ul>`;
  const fx = day.factors.filter((f) => f.f !== 1 || f.f === null).map((f) => `<tr><td><b>${esc(f.label)}</b><br><span class="xs muted">${esc(f.value)}</span></td><td class="num">${f.f == null ? `${BASE_VISITS}건` : `× ${f.f.toFixed(2)}`}</td><td>${SRC_BADGE[f.src] || ''}</td></tr><tr class="fx-note"><td colspan="3">${esc(f.note)}</td></tr>`).join('');
  // 판단 품목: 기본 시나리오 조건에서 보류·5팩·10팩 (수요 = 하루 손님에 비례, 가상)
  const k = cardById('C01');
  const res = E.runAll(k.cond, [day.item, day.item, day.item]);
  const itemRows = res.map((r, i) => `<tr><td>${['보류', '5팩 주문', '10팩 주문'][i]}</td><td class="num">${r.metrics.unmetTotal}명</td><td class="num">${r.metrics.endingPacks}팩</td></tr>`).join('');
  return `
  <header class="side-head">
    <p class="kicker">기본 보기</p>
    <h1 id="h-sim" tabindex="-1">하루 손님 흐름</h1>
    <p class="side-lede">날짜와 환경을 바꾸면 그날 약국에 올 손님 수가 바뀝니다. 아래 <b>재생</b>을 누르면 3D에서 하루를 봅니다.</p>
  </header>
  <section class="side-sec">
    <label class="side-lab" for="env-date">날짜</label>
    <select id="env-date" class="sel wide">${dayOptions()}</select>
    <p class="day-tags">${tags.map((t) => `<span>${t}</span>`).join('')}</p>
  </section>
  <section class="side-sec">
    <h2 class="side-h">환경 바꿔 보기</h2>
    ${slider('env-ili', '독감 유행 (경기)', '', day.ili, 0, 80, 0.5, def.ili, `· ${def.iliCarried ? `최근 ${def.iliWeek}주 값` : `${def.iliWeek}주`}`)}
    ${slider('env-temp', '평균기온', '℃', day.temp, -10, 35, 0.5, def.temp, '· 서울 관측소')}
    <div class="tg-row">
      <label class="tg"><input type="checkbox" id="env-rain" ${day.rain ? 'checked' : ''}><span>비</span><small>${def.rainMm != null ? `그날 ${def.rainMm}mm` : '값 없음'}</small></label>
      <label class="tg"><input type="checkbox" id="env-dust" ${S.env.dust ? 'checked' : ''}><span>미세먼지 많음</span><small>${def.pm10 != null ? `PM10 ${def.pm10}` : '값 없음'} · 마스크만</small></label>
    </div>
  </section>
  <section class="side-sec result">
    <div class="big-num"><b>${day.open ? `약 ${Math.round(total)}명` : '휴무'}</b><span>그날 예상 손님 ${day.open ? '' : '(약국 쉬는 날, 가상 달력)'}</span></div>
    ${bar}${legend}
    <h3 class="side-h3">시간대별</h3>
    ${hourSVG(day)}
    <p class="xs muted">막대 색은 3D 손님의 옷 색과 같습니다. 회색 칸은 약국이 닫힌 시간입니다.</p>
  </section>
  ${forecastSection(forecast({ date: S.env.date, ili: S.env.ili, temp: S.env.temp, rain: S.env.rain }))}
  <section class="side-sec">
    <h2 class="side-h">왜 이 숫자인가</h2>
    <div class="tbl-wrap"><table class="tbl fx">${fx}</table></div>
    <p class="xs muted" style="margin-top:6px">시간대 분포와 처방·일반약 비율은 ${VIRT} 데이터, 이비인후과 진료시간은 ${PUB}(팀 정리본, 공식 홈페이지 확인)입니다.</p>
  </section>
  <section class="side-sec">
    <h2 class="side-h">판단 품목으로 보면 ${VIRT}</h2>
    <p class="small">하루에 이 약을 찾는 손님이 <b>${day.item}명</b>이라면(기준 ${ITEM_BASE}명), 기본 시나리오(전산 8팩, 내일 입고)에서 사흘 동안:</p>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>선택</th><th class="num">못 판 손님</th><th class="num">남는 재고</th></tr></thead><tbody>${itemRows}</tbody></table></div>
    <p class="xs muted" style="margin-top:6px">손님 수에 비례해 수요를 늘린 가상 계산입니다. 시뮬레이션 모드의 판단 비교에는 쓰지 않습니다.</p>
  </section>`;
}

/* ---------- 시뮬레이션: 4단계 ---------- */
const STEPS = [[1, '시나리오'], [2, 'AI 판단'], [3, '약사 답 비교'], [4, '근거 결정']];
function stepper() {
  return `<ol class="sstep" aria-label="시뮬레이션 단계">${STEPS.map(([n, t]) => `<li><button type="button" data-step="${n}" ${n === S.step ? 'aria-current="step"' : ''}><span class="n">${n}</span>${t}</button></li>`).join('')}</ol>`;
}
function scenarioEnv() {
  const d = computeDay({ date: D0 });
  return `<ul class="env-facts">
    <li><span>날짜</span><b>${E.dayLabel(D0)} (${esc(d.def.dow)}) 아침 8:50 · 연휴 다음 첫 영업일</b>${PUB}</li>
    <li><span>독감</span><b>경기 ${d.def.ili}명/1,000명 (최근 ${d.def.iliWeek}주)</b>${PUB}</li>
    <li><span>같은 층 이비인후과</span><b>${d.entH ? `${d.entH[0]}시부터 진료 (화요일 오전 휴진)` : '-'}</b>${PUB}</li>
  </ul>`;
}
function obsTable(cardId, checked) {
  const k = cardById(cardId), c = k.cond;
  const pn = c.prior ? E.PRIOR_ORDER.packs : 0;
  const ctx = { ...c, UNIT: E.UNIT_COST, CAP: E.OFFER.capacity, DUE: E.OFFER.due, PRIOR_ARR: E.PRIOR_ORDER.arrival, D0: E.CAL[0], D1: E.CAL[1], D2: E.CAL[2], BULK_MIN: E.BULK_MIN, PRIOR_N: pn, POS_BOOK: c.book + pn, POS_PHYS: c.physical + pn, DISC: E.discountPct(c) };
  const fmt = { won: E.won, date: E.dayLabel, n: String };
  const fill = (t) => String(t).replace(/\{(\w+):(\w+)\}/g, (_, f, key) => fmt[f](ctx[key]));
  const { shown, hidden } = obsLines(cardId, c, checked, true);
  return `<div class="tbl-wrap"><table class="tbl obs"><tbody>${shown.map((r) => `<tr><th>${esc(r.obs_label_ko)}</th><td>${esc(fill(r.obs_text_ko))} ${/공공/.test(r.source_kind) ? PUB : /가정|가상/.test(r.source_kind) ? VIRT : ''}</td></tr>`).join('')}${hidden.map((r) => `<tr class="hidden-row"><th>${esc(r.obs_label_ko)}</th><td>${esc(r.obs_text_ko)}</td></tr>`).join('')}</tbody></table></div>`;
}
const LIST = () => CARDS.filter((m) => m.kind !== 'sweep');
/** 기본 장면(C01)에서 이 시나리오가 바꾼 것. 아침에는 모르는 정보(실제 재고)는 적지 않는다 */
const DELTA = {
  C02: '입고가 하루 늦음 (내일 → 모레 아침)',
  C03: '10팩 이상 한 번에 사면 팩당 9,000원 (10% 할인)',
  C04: '입고가 모레 아침 + 10팩 이상 10% 할인',
  C05: '전산 기록이 72시간 전 값. 실제 재고는 확인 전이라 모름',
  C06: '이미 넣은 주문 5팩이 내일 아침 도착 예정',
  E1: '10팩 이상 10% 할인 + 이 약은 반품 불가',
  E2: '10팩 이상 10% 할인 + 창고가 거의 참',
  E3: '도매 사이트에 이 약이 "재고 부족 예정"으로 표시됨',
  E4: '한글날 연휴로 도매상 휴무. 연휴 전 마지막 주문은 내일 오후까지, 연휴 뒤 첫 도착은 10/12(월)',
};
/** 모든 시나리오가 공통으로 시작하는 기본 조건 (C01). 화면 맨 위에 고정한다 */
function baseBox() {
  const d = computeDay({ date: D0 });
  const env = [
    ['날짜', `${E.dayLabel(D0)}(${d.def.dow}) 8:50`, '연휴 다음 첫 영업일', PUB],
    ['독감', `경기 ${d.def.ili}명`, `1,000명당 · 최근 ${d.def.iliWeek}주`, PUB],
    ['이비인후과', `${d.entH ? d.entH[0] : '-'}시부터 진료`, '화요일 오전 휴진', PUB],
  ];
  const rows = [['약품', '종합감기약', '일반의약품 · 1팩 = 3갑', '']].concat(tileRows(cardById('C01')).map(([a, v, s]) => [a, v, s, '']), [['공급 상태', '주문 가능', '도매 사이트 표시', ''], ['보관 공간', '여유', '', '']]);
  const tile = ([a, v, s, tag]) => `<div class="tile"><span>${a}</span><b>${esc(v)}</b>${s ? `<small>${esc(s)}</small>` : ''}${tag ? `<i class="tile-tag">${tag}</i>` : ''}</div>`;
  return `<details class="box base-box" open>
    <summary><b>기본 조건</b><span>모든 시나리오는 여기서 시작해 조건 하나만 바뀝니다 ${ASSUME}</span></summary>
    <p class="box-k sub">재고와 거래</p><div class="tiles">${rows.map(tile).join('')}</div>
    <p class="box-k sub">그날 환경</p><div class="tiles">${env.map(tile).join('')}</div>
  </details>`;
}
function scenarioStep() {
  const k = card();
  const list = LIST().map((m, i) => {
    const hasAI = !!aiRun(m.id, 'P1'), hasAns = !!answerOf(m.id);
    return `<label class="scn"><input type="radio" name="scn" value="${m.id}" ${m.id === S.cardId ? 'checked' : ''}><span>
      <span class="scn-no">${i + 1}</span>
      <span class="scn-body"><b>${esc(m.title)}</b><small><span class="scn-kind k-${m.kind}">${KIND_KO[m.kind]}${S.layer === 'P2' && DEV_CARDS.includes(m.id) ? ' · 개발용' : ''}</span> ${esc(m.short)}</small></span>
      <span class="scn-st"><i class="${hasAI ? 'on' : ''}" title="AI 답 ${hasAI ? '있음' : '없음'}">AI</i><i class="${hasAns ? 'on' : ''}" title="약사 답 ${hasAns ? '있음' : '없음'}">약사</i></span>
    </span></label>`;
  }).join('');
  const isBase = k.id === 'C01';
  return `
    <h2 class="side-h">어떤 상황을 볼까요?</h2>
    ${baseBox()}
    <div class="scn-list" role="radiogroup" aria-label="시나리오">${list}</div>
    <section class="box scn-card">
      <p class="box-k">시나리오 ${LIST().indexOf(k) + 1} · ${KIND_KO[k.kind]}</p>
      <h3 class="scn-title">${esc(k.title)}</h3>
      <div class="delta${isBase ? ' base' : ''}"><span>${isBase ? '기준 장면' : '기본 조건에서 바뀐 것'}</span><b>${isBase ? '위 기본 조건 그대로입니다. 다른 시나리오는 여기서 하나씩만 바뀝니다.' : esc(DELTA[k.id] || k.short)}</b></div>
      <dl class="dl2">
        <dt>무엇을 보려는가</dt><dd>${esc(k.test)}</dd>
        <dt>지어낸 부분</dt><dd>${VIRT} ${esc(k.invented)}</dd>
      </dl>
      <details class="help"><summary>약사와 AI가 똑같이 받은 정보</summary>${obsTable(k.id, false)}<p class="xs muted" style="margin-top:6px">자물쇠 줄은 아침에는 아무도 모르는 정보라 주지 않습니다.</p></details>
      <details class="help"><summary>약사에게 읽어 준 장면 문장</summary><p class="story">${esc(k.story)}</p></details>
      <details class="help"><summary>이 시나리오를 만든 인터뷰 근거</summary><ul class="basis">${k.basis.map((b) => `<li>${chips(b.ids)}<span>${esc(b.why)}</span></li>`).join('')}</ul></details>
    </section>
    <div class="side-cta"><button class="btn btn-primary" type="button" data-step="2">AI 판단 보기</button></div>`;
}
function seenFacts(k) {
  const c = k.cond, pn = c.prior ? E.PRIOR_ORDER.packs : 0;
  const rows = [
    ['재고 위치', `전산 ${c.book}팩 + 이미 넣은 주문 ${pn}팩 = ${E.positionOf(c)}팩 (선반+창고, ${c.ageH}시간 전 기록)`],
    ['최근 판매', '사흘 내내 하루 5팩 · 개업 초기라 앞으로도 같을지는 불확실'],
    ['도매 단가', c.bulk ? `${E.BULK_MIN}팩 미만 팩당 ${E.won(E.UNIT_COST)} · ${E.BULK_MIN}팩 이상 팩당 ${E.won(c.bulk)} (${E.discountPct(c)}% 할인)` : `팩당 ${E.won(E.UNIT_COST)} (할인 없음)`],
    ['입고', `보통 다음 날 아침 · 이번 주문은 ${E.dayLabel(c.arrival)} 아침`],
    ['반품', c.ret ? '미개봉·유효기간이 남으면 가능' : '불가'],
  ];
  if (c.tight) rows.push(['보관 공간', '창고가 거의 참']);
  if (c.hint) rows.push(['공급 상태', "도매 사이트에 '재고 부족 예정' 표시"]);
  if (c.cutoff) rows.push(['도매 휴무', '한글날 연휴, 연휴 뒤 첫 도착 10/12(월)']);
  return rows;
}
function factorRows(fs) {
  if (!fs || !fs.length) return '<p class="small muted">요인을 적지 않았습니다.</p>';
  const order = ['interview', 'scene', 'observation', 'assumption', 'general_knowledge', ''];
  const sorted = [...fs].sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source));
  return `<ul class="why-list">${sorted.map((f) => {
    const ids = (f.ids || []);
    const cites = ids.map((i) => { const r = lookup(i); return `<span class="cite">${chip(i)}${r ? `<span>${esc(r.title)}</span>` : ''}</span>`; }).join('');
    return `<li>${srcTag(f.source)}<div><span>${esc(f.factor)}</span>${ids.length ? `<div class="why-ids">${cites}</div>` : ''}</div></li>`;
  }).join('')}</ul>`;
}
/* ---------- 같은 조건 반복 결과 읽기 ---------- */
const DEV_CARDS = ['C01', 'C03', 'C05']; // 10/6 응답이 질문으로 삼았거나(C01·C05) 응답 내용(할인)에서 만든(C03) 장면. P2 에서는 평가에 쓰지 않는다
const qtyList = (cardId, layer) => aiRuns(cardId, layer).sort((a, b) => a.rep - b.rep).map((r) => { const l = r.steps[r.steps.length - 1]; return l.action === 'commit_choice' ? (l.qty_packs ?? 0) : null; });
const median = (arr) => { const v = arr.filter((x) => x != null).sort((x, y) => x - y); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const repsText = (cardId, layer) => { const q = qtyList(cardId, layer); return q.length ? `${q.map((x) => (x == null ? '-' : x)).join(' · ')}팩` : '실행 없음'; };
const arrow = (x, y) => (x == null || y == null ? '비교 불가' : x > y ? '▲ 늘어남' : x < y ? '▼ 줄어듦' : '＝ 같음');

const LAYERS = ['B1', 'P0', 'P1', 'P2'];
const LAYER_INFO = { B1: '장면만', P0: '+ 인터뷰 근거', P1: '+ 그날 환경', P2: '+ 10/6 약사 응답' };
/** 정보 수준 4개는 순서가 아니라 서로 독립된 실행이다. 라디오는 화면에 어느 실행의 답을 보일지만 고른다 */
function layerStrip() {
  if (!RUNS) return '';
  const ls = LAYERS.filter((l) => RUNS.layers.includes(l));
  const strip = `<div class="layer-strip l4" role="radiogroup" aria-label="AI에게 준 정보 수준">${ls.map((l) => { const r = aiRun(S.cardId, l); return `<label><input type="radio" name="ailayer" value="${l}" ${l === S.layer ? 'checked' : ''}><span><b>${l}<em>${LAYER_INFO[l]}</em></b><small>${r ? esc(ACTION_LABEL[finalOf(r)] || finalOf(r)) : '실행 없음'}</small></span></label>`; }).join('')}</div>
    <p class="xs muted">네 가지는 순서가 아니라 <b>서로 독립된 실행</b>입니다. 받은 정보만 다릅니다. P1은 약사가 받는 정보와 같습니다.</p>`;
  const rows = ls.map((l) => `<tr class="${l === S.layer ? 'sel' : ''}"><th>${l}</th><td>${esc(repsText(S.cardId, l))}</td><td class="num">${median(qtyList(S.cardId, l)) ?? '-'}</td></tr>`).join('');
  const dev = S.layer === 'P2' && DEV_CARDS.includes(S.cardId);
  return `${strip}<table class="tbl useans-tbl"><thead><tr><th>층</th><th>같은 조건에서 반복한 주문 수량</th><th class="num">중앙값</th></tr></thead><tbody>${rows}</tbody></table>
    ${dev ? '<p class="xs muted">이 시나리오는 10/6 응답이 질문으로 삼았거나 응답 내용에서 만든 장면이라, P2 결과는 평가에 쓰지 않습니다(개발용).</p>' : ''}`;
}

/* ---------- 할인율 스윕 ---------- */
const SWEEP = [[0, 'C01'], [5, 'S05'], [10, 'C03'], [15, 'S15'], [20, 'S20']];
function sweepThreshold(layer) {
  const m = SWEEP.map(([p, id]) => [p, median(qtyList(id, layer))]);
  const m0 = m[0][1];
  if (m0 == null) return null;
  const hit = m.find(([p, v]) => p > 0 && v != null && v > m0);
  return hit ? { pct: hit[0], from: m0, to: hit[1] } : { pct: null, from: m0 };
}
function sweepSVG(layers) {
  const W = 340, H = 200, L = 30, B = 32, T = 12, R = 14, YMAX = E.OFFER.capacity;
  const X = (i) => L + 14 + (i * (W - L - R - 28)) / (SWEEP.length - 1);
  const Y = (v) => T + (1 - v / YMAX) * (H - T - B);
  let g = '';
  [0, 5, 10, 15, 20].forEach((v) => { g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 4}" y="${Y(v) + 3}" text-anchor="end">${v}</text>`; });
  SWEEP.forEach(([p], i) => { g += `<text x="${X(i)}" y="${H - 14}" text-anchor="middle">${p}%</text>`; });
  g += `<text x="${(L + W - R) / 2}" y="${H - 2}" text-anchor="middle" class="axis-t">10팩 이상 할인율 (가정)</text><text x="6" y="${T + 4}" class="axis-t">팩</text>`;
  const b = SWEEP.map(([, id]) => E.b0(cardById(id).cond));
  g += `<polyline class="sw-b0" points="${b.map((x, i) => `${X(i)},${Y(x.need)}`).join(' ')}"><title>B0 필요량 (교과서 계산)</title></polyline>`;
  g += `<polyline class="sw-b0 tier" points="${b.map((x, i) => `${X(i)},${Y(x.withTier)}`).join(' ')}"><title>B0 할인 구간까지 채움</title></polyline>`;
  layers.forEach((layer, li) => {
    const cls = layer === 'P2' ? 'sw-p2' : 'sw-p1';
    const pts = [];
    SWEEP.forEach(([p, id], i) => {
      const q = qtyList(id, layer);
      q.forEach((v, j) => { if (v != null) g += `<circle class="${cls}" cx="${X(i) + (j - (q.length - 1) / 2) * 6 + (li ? 4 : -4)}" cy="${Y(v)}" r="3.4"><title>${esc(layerName(layer))} · 할인 ${p}% · ${v}팩</title></circle>`; });
      const m = median(q); if (m != null) pts.push(`${X(i) + (li ? 4 : -4)},${Y(m)}`);
    });
    if (pts.length > 1) g += `<polyline class="${cls} line" points="${pts.join(' ')}"/>`;
  });
  return `<svg class="hour-chart sweep-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="할인율을 0에서 20퍼센트로 올릴 때 AI 주문 수량. 점은 시도별 수량, 선은 중앙값, 점선은 교과서 계산입니다.">${g}</svg>`;
}
function sweepSection() {
  if (!RUNS) return '';
  const layers = ['P1', 'P2'].filter((l) => RUNS.layers.includes(l) && SWEEP.some(([, id]) => aiRuns(id, l).length));
  const head = `<section class="box sweep"><h2 class="box-k">할인율이 몇 %부터 주문을 바꾸나 ${ASSUME}</h2>`;
  if (!layers.length) return `${head}<p class="small muted">할인율 스윕 결과가 아직 없습니다. <code>python scripts/run_persona.py --cards all</code> 을 실행하면 채워집니다.</p></section>`;
  const thr = layers.map((l) => ({ l, t: sweepThreshold(l) }));
  const rows = SWEEP.map(([p, id]) => { const b = E.b0(cardById(id).cond); return `<tr><th>${p}%</th>${layers.map((l) => `<td>${esc(repsText(id, l))}</td>`).join('')}<td class="num">${b.need}${b.withTier !== b.need ? ` / ${b.withTier}` : ''}팩</td></tr>`; }).join('');
  return `${head}
    <p class="small">기본 장면에서 10팩 이상 할인율만 바꿔 물었습니다.</p>
    <div class="sw-legend"><span><i class="sw-dot p1"></i>${esc(layerName('P1'))}</span>${layers.includes('P2') ? `<span><i class="sw-dot p2"></i>${esc(layerName('P2'))}</span>` : ''}<span><i class="sw-dash"></i>B0 필요량 / 할인 구간까지</span></div>
    ${sweepSVG(layers)}
    <ul class="small sw-thr">${thr.map(({ l, t }) => `<li><b>${esc(layerName(l))}</b> ${t == null ? '결과 없음' : t.pct == null ? `0~20% 구간에서 중앙값이 ${t.from}팩에서 늘지 않았습니다` : `할인 ${t.pct}%에서 처음 중앙값이 ${t.from}팩에서 ${t.to}팩으로 늘었습니다`}</li>`).join('')}</ul>
    <details class="help"><summary>표로 보기</summary><div class="tbl-wrap"><table class="tbl"><thead><tr><th>할인율</th>${layers.map((l) => `<th>${esc(layerName(l))} (시도별)</th>`).join('')}<th class="num">B0 필요량 / 할인 포함</th></tr></thead><tbody>${rows}</tbody></table></div></details>
    <p class="xs muted" style="margin-top:6px">3번 반복이라 방향만 봅니다. 할인 구간과 할인율은 가정입니다.</p>
  </section>`;
}

/* ---------- AI 판단 화면: 결과 카드 → 상황 타일 → 핵심 이유 → 근거 → 자세히 ---------- */
const sentences = (t) => String(t || '').split(/(?<=[.다요])\s+/).filter(Boolean);
/** 상황 타일 줄. 기본 장면(C01)에서 바뀐 조건에는 chg 를 붙인다 (실물 재고는 아침에는 모르므로 비교하지 않는다) */
function tileRows(k) {
  const c = k.cond, pn = c.prior ? E.PRIOR_ORDER.packs : 0, base = cardById('C01');
  const diff = (...f) => (k.id !== 'C01' && f.some((x) => base.cond[x] !== c[x]) ? ' chg' : '');
  const t = [
    ['재고 위치', `${E.positionOf(c)}팩`, `전산 ${c.book}(${c.ageH}시간 전) + 주문 ${pn}`, diff('book', 'prior', 'ageH')],
    ['하루 판매', '5팩', '사흘 내내', ''],
    ['도매 단가', E.won(E.UNIT_COST), c.bulk ? `${E.BULK_MIN}팩↑ ${E.won(c.bulk)} (-${E.discountPct(c)}%)` : '할인 없음', diff('bulk')],
    ['입고', `${E.dayLabel(c.arrival)} 아침`, '보통 다음 날', diff('arrival')],
    ['반품', c.ret ? '가능' : '불가', c.ret ? '미개봉·유효기간 남을 때' : '', diff('ret')],
  ];
  if (c.tight) t.push(['보관 공간', '거의 참', '', ' chg']);
  if (c.hint) t.push(['공급 상태', '재고 부족 예정', '도매 사이트 표시', ' chg']);
  if (c.cutoff) t.push(['도매 휴무', '한글날 연휴', '연휴 뒤 10/12 도착', ' chg']);
  return t;
}
function tilesOf(k) {
  return `<div class="tiles">${tileRows(k).map(([a, v, s, cls]) => `<div class="tile${cls}"><span>${a}</span><b>${esc(v)}</b>${s ? `<small>${esc(s)}</small>` : ''}</div>`).join('')}</div>`;
}
/** 근거: 요인 문구와 번호 칩만. 번호의 제목은 칩을 눌러 본다 */
function factorBox(fs) {
  if (!fs || !fs.length) return '<p class="small muted">요인을 적지 않았습니다.</p>';
  const order = ['interview', 'scene', 'observation', 'assumption', 'general_knowledge', ''];
  const sorted = [...fs].sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source));
  return `<ul class="why-compact">${sorted.map((f) => `<li>${srcTag(f.source)}<span>${esc(f.factor)}</span>${(f.ids || []).length ? chips(f.ids) : ''}</li>`).join('')}</ul>`;
}
function aiStep() {
  const k = card(), run = aiRun(S.cardId);
  if (!run) {
    return `<h2 class="side-h">AI 판단</h2>${layerStrip()}<div class="empty"><b>이 시나리오의 AI 답이 아직 없습니다.</b><p>운영진이 AI 실행을 돌리면 이곳에 나타납니다.</p></div>${sweepSection()}`;
  }
  const r = S.replay.i;
  const steps = run.steps, first = steps[0], last = steps[steps.length - 1];
  const checked = first.action === 'check_physical_stock';
  const fin = finalOf(run), qAi = qtyOf(fin);
  const show = (n) => (r >= n ? '' : ' hidden-step');
  const nFinal = checked ? 2 : 1;
  const b = E.b0(k.cond);
  const qtys = [...new Set([0, b.need, b.withTier, ...(qAi != null ? [qAi] : [])])].sort((x, y) => x - y);
  const res = E.runAll(k.cond, E.DEMAND, qtys);
  const tagsOf = (q) => [q === 0 ? badge('neutral', '보류') : '', q === b.need ? badge('hyp', 'B0 필요량') : '', b.withTier !== b.need && q === b.withTier ? badge('hyp', 'B0 할인 포함') : '', q === qAi ? badge('neutral', 'AI 선택') : ''].filter(Boolean).join(' ');
  const resRows = res.map((x) => `<tr class="${x.packs === qAi ? 'sel' : ''}"><td>${x.packs}팩 ${tagsOf(x.packs)}</td><td class="num">${x.metrics.unmetTotal}명</td><td class="num">${x.metrics.endingPacks}팩</td><td class="num">${E.won(x.metrics.newCommitKrw)}</td></tr>`).join('');
  const oneLine = (() => { const f = sentences(last.reason)[0] || ''; return f.length > 120 ? `${f.slice(0, 118)}…` : f; })();
  const flags = [...new Set(run.flags.map(flagText))];
  const nRuns = aiRuns(S.cardId, run.layer).length;
  return `
    <h2 class="side-h">AI 판단</h2>
    ${layerStrip()}
    <section class="box ai-hero${show(nFinal)}">
      <p class="box-k">AI 최종 판단</p>
      <p class="hero-v">${esc(ACTION_LABEL[fin] || fin)}${last.strategy ? `<span class="hero-tag">${esc(E.STRATEGY_KO[last.strategy] || last.strategy)}</span>` : ''}</p>
      <div class="hero-sub">
        <span>같은 조건 ${nRuns}번<b>${esc(repsText(S.cardId, run.layer).replace('팩', ''))}팩</b></span>
        <span>B0 · 교과서 계산<b>${b.need}팩${b.withTier !== b.need ? ` · 할인 포함 ${b.withTier}팩` : ''}</b></span>
      </div>
    </section>
    <section class="box${show(0)}"><p class="box-k">AI가 본 상황 ${VIRT}</p>${tilesOf(k)}</section>
    ${checked ? `<section class="box step-act${show(1)}"><p class="box-k">먼저 한 행동</p><p class="act-line"><b>실물 확인</b><span>선반·창고 합계 <b>${k.cond.physical}팩</b>${k.cond.physical !== k.cond.book ? ` (전산보다 ${k.cond.book - k.cond.physical}팩 적음)` : ' (전산과 같음)'}</span></p></section>` : ''}
    <section class="box${show(nFinal)}"><p class="box-k">핵심 이유</p>
      ${(last.priorities || []).length ? `<div class="pri-chips">${last.priorities.map((p) => `<span>${esc(p)}</span>`).join('')}</div>` : ''}
      <p class="why-one">${esc(oneLine)}</p>
      ${factorBox(last.factors)}
    </section>
    ${flags.length ? `<p class="flag-line"><b>자동 점검 ${flags.length}건</b> ${flags.map(esc).join(' · ')}</p>` : ''}
    <details class="help"><summary>자세히 (이유 전문 · 교과서 계산 · 사흘 뒤 결과)</summary>
      <p class="small"><b>교과서 계산 B0</b> ${ASSUME} 목표재고 = 하루 ${b.d}팩 × (점검 ${b.R}일 + 입고 ${b.L}일) + 안전재고 ${b.SS}팩 = ${b.target}팩. 재고 위치 ${b.pos}팩을 빼면 필요량 ${b.need}팩${b.withTier !== b.need ? `, 할인 구간(${E.BULK_MIN}팩)까지 채우면 ${b.withTier}팩` : ''}. AI에게는 보여 주지 않았고 정답이 아닙니다. 반품·공간·품절은 이 식에 없습니다.</p>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>주문 수량</th><th class="num">못 판 손님</th><th class="num">남는 재고</th><th class="num">새 주문 금액</th></tr></thead><tbody>${resRows}</tbody></table></div>
      <p class="xs muted">하루 5명이 찾는다는 가정의 계산 ${VIRT}</p>
      <p class="small"><b>AI가 쓴 이유 전문</b><br>${esc(last.reason)}</p>
      ${checked ? `<p class="small"><b>처음 판단 (실물 확인 전)</b><br>${esc(first.reason)}</p>` : ''}
      ${(last.missing_info || []).length ? `<p class="small"><b>더 알고 싶다고 한 것</b><br>${last.missing_info.map(esc).join(' · ')}</p>` : ''}
      <p class="xs muted">모델 ${esc(RUNS.model)} · ${esc(String(RUNS.created_at).replace('T', ' ').slice(0, 16))} · ${run.rep}번째 시도</p></details>
    ${sweepSection()}
    <div class="side-cta"><button class="btn" type="button" data-replay="1">3D에서 다시 보기</button><button class="btn btn-primary" type="button" data-step="3">약사 답과 비교</button></div>`;
}
/* ---------- 변수별 영향: 조건 하나를 바꿨을 때 AI 수량이 어느 쪽으로, 얼마나 움직였나 ---------- */
// [배지 색, 짧은 이름, 한 줄 뜻]
const JUDGE = {
  signal: ['good', '차이가 확실함', 'AI를 3번 돌린 결과가 기준 장면의 결과와 하나도 겹치지 않습니다.'],
  few: ['neutral', '표본 부족', '3번 반복이라 차이가 있는지 없는지 말할 수 없습니다. 더 많이 돌려야 합니다.'],
  cap: ['hyp', '비교 어려움', '기준 장면이 이미 10팩(할인 구간)이라 할인으로 더 늘어날 여지가 없거나, 줄어들 가설인데 이미 0입니다.'],
  none: ['unknown', '결과 없음', '기준 장면이나 이 장면의 AI 답이 아직 없습니다.'],
};
const HYP_DIR_KO = { up: '늘어남', down: '줄어듦', up_or_same: '같거나 늘어남', down_or_same: '같거나 줄어듦' };
const EFFECT_IDS = ['C02', 'C03', 'C04', 'C05', 'C06', 'E1', 'E2', 'E3', 'E4'];
/** 판정 규칙(위에서부터 먼저 맞는 것):
 *  비교 불가 = 기준 장면이나 이 장면의 결과가 없음
 *  신호 있음 = 이 장면의 반복 결과가 기준 장면의 반복 결과와 겹치지 않고 한쪽에 있음 (3번 반복 기준 매우 엄격한 조건)
 *  천장에 막힘 = 할인 장면인데 기준 장면 중앙값이 이미 할인 구간 수량(10팩) 이상이라 더 늘 이유가 안 보임 / 바닥에 막힘 = 줄어들 가설인데 기준이 이미 0
 *  표본 부족 = 그 밖 (겹치거나 변화가 안 보임. 3번으로는 "효과 없음"도 확인할 수 없다) */
function effectOf(cardId, layer) {
  const spec = DB.specById.get(cardId), baseId = spec && spec.base_card_id;
  if (!baseId) return { state: 'none' };
  const a = qtyList(baseId, layer).filter((x) => x != null), c = qtyList(cardId, layer).filter((x) => x != null);
  if (!a.length || !c.length) return { state: 'none', why: !a.length && !c.length ? '기준 장면과 이 장면 모두 AI 결과가 없습니다.' : !c.length ? '이 장면의 AI 결과가 아직 없습니다.' : '기준 장면의 AI 결과가 없습니다.', reps: '' };
  const ma = median(a), mc = median(c), d = mc - ma, dir = spec.hypothesis_dir || '';
  let state, why = '';
  const baseShort = cardById(baseId).short;
  if (Math.min(...c) > Math.max(...a) || Math.max(...c) < Math.min(...a)) state = 'signal';
  else if (dir.startsWith('up') && ma >= E.BULK_MIN && cardById(cardId).cond.bulk && !cardById(baseId).cond.bulk) {
    state = 'cap';
    why = `기준 장면(${baseShort})의 중앙값이 이미 ${ma}팩이라 할인 구간(${E.BULK_MIN}팩)보다 더 늘 여지가 없어, 할인 효과가 있어도 보이지 않습니다.`;
  } else if (dir === 'down' && Math.max(...a) <= 0) {
    state = 'cap';
    why = `기준 장면(${baseShort})이 이미 0팩이라 더 줄어들 수 없습니다.`;
  } else state = 'few';
  let match = null;
  if (state === 'signal' && dir) match = (d > 0 ? dir.startsWith('up') : dir.startsWith('down')) ? 'same' : 'opp';
  return { state, ma, mc, d, match, why, reps: `기준 ${a.join('·')} / 이 장면 ${c.join('·')}` };
}
const fmtD = (d) => (d > 0 ? `+${d}` : d < 0 ? `−${Math.abs(d)}` : '0');
function effectsBox() {
  const layer = S.layer;
  const rows = EFFECT_IDS.map((id) => {
    const spec = DB.specById.get(id), k = cardById(id), base = cardById(spec.base_card_id);
    const ef = effectOf(id, layer);
    const b0d = E.b0(k.cond).withTier - E.b0(base.cond).withTier;
    const [jc, jt] = JUDGE[ef.state];
    const pre = spec.hypothesis_when === '사전';
    const matchTxt = ef.match ? (ef.match === 'same' ? '예상대로' : '예상과 반대') : '';
    const matchCell = ef.match ? (pre ? badge(ef.match === 'same' ? 'good' : 'bad', matchTxt) : `<span class="xs muted">참고 · ${matchTxt}</span>`) : '<span class="xs muted">예상 확인 불가</span>';
    return `<tr class="${id === S.cardId ? 'sel' : ''}">
      <td><b>${esc(DELTA[id] || k.short)}</b><br><span class="xs muted">기준: ${esc(base.short)}</span></td>
      <td><span class="htip" tabindex="0">${esc(HYP_DIR_KO[spec.hypothesis_dir] || '-')} ${badge(pre ? 'interview' : 'neutral', spec.hypothesis_when || '-')}<br><span class="xs muted htip-prev">${esc(spec.hypothesis_basis)}</span><span class="htip-pop" role="tooltip"><b>가설 (${esc(spec.hypothesis_when)})</b>${esc(spec.hypothesis_ko)}<b>근거</b>${esc(spec.hypothesis_basis)}</span></span></td>
      <td class="num">${fmtD(b0d)}</td>
      <td class="num">${ef.state === 'none' ? '-' : `${ef.ma}→${ef.mc} <b>(${fmtD(ef.d)})</b>`}</td>
      <td>${badge(jc, jt)}<br>${matchCell}${ef.why ? `<p class="why-judge ${ef.state}">${esc(ef.why)}</p>` : ''}${ef.reps ? `<p class="xs muted reps-line">${esc(ef.reps)}</p>` : ''}</td></tr>`;
  }).join('');
  const all = EFFECT_IDS.map((id) => `<tr><th>${esc(DELTA[id] || cardById(id).short)}</th>${LAYERS.filter((l) => RUNS.layers.includes(l)).map((l) => { const e = effectOf(id, l); return `<td>${e.state === 'none' ? '-' : `${fmtD(e.d)} <span class="xs muted">${JUDGE[e.state][1]}</span>`}</td>`; }).join('')}</tr>`).join('');
  const cnt = EFFECT_IDS.reduce((m, id) => { const s = effectOf(id, layer).state; m[s] = (m[s] || 0) + 1; return m; }, {});
  return `<section class="box effects"><p class="box-k">변수별 영향 · <b class="lay-now">${esc(layerName(layer))}</b></p>
    <p class="small">조건 하나를 바꿨을 때 AI 주문 수량(중앙값)이 얼마나 움직였는지입니다. ${EFFECT_IDS.length}개 중 차이가 확실함 ${cnt.signal || 0} · 표본 부족 ${cnt.few || 0} · 비교 어려움 ${cnt.cap || 0} · 결과 없음 ${cnt.none || 0}</p>
    <ul class="judge-legend">${Object.values(JUDGE).map(([c, t, d]) => `<li>${badge(c, t)}<span>${esc(d)}</span></li>`).join('')}</ul>
    <div class="tbl-wrap"><table class="tbl eff-tbl"><thead><tr><th>바뀐 조건</th><th>가설 (예상 방향)</th><th class="num">B0<br><span class="xs muted">교과서</span></th><th class="num">AI<br><span class="xs muted">기준→이 장면</span></th><th>결과 판정</th></tr></thead><tbody>${rows}</tbody></table></div>
    <details class="help"><summary>다른 정보 수준에서는? (변화 폭)</summary><div class="tbl-wrap"><table class="tbl"><thead><tr><th>바뀐 조건</th>${LAYERS.filter((l) => RUNS.layers.includes(l)).map((l) => `<th>${l}</th>`).join('')}</tr></thead><tbody>${all}</tbody></table></div></details>
    <details class="help"><summary>가설의 "사전 · 사후"는 무슨 뜻인가요?</summary><ul class="small b0-notes">
      <li><b>사전</b> AI 결과가 나오기 전에 적은 예상입니다. 이 예상과 같은지·반대인지만 판정에 씁니다.</li>
      <li><b>사후</b> 결과를 본 뒤 정리한 문장입니다. 방향은 교과서 계산이나 약사 응답에서 가져왔지만, 참고로만 표시하고 판정에는 쓰지 않습니다.</li>
      <li>예상은 결과를 본 뒤에 고치지 않습니다. 틀렸으면 "예상과 반대"로 남습니다.</li>
      <li>약사 답은 수량이 없어 이 표에서 비교하지 않고 가설의 근거로만 씁니다. B0 열은 교과서 계산(할인 포함 기준)의 변화입니다.</li></ul></details>
  </section>`;
}
function cmpTile(who, big, sub, cls = '') {
  return `<div class="cmp-tile ${cls}"><span class="cmp-who">${who}</span><b>${big}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
}
function compareStep() {
  const k = card(), run = aiRun(S.cardId), ans = answerOf(S.cardId), b = E.b0(k.cond);
  const aiFirst = run ? run.steps[0].action === 'check_physical_stock' ? 'check_physical_stock' : finalOf(run) : null;
  const aiFin = run ? finalOf(run) : null;
  const last = run ? run.steps[run.steps.length - 1] : null;
  const none = '<span class="muted">-</span>';
  const wait = '<span class="muted">대기 중</span>';
  const qty = aiFin ? qtyOf(aiFin) : null;
  const aiOrders = qty == null ? null : qty > 0;
  const ansQ = ans ? qtyOf(ans.final_choice) : null;
  const ansOrders = ans ? (ans.final_choice === 'order_open' ? true : ansQ != null ? ansQ > 0 : null) : null;
  const inRange = ans && qty != null && ans.qty_min !== '' && ans.qty_max !== '' ? qty >= Number(ans.qty_min) && qty <= Number(ans.qty_max) : null;
  const m1 = ans && run && ans.first_action ? badge(ans.first_action === aiFirst ? 'good' : 'bad', `먼저 한 행동 ${ans.first_action === aiFirst ? '같음' : '다름'}`) : '';
  const mOrder = aiOrders != null && ansOrders != null ? badge(aiOrders === ansOrders ? 'good' : 'bad', `발주 여부 ${aiOrders === ansOrders ? '같음' : '다름'}`) : '';
  const m2 = inRange == null ? '' : badge(inRange ? 'good' : 'bad', inRange ? '약사 범위 안' : '약사 범위 밖');
  const badges = [mOrder, m1, m2].filter(Boolean).join(' ');
  const aiSub = last ? [last.strategy ? E.STRATEGY_KO[last.strategy] || last.strategy : '', aiFirst === 'check_physical_stock' ? '먼저 실물 확인' : ''].filter(Boolean).join(' · ') : '';
  const phBig = ans ? (ans.final_choice === 'order_open' ? '주문' : esc(ACTION_LABEL[ans.final_choice] || ans.final_choice)) : wait;
  const phSub = ans ? (ans.qty_min !== '' ? `괜찮다고 본 범위 ${esc(ans.qty_min)}~${esc(ans.qty_max)}팩` : '수량은 답하지 않음') : '';
  const oneLine = (t) => { const s = sentences(t)[0] || ''; return s.length > 120 ? `${s.slice(0, 118)}…` : s; };
  const phReason = ans ? (ans.reason_quote_ko ? `"${ans.reason_quote_ko}"` : ans.answer_ko || '') : '';
  return `
    <h2 class="side-h">AI 답 · 약사 답 · 교과서 계산</h2>
    ${layerStrip()}
    <section class="box"><p class="box-k">최종 판단 비교</p>
      <div class="cmp-tiles">
        ${cmpTile(`AI <em>페르소나</em>`, run ? esc(ACTION_LABEL[aiFin] || aiFin) : none, aiSub, 'ai')}
        ${cmpTile(`약사 <em>인터뷰 응답자</em>`, phBig, phSub)}
        ${cmpTile(`B0 <em>교과서 계산</em>`, `${b.need}팩`, b.withTier !== b.need ? `할인 포함 ${b.withTier}팩` : '교과서 계산')}
      </div>
      ${badges ? `<p class="cmp-badges">${badges}</p>` : ''}
      ${ans ? '' : '<p class="xs muted">약사 답이 아직 없습니다. 이 시나리오를 약사에게 물어 받은 답이 들어오면 가운데 칸이 채워집니다.</p>'}
    </section>
    <section class="box"><p class="box-k">이유 (한 문장씩)</p>
      <div class="cmp-cols">
        <div><span class="cmp-who">AI</span><p>${last ? esc(oneLine(last.reason)) : none}</p></div>
        <div><span class="cmp-who">약사</span><p class="clip">${ans ? esc(phReason) || none : wait}</p></div>
        <div><span class="cmp-who">B0</span><p>${b.d}×(${b.R}+${b.L})+${b.SS} = ${b.target}팩에서 재고 위치 ${b.pos}팩을 뺀 값</p></div>
      </div>
    </section>
    ${effectsBox()}
    <details class="help"><summary>중요하게 본 것 · 더 알고 싶은 것 · 약사에게 실제로 물은 것</summary>
      <p class="small"><b>AI가 중요하게 본 것</b><br>${last && last.priorities ? last.priorities.map(esc).join(' · ') : '-'}</p>
      <p class="small"><b>AI가 더 알고 싶다고 한 것</b><br>${last && last.missing_info ? last.missing_info.map(esc).join(' · ') : '-'}</p>
      ${ans ? `<p class="small"><b>약사가 중요하게 본 것</b><br>${[ans.priority_1_ko, ans.priority_2_ko].filter(Boolean).map(esc).join(' · ') || '-'}</p><p class="small"><b>약사가 더 알고 싶다고 한 것</b><br>${esc(ans.need_more_ko) || '-'}</p>` : ''}
      ${ans && ans.question_ko ? `<p class="small"><b>약사에게 한 질문</b><br>${esc(ans.question_ko)}</p><p class="small"><b>답 (팀원이 정리해 전달)</b><br>${esc(ans.answer_ko)}</p>${ans.note_ko ? `<p class="xs muted">${esc(ans.note_ko)}</p>` : ''}` : ''}
    </details>
    <p class="xs muted" style="margin-top:10px">맞고 틀림을 판정하지 않습니다. 응답자가 1명이라 어디서 다른지 찾는 용도입니다.</p>
    <div class="side-cta"><button class="btn btn-primary" type="button" data-step="4">근거에 추가할지 정하기</button></div>`;
}
const DEC_KEY = 'pp-ev-decisions';
const decisions = () => store.get(DEC_KEY, {});
function evidenceStep() {
  const ans = answerOf(S.cardId);
  const head = `<h2 class="side-h">근거에 추가할지 정하기</h2>
    <p class="small">약사 답에 <b>인터뷰에 없던 판단 기준이나 경험</b>이 있으면 근거 후보로 올립니다. 페르소나가 다음에 참고하는 학습 데이터가 됩니다.</p>
    <div class="callout" style="margin:10px 0"><p><b>AI 답은 근거가 되지 않습니다.</b> 근거는 약사 본인의 말에서만 나옵니다. 후보로 올린 내용은 운영진이 검토해 원본 인터뷰 자료에 넣은 뒤에 반영되고, 그때부터 이 시나리오는 연습용이 됩니다.</p></div>`;
  if (!ans) return `${head}<div class="empty"><b>검토할 약사 답이 없습니다.</b><p>약사 답이 들어오면 약사가 한 말이 여기에 항목별로 나옵니다.</p></div>`;
  const items = [['reason_quote_ko', '약사가 한 말'], ['answer_ko', '약사 답 (팀원이 정리해 전달)'], ['priority_1_ko', '중요하게 본 것 1'], ['priority_2_ko', '중요하게 본 것 2'], ['need_more_ko', '더 알고 싶다고 한 것']].filter(([f]) => ans[f]);
  const d = decisions();
  return `${head}<ul class="ev-dec">${items.map(([f, lab]) => {
    const key = `${S.cardId}|${ans.round}|${f}`, v = d[key] || '';
    return `<li><p class="xs muted">${lab}</p><p>"${esc(ans[f])}"</p><div class="seg small" role="radiogroup" aria-label="${lab} 결정">${[['candidate', '근거 후보로'], ['hold', '보류'], ['reject', '추가 안 함']].map(([val, t]) => `<label><input type="radio" name="dec-${f}" value="${val}" data-dec="${esc(key)}" ${v === val ? 'checked' : ''}><span>${t}</span></label>`).join('')}</div></li>`;
  }).join('')}</ul><p class="xs muted">결정은 이 브라우저에 저장되고, "운영 메모" 탭에서 모아 볼 수 있습니다.</p>`;
}
function simSide() {
  const body = S.step === 1 ? scenarioStep() : S.step === 2 ? aiStep() : S.step === 3 ? compareStep() : evidenceStep();
  return `<header class="side-head"><p class="kicker">시뮬레이션 · 약사 시점</p><h1 id="h-sim" tabindex="-1">${esc(card().title)}</h1>${stepper()}</header><div class="side-body">${body}</div>`;
}

/* ---------- AI 판단 재생 (3D 1인칭) ---------- */
function caption(text) { const el = $('#fp-caption'); el.hidden = !text; el.innerHTML = text || ''; }
function stopReplay() { clearTimeout(S.replay.timer); }
function startReplay() {
  stopReplay();
  const run = aiRun(S.cardId), k = card();
  S.checked = false; S.replay.i = -1;
  if (!run) { caption(''); render(); return; }
  const checked = run.steps[0].action === 'check_physical_stock';
  const fin = finalOf(run);
  const seq = [
    () => { sc && sc.firstPerson('front'); caption(`<b>AI</b> 카운터 전산을 봅니다 · 전산 재고 ${k.cond.book}팩 (${k.cond.ageH}시간 전 기록)`); },
    ...(checked ? [() => { S.checked = true; sc && sc.firstPerson('shelf'); applyScene(); caption(`<b>AI</b> 선반과 창고부터 확인합니다 · 실제로는 합계 <b>${k.cond.physical}팩</b>`); }] : []),
    () => { sc && sc.firstPerson('front'); caption(`<b>AI 최종 판단</b> ${esc(ACTION_LABEL[fin] || fin)}`); },
  ];
  const go = (i) => {
    S.replay.i = i; seq[i](); renderSide(); markLook();
    if (i < seq.length - 1) S.replay.timer = setTimeout(() => go(i + 1), reduceMotion() ? 0 : 2600);
  };
  go(0);
}
function markLook() { $$('#fp-ui [data-look]').forEach((b) => b.setAttribute('aria-pressed', String(sc && sc.isFirstPerson && b.dataset.look === (S.checked && S.replay.i === 1 ? 'shelf' : 'front')))); }

/* ---------- 왼쪽 위 드롭다운: 판단 품목 재고와 범례 ---------- */
function renderDropdown() {
  const c = card().cond;
  const real = S.mode === 'sim' && S.checked ? `${c.physical}팩 (확인함)` : '확인 전 (모름)';
  $('#dd-body').innerHTML = `
    <p class="dd-k">판단 품목 ${VIRT}</p>
    <p class="small" style="margin:0 0 6px">종합감기약(정제). 한 갑 10정, 한 팩은 3갑 묶음입니다. 재고는 선반과 창고를 합친 수량입니다.</p>
    <ul class="dd-facts"><li><i class="sw ghost"></i><span>전산 기록</span><b>${c.book}팩</b></li><li><i class="sw solid"></i><span>실제 (선반·창고)</span><b>${real}</b></li></ul>
    <p class="dd-k">손님 옷 색 = 들어온 길</p>
    <ul class="dd-leg">${Object.values(ROUTE).map((r) => `<li><i class="sw" style="background:${r.c}"></i>${r.t}</li>`).join('')}</ul>
    <p class="dd-k">나갈 때 발 아래 원 ${ASSUME}</p>
    <ul class="dd-leg"><li><i class="sw round" style="background:#2f8f4e"></i>바로 받음</li><li><i class="sw round" style="background:#e0a100"></i>기다림</li><li><i class="sw round" style="background:#d23b2a"></i>기다리다 감</li></ul>
    <p class="xs muted" style="margin:6px 0 0">초록 명찰이 인터뷰한 약사, 파란 명찰은 다른 약사입니다. 인물 1명 = 손님 2명.</p>`;
}

/* ---------- 재생 (기본 보기) ---------- */
function setPlaying(on) {
  S.playing = on;
  if (sc) {
    if (on) { const fi = sc.flowInfo(); if (fi.closed || fi.date !== S.env.date) { sc.setFlow({ date: null }); sc.resetDay(); sc.setFlow({ date: S.env.date }); } }
    sc.setFlow({ running: on });
  }
  renderPlay();
}
function renderPlay() {
  $('#play-label').textContent = S.playing ? '멈춤' : '하루 재생';
  $('#play-icon').setAttribute('href', S.playing ? '#i-pause' : '#i-play');
  $$('#speed-seg input').forEach((i) => { i.checked = i.value === S.speed; });
}
function updateClock() {
  if (!sc) return;
  const fi = sc.flowInfo();
  const m = Math.min(fi.clock, 19 * 60), hh = Math.floor(m / 60), mm = String(Math.floor(m % 60)).padStart(2, '0');
  const came = fi.spawned * fi.perFigure;
  $('#play-clock').textContent = fi.date ? `${E.dayLabel(fi.date)} ${hh}:${mm}${fi.closed ? ' · 영업 끝' : ''}` : '재생 전';
  $('#play-count').textContent = fi.date ? `지금까지 약 ${came}명 왔습니다 (인물 1명 = 손님 ${fi.perFigure}명)` : '';
  if (S.playing && fi.closed && fi.onScreen === 0) { setPlaying(false); toast('하루 영업이 끝났습니다. 날짜나 환경을 바꿔 다시 재생해 보세요.'); }
}

/* ---------- 모드 전환 ---------- */
function applyMode() {
  const sim = S.mode === 'sim';
  $('#view-simulate .sim2').dataset.mode = S.mode;
  $$('#mode-seg input').forEach((i) => { i.checked = i.value === S.mode; });
  $('#fp-ui').hidden = !sim;
  $('#basic-play').hidden = sim;
  $('#view-tools').hidden = sim;
  $('#stage').classList.toggle('fpv', sim);
  if (!sim) caption('');
  if (!sc) return;
  if (sim) { sc.setDemand({ hours: flowHours(computeDay({ date: D0 })), open: true, ili: computeDay({ date: D0 }).ili, perFigure: 2 }); sc.setFlow({ date: D0, running: !reduceMotion() }); sc.firstPerson(S.checked ? 'shelf' : 'front'); }
  else { stopReplay(); sc.flyTo('overview'); sc.setFlow({ date: null, running: false }); } // 시뮬레이션 모드의 손님은 비우고 기본 보기는 재생 전으로
}
export function setMode(m, { intro = true } = {}) {
  if (m === S.mode) return;
  S.mode = m;
  if (m === 'sim') {
    setPlaying(false);
    S.step = 1; S.checked = false; S.replay.i = -1;
    applyMode(); applyScene(); render();
    if (intro && !store.raw('pp-sim-intro-off')) openIntro();
  } else { applyMode(); applyScene(); render(); }
}
function openIntro() { const d = $('#sim-intro'); if (d.showModal && !d.open) d.showModal(); $('#intro-start').focus(); }
$('#intro-start').addEventListener('click', () => { if ($('#intro-off').checked) store.setRaw('pp-sim-intro-off', '1'); $('#sim-intro').close(); });
$('#btn-sim-help').addEventListener('click', openIntro);

/* ---------- 렌더 ---------- */
function renderSide() { $('#side').innerHTML = S.mode === 'sim' ? simSide() : basicSide(); }
function render() { renderSide(); renderDropdown(); renderPlay(); }
function goStep(n) {
  S.step = n; render(); $('#side').scrollTop = 0;
  if (n === 2) startReplay(); else { stopReplay(); caption(n === 1 ? '' : $('#fp-caption').innerHTML); }
  const h = $('#side .side-h'); h && (h.tabIndex = -1, h.focus({ preventScroll: true }));
}

/* ---------- 이벤트 ---------- */
$('#side').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.step) goStep(Number(b.dataset.step));
  else if (b.dataset.replay) startReplay();
  else if (b.dataset.resetEnv) { if (b.dataset.resetEnv === 'env-ili') S.env.ili = null; else S.env.temp = null; envChanged(); }
});
$('#side').addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'env-ili' || t.id === 'env-temp') {
    S.env[t.id === 'env-ili' ? 'ili' : 'temp'] = Number(t.value);
    $(`#${t.id}-out`).innerHTML = `${Number(t.value).toFixed(1)}<small>${t.id === 'env-temp' ? '℃' : ''}</small>`;
    clearTimeout(tick); tick = setTimeout(envChanged, 120);
  }
});
$('#side').addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'env-date') { S.env = { date: t.value, ili: null, temp: null, rain: null, dust: S.env.dust }; if (S.playing) setPlaying(false); envChanged(); if (sc) { sc.setFlow({ date: null }); } }
  else if (t.id === 'env-rain') { S.env.rain = t.checked; envChanged(); }
  else if (t.id === 'env-dust') { S.env.dust = t.checked; envChanged(); }
  else if (t.name === 'scn') { S.cardId = t.value; S.checked = false; S.replay.i = -1; caption(''); if (sc) sc.firstPerson('front'); applyScene(); render(); }
  else if (t.name === 'ailayer') { S.layer = t.value; if (S.step === 2) startReplay(); else render(); }
  else if (t.dataset.dec) { const d = decisions(); d[t.dataset.dec] = t.value; store.set(DEC_KEY, d); toast(t.value === 'candidate' ? '근거 후보로 표시했습니다. 운영진 검토 전까지는 근거가 아닙니다.' : '결정을 저장했습니다.'); }
});
function envChanged() {
  const keepFocus = document.activeElement && document.activeElement.id;
  applyScene(); renderSide();
  if (keepFocus) { const el = document.getElementById(keepFocus); el && el.focus({ preventScroll: true }); }
}
$('#mode-seg').addEventListener('change', (e) => { if (e.target.name === 'simmode') setMode(e.target.value); });
$('#basic-play').addEventListener('click', (e) => { const b = e.target.closest('#btn-play'); if (b) setPlaying(!S.playing); });
$('#speed-seg').addEventListener('change', (e) => { S.speed = e.target.value; sc && sc.setSpeed(SPEED[S.speed]); });
$('#fp-ui').addEventListener('click', (e) => { const b = e.target.closest('[data-look]'); if (b && sc) { sc.firstPerson(b.dataset.look); $$('#fp-ui [data-look]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); } });
$('#view-tools').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b || !sc) return;
  if (b.dataset.view) sc.flyTo(b.dataset.view);
  else if (b.id === 'btn-zoom-in') sc.zoom(0.8);
  else if (b.id === 'btn-zoom-out') sc.zoom(1.25);
  else if (b.id === 'btn-labels') { const on = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', String(on)); sc.setLabels(on); }
});
$('#stage').addEventListener('keydown', (e) => {
  if (!sc) return;
  const k = e.key;
  if (k === 'ArrowLeft') sc.rotate(-0.12, 0); else if (k === 'ArrowRight') sc.rotate(0.12, 0);
  else if (k === 'ArrowUp') sc.rotate(0, -0.08); else if (k === 'ArrowDown') sc.rotate(0, 0.08);
  else if (k === '+' || k === '=') sc.zoom(0.85); else if (k === '-') sc.zoom(1.18);
  else return;
  e.preventDefault();
});

/* ---------- 진입·이탈 ---------- */
export async function enterSim() {
  if (!S.ready) {
    $('#side').innerHTML = '<p class="small muted" style="padding:20px">데이터를 불러오는 중…</p>';
    try { await Promise.all([loadDemand(), loadRuns(), loadAnswers()]); S.ready = true; }
    catch (e) { $('#side').innerHTML = `<div class="callout warn" style="margin:20px"><p>데이터를 읽지 못했습니다 (${esc(e.message)}). 저장소 루트에서 서버를 열었는지 확인하세요.</p></div>`; return; }
    setInterval(updateClock, 400);
  }
  ensureScene(); sc && sc.resize();
  applyMode(); applyScene(); render();
  if (pending !== null) {
    const n = pending; pending = null;
    if (n === 0) setMode('basic');
    else { if (S.mode !== 'sim') setMode('sim', { intro: false }); goStep(n); }
  }
}
let pending = null;
/** 홈의 단계 링크에서 부른다. 0 = 기본 보기, 1~4 = 시뮬레이션 단계 */
export function openAt(n) { pending = n; }
export function leaveSim() { stopReplay(); if (S.playing) setPlaying(false); if (sc) sc.setFlow({ running: false }); }
export const simState = () => S;
export const simData = () => ({ RUNS, ANSWERS, decisions: decisions() });
export { loadRuns, loadAnswers };
