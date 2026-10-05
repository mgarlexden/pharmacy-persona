// 발주 판단 장면의 상태 계산 (코드가 하는 일). LLM/사람의 판단과 분리되어 있다.
// 모든 수량·가격·날짜는 계산 검증용 가정이다 (docs/SIMULATION_GUIDE.md 3.1, 3.5).
// 팀 참조팩(reference_transition.py)의 규칙을 같은 방식으로 다시 구현한 것이며, 그 코드를 실행한 것은 아니다.

export const CAL = ['2026-10-06', '2026-10-07', '2026-10-08'];
export const AS_OF = '2026-10-06T08:50:00+09:00';
export const UNIT_COST = 10000;
export const LIMIT_KRW = 120000;
export const DEMAND = [5, 5, 5];
export const OFFER = { id: 'OFFER_A', supplier: 'DEMO_A', capacity: 10, unitCost: UNIT_COST, terms: 'credit', due: '2026-11-05' };
export const OPTIONS = [
  { id: 'Q_0', packs: 0, label: '보류 (0팩)' },
  { id: 'Q_5', packs: 5, label: '5팩 주문' },
  { id: 'Q_10', packs: 10, label: '10팩 주문' },
];
export const PRIOR_ORDER = { id: 'PRIOR_001', origin: 'preexisting', packs: 5, arrival: '2026-10-07', due: '2026-11-05', unitCost: UNIT_COST };

export const won = (n) => n.toLocaleString('ko-KR') + '원';
export const dayLabel = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;

/** 모델과 화면에 보여도 되는 값만 만든다. 실물 재고·미래 수요·선택별 결과는 넣지 않는다. */
export function buildObservation(c) {
  return {
    asOf: AS_OF,
    item: { id: 'DEMO_PACK_01', label: '가상 발주판단용 단일 품목', unit: 'pack' },
    stock: { book: c.book, ageH: c.ageH, status: 'not_checked' },
    recentUse: [5, 5, 5],
    cashKrw: c.cash,
    limitKrw: LIMIT_KRW,
    offer: { ...OFFER, arrival: c.arrival },
    knownUnreceived: c.prior ? [{ id: PRIOR_ORDER.id, packs: PRIOR_ORDER.packs, arrival: PRIOR_ORDER.arrival }] : [],
    options: OPTIONS,
    calendar: CAL,
  };
}

/** 실물 확인: 같은 판단 시점 안에서 결과를 공개한다. 시간·비용은 0으로 둔 단순화(가정). */
export function checkPhysical(obs, c) {
  return {
    ...obs,
    stock: { ...obs.stock, status: 'checked', physical: c.physical },
  };
}

export function constraints(c, qid) {
  const opt = OPTIONS.find((o) => o.id === qid);
  if (!opt) return [];
  const q = opt.packs;
  if (q === 0) {
    return [
      { id: 'none', label: '주문 없음', pass: true, detail: '구매약정과 채무가 생기지 않습니다.' },
    ];
  }
  const commit = q * UNIT_COST;
  return [
    { id: 'capacity', label: '공급 가능 수량', pass: q <= OFFER.capacity, detail: `${q}팩 ≤ ${OFFER.capacity}팩` },
    { id: 'limit', label: '추가 구매약정 한도', pass: commit <= LIMIT_KRW, detail: `${won(commit)} ≤ ${won(LIMIT_KRW)}` },
    { id: 'arrival', label: '입고일이 판단일 이후', pass: c.arrival > CAL[0], detail: `입고 ${dayLabel(c.arrival)}, 판단 ${dayLabel(CAL[0])}` },
    { id: 'due', label: '결제일이 3일 관찰기간 밖', pass: OFFER.due > CAL[2], detail: `결제 ${dayLabel(OFFER.due)} (관찰 ${dayLabel(CAL[0])}~${dayLabel(CAL[2])})` },
  ];
}

/** 선택 하나를 적용해 3일을 한 번 진행한다. 제약을 어기면 자르지 않고 오류를 돌려준다.
    demand: 날짜별 수요(팩). 기본은 카드 가정값 [5,5,5] 이고, 팀 검증표도 이 값으로 맞춘다. */
export function runBranch(c, qid, demand = DEMAND) {
  const opt = OPTIONS.find((o) => o.id === qid);
  if (!opt) return { error: '알 수 없는 선택지입니다.' };
  const failed = constraints(c, qid).filter((x) => !x.pass);
  if (failed.length) return { error: `제약 위반: ${failed.map((f) => f.label).join(', ')}` };

  const q = opt.packs;
  const orders = c.prior ? [{ ...PRIOR_ORDER }] : [];
  if (q > 0) {
    orders.push({ id: 'CURRENT', origin: 'current', packs: q, arrival: c.arrival, due: OFFER.due, unitCost: UNIT_COST });
  }
  // 각 주문은 입고 통지 1건을 만든다. 기존 주문은 같은 통지가 한 번 더 온다 (중복 방지 확인용).
  const notices = orders.map((o) => ({ id: o.id, date: o.arrival }));
  if (c.prior) notices.push({ id: PRIOR_ORDER.id, date: PRIOR_ORDER.arrival });

  let stock = c.physical;
  const received = new Set();
  const payables = [];
  const ledger = [];
  let dupIgnored = 0;
  if (q > 0) ledger.push({ date: CAL[0], event: '구매약정 수락', packs: q, amountKrw: q * UNIT_COST });
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
      newCommitKrw: q * UNIT_COST,
      newPayableKrw: sum(payables.filter((p) => p.origin === 'current').map((p) => p.amountKrw)),
      priorPayableKrw: sum(payables.filter((p) => p.origin === 'preexisting').map((p) => p.amountKrw)),
    },
  };
}

export function runAll(c, demand = DEMAND) {
  return OPTIONS.map((o) => runBranch(c, o.id, demand));
}
