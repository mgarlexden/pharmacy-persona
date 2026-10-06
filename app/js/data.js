// CSV 읽기, 카드·예시·니즈 정의. 근거 문구는 data/1_interview/*.csv 에서 읽은 실제 내용만 쓴다.

export function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

const FILES = {
  claims: 'claims.csv', rules: 'rules.csv', cases: 'cases.csv', guardrails: 'guardrails.csv', profile: 'persona_profile.csv', variables: 'variables.csv',
};

// 카드 변수표 (data/4_bridge). 관측 문장과 변수 역할의 원본이다. scripts/run_persona.py 도 같은 파일을 읽는다.
const BRIDGE = { obsRows: 'card_variables.csv', cardSpecs: 'cards.csv', roles: 'variable_roles.csv' };

export const DB = { claims: [], rules: [], cases: [], guardrails: [], profile: [], variables: [], obsRows: [], cardSpecs: [], roles: [], byId: new Map(), ok: false };

export async function loadData() {
  const get = async (dir, f) => {
    const res = await fetch(`../data/${dir}/${f}`);
    if (!res.ok) throw new Error(`${f} ${res.status}`);
    return parseCSV(await res.text());
  };
  const entries = await Promise.all([
    ...Object.entries(FILES).map(async ([k, f]) => [k, await get('1_interview', f)]),
    ...Object.entries(BRIDGE).map(async ([k, f]) => [k, await get('4_bridge', f)]),
  ]);
  entries.forEach(([k, rows]) => { DB[k] = rows; });
  DB.roleById = new Map(DB.roles.map((r) => [r.variable_id, r]));
  DB.specById = new Map(DB.cardSpecs.map((r) => [r.card_id, r]));
  DB.claims.forEach((r) => DB.byId.set(r.claim_id, { kind: '발언', id: r.claim_id, title: r.topic_ko, quote: r.quote_ko, summary: r.summary_ko, type: r.record_type, where: r.source_location, applies: r.applies_to }));
  DB.rules.forEach((r) => DB.byId.set(r.rule_id, { kind: '규칙', id: r.rule_id, title: r.title_ko, summary: r.judgement_ko, note: r.reading_note_ko, situation: r.situation_ko, type: r.statement_type }));
  DB.cases.forEach((r) => DB.byId.set(r.case_id, { kind: '사례', id: r.case_id, title: r.title_ko, summary: r.outcome_ko, note: r.learning_ko, situation: r.situation_ko, type: r.record_type, applies: r.applies_to }));
  DB.guardrails.forEach((r) => DB.byId.set(r.guardrail_id, { kind: '가드레일', id: r.guardrail_id, title: r.rule_ko, summary: r.handling_ko, note: r.distinguish_ko, situation: r.applies_at, type: r.check_type }));
  DB.ok = true;
  return DB;
}

export const lookup = (id) => DB.byId.get(id) || null;

/* 관측 줄 고르기: scripts/run_persona.py 의 obs_lines 와 같은 규칙.
   카드 전용 줄이 같은 순서의 공통(*) 줄을 덮고, scene=false 면 장면 입력 줄을 뺀다. hidden 줄은 따로 돌려준다. */
export function obsLines(cardId, cond, checked, scene = true) {
  const want = new Set(['always', checked ? 'checked' : 'unchecked', cond.prior ? 'prior' : 'no_prior', cond.bulk ? 'bulk' : 'no_bulk', cond.ret ? 'ret_ok' : 'ret_no', cond.hint ? 'hint' : 'no_hint']);
  if (cond.cutoff) want.add('cutoff');
  if (cond.tight) want.add('tight');
  const rows = new Map();
  DB.obsRows.forEach((r) => {
    if ((r.card_id !== '*' && r.card_id !== cardId) || !want.has(r.show_when)) return;
    if (r.layer === 'scene' && !scene) return;
    const prev = rows.get(r.line_order);
    if (prev && prev.card_id === cardId && r.card_id === '*') return;
    rows.set(r.line_order, r);
  });
  const shown = [...rows.values()].sort((a, b) => Number(a.line_order) - Number(b.line_order));
  const hidden = DB.obsRows.filter((r) => r.show_when === 'hidden' && (r.card_id === '*' || r.card_id === cardId));
  return { shown, hidden };
}

// ---------- 시나리오 카드 (모든 수치는 가정) ----------
// 10/6 통화 뒤 조정: 통장 잔액·외상 한도는 판단 조건에서 뺐다(소액 품목 발주를 잔액에 맞춰 정하지 않는다는 응답).
// 대신 수량별 단가(대량 할인)를 조건으로 넣었고, 재고는 선반+창고 합계로 정했다. 원본 값은 data/4_bridge/cards.csv.
// bulk: 10팩 이상을 한 번에 주문할 때의 팩당 단가. null 이면 수량과 관계없이 같은 단가.
// ret: 반품 가능, hint: 도매 사이트에 '재고 부족 예정' 표시, cutoff: 한글날 연휴 전 주문 마감, tight: 창고가 거의 찬 상태
const mk = (arrival, extra = {}) => ({ bulk: null, arrival, book: 8, physical: 8, ageH: 12, prior: false, ret: true, hint: false, cutoff: false, tight: false, ...extra });
export const D1 = '2026-10-07';
export const D2 = '2026-10-08';

// 화면에는 id 를 보이지 않는다. id 는 저장 기록과 자체 점검에만 쓰는 내부 키다.
// 각 카드: title(한 줄 상황), story(약사에게 읽어 줄 장면), test(이 카드로 확인하려는 것),
// support(인터뷰 근거의 정도: direct 직접 / partial 일부 / none 없음), basis(근거 ID 와 연결 이유), invented(가정으로 정한 부분)
export const CARDS = [
  {
    id: 'C01', title: '오늘은 버티지만 내일이 걱정되는 아침', short: '기본 장면',
    story: '자주 나가는 감기약이 전산상 8팩(선반과 창고 합계) 남았습니다. 하루 5팩 정도 나가니 오늘은 버티지만 내일은 모자랄 수 있습니다. 도매상은 지금 주문하면 내일 아침에 가져다주고, 몇 팩을 주문하든 팩당 1만원입니다.',
    test: '가장 기본이 되는 장면입니다. "오늘·내일을 버틸 수 있는가"와 "재고·구매대금 부담" 사이에서 약사가 몇 팩을 주문하는지 봅니다. 다른 카드는 모두 이 장면에서 조건 하나만 바꾼 것입니다.',
    support: 'direct',
    basis: [
      { ids: ['R02', 'E029'], why: '남은 약으로 오늘·내일을 감당할지 약사가 직접 판단한다고 말했습니다.' },
      { ids: ['R03', 'E034'], why: '개업 초기라 약품 구매대금 부담을 함께 고려한다고 말했습니다.' },
      { ids: ['E032', 'I05'], why: '실제로 재고가 아슬아슬했던 경험이 있다고 답했습니다.' },
    ],
    invented: '8팩, 하루 5팩, 팩당 1만원, 다음 날 입고는 모두 계산을 위한 가정입니다.',
    tags: ['할인 없음', '내일 입고'], cond: mk(D1),
  },
  {
    id: 'C02', title: '주문해도 모레에야 들어오는 날', short: '입고가 늦은 날',
    story: '기본 장면과 같습니다. 다만 도매상이 이번에는 이틀 뒤(모레 아침)에야 가져다줄 수 있다고 합니다. 그 사이 내일 하루는 손님을 다 받지 못할 수 있습니다.',
    test: '입고가 하루 늦어지는 것만 바꿨습니다. 약사가 "입고 전에 비는 하루"를 고려해 주문량을 바꾸는지 봅니다.',
    support: 'partial',
    basis: [
      { ids: ['E033', 'I06'], why: '유행기에는 주문처가 품절되어 보충이 막힐 수 있다고 말했습니다. 공급이 늦어지는 상황 자체는 인터뷰에 나옵니다.' },
      { ids: ['R02', 'E029'], why: '오늘·내일을 버틸지 판단하는 방식은 기본 장면과 같습니다.' },
    ],
    invented: '"이틀 뒤 입고"라는 구체적인 납기는 인터뷰에 없는 가정입니다.',
    tags: ['할인 없음', '모레 입고'], cond: mk(D2),
  },
  {
    id: 'C03', title: '10팩을 한 번에 사면 싸지는 날', short: '수량 할인이 있는 날',
    story: '기본 장면과 같습니다. 다만 도매상이 10팩을 한 번에 주문하면 팩당 9천원(10% 할인)에 준다고 합니다. 5팩만 주문하면 팩당 1만원 그대로입니다.',
    test: '단가 조건만 바꿨습니다. 기본 장면과 비교해 "대량 할인이 있으면 더 많이 주문하는가"를 따로 떼어 봅니다. 할인과 남는 재고의 부담이 맞서는 장면입니다.',
    support: 'partial',
    basis: [
      { ids: ['R03'], why: '무한정 미리 사두지는 못하지만, 회전이 높고 자금에 여유가 있으면 더 보유할 수 있다고도 설명했습니다.' },
      { ids: ['E035', 'R04'], why: '유효기간과 보관 공간 제약, 반품이 쉽지 않다는 점은 많이 사 두는 쪽의 부담입니다.' },
    ],
    invented: '"10팩 이상 팩당 9천원(10% 할인)"이라는 단가 구간은 가정입니다. 실제 할인 기준은 약국·약마다 다릅니다.',
    tags: ['10팩 할인', '내일 입고'], cond: mk(D1, { bulk: 9000 }),
  },
  {
    id: 'C04', title: '할인은 있지만 입고가 늦은 날', short: '수량 할인 + 입고 늦음',
    story: '도매상이 10팩을 한 번에 주문하면 팩당 9천원에 주지만, 모레 아침에야 가져다줄 수 있습니다.',
    test: '"입고가 늦은 날"에서 단가만, "수량 할인이 있는 날"에서 입고만 바꾼 카드입니다. 두 조건이 각각 판단을 어떻게 바꾸는지 짝지어 비교할 때 씁니다.',
    support: 'none',
    basis: [
      { ids: ['E033', 'R03'], why: '공급 지연과 재고 부담은 각각 인터뷰에 나오지만, 할인과 입고 지연이 겹친 상황은 나오지 않습니다.' },
    ],
    invented: '단가 구간과 이틀 뒤 입고는 모두 가정입니다.',
    tags: ['10팩 할인', '모레 입고'], cond: mk(D2, { bulk: 9000 }),
  },
  {
    id: 'C05', title: '전산에는 8팩, 실제 재고는 확인 전', short: '전산과 실물이 다를 수 있는 날',
    story: '전산에는 8팩(선반과 창고 합계)이 있다고 나오지만 사흘 전 기록입니다. 그동안 출고를 다 입력하지 못했을 수 있습니다. 선반과 창고를 직접 보기 전에는 실제로 몇 팩인지 모릅니다.',
    test: '약사가 "확인해 보겠다"고 말로만 하는지, 실제로 선반·창고부터 확인하는지 봅니다. 이 카드에서는 "실물 확인"을 하기 전까지 실제 재고가 숨겨져 있습니다.',
    support: 'direct',
    basis: [
      { ids: ['R01', 'E030'], why: '자주 나가는 약은 전산보다 보관 장소를 눈으로 확인하는 편이 빠르다고 말했습니다.' },
      { ids: ['E042', 'E043'], why: '모든 출고를 정확히 입력하기 어려워 전산과 실물의 오차가 쌓인다고 말했습니다.' },
    ],
    invented: '실제 재고 3팩(선반과 창고 합계)과 72시간 전 기록은 가정입니다.',
    tags: ['할인 없음', '내일 입고', '전산·실물 차이'], cond: mk(D1, { physical: 3, ageH: 72 }),
  },
  {
    id: 'C06', title: '어제 넣은 주문 5팩이 아직 안 온 날', short: '이미 주문해 둔 것이 있는 날',
    story: '기본 장면과 같습니다. 다만 어제 이미 5팩을 주문해 두었고, 그 물건이 내일 아침에 들어올 예정입니다.',
    test: '이미 넣어 둔 주문을 계산에 넣고 추가 주문을 줄이는지 봅니다. 전산 재고만 보고 판단하면 중복 주문이 생길 수 있습니다.',
    support: 'partial',
    basis: [
      { ids: ['E064'], why: '여러 거래처에 흩어진 공급 정보를 한눈에 보기 어렵다고 말했습니다. 이미 넣은 주문을 놓치기 쉬운 이유와 연결됩니다.' },
      { ids: ['R02', 'E029'], why: '오늘·내일을 버틸지 판단하는 방식은 기본 장면과 같습니다.' },
    ],
    invented: '기존 주문 5팩과 그 입고일은 가정입니다. 이런 상황에서 어떻게 했는지는 인터뷰에 직접 나오지 않습니다.',
    tags: ['할인 없음', '내일 입고', '기존 주문 5팩'], cond: mk(D1, { prior: true }),
  },
  // ---- 할인율 스윕 지점 (화면의 시나리오 목록에는 나오지 않는다. 0% = C01, 10% = C03) ----
  {
    id: 'S05', kind: 'sweep', title: '할인율 5%', short: '스윕 지점',
    story: '기본 장면에서 10팩 이상 주문할 때 팩당 9,500원(5% 할인)만 다릅니다.', test: '할인율이 몇 %부터 주문량을 바꾸는지 보는 스윕 지점입니다.',
    support: 'none', basis: [{ ids: ['R03'], why: '할인과 남는 재고의 부담이 맞서는 장면입니다.' }],
    invented: '할인 구간(10팩 이상)과 5%는 가정입니다.', tags: ['10팩 5% 할인'], cond: mk(D1, { bulk: 9500 }),
  },
  {
    id: 'S15', kind: 'sweep', title: '할인율 15%', short: '스윕 지점',
    story: '기본 장면에서 10팩 이상 주문할 때 팩당 8,500원(15% 할인)만 다릅니다.', test: '할인율 스윕 지점입니다.',
    support: 'none', basis: [{ ids: ['R03'], why: '할인과 남는 재고의 부담이 맞서는 장면입니다.' }],
    invented: '할인 구간(10팩 이상)과 15%는 가정입니다.', tags: ['10팩 15% 할인'], cond: mk(D1, { bulk: 8500 }),
  },
  {
    id: 'S20', kind: 'sweep', title: '할인율 20%', short: '스윕 지점',
    story: '기본 장면에서 10팩 이상 주문할 때 팩당 8,000원(20% 할인)만 다릅니다.', test: '할인율 스윕 지점입니다.',
    support: 'none', basis: [{ ids: ['R03'], why: '할인과 남는 재고의 부담이 맞서는 장면입니다.' }],
    invented: '할인 구간(10팩 이상)과 20%는 가정입니다.', tags: ['10팩 20% 할인'], cond: mk(D1, { bulk: 8000 }),
  },
  // ---- 평가용: 10/6 약사 응답에 없는 조합. 약사 답을 받은 적이 없어 AI 가 약사와 비슷한 방향인지 볼 때 쓴다 ----
  {
    id: 'E1', kind: 'eval', hypo: 'C03(할인만 있는 날)보다 같거나 줄어듭니다. 반품 불가가 더 사 두는 부담을 키우기 때문입니다. 다만 인터뷰는 반품을 피하려 한다는 것(R04)까지만 말해, 얼마나 줄지는 가정할 수 없습니다.', title: '할인은 있지만 반품이 안 되는 약', short: '할인 + 반품 불가',
    story: '도매상이 10팩 이상 주문하면 팩당 9천원(10% 할인)에 주지만, 이 약은 한 번 받으면 반품할 수 없습니다.',
    test: '할인(더 사는 이유)과 반품 불가(덜 사는 이유)가 맞서는 장면입니다. 10/6 응답에는 이 조합이 없습니다.',
    support: 'partial',
    basis: [
      { ids: ['R04', 'E038'], why: '반품을 쉽게 되돌릴 수 있는 선택으로 보지 않는다고 말했습니다.' },
      { ids: ['R03'], why: '할인과 남는 재고의 부담이 맞서는 장면입니다.' },
    ],
    invented: '반품 불가 설정과 할인 구간·할인율은 가정입니다.', tags: ['10팩 할인', '반품 불가'], cond: mk(D1, { bulk: 9000, ret: false }),
  },
  {
    id: 'E2', kind: 'eval', hypo: 'C03(할인만 있는 날)보다 같거나 줄어듭니다. 공간이 없으면 한꺼번에 많이 받기 어렵기 때문입니다(E035).', title: '할인은 있지만 창고가 거의 찬 상태', short: '할인 + 보관 공간 부족',
    story: '도매상이 10팩 이상 주문하면 팩당 9천원에 주지만, 창고가 거의 차 있어 한꺼번에 많이 들어오면 둘 곳이 마땅치 않습니다.',
    test: '할인과 보관 공간 부담이 맞서는 장면입니다. 10/6 응답에는 이 조합이 없습니다.',
    support: 'partial',
    basis: [
      { ids: ['E035'], why: '의약품 보유에는 유효기간과 보관 공간 제약이 있다고 말했습니다.' },
      { ids: ['R03'], why: '할인과 남는 재고의 부담이 맞서는 장면입니다.' },
    ],
    invented: '공간이 부족한 정도와 할인 구간·할인율은 가정입니다.', tags: ['10팩 할인', '창고 거의 참'], cond: mk(D1, { bulk: 9000, tight: true }),
  },
  {
    id: 'E3', kind: 'eval', hypo: 'C01(품절 조짐 없는 날)보다 늘어납니다. 품절을 피하려는 쪽이 자연스럽지만, 인터뷰에는 이 표시에 어떻게 반응하는지가 없어 가설입니다.', title: '도매 사이트에 "재고 부족 예정"이 뜬 날', short: '품절 조짐 (할인 없음)',
    story: '기본 장면과 같습니다. 다만 도매상 주문 사이트에 이 약이 "재고 부족 예정"으로 표시되어 있습니다. 언제 품절될지는 알 수 없습니다.',
    test: '품절 조짐이 주문량을 늘리는지 봅니다. 공급중단·부족 공개자료에서 감기 관련 품목은 약 2~3%로 드물어, 낮은 빈도의 별도 조건으로 둡니다. 독감과의 연동은 가설입니다.',
    support: 'partial',
    basis: [{ ids: ['E033', 'I06'], why: '유행기에 주문처 품절로 보충이 막힐 수 있다고 설명했습니다. 얼마나 자주인지는 인터뷰에 없습니다.' }],
    invented: '"재고 부족 예정" 표시와 그 의미는 가정입니다.', tags: ['할인 없음', '품절 조짐'], cond: mk(D1, { hint: true }),
  },
  {
    id: 'E4', kind: 'eval', hypo: 'C01(연휴 마감 없는 날)보다 같거나 늘어납니다. 연휴 전에 미리 받아 두려는 쪽이 자연스럽지만 인터뷰에 직접 근거는 없어 가설입니다.', title: '한글날 연휴 전 마지막 주문일', short: '연휴 전 도매 주문 마감',
    story: '기본 장면과 같습니다. 다만 한글날 연휴로 도매상이 쉬어서, 연휴 전 마지막 주문은 내일 오후까지이고 연휴 뒤 첫 도착은 10/12(월) 아침입니다.',
    test: '연휴 전에 미리 주문하는지, 수량이 늘어나는지 봅니다. 10/6 응답에는 이 상황이 없습니다.',
    support: 'none',
    basis: [{ ids: ['E033', 'R02'], why: '오늘·내일을 버틸지 판단하는 방식은 기본 장면과 같고, 도매 휴무는 인터뷰에 없습니다.' }],
    invented: '도매상 휴무일과 연휴 뒤 도착일은 가정입니다.', tags: ['할인 없음', '연휴 전 마감'], cond: mk(D1, { cutoff: true }),
  },
];

export const SUPPORT = {
  direct: { cls: 'interview', label: '인터뷰의 판단 방식을 쓴 장면' },
  partial: { cls: 'unknown', label: '인터뷰의 일부 요소만 쓴 장면' },
  none: { cls: 'hyp', label: '인터뷰에 없는 대조용 장면' },
};

CARDS.forEach((c) => { c.kind = c.kind || 'practice'; });
export const cardById = (id) => CARDS.find((c) => c.id === id);
export const KIND_KO = { practice: '연습용', eval: '평가용', sweep: '스윕용' };
/** 10/6 약사 응답에 T01, T02... 번호를 붙여 근거 칩으로 열 수 있게 한다 (번호 규칙은 scripts/run_persona.py 의 answer_items 와 같다) */
export function registerAnswerIds(rows) {
  let n = 0;
  rows.forEach((r) => {
    const text = [r.realism_ko, r.answer_ko].filter((x) => x && x.trim()).join(' / ');
    if (!text) return;
    const id = `T${String(++n).padStart(2, '0')}`;
    DB.byId.set(id, { kind: '10/6 통화 응답', id, title: r.question_ko || '원래 질문지에 대한 응답', quote: '', summary: text, type: '팀원이 정리해 전달한 답 (약사 직접 인용 아님)', where: '2026-10-06 통화' });
  });
}

export const PAIRS = [
  { a: 'C01', b: 'C03', changed: '수량 할인만 변경' },
  { a: 'C02', b: 'C04', changed: '수량 할인만 변경' },
  { a: 'C01', b: 'C02', changed: '입고일만 변경' },
  { a: 'C03', b: 'C04', changed: '입고일만 변경' },
];

// 평가용 카드(인터뷰 밖 인접 상황) 후보: 인터뷰가 이미 다룬 범위와 대조한 뒤 확정한다. 지금은 선택할 수 없다.
export const KIND2_CANDIDATES = [
  '긴 연휴 전 발주', '유효기간 임박 · 보관 공간 부족', '반품 불가 신제품 입점 제안', '인근 신규 약국 개업',
];

// 미충족, 기말재고, 구매약정. C01·C02·C05·C06 은 팀 참조팩 verification.json 의 보고값이다.
// C03·C04 는 수량 할인 카드로 바뀌어 팀 보고값이 아니라 같은 규칙으로 다시 계산한 값이다 (10팩 약정 90,000원).
export const EXPECTED = {
  C01: { Q_0: [7, 0, 0], Q_5: [2, 0, 50000], Q_10: [0, 3, 100000] },
  C02: { Q_0: [7, 0, 0], Q_5: [2, 0, 50000], Q_10: [2, 5, 100000] },
  C03: { Q_0: [7, 0, 0], Q_5: [2, 0, 50000], Q_10: [0, 3, 90000] },
  C04: { Q_0: [7, 0, 0], Q_5: [2, 0, 50000], Q_10: [2, 5, 90000] },
  C05: { Q_0: [12, 0, 0], Q_5: [7, 0, 50000], Q_10: [2, 0, 100000] },
  C06: { Q_0: [2, 0, 0], Q_5: [0, 3, 50000], Q_10: [0, 8, 100000] },
};

// ---------- 예시 응답 (실제 모델이 아니다) ----------
// 설명을 위해 사람이 미리 쓴 샘플이다. 약사의 답도, B1/P0 의 출력도 아니다. 근거 ID 는 실제 CSV 에 있는 것만 쓴다.
const CLAIM_STOCK = { ids: ['R01', 'E030'], claim: '자주 쓰는 품목은 전산보다 보관 장소를 눈으로 확인하는 편이 빠르다는 근거', inference: true };
const CLAIM_COVER = { ids: ['R02', 'E029'], claim: '남은 양으로 오늘과 내일을 버틸지 사람이 판단한다는 근거', inference: true };
const CLAIM_CASH = { ids: ['R03', 'E034'], claim: '개업 초기에는 약품 구매대금 부담을 함께 고려한다는 근거', inference: true };
const CLAIM_RETURN = { ids: ['R04', 'E038'], claim: '반품을 쉽게 되돌릴 수 있는 선택으로 보지 않는다는 근거', inference: true };
const CLAIM_SPACE = { ids: ['E035'], claim: '의약품 보유에는 유효기간과 보관 공간 제약이 있다는 근거', inference: true };

export const SAMPLES = {
  C01: [{ kind: 'commit_choice', q: 'Q_5', reason: '남은 약으로 오늘은 버티지만 내일은 어려울 수 있어 부족을 피하려 합니다. 다만 개업 초기 구매대금 부담과 반품이 쉽지 않다는 점 때문에 가장 많은 수량은 고르지 않았습니다.', claims: [CLAIM_COVER, CLAIM_CASH, CLAIM_RETURN], missing: ['실제 수요 추이', '실물 재고'] }],
  C02: [{ kind: 'commit_choice', q: 'Q_5', reason: '입고가 늦어져 일부 부족은 피하기 어렵다고 봅니다. 그래도 구매대금 부담과 반품 곤란을 고려해 중간 수량을 골랐습니다.', claims: [CLAIM_COVER, CLAIM_CASH, CLAIM_RETURN], missing: ['입고 지연 가능성', '실물 재고'] }],
  C03: [{ kind: 'commit_choice', q: 'Q_5', reason: '할인이 있어도 남는 재고의 유효기간과 공간 부담은 그대로라고 봅니다. 할인 폭과 남는 재고를 견줘 본 추론입니다.', claims: [CLAIM_COVER, CLAIM_SPACE, CLAIM_RETURN], missing: ['이 약의 실제 회전 속도'] }],
  C04: [{ kind: 'commit_choice', q: 'Q_5', reason: '입고가 늦는 점은 수량으로 되돌릴 수 없다고 봅니다. 할인보다 남는 재고 부담을 더 크게 본 추론입니다.', claims: [CLAIM_COVER, CLAIM_SPACE, CLAIM_RETURN], missing: ['이 약의 실제 회전 속도'] }],
  C05: [
    { kind: 'check_physical_stock', q: null, reason: '전산 기록이 72시간 전 값이라 먼저 선반과 창고를 확인하겠습니다.', claims: [CLAIM_STOCK, { ids: ['E042'], claim: '시간이 지나며 전산과 실물 재고 오차가 누적될 수 있다는 근거', inference: false }], missing: ['현재 실물 수량'] },
    { kind: 'commit_choice', q: 'Q_10', reason: '실물이 전산보다 훨씬 적은 것을 확인했으니 부족을 피하는 쪽으로 고릅니다.', claims: [CLAIM_COVER, CLAIM_CASH], missing: ['실제 수요 추이'] },
  ],
  C06: [{ kind: 'commit_choice', q: 'Q_0', reason: '내일 들어오는 기존 주문 5팩을 고려하면 당장 추가 주문 없이도 버틸 수 있다고 봅니다. 구매대금 부담과 반품 곤란을 함께 고려했습니다.', claims: [CLAIM_COVER, CLAIM_CASH, CLAIM_RETURN], missing: ['기존 주문의 입고 확정 여부'] }],
};

// 판단 단계에서 고를 수 있는 근거 후보 (CSV 에서 제목·문구를 읽어 보여 준다)
export const EVIDENCE_PICKS = ['R01', 'R02', 'R03', 'R04', 'E030', 'E029', 'E034', 'E038', 'E042', 'E035', 'E037'];

// ---------- 3D 장면 속 물건 설명 ----------
export const OBJ_INFO = {
  pharmacy: { title: '약국 (2층) · 조제실', tag: '인터뷰', body: '인터뷰 약국은 2층에 있고, 1층에는 정형외과, 같은 층에는 이비인후과가 있습니다. 개업 약 3주차입니다. 유리벽 안쪽이 조제실입니다. 내부 배치는 인터뷰에 없어 임의로 그렸습니다. 실제 건물 3층은 치과입니다(팀 정리본).', refs: ['E001', 'E002', 'E013'] },
  stock: { title: '재고 선반 · 판단 품목', tag: '가상', body: '카운터 뒤 선반에 판단에 쓰는 약 한 품목(종합감기약)을 보여 줍니다. 재고는 선반과 창고를 합친 수량입니다. 반투명 보라 상자는 전산 기록(관측값), 불투명 갈색 상자는 실물입니다. 실물은 "실물 확인"을 한 뒤에, 또는 결과 재생 중에 보입니다. 품목과 수량은 모두 가정입니다.', refs: ['E030', 'E042'] },
  persona: { title: '응답자 약사 (초록 명찰)', tag: '인터뷰', body: '인터뷰에 응한 약사 1명입니다. 조제실에 있습니다. 눌러서 프로필을 봅니다.', refs: ['U001', 'G07'] },
  counter: { title: '카운터 · 전산 모니터 · 다른 약사', tag: '인터뷰', body: '카운터 위 모니터는 약국 전산입니다. 약사와 AI에게 주는 관측값(전산 기록 재고 등)만 띄우고, 확인 전의 실제 재고는 띄우지 않습니다. 파란 명찰의 약사는 응답자가 아닌 다른 약사로, 이 사람의 판단·성향은 만들지 않습니다. 약사 2인 운영은 사용자 보완입니다.', refs: ['U001', 'G07'] },
  demand: { title: '이 약을 찾은 손님 (하루 수요)', tag: '가상', body: '카운터 앞 줄은 판단 품목을 찾은 손님입니다. 하루 수요 5팩을 5명으로 나타냈고, 상자를 든 인물은 사 간 손님, 흐린 인물은 재고가 없어 못 사고 간 손님입니다. 코드가 계산한 가상 결과이며 못 판 수요는 다음 날로 넘기지 않습니다.', refs: [] },
  customers: { title: '손님 흐름 (재생 중)', tag: '가상', body: '그날 약국에 온 손님을 움직임으로 보여 주는 연출입니다. 손님 수는 가상 데이터의 처방 건수(1층 의원·이비인후과)와 시간대별 워크인 수를 따르고, 인물 1명이 손님 약 2명입니다. 옷 색은 들어온 길, 나갈 때 발 아래 원은 기다린 시간에 따른 결과(만족·지연·이탈)입니다. 시간대 분포, 기다릴 수 있는 시간, 연령 비율, 마스크 비율은 가정입니다. 어린이는 보호자와 함께 다닙니다. 가상 데이터의 1층 처방은 "내과" 처방으로 만들어져 있어, 인터뷰의 1층 정형외과와 이름이 다릅니다. 이 연출은 판단 품목의 계산(하루 5팩)과 연결되지 않습니다.', refs: ['E012', 'E088', 'G02'] },
  goods: { title: '진열 상품', tag: '가상', body: '진열대의 다른 상품입니다. 품목·진열 위치·페이스 수는 가상 데이터(L56·L57)이며 위치는 인터뷰에 없는 임의 배치입니다. 색은 구분(초록 일반의약품, 보라 건강기능식품, 주황 의약외품, 회색 기타)입니다. 이번 발주 판단에는 쓰지 않습니다.', refs: ['R06', 'G02'] },
  sofa: { title: '대기 소파', tag: '인터뷰', body: '조제를 기다리는 자리입니다. 소파 근처에 둔 안마봉이 모두 팔렸다는 사례가 있습니다. 이번 발주 장면에는 쓰이지 않는 배경입니다.', refs: ['E053', 'I10'] },
  ent: { title: '이비인후과 (2층, 같은 층)', tag: '인터뷰', body: '같은 건물 신규 의원입니다. 재생 중에는 그날 이비인후과 처방 건수(가상)만큼 환자가 진료를 기다렸다가 약국으로 옵니다.', refs: ['E002', 'E003'] },
  ortho: { title: '정형외과 (1층)', tag: '인터뷰', body: '같은 건물 1층 정형외과입니다. 환자 유입이 기대보다 적었다는 사례가 있습니다.', refs: ['E002', 'I03', 'E017'] },
  across: { title: '건너편 기존 이비인후과', tag: '미반영', body: '기존 이비인후과가 쉬는 날 같은 건물 신규 의원이 붐빈다는 관찰입니다. 휴진 일정 데이터가 없어 지금은 반영하지 않습니다.', refs: ['E025', 'I04'] },
  nbph: { title: '옆 건물 약국', tag: '인터뷰', body: '기존 환자가 그대로 옆 건물 약국으로 가기도 한다는 발언에 나오는 약국입니다. 위치와 영업일은 연동 전이라 자리만 표시했습니다.', refs: ['E018'] },
  truck: { title: '도매 트럭 · 입고', tag: '가상', body: '주문한 약이 도착하는 날에 트럭이 건물 앞에 서고, 상자가 내려진 뒤 재고 선반이 채워집니다. 입고일과 단가는 가정입니다.', refs: [] },
};

// 3D 라벨 (장면에 겹쳐 보이는 짧은 이름). 위치는 app/design/building3d.js 의 ANCHORS 가 정한다.
export const SCENE_LABELS = [
  { key: 'pharmacy', text: '약국 · 2F', cls: 'real' },
  { key: 'ent', text: '이비인후과 · 2F', cls: 'real' },
  { key: 'ortho', text: '정형외과 · 1F', cls: 'real' },
  { key: 'persona', text: '응답자 약사', cls: 'real' },
  { key: 'stock', text: '재고 선반 (가상)', cls: 'virtual' },
  { key: 'across', text: '건너편 기존 이비인후과 (미반영)', cls: 'muted' },
  { key: 'truck', text: '도매 트럭 · 대기 (가상)', cls: 'virtual', at: [-40, 3.3, 9.2] },
];

// ---------- 니즈 카드 (근거는 CSV 의 실제 ID) ----------
export const NEEDS = [
  {
    id: 'N1', title: '전산 재고를 믿기 어려워 실물을 직접 본다',
    situation: '자주 쓰는 약은 전산 조회가 가능해도 보관 장소를 눈으로 보는 편이 빠르고, 시간이 지나면 전산과 실물의 오차가 쌓인다고 설명합니다.',
    workaround: '실물 위치를 직접 확인합니다. 현재 전산에는 사전 재고부족 알림이 없다고 답했습니다.',
    pain: '재고가 부족해질 시점을 사람이 판단해야 합니다.',
    refs: ['E030', 'E042', 'E028', 'E029', 'E063', 'E059'],
    frequency: '미확인', ax: '전산과 실물의 차이, 소진 속도를 함께 보여 주는 도구가 도움이 될 수 있다는 가설입니다.',
    conditions: ['기존 전산은 민간 유료 프로그램을 쓰고 있음(E059). 교체·연동 부담은 미확인.'],
  },
  {
    id: 'N2', title: '많이 사 두자니 대금이, 적게 사자니 결품이 걱정이다',
    situation: '유행기에는 주문처 자체가 품절될 수 있고, 수익이 나기 전이라 약값을 무한정 늘릴 수 없다고 설명합니다.',
    workaround: '남은 양으로 오늘·내일을 버틸지 사람이 판단합니다.',
    pain: '결품 손해와 구매대금 부담이 서로 맞바뀝니다.',
    refs: ['E033', 'E034', 'R03', 'I06'],
    frequency: '미확인', ax: '수요와 결제 일정을 함께 놓고 발주 규모를 비교해 보는 도구가 도움이 될 수 있다는 가설입니다.',
    conditions: ['I06은 설명용 가정 사례입니다. 실제 경험이 아닙니다.'],
  },
  {
    id: 'N3', title: '반품이 자유롭지 않아 유효기간과 공간이 부담이다',
    situation: '임박품 미반품, 반품 거절, 부분 환급 등 조건이 다양하고, 의약품에는 유효기간과 보관 공간의 제약이 있다고 설명합니다.',
    workaround: '반품을 쉽게 되돌릴 수 있는 선택으로 보지 않고 주문합니다.',
    pain: '과잉 재고가 손실로 이어질 수 있습니다.',
    refs: ['E038', 'E035', 'R04'],
    frequency: '미확인', ax: '유효기간과 반품 조건을 한눈에 보게 하는 도구가 도움이 될 수 있다는 가설입니다.',
    conditions: ['거래처마다 반품 조건이 다르다는 점은 확인됨. 구체적인 거래 구조는 미확인.'],
  },
  {
    id: 'N4', title: '운영 이력이 짧아 수요를 예측하기 어렵다',
    situation: '개업 초기라 수요가 많고 적은 날을 안정적으로 예측하기 어렵고, 충분한 운영 이력이 없다고 설명합니다.',
    workaround: '인터뷰에서 확인된 대처 방식은 없습니다. 재고가 부족해질 뻔한 경험이 있다고 답했습니다.',
    pain: '이력이 쌓이기 전에는 참고할 기준이 부족합니다.',
    refs: ['E027', 'E037', 'E032'],
    frequency: '미확인', ax: '이력이 쌓이기 전에 참고할 외부 수요 기준을 제공하는 방법이 있다는 가설입니다. 공공·민간 데이터는 장면 입력일 뿐 이 사람의 판단 근거가 아닙니다.',
    conditions: ['개업 초기라는 상태에서 나온 어려움일 수 있어, 시간이 지나면 달라질 수 있습니다.'],
  },
  {
    id: 'N5', title: '제안에 대한 반응: 수용·거부 조건',
    kind: 'suggestion',
    situation: '인터뷰어가 제안한 기능에 대한 반응입니다. 자동 상담 메모는 동의를 전제로 해야 한다는 우려를, 방문자 순위는 효용에 의문을 보였습니다.',
    workaround: '해당 없음(제안에 대한 반응).',
    pain: '자발적으로 말한 어려움이 아니므로 수요 증거로는 약합니다.',
    refs: ['I12', 'I13'],
    frequency: '해당 없음', ax: '수요의 증거가 아니라, 도입할 때 지켜야 할 조건으로 읽습니다.',
    conditions: ['수집 방식, 목적, 보관에 대한 동의가 수용 조건입니다.', '분석 정보의 실무 목적이 분명해야 효용을 인정합니다.'],
  },
];

// ---------- LLM(에이전트)이 하면 안 되는 것 ----------
export const DONTS = [
  ['숨은 실물 재고, 미래 수요, 선택별 결과, 정답에 접근하거나 요청하기', '정보 누출입니다. 모델에는 관측값만 줍니다.'],
  ['인터뷰·CSV에 없는 수량·비율·임계치를 만들기 (예: "1.5일 미만이면 긴급", "8~9일분")', 'G02. 이 값들은 가정입니다.'],
  ['규칙 사이의 우선순위를 임의로 완성하기', '인터뷰로 정해지지 않은 순서를 성향으로 확정하게 됩니다.'],
  ['시뮬레이션 출력을 사실로 말하거나 근거(claims)로 되먹이기', 'G04.'],
  ['약사 2인의 합의·권한·성향을 확정하기', 'G07. 응답자는 1명입니다.'],
  ['과거 직장·타약국 경험을 현재 약국의 판단으로 단정하기', 'G01.'],
  ['계획·의견("하려 한다", "좋을 수 있다")을 실행·결과("했다", "효과가 났다")로 서술하기', 'G06.'],
  ['의료·법률 발언을 자동 규칙으로 쓰거나 진단을 단정하기', 'G03.'],
  ['근거 ID를 지어내거나, 존재만 하는 ID를 주장에 붙이기', 'ID가 있어도 그 주장을 지원하는지는 별도 확인이 필요합니다. 실제 CSV 문구만 인용합니다.'],
  ['자기 설명을 "내부 사고과정"으로 표시하거나 수치 확신도·확률을 만들기', '모델 설명은 실제 영향 요인을 빠뜨릴 수 있습니다. 증거는 조회 기록입니다.'],
  ['니즈·AX 여지를 확인된 사실처럼 쓰기, 니즈를 묻기 전에 해결책을 제시하기', '해결책 편향이 생깁니다.'],
  ['인터뷰 약사를 소상공인·동네 약국 일반으로 일반화하기', '현재 근거는 인터뷰 1건입니다.'],
  ['가상 수치를 "가상" 표시 없이 쓰기', 'G02.'],
  ['팀원·인터뷰 대상자의 실명을 산출물에 쓰기', '인터뷰 전사본의 화자 표기에 실명이 있으므로 특히 주의합니다.'],
];
