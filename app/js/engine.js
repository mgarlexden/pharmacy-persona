// 발주 판단 장면의 상태 계산 (코드가 하는 일). LLM/사람의 판단과 분리되어 있다.
// 모든 수량·가격·날짜는 계산 검증용 가정이다 (docs/SIMULATION_GUIDE.md 3.1, 3.5).
// 10/6 통화 뒤 조정: 통장 잔액·외상 한도는 판단 조건에서 뺐고, 수량별 단가(대량 할인)를 넣었다. 재고는 선반+창고 합계다.
// 참고: 대한약사회 약국업무 매뉴얼(2024.02) 247~248쪽 재고관리 — 적게 두면 수요에 대응하지 못하고, 많이 두면 공간·반품이 문제가 된다. 계산식은 없다.
// 팀 참조팩(reference_transition.py)의 규칙을 같은 방식으로 다시 구현한 것이며, 그 코드를 실행한 것은 아니다.

export const CAL = ['2026-10-06', '2026-10-07', '2026-10-08'];
export const AS_OF = '2026-10-06T08:50:00+09:00';
export const UNIT_COST = 10000;
export const CAPACITY_NOTE = '최대 수량을 10에서 20으로 올렸다: 10이 선택의 상한이라 AI 답이 10으로 몰렸다.';
export const BULK_MIN = 10; // 이 수량 이상을 한 번에 주문하면 카드의 bulk 단가를 쓴다 (가정)
export const DEMAND = [5, 5, 5];
export const OFFER = { id: 'OFFER_A', supplier: 'DEMO_A', capacity: 20, unitCost: UNIT_COST, terms: 'credit', due: '2026-11-05' };
// 참고용 세 가지(기본 보기의 표). AI 의 선택은 0~OFFER.capacity 사이 어떤 정수여도 된다.
export const OPTIONS = [
  { id: 'Q_0', packs: 0, label: '보류 (0팩)' },
  { id: 'Q_5', packs: 5, label: '5팩 주문' },
  { id: 'Q_10', packs: 10, label: '10팩 주문' },
];
const packsOf = (q) => (typeof q === 'number' ? q : OPTIONS.find((o) => o.id === q)?.packs ?? (/^Q_(\d+)$/.test(q) ? Number(q.slice(2)) : null));
export const STRATEGY_KO = { need_only: '필요한 만큼만', fill_discount: '할인 구간까지', other: '그 밖' };
export const PRIOR_ORDER = { id: 'PRIOR_001', origin: 'preexisting', packs: 5, arrival: '2026-10-07', due: '2026-11-05', unitCost: UNIT_COST };

export const won = (n) => n.toLocaleString('ko-KR') + '원';
/** 이번 주문의 팩당 단가. 카드에 수량 할인(bulk)이 있고 BULK_MIN 이상이면 할인 단가 */
export const unitCostFor = (c, q) => (c.bulk && q >= BULK_MIN ? c.bulk : UNIT_COST);
export const discountPct = (c) => (c.bulk ? Math.round((1 - c.bulk / UNIT_COST) * 100) : 0);
/** 재고 위치 = 보유(선반+창고) + 이미 넣은 주문. checked 면 실제 재고, 아니면 전산 기록 */
export const positionOf = (c, checked = false) => (checked ? c.physical : c.book) + (c.prior ? PRIOR_ORDER.packs : 0);

/** 교과서 기준선 B0 (AI 에게는 숨긴다. 정답이 아니라 비교 기준이다).
 *  주기 점검: 목표재고 S = d×(R+L) + SS,  필요량 g = max(0, S − 재고 위치).
 *  d 하루 5팩 (카드 가정), R 점검 주기 1일, L 주문부터 입고까지 일수(카드의 입고일 − 판단일), SS 안전재고 2팩.
 *  R·SS 와 d 는 설명용 가정이고 값을 바꾸면 기준선도 바뀐다. 재고 위치는 확인한 실제 재고로 계산한다(교과서는 재고를 안다고 본다).
 *  할인이 있으면 보유비용을 무시할 만큼 회전이 빠르다고 보고(이 수요에서는 10팩이 이틀 안에 소진) 할인 구간까지 채우는 값도 같이 낸다.
 *  반품 가능 여부, 보관 공간, 품절 조짐은 이 공식에 들어 있지 않다. 그 조건들에서 AI 가 B0 와 달라지는지를 보는 것이 평가용 카드의 목적이다. */
export const B0_PARAM = { d: 5, R: 1, SS: 2 };
export function b0(c) {
  const { d, R, SS } = B0_PARAM;
  const L = Math.round((Date.parse(c.arrival) - Date.parse(CAL[0])) / 86400000);
  const target = d * (R + L) + SS;
  const pos = positionOf(c, true);
  const need = Math.min(OFFER.capacity, Math.max(0, target - pos));
  const withTier = c.bulk && need < BULK_MIN ? BULK_MIN : need;
  return { d, R, L, SS, target, pos, need, withTier };
}
export const dayLabel = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;

/** 모델과 화면에 보여도 되는 값만 만든다. 실물 재고·미래 수요·선택별 결과는 넣지 않는다. */
export function buildObservation(c) {
  return {
    position: positionOf(c),
    options: { qtyRange: [0, OFFER.capacity], strategies: Object.keys(STRATEGY_KO) },
    asOf: AS_OF,
    item: { id: 'DEMO_PACK_01', label: '종합감기약(정제 10정/갑, 1팩=3갑)', unit: 'pack' },
    stock: { book: c.book, ageH: c.ageH, scope: 'shelf+storage', status: 'not_checked' },
    recentUse: [5, 5, 5],
    offer: { ...OFFER, arrival: c.arrival, priceTiers: c.bulk ? [{ minPacks: 1, unitCost: UNIT_COST }, { minPacks: BULK_MIN, unitCost: c.bulk }] : [{ minPacks: 1, unitCost: UNIT_COST }] },
    knownUnreceived: c.prior ? [{ id: PRIOR_ORDER.id, packs: PRIOR_ORDER.packs, arrival: PRIOR_ORDER.arrival }] : [],
    calendar: CAL,
  };
}

/** 실물 확인(선반·창고): 같은 판단 시점 안에서 결과를 공개한다. 시간·비용은 0으로 둔 단순화(가정). */
export function checkPhysical(obs, c) {
  return {
    ...obs,
    stock: { ...obs.stock, status: 'checked', physical: c.physical },
  };
}

export function constraints(c, qid) {
  const q = packsOf(qid);
  if (q == null || q < 0) return [];
  if (q === 0) {
    return [
      { id: 'none', label: '주문 없음', pass: true, detail: '구매약정과 채무가 생기지 않습니다.' },
    ];
  }
  return [
    { id: 'capacity', label: '공급 가능 수량', pass: q <= OFFER.capacity, detail: `${q}팩 ≤ ${OFFER.capacity}팩` },
    { id: 'arrival', label: '입고일이 판단일 이후', pass: c.arrival > CAL[0], detail: `입고 ${dayLabel(c.arrival)}, 판단 ${dayLabel(CAL[0])}` },
    { id: 'due', label: '결제일이 3일 관찰기간 밖', pass: OFFER.due > CAL[2], detail: `결제 ${dayLabel(OFFER.due)} (관찰 ${dayLabel(CAL[0])}~${dayLabel(CAL[2])})` },
  ];
}

/** 선택 하나를 적용해 3일을 한 번 진행한다. 제약을 어기면 자르지 않고 오류를 돌려준다.
    demand: 날짜별 수요(팩). 기본은 카드 가정값 [5,5,5] 이고, 팀 검증표도 이 값으로 맞춘다. */
export function runBranch(c, qid, demand = DEMAND) {
  const q = packsOf(qid);
  if (q == null || q < 0) return { error: '알 수 없는 선택지입니다.' };
  const failed = constraints(c, qid).filter((x) => !x.pass);
  if (failed.length) return { error: `제약 위반: ${failed.map((f) => f.label).join(', ')}` };

  const unit = unitCostFor(c, q);
  const orders = c.prior ? [{ ...PRIOR_ORDER }] : [];
  if (q > 0) {
    orders.push({ id: 'CURRENT', origin: 'current', packs: q, arrival: c.arrival, due: OFFER.due, unitCost: unit });
  }
  // 각 주문은 입고 통지 1건을 만든다. 기존 주문은 같은 통지가 한 번 더 온다 (중복 방지 확인용).
  const notices = orders.map((o) => ({ id: o.id, date: o.arrival }));
  if (c.prior) notices.push({ id: PRIOR_ORDER.id, date: PRIOR_ORDER.arrival });

  let stock = c.physical;
  const received = new Set();
  const payables = [];
  const ledger = [];
  let dupIgnored = 0;
  if (q > 0) ledger.push({ date: CAL[0], event: '구매약정 수락', packs: q, amountKrw: q * unit });
  const timeline = CAL.map((date, i) => {
    const opening = stock;
    let delivered = 0;
    notices.filter((n) => n.date === date).forEach((n) => {
      if (received.has(n.id)) { dupIgnored += 1; return; }
      received.add(n.id);
      const o = orders.find((x) => x.id === n.id);
      delivered += o.packs;
      payables.push({ order: o.id, origin: o.origin, recognized: date, due: o.due, amountKrw: o.packs * o.unitCost });
      ledger.push({ date, event: '입고 · 매입채무 인식', packs: o.packs, amountKrw: o.packs * o.unitCost, due: o.due });
    });
    const available = opening + delivered;
    const want = demand[i] ?? DEMAND[i];
    const fulfilled = Math.min(available, want);
    const unmet = want - fulfilled;
    stock = available - fulfilled;
    return { i: i + 1, date, opening, received: delivered, demand: want, fulfilled, unmet, closing: stock };
  });
  const sum = (arr) => arr.reduce((a, b) => a + b, 0);
  return {
    qid, packs: q, timeline, payables, ledger, dupIgnored,
    unreceived: orders.filter((o) => !received.has(o.id)),
    metrics: {
      unmetTotal: sum(timeline.map((t) => t.unmet)),
      endingPacks: stock,
      endingValueKrw: stock * UNIT_COST,
      newCommitKrw: q * unit,
      unitCostKrw: q > 0 ? unit : null,
      newPayableKrw: sum(payables.filter((p) => p.origin === 'current').map((p) => p.amountKrw)),
      priorPayableKrw: sum(payables.filter((p) => p.origin === 'preexisting').map((p) => p.amountKrw)),
    },
  };
}

export function runAll(c, demand = DEMAND, qtys = OPTIONS.map((o) => o.packs)) {
  return qtys.map((q) => runBranch(c, q, demand));
}
