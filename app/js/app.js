import { loadData, DB, lookup, CARDS, SUPPORT, cardById, PAIRS, KIND2_CANDIDATES, EXPECTED, SAMPLES, EVIDENCE_PICKS, OBJ_INFO, SCENE_LABELS, NEEDS, DONTS } from './data.js';
import * as E from './engine.js';
import { createScene } from './scene3d.js';

/* ---------- 도우미 ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 저장소를 쓸 수 없는 환경 */ } },
  raw(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  setRaw(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* noop */ } },
};
const badge = (cls, t) => `<span class="badge b-${cls}">${esc(t)}</span>`;
const VIRT = badge('virtual', '가상');
const chip = (id) => `<button type="button" class="ev-chip${lookup(id) ? '' : ' bad'}" data-ref="${esc(id)}" aria-label="근거 ${esc(id)} 원문 보기">${esc(id)}</button>`;
const chips = (ids) => `<span class="ev-chips">${ids.map(chip).join('')}</span>`;
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const ACTION_LABEL = { check_physical_stock: '선반 확인', Q_0: '보류 (0팩)', Q_5: '5팩 주문', Q_10: '10팩 주문', defer: '판단 유보', other: '후보 밖' };
const QTY = { Q_0: 0, Q_5: 5, Q_10: 10 };
const dl = (iso) => E.dayLabel(iso);

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3800);
}

/* ---------- 상태 ---------- */
const S = {
  cardId: 'C01', cond: { ...CARDS[0].cond }, step: 1, responder: 'direct',
  obs: null, checked: false, log: [], sampleIdx: 0,
  pick: { action: null, refs: new Set(), missing: '', deferReason: '' },
  result: null, chosen: null, source: null, finalRefs: [], day: 0, playing: false, engineView: false,
};
const card = () => CARDS.find((c) => c.id === S.cardId);
let playTimer;
function resetSim(keepCond = false) {
  if (!keepCond) S.cond = { ...card().cond };
  S.obs = E.buildObservation(S.cond);
  S.checked = false; S.log = []; S.sampleIdx = 0;
  S.pick = { action: null, refs: new Set(), missing: '', deferReason: '' };
  S.result = null; S.chosen = null; S.source = null; S.finalRefs = []; S.day = 0;
  stopPlay();
}
resetSim();

let scenes = { hero: null, sim: null };

/* ---------- 테마 ---------- */
const isDark = () => {
  const t = document.documentElement.getAttribute('data-theme');
  return t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
};
function syncTheme() {
  const d = isDark();
  $('#btn-theme').setAttribute('aria-pressed', String(d));
  $('#theme-icon').setAttribute('href', d ? '#i-sun' : '#i-moon');
  Object.values(scenes).forEach((s) => s && s.setTheme(d));
}
$('#btn-theme').addEventListener('click', () => {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  store.setRaw('pp-theme', next);
  syncTheme();
});
window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', syncTheme);

/* ---------- 3D 장면 ---------- */
function ensureScene(kind) {
  if (scenes[kind]) return scenes[kind];
  const container = kind === 'hero' ? $('#hero-stage') : $('#stage');
  const sc = createScene(container, { hero: kind === 'hero', labels: kind === 'sim' ? SCENE_LABELS : [] });
  if (!sc) {
    $(kind === 'hero' ? '#hero-fallback' : '#stage-fallback').hidden = false;
    return null;
  }
  scenes[kind] = sc;
  sc.setTheme(isDark());
  sc.onPick((key) => { if (kind === 'sim') showObj(key); else location.hash = '#/simulate'; });
  if (kind === 'sim') { applyScene(); }
  return sc;
}
function sceneView() {
  const c = S.cond;
  if (!S.result || S.day === 0) {
    const solid = S.checked || S.engineView ? c.physical : 0;
    return { ghost: c.book, solid: Math.min(10, solid), truck: 'away', drop: 0, fulfilled: 0, unmet: 0 };
  }
  const br = S.result.find((r) => r.qid === S.chosen);
  const t = br.timeline[S.day - 1];
  return { ghost: 0, solid: Math.min(10, t.closing), truck: t.received > 0 ? 'arrived' : 'away', drop: Math.min(10, t.received), fulfilled: t.fulfilled, unmet: t.unmet };
}
function statusText() {
  const c = S.cond;
  if (!S.result || S.day === 0) {
    let s = `판단 시점 ${dl(E.CAL[0])} 08:50 · 전산 재고 ${c.book}팩(${c.ageH}시간 전 기록)`;
    s += S.checked ? ` · 실물 확인됨: ${c.physical}팩` : (S.engineView ? ` · 숨은 값: 실제 ${c.physical}팩 (약사와 AI에게는 주지 않음)` : ' · 실제 선반은 확인 전');
    return s;
  }
  const br = S.result.find((r) => r.qid === S.chosen);
  const t = br.timeline[S.day - 1];
  return `${dl(t.date)} 문 닫을 때 · 들어온 약 ${t.received}팩 · 사 간 손님 ${t.fulfilled}명 · 못 사고 간 손님 ${t.unmet}명 · 남은 재고 ${t.closing}팩${t.closing > 10 ? ' (선반에는 10팩까지 표시)' : ''} · 코드 계산(가상)`;
}
function applyScene() {
  if (scenes.sim) scenes.sim.setState(sceneView());
  $('#stage-status').textContent = statusText();
  renderDayChips();
}
function renderDayChips() {
  const has = !!S.result;
  const items = [{ d: 0, t: '판단 시점' }, ...E.CAL.map((iso, i) => ({ d: i + 1, t: `${dl(iso)} 마감` }))];
  $('#daychips').innerHTML = items.map((x) => `<button type="button" class="daychip" data-day="${x.d}" aria-pressed="${S.day === x.d}" ${x.d > 0 && !has ? 'disabled' : ''}>${x.t}</button>`).join('');
  $('#btn-prev').disabled = !has || S.day === 0;
  $('#btn-next').disabled = !has || S.day === 3;
  $('#btn-play').disabled = !has;
  $('#play-label').textContent = S.playing ? '멈춤' : '재생';
  $('#play-icon').setAttribute('href', S.playing ? '#i-pause' : '#i-play');
}
function stopPlay() { S.playing = false; clearInterval(playTimer); }
function startPlay() {
  if (!S.result) return;
  if (S.day >= 3) S.day = 0;
  S.playing = true; clearInterval(playTimer);
  playTimer = setInterval(() => {
    if (S.day >= 3) { stopPlay(); applyScene(); return; }
    S.day += 1; applyScene(); if (S.step === 3) markDay();
    if (S.day >= 3) { stopPlay(); applyScene(); }
  }, 1700);
  applyScene();
}
function markDay() { $$('#panel tr[data-day]').forEach((tr) => tr.classList.toggle('sel', Number(tr.dataset.day) === S.day)); }
function setDay(d) { stopPlay(); S.day = Math.max(0, Math.min(3, d)); applyScene(); markDay(); }

/* 3D 도구 */
$('#stage-play').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.id === 'btn-play') { S.playing ? (stopPlay(), applyScene()) : startPlay(); }
  else if (b.id === 'btn-prev') setDay(S.day - 1);
  else if (b.id === 'btn-next') setDay(S.day + 1);
  else if (b.dataset.day !== undefined) setDay(Number(b.dataset.day));
});
$('.stage-tools').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const sc = scenes.sim;
  if (b.dataset.view) { sc && sc.flyTo(b.dataset.view); if (b.dataset.view === 'judge') showObj('judge'); if (b.dataset.view === 'roof') showObj('roof'); if (b.dataset.view === 'stock') showObj('stock'); if (b.dataset.view === 'street') showObj('truck'); if (b.dataset.view === 'pharmacy') showObj('pharmacy'); if (b.dataset.view === 'pharmacist') openProfile(); }
  else if (b.id === 'btn-zoom-in') sc && sc.zoom(0.8);
  else if (b.id === 'btn-zoom-out') sc && sc.zoom(1.25);
  else if (b.id === 'btn-labels') { const on = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', String(on)); sc && sc.setLabels(on); }
  else if (b.id === 'btn-engine') {
    S.engineView = !S.engineView; b.setAttribute('aria-pressed', String(S.engineView)); applyScene();
    toast(S.engineView ? '숨은 상태를 표시합니다. 이 값은 모델과 약사에게 전달되지 않는 엔진 값입니다.' : '숨은 상태를 다시 가렸습니다.');
  }
});
$('#stage').addEventListener('keydown', (e) => {
  const sc = scenes.sim; if (!sc) return;
  const k = e.key;
  if (k === 'ArrowLeft') sc.rotate(-0.12, 0); else if (k === 'ArrowRight') sc.rotate(0.12, 0);
  else if (k === 'ArrowUp') sc.rotate(0, -0.08); else if (k === 'ArrowDown') sc.rotate(0, 0.08);
  else if (k === '+' || k === '=') sc.zoom(0.85); else if (k === '-') sc.zoom(1.18); else if (k === 'Home') sc.flyTo('overview');
  else return;
  e.preventDefault();
});

/* 장면 목록과 물건 설명 (무대 위 카드) */
function renderObjList() {
  const order = ['pharmacy', 'stock', 'counter', 'customers', 'truck', 'sofa', 'ent', 'ortho', 'across', 'judge', 'roof'];
  $('#obj-list').innerHTML = order.map((k) => `<button type="button" class="btn btn-sm" data-obj="${k}">${esc(OBJ_INFO[k].title)}</button>`).join('');
}
$('#obj-list').addEventListener('click', (e) => { const b = e.target.closest('[data-obj]'); if (b) showObj(b.dataset.obj); });
const TAGS = { 인터뷰: 'interview', 가상: 'virtual', 개념: 'concept', 미반영: 'unknown' };
function setObjCard(open) {
  if (open) setProfile(false);
  $('#obj-card').hidden = !open;
  $('#btn-objlist').setAttribute('aria-pressed', String(open));
  if (open) setStageHint(false);
}
function showObj(key) {
  if (key === 'persona') { openProfile(); return; }
  const o = OBJ_INFO[key]; if (!o) return;
  $('#obj-detail').innerHTML = `<h3>${esc(o.title)} ${badge(TAGS[o.tag] || 'neutral', o.tag)}</h3><p class="small" style="margin-bottom:8px">${esc(o.body)}</p>${o.refs.length ? `<p class="xs muted" style="margin-bottom:4px">근거가 된 인터뷰 번호 (누르면 원문)</p>${chips(o.refs)}` : '<p class="xs muted" style="margin:0">인터뷰 근거가 없는 가정 요소입니다.</p>'}`;
  setObjCard(true);
}
/* 인터뷰 약사 프로필: persona_profile.csv(사실값·서술)와 variables.csv(고정 속성·제약·상태·판단규칙…)를 그대로 읽어 보여 준다.
   CSV 에 없는 값(성별, 나이, 경력 연수)은 지어내지 않고 '미확인'으로 둔다. */
const MISSING_FACTS = [['성별', '인터뷰 자료에 없음'], ['나이', '인터뷰 자료에 없음'], ['약사 경력 연수', '"이전 약국과 규모가 큰 약국에서 근무"까지만 있고 연수는 없음 (P008)']];
function profileHTML() {
  if (!DB.ok) return '<p class="muted">근거 데이터를 불러오는 중입니다.</p>';
  const facts = DB.profile.filter((r) => r.kind === 'fact');
  const narr = DB.profile.filter((r) => r.kind === 'narrative');
  const factRows = facts.map((r) => `<tr><th>${esc(r.summary_ko)}</th><td><b>${esc(r.value)}</b> ${esc(r.unit === 'date' ? '' : r.unit)} ${badge('interview', '인터뷰')}</td></tr>`).join('')
    + MISSING_FACTS.map(([k, why]) => `<tr><th>${k}</th><td>${badge('unknown', '미확인')} <span class="xs muted">${esc(why)}</span></td></tr>`).join('');
  const groups = {};
  DB.variables.forEach((v) => { (groups[v.category_ko] = groups[v.category_ko] || []).push(v); });
  const scopeCls = (a) => (/현재/.test(a) ? 'interview' : /과거|타|다른/.test(a) ? 'hyp' : 'neutral');
  const varGroups = Object.entries(groups).map(([cat, list], i) => `<details class="pf-group" ${i === 0 ? 'open' : ''}><summary>${esc(cat.replace(/^\d+\s*/, ''))} <span class="xs muted" style="font-weight:400">${list.length}건</span></summary>${list.map((v) => `<div class="pf-var"><b>${esc(v.label_ko)}</b>${v.applies_to ? badge(scopeCls(v.applies_to), v.applies_to.split('/')[0].trim()) : ''}<span class="u">${esc(v.interview_finding_ko)}</span></div>`).join('')}</details>`).join('');
  return `
    <h3>인터뷰 약사 ${badge('interview', '응답자 1인')}</h3>
    <p class="lede">이 시뮬레이터가 재현하려는 사람입니다. 아래는 인터뷰를 정리한 CSV를 그대로 읽어 온 것이고, 시뮬레이션 값이 아닙니다.</p>
    <p class="xs" style="margin:0 0 6px"><b>확인된 사실</b></p>
    <table class="pf-facts"><tbody>${factRows}</tbody></table>
    <div class="callout warn" style="margin-bottom:12px"><p>성별과 나이는 인터뷰 자료에 없어서 비워 두었습니다. 화면에서 추정해 채우지 않습니다. 확인되면 원본 Excel에 추가해야 이곳에 나타납니다.</p></div>
    <p class="xs" style="margin:12px 0 0"><b>어떤 사람인가 (인터뷰 정리)</b></p>
    ${narr.map((r) => `<div class="pf-sec"><span class="k">${esc(r.section_ko)}</span><b>${esc(r.summary_ko)}</b><p>${esc(r.detail_ko)}</p></div>`).join('')}
    <p class="xs" style="margin:16px 0 4px"><b>세부 항목 (변수 사전 ${DB.variables.length}건)</b> <span class="muted">— 누르면 펼쳐집니다</span></p>
    ${varGroups}
    <div class="callout" style="margin:12px 0 16px"><p>약사 2인 운영은 사용자 보완 정보(U001)이고 응답자는 1명입니다. 응답자의 과거 근무 경험은 현재 약국의 값과 따로 둡니다 ${chips(['U001', 'G01', 'G07'])}.</p></div>`;
}
function setProfile(open) {
  if (open) { setObjCard(false); setStageHint(false); $('#profile-body').innerHTML = profileHTML(); $('#profile-card').scrollTop = 0; }
  $('#profile-card').hidden = !open;
}
function openProfile() { setProfile(true); }
$('#profile-close').addEventListener('click', () => setProfile(false));
function setStageHint(open) {
  $('#stage-hint').hidden = !open;
  $('#btn-stagehelp').setAttribute('aria-pressed', String(open));
  if (!open) store.setRaw('pp-stagehint', '1');
}
$('#obj-close').addEventListener('click', () => setObjCard(false));
$('#btn-objlist').addEventListener('click', () => {
  const open = $('#obj-card').hidden;
  if (open && !$('#obj-detail').innerHTML.trim()) $('#obj-detail').innerHTML = '<h3>장면 목록</h3><p class="small" style="margin:0">3D 장면에 있는 것을 글로 봅니다. 3D를 쓰기 어려울 때도 같은 정보를 볼 수 있습니다.</p>';
  setObjCard(open);
});
$('#btn-stagehelp').addEventListener('click', () => { const open = $('#stage-hint').hidden; if (open) { setProfile(false); setObjCard(false); } setStageHint(open); });
$('#stage-hint-close').addEventListener('click', () => setStageHint(false));

/* ---------- 근거 서랍 ---------- */
let drawerTrigger = null;
function openRef(id, trigger) {
  const r = lookup(id);
  drawerTrigger = trigger || null;
  const body = r
    ? `<p class="xs muted" style="margin:0 0 4px">${badge('interview', r.kind)} ${r.type ? badge('neutral', r.type) : ''}</p>
       <h2 id="drawer-title"><span class="mono">${esc(r.id)}</span> ${esc(r.title)}</h2>
       ${r.quote ? `<p class="xs muted" style="margin-bottom:4px">원문 발언 일부</p><blockquote style="margin:0 0 12px;padding-left:12px;border-left:3px solid var(--line)">${esc(r.quote)}</blockquote>` : ''}
       ${r.situation ? `<p class="xs muted" style="margin-bottom:2px">상황</p><p>${esc(r.situation)}</p>` : ''}
       <p class="xs muted" style="margin-bottom:2px">${r.kind === '발언' ? '요약' : r.kind === '규칙' ? '판단' : r.kind === '사례' ? '결과' : '처리'}</p><p>${esc(r.summary)}</p>
       ${r.note ? `<p class="xs muted" style="margin-bottom:2px">읽을 때 주의</p><p>${esc(r.note)}</p>` : ''}
       ${r.where ? `<p class="xs muted">출처 위치: ${esc(r.where)}</p>` : ''}
       <p class="xs muted">data/1_interview/ 의 CSV 내용입니다.</p>`
    : `<h2 id="drawer-title">${esc(id)}</h2><p>데이터에서 이 ID를 찾지 못했습니다. 근거로 쓰기 전에 확인이 필요합니다.</p>`;
  $('#drawer-body').innerHTML = body;
  $('#drawer').hidden = false;
  $('#drawer-close').focus();
}
function closeDrawer() { $('#drawer').hidden = true; if (drawerTrigger && document.contains(drawerTrigger)) drawerTrigger.focus(); }
$('#drawer-close').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#drawer').hidden) closeDrawer();
  else if (!$('#profile-card').hidden) setProfile(false);
  else if (!$('#obj-card').hidden) setObjCard(false);
  else if (!$('#stage-hint').hidden) setStageHint(false);
});
// 헤더 높이를 CSS 변수로 넘겨 시뮬레이터가 남은 화면을 정확히 채우게 한다.
new ResizeObserver(() => document.documentElement.style.setProperty('--hdr-h', `${$('#site-header').offsetHeight}px`)).observe($('#site-header'));
document.addEventListener('click', (e) => { const b = e.target.closest('[data-ref]'); if (b) openRef(b.dataset.ref, b); });

/* ---------- 시뮬레이터 패널 ---------- */
const stepDone = () => ({ 1: true, 2: true, 3: !!S.result });
function renderStepper() {
  $$('#sim-stepper button').forEach((b) => {
    const n = Number(b.dataset.step);
    b.toggleAttribute('aria-current', n === S.step);
    if (n === S.step) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    b.disabled = n === 3 && !S.result;
  });
}
$('#sim-stepper').addEventListener('click', (e) => { const b = e.target.closest('button[data-step]'); if (b && !b.disabled) goStep(Number(b.dataset.step)); });
function goStep(n) { S.step = n; if (n !== 3) { stopPlay(); } renderPanel(); $('.panel-col').scrollTop = 0; applyScene(); const h = $('#panel h2'); h && h.focus && (h.tabIndex = -1, h.focus({ preventScroll: true })); }

const helpBox = (title, html) => `<details class="help"><summary>${esc(title)}</summary>${html}</details>`;

function changedConds() {
  const base = card().cond, c = S.cond, d = [];
  if (c.cash !== base.cash) d.push('현금');
  if (c.arrival !== base.arrival) d.push('입고일');
  if (c.prior !== base.prior) d.push('기존 미입고');
  if (c.physical !== base.physical) d.push('전산·실물 불일치');
  return d;
}
function obsTable() {
  const c = S.cond, o = S.obs;
  const stockCell = S.checked
    ? `전산 ${c.book}팩 (${c.ageH}시간 전 기록) ${VIRT}<br><b>실물 확인: ${c.physical}팩</b> ${badge('good', '확인됨')}`
    : `전산 ${c.book}팩 (${c.ageH}시간 전 기록) ${VIRT} ${badge('unknown', '실물 미확인')}`;
  return `<div class="tbl-wrap"><table class="tbl obs"><caption class="sr-only">약사와 AI에게 똑같이 주는 정보</caption><tbody>
    <tr><td>언제</td><td>${dl(E.CAL[0])} 아침 8시 50분, 문 열기 전 ${VIRT}</td></tr>
    <tr><td>어떤 약</td><td>${esc(o.item.label)}, 팩 단위 ${VIRT}</td></tr>
    <tr><td>남은 재고</td><td>${stockCell}</td></tr>
    <tr><td>최근 판매량</td><td>사흘 내내 하루 5팩 ${VIRT}</td></tr>
    <tr><td>통장 잔액</td><td>${E.won(c.cash)} ${VIRT}<br><span class="xs muted">판단할 때 참고하는 사정일 뿐, 약국의 전체 현금을 예측한 값이 아닙니다.</span></td></tr>
    <tr><td>외상 주문 한도</td><td>${E.won(E.LIMIT_KRW)} ${VIRT}<br><span class="xs muted">통장 잔액과 별개로, 이번에 후불로 더 주문할 수 있는 금액입니다.</span></td></tr>
    <tr><td>도매상 조건</td><td>팩당 ${E.won(E.UNIT_COST)}, 최대 ${E.OFFER.capacity}팩까지 가능<br>${dl(c.arrival)} 아침 문 열기 전에 도착, 대금은 ${dl(E.OFFER.due)}에 결제 ${VIRT}</td></tr>
    <tr><td>이미 넣은 주문</td><td>${c.prior ? `5팩, ${dl(E.PRIOR_ORDER.arrival)} 아침 도착 예정 ${VIRT}` : '없음'}</td></tr>
    <tr><td>고를 수 있는 것</td><td>선반 확인 · 보류(0팩) · 5팩 주문 · 10팩 주문 · 판단 유보</td></tr>
    <tr class="hidden-row"><td><span class="lock"><svg width="14" height="14" aria-hidden="true"><use href="#i-lock"/></svg>주지 않는 정보</span></td><td>확인 전의 실제 재고, 앞으로 올 손님 수, 선택별 결과. 실제 약사도 아침에는 이것을 모릅니다.</td></tr>
  </tbody></table></div>`;
}

const supportBadge = (k) => badge(SUPPORT[k.support].cls, SUPPORT[k.support].label);
function cardMore(k) {
  return `<div class="card-more">
    <p><span class="k">이 카드로 확인하려는 것</span>${esc(k.test)}</p>
    <p><span class="k">근거가 된 인터뷰 내용</span></p>
    <ul class="basis">${k.basis.map((b) => `<li>${chips(b.ids)}<span>${esc(b.why)}</span></li>`).join('')}</ul>
    <p style="margin:8px 0 0"><span class="k">가정으로 정한 부분</span>${VIRT} ${esc(k.invented)}</p>
  </div>`;
}
function renderStep1() {
  const c = S.cond, diff = changedConds();
  return `
    <div class="p-title"><h2>상황 고르기</h2><span class="xs muted">1 / 3</span></div>
    <div class="intro"><dl>
      <dt>하는 일</dt><dd>약사에게 물어볼 <b>상황 카드</b>를 하나 고릅니다. 상황 카드는 "어느 날 아침의 약국 사정"입니다. 남은 재고, 통장 잔액, 도매상이 언제 가져다주는지가 들어 있고, 마지막에 "몇 팩을 주문하겠습니까?"를 묻습니다.</dd>
      <dt>왜</dt><dd>카드마다 조건이 <b>하나씩만</b> 다릅니다. 그래야 약사의 답이 달라졌을 때 무엇 때문인지 알 수 있습니다.</dd>
      <dt>다음</dt><dd>카드를 고르면 왼쪽 3D 선반과 아래 "약사와 AI가 보게 될 정보"가 바뀝니다. 확인한 뒤 판단 단계로 넘어갑니다.</dd>
    </dl></div>

    <div class="sec-label">상황 카드 ${badge('neutral', '모두 연습용')}</div>
    <p class="sec-hint">고른 카드는 펼쳐져서, 무엇을 확인하려는 카드인지와 인터뷰의 어떤 말에서 나왔는지 보여 줍니다.</p>
    <div class="cardlist" role="radiogroup" aria-label="상황 카드">
      ${CARDS.map((k) => {
        const on = k.id === S.cardId;
        return `<label class="card-opt"><input type="radio" name="card" value="${k.id}" ${on ? 'checked' : ''}><span>
          <span class="t">${esc(k.title)}</span>
          <span class="d">${esc(k.story)}</span>
          <span class="tags">${supportBadge(k)}${k.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</span>
          ${on ? cardMore(k) : ''}
        </span></label>`;
      }).join('')}
      <label class="card-opt off" aria-disabled="true"><input type="radio" disabled><span>
        <span class="t">인터뷰에 없던 새 상황 ${badge('unknown', '준비 중')}</span>
        <span class="d">재현도를 실제로 재는 <b>평가용</b> 카드입니다. 위의 여섯 장은 인터뷰가 이미 다룬 요소로 만들어서, AI가 인터뷰를 따라 하기만 해도 맞힐 수 있습니다. 그래서 인터뷰에 없던 상황이 따로 필요합니다.</span>
        <span class="d" style="margin-top:6px">후보: ${KIND2_CANDIDATES.map(esc).join(', ')}. 인터뷰가 다룬 범위와 대조한 뒤 확정합니다.</span>
      </span></label>
    </div>

    <details class="toggle" ${diff.length ? 'open' : ''}>
      <summary>조건 하나 바꿔 보기 ${diff.length ? badge('hyp', `바꾼 조건: ${diff.join(', ')}`) : '<span class="xs muted" style="font-weight:400">(선택)</span>'}</summary>
      <p class="sec-hint">고른 카드에서 조건 하나만 바꿔 새 상황을 만들어 봅니다. 카드에 없는 조합을 시험할 때 씁니다. 바꾼 상황에는 미리 써 둔 예시 응답이 맞지 않을 수 있습니다.</p>
      <div class="cond-row"><span class="lab" id="lab-cash">통장 잔액</span>
        <span class="seg" role="radiogroup" aria-labelledby="lab-cash"><label><input type="radio" name="cash" value="60000" ${c.cash === 60000 ? 'checked' : ''}><span>6만원 (빠듯함)</span></label><label><input type="radio" name="cash" value="600000" ${c.cash === 600000 ? 'checked' : ''}><span>60만원 (넉넉함)</span></label></span>
        <span class="hint">주문은 후불이라 계산상 재고에는 영향이 없습니다. 약사가 돈 걱정 때문에 덜 주문하는지 보려는 조건입니다.</span></div>
      <div class="cond-row"><span class="lab" id="lab-arr">주문한 약이 들어오는 날</span>
        <span class="seg" role="radiogroup" aria-labelledby="lab-arr"><label><input type="radio" name="arrival" value="${E.CAL[1]}" ${c.arrival === E.CAL[1] ? 'checked' : ''}><span>내일 아침 (${dl(E.CAL[1])})</span></label><label><input type="radio" name="arrival" value="${E.CAL[2]}" ${c.arrival === E.CAL[2] ? 'checked' : ''}><span>모레 아침 (${dl(E.CAL[2])})</span></label></span>
        <span class="hint">늦게 들어오면 그 사이 손님을 돌려보낼 수 있습니다.</span></div>
      <div class="checks">
        <label class="check"><input type="checkbox" name="prior" ${c.prior ? 'checked' : ''}><span>어제 넣은 주문 5팩이 내일 들어올 예정<br><span class="xs muted">이미 넣은 주문을 고려하는지 봅니다.</span></span></label>
        <label class="check"><input type="checkbox" name="gap" ${c.physical !== c.book ? 'checked' : ''}><span>전산 기록과 실제 선반이 다름<br><span class="xs muted">실제로는 3팩. 선반을 확인하기 전에는 숨겨집니다.</span></span></label>
      </div>
      ${diff.length > 1 ? `<div class="callout warn" style="margin-top:12px"><b>조건을 둘 이상 바꿨습니다.</b> 답이 달라져도 어느 조건 때문인지 알 수 없습니다. 하나만 바꾸세요.</div>` : ''}
      ${diff.length ? '<button class="btn btn-sm" type="button" data-reset="1" style="margin-top:12px">카드 원래 조건으로 되돌리기</button>' : ''}
    </details>

    <div class="sec-label">약사와 AI가 보게 될 정보</div>
    <p class="sec-hint">약사에게 물을 때도, AI에게 물을 때도 이 표의 내용만 줍니다. 마지막 줄의 잠긴 정보는 판단이 끝날 때까지 누구에게도 주지 않습니다.</p>
    ${obsTable()}
    <div class="btn-row sticky"><button class="btn btn-primary" type="button" data-go="2">이 상황으로 판단하기</button></div>`;
}

function sampleCurrent() {
  const list = SAMPLES[S.cardId] || [];
  let i = S.sampleIdx;
  // 이미 실물을 확인했다면 예시의 '실물 확인' 단계는 건너뛴다.
  while (i < list.length - 1 && list[i].kind === 'check_physical_stock' && S.checked) i += 1;
  return list[Math.min(i, list.length - 1)];
}
function claimBlock(cl) {
  const texts = cl.ids.map((id) => lookup(id)).filter(Boolean);
  return `<div class="claim"><div class="ev-chips" style="margin-bottom:6px">${cl.ids.map(chip).join('')} ${cl.inference ? badge('hyp', '이번 상황에 적용한 추론') : badge('interview', '인터뷰가 직접 말한 내용')}</div><p class="small" style="margin:0">${esc(cl.claim)}</p>${texts.length ? `<p class="xs muted" style="margin:6px 0 0">CSV: ${texts.map((r) => `${esc(r.id)} "${esc((r.summary || '').slice(0, 70))}"`).join(' / ')}</p>` : ''}</div>`;
}
function consList(qid) {
  const cs = E.constraints(S.cond, qid);
  return `<ul class="cons">${cs.map((x) => `<li class="${x.pass ? '' : 'fail'}">${badge(x.pass ? 'good' : 'bad', x.pass ? '통과' : '위반')}<span><b>${esc(x.label)}</b> <span class="xs muted">${esc(x.detail)}</span></span></li>`).join('')}</ul>`;
}
function logList() {
  if (!S.log.length) return '<p class="small muted">아직 조회나 판단 기록이 없습니다.</p>';
  return `<ol class="log">${S.log.map((l, i) => `<li><span class="badge b-neutral">${i + 1}</span><span>${esc(l.text)}</span></li>`).join('')}</ol>`;
}

/* ---------- 저장된 AI 답 (runs/latest.json) ----------
   화면은 AI 를 직접 호출하지 않는다. scripts/run_persona.py 가 저장한 결과 파일만 읽는다. */
let RUNS = null;
async function loadRuns() {
  try {
    const res = await fetch('../runs/latest.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    RUNS = await res.json();
  } catch (e) { RUNS = null; }
  const b = $('#badge-ai');
  if (b) { b.className = RUNS ? 'badge b-hyp' : 'badge b-sample'; b.textContent = RUNS ? `저장된 AI 답 있음 · ${RUNS.model}` : 'AI 답 아직 없음'; }
}
const qidOf = (a, qty) => (a === 'commit_choice' ? `Q_${qty ?? 0}` : a);
const runsFor = (cardId, layer) => (RUNS ? RUNS.results.filter((r) => r.card === cardId && (!layer || r.layer === layer)) : []);
const runLayers = () => (RUNS ? RUNS.layers : []);
const SV = { layer: 'P0', rep: 1 };
function savedPick(cardId) {
  const layer = runLayers().includes(SV.layer) ? SV.layer : runLayers()[0];
  const list = runsFor(cardId, layer);
  return { layer, list, cur: list.find((r) => r.rep === SV.rep) || list[0] };
}
const idBadge = (id) => (lookup(id) || id === 'U001'
  ? `<span class="ev-chips">${chip(id)}${badge('good', '번호 있음')}</span>`
  : `<span class="ev-chips">${chip(id)}${badge('bad', '데이터에 없는 번호')}</span>`);
const FLAG_TEXT = {
  ids_given_without_interview: '인터뷰 자료 없이 근거 번호를 댔습니다',
  no_evidence_cited: '선택을 했지만 근거 번호가 없습니다',
  invalid_qty: '주문량이 선택지에 없습니다',
  action_not_allowed: '허용되지 않은 행동입니다',
  priorities_not_two: '중요하게 본 것이 두 가지가 아닙니다',
};
const flagText = (f) => { const k = f.replace(/^r\d+:/, ''); return FLAG_TEXT[k] || (k.startsWith('unknown_ids') ? `데이터에 없는 근거 번호: ${k.split(':').slice(1).join(':')}` : k); };
function savedHTML() {
  const k = card();
  if (!RUNS) return `<div class="callout warn"><p><b>저장된 AI 답이 아직 없습니다.</b> 터미널에서 <code>python scripts/run_persona.py --mode sync --cards all --reps 1 --yes</code> 를 실행하면 <code>runs/latest.json</code> 이 만들어지고 이 화면이 읽습니다. 자세한 방법은 app/README.md 에 있습니다.</p></div>`;
  const { layer, list, cur } = savedPick(S.cardId);
  const modified = changedConds().length > 0;
  const head = `<p class="small muted">모델 <b>${esc(RUNS.model)}</b> · 실행 ${esc(RUNS.created_at.replace('T', ' '))} · ${RUNS.mode === 'batch' ? '일괄 실행' : '바로 실행'} ${RUNS.est_cost_usd != null ? `· 추정 비용 $${RUNS.est_cost_usd.toFixed(3)}` : ''}</p>`;
  const layerSeg = `<div class="cond-row"><span class="lab" id="lab-layer">어떤 정보를 준 AI인가요?</span>
    <span class="seg" role="radiogroup" aria-labelledby="lab-layer">${runLayers().map((l) => `<label><input type="radio" name="svlayer" value="${l}" ${l === layer ? 'checked' : ''}><span>${l === 'B1' ? 'B1 · 일반 약사' : l === 'P0' ? 'P0 · 인터뷰 근거 포함' : l}</span></label>`).join('')}</span>
    <span class="hint">B1은 인터뷰 자료 없이, P0는 인터뷰 근거를 함께 줬습니다. 둘의 차이가 인터뷰가 더한 몫입니다.</span></div>`;
  if (!cur) return `${head}${layerSeg}<div class="callout warn"><p>이 상황(${esc(k.title)})은 저장된 실행에 들어 있지 않습니다.</p></div>`;
  const repSeg = `<div class="cond-row"><span class="lab" id="lab-rep">몇 번째 시도인가요?</span>
    <span class="seg" role="radiogroup" aria-labelledby="lab-rep">${list.map((r) => `<label><input type="radio" name="svrep" value="${r.rep}" ${r.rep === cur.rep ? 'checked' : ''}><span>${r.rep}번째</span></label>`).join('')}</span>
    <span class="hint">같은 입력으로 여러 번 물어 답이 얼마나 일정한지 봅니다.</span></div>`;
  const cons = (RUNS.consistency || {})[`${S.cardId}|${layer}`];
  const finLab = (a) => (a === 'commit_5' ? '5팩 주문' : a === 'commit_10' ? '10팩 주문' : a === 'commit_0' ? '보류' : (ACTION_LABEL[a] || a));
  const consTxt = cons ? `${cons.n}번 중 첫 행동: ${Object.entries(cons.first_action).map(([a, n]) => `${esc(ACTION_LABEL[a] || a)} ${n}번`).join(', ')} · 최종 선택: ${Object.entries(cons.final).map(([a, n]) => `${esc(finLab(a))} ${n}번`).join(', ')}` : '';
  const steps = cur.steps.map((s) => `<li><span class="badge b-neutral">${s.round}</span><span><b>${esc(ACTION_LABEL[qidOf(s.action, s.qty_packs)] || s.action)}</b>${s.round === 1 && s.action === 'check_physical_stock' ? ' <span class="muted">→ 확인 결과를 받고 다시 판단</span>' : ''}</span></li>`).join('');
  const last = cur.steps[cur.steps.length - 1];
  const ids = [...new Set(cur.steps.flatMap((s) => s.cited_ids || []))];
  const idsHtml = ids.length ? ids.map((i) => `<div style="margin-bottom:6px">${idBadge(i)}</div>`).join('') : '<p class="small muted">근거 번호를 들지 않았습니다.</p>';
  const flagHtml = cur.flags.length ? `<div class="callout warn" style="margin:12px 0"><p><b>검증에서 걸린 것</b><br>${cur.flags.map((f) => esc(flagText(f))).join('<br>')}</p></div>` : '';
  const finalQ = qidOf(last.action, last.qty_packs);
  return `${head}${layerSeg}${repSeg}
    <div class="sample-card"><span class="ribbon">${badge('hyp', `AI 답 · ${esc(RUNS.model)}`)}</span>
      ${modified ? '<p class="small"><b>조건을 바꿨으므로 저장된 답이 지금 상황과 맞지 않습니다.</b></p>' : ''}
      <p class="xs muted" style="margin:0 0 4px">AI가 한 일 (순서대로)</p><ol class="log" style="margin-bottom:12px">${steps}</ol>
      <p class="xs muted" style="margin:0">최종 선택</p><p class="big-choice">${esc(ACTION_LABEL[finalQ] || finalQ)}</p>
      <p class="xs muted" style="margin:0 0 2px">이유</p><p class="reason">${esc(last.reason)}</p>
      <p class="xs muted" style="margin:0 0 2px">중요하게 본 것</p><p class="small">${(last.priorities || []).map(esc).join(' · ') || '-'}</p>
      <p class="xs muted" style="margin:0 0 6px">근거로 든 인터뷰 번호 (데이터에 실제 있는지 확인)</p>${idsHtml}
      <p class="xs muted" style="margin:10px 0 2px">더 알고 싶은 정보</p><p class="small">${(last.missing_info || []).map(esc).join(' · ') || '없음'}</p>
      ${flagHtml}${consTxt ? `<p class="xs muted" style="margin:10px 0 0">${consTxt}</p>` : ''}
      <div class="btn-row sticky"><button class="btn btn-primary" type="button" data-saved-run="1">${cur.steps[0].action === 'check_physical_stock' && !S.checked ? '이 답대로 선반 확인하고 결과 보기' : '이 답으로 결과 보기'}</button></div>
    </div>`;
}
function runSaved() {
  const { cur } = savedPick(S.cardId); if (!cur) return;
  const refs = [...new Set(cur.steps.flatMap((s) => s.cited_ids || []))].filter((i) => lookup(i));
  if (cur.steps[0].action === 'check_physical_stock' && !S.checked) doCheck();
  const last = cur.steps[cur.steps.length - 1];
  S.finalRefs = refs;
  if (last.action === 'defer') { S.log.push({ t: 'defer', text: `AI 판단 유보: ${last.reason}` }); toast('AI가 판단을 유보했습니다. 결과 계산은 하지 않습니다.'); renderPanel(); return; }
  commit(qidOf(last.action, last.qty_packs), 'saved');
}
function savedAnswer(cardId) {
  if (!RUNS) return null;
  const layer = runLayers().includes('P0') ? 'P0' : runLayers()[0];
  const cur = runsFor(cardId, layer).find((r) => r.rep === 1) || runsFor(cardId, layer)[0];
  if (!cur) return null;
  const last = cur.steps[cur.steps.length - 1];
  return { src: `저장된 AI 답 (${layer} · ${RUNS.model} · 1번째 시도)`, first: qidOf(cur.first_action, cur.steps[0].qty_packs), final: qidOf(last.action, last.qty_packs), reason: last.reason, refs: [...new Set(cur.steps.flatMap((s) => s.cited_ids || []))] };
}

function renderStep2() {
  const c = S.cond;
  const modified = changedConds().length > 0;
  const stockLine = S.checked ? `전산 기록 ${c.book}팩 · <b>실제 선반 ${c.physical}팩 (확인함)</b>` : `전산 기록 ${c.book}팩 (${c.ageH}시간 전) · 실제 선반은 아직 모름`;
  let body = '';
  if (S.responder === 'saved') {
    body = savedHTML();
  } else if (S.responder === 'sample') {
    const cur = sampleCurrent();
    const isCheck = cur.kind === 'check_physical_stock';
    const alreadyChecked = isCheck && S.checked;
    body = `<div class="sample-card"><span class="ribbon">${badge('sample', '예시 · 실제 AI 아님')}</span>
      <p class="small muted">AI가 연결되면 이런 형태로 답이 나온다는 것을 보여 주려고 사람이 미리 쓴 응답입니다. 약사의 답도, 실제 AI의 출력도 아닙니다.${modified ? ' <b>조건을 바꿨으므로 이 예시가 지금 상황에 맞지 않을 수 있습니다.</b>' : ''}</p>
      <p class="xs muted" style="margin:12px 0 0">고른 행동</p><p class="big-choice">${esc(ACTION_LABEL[cur.kind === 'commit_choice' ? cur.q : cur.kind])}</p>
      <p class="xs muted" style="margin:0 0 2px">이유</p><p class="reason">${esc(cur.reason)}</p>
      <p class="xs muted" style="margin:0 0 6px">근거로 든 인터뷰 내용</p>${cur.claims.map(claimBlock).join('')}
      <p class="xs muted" style="margin:10px 0 2px">더 알고 싶은 정보</p><p class="small">${cur.missing.map(esc).join(' · ') || '없음'}</p>
      ${cur.kind === 'commit_choice' ? `<p class="xs muted" style="margin:0 0 6px">도매상 조건 검사 (코드)</p>${consList(cur.q)}` : ''}
      <div class="btn-row sticky">${isCheck
        ? `<button class="btn btn-primary" type="button" data-sample-run="1" ${alreadyChecked ? 'disabled' : ''}>이 응답대로 선반 확인하기</button>`
        : `<button class="btn btn-primary" type="button" data-sample-run="1">이 응답으로 결과 보기</button>`}</div></div>`;
  } else {
    const pa = S.pick.action;
    body = `
      <div class="sec-label"><span class="badge b-neutral">①</span> 먼저 확인할 것이 있나요?</div>
      <p class="sec-hint">전산 기록은 실제 선반과 다를 수 있습니다. 인터뷰 약사는 자주 나가는 약은 선반을 직접 본다고 말했습니다 ${chips(['E030'])}. 확인이 필요 없다고 생각하면 건너뛰어도 됩니다.</p>
      <div class="panel-flat">
        <p class="small" style="margin:0 0 8px">${stockLine}</p>
        <button class="btn btn-sm" type="button" data-check="1" ${S.checked ? 'disabled' : ''}><svg width="16" height="16" aria-hidden="true"><use href="#i-eye"/></svg>${S.checked ? '선반 확인함' : '선반 확인하기'}</button>
        <p class="xs muted" style="margin:8px 0 0">누르면 실제 재고가 공개되고 왼쪽 3D 선반에 갈색 상자로 나타납니다. 확인했다는 사실이 기록에 남습니다.</p>
      </div>
      <div class="sec-label"><span class="badge b-neutral">②</span> 어떻게 하시겠어요?</div>
      <p class="sec-hint">하나를 고르면 코드가 도매상 조건(최대 10팩, 외상 한도)을 넘지 않는지 바로 검사합니다. 검사는 규칙 위반만 알려 줄 뿐 좋고 나쁨을 판단하지 않습니다.</p>
      <div class="actions" role="radiogroup" aria-label="최종 선택">
        ${[['Q_0', '보류 (0팩)', '이번에는 주문하지 않기로 정합니다. 돈이 나가지 않습니다.'], ['Q_5', '5팩 주문', '하루치 정도를 후불로 주문합니다. 5만원.'], ['Q_10', '10팩 주문', '이틀치 정도를 후불로 주문합니다. 10만원.'], ['defer', '판단 유보', '정보가 부족해 아직 못 정합니다. 무엇이 더 필요한지 적습니다.']]
          .map(([v, t, d]) => `<label class="act"><input type="radio" name="act" value="${v}" ${pa === v ? 'checked' : ''}><span><b>${t}</b><small>${d}</small></span></label>`).join('')}
      </div>
      ${pa === 'defer' ? `<div class="field" style="margin-top:12px"><label for="defer-reason">왜 아직 못 정하나요? (필수)</label><input type="text" id="defer-reason" value="${esc(S.pick.deferReason)}" placeholder="예: 실제 재고를 모르는 상태에서는 정할 수 없음"></div>` : ''}
      ${pa && pa !== 'defer' ? `<p class="xs muted" style="margin:12px 0 6px">도매상 조건 검사 (코드)</p>${consList(pa)}` : ''}
      <div class="sec-label"><span class="badge b-neutral">③</span> 그렇게 고른 이유는?</div>
      <p class="sec-hint">이유가 된 인터뷰 내용을 고릅니다. 나중에 약사 답과 비교할 때, 약사가 꼽은 우선 조건과 겹치는지 보는 데 쓰입니다. 인터뷰가 이 수량을 직접 말한 것은 아니므로 "이번 상황에 적용한 추론"으로 기록됩니다.</p>
      <div class="checks">${EVIDENCE_PICKS.map((id) => { const r = lookup(id); return `<label class="check"><input type="checkbox" name="ref" value="${id}" ${S.pick.refs.has(id) ? 'checked' : ''}><span>${chip(id)} <span class="small">${esc(r ? r.title : '(데이터에 없음)')}</span></span></label>`; }).join('')}</div>
      <div class="field" style="margin-top:12px"><label for="missing">더 알고 싶은 정보 (선택)</label><input type="text" id="missing" value="${esc(S.pick.missing)}" placeholder="예: 다음 주 손님 수 추이"></div>
      <div class="btn-row sticky"><button class="btn btn-primary" type="button" data-commit="1" id="btn-commit">${pa === 'defer' ? '유보로 기록하기' : '이 선택으로 결과 보기'}</button></div>`;
  }
  const k = card();
  return `
    <div class="p-title"><h2>판단 내리기</h2><span class="xs muted">2 / 3</span></div>
    <div class="intro"><dl>
      <dt>하는 일</dt><dd>"이 약사라면 어떻게 할까?"를 정합니다. 확인 → 선택 → 이유 순서로 진행하고, 한 일은 순서대로 기록됩니다.</dd>
      <dt>누가</dt><dd>이 자리는 AI(페르소나)가 답하는 곳입니다. 화면이 AI를 직접 부르지는 않고, <b>저장된 AI 답</b>(터미널에서 미리 실행해 둔 결과)을 보여 줍니다. 결과가 없으면 <b>직접 판단</b>(내가 페르소나 역할)하거나 <b>예시 응답</b>(미리 써 둔 샘플)을 쓸 수 있습니다.</dd>
      <dt>다음</dt><dd>선택을 확정하면 결과 미리보기로 넘어갑니다. 판단 유보는 결과 없이 기록만 남습니다.</dd>
    </dl></div>
    <div class="panel-flat" style="margin-bottom:16px"><p class="xs muted" style="margin:0 0 2px">지금 상황</p><p style="margin:0;font-weight:600">${esc(k.title)}</p>${modified ? `<p class="xs" style="margin:4px 0 0">${badge('hyp', `조건 바꿈: ${changedConds().join(', ')}`)}</p>` : ''}<button class="btn btn-ghost btn-sm" type="button" data-go="1" style="margin:6px 0 0 -10px">상황 다시 보기</button></div>
    <div class="cond-row"><span class="lab" id="lab-resp">누가 판단하나요?</span>
      <span class="seg" role="radiogroup" aria-labelledby="lab-resp"><label><input type="radio" name="resp" value="direct" ${S.responder === 'direct' ? 'checked' : ''}><span>직접 판단</span></label><label><input type="radio" name="resp" value="saved" ${S.responder === 'saved' ? 'checked' : ''}><span>저장된 AI 답${RUNS ? '' : ' (없음)'}</span></label><label><input type="radio" name="resp" value="sample" ${S.responder === 'sample' ? 'checked' : ''}><span>예시 응답 보기</span></label></span></div>
    ${body}
    <div class="sec-label">지금까지 한 일</div>
    <p class="sec-hint">AI를 연결해도 같은 방식으로 기록됩니다. "확인하겠다"는 말이 아니라 실제로 무엇을 눌렀는지가 남습니다.</p>
    ${logList()}
    <div class="btn-row"><button class="btn btn-ghost btn-danger" type="button" data-reset="2">판단 처음부터 다시</button></div>`;
}

/* ----- 차트 (닫힌 재고 추이) ----- */
function chartSVG(res) {
  const W = 540, H = 250, L = 40, R = 104, T = 16, B = 40;
  const ser = res.map((r, i) => ({ r, cls: ['s-hold', 's-q5', 's-q10'][i], name: ['보류', '5팩', '10팩'][i], shape: ['c', 's', 't'][i], pts: [S.cond.physical, ...r.timeline.map((t) => t.closing)] }));
  const ymax = Math.max(10, ...ser.flatMap((s) => s.pts));
  const yTop = Math.ceil(ymax / 5) * 5;
  const X = (i) => L + (i * (W - L - R)) / 3;
  let dodge = 0; // 값이 같아 겹치는 선도 보이도록 시리즈마다 화면에서만 살짝 어긋나게 그린다 (값은 그대로).
  const Y = (v) => T + (1 - v / yTop) * (H - T - B) + dodge;
  const xl = ['판단 시점', `${dl(E.CAL[0])} 마감`, `${dl(E.CAL[1])} 마감`, `${dl(E.CAL[2])} 마감`];
  let g = '';
  for (let v = 0; v <= yTop; v += 5) g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 8}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`;
  xl.forEach((t, i) => { g += `<text x="${X(i)}" y="${H - 14}" text-anchor="middle">${t}</text>`; });
  const mark = (s, x, y, v, i, sel) => {
    const sz = sel ? 6 : 5;
    const shape = s.shape === 'c' ? `<circle class="${s.cls}" cx="${x}" cy="${y}" r="${sz}" stroke="var(--surface)" stroke-width="2"/>`
      : s.shape === 's' ? `<rect class="${s.cls}" x="${x - sz}" y="${y - sz}" width="${sz * 2}" height="${sz * 2}" stroke="var(--surface)" stroke-width="2"/>`
        : `<path class="${s.cls}" d="M${x} ${y - sz - 1}L${x + sz + 1} ${y + sz}L${x - sz - 1} ${y + sz}Z" stroke="var(--surface)" stroke-width="2"/>`;
    return `<g><title>${s.name}: ${xl[i]} 재고 ${v}팩 (가상)</title>${shape}<circle cx="${x}" cy="${y}" r="13" fill="transparent"/></g>`;
  };
  let lines = '';
  const ends = [];
  ser.forEach((s, si) => {
    dodge = (si - 1) * 3.5;
    const sel = s.r.qid === S.chosen;
    const d = s.pts.map((v, i) => `${i ? 'L' : 'M'}${X(i)} ${Y(v)}`).join(' ');
    lines += `<path class="${s.cls}" d="${d}" style="fill:none" stroke-width="${sel ? 3.5 : 2}" opacity="${sel ? 1 : 0.85}"/>`;
    s.pts.forEach((v, i) => { lines += mark(s, X(i), Y(v), v, i, sel); });
    ends.push({ y: Y(s.pts[3]), s, v: s.pts[3], sel });
  });
  dodge = 0;
  ends.sort((a, b) => a.y - b.y);
  // 끝점 라벨이 겹치지 않게, 원래 높이를 중심으로 일정 간격으로 펼친다.
  const mid = ends.reduce((a, e) => a + e.y, 0) / ends.length;
  ends.forEach((e, i) => { e.y = mid + (i - (ends.length - 1) / 2) * 17; });
  const labels = ends.map((e) => `<text x="${W - R + 12}" y="${e.y + 4}" style="font-weight:${e.sel ? 700 : 500}">${e.s.name} ${e.v}팩${e.sel ? ' (선택)' : ''}</text>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="선택별 재고 추이. 표로도 볼 수 있습니다.">${g}<line class="axis" x1="${L}" x2="${W - R}" y1="${Y(0)}" y2="${Y(0)}"/>${lines}${labels}</svg>`;
}

function renderStep3() {
  const res = S.result;
  const ch = res.find((r) => r.qid === S.chosen);
  const rows = res.map((r, i) => {
    const m = r.metrics, sel = r.qid === S.chosen;
    const pay = r.payables.filter((p) => p.origin === 'current')[0];
    return `<tr class="${sel ? 'sel' : ''}"><td><b>${['보류', '5팩 주문', '10팩 주문'][i]}</b><br>${sel ? badge('interview', '선택') : badge('neutral', '비교용 계산')}${pay ? `<br><span class="xs muted">${dl(pay.recognized)} 입고, ${dl(pay.due)} 결제</span>` : ''}</td>
      <td class="num">${m.unmetTotal}팩</td><td class="num">${m.endingPacks}팩</td><td class="num">${E.won(m.endingValueKrw)}</td><td class="num">${E.won(m.newCommitKrw)}</td></tr>`;
  }).join('');
  const days = ch.timeline.map((t) => `<tr data-day="${t.i}" class="${S.day === t.i ? 'sel' : ''}"><td>${dl(t.date)}</td><td class="num">${t.opening}</td><td class="num">${t.received}</td><td class="num">${t.demand}</td><td class="num">${t.fulfilled}</td><td class="num">${t.unmet}</td><td class="num">${t.closing}</td></tr>`).join('');
  const refs = S.finalRefs.length ? chips(S.finalRefs) : '<span class="small muted">근거를 붙이지 않았습니다.</span>';
  const tableAll = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>시점</th>${res.map((_, i) => `<th class="num">${['보류', '5팩', '10팩'][i]} 재고</th>`).join('')}</tr></thead><tbody>${['판단 시점', ...E.CAL.map((d) => `${dl(d)} 마감`)].map((lab, k) => `<tr><td>${lab}</td>${res.map((r) => `<td class="num">${k === 0 ? S.cond.physical : r.timeline[k - 1].closing}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  return `
    <div class="p-title"><h2>결과 미리보기</h2><span class="xs muted">3 / 3</span></div>
    <div class="intro"><dl>
      <dt>하는 일</dt><dd>고른 선택대로 사흘을 진행하면 재고가 어떻게 되는지 코드가 계산합니다. 하루 손님 5명은 가정입니다. 왼쪽 아래 <b>재생</b>을 누르면 3D에서 하루씩 볼 수 있습니다.</dd>
      <dt>왜 사흘</dt><dd>주문한 약은 하루나 이틀 뒤에 들어옵니다. "들어오기 전까지 몇 명을 돌려보내는지"와 "들어온 뒤 얼마나 남는지"를 함께 보려면 최소 사흘이 필요합니다.</dd>
      <dt>주의</dt><dd>이 결과는 선택의 무게를 이해하기 위한 <b>참고 자료</b>입니다. 약사 답과 AI 답의 비교(재현도)에는 쓰지 않고, 약사에게 물을 때도 보여 주지 않습니다.</dd>
    </dl></div>
    <p class="xs muted" style="margin:0">고른 선택</p>
    <p class="big-choice">${esc(ACTION_LABEL[S.chosen])} ${badge(S.source === 'sample' ? 'sample' : S.source === 'saved' ? 'hyp' : 'interview', S.source === 'sample' ? '예시 응답' : S.source === 'saved' ? '저장된 AI 답' : '직접 판단')}</p>
    <p class="small muted" style="margin-bottom:6px">선반 확인 ${S.log.filter((l) => l.t === 'check').length}회 · 이유로 고른 인터뷰 내용</p>${refs}
    <div class="sec-label">같은 손님 수에서 세 가지 선택 비교 ${VIRT}</div>
    <p class="sec-hint">고른 선택만 계산하면 비교할 기준이 없어서, 고르지 않은 선택도 같은 조건으로 계산해 나란히 놓았습니다. "선택" 표시가 붙은 줄이 실제로 고른 것입니다.</p>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>선택</th><th class="num">못 판 손님</th><th class="num">남은 재고</th><th class="num">남은 재고 금액</th><th class="num">새 주문 금액</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="callout warn" style="margin-top:12px"><b>못 판 손님이 0명이라고 좋은 선택은 아닙니다.</b> 반품, 유효기간, 월 결제 부담은 이 계산에 없습니다. 인터뷰 약사는 이 부담 때문에 많이 사 두기를 꺼린다고 말했습니다 ${chips(['E034', 'E038'])}. 그래서 남은 재고 금액과 새 주문 금액을 같이 봅니다. 팩당 ${E.won(E.UNIT_COST)}은 가정입니다.</div>
    <div class="sec-label">재고가 어떻게 변하나</div>
    <div class="chart-legend"><span><svg width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="var(--s-blue)"/></svg>보류</span><span><svg width="14" height="14" aria-hidden="true"><rect x="2" y="2" width="10" height="10" fill="var(--s-orange)"/></svg>5팩 주문</span><span><svg width="14" height="14" aria-hidden="true"><path d="M7 1L13 13H1Z" fill="var(--s-aqua)"/></svg>10팩 주문</span></div>
    ${chartSVG(res)}
    <p class="xs muted" style="margin:4px 0 0">값이 같은 선은 겹쳐 보이지 않도록 화면에서만 살짝 어긋나게 그렸습니다. 정확한 값은 표로 확인하세요.</p>
    <details class="help" style="margin-top:8px"><summary>표로 보기</summary>${tableAll}</details>
    <details class="help"><summary>일별 상세 (선택한 선택지)</summary><div class="tbl-wrap"><table class="tbl"><thead><tr><th>날짜</th><th class="num">시작</th><th class="num">입고</th><th class="num">수요</th><th class="num">판매</th><th class="num">못 판</th><th class="num">마감</th></tr></thead><tbody>${days}</tbody></table></div><p class="xs muted" style="margin-top:8px">못 판 수요는 다음 날로 이월하지 않습니다. 입고는 해당일 수요가 생기기 전에 반영합니다.${ch.dupIgnored ? ` 같은 입고 통지가 ${ch.dupIgnored}번 더 왔지만 재고와 채무는 한 번만 늘렸습니다.` : ''}</p></details>
    <div class="sec-label">무엇이 확인되었나</div>
    <p class="sec-hint">네 가지는 서로 다른 것을 확인하므로 하나의 점수로 합치지 않습니다.</p>
    <div class="status-strip">
      <div><b>데이터 구조</b>${badge('good', '통과')}<br><span class="muted">근거 번호와 열 형식 8가지 검사</span></div>
      <div><b>계산</b>${selfTestBadge()}<br><span class="muted">이 화면의 계산을 팀 검증표와 대조</span></div>
      <div><b>판단 재현</b>${badge('unknown', '아직 안 함')}<br><span class="muted">약사 답과 비교해야 알 수 있음</span></div>
      <div><b>니즈</b>${badge('unknown', '아직 안 함')}<br><span class="muted">약사 확인 전</span></div>
    </div>
    <div class="callout" style="margin-top:20px"><b>다음 할 일</b><br>이 상황 카드를 실제 약사에게 보여 주고 답을 받아, "약사 답과 비교" 화면에 입력합니다. 결과 화면은 보여 주지 않습니다.</div>
    <div class="btn-row sticky"><a class="btn btn-primary" href="#/validate" data-to-validate="1">약사 답과 비교하기</a><button class="btn" type="button" data-reset="1">다른 상황으로 다시</button></div>`;
}

function renderPanel(focusSel) {
  $('#panel').innerHTML = S.step === 1 ? renderStep1() : S.step === 2 ? renderStep2() : renderStep3();
  renderStepper();
  if (focusSel) { const el = $(focusSel, $('#panel')); el && el.focus({ preventScroll: true }); }
}

/* 패널 이벤트 (위임) */
const panel = $('#panel');
panel.addEventListener('change', (e) => {
  const t = e.target, n = t.name;
  if (n === 'card') { S.cardId = t.value; resetSim(); renderPanel(`input[name=card][value=${t.value}]`); applyScene(); }
  else if (n === 'cash') { S.cond.cash = Number(t.value); resetSim(true); renderPanel(`input[name=cash][value="${t.value}"]`); }
  else if (n === 'arrival') { S.cond.arrival = t.value; resetSim(true); renderPanel(`input[name=arrival][value="${t.value}"]`); }
  else if (n === 'prior') { S.cond.prior = t.checked; resetSim(true); renderPanel('input[name=prior]'); }
  else if (n === 'gap') { S.cond.physical = t.checked ? 3 : 8; S.cond.ageH = t.checked ? 72 : 12; resetSim(true); renderPanel('input[name=gap]'); applyScene(); }
  else if (n === 'svlayer') { SV.layer = t.value; renderPanel(`input[name=svlayer][value=${t.value}]`); }
  else if (n === 'svrep') { SV.rep = Number(t.value); renderPanel(`input[name=svrep][value=${t.value}]`); }
  else if (n === 'resp') { S.responder = t.value; renderPanel(`input[name=resp][value=${t.value}]`); }
  else if (n === 'act') { S.pick.action = t.value; renderPanel(`input[name=act][value=${t.value}]`); }
  else if (n === 'ref') { t.checked ? S.pick.refs.add(t.value) : S.pick.refs.delete(t.value); }
});
panel.addEventListener('input', (e) => {
  if (e.target.id === 'missing') S.pick.missing = e.target.value;
  if (e.target.id === 'defer-reason') S.pick.deferReason = e.target.value;
});
panel.addEventListener('click', (e) => {
  const b = e.target.closest('button, a'); if (!b) return;
  if (b.dataset.go) goStep(Number(b.dataset.go));
  else if (b.dataset.reset) { const keep = b.dataset.reset === '2'; resetSim(keep); S.step = keep ? 2 : 1; renderPanel(); applyScene(); toast(keep ? '판단을 처음부터 다시 시작합니다.' : '조건을 카드 기본값으로 되돌렸습니다.'); }
  else if (b.dataset.check) doCheck();
  else if (b.dataset.sampleRun) runSample();
  else if (b.dataset.savedRun) runSaved();
  else if (b.dataset.commit) commitDirect();
  else if (b.dataset.toValidate) { V.cardId = S.cardId; }
});
function doCheck() {
  if (S.checked) return;
  S.obs = E.checkPhysical(S.obs, S.cond); S.checked = true;
  S.log.push({ t: 'check', text: `선반 확인 → 실제 ${S.cond.physical}팩 (전산 기록은 ${S.cond.book}팩)` });
  toast(`선반에 실제로 ${S.cond.physical}팩이 있습니다. 이 정보로 다시 판단하세요.`);
  renderPanel('[data-check]'); applyScene();
}
function runSample() {
  const cur = sampleCurrent();
  if (cur.kind === 'check_physical_stock') { doCheck(); S.sampleIdx += 1; renderPanel(); return; }
  S.pick.refs = new Set(cur.claims.flatMap((c) => c.ids));
  S.finalRefs = [...S.pick.refs];
  commit(cur.q, 'sample');
}
function commitDirect() {
  const a = S.pick.action;
  if (!a) { toast('최종 선택을 먼저 고르세요.'); $('input[name=act]', panel)?.focus(); return; }
  if (a === 'defer') {
    if (!S.pick.deferReason.trim()) { toast('유보 사유를 적어야 합니다.'); $('#defer-reason')?.focus(); return; }
    S.log.push({ t: 'defer', text: `판단 유보: ${S.pick.deferReason.trim()}${S.pick.missing ? ` (필요한 정보: ${S.pick.missing})` : ''}` });
    toast('판단 유보로 기록했습니다. 시간은 흐르지 않았습니다.');
    S.pick.action = null; S.pick.deferReason = ''; renderPanel(); return;
  }
  S.finalRefs = [...S.pick.refs];
  commit(a, 'direct');
}
function commit(qid, source) {
  const r = E.runBranch(S.cond, qid);
  if (r.error) { toast(r.error + ' — 자동으로 고치지 않습니다. 다른 선택을 하세요.'); return; }
  S.result = E.runAll(S.cond); S.chosen = qid; S.source = source;
  S.log.push({ t: 'commit', text: `선택 확정: ${ACTION_LABEL[qid]} (${source === 'sample' ? '예시 응답' : source === 'saved' ? '저장된 AI 답' : '직접 판단'})` });
  S.step = 3; S.day = 0;
  renderPanel(); applyScene(); $('.panel-col').scrollTop = 0;
  const h = $('#panel h2'); h && (h.tabIndex = -1, h.focus({ preventScroll: true }));
  if (!reduceMotion()) startPlay(); else toast('재생 버튼이나 날짜 버튼으로 3일을 확인하세요.');
}

/* ---------- 계산 자체 점검 ---------- */
let SELFTEST = null;
function selfTest() {
  let ok = 0, total = 0;
  CARDS.forEach((k) => E.runAll(k.cond).forEach((r) => {
    const exp = EXPECTED[k.id][r.qid]; total += 1;
    if (r.metrics.unmetTotal === exp[0] && r.metrics.endingPacks === exp[1] && r.metrics.newCommitKrw === exp[2]) ok += 1;
  }));
  return { ok, total };
}
function selfTestBadge() { return SELFTEST.ok === SELFTEST.total ? badge('good', `${SELFTEST.ok}/${SELFTEST.total} 일치`) : badge('bad', `${SELFTEST.ok}/${SELFTEST.total} 불일치`); }

/* ---------- 비교·검증 ---------- */
const V = { cardId: 'C01', round: 1, step: 'A', cur: null, confirmClear: false };
const REC_KEY = 'pp-records';
const records = () => store.get(REC_KEY, []);
const FIRST = [['check_physical_stock', '선반부터 확인'], ['Q_0', '보류 (0팩)'], ['Q_5', '5팩 주문'], ['Q_10', '10팩 주문'], ['defer', '판단 유보'], ['other', '후보 밖의 답']];
function aiAnswer(cardId) {
  if (S.result && S.cardId === cardId && S.chosen) {
    const first = S.log.some((l) => l.t === 'check') ? 'check_physical_stock' : S.chosen;
    const lab = { sample: '예시 응답', saved: '저장된 AI 답', direct: '직접 판단 결과' }[S.source] || '직접 판단 결과';
    const reason = S.source === 'sample' ? SAMPLES[cardId].slice(-1)[0].reason : S.source === 'saved' ? (savedAnswer(cardId) || {}).reason || '' : '(직접 판단)';
    return { src: lab, first, final: S.chosen, reason, refs: S.finalRefs };
  }
  const sv = savedAnswer(cardId);
  if (sv) return sv;
  const list = SAMPLES[cardId]; const last = list[list.length - 1];
  return { src: '예시 응답 (비실행)', first: list[0].kind === 'check_physical_stock' ? 'check_physical_stock' : list[0].q, final: last.q, reason: last.reason, refs: [...new Set(last.claims.flatMap((c) => c.ids))] };
}
function renderValidate() {
  const root = $('#validate-root');
  const recs = records();
  const cur = V.cur ? recs.find((r) => r.id === V.cur) : null;
  const stepA = !cur, stepB = cur && !cur.cmp, stepC = cur && cur.cmp;
  const ai = aiAnswer(V.cardId);
  const firstOpts = FIRST.map(([v, t]) => `<label class="act"><input type="radio" name="vfirst" value="${v}" ${cur && cur.human.first === v ? 'checked' : ''} ${cur ? 'disabled' : ''}><span><b>${t}</b></span></label>`).join('');
  const vk = cardById(V.cardId);
  const formA = `
    <div class="panel">
      <h2>약사 답 먼저 받기</h2>
      <p class="muted">약사에게 아래 상황만 읽어 주고 답을 받아 적습니다. 결과 미리보기나 AI 답은 보여 주지 않습니다. 고를 수 있는 것 밖의 답도 그대로 받습니다.</p>
      <div class="field"><label for="v-card">물어볼 상황</label><select id="v-card">${CARDS.map((k) => `<option value="${k.id}" ${k.id === V.cardId ? 'selected' : ''}>${esc(k.title)}</option>`).join('')}</select></div>
      <div class="panel-flat" style="margin-bottom:16px"><p class="xs muted" style="margin:0 0 4px">약사에게 읽어 줄 내용</p><p style="margin:0 0 8px">${esc(vk.story)} 몇 팩을 주문하시겠어요?</p><p class="xs" style="margin:0">${supportBadge(vk)} ${badge('neutral', '연습용')} <span class="muted">인터뷰가 다룬 요소로 만든 카드라 재현도 판정에는 쓰지 않습니다.</span></p></div>
      <div class="field"><label for="v-round">몇 번째 응답인가요?</label><select id="v-round"><option value="1" ${V.round === 1 ? 'selected' : ''}>처음 묻는 것</option><option value="2" ${V.round === 2 ? 'selected' : ''}>시간을 두고 같은 상황을 다시 묻는 것</option></select><span class="hint">같은 약사도 다시 물으면 답이 바뀔 수 있습니다. 다시 물은 답은 "사람끼리도 이 정도는 다르다"는 기준선이 됩니다.</span></div>
      <p class="sec-label">약사가 가장 먼저 한 행동</p><p class="sec-hint">"일단 선반부터 볼게요"처럼 확인부터 하겠다고 하면 첫 번째를 고릅니다.</p><div class="actions" role="radiogroup" aria-label="약사의 첫 행동">${firstOpts}</div>
      <p class="sec-label">괜찮다고 본 주문량</p><p class="sec-hint">"5팩에서 7팩 정도"처럼 범위로 받습니다. 하나만 말하면 최소와 최대에 같은 값을 넣습니다.</p>
      <div class="field-row">
        <div class="field"><label for="v-min">최소 (팩)</label><input type="number" id="v-min" min="0" max="10" inputmode="numeric"></div>
        <div class="field"><label for="v-max">최대 (팩)</label><input type="number" id="v-max" min="0" max="10" inputmode="numeric"></div>
      </div>
      <p class="sec-label">가장 중요하게 본 것 두 가지</p><p class="sec-hint">약사가 한 말을 그대로 적습니다. 예: "내일 손님 못 받는 것", "이번 달 약값".</p>
      <div class="field-row">
        <div class="field"><label for="v-p1">첫째</label><input type="text" id="v-p1"></div>
        <div class="field"><label for="v-p2">둘째</label><input type="text" id="v-p2"></div>
      </div>
      <div class="field"><label for="v-need">더 알고 싶다고 한 정보</label><textarea id="v-need"></textarea></div>
      <div class="field-row">
        <div class="field"><label for="v-real">이 상황이 현실적이라고 했나요?</label><select id="v-real"><option value="현실적">현실적이다</option><option value="부분적">부분적으로 현실적이다</option><option value="비현실적">현실적이지 않다</option></select></div>
        <div class="field"><label for="v-note">현실성에 대한 말 (선택)</label><input type="text" id="v-note"></div>
      </div>
      <div class="btn-row"><button class="btn btn-primary" type="button" id="v-save-a">약사 답 저장하고 AI 답 열기</button></div>
    </div>`;
  const aiBlock = `
    <div class="panel">
      <h2>AI 답 ${badge('sample', ai.src)}</h2>
      <p class="small muted">${ai.src.includes('예시') ? '실제 AI가 아니라 설명용으로 미리 쓴 예시입니다. AI를 연결하면 이 자리에 실제 답이 들어옵니다.' : '시뮬레이터에서 직접 판단한 결과입니다. AI를 연결하면 이 자리에 실제 답이 들어옵니다.'}</p>
      <dl class="kv"><dt>첫 행동</dt><dd><b>${esc(ACTION_LABEL[ai.first])}</b></dd><dt>최종 선택</dt><dd>${esc(ACTION_LABEL[ai.final])}</dd><dt>이유</dt><dd>${esc(ai.reason)}</dd><dt>근거</dt><dd>${ai.refs.length ? chips(ai.refs) : '없음'}</dd></dl>
    </div>`;
  let compare = '';
  if (cur) {
    const h = cur.human;
    const firstMatch = h.first === cur.ai.first;
    const qty = QTY[cur.ai.final];
    const inRange = h.min === '' || h.max === '' || qty === undefined ? null : (qty >= Number(h.min) && qty <= Number(h.max));
    compare = `
      <div class="panel">
        <h2>비교 기록 <span class="small muted" style="font-weight:400">${esc(cardById(cur.cardId).title)}</span></h2>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>항목</th><th>약사</th><th>AI</th><th>결과</th></tr></thead><tbody>
          <tr><td>첫 행동</td><td>${esc(ACTION_LABEL[h.first])}</td><td>${esc(ACTION_LABEL[cur.ai.first])}</td><td>${badge(firstMatch ? 'good' : 'bad', firstMatch ? '같음' : '다름')}</td></tr>
          <tr><td>주문량</td><td>${h.min !== '' ? `${esc(h.min)}~${esc(h.max)}팩` : '입력 안 함'}</td><td>${qty === undefined ? '해당 없음' : qty + '팩'}</td><td>${inRange === null ? badge('neutral', '비교 불가') : badge(inRange ? 'good' : 'bad', inRange ? '약사 범위 안' : '약사 범위 밖')}</td></tr>
          <tr><td>중요하게 본 것</td><td>${esc(h.p1)} / ${esc(h.p2)}</td><td>${cur.ai.refs.length ? '근거 ' + cur.ai.refs.map(esc).join(', ') : '-'}</td><td>${cur.cmp ? esc(cur.cmp.pri) : '아래에서 기록'}</td></tr>
          <tr><td>더 알고 싶은 정보</td><td>${esc(h.need) || '-'}</td><td>-</td><td>${cur.cmp ? esc(cur.cmp.need) : '아래에서 기록'}</td></tr>
        </tbody></table></div>
        ${cur.cmp ? `<p class="small" style="margin-top:12px">${badge('good', '비교 기록 저장됨')}</p>` : `
        <p class="sec-hint" style="margin-top:16px">첫 행동과 주문량은 위에서 자동으로 비교했습니다. 글로 된 두 항목은 약사의 말과 AI의 이유를 읽고 직접 고릅니다.</p>
        <div class="field-row">
          <div class="field"><label for="c-pri">중요하게 본 것이 겹치는 정도</label><select id="c-pri"><option>0개 겹침</option><option>1개 겹침</option><option>2개 겹침</option></select></div>
          <div class="field"><label for="c-need">더 알고 싶은 정보가 겹치는 정도</label><select id="c-need"><option>겹침</option><option>일부 겹침</option><option>겹치지 않음</option></select></div>
        </div>
        <div class="btn-row"><button class="btn btn-primary" type="button" id="v-save-c">비교 기록 저장</button></div>`}
      </div>
      ${cur.cmp ? candidateBlock(cur) : ''}`;
  }
  const steps = `<ol class="vsteps" aria-label="진행 단계">
    <li ${stepA ? 'aria-current="step"' : ''} class="${cur ? 'done' : ''}"><span class="n">1</span><span>약사 답 받기<small>AI 답을 보기 전에</small></span></li>
    <li ${stepB ? 'aria-current="step"' : ''} class="${cur ? 'done' : ''}"><span class="n">2</span><span>AI 답 열기 ${cur ? '' : badge('neutral', '잠김')}<small>약사 답을 저장하면 열림</small></span></li>
    <li ${stepC ? 'aria-current="step"' : ''} class="${cur && cur.cmp ? 'done' : ''}"><span class="n">3</span><span>비교 기록<small>겹치는 정도를 남김</small></span></li>
    <li class="${cur && candidates().some((x) => x.recordId === cur.id) ? 'done' : ''}"><span class="n">4</span><span>근거 후보 (선택)<small>인터뷰에 없던 새 내용</small></span></li></ol>
    ${cur ? '<button class="btn btn-sm" type="button" id="v-new" style="margin-top:12px;width:100%">새 기록 시작</button>' : ''}`;
  root.innerHTML = `
    <div class="vgrid">
      <div>${steps}</div>
      <div class="stack">
        ${stepA ? formA : ''}
        ${cur ? aiBlock : ''}
        ${compare}
        ${summaryHTML()}
      </div>
    </div>`;
}
/* 근거 후보: 약사 답 중 인터뷰에 없던 내용. 앱은 claims.csv 를 고치지 않는다(1번 폴더는 source/ Excel 이 원본).
   후보를 CSV 로 내보내면 팀이 검토해 Excel 에 넣고 build.py 로 반영한다. 그때 E 번호가 붙는다. */
const CAND_KEY = 'pp-candidates';
const candidates = () => store.get(CAND_KEY, []);
function candidateBlock(rec) {
  const mine = candidates().filter((x) => x.recordId === rec.id);
  return `
    <div class="panel">
      <h2>근거 후보로 남기기 <span class="small muted" style="font-weight:400">선택</span></h2>
      <p class="muted">약사가 이번 답에서 <b>인터뷰에 없던 판단 기준이나 경험</b>을 말했다면 여기에 남깁니다. 페르소나가 다음에 참고할 근거가 될 수 있습니다.</p>
      <div class="callout warn" style="margin-bottom:16px"><b>아직 근거가 아닙니다.</b> 이 화면은 인터뷰 근거 파일을 직접 고치지 않습니다. 후보를 파일로 내보내 팀이 검토한 뒤 원본 Excel에 넣어야 근거가 되고, 그때 새 번호(E###)가 붙습니다. 근거로 넣은 뒤에는 <b>이 상황 카드로 이 약사의 재현도를 잴 수 없습니다.</b> 답을 미리 알려 준 셈이기 때문입니다.</div>
      ${mine.length ? `<ul class="log" style="margin-bottom:16px">${mine.map((x) => `<li>${badge('unknown', '검토 대기')}<span><b>${esc(x.topic_ko)}</b> · "${esc(x.quote_ko)}"</span></li>`).join('')}</ul>` : ''}
      <div class="field"><label for="cd-topic">주제</label><input type="text" id="cd-topic" placeholder="예: 기존 주문 확인 순서"><span class="hint">한두 단어로 적습니다. 인터뷰 근거의 "주제" 열과 같은 형식입니다.</span></div>
      <div class="field"><label for="cd-quote">약사가 한 말 (그대로)</label><textarea id="cd-quote" placeholder="해석하지 않고 들은 대로 적습니다"></textarea></div>
      <div class="field"><label for="cd-sum">한 줄 요약</label><input type="text" id="cd-sum" placeholder="예: 추가 주문 전 거래처별 미입고 주문을 먼저 확인한다"></div>
      <div class="field"><label for="cd-scope">어디에 해당하는 말인가요?</label><select id="cd-scope"><option>현재 약국</option><option>과거 근무처</option><option>다른 약국</option><option>일반 의견</option></select><span class="hint">과거 직장이나 다른 약국 이야기를 지금 약국의 판단으로 쓰지 않기 위한 구분입니다 (G01).</span></div>
      <div class="btn-row"><button class="btn" type="button" id="cd-add">근거 후보에 추가</button></div>
    </div>`;
}
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
function downloadFile(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); URL.revokeObjectURL(a.href);
}

function summaryHTML() {
  const recs = records().filter((r) => r.cmp);
  const first = recs.filter((r) => r.human.first === r.ai.first).length;
  // 변화 방향 (카드 쌍)
  const dirRows = PAIRS.map((p) => {
    const a = recs.find((r) => r.cardId === p.a && r.round === 1), b = recs.find((r) => r.cardId === p.b && r.round === 1);
    const pairName = `${esc(cardById(p.a).short)} ↔ ${esc(cardById(p.b).short)}`;
    if (!a || !b) return `<tr><td>${pairName}</td><td>${p.changed}</td><td colspan="3" class="muted">두 상황의 기록이 모두 있어야 비교할 수 있습니다.</td></tr>`;
    const q = (r, who) => QTY[who === 'h' ? r.human.first : r.ai.final];
    const sgn = (x, y) => (x === undefined || y === undefined ? null : Math.sign(y - x));
    const hd = sgn(q(a, 'h'), q(b, 'h')), ad = sgn(QTY[a.ai.final], QTY[b.ai.final]);
    const lab = (d) => (d === null ? '비교 불가' : d > 0 ? '늘림' : d < 0 ? '줄임' : '그대로');
    return `<tr><td>${pairName}</td><td>${p.changed}</td><td>${lab(hd)}</td><td>${lab(ad)}</td><td>${hd === null || ad === null ? badge('neutral', '비교 불가') : badge(hd === ad ? 'good' : 'bad', hd === ad ? '방향 같음' : '방향 다름')}</td></tr>`;
  }).join('');
  // 본인 재응답
  const byCard = {};
  records().forEach((r) => { (byCard[r.cardId] = byCard[r.cardId] || []).push(r); });
  const selfRows = Object.entries(byCard).filter(([, v]) => v.some((r) => r.round === 1) && v.some((r) => r.round === 2)).map(([id, v]) => {
    const r1 = v.find((r) => r.round === 1), r2 = v.find((r) => r.round === 2);
    return `<tr><td>${esc(cardById(id).short)}</td><td>${esc(ACTION_LABEL[r1.human.first])}</td><td>${esc(ACTION_LABEL[r2.human.first])}</td><td>${badge(r1.human.first === r2.human.first ? 'good' : 'bad', r1.human.first === r2.human.first ? '같음' : '다름')}</td></tr>`;
  }).join('');
  const all = records();
  const cands = candidates();
  return `
  <div class="panel">
    <h2>지금까지의 기록</h2>
    <div class="callout warn"><b>판정을 내리지 않습니다.</b> "몇 개가 같으면 재현한다"고 볼지 정하는 기준이 아직 없습니다. 응답자가 1명이고 상황이 적어서, 통계가 아니라 어디서 다른지 찾는 용도로만 씁니다. 아래는 횟수만 보여 줍니다.</div>
    <p style="margin-top:12px">비교 기록 <b>${recs.length}건</b> · 첫 행동이 같음 <b>${first}건</b> / 다름 <b>${recs.length - first}건</b></p>
    <h3 style="margin-top:24px">조건 하나를 바꿨을 때 같은 쪽으로 움직였나</h3>
    <p class="sec-hint">예를 들어 현금이 넉넉해졌을 때 약사가 주문을 늘렸다면, AI도 늘렸는지 봅니다. 답이 정확히 같지 않아도 반응 방향이 같으면 판단 방식이 닮았다고 볼 여지가 있습니다.</p>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>비교한 두 상황</th><th>바꾼 조건</th><th>약사</th><th>AI</th><th>결과</th></tr></thead><tbody>${dirRows}</tbody></table></div>
    <h3 style="margin-top:24px">약사 본인에게 다시 물었을 때</h3>
    <p class="sec-hint">같은 약사도 답이 바뀐다면, AI에게 그보다 높은 일치를 기대할 수 없습니다.</p>
    ${selfRows ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>상황</th><th>처음 첫 행동</th><th>다시 물은 첫 행동</th><th>결과</th></tr></thead><tbody>${selfRows}</tbody></table></div>` : '<p class="small muted">같은 상황을 처음 물은 기록과 다시 물은 기록이 모두 있어야 표시됩니다.</p>'}
    <h3 style="margin-top:24px">저장된 기록 ${all.length}건</h3>
    ${all.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>상황</th><th>차수</th><th>약사 첫 행동</th><th>AI 첫 행동</th><th>근거 후보</th><th>시각</th></tr></thead><tbody>${all.map((r) => `<tr><td>${esc(cardById(r.cardId).short)}</td><td>${r.round === 1 ? '처음' : '다시 물음'}</td><td>${esc(ACTION_LABEL[r.human.first])}</td><td>${esc(ACTION_LABEL[r.ai.first])}</td><td>${cands.filter((x) => x.recordId === r.id).length || '-'}</td><td class="xs">${esc(new Date(r.savedAt).toLocaleString('ko-KR'))}</td></tr>`).join('')}</tbody></table></div>` : '<p class="small muted">아직 기록이 없습니다. 위에서 약사 답을 먼저 저장하세요.</p>'}
    <h3 style="margin-top:24px">근거 후보 ${cands.length}건</h3>
    <p class="sec-hint">CSV로 내보내면 인터뷰 근거 파일과 같은 열(주제, 해당 범위, 기록 유형, 발언, 요약, 출처 위치)로 나옵니다. 팀이 검토해 원본 Excel에 옮깁니다.</p>
    ${cands.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>주제</th><th>약사가 한 말</th><th>해당 범위</th><th>상황</th><th>상태</th></tr></thead><tbody>${cands.map((x) => `<tr><td>${esc(x.topic_ko)}</td><td>${esc(x.quote_ko)}</td><td>${esc(x.applies_to)}</td><td>${esc(x.card_title)}</td><td>${badge('unknown', x.review_status)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="small muted">아직 없습니다. 비교 기록을 저장하면 근거 후보를 남길 수 있습니다.</p>'}
    <p class="xs muted" style="margin-top:12px">기록은 이 브라우저에만 저장되며 저장소에 올라가지 않습니다. 약사 응답 원본은 저장소에 올리지 않는 규칙입니다.</p>
    <div class="btn-row"><button class="btn" type="button" id="v-export" ${all.length ? '' : 'disabled'}>비교 기록 내보내기 (JSON)</button><button class="btn" type="button" id="v-export-cand" ${cands.length ? '' : 'disabled'}>근거 후보 내보내기 (CSV)</button>
      ${V.confirmClear ? `<button class="btn btn-danger" type="button" id="v-clear-yes">정말 모두 지우기</button><button class="btn btn-ghost" type="button" id="v-clear-no">취소</button>` : `<button class="btn btn-ghost btn-danger" type="button" id="v-clear" ${all.length ? '' : 'disabled'}>기록 모두 지우기</button>`}</div>
  </div>`;
}
$('#validate-root').addEventListener('change', (e) => {
  if (e.target.id === 'v-card') { V.cardId = e.target.value; V.cur = null; renderValidate(); $('#v-card').focus(); }
  if (e.target.id === 'v-round') V.round = Number(e.target.value);
});
$('#validate-root').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.id === 'v-save-a') {
    const first = $('input[name=vfirst]:checked'); if (!first) { toast('약사의 첫 행동을 고르세요.'); return; }
    const g = (id) => $(id).value;
    const rec = { id: 'R' + Date.now(), cardId: V.cardId, round: V.round, savedAt: new Date().toISOString(),
      human: { first: first.value, min: g('#v-min'), max: g('#v-max'), p1: g('#v-p1'), p2: g('#v-p2'), need: g('#v-need'), real: g('#v-real'), note: g('#v-note') },
      ai: (() => { const a = aiAnswer(V.cardId); return { first: a.first, final: a.final, refs: a.refs, src: a.src }; })(), cmp: null };
    store.set(REC_KEY, [...records(), rec]); V.cur = rec.id; renderValidate(); toast('약사 답을 저장했습니다. AI 답이 열렸습니다.');
  } else if (b.id === 'v-save-c') {
    const recs = records(); const r = recs.find((x) => x.id === V.cur);
    r.cmp = { pri: $('#c-pri').value, need: $('#c-need').value, claims: false };
    store.set(REC_KEY, recs); renderValidate(); toast('비교 기록을 저장했습니다. 새로 나온 내용이 있으면 근거 후보로 남기세요.');
  } else if (b.id === 'cd-add') {
    const topic = $('#cd-topic').value.trim(), quote = $('#cd-quote').value.trim(), sum = $('#cd-sum').value.trim();
    if (!topic || !quote) { toast('주제와 약사가 한 말을 적어야 합니다.'); (topic ? $('#cd-quote') : $('#cd-topic')).focus(); return; }
    const recs = records(); const r = recs.find((x) => x.id === V.cur);
    const k = cardById(r.cardId);
    const cand = { candidate_id: 'CAND-' + Date.now(), recordId: r.id, topic_ko: topic, applies_to: $('#cd-scope').value, record_type: '후속 응답',
      quote_ko: quote, summary_ko: sum, source_location: `후속 응답 · ${k.title} · ${r.round === 1 ? '처음' : '다시 물음'}`, card_title: k.title,
      recorded_at: new Date().toISOString(), review_status: '검토 대기' };
    store.set(CAND_KEY, [...candidates(), cand]);
    r.cmp.claims = true; store.set(REC_KEY, recs);
    renderValidate(); toast('근거 후보에 추가했습니다. 팀 검토 전까지는 근거가 아닙니다.');
  } else if (b.id === 'v-new') { V.cur = null; renderValidate(); }
  else if (b.id === 'v-export') downloadFile('persona-validation-records.json', JSON.stringify(records(), null, 2), 'application/json');
  else if (b.id === 'v-export-cand') {
    const cols = ['candidate_id', 'topic_ko', 'applies_to', 'record_type', 'quote_ko', 'summary_ko', 'source_location', 'card_title', 'recorded_at', 'review_status'];
    const csv = '﻿' + [cols.join(','), ...candidates().map((x) => cols.map((c) => csvCell(x[c])).join(','))].join('\r\n');
    downloadFile('claim-candidates.csv', csv, 'text/csv;charset=utf-8');
  } else if (b.id === 'v-clear') { V.confirmClear = true; renderValidate(); $('#v-clear-no')?.focus(); }
  else if (b.id === 'v-clear-no') { V.confirmClear = false; renderValidate(); }
  else if (b.id === 'v-clear-yes') { store.set(REC_KEY, []); V.cur = null; V.confirmClear = false; renderValidate(); toast('기록을 모두 지웠습니다.'); }
});

/* ---------- 근거 ---------- */
const EV = { tab: 'claims', q: '' };
function renderEvidence() {
  const root = $('#evidence-root');
  const tabs = [['claims', '발언'], ['rules', '규칙'], ['cases', '사례'], ['guardrails', '주의 규칙'], ['layers', '층 구조']];
  let content = '';
  if (EV.tab === 'layers') {
    content = `<p class="muted">정보를 섞지 않고 층으로 나눠 비교합니다. 이번 초안에는 어느 층도 에이전트에 연결되어 있지 않습니다.</p>
    <div class="layers">
      <div class="layer"><h4>B1 ${badge('neutral', '기준선')}</h4><p class="small"><b>넣는 것</b> 같은 환경·제약, 개인 근거 없음</p><p class="small"><b>알려 주는 것</b> 일반 약사 AI가 개인 자료 없이 어디까지 맞히는지</p><p class="xs muted">상태: 미연결</p></div>
      <div class="layer"><h4>P0 ${badge('interview', '인터뷰')}</h4><p class="small"><b>넣는 것</b> B1 + 인터뷰 근거(발언·규칙·사례, ID로 검색)</p><p class="small"><b>알려 주는 것</b> 인터뷰의 기여 = P0와 B1의 차이</p><p class="xs muted">상태: 근거 데이터 있음, 에이전트 미연결</p></div>
      <div class="layer"><h4>P1 ${badge('virtual', '장면 입력')}</h4><p class="small"><b>넣는 것</b> P0 + 공공·민간 데이터를 장면 입력으로</p><p class="small"><b>알려 주는 것</b> 환경 현실성의 기여. 약사에게도 같은 정보를 줍니다.</p><p class="xs muted">상태: 미연결(실제 값 미수집)</p></div>
      <div class="layer"><h4>P2 ${badge('hyp', '타 약사')}</h4><p class="small"><b>넣는 것</b> P1 + 다른 약사 데이터("타 약사 유래" 표시)</p><p class="small"><b>알려 주는 것</b> 동료 사전지식의 기여. 인터뷰가 늘어난 뒤에 켭니다.</p><p class="xs muted">상태: 데이터 없음</p></div>
    </div>
    <div class="callout" style="margin-top:16px">층을 합치면 인터뷰한 그 약사가 아니라 "개업 초기 약사 일반"이 됩니다. 그래서 층마다 따로 켜고 끄며 기여를 분리해서 봅니다.</div>`;
  } else {
    const q = EV.q.trim().toLowerCase();
    const rows = DB[EV.tab].filter((r) => !q || Object.values(r).some((v) => String(v).toLowerCase().includes(q)));
    const idKey = { claims: 'claim_id', rules: 'rule_id', cases: 'case_id', guardrails: 'guardrail_id' }[EV.tab];
    const items = rows.map((r) => {
      const id = r[idKey]; const x = lookup(id);
      return `<article class="ev-item"><header><button type="button" class="ev-chip" data-ref="${esc(id)}" aria-label="${esc(id)} 원문 열기">${esc(id)}</button><h3 style="margin:0;font-size:1rem">${esc(x.title)}</h3>${x.type ? badge('neutral', x.type) : ''}</header>
        ${x.quote ? `<blockquote>${esc(x.quote)}</blockquote>` : ''}<p class="small" style="margin:0">${esc(x.summary)}</p>${x.where ? `<p class="xs muted" style="margin:6px 0 0">${esc(x.where)}</p>` : ''}</article>`;
    }).join('');
    content = `<div class="field" style="max-width:420px"><label for="ev-q">검색 (ID, 제목, 문구)</label><input type="text" id="ev-q" value="${esc(EV.q)}" placeholder="예: E034, 반품, 현금"></div>
      <p class="small muted" id="ev-count" aria-live="polite">${DB[EV.tab].length}건 중 ${rows.length}건</p><div class="ev-list">${items || '<p class="muted">찾는 항목이 없습니다. 다른 단어로 검색해 보세요.</p>'}</div>`;
  }
  root.innerHTML = `<div class="tabs" role="tablist" aria-label="근거 종류">${tabs.map(([k, t]) => `<button role="tab" type="button" data-tab="${k}" aria-selected="${EV.tab === k}">${t}${k !== 'layers' && DB.ok ? ` <span class="xs muted">${DB[k].length}</span>` : ''}</button>`).join('')}</div>${content}`;
}
$('#evidence-root').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) { EV.tab = b.dataset.tab; renderEvidence(); $(`[data-tab=${b.dataset.tab}]`).focus(); } });
$('#evidence-root').addEventListener('input', (e) => {
  if (e.target.id !== 'ev-q') return;
  EV.q = e.target.value; const pos = e.target.selectionStart; renderEvidence(); const i = $('#ev-q'); i.focus(); i.setSelectionRange(pos, pos);
});

/* ---------- 니즈 ---------- */
const NEED_KEY = 'pp-needs';
function renderNeeds() {
  const st = store.get(NEED_KEY, {});
  const typeOf = (id) => { const r = lookup(id); return r && r.type ? r.type : ''; };
  $('#needs-root').innerHTML = `
    <div class="callout hyp" style="margin-bottom:16px"><b>모든 AX 여지는 가설입니다.</b> 인터뷰 1건에서 약사가 직접 말한 어려움과 대처만 근거로 씁니다. 시뮬레이션 결과는 근거가 아닙니다. 약사에게 확인할 때는 <b>해결책을 보여 주기 전에</b> 어려움의 빈도·심각도·현재 대처를 먼저 묻고, 그다음에 도입 조건을 묻습니다.</div>
    <div class="needs">${NEEDS.map((n) => `
      <article class="need ${n.kind === 'suggestion' ? 'suggest' : ''}" aria-labelledby="${n.id}-t">
        <h3 id="${n.id}-t">${esc(n.title)} ${n.kind === 'suggestion' ? badge('sample', '제안 반응 · 수요 증거 약함') : badge('interview', '인터뷰 근거')}</h3>
        <dl>
          <dt>상황</dt><dd>${esc(n.situation)}</dd>
          <dt>현재 하는 방식</dt><dd>${esc(n.workaround)}</dd>
          <dt>어려움</dt><dd>${esc(n.pain)}</dd>
          <dt>근거</dt><dd><span class="ev-chips">${n.refs.map((id) => `<span style="display:inline-flex;gap:4px;align-items:center">${chip(id)}<span class="xs muted">${esc(typeOf(id))}</span></span>`).join('')}</span></dd>
          <dt>빈도</dt><dd>${badge('unknown', n.frequency)}</dd>
          <dt>AX 여지</dt><dd>${badge('hyp', '가설')} ${esc(n.ax)}</dd>
          <dt>도입 조건</dt><dd><ul style="margin:0">${n.conditions.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></dd>
        </dl>
        <div class="field-row">
          <div class="field"><label for="${n.id}-s">확인 상태</label><select id="${n.id}-s" data-need="${n.id}" data-f="status">${['미확인', '약사가 확인함', '수정 필요'].map((o) => `<option ${((st[n.id] || {}).status || '미확인') === o ? 'selected' : ''}>${o}</option>`).join('')}</select></div>
          <div class="field"><label for="${n.id}-m">확인 메모</label><input type="text" id="${n.id}-m" data-need="${n.id}" data-f="memo" value="${esc((st[n.id] || {}).memo || '')}" placeholder="약사가 한 말을 그대로 적습니다"></div>
        </div>
      </article>`).join('')}</div>`;
}
$('#needs-root').addEventListener('change', (e) => { const el = e.target.closest('[data-need]'); if (!el) return; const st = store.get(NEED_KEY, {}); st[el.dataset.need] = { ...(st[el.dataset.need] || {}), [el.dataset.f]: el.value }; store.set(NEED_KEY, st); toast('확인 상태를 저장했습니다.'); });

/* ---------- 온보딩 ---------- */
const OB = [
  { t: '이 서비스는 무엇인가요?', b: `<p>인터뷰한 <b>약사 1명</b>의 주문 판단을 AI가 얼마나 닮았는지 확인하는 시뮬레이터입니다.</p><ul><li><b>코드</b>는 재고, 입고, 주문 금액을 계산합니다.</li><li><b>AI(페르소나)</b>는 보이는 정보만 보고 판단합니다.</li><li><b>실제 약사</b>의 답이 정답입니다.</li></ul><p class="small muted">지금은 인터뷰 1건뿐이라 "동네 약국 일반"은 말할 수 없습니다.</p>` },
  { t: '상황 카드가 핵심입니다', b: `<p><b>상황 카드</b>는 약사와 AI에게 똑같이 보여 줄 "어느 날 아침의 약국 사정"입니다. 남은 재고, 통장 잔액, 도매상이 언제 가져다주는지가 들어 있고 "몇 팩을 주문하겠습니까?"를 묻습니다.</p><p>카드마다 조건이 하나씩만 다릅니다. 그래야 답이 달라졌을 때 무엇 때문인지 알 수 있습니다. 카드를 고르면 어떤 인터뷰 발언에서 나온 장면인지도 함께 나옵니다.</p>` },
  { t: '화면의 표시를 읽는 법', b: `<p>값에는 출처 표시가 붙습니다.</p><p>${badge('interview', '인터뷰')} 약사가 한 말에 근거<br>${badge('virtual', '가상')} 계산을 위한 가정, 실제 값 아님<br>${badge('unknown', '미확인')} 아직 모르는 값<br>${badge('hyp', '가설')} 확인 전 추정<br>${badge('sample', '예시')} 설명용 샘플, 실제 AI 아님</p><p class="small muted">3D에서 반투명 보라 상자는 전산 기록, 갈색 상자는 실제 선반 재고입니다. 점선 층은 실제 건물에 없는 개념 층입니다.</p>` },
  { t: '이렇게 진행합니다', b: `<ol><li><b>상황 고르기</b>: 약사에게 물어볼 상황 카드를 고릅니다.</li><li><b>판단 내리기</b>: 약사라면 어떻게 할지 고르고 이유를 남깁니다.</li><li><b>결과 미리보기</b>: 그 선택으로 사흘 동안 재고가 어떻게 되는지 봅니다. 참고용입니다.</li><li><b>약사 답과 비교</b>: 약사 답을 먼저 받고 AI 답을 엽니다.</li><li><b>니즈 확인</b>: 어려움과 AX 여지를 가설로 정리합니다.</li></ol>` },
  { t: '꼭 지켜 주세요', b: `<ul><li>약사에게 <b>AI 답이나 결과 화면을 먼저 보여 주지 않습니다.</b></li><li>조건은 <b>한 번에 하나만</b> 바꿉니다.</li><li>수치는 모두 가정입니다. 못 판 손님이 0명이라고 좋은 선택은 아닙니다.</li><li>시뮬레이션 결과를 근거나 사실로 저장하지 않습니다.</li><li>AI는 아직 연결되어 있지 않습니다.</li></ul><p class="small muted">더 자세한 내용은 "사용 가이드"에 있습니다.</p>` },
];
let obIdx = 0;
function renderOb() {
  const s = OB[obIdx];
  $('#ob-body').innerHTML = `<div class="ob-art" aria-hidden="true"><svg width="56" height="56"><use href="#i-building"/></svg></div><h2 id="ob-title">${esc(s.t)}</h2>${s.b}<p class="xs muted" style="margin:12px 0 0">${obIdx + 1} / ${OB.length}</p>`;
  $('#ob-dots').innerHTML = OB.map((_, i) => `<i class="${i === obIdx ? 'on' : ''}"></i>`).join('');
  $('#ob-prev').hidden = obIdx === 0;
  $('#ob-next').textContent = obIdx === OB.length - 1 ? '시작하기' : '다음';
}
function openOb() { obIdx = 0; renderOb(); const d = $('#onboard'); if (d.showModal && !d.open) d.showModal(); }
function closeOb() { const d = $('#onboard'); d.open && d.close(); store.setRaw('pp-onboarded', '1'); }
$('#ob-next').addEventListener('click', () => { if (obIdx >= OB.length - 1) { closeOb(); return; } obIdx += 1; renderOb(); });
$('#ob-prev').addEventListener('click', () => { obIdx = Math.max(0, obIdx - 1); renderOb(); });
$('#ob-skip').addEventListener('click', closeOb);
$('#onboard').addEventListener('close', () => store.setRaw('pp-onboarded', '1'));
$('#btn-help').addEventListener('click', openOb);
$('#btn-help-2').addEventListener('click', openOb);

/* ---------- 실행 기록 (runs/index.json + runs/<실행번호>/results.json) ----------
   화면은 AI 를 호출하지 않는다. 스크립트가 쌓아 둔 파일만 읽는다. */
const RH = { index: null, indexErr: false, cache: {}, tab: 'list', openId: null, card: 'C01', a: null, b: null };
const KIND_BADGE = { eval: () => badge('good', '평가용'), practice: () => badge('neutral', '연습'), unlabeled: () => badge('sample', '표시 없음') };
const runTime = (s) => esc(String(s || '').replace('T', ' ').slice(0, 16));
const finalKey = (r) => { const l = r.steps[r.steps.length - 1]; return qidOf(l.action, l.qty_packs); };
const finalLabel = (k) => ACTION_LABEL[k] || k;
const tally = (rs) => { const m = {}; rs.forEach((r) => { const k = finalKey(r); m[k] = (m[k] || 0) + 1; }); return m; };
const tallyHTML = (rs) => (rs.length ? Object.entries(tally(rs)).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${esc(finalLabel(k))} ${n}번`).join(' · ') : '<span class="muted">없음</span>');
function majority(rs) {
  const t = Object.entries(tally(rs)).sort((x, y) => y[1] - x[1]);
  if (!t.length) return null;
  if (t.length > 1 && t[0][1] === t[1][1]) return 'split';
  return t[0][0];
}
async function loadRunIndex() {
  try {
    const res = await fetch('../runs/index.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    RH.index = (await res.json()).runs || [];
    RH.indexErr = false;
  } catch (e) { RH.index = null; RH.indexErr = true; }
}
async function getRun(id) {
  if (!RH.cache[id]) {
    const res = await fetch(`../runs/${encodeURIComponent(id)}/results.json`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${id}: ${res.status}`);
    RH.cache[id] = await res.json();
  }
  return RH.cache[id];
}
const runMeta = (id) => (RH.index || []).find((x) => x.run_id === id);
function runBrief(m) {
  return `${KIND_BADGE[m.kind] ? KIND_BADGE[m.kind]() : ''} <b>${esc(m.model)}</b> · ${m.mode === 'batch' ? '일괄' : '바로'} · ${runTime(m.created_at)}`;
}
function runsEmpty() {
  return `<div class="callout warn"><p><b>${RH.indexErr ? '실행 기록 파일(runs/index.json)을 찾지 못했습니다.' : '아직 실행 기록이 없습니다.'}</b><br>
    터미널에서 <code>python scripts/run_persona.py --mode sync --cards all --reps 1 --yes</code> 를 실행하면 기록이 쌓입니다. 이미 실행한 결과가 있는데 이 안내가 보이면 <code>python scripts/run_persona.py --reindex</code> 를 실행하세요.</p></div>`;
}
function runsListHTML() {
  const rows = RH.index.map((m) => `<tr${RH.openId === m.run_id ? ' class="sel"' : ''}>
    <td><button type="button" class="lk" data-run-open="${esc(m.run_id)}">${runTime(m.created_at)}</button></td>
    <td>${KIND_BADGE[m.kind] ? KIND_BADGE[m.kind]() : ''}${m.note ? `<div class="xs muted">${esc(m.note)}</div>` : ''}</td>
    <td>${esc(m.model)}</td><td>${m.mode === 'batch' ? '일괄' : '바로'}</td>
    <td>${(m.cards || []).length}장 × ${(m.layers || []).join('·')} × ${m.reps}회</td>
    <td class="num">${m.n_flagged ? badge('bad', `${m.n_flagged}건`) : '0건'}</td>
    <td class="num">${m.est_cost_usd != null ? `$${m.est_cost_usd.toFixed(3)}` : '-'}</td>
    <td class="xs muted">${esc(m.prompt_hash || '-')}</td></tr>`).join('');
  return `<div class="tbl-wrap"><table class="tbl"><caption class="sr-only">실행 기록 목록</caption><thead><tr><th>실행 시각 (눌러서 열기)</th><th>구분</th><th>모델</th><th>방식</th><th>범위</th><th class="num">검증에 걸린 결과</th><th class="num">추정 비용</th><th>입력 지문</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="xs muted" style="margin-top:8px">입력 지문은 프롬프트 문구와 인터뷰 근거 묶음에서 계산한 값입니다. 지문이 같은 실행끼리만 "같은 입력"으로 비교할 수 있습니다. 없는 칸은 지문을 남기기 전에 만든 실행입니다.</p>
    <div id="run-detail"></div>`;
}
async function runDetailHTML(id) {
  const d = await getRun(id);
  const m = runMeta(id) || {};
  const byKey = (c, l) => d.results.filter((r) => r.card === c && r.layer === l);
  const rows = d.cards.map((c) => `<tr><td>${esc(cardById(c).title)}</td>${d.layers.map((l) => `<td>${tallyHTML(byKey(c, l))}</td>`).join('')}</tr>`).join('');
  const flagged = d.results.filter((r) => r.flags.length);
  const flagRows = flagged.map((r) => `<li><b>${esc(cardById(r.card).title)}</b> · ${esc(r.layer)} · ${r.rep}번째: ${r.flags.map((f) => esc(flagText(f))).join(', ')}</li>`).join('');
  const detail = d.results.map((r) => {
    const last = r.steps[r.steps.length - 1];
    const ids = [...new Set(r.steps.flatMap((s) => s.cited_ids || []))];
    return `<details class="help"><summary>${esc(cardById(r.card).title)} · ${esc(r.layer)} · ${r.rep}번째 → <b>${esc(finalLabel(finalKey(r)))}</b></summary>
      <p class="reason">${esc(last.reason)}</p>
      <p class="small"><span class="muted">중요하게 본 것</span> ${(last.priorities || []).map(esc).join(' · ') || '-'}</p>
      <p class="small"><span class="muted">든 근거</span> ${ids.length ? ids.map(idBadge).join(' ') : '없음'}</p></details>`;
  }).join('');
  return `<section class="run-detail"><h3>${runBrief({ ...m, ...d })}</h3>
    <p class="small muted">같은 상황을 ${d.reps}번씩 물은 결과입니다. 한 칸의 "5팩 주문 2번"은 두 번의 시도가 그 선택으로 끝났다는 뜻입니다. 위 칸의 숫자가 갈릴수록 AI의 답이 일정하지 않습니다.</p>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>상황</th>${d.layers.map((l) => `<th>${l === 'B1' ? 'B1 · 일반 약사' : l === 'P0' ? 'P0 · 인터뷰 근거 포함' : esc(l)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
    ${flagged.length ? `<div class="callout warn" style="margin:12px 0"><p><b>검증에 걸린 결과 ${flagged.length}건</b></p><ul class="small">${flagRows}</ul></div>` : ''}
    <h3 style="margin-top:20px">시도별 이유와 근거</h3>${detail}
    <p class="xs muted" style="margin-top:12px">${esc(d.note || '')}</p></section>`;
}
function cardAccumHTML(runsData) {
  const cardOpts = Object.keys(CARDS_BY_ID_LIST()).map((c) => `<option value="${c}"${c === RH.card ? ' selected' : ''}>${esc(cardById(c).title)}</option>`).join('');
  const rows = RH.index.map((m) => {
    const d = runsData[m.run_id];
    if (!d) return '';
    const cells = ['B1', 'P0'].map((l) => `<td>${tallyHTML(d.results.filter((r) => r.card === RH.card && r.layer === l))}</td>`).join('');
    return `<tr><td>${runTime(m.created_at)}</td><td>${KIND_BADGE[m.kind] ? KIND_BADGE[m.kind]() : ''}</td><td>${esc(m.model)}</td>${cells}</tr>`;
  }).join('');
  return `<div class="cond-row"><label class="lab" for="rh-card">상황</label><select id="rh-card" class="sel">${cardOpts}</select></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>실행 시각</th><th>구분</th><th>모델</th><th>B1 · 일반 약사</th><th>P0 · 인터뷰 근거 포함</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="muted">이 상황이 들어 있는 실행이 없습니다.</td></tr>'}</tbody></table></div>
    <p class="xs muted" style="margin-top:8px">같은 상황에 대한 모든 실행의 최종 선택입니다. 모델이나 입력 지문이 다른 실행이 섞여 있을 수 있으니 목록 탭에서 조건을 함께 확인하세요.</p>`;
}
const CARDS_BY_ID_LIST = () => Object.fromEntries(CARDS.map((c) => [c.id, c]));
function compareHTML(A, B) {
  const opts = (sel) => RH.index.map((m) => `<option value="${esc(m.run_id)}"${m.run_id === sel ? ' selected' : ''}>${runTime(m.created_at)} · ${esc(m.model)} · ${m.mode === 'batch' ? '일괄' : '바로'}</option>`).join('');
  let body = '<p class="small muted">비교할 실행 두 개를 고르세요.</p>';
  if (A && B) {
    const ma = runMeta(A.run_id) || A, mb = runMeta(B.run_id) || B;
    const diff = [];
    if (ma.model !== mb.model) diff.push('모델이 다릅니다');
    if ((ma.prompt_hash || '') !== (mb.prompt_hash || '')) diff.push(ma.prompt_hash && mb.prompt_hash ? '프롬프트나 인터뷰 근거 묶음이 다릅니다' : '입력 지문이 없는 실행이 있어 같은 입력인지 알 수 없습니다');
    const cards = A.cards.filter((c) => B.cards.includes(c));
    const layers = A.layers.filter((l) => B.layers.includes(l));
    const rows = cards.flatMap((c) => layers.map((l) => {
      const ra = A.results.filter((r) => r.card === c && r.layer === l), rb = B.results.filter((r) => r.card === c && r.layer === l);
      const ka = majority(ra), kb = majority(rb);
      const res = ka === 'split' || kb === 'split' ? badge('neutral', '시도가 갈림') : ka === kb ? badge('good', '같음') : badge('bad', '다름');
      return `<tr><td>${esc(cardById(c).title)}</td><td>${esc(l)}</td><td>${tallyHTML(ra)}</td><td>${tallyHTML(rb)}</td><td>${res}</td></tr>`;
    })).join('');
    body = `${diff.length ? `<div class="callout warn" style="margin:12px 0"><p><b>두 실행은 같은 조건이 아닙니다.</b> ${diff.join(' · ')}. 차이가 나도 원인이 상황이나 약사 쪽이라고 말할 수 없습니다.</p></div>` : '<div class="callout" style="margin:12px 0"><p>모델과 입력 지문이 같은 실행끼리의 비교입니다. 차이는 AI 답의 흔들림으로 볼 수 있습니다.</p></div>'}
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>상황</th><th>층</th><th>왼쪽 실행</th><th>오른쪽 실행</th><th>가장 많은 선택</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="xs muted" style="margin-top:8px">"가장 많은 선택"은 반복한 시도 중 가장 자주 나온 최종 선택이 같은지 봅니다. 맞고 틀림을 판정하지 않습니다.</p>`;
  }
  return `<div class="cond-row"><label class="lab" for="rh-a">왼쪽 실행</label><select id="rh-a" class="sel">${opts(RH.a)}</select>
    <label class="lab" for="rh-b">오른쪽 실행</label><select id="rh-b" class="sel">${opts(RH.b)}</select></div>${body}`;
}
async function renderRuns() {
  const root = $('#runs-root');
  if (!RH.index || !RH.index.length) { root.innerHTML = runsEmpty(); return; }
  const tabs = [['list', '실행 목록'], ['card', '상황별 누적'], ['cmp', '실행 비교']];
  const seg = `<div class="cond-row"><span class="lab" id="lab-rh">보는 방법</span><span class="seg" role="radiogroup" aria-labelledby="lab-rh">${tabs.map(([k, t]) => `<label><input type="radio" name="rhtab" value="${k}" ${RH.tab === k ? 'checked' : ''}><span>${t}</span></label>`).join('')}</span>
    <span class="hint">${RH.tab === 'list' ? '실행 한 번의 결과를 엽니다.' : RH.tab === 'card' ? '한 상황에 대해 쌓인 모든 실행을 봅니다.' : '두 실행의 답을 나란히 놓습니다.'}</span></div>`;
  root.innerHTML = `${seg}<div id="rh-body"><p class="small muted">불러오는 중…</p></div>`;
  const body = $('#rh-body');
  try {
    if (RH.tab === 'list') {
      body.innerHTML = runsListHTML();
      if (RH.openId) $('#run-detail').innerHTML = await runDetailHTML(RH.openId);
    } else if (RH.tab === 'card') {
      const all = {}; await Promise.all(RH.index.map(async (m) => { all[m.run_id] = await getRun(m.run_id); }));
      body.innerHTML = cardAccumHTML(all);
    } else {
      RH.a = RH.a || (RH.index[1] || RH.index[0]).run_id; RH.b = RH.b || RH.index[0].run_id;
      const [A, B] = await Promise.all([getRun(RH.a), getRun(RH.b)]);
      body.innerHTML = compareHTML(A, B);
    }
  } catch (e) { body.innerHTML = `<div class="callout warn"><p>실행 파일을 읽지 못했습니다 (${esc(e.message)}). 폴더를 옮기거나 지웠다면 <code>python scripts/run_persona.py --reindex</code> 를 실행하세요.</p></div>`; }
}
$('#runs-root').addEventListener('change', (e) => {
  if (e.target.name === 'rhtab') { RH.tab = e.target.value; renderRuns(); }
  else if (e.target.id === 'rh-card') { RH.card = e.target.value; renderRuns(); }
  else if (e.target.id === 'rh-a') { RH.a = e.target.value; renderRuns(); }
  else if (e.target.id === 'rh-b') { RH.b = e.target.value; renderRuns(); }
});
$('#runs-root').addEventListener('click', (e) => {
  const b = e.target.closest('[data-run-open]'); if (!b) return;
  RH.openId = RH.openId === b.dataset.runOpen ? null : b.dataset.runOpen; renderRuns();
});

/* ---------- 라우터 ---------- */
const ROUTES = { '': 'home', '/': 'home', '/guide': 'guide', '/simulate': 'simulate', '/validate': 'validate', '/runs': 'runs', '/evidence': 'evidence', '/needs': 'needs' };
const TITLES = { home: '약국 페르소나 시뮬레이터', guide: '사용 가이드', simulate: '시뮬레이터', validate: '약사 답과 비교', runs: '실행 기록', evidence: '인터뷰 근거', needs: '니즈와 AX 여지' };
function route() {
  const hash = location.hash;
  if (hash && !hash.startsWith('#/')) { return; } // 가이드 안의 목차 이동
  const name = ROUTES[hash.slice(1)] || 'home';
  document.body.dataset.route = name;
  $$('.view').forEach((v) => { v.hidden = v.id !== `view-${name}`; });
  $$('.nav a').forEach((a) => { a.dataset.route === name ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'); });
  document.title = name === 'home' ? TITLES.home : `${TITLES[name]} · 약국 페르소나 시뮬레이터`;
  stopPlay();
  if (name === 'home') { ensureScene('hero'); }
  if (name === 'simulate') {
    const sc = ensureScene('sim'); renderPanel(); applyScene(); sc && sc.resize();
    if (!store.raw('pp-stagehint') && $('#obj-card').hidden) setStageHint(true);
  }
  if (name === 'validate') renderValidate();
  if (name === 'runs') loadRunIndex().then(renderRuns);
  if (name === 'evidence' && DB.ok) renderEvidence();
  if (name === 'needs' && DB.ok) renderNeeds();
  window.scrollTo(0, 0);
  const h = $(`#view-${name} h1`); h && h.focus({ preventScroll: true });
}
window.addEventListener('hashchange', route);
document.addEventListener('click', (e) => { const a = e.target.closest('[data-step-link]'); if (a) { S.step = Number(a.dataset.stepLink) === 3 && !S.result ? 1 : Number(a.dataset.stepLink); } });

/* ---------- 시작 ---------- */
function renderDonts() { $('#dont-list').innerHTML = DONTS.map(([a, b]) => `<li><span>${esc(a)}<small>${esc(b)}</small></span></li>`).join(''); }
async function init() {
  syncTheme(); renderObjList(); renderDonts();
  SELFTEST = selfTest();
  try {
    await loadData();
    $('#data-status').innerHTML = `근거 데이터 불러옴: 발언 ${DB.claims.length}건 · 규칙 ${DB.rules.length}건 · 사례 ${DB.cases.length}건 · 주의 규칙 ${DB.guardrails.length}건 &nbsp;|&nbsp; 계산 자체 점검: 팀 보고 검증표와 ${SELFTEST.ok}/${SELFTEST.total} 일치`;
  } catch (err) {
    $('#data-status').textContent = '근거 데이터를 불러오지 못했습니다.';
    const bn = $('#app-banner'); bn.hidden = false;
    bn.textContent = `근거 CSV를 읽지 못했습니다(${err.message}). 저장소 루트에서 서버를 실행한 뒤 http://localhost 주소로 열어야 합니다. 파일을 직접 열면 동작하지 않습니다.`;
  }
  await loadRuns();
  route();
  if (!store.raw('pp-onboarded')) setTimeout(openOb, 400);
  window.__app = { S, V, scenes, E, route };
}
init();
