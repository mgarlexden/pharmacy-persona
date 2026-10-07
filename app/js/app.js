import { loadData, DB, lookup, CARDS, cardById, NEEDS } from './data.js';
import { renderDataPage } from './datapage.js';
import { enterSim, leaveSim, scene, openAt, simData, loadRuns, loadAnswers } from './sim.js';
import { $, $$, esc, store, badge, VIRT, PUB, INTV, chip, chips, toast, ACTION_LABEL, qidOf, layerName, srcTag, flagText, csvCell, downloadFile } from './ui.js';

/* ---------- 테마 ---------- */
const isDark = () => {
  const t = document.documentElement.getAttribute('data-theme');
  return t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
};
function syncTheme() {
  const d = isDark();
  $('#btn-theme').setAttribute('aria-pressed', String(d));
  $('#theme-icon').setAttribute('href', d ? '#i-sun' : '#i-moon');
  const sc = scene(); sc && sc.setTheme(d);
}
$('#btn-theme').addEventListener('click', () => {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  store.setRaw('pp-theme', next);
  syncTheme();
});
window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', syncTheme);

/* ---------- 근거 서랍 ---------- */
let drawerTrigger = null;
function openRef(id, trigger) {
  const r = lookup(id);
  drawerTrigger = trigger || null;
  const body = r
    ? `<p class="xs muted" style="margin:0 0 4px">${badge('interview', r.kind)} ${r.type ? badge('neutral', r.type) : ''}</p>
       <h2 id="drawer-title"><span class="mono">${esc(r.id)}</span> ${esc(r.title)}</h2>
       ${r.quote ? `<p class="xs muted" style="margin-bottom:4px">약사가 한 말 (일부)</p><blockquote style="margin:0 0 12px;padding-left:12px;border-left:3px solid var(--line)">${esc(r.quote)}</blockquote>` : ''}
       ${r.situation ? `<p class="xs muted" style="margin-bottom:2px">상황</p><p>${esc(r.situation)}</p>` : ''}
       <p class="xs muted" style="margin-bottom:2px">${r.kind === '발언' ? '요약' : r.kind === '규칙' ? '판단' : r.kind === '사례' ? '결과' : '처리'}</p><p>${esc(r.summary)}</p>
       ${r.note ? `<p class="xs muted" style="margin-bottom:2px">읽을 때 주의</p><p>${esc(r.note)}</p>` : ''}
       ${r.where ? `<p class="xs muted">출처 위치: ${esc(r.where)}</p>` : ''}
       ${r.kind === '규칙' ? `<p style="margin-top:14px"><button type="button" class="btn" data-goto-rule="${esc(r.id)}">약사 프로필의 판단 방식에서 보기</button></p>` : ''}`
    : `<h2 id="drawer-title">${esc(id)}</h2><p>데이터에서 이 번호를 찾지 못했습니다.</p>`;
  $('#drawer-body').innerHTML = body;
  $('#drawer').hidden = false;
  $('#drawer-close').focus();
}
function closeDrawer() { $('#drawer').hidden = true; if (drawerTrigger && document.contains(drawerTrigger)) drawerTrigger.focus(); }
$('#drawer-close').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#drawer').hidden) closeDrawer(); });
document.addEventListener('click', (e) => { const b = e.target.closest('[data-ref]'); if (b) openRef(b.dataset.ref, b); });
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-goto-rule]'); if (!g) return;
  const id = g.dataset.gotoRule;
  closeDrawer();
  location.hash = '#/profile';
  setTimeout(() => { const el = document.getElementById(`pf-${id}`); if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 2400); } }, 250);
});
new ResizeObserver(() => document.documentElement.style.setProperty('--hdr-h', `${$('#site-header').offsetHeight}px`)).observe($('#site-header'));
// 홈의 단계 링크: 시뮬레이터의 해당 단계로 바로 연다
document.addEventListener('click', (e) => { const a = e.target.closest('[data-go-sim]'); if (a) openAt(Number(a.dataset.goSim)); });

/* ---------- 약사 프로필 ---------- */
function openedDays() {
  const r = DB.profile.find((x) => x.unit === 'date' && /개업일/.test(x.summary_ko));
  if (!r) return null;
  const [y, mo, d] = r.value.split('-').map(Number);
  const open = new Date(y, mo - 1, d), now = new Date(); now.setHours(0, 0, 0, 0);
  const days = Math.round((now - open) / 86400000);
  return { date: r.value, nth: days + 1 };
}
const KEY_RULES = ['R01', 'R02', 'R03', 'R04'];
const PF = { q: '' };
function profilePage() {
  const root = $('#profile-root');
  if (!DB.ok) { root.innerHTML = '<p class="muted">불러오는 중…</p>'; return; }
  const od = openedDays();
  const facts = DB.profile.filter((r) => r.kind === 'fact');
  const narr = DB.profile.filter((r) => r.kind === 'narrative');
  const rule = (r) => `<li id="pf-${esc(r.rule_id)}"><span class="pf-rid">${chip(r.rule_id)}</span><div><b>${esc(r.title_ko)}</b><p>${esc(r.judgement_ko)}</p></div></li>`;
  const key = DB.rules.filter((r) => KEY_RULES.includes(r.rule_id));
  const other = DB.rules.filter((r) => !KEY_RULES.includes(r.rule_id));
  root.innerHTML = `
    <div class="pf-hero">
      <div class="pf-id"><span class="pf-av" aria-hidden="true">약</span><div><p class="pf-name">인터뷰 약사 ${INTV}</p><p class="small muted">응답자 1명 · 약사 2인 운영 중 1명 · 성별·나이는 자료에 없음</p></div></div>
      <div class="pf-tiles">
        <div><span>개업</span><b>${od ? `${od.nth}일째` : '-'}</b><small>${od ? esc(od.date) : ''} 개업</small></div>
        <div><span>위치</span><b>2층 약국</b><small>경기 구리시 · 1층 정형외과, 같은 층 이비인후과, 3층 치과</small></div>
        <div><span>인터뷰</span><b>개업 약 3주</b><small>판단 근거는 그때 한 말입니다</small></div>
      </div>
    </div>
    <section class="pf-sec"><h2>어떤 사람인가</h2><p class="small muted">인터뷰를 정리한 문장입니다. 약사의 말 그대로는 아닙니다.</p>
      <div class="pf-cards">${narr.map((r) => `<div class="pf-card"><span class="k">${esc(r.section_ko)}</span><b>${esc(r.summary_ko)}</b><p>${esc(r.detail_ko)}</p></div>`).join('')}</div></section>
    <section class="pf-sec"><h2>판단 방식</h2><p class="small muted">시나리오에 주로 쓰이는 네 가지입니다. 번호를 누르면 근거가 된 말을 볼 수 있습니다.</p>
      <ul class="pf-rules">${key.map(rule).join('')}</ul>
      <details class="help"><summary>그 밖의 판단 방식 ${other.length}개</summary><ul class="pf-rules">${other.map(rule).join('')}</ul></details></section>
    <section class="pf-sec"><h2>확인된 사실</h2>
      <div class="tbl-wrap"><table class="tbl"><tbody>${facts.map((r) => `<tr><th>${esc(r.summary_ko)}</th><td><b>${esc(r.value)}</b> ${esc(r.unit === 'date' ? '' : r.unit)}</td></tr>`).join('')}</tbody></table></div></section>
    <section class="pf-sec"><details class="help"><summary>인터뷰 원문 찾기</summary>
      <div class="field" style="max-width:420px;margin-top:8px"><label for="pf-q">찾을 말 (번호, 주제, 문구)</label><input type="text" id="pf-q" value="${esc(PF.q)}" placeholder="예: 반품, 현금, E034"></div>
      <div id="pf-results"></div></details></section>`;
  renderPfSearch();
}
function renderPfSearch() {
  const el = $('#pf-results'); if (!el) return;
  const q = PF.q.trim().toLowerCase();
  if (!q) { el.innerHTML = '<p class="small muted">찾을 말을 입력하세요.</p>'; return; }
  const hits = [...DB.byId.values()].filter((x) => [x.id, x.title, x.summary, x.quote].some((v) => String(v || '').toLowerCase().includes(q))).slice(0, 30);
  el.innerHTML = hits.length ? `<ul class="pf-hits">${hits.map((x) => `<li>${chip(x.id)}<div><b>${esc(x.title)}</b><p>${esc(x.summary)}</p></div></li>`).join('')}</ul>` : '<p class="small muted">찾는 말이 없습니다.</p>';
}
$('#profile-root').addEventListener('input', (e) => { if (e.target.id === 'pf-q') { PF.q = e.target.value; renderPfSearch(); } });

/* ---------- 운영 메모 ---------- */
const TODO = [
  ['약사 답의 주문 수량 없음', '10/6에 약사 답 2건(C01·C05와 비슷한 조건)을 받았지만 주문 수량은 답하지 않았습니다. 수량이나 괜찮은 범위를 받아야 AI 답과 숫자로 비교할 수 있습니다. C02·C03·C04·C06은 아직 묻지 않았습니다.'],
  ['평가용 시나리오 없음', '지금 6개는 모두 인터뷰가 다룬 요소로 만든 연습용입니다. 재현도를 재려면 인터뷰에 없던 새 상황이 필요합니다.'],
  ['통과 기준 미정', '몇 개가 같으면 "재현했다"고 볼지 정하지 않았습니다. 화면은 같음·다름만 보여 줍니다.'],
  ['AI 실행이 가벼운 수준', '가장 싼 모델(haiku)로 1회씩만 돌렸습니다. 같은 답이 나오는지 보려면 3회 반복, 판단 품질을 보려면 상위 모델 실행이 필요합니다.'],
  ['의원 진료시간', '같은 건물 이비인후과만 팀 정리본(공식 홈페이지)으로 넣었습니다. 1층 정형외과 진료시간은 확인되지 않았고, 진료시간 API는 신청 전입니다.'],
  ['약국 실제 영업시간', '자료마다 달라 확인하지 못했습니다. 지금은 가상 달력(평일 09–19, 토 09–14, 일·공휴일 휴무)을 씁니다.'],
  ['의약품 공급중단·부족', '공공데이터포털 사이트 오류로 받지 못했습니다. 추후 연동합니다.'],
  ['날씨 관측소', '구리시에 ASOS 관측소가 없어 서울(108) 값을 씁니다.'],
  ['수요 반응 크기', '독감 0.4, 기온 1℃당 1.2%, 비 오면 일반약 방문 −15%, 연휴 다음 날 +20%는 근거 자료 없이 정한 가정입니다 (app/js/demand.js).'],
  ['사흘 계산 범위', '판단 품목 1개, 하루 5팩 수요. 반품·유효기간·결제 부담은 계산하지 않습니다.'],
];
const DECISIONS = [
  ['화면에서 답을 고르지 않는다', '판단은 AI(인터뷰 근거)가, 기준 답은 약사가 준다. 사람이 고르면 재현도를 잴 수 없다.'],
  ['AI 답은 근거로 넣지 않는다 (G04)', '근거 후보는 약사 본인의 말에서만 나온다. AI 답을 넣으면 페르소나가 자기 출력을 학습하게 된다.'],
  ['약사에게 AI 답을 먼저 보여 주지 않는다', '본 뒤의 답은 AI 답의 영향을 받는다.'],
  ['근거로 넣은 시나리오는 연습용이 된다', '답을 미리 알려 준 셈이라 그 시나리오로는 재현도를 잴 수 없다.'],
  ['시나리오는 조건 하나씩만 바꾼다', '답이 달라졌을 때 원인을 그 조건으로 좁히기 위해서.'],
  ['정보 수준 B1·P0·P1을 섞지 않는다', '인터뷰와 그날 환경이 각각 판단을 얼마나 바꾸는지 따로 보기 위해서. P1이 약사와 같은 정보.'],
  ['하루 손님 100건은 가정', '약사가 매출과 연결되는 수치 공유를 부담스러워해서, 대신 "신규 약국 초기 하루 약 100건"을 써도 된다고 했다.'],
  ['지역은 경기 구리시, 장면 날짜는 2026-10-06(화)', '연휴(10/5 대체공휴일) 다음 첫 영업일, 한글날 휴무 전 주간.'],
  ['공공데이터는 한 파일로 모은다', 'API를 매번 부르면 느리고 한도가 작다(에어코리아 하루 500건). build_public.py가 data/2_world/derived/public_snapshot.csv를 만든다.'],
  ['의원·약국 이름과 좌표는 저장소에 넣지 않는다', '저장소가 공개라 인터뷰 약국이 특정될 수 있다. 개수와 구간만 남긴다.'],
  ['3층 판단실을 없앴다', '실제 건물 3층은 치과다. 개념 층이 실제 층처럼 보여 혼동을 줬다.'],
  ['응답자는 1명 (G07), 팀원 실명 금지', '약국 전체의 합의나 성향으로 쓰지 않는다.'],
];
async function opsPage() {
  const root = $('#ops-root');
  await Promise.all([loadRuns(), loadAnswers()]);
  const { RUNS, ANSWERS, decisions } = simData();
  const dec = Object.entries(decisions);
  const decRows = dec.map(([k, v]) => { const [c, round, f] = k.split('|'); const a = ANSWERS.find((x) => x.card_id === c && String(x.round) === round); return `<tr><td>${esc(cardById(c) ? cardById(c).title : c)}</td><td>${esc(f)}</td><td>${esc(a ? a[f] : '')}</td><td>${badge(v === 'candidate' ? 'good' : v === 'hold' ? 'unknown' : 'neutral', v === 'candidate' ? '근거 후보' : v === 'hold' ? '보류' : '추가 안 함')}</td></tr>`; }).join('');
  root.innerHTML = `
    <section class="ops-sec"><h2>지금 상태</h2>
      <div class="dp-tiles">
        <div class="dp-tile"><span class="k">AI 실행 (최근)</span><b>${RUNS ? `${RUNS.results.length}건` : '없음'}</b><span class="s">${RUNS ? `${esc(RUNS.model)} · ${esc(String(RUNS.created_at).replace('T', ' ').slice(0, 16))} · 점검에 걸린 결과 ${RUNS.results.filter((r) => r.flags.length).length}건` : 'run_persona.py 실행 필요'}</span></div>
        <div class="dp-tile"><span class="k">약사 답</span><b>${ANSWERS.length}건</b><span class="s">data/5_validation/pharmacist_answers.csv</span></div>
        <div class="dp-tile"><span class="k">근거 결정 (이 브라우저)</span><b>${dec.length}건</b><span class="s">근거 후보 ${dec.filter(([, v]) => v === 'candidate').length}건</span></div>
      </div>
      ${dec.length ? `<div class="tbl-wrap" style="margin-top:12px"><table class="tbl"><thead><tr><th>시나리오</th><th>항목</th><th>약사가 한 말</th><th>결정</th></tr></thead><tbody>${decRows}</tbody></table></div><div class="btn-row"><button class="btn" type="button" id="ops-export">근거 후보 내보내기 (CSV)</button></div>` : ''}
    </section>
    <section class="ops-sec"><h2>아직 안 된 것</h2><ul class="memo">${TODO.map(([a, b]) => `<li><b>${esc(a)}</b><span>${esc(b)}</span></li>`).join('')}</ul></section>
    <section class="ops-sec"><h2>결정과 이유</h2><ul class="memo">${DECISIONS.map(([a, b]) => `<li><b>${esc(a)}</b><span>${esc(b)}</span></li>`).join('')}</ul></section>
    <section class="ops-sec"><h2>갱신하는 법</h2>
      <div class="tbl-wrap"><table class="tbl"><tbody>
        <tr><th>AI 다시 실행</th><td><code>python scripts/run_persona.py --mode sync --cards all --reps 3 --yes</code><br><span class="xs muted">먼저 --dry-run 으로 요청 수와 토큰을 확인합니다. 키는 .env 의 ANTHROPIC_API_KEY.</span></td></tr>
        <tr><th>공공데이터 다시 받기</th><td><code>python scripts/build_public.py --refresh</code><br><span class="xs muted">키는 .env 의 DATA_GO_KR_KEY. 원본은 fetched/ (저장소에 올라가지 않음).</span></td></tr>
        <tr><th>약사 답 넣기</th><td><code>data/5_validation/pharmacist_answers.csv</code> 에 한 줄씩. first_action·final_choice 는 check_physical_stock, Q_<수량>(예: Q_0, Q_7), order_open(주문하지만 수량은 답하지 않음), defer, other 중 하나. 묻지 않은 칸은 비워 둔다. 이유는 약사가 한 말 그대로, 팀원이 정리한 답은 answer_ko 에 그대로.</td></tr>
        <tr><th>근거 반영</th><td>근거 후보를 source/ Excel 에 옮기고 <code>python scripts/build.py</code> → <code>python scripts/validate.py</code></td></tr>
      </tbody></table></div></section>`;
}
$('#ops-root').addEventListener('click', (e) => {
  if (e.target.id !== 'ops-export') return;
  const { ANSWERS, decisions } = simData();
  const cols = ['card_id', 'card_title', 'round', 'field', 'text_ko', 'decision', 'decided_in'];
  const rows = Object.entries(decisions).filter(([, v]) => v === 'candidate').map(([k, v]) => { const [c, round, f] = k.split('|'); const a = ANSWERS.find((x) => x.card_id === c && String(x.round) === round) || {}; return { card_id: c, card_title: cardById(c) ? cardById(c).title : '', round, field: f, text_ko: a[f] || '', decision: v, decided_in: '시뮬레이터 근거 결정' }; });
  downloadFile('evidence-candidates.csv', '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n'), 'text/csv;charset=utf-8');
});

const idBadge = (id) => (lookup(id) || id === 'U001'
  ? `<span class="ev-chips">${chip(id)}${badge('good', '번호 있음')}</span>`
  : `<span class="ev-chips">${chip(id)}${badge('bad', '데이터에 없는 번호')}</span>`);


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
  const flagRows = flagged.map((r) => `<li><b>${esc(cardById(r.card).title)}</b> · ${esc(r.layer)} · ${r.rep}번째: ${[...new Set(r.flags.map(flagText))].map(esc).join(', ')}</li>`).join('');
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
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>상황</th>${d.layers.map((l) => `<th>${esc(layerName(l))}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
    ${factorSummaryHTML(d)}${ablationHTML(d)}
    ${flagged.length ? `<div class="callout warn" style="margin:12px 0"><p><b>검증에 걸린 결과 ${flagged.length}건</b></p><ul class="small">${flagRows}</ul></div>` : ''}
    <h3 style="margin-top:20px">시도별 이유와 근거</h3>${detail}
    <p class="xs muted" style="margin-top:12px">${esc(d.note || '')}</p></section>`;
}
function factorSummaryHTML(d) {
  const fs = d.factor_summary; if (!fs) return '';
  const srcs = ['interview', 'scene', 'observation', 'assumption', 'general_knowledge'];
  const rows = Object.entries(fs).map(([l, v]) => `<tr><td>${esc(layerName(l))}</td>${srcs.map((k) => `<td class="num">${v[k]}</td>`).join('')}<td class="num"><b>${v.general_knowledge_share == null ? '-' : `${Math.round(v.general_knowledge_share * 100)}%`}</b></td></tr>`).join('');
  return `<h3 style="margin-top:20px">판단 요인의 출처</h3>
    <p class="small muted">AI가 최종 판단마다 적은 요인을 출처별로 센 것입니다. "일반 상식" 몫이 클수록 인터뷰와 관측값 밖의 지식에 기댔다는 뜻입니다. AI의 자기 보고라서 실제로 무엇에 기댔는지를 보증하지는 않습니다. 그래서 아래 "근거를 하나씩 빼 보기"로 따로 확인합니다.</p>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>층</th>${srcs.map((k) => `<th class="num">${srcTag(k)}</th>`).join('')}<th class="num">일반 상식 비율</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function ablationHTML(d) {
  const rows = d.ablation_summary || []; if (!rows.length) return '';
  const fin = (k) => { const m = /^commit_(\d+)$/.exec(k || ''); return k === 'split' ? '시도가 갈림' : k === 'commit_choice' ? '바로 주문 결정' : m ? (Number(m[1]) === 0 ? '보류' : `${Number(m[1])}팩 주문`) : (ACTION_LABEL[k] || k || '-'); };
  const res = (c) => (c === 'yes' ? badge('bad', '판단이 바뀜') : c === 'no' ? badge('neutral', '그대로') : badge('unknown', '시도가 갈려 판단 보류'));
  const body = rows.map((r) => `<tr><td>${chip(r.rule)}</td><td>${esc(cardById(r.card).title)}</td><td>${esc(fin(r.base_first))} → ${esc(fin(r.base_final))}</td><td>${esc(fin(r.ablated_first))} → ${esc(fin(r.ablated_final))}</td><td>${res(r.changed)}</td></tr>`).join('');
  const removed = Object.entries(d.ablations || {}).map(([l, ids]) => `<li><b>${esc(l.slice(3))}</b> 묶음: ${ids.map((i) => chip(i)).join(' ')}</li>`).join('');
  return `<h3 style="margin-top:20px">근거를 하나씩 빼 보기</h3>
    <p class="small muted">P1에서 규칙 하나와 그 규칙을 받치는 발언·사례를 빼고 같은 카드를 다시 풀게 했습니다. 판단(첫 행동 또는 가장 많은 최종 선택)이 바뀌면 그 근거가 실제로 판단에 쓰였다는 신호입니다. 그대로면 그 근거 없이도 같은 답이 나온다는 뜻이라, 그 카드에서는 근거가 장식일 수 있습니다. 반복 수가 적으면 우연히 바뀔 수 있으니 확정 결론으로 읽지 않습니다.</p>
    <ul class="small">${removed}</ul>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>뺀 규칙</th><th>상황</th><th>P1 (첫 행동 → 최종)</th><th>뺀 뒤</th><th>결과</th></tr></thead><tbody>${body}</tbody></table></div>`;
}
function cardAccumHTML(runsData) {
  const cardOpts = Object.keys(CARDS_BY_ID_LIST()).map((c) => `<option value="${c}"${c === RH.card ? ' selected' : ''}>${esc(cardById(c).title)}</option>`).join('');
  const AL = [...new Set(Object.values(runsData).flatMap((d) => d.layers))].filter((l) => !l.startsWith('P1-'));
  const rows = RH.index.map((m) => {
    const d = runsData[m.run_id];
    if (!d) return '';
    const cells = AL.map((l) => `<td>${tallyHTML(d.results.filter((r) => r.card === RH.card && r.layer === l))}</td>`).join('');
    return `<tr><td>${runTime(m.created_at)}</td><td>${KIND_BADGE[m.kind] ? KIND_BADGE[m.kind]() : ''}</td><td>${esc(m.model)}</td>${cells}</tr>`;
  }).join('');
  return `<div class="cond-row"><label class="lab" for="rh-card">상황</label><select id="rh-card" class="sel">${cardOpts}</select></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>실행 시각</th><th>구분</th><th>모델</th>${AL.map((l) => `<th>${esc(layerName(l))}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${3 + AL.length}" class="muted">이 상황이 들어 있는 실행이 없습니다.</td></tr>`}</tbody></table></div>
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


/* ---------- 라우터 ---------- */
const ROUTES = { '': 'home', '/': 'home', '/guide': 'guide', '/simulate': 'simulate', '/profile': 'profile', '/runs': 'runs', '/data': 'data', '/needs': 'needs', '/ops': 'ops', '/validate': 'simulate', '/evidence': 'profile' };
const TITLES = { home: '약국 페르소나 시뮬레이터', guide: '사용 가이드', simulate: '시뮬레이터', profile: '약사 프로필', runs: '실행 기록', data: '공공·가상 데이터', needs: '니즈와 AX 여지', ops: '운영 메모' };
let curRoute = null;
function route() {
  const hash = location.hash;
  if (hash && !hash.startsWith('#/')) return;
  const name = ROUTES[hash.slice(1)] || 'home';
  if (curRoute === 'simulate' && name !== 'simulate') leaveSim();
  curRoute = name;
  document.body.dataset.route = name;
  $$('.view').forEach((v) => { v.hidden = v.id !== `view-${name}`; });
  $$('.nav a').forEach((a) => { a.dataset.route === name ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'); });
  document.title = name === 'home' ? TITLES.home : `${TITLES[name]} · 약국 페르소나 시뮬레이터`;
  if (name === 'simulate') enterSim();
  if (name === 'profile') profilePage();
  if (name === 'runs') loadRunIndex().then(renderRuns);
  if (name === 'data') renderDataPage($('#data-root'));
  if (name === 'needs' && DB.ok) renderNeeds();
  if (name === 'ops') opsPage();
  window.scrollTo(0, 0);
  const h = $(`#view-${name} h1`); h && h.focus({ preventScroll: true });
}
window.addEventListener('hashchange', route);

/* ---------- 시작 ---------- */
async function init() {
  syncTheme();
  try {
    await loadData();
    $('#data-status').innerHTML = `근거 데이터: 발언 ${DB.claims.length}건 · 판단 방식 ${DB.rules.length}건 · 사례 ${DB.cases.length}건 · 주의 규칙 ${DB.guardrails.length}건`;
  } catch (err) {
    $('#data-status').textContent = '근거 데이터를 불러오지 못했습니다.';
    const bn = $('#app-banner'); bn.hidden = false;
    bn.textContent = `근거 CSV를 읽지 못했습니다(${err.message}). 저장소 루트에서 서버를 실행한 뒤 http://localhost 주소로 열어야 합니다.`;
  }
  route();
  window.__app = { DB, route, scene };
}
init();
