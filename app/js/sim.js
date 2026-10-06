// 시뮬레이터 탭.
// 기본 보기: 1~2층 건물. 날짜·독감·기온·비를 바꾸면 하루 손님 수가 바뀌고, 재생하면 3D에서 손님이 띄엄띄엄 들어온다.
// 시뮬레이션: 약사 시점(1인칭). 시나리오 고르기 → AI 판단 따라가기 → 약사 답과 비교 → 근거에 추가할지 정하기.
// 판단은 AI(저장된 실행 결과)가 한다. 화면에서 답을 고르지 않는다. 약사 답은 data/5_validation/pharmacist_answers.csv 에서 읽는다.
import { lookup, obsLines, CARDS, cardById, OBJ_INFO, SCENE_LABELS, parseCSV } from './data.js';
import * as E from './engine.js';
import { loadDemand, computeDay, forecast, flowHours, dayDefaults, model as dmodel, BASE_VISITS, ITEM_BASE, HOURS } from './demand.js';
import { createScene } from '../design/building3d.js';
import { $, $$, esc, store, badge, VIRT, PUB, INTV, ASSUME, chip, chips, toast, reduceMotion, ACTION_LABEL, qidOf, layerName, srcTag, flagText } from './ui.js';

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
    ANSWERS = parseCSV(await r.text()).filter((x) => x.card_id);
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
  const ctx = { ...c, UNIT: E.UNIT_COST, CAP: E.OFFER.capacity, DUE: E.OFFER.due, PRIOR_ARR: E.PRIOR_ORDER.arrival, D0: E.CAL[0], D1: E.CAL[1], D2: E.CAL[2] };
  const fmt = { won: E.won, date: E.dayLabel, n: String };
  const fill = (t) => String(t).replace(/\{(\w+):(\w+)\}/g, (_, f, key) => fmt[f](ctx[key]));
  const { shown, hidden } = obsLines(cardId, c, checked, true);
  return `<div class="tbl-wrap"><table class="tbl obs"><tbody>${shown.map((r) => `<tr><th>${esc(r.obs_label_ko)}</th><td>${esc(fill(r.obs_text_ko))} ${/공공/.test(r.source_kind) ? PUB : /가정|가상/.test(r.source_kind) ? VIRT : ''}</td></tr>`).join('')}${hidden.map((r) => `<tr class="hidden-row"><th>${esc(r.obs_label_ko)}</th><td>${esc(r.obs_text_ko)}</td></tr>`).join('')}</tbody></table></div>`;
}
function scenarioStep() {
  const k = card();
  const list = CARDS.map((m, i) => {
    const hasAI = !!aiRun(m.id, 'P1'), hasAns = !!answerOf(m.id);
    return `<label class="scn"><input type="radio" name="scn" value="${m.id}" ${m.id === S.cardId ? 'checked' : ''}><span>
      <span class="scn-no">${i + 1}</span>
      <span class="scn-body"><b>${esc(m.title)}</b><small>${esc(m.short)} · ${m.tags.map(esc).join(' · ')}</small></span>
      <span class="scn-st"><i class="${hasAI ? 'on' : ''}" title="AI 답 ${hasAI ? '있음' : '없음'}">AI</i><i class="${hasAns ? 'on' : ''}" title="약사 답 ${hasAns ? '있음' : '없음'}">약사</i></span>
    </span></label>`;
  }).join('');
  return `
    <h2 class="side-h">어떤 상황을 볼까요?</h2>
    <p class="small muted">시나리오마다 조건이 <b>하나씩만</b> 다릅니다. 답이 달라지면 그 조건 때문이라고 볼 수 있습니다.</p>
    <div class="scn-list" role="radiogroup" aria-label="시나리오">${list}</div>
    <article class="scn-detail">
      <p class="kicker">시나리오 ${CARDS.indexOf(k) + 1}</p>
      <h3>${esc(k.title)}</h3>
      <p class="story">${esc(k.story)}</p>
      <dl class="dl2">
        <dt>무엇을 보려는가</dt><dd>${esc(k.test)}</dd>
        <dt>그날 환경</dt><dd>${scenarioEnv()}</dd>
        <dt>지어낸 부분</dt><dd>${VIRT} ${esc(k.invented)}</dd>
      </dl>
      <details class="help"><summary>약사와 AI가 똑같이 받은 정보</summary>${obsTable(k.id, false)}<p class="xs muted" style="margin-top:6px">자물쇠 줄은 아침에는 아무도 모르는 정보라 주지 않습니다.</p></details>
      <details class="help"><summary>이 시나리오를 만든 인터뷰 근거</summary><ul class="basis">${k.basis.map((b) => `<li>${chips(b.ids)}<span>${esc(b.why)}</span></li>`).join('')}</ul></details>
    </article>
    <div class="side-cta"><button class="btn btn-primary" type="button" data-step="2">AI 판단 보기</button></div>`;
}
function seenFacts(k) {
  const c = k.cond;
  return [['전산 재고', `${c.book}팩 · 선반+창고 (${c.ageH}시간 전 기록)`], ['최근 판매', '하루 5팩'], ['도매 단가', c.bulk ? `5팩 팩당 ${E.won(E.UNIT_COST)} · 10팩 팩당 ${E.won(c.bulk)}` : `팩당 ${E.won(E.UNIT_COST)} (할인 없음)`], ['입고', `${E.dayLabel(c.arrival)} 아침`], ['이미 넣은 주문', c.prior ? '5팩 (내일 도착)' : '없음']];
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
function layerStrip() {
  if (!RUNS) return '';
  const ls = ['B1', 'P0', 'P1'].filter((l) => RUNS.layers.includes(l));
  return `<div class="layer-strip" role="radiogroup" aria-label="AI에게 준 정보 수준">${ls.map((l) => { const r = aiRun(S.cardId, l); return `<label><input type="radio" name="ailayer" value="${l}" ${l === S.layer ? 'checked' : ''}><span><b>${esc(layerName(l))}</b><small>${r ? esc(ACTION_LABEL[finalOf(r)] || finalOf(r)) : '실행 없음'}</small></span></label>`; }).join('')}</div>
    <p class="xs muted">P1이 약사와 같은 정보를 받은 AI입니다. B1·P0와 답이 다르면 인터뷰나 그날 환경이 판단을 바꾼 것입니다.</p>`;
}
function aiStep() {
  const k = card(), run = aiRun(S.cardId);
  if (!run) {
    return `<h2 class="side-h">AI 판단</h2>${layerStrip()}<div class="empty"><b>이 시나리오의 AI 답이 아직 없습니다.</b><p>운영진이 AI 실행을 돌리면 이곳에 나타납니다.</p></div>`;
  }
  const r = S.replay.i;
  const steps = run.steps, first = steps[0], last = steps[steps.length - 1];
  const checked = first.action === 'check_physical_stock';
  const fin = finalOf(run);
  const show = (n) => (r >= n ? '' : ' hidden-step');
  const res = E.runAll(k.cond);
  const resRows = res.map((x, i) => `<tr class="${x.qid === fin ? 'sel' : ''}"><td>${['보류', '5팩 주문', '10팩 주문'][i]}${x.qid === fin ? ' ' + badge('neutral', 'AI 선택') : ''}</td><td class="num">${x.metrics.unmetTotal}명</td><td class="num">${x.metrics.endingPacks}팩</td><td class="num">${E.won(x.metrics.newCommitKrw)}</td></tr>`).join('');
  return `
    <h2 class="side-h">AI는 이렇게 판단했습니다</h2>
    ${layerStrip()}
    <ol class="flow-v">
      <li class="${show(0)}"><span class="dot">1</span><div><p class="fv-k">본 것</p><ul class="seen">${seenFacts(k).map(([a, b]) => `<li><span>${a}</span><b>${esc(b)}</b></li>`).join('')}</ul></div></li>
      ${checked ? `<li class="${show(1)}"><span class="dot">2</span><div><p class="fv-k">먼저 한 행동</p><p class="fv-act">실물 확인 (선반·창고)</p><p class="fv-why">${esc(first.reason)}</p><p class="fv-res">확인 결과: 선반과 창고 합계 <b>${k.cond.physical}팩</b>${k.cond.physical !== k.cond.book ? ` (전산보다 ${k.cond.book - k.cond.physical}팩 적음)` : ' (전산과 같음)'}</p></div></li>` : ''}
      <li class="${show(checked ? 2 : 1)}"><span class="dot">${checked ? 3 : 2}</span><div><p class="fv-k">최종 판단</p><p class="fv-final">${esc(ACTION_LABEL[fin] || fin)}</p><p class="fv-why">${esc(last.reason)}</p>
        ${(last.priorities || []).length ? `<p class="fv-pri"><span>중요하게 본 것</span>${last.priorities.map((p) => `<em>${esc(p)}</em>`).join('')}</p>` : ''}</div></li>
      <li class="${show(checked ? 2 : 1)}"><span class="dot">${checked ? 4 : 3}</span><div><p class="fv-k">무엇을 근거로</p>${factorRows(last.factors)}
        ${(last.missing_info || []).length ? `<p class="fv-miss"><span>더 알고 싶다고 한 것</span>${last.missing_info.map(esc).join(' · ')}</p>` : ''}</div></li>
    </ol>
    ${run.flags.length ? `<div class="callout warn" style="margin:8px 0"><p><b>자동 점검에서 걸린 것</b><br>${[...new Set(run.flags.map(flagText))].map(esc).join('<br>')}</p></div>` : ''}
    <details class="help"><summary>이 판단대로 하면 사흘 뒤 ${VIRT}</summary><div class="tbl-wrap"><table class="tbl"><thead><tr><th>선택</th><th class="num">못 판 손님</th><th class="num">남는 재고</th><th class="num">새 주문 금액</th></tr></thead><tbody>${resRows}</tbody></table></div><p class="xs muted" style="margin-top:6px">하루 5명이 이 약을 찾는다는 가정의 계산입니다. 약사 답과 비교할 때는 쓰지 않습니다.</p></details>
    <p class="xs muted">모델 ${esc(RUNS.model)} · ${esc(String(RUNS.created_at).replace('T', ' ').slice(0, 16))} 실행 · ${run.rep}번째 시도</p>
    <div class="side-cta"><button class="btn" type="button" data-replay="1">3D에서 다시 보기</button><button class="btn btn-primary" type="button" data-step="3">약사 답과 비교</button></div>`;
}
function cmpRow(label, a, b, match) {
  return `<div class="cmp-row"><p class="cmp-k">${label}${match ? ` ${match}` : ''}</p><div class="cmp-ai">${a}</div><div class="cmp-ph">${b}</div></div>`;
}
function compareStep() {
  const run = aiRun(S.cardId, 'P1'), ans = answerOf(S.cardId);
  const aiFirst = run ? run.steps[0].action === 'check_physical_stock' ? 'check_physical_stock' : finalOf(run) : null;
  const aiFin = run ? finalOf(run) : null;
  const last = run ? run.steps[run.steps.length - 1] : null;
  const none = '<span class="muted">-</span>';
  const wait = '<span class="muted">대기 중</span>';
  const qty = aiFin && /^Q_\d+$/.test(aiFin) ? Number(aiFin.slice(2)) : null;
  const inRange = ans && qty != null && ans.qty_min !== '' && ans.qty_max !== '' ? qty >= Number(ans.qty_min) && qty <= Number(ans.qty_max) : null;
  const m1 = ans && run && ans.first_action ? badge(ans.first_action === aiFirst ? 'good' : 'bad', ans.first_action === aiFirst ? '같음' : '다름') : '';
  const notAsked = '<span class="muted">묻지 않음</span>';
  const m2 = inRange == null ? '' : badge(inRange ? 'good' : 'bad', inRange ? '약사 범위 안' : '약사 범위 밖');
  return `
    <h2 class="side-h">AI 답과 약사 답</h2>
    <p class="small muted">같은 시나리오, 같은 정보에 대한 두 답입니다. AI는 정보 수준 P1(약사와 같은 정보)입니다.</p>
    <div class="cmp">
      <div class="cmp-head"><span></span><b>AI ${badge('hyp', '페르소나')}</b><b>약사 ${INTV}</b></div>
      ${cmpRow('먼저 한 행동', run ? esc(ACTION_LABEL[aiFirst]) : none, ans ? (ans.first_action ? esc(ACTION_LABEL[ans.first_action] || ans.first_action) : notAsked) : wait, m1)}
      ${cmpRow('최종 판단', run ? `<b>${esc(ACTION_LABEL[aiFin])}</b>` : none, ans ? `<b>${esc(ACTION_LABEL[ans.final_choice] || ans.final_choice)}</b>${ans.qty_min !== '' ? `<br><span class="xs muted">괜찮다고 본 범위 ${esc(ans.qty_min)}~${esc(ans.qty_max)}팩</span>` : ''}` : wait, m2)}
      ${cmpRow('중요하게 본 것', last && last.priorities ? last.priorities.map(esc).join('<br>') : none, ans ? [ans.priority_1_ko, ans.priority_2_ko].filter(Boolean).map(esc).join('<br>') || none : wait)}
      ${cmpRow('이유', last ? `<span class="clip">${esc(last.reason)}</span>` : none, ans ? (ans.reason_quote_ko ? `"${esc(ans.reason_quote_ko)}"` : ans.answer_ko ? esc(ans.answer_ko) : none) : wait)}
      ${cmpRow('더 알고 싶은 것', last && last.missing_info ? last.missing_info.map(esc).join('<br>') : none, ans ? esc(ans.need_more_ko) || none : wait)}
    </div>
    ${ans && ans.question_ko ? `<details class="help" style="margin-top:12px"><summary>약사에게 실제로 물은 것과 답</summary><p class="small"><b>질문</b> ${esc(ans.question_ko)}</p><p class="small"><b>답</b> ${esc(ans.answer_ko)}</p>${ans.source_kind_ko ? `<p class="xs muted">${esc(ans.source_kind_ko)}</p>` : ''}${ans.note_ko ? `<p class="xs muted">${esc(ans.note_ko)}</p>` : ''}</details>` : ''}
    ${ans ? '' : `<div class="empty" style="margin-top:12px"><b>약사 답이 아직 없습니다.</b><p>약사에게 이 시나리오를 물어 받은 답을 운영진이 입력하면 오른쪽 칸이 채워집니다. 약사에게는 AI 답을 먼저 보여 주지 않습니다.</p></div>`}
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
  else if (t.name === 'ailayer') { S.layer = t.value; startReplay(); }
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
