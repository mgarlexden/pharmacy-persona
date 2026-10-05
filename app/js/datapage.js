// 공공·가상 데이터 탭. 저장된 CSV만 읽어 보여 준다(화면이 API 를 부르지 않는다).
// 공공: data/2_world/derived/public_snapshot.csv (scripts/build_public.py 가 만든다), 출처 목록은 data/2_world/data_sources.csv
// 가상: data/3_virtual/ (virtual_params.csv, field_defs.csv, tables/*.csv)
import { parseCSV } from './data.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const badge = (cls, t) => `<span class="badge b-${cls}">${esc(t)}</span>`;
const PUB = badge('public', '공공');
const VIRT = badge('virtual', '가상');
const fmt = (v) => { const n = Number(v); return v !== '' && Number.isFinite(n) ? n.toLocaleString('ko-KR') : esc(v); };
const md = (iso) => { const d = new Date(`${iso}T00:00:00`); return `${d.getMonth() + 1}/${d.getDate()}`; };

const BASE = '../data/';
const VTABLES = {
  calendar: ['달력', '날짜, 영업 여부, 연휴 전후, 독감 지수', true],
  rx_daily: ['처방 건수', '내과·이비인후과 처방 건수와 조제료', true],
  otc_hourly: ['일반약 방문(시간별)', '시간대별 일반약 구매자와 판매', true],
  inventory_daily: ['재고', '품목별 실물·전산 재고, 주문, 입고', false],
  cash_daily: ['현금', '입금, 도매 결제, 고정비, 현금 여력', false],
  payment_daily: ['도매 결제', '결제 조건, 금융비용 할인, 미지급', false],
  supply_daily: ['도매 공급', '주문 마감, 최소 주문, 결품', false],
};
// 지금 화면이 실제로 읽는 값과, 준비된 공공 값. 연결 전/후를 바꾸면 이 표만 고친다.
const LINKS = [
  ['연휴·공휴일', 'X001', '공휴일 정보 → 날짜별 공휴일, 연휴 다음 날', '시나리오 문구 · 기본 보기', '연결됨'],
  ['감기·독감 유행', 'X005', '경기 인플루엔자 의사환자분율(주별)', '시나리오 문구 · 기본 보기 손님 수', '연결됨'],
  ['주변 의원 진료·휴진', 'X002', '같은 건물 이비인후과 진료시간 (화요일 오전 휴진, 일·공휴일 오전 진료)', '시나리오 문구 · 기본 보기 시간대별 손님', '연결됨'],
  ['비·기온', '-', '기상청 ASOS 일자료 (서울 관측소)', '기본 보기 손님 수 · 3D 우산', '연결됨'],
  ['미세먼지', '-', '에어코리아 구리시 측정소 일평균', '기본 보기에 수치 표시 · 3D 마스크 (켜고 끄기)', '연결됨'],
  ['감기약 계절 수요', '-', '구리시 약효분류 3종 월별 사용량', '기본 보기 손님 수(계절)', '연결됨'],
  ['주변 의원·약국 수', 'P011, X012', '반경 100·200·300m 의료기관·약국 수, 같은 건물 3곳', '이 탭과 약사 프로필에만 표시', '표시만'],
  ['하루 손님 규모', '-', '공공 자료 없음. 인터뷰의 "하루 약 100건"(가정 허용값)', '기본 보기 손님 수의 기준', '인터뷰 가정'],
  ['재고·현금·도매 조건', 'S·C 계열', '공공 자료 없음 (인터뷰 정성 근거)', '시나리오의 가정값', '해당 없음'],
];
// 출처별 연결 상태 (data_sources.csv 의 ID). 이름·제공기관은 그 파일에서 읽는다.
const SRC = [
  ['DT_L17', 'API', '받아 둠'], ['DT_L18', 'API', '받아 둠'], ['DT_L20', 'API', '받아 둠'], ['DT_L10', 'API', '받아 둠'],
  ['DT_L11', '웹 표 내려받기', '받아 둠'], ['DT_L33', '파일', '받아 둠'], ['DT_L34', '파일', '받아 둠'], ['DT_L23', '파일', '받아 둠'], ['DT_L40', '파일', '받아 둠'],
  ['DT_L35', 'API (같은 건물은 팀 정리본)', '신청 전'], ['DT_L14', 'API', '추후 연동'], ['DT_L19', 'API', '필요 시'],
];
const PROP_ASSUME = [
  ['화면의 인물 수', '손님 2명을 인물 1명으로 그림'],
  ['하루 길이', '재생 시 하루를 12초로 줄임'],
  ['기다리는 한계', '처방 손님 약 25분, 일반약 손님 약 12분 (가정)'],
  ['응대 시간', '처방 약 3분, 일반약 약 1.5분, 판매만 약 1분 (가정)'],
  ['손님 색과 원', '유입 경로별 옷 색, 발 아래 원(초록·노랑·빨강)은 가정 규칙으로 정함'],
];

const state = { tab: 'overview', loaded: false, err: '', pub: [], src: new Map(), vp: [], fd: [], vcount: {}, root: null };

async function getCSV(path) {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return parseCSV(await r.text());
}
async function loadAll() {
  if (state.loaded) return;
  const [pub, src, vp, fd] = await Promise.all([
    getCSV('2_world/derived/public_snapshot.csv'), getCSV('2_world/data_sources.csv'),
    getCSV('3_virtual/virtual_params.csv'), getCSV('3_virtual/field_defs.csv'),
  ]);
  state.pub = pub; state.vp = vp; state.fd = fd;
  src.forEach((r) => state.src.set(r.data_id, r));
  await Promise.all(Object.keys(VTABLES).map(async (t) => {
    const r = await fetch(`${BASE}3_virtual/tables/${t}.csv`);
    if (r.ok) { const txt = await r.text(); state.vcount[t] = Math.max(0, txt.split('\n').filter((l) => l.trim()).length - 1); }
  }));
  state.loaded = true;
}

const rows = (scope) => state.pub.filter((r) => r.scope === scope);
const one = (scope, key, label) => (state.pub.find((r) => r.scope === scope && r.key === key && r.label_ko === label) || {}).value;
const fetchedAt = (id) => { const r = state.pub.find((x) => x.data_id === id); return r ? r.fetched_at.slice(0, 16).replace('T', ' ') : ''; };

/* ---------- 한눈에 ---------- */
function overview() {
  const c = {}; state.pub.forEach((r) => { c[r.scope] = (c[r.scope] || 0) + 1; });
  const tiles = `<div class="dp-tiles">
    <div class="dp-tile"><span class="k">${PUB} 정리해 둔 값</span><b>${state.pub.length.toLocaleString('ko-KR')}개</b><span class="s">날짜별 ${c.daily || 0} · 월별 ${c.monthly || 0} · 고정 ${c.fixed || 0} · 주별 ${c.weekly || 0}</span></div>
    <div class="dp-tile"><span class="k">${VIRT} 기록 표</span><b>${Object.keys(VTABLES).length}개</b><span class="s">1년치(2026-01-01~12-31) 가상 약국 기록</span></div>
    <div class="dp-tile"><span class="k">${VIRT} 가정과 기준</span><b>${state.vp.length}개</b><span class="s">가상 표를 만든 기준과 가정</span></div>
  </div>`;
  const body = LINKS.map(([name, v, src, where, st]) => `<tr><td><b>${esc(name)}</b>${v !== '-' ? ` <span class="xs muted">${esc(v)}</span>` : ''}</td><td>${st === '연결됨' || st === '표시만' ? `${PUB} ` : ''}${esc(src)}</td><td>${esc(where)}</td><td>${badge(st === '연결됨' ? 'good' : st === '인터뷰 가정' ? 'interview' : 'neutral', st)}</td></tr>`).join('');
  return `${tiles}
  <div class="callout" style="margin:16px 0"><p>시뮬레이터의 기본 보기(하루 손님 흐름)와 시나리오 문구가 아래 공공 값을 씁니다. 재고·현금·주문량과 시간대별 손님 분포는 가상입니다.</p></div>
  <h2 class="dp-h">시뮬레이션 변수별 데이터 연결 상태</h2>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>변수</th><th>쓰는 값</th><th>어디에 쓰나</th><th>상태</th></tr></thead><tbody>${body}</tbody></table></div>
  <p class="xs muted" style="margin-top:8px">"하루 약 100건"은 인터뷰에서 약사가 신규 약국의 초기 상황을 가정할 때 써도 된다고 한 값입니다. 실제 평균이 아니며, 응답자 1명의 의견입니다.</p>`;
}

/* ---------- 공공데이터 ---------- */
function radiusTable() {
  const KINDS = [['의원', '의원'], ['치과', '치과'], ['한의원', '한의원'], ['의료기관(의원·치과·한의원)', '의료기관 합계'], ['주변 약국', '주변 약국']];
  const R = [100, 200, 300];
  const body = KINDS.map(([k, lab]) => `<tr><td><b>${esc(lab)}</b></td>${R.map((r) => {
    const v = one('fixed', `반경${r}m`, `반경 ${r}m 안 ${k}`);
    const x = one('fixed', `반경${r}m`, `[교차 확인] 반경 ${r}m 안 ${k}`);
    const diff = x !== undefined && x !== '' && String(x) !== String(v);
    return `<td class="num">${fmt(v ?? '')}${x !== undefined && x !== '' ? ` <span class="xs ${diff ? 'diff' : 'muted'}" title="심평원 2026.6 파일로 같은 기준점에서 계산한 값">(${fmt(x)})</span>` : ''}</td>`;
  }).join('')}</tr>`).join('');
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>구분</th>${R.map((r) => `<th class="num">${r}m 안</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>
  <p class="xs muted" style="margin-top:8px">숫자는 팀 정리본(공개자료 확인 목록, 2026-10-06 조회), 괄호는 심평원 2026.6 파일로 같은 기준점에서 계산한 값입니다. 괄호가 다르게 표시된 칸은 두 자료가 어긋난 곳입니다. 직선거리이며 약국 자신은 제외합니다. 현재 영업 전수조사가 아닙니다.</p>`;
}
function buildingBlock() {
  const n = one('fixed', '같은건물', '같은 건물 의료기관 수');
  const floors = rows('fixed').filter((r) => r.key === '같은건물' && r.label_ko.startsWith('같은 건물 ') && r.unit === '' && /층/.test(r.value) && !r.label_ko.includes('진료시간'));
  const hr = rows('fixed').find((r) => r.label_ko === '같은 건물 이비인후과 진료시간');
  let hours = '';
  if (hr) {
    const DAYS = ['월', '화', '수', '목', '금', '토', '일', '공휴일'];
    const map = {};
    hr.value.split('/').forEach((seg) => { const m = seg.trim().match(/^(\S+)\s+(.+)$/); if (m) m[1].split('·').forEach((d) => { map[d] = m[2]; }); });
    hours = `<h3 class="dp-h3">같은 건물 이비인후과 진료시간</h3>
    <div class="tbl-wrap"><table class="tbl"><thead><tr>${DAYS.map((d) => `<th class="num">${d}</th>`).join('')}</tr></thead><tbody><tr>${DAYS.map((d) => `<td class="num">${esc(map[d] || '-')}</td>`).join('')}</tr></tbody></table></div>
    <p class="xs muted" style="margin-top:8px">${esc(hr.note)} 시뮬레이터의 시간대별 손님과 시나리오 문구가 이 진료시간을 씁니다.</p>`;
  }
  return `<h3 class="dp-h3">같은 건물 ${n || ''}곳</h3>
  <ul class="dp-list">${floors.map((f) => `<li><b>${esc(f.value)}</b> ${esc(f.label_ko.replace('같은 건물 ', ''))}</li>`).join('')}</ul>${hours}`;
}
function guriBlock() {
  const t = rows('fixed').filter((r) => r.data_id === 'DT_L33' && r.key === '' && !r.label_ko.includes('안'));
  const sub = rows('fixed').filter((r) => r.data_id === 'DT_L34');
  const max = Math.max(1, ...sub.map((r) => Number(r.value)));
  const ph = ['구리시 약국 수', '구리시 약국 목록 수(중복 제외)', '구리시 약국 중 토요일 영업', '구리시 약국 중 일요일 영업', '구리시 약국 중 공휴일 영업', '구리시 약국 중 월요일 20시 이후 마감'];
  return `<div class="dp-two">
    <div><h3 class="dp-h3">구리시 의료기관 (2026.6)</h3><ul class="dp-kv">${t.map((r) => `<li><span>${esc(r.label_ko.replace('구리시 ', '').replace(' 수', ''))}</span><b>${fmt(r.value)}곳</b></li>`).join('')}</ul>
    <h3 class="dp-h3">구리시 약국</h3><ul class="dp-kv">${ph.map((l) => { const r = state.pub.find((x) => x.label_ko === l); return r ? `<li><span>${esc(l.replace('구리시 ', ''))}</span><b>${fmt(r.value)}${esc(r.unit)}</b></li>` : ''; }).join('')}</ul>
    <p class="xs muted">약국 107곳은 2026.6 심평원 파일, 나머지는 2026-10 약국 목록 기준입니다. 이 약국은 9월 개업이라 6월 파일에는 없습니다.</p></div>
    <div><h3 class="dp-h3">구리시 의원의 진료과목</h3><div class="dp-bars">${sub.slice(0, 12).map((r) => `<div class="dp-bar"><span>${esc(r.label_ko.replace('구리시 의원 중 ', '').replace(' 진료과목', ''))}</span><i style="--w:${(Number(r.value) / max * 100).toFixed(0)}%"></i><b>${fmt(r.value)}</b></div>`).join('')}</div>
    <p class="xs muted">한 의원이 여러 과목을 보면 과목마다 셉니다.</p></div></div>`;
}
function dailyBlock() {
  const days = new Map();
  rows('daily').forEach((r) => { const d = days.get(r.key) || { date: r.key }; d[r.label_ko] = r.value; days.set(r.key, d); });
  const list = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  const sim = new Set(['2026-10-06', '2026-10-07', '2026-10-08']);
  const body = list.map((d) => {
    const hol = d['공휴일 여부'] === 'Y';
    const cell = (v, u = '') => (v === undefined || v === '' ? '<td class="num muted">—</td>' : `<td class="num">${esc(v)}${u}</td>`);
    return `<tr class="${hol ? 'hol' : ''}${sim.has(d.date) ? ' simday' : ''}"><td>${md(d.date)}(${esc(d['요일'])})${sim.has(d.date) ? ' <span class="xs">시뮬레이션 장면</span>' : ''}</td><td>${hol ? esc(d['공휴일 이름'] || '공휴일') : ''}</td>${cell(d['평균기온'], '℃')}${cell(d['최저기온'] !== undefined ? `${d['최저기온']}~${d['최고기온']}` : undefined, '℃')}${cell(d['일 강수량'], 'mm')}${cell(d['PM10 일평균'])}${cell(d['PM2.5 일평균'])}</tr>`;
  }).join('');
  return `<div class="tbl-wrap dp-scroll"><table class="tbl"><thead><tr><th>날짜</th><th>공휴일</th><th class="num">평균기온</th><th class="num">최저~최고</th><th class="num">강수량</th><th class="num">PM10</th><th class="num">PM2.5</th></tr></thead><tbody>${body}</tbody></table></div>
  <p class="xs muted" style="margin-top:8px">날씨는 서울 관측소(구리시에는 관측소가 없음)이고 10/4까지, 미세먼지는 구리시 동구동 측정소 일평균이며 10/5까지 있습니다. 빈 칸(—)은 아직 값이 없는 날입니다. 미세먼지는 단위가 ㎍/㎥이고, "나쁨" 같은 등급 기준은 확인된 근거가 없어 넣지 않았습니다.</p>`;
}
function weeklyBlock() {
  const w = rows('weekly'); const max = Math.max(40, ...w.map((r) => Number(r.value) || 0));
  return `<div class="dp-bars">${w.map((r) => `<div class="dp-bar"><span>${esc(r.key.replace('2026-27절기 ', ''))}</span>${r.value === '' ? '<em>집계 중</em>' : `<i style="--w:${(Number(r.value) / max * 100).toFixed(0)}%"></i><b>${fmt(r.value)}</b>`}</div>`).join('')}</div>
  <p class="xs muted" style="margin-top:8px">경기, 2026-27 절기, 외래환자 1,000명당 인플루엔자 의사환자분율(질병관리청 감염병포털 표본감시). 시군구 값은 없습니다. 시나리오 문구와 기본 보기는 가장 최근 값(39주)을 씁니다.</p>`;
}
function monthlyBlock() {
  const q = rows('monthly').filter((r) => r.label_ko.endsWith('사용 수량'));
  const labs = [...new Set(q.map((r) => r.label_ko))];
  const months = [...new Set(q.map((r) => r.key))].sort();
  const mx = Object.fromEntries(labs.map((l) => [l, Math.max(...q.filter((r) => r.label_ko === l).map((r) => Number(r.value)))]));
  const get = (m, l) => (q.find((r) => r.key === m && r.label_ko === l) || {}).value;
  const body = months.map((m) => `<tr class="${/-(09|10)$/.test(m) ? 'simday' : ''}"><td>${m}</td>${labs.map((l) => { const v = get(m, l); return v === undefined ? '<td class="num muted">—</td>' : `<td class="num dp-cellbar" style="--w:${(Number(v) / mx[l] * 100).toFixed(0)}%">${fmt(v)}</td>`; }).join('')}</tr>`).join('');
  return `<div class="tbl-wrap dp-scroll"><table class="tbl"><thead><tr><th>진료월</th>${labs.map((l) => `<th class="num">${esc(l.replace(' 사용 수량', ''))}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>
  <p class="xs muted" style="margin-top:8px">구리시, 조제기준, 보험자 구분을 합친 사용 수량(심평원). 건강보험 청구분만 있어 처방 없이 산 일반약은 빠집니다. 가장 최근 달은 약 4개월 늦게 올라옵니다. 9·10월 줄을 표시했습니다.</p>`;
}
function sourcesBlock() {
  const body = SRC.map(([id, how, st]) => {
    const s = state.src.get(id) || {};
    return `<tr><td class="num">${esc(id)}</td><td><b>${esc(s.item_ko || '')}</b><br><span class="xs muted">${esc(s.provider || '')}</span></td><td>${esc(how)}</td><td>${badge(st === '받아 둠' ? 'good' : st === '추후 연동' ? 'hyp' : 'neutral', st)}</td><td class="xs muted">${esc(fetchedAt(id) || '—')}</td></tr>`;
  }).join('');
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>데이터</th><th>이름과 제공기관</th><th>받는 방법</th><th>상태</th><th>받은 시각</th></tr></thead><tbody>${body}</tbody></table></div>
  <p class="xs muted" style="margin-top:8px">전체 63개 출처의 설명은 <code>data/2_world/data_sources.csv</code>에 있습니다. 이 화면은 저장된 값만 읽습니다. 값을 새로 받으려면 <code>python scripts/build_public.py --refresh</code>를 실행합니다. 주변 의원·약국 수에는 팀이 공개자료로 정리한 목록도 쓰였고, 그 목록의 이름과 주소는 저장소에 두지 않았습니다.</p>`;
}
function publicTab() {
  return `<div class="callout" style="margin-bottom:16px"><p>${PUB} <b>공공 실측 값</b>입니다. 공공데이터포털 API와 내려받은 파일에서 필요한 값만 뽑아 한 파일(<code>data/2_world/derived/public_snapshot.csv</code>)로 모았습니다. 개별 의원·약국 이름과 좌표는 넣지 않았습니다.</p></div>
  <section class="dp-sec"><h2 class="dp-h">주변 환경 (고정) ${PUB}</h2>${radiusTable()}${buildingBlock()}</section>
  <section class="dp-sec"><h2 class="dp-h">구리시 전체 현황 (고정) ${PUB}</h2>${guriBlock()}</section>
  <section class="dp-sec"><h2 class="dp-h">9·10월 날짜별 환경 ${PUB}</h2>${dailyBlock()}</section>
  <section class="dp-sec"><h2 class="dp-h">독감 유행 (주별) ${PUB}</h2>${weeklyBlock()}</section>
  <section class="dp-sec"><h2 class="dp-h">감기약 계절 수요 (월별) ${PUB}</h2>${monthlyBlock()}</section>
  <section class="dp-sec"><h2 class="dp-h">출처와 연결 상태</h2>${sourcesBlock()}</section>`;
}

/* ---------- 가상데이터 ---------- */
function virtualTab() {
  const byTable = {};
  state.fd.forEach((r) => { (byTable[r.table_name] = byTable[r.table_name] || []).push(r); });
  const trs = Object.entries(VTABLES).map(([t, [name, desc, used]]) => {
    const f = byTable[t] || [];
    return `<tr><td><b>${esc(name)}</b><br><span class="xs muted">${esc(t)}.csv</span></td><td>${esc(desc)}</td><td class="num">${fmt(state.vcount[t] ?? '')}</td><td class="num">${f.length}</td><td>${used ? badge('virtual', '3D 손님 흐름에 사용') : badge('neutral', '아직 화면에 안 씀')}</td></tr>`;
  }).join('');
  const groups = {};
  state.vp.forEach((r) => { (groups[r.source_kind_ko || '기타'] = groups[r.source_kind_ko || '기타'] || []).push(r); });
  const order = ['가정', '측정', '파생', '결정', '인터뷰'];
  const keys = [...new Set([...order.filter((k) => groups[k]), ...Object.keys(groups)])];
  const gh = keys.map((k) => `<details class="dp-det" ${k === '가정' ? 'open' : ''}><summary><b>${esc(k)}</b> <span class="xs muted">${groups[k].length}개</span></summary>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>이름</th><th class="num">값</th><th>근거</th></tr></thead><tbody>${groups[k].map((r) => `<tr><td>${esc(r.label_ko)}<br><span class="xs muted">${esc(r.param_id)}${r.used_in ? ` · 쓰임: ${esc(r.used_in)}` : ''}</span></td><td class="num">${esc(r.value_text)}${r.unit ? ` ${esc(r.unit)}` : ''}</td><td class="xs">${esc(r.basis_ko || r.grade_reason_ko || '')}${r.support_grade ? ` <span class="muted">(등급 ${esc(r.support_grade)})</span>` : ''}</td></tr>`).join('')}</tbody></table></div></details>`).join('');
  return `<div class="callout virt" style="margin-bottom:16px"><p>${VIRT} <b>가상 값</b>입니다. 가상 약국 한 곳의 1년치 기록을 팀이 가정으로 만든 것이며, 실제 약국의 값이 아닙니다. 화면에 나올 때는 항상 "가상"을 붙입니다.</p></div>
  <section class="dp-sec"><h2 class="dp-h">가상 표 ${VIRT}</h2><div class="tbl-wrap"><table class="tbl"><thead><tr><th>표</th><th>내용</th><th class="num">행 수</th><th class="num">열 수</th><th>화면에서 쓰임</th></tr></thead><tbody>${trs}</tbody></table></div>
  <p class="xs muted" style="margin-top:8px">손님 수 계산(사흘 재고)은 하루 수요를 고정값으로 쓰고, 이 표들과는 이어져 있지 않습니다. 3D의 손님 흐름만 달력·처방·일반약 표를 읽습니다.</p></section>
  <section class="dp-sec"><h2 class="dp-h">가상 표를 만든 가정과 기준 ${VIRT}</h2>${gh}</section>
  <section class="dp-sec"><h2 class="dp-h">3D 화면 연출에 쓴 가정 ${VIRT}</h2><ul class="dp-kv">${PROP_ASSUME.map(([a, b]) => `<li><span>${esc(a)}</span><b>${esc(b)}</b></li>`).join('')}</ul></section>`;
}

/* ---------- 화면 ---------- */
function paint() {
  const root = state.root;
  const tabs = [['overview', '한눈에'], ['public', '공공데이터'], ['virtual', '가상데이터']];
  const seg = `<div class="cond-row"><span class="lab" id="lab-dp">보기</span><span class="seg" role="radiogroup" aria-labelledby="lab-dp">${tabs.map(([k, t]) => `<label><input type="radio" name="dptab" value="${k}" ${state.tab === k ? 'checked' : ''}><span>${t}</span></label>`).join('')}</span></div>`;
  let body = '';
  if (state.err) body = `<div class="callout warn"><p>데이터를 읽지 못했습니다 (${esc(state.err)}). 서버를 저장소 루트에서 열었는지, <code>python scripts/build_public.py</code>를 실행했는지 확인하세요.</p></div>`;
  else if (!state.loaded) body = '<p class="small muted">불러오는 중…</p>';
  else body = state.tab === 'public' ? publicTab() : state.tab === 'virtual' ? virtualTab() : overview();
  root.innerHTML = `${seg}<div class="dp-body">${body}</div>`;
}
export async function renderDataPage(root) {
  if (!state.root) {
    state.root = root;
    root.addEventListener('change', (e) => { if (e.target.name === 'dptab') { state.tab = e.target.value; paint(); window.scrollTo({ top: 0 }); } });
  }
  paint();
  try { await loadAll(); state.err = ''; } catch (e) { state.err = e.message; }
  paint();
}
