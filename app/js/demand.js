// 하루 손님 수 모형. 기준 규모는 인터뷰, 날짜별 환경은 공공데이터, 시간대 분포는 가상데이터, 반응 크기는 가정이다.
// 모형이 쓰는 값과 출처는 factors 로 그대로 돌려줘 화면에 보인다. 값을 몰래 보정하지 않는다.
//
//   하루 손님 = 기준(인터뷰 100건) × 계절(공공) × 독감(공공 값 + 가정 계수) × 기온(공공 값 + 가정 계수) × 연휴 다음 날(가정)
//   시간대별로 나누고(가상 분포), 약국·이비인후과가 닫힌 시간은 뺀다(가상 영업시간 · 공공 진료시간).
import { parseCSV } from './data.js';

export const BASE_VISITS = 100; // 인터뷰: 신규 약국 초기 상황이면 하루 약 100건으로 잡아도 된다 (실측 평균 아님)
export const ITEM_BASE = 5; // 판단 품목의 하루 수요 (카드 가정값)
// 반응 크기 (가정). 근거 데이터가 없어 팀이 정한 값이며 화면에 "가정"으로 보인다.
export const K = { ili: 0.4, temp: 0.012, rainWalk: 0.85, afterHoliday: 1.2, inquiryPerWalk: 0.25 };
export const RX_HOUR_W = [8, 14, 14, 12, 5, 9, 10, 10, 11, 7]; // 09~18시 처방 손님 도착 비중 (가정, 3D 목업과 같은 값)
export const HOURS = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
const DOW = ['일', '월', '화', '수', '목', '금', '토'];

const M = { ready: false };
const get = async (p) => { const r = await fetch(p); if (!r.ok) throw new Error(`${p} ${r.status}`); return parseCSV(await r.text()); };
const num = (v) => (v === '' || v == null ? null : Number(v));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

function isoWeek(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - y0) / 86400000 + 1) / 7);
}
function parseHours(s) {
  const out = {};
  String(s || '').split('/').forEach((seg) => {
    const m = seg.trim().match(/^(\S+)\s+(\d{1,2})\D+(\d{1,2})/);
    if (m) m[1].split('·').forEach((d) => { out[d] = [Number(m[2]), Number(m[3])]; });
  });
  return out;
}

export async function loadDemand(base = '../data/') {
  if (M.ready) return M;
  const [pub, cal, rx, oh] = await Promise.all([
    get(`${base}2_world/derived/public_snapshot.csv`), get(`${base}3_virtual/tables/calendar.csv`),
    get(`${base}3_virtual/tables/rx_daily.csv`), get(`${base}3_virtual/tables/otc_hourly.csv`),
  ]);
  // 공공: 날짜별
  const day = new Map();
  pub.filter((r) => r.scope === 'daily').forEach((r) => { const d = day.get(r.key) || { date: r.key }; d[r.label_ko] = r.value; day.set(r.key, d); });
  M.dates = [...day.keys()].sort();
  M.pubDay = day;
  // 공공: 주별 독감 (ISO 주차로 날짜에 대응. 질병관리청 주차와 하루 정도 어긋날 수 있다)
  M.iliWeek = {};
  pub.filter((r) => r.scope === 'weekly' && r.value !== '').forEach((r) => { const w = Number((r.key.match(/(\d+)주/) || [])[1]); if (w) M.iliWeek[w] = Number(r.value); });
  const weeks = Object.keys(M.iliWeek).map(Number).sort((a, b) => a - b);
  M.iliLastWeek = weeks[weeks.length - 1];
  M.iliRef = mean(Object.values(M.iliWeek)); // 9월 경기 평균: 하루 100건을 말한 시기의 수준
  // 공공: 기온 기준 (받아 둔 9·10월 평균)
  M.tempRef = mean([...day.values()].map((d) => num(d['평균기온'])).filter((v) => v != null));
  // 공공: 계절 지수 (구리시 감기 관련 약효분류 3종 사용량, 같은 달의 2024·2025 평균 / 9·10월 평균)
  const mq = {};
  pub.filter((r) => r.scope === 'monthly' && r.label_ko.endsWith('사용 수량')).forEach((r) => { mq[r.key] = (mq[r.key] || 0) + Number(r.value); });
  const monthAvg = (m) => mean(['2024', '2025'].map((y) => mq[`${y}-${m}`]).filter((v) => v != null));
  const ref = mean([monthAvg('09'), monthAvg('10')]);
  M.season = { '09': monthAvg('09') / ref, '10': monthAvg('10') / ref };
  // 공공: 같은 건물 이비인후과 진료시간
  const ent = pub.find((r) => r.label_ko === '같은 건물 이비인후과 진료시간');
  M.entHours = parseHours(ent && ent.value);
  // 가상: 약국 영업, 연휴 전후
  M.cal = new Map(cal.map((r) => [r.date, r]));
  // 가상: 손님 구성(처방 대 일반약)과 시간대 분포. 9·10월 평일 영업일 평균
  const wk = cal.filter((r) => /^2026-(09|10)/.test(r.date) && r.is_open === 'Y' && r.open_type === '평일').map((r) => r.date);
  const wkSet = new Set(wk);
  const rxRows = rx.filter((r) => wkSet.has(r.date));
  const im = mean(rxRows.map((r) => Number(r.rx_count_internal) || 0)), en = mean(rxRows.map((r) => Number(r.rx_count_ent) || 0));
  const walkBy = HOURS.map(() => []);
  const walkDay = {};
  oh.filter((r) => wkSet.has(r.date)).forEach((r) => { const h = Number(r.hour_band.slice(0, 2)) - 9; if (h >= 0 && h < 10) { walkBy[h].push(Number(r.walkin_buyers) || 0); walkDay[r.date] = (walkDay[r.date] || 0) + (Number(r.walkin_buyers) || 0); } });
  const walk = mean(Object.values(walkDay)), inq = walk * K.inquiryPerWalk;
  const tot = im + en + walk + inq;
  M.mix = { oth: im / tot, ent: en / tot, walk: walk / tot, inq: inq / tot };
  const wsum = walkBy.reduce((a, l) => a + mean(l), 0) || 1;
  M.walkW = walkBy.map((l) => mean(l) / wsum);
  const rsum = RX_HOUR_W.reduce((a, b) => a + b, 0);
  M.rxW = RX_HOUR_W.map((w) => w / rsum);
  M.ready = true;
  return M;
}

/** 그날의 공공 값 (화면 기본값). */
export function dayDefaults(date) {
  const d = M.pubDay.get(date) || {};
  const w = isoWeek(date);
  const ili = M.iliWeek[w] ?? M.iliWeek[M.iliLastWeek];
  return {
    date, dow: d['요일'] || DOW[new Date(`${date}T00:00:00`).getDay()],
    holiday: d['공휴일 여부'] === 'Y' ? (d['공휴일 이름'] || '공휴일') : '',
    ili, iliWeek: M.iliWeek[w] != null ? w : M.iliLastWeek, iliCarried: M.iliWeek[w] == null,
    temp: num(d['평균기온']), tempMin: num(d['최저기온']), tempMax: num(d['최고기온']),
    rainMm: num(d['일 강수량']), pm10: num(d['PM10 일평균']), pm25: num(d['PM2.5 일평균']),
  };
}

/**
 * 하루 손님 계산.
 * env: { date, ili, temp, rain(bool) } — ili·temp 가 없으면 그날 공공 값, 그것도 없으면 기준값을 쓴다.
 */
export function computeDay(env) {
  const def = dayDefaults(env.date);
  const c = M.cal.get(env.date) || {};
  const open = c.is_open === 'Y';
  const openH = open ? Number(c.open_hours) || 10 : 0;
  const ili = env.ili ?? def.ili ?? M.iliRef;
  const temp = env.temp ?? def.temp ?? M.tempRef;
  const rain = env.rain ?? (def.rainMm != null && def.rainMm >= 1);
  const month = env.date.slice(5, 7);
  const fSeason = M.season[month] || 1;
  const km = env.kMul ?? 1; // 가정한 반응 크기를 몇 배로 볼지 (예측 범위 계산용)
  const fIli = Math.max(0.6, 1 + K.ili * km * (ili / M.iliRef - 1));
  const fTemp = Math.max(0.7, 1 + K.temp * km * (M.tempRef - temp));
  const after = /연휴 후|연휴 다음/.test(c.holiday_adjacency || '');
  const fAfter = after ? 1 + (K.afterHoliday - 1) * km : 1;
  const fRain = 1 - (1 - K.rainWalk) * km;
  const mult = fSeason * fIli * fTemp * fAfter;
  const dowKey = def.holiday ? '공휴일' : def.dow;
  const entH = M.entHours[dowKey] || null;
  const hours = HOURS.map((h, i) => {
    const pharmOpen = i < openH;
    const entOpen = !!entH && h >= entH[0] && h < entH[1];
    const b = BASE_VISITS * mult;
    if (!pharmOpen) return { h, oth: 0, ent: 0, walk: 0, inq: 0, open: false, entOpen };
    return {
      h, open: true, entOpen,
      oth: b * M.mix.oth * M.rxW[i],
      ent: entOpen ? b * M.mix.ent * M.rxW[i] : 0,
      walk: b * M.mix.walk * M.walkW[i] * (rain ? fRain : 1),
      inq: b * M.mix.inq * M.walkW[i] * (rain ? fRain : 1),
    };
  });
  const sum = (k) => hours.reduce((a, x) => a + x[k], 0);
  const total = sum('oth') + sum('ent') + sum('walk') + sum('inq');
  const factors = [
    { label: '기준 규모', value: `하루 ${BASE_VISITS}건`, f: null, src: 'interview', note: '인터뷰에서 약사가 "신규 약국 초기라면 하루 약 100건으로 잡아도 된다"고 한 값. 실제 평균이 아님' },
    { label: '계절', value: `${Number(month)}월`, f: fSeason, src: 'public', note: '구리시 감기 관련 약 사용량(2024·2025 같은 달 평균)을 9·10월 평균과 비교' },
    { label: '독감', value: `${ili.toFixed(1)}명/1,000명`, f: fIli, src: env.ili != null ? 'user' : 'public', note: `경기 의사환자분율. 기준 ${M.iliRef.toFixed(1)}명(9월 평균). 반응 크기 ${K.ili}는 가정` },
    { label: '기온', value: `${temp.toFixed(1)}℃`, f: fTemp, src: env.temp != null ? 'user' : 'public', note: `서울 관측소 평균기온. 기준 ${M.tempRef.toFixed(1)}℃. 1℃ 낮을 때 ${(K.temp * 100).toFixed(1)}% 늘어난다는 반응은 가정` },
    { label: '연휴 다음 날', value: after ? '해당' : '아님', f: fAfter, src: 'assume', note: after ? `연휴 뒤 첫 영업일에 ${Math.round((K.afterHoliday - 1) * 100)}% 몰린다는 가정` : '' },
    { label: '비', value: rain ? '옴' : '안 옴', f: rain ? K.rainWalk : 1, src: env.rain != null ? 'user' : 'public', note: rain ? `일반약 방문만 ${Math.round((1 - K.rainWalk) * 100)}% 줄인다는 가정` : '' },
  ];
  return {
    date: env.date, open, openH, def, ili, temp, rain, after, entH, hours, factors, mult,
    total, rxOth: sum('oth'), rxEnt: sum('ent'), walk: sum('walk'), inq: sum('inq'),
    item: Math.max(0, Math.round(ITEM_BASE * (open ? total / BASE_VISITS : 0))),
    pharmHoursKnown: false,
  };
}

export const FORECAST_SPREAD = [0.5, 1.5]; // 가정한 반응 크기를 절반 ~ 1.5배로 흔든 범위

/**
 * 선택한 날부터 앞으로 며칠의 예상 손님과 판단 품목 수요.
 * 독감 값을 직접 바꿨으면 모든 날에 적용하고, 기온을 바꿨으면 바꾼 만큼을 모든 날에 더한다. 비는 선택한 날에만 적용한다.
 * 범위는 값을 지어내지 않고, 가정한 반응 크기(K)만 FORECAST_SPREAD 배로 흔들어 만든다.
 */
export function forecast(env, days = 7) {
  const i0 = Math.max(0, M.dates.indexOf(env.date));
  const def0 = dayDefaults(env.date);
  const dT = env.temp != null && def0.temp != null ? env.temp - def0.temp : 0;
  const list = M.dates.slice(i0, i0 + days).map((date) => {
    const d = dayDefaults(date);
    const e = { date, ili: env.ili ?? undefined, temp: d.temp != null && dT ? d.temp + dT : undefined, rain: date === env.date ? env.rain : undefined };
    const vals = [1, ...FORECAST_SPREAD].map((kMul) => computeDay({ ...e, kMul }));
    const tot = vals.map((v) => v.total);
    const base = computeDay(e);
    return { date, dow: d.dow, holiday: d.holiday, open: base.open, base: base.total, lo: Math.min(...tot), hi: Math.max(...tot) };
  });
  const k = ITEM_BASE / BASE_VISITS;
  // 선택한 날부터 영업하는 사흘의 판단 품목 수요 합계
  const three = list.filter((x) => x.open).slice(0, 3);
  const sum = (key) => three.reduce((a, x) => a + x[key] * k, 0);
  return { list, itemDays: three.length, item: { lo: Math.round(sum('lo')), base: Math.round(sum('base')), hi: Math.round(sum('hi')) } };
}

/** 3D 손님 흐름에 넘길 시간대별 값 (손님 수/시간) */
export function flowHours(day) {
  return day.hours.map((x) => ({ oth: x.oth, ent: x.ent, walk: x.walk, inq: x.inq, open: x.open }));
}
export const model = () => M;
