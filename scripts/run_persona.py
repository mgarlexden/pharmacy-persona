#!/usr/bin/env python
"""페르소나(AI)에게 상황 카드를 풀게 하고 결과를 runs/ 에 파일로 저장한다.

층(layer)
  B1  개인 근거 없는 일반 약사. 인터뷰 자료를 보내지 않는다.
  P0  B1 + 인터뷰 근거(profile/claims/rules/cases/guardrails). 같은 자료를 캐시해서 재사용한다.
  (P1, P2 는 공공·민간 데이터, 타 약사 데이터가 준비된 뒤 추가한다.)

실행 방식
  sync   한 건씩 바로 호출 (개발·확인용, 기본 모델 dev=Haiku)
  batch  Message Batches API 로 한꺼번에 제출 (실제 비교 실행, 기본 모델 run=Sonnet). 결과는 몇 분~몇 시간 뒤에 온다.

보내는 것: 카드의 '보이는 정보' 표와 data/1_interview 의 정리된 CSV(실명 없음). 전사 원문, 약사 응답 원본은 보내지 않는다.
시뮬레이션 출력은 사실이 아니다. runs/ 는 data/ 와 분리되어 있고 claims 로 되먹이지 않는다 (G04).

예)
  python scripts/run_persona.py --dry-run                       # 요청 수와 토큰만 계산 (호출 비용 없음)
  python scripts/run_persona.py --mode sync --cards C01 --layers P0 --reps 1 --yes
  python scripts/run_persona.py --mode batch --model run --yes  # 6장 x 2층 x 3회
"""
import argparse
import csv
import datetime as dt
import hashlib
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for _s in (sys.stdout, sys.stderr):  # Windows 콘솔(cp949/cp1252)에서 한글이 깨지거나 오류가 나지 않게
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
DATA = ROOT / "data" / "1_interview"
RUNS = ROOT / "runs"
CFG = json.loads((ROOT / "scripts" / "persona_config.json").read_text(encoding="utf-8"))


def load_dotenv():
    """저장소 루트의 .env 에서 KEY=값 줄을 읽어 환경변수로 넣는다. .env 는 .gitignore 대상이다.
    이미 설정된 환경변수보다 .env 가 우선한다 (잘못된 키가 환경에 남아 있어도 .env 로 덮어쓸 수 있게)."""
    p = ROOT / ".env"
    if not p.exists():
        return
    for line in p.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip().strip('"').strip("'")
        if v:
            os.environ[k.strip()] = v


load_dotenv()

# ---------------------------------------------------------------- 카드 (모든 수치는 가정)
# app/js/data.js 의 CARDS 와 같은 값이다. 한쪽을 바꾸면 다른 쪽도 바꾼다 (--check-cards 로 대조).
CAL = ["10/6", "10/7", "10/8"]
UNIT_COST, LIMIT_KRW, CAPACITY, DUE = 10000, 120000, 10, "11/5"
CARDS = {
    "C01": dict(cash=60000, arrival="10/7", book=8, physical=8, ageH=12, prior=False),
    "C02": dict(cash=60000, arrival="10/8", book=8, physical=8, ageH=12, prior=False),
    "C03": dict(cash=600000, arrival="10/7", book=8, physical=8, ageH=12, prior=False),
    "C04": dict(cash=600000, arrival="10/8", book=8, physical=8, ageH=12, prior=False),
    "C05": dict(cash=60000, arrival="10/7", book=8, physical=3, ageH=72, prior=False),
    "C06": dict(cash=60000, arrival="10/7", book=8, physical=8, ageH=12, prior=True),
}
ACTIONS_R1 = ["check_physical_stock", "commit_choice", "defer"]
ACTIONS_R2 = ["commit_choice", "defer"]
LAYERS = ["B1", "P0"]


def won(n):
    return f"{n:,}원"


def observation_text(c, checked_physical=None):
    """약사와 AI 에게 똑같이 보여 주는 정보. 확인 전의 실제 재고, 앞으로의 손님 수, 선택별 결과는 넣지 않는다."""
    if checked_physical is None:
        stock = f"전산 기록 {c['book']}팩 ({c['ageH']}시간 전 기록). 실제 선반 재고는 아직 확인하지 않았다."
    else:
        stock = f"전산 기록 {c['book']}팩 ({c['ageH']}시간 전 기록). 선반을 확인했고 실제로는 {checked_physical}팩이다."
    prior = "5팩, 10/7 아침 도착 예정 (이미 넣어 둔 주문)" if c["prior"] else "없음"
    return "\n".join([
        f"- 언제: {CAL[0]} 아침 8시 50분, 문 열기 전",
        "- 어떤 약: 가상 발주판단용 단일 품목, 팩 단위",
        f"- 남은 재고: {stock}",
        "- 최근 판매량: 사흘 내내 하루 5팩",
        f"- 통장 잔액: {won(c['cash'])} (판단할 때 참고하는 사정이며 약국 전체 현금이 아니다)",
        f"- 외상 주문 한도: {won(LIMIT_KRW)} (통장 잔액과 별개로 이번에 후불로 더 주문할 수 있는 금액)",
        f"- 도매상 조건: 팩당 {won(UNIT_COST)}, 최대 {CAPACITY}팩, {c['arrival']} 아침 문 열기 전 도착, 대금은 {DUE}에 결제",
        f"- 이미 넣은 주문: {prior}",
        "- 고를 수 있는 것: 선반 확인 / 보류(0팩) / 5팩 주문 / 10팩 주문 / 판단 유보",
    ])


# ---------------------------------------------------------------- 인터뷰 자료
def read_csv(name):
    with open(DATA / name, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def load_db():
    db = dict(
        claims=read_csv("claims.csv"), rules=read_csv("rules.csv"), cases=read_csv("cases.csv"),
        guardrails=read_csv("guardrails.csv"), profile=read_csv("persona_profile.csv"),
    )
    ids = {r["claim_id"] for r in db["claims"]} | {r["rule_id"] for r in db["rules"]} \
        | {r["case_id"] for r in db["cases"]} | {r["guardrail_id"] for r in db["guardrails"]}
    db["ids"] = ids
    return db


def interview_package(db):
    """P0 에서만 보낸다. 모두 정리된 문장이며 source_location, 전사 원문은 넣지 않는다."""
    out = ["# 인터뷰 근거 (판단 대상 약사 1명)", "", "## 프로필"]
    for r in db["profile"]:
        if r["kind"] == "fact":
            out.append(f"- {r['summary_ko']}: {r['value']}{r['unit'] if r['unit'] != 'date' else ''}")
        else:
            out.append(f"- [{r['section_ko']}] {r['summary_ko']} — {r['detail_ko']}")
    out += ["", "## 발언 (E###)  형식: ID | 주제 | 해당 범위 | 유형 | 원문 일부 | 요약"]
    for r in db["claims"]:
        out.append(f"{r['claim_id']} | {r['topic_ko']} | {r['applies_to']} | {r['record_type']} | {r['quote_ko']} | {r['summary_ko']}")
    out += ["", "## 규칙 (R##)  형식: ID | 제목 | 상황 | 고려한 정보 | 판단 | 읽을 때 주의"]
    for r in db["rules"]:
        out.append(f"{r['rule_id']} | {r['title_ko']} | {r['situation_ko']} | {r['info_considered_ko']} | {r['judgement_ko']} | {r['reading_note_ko']}")
    out += ["", "## 사례 (I##)  형식: ID | 제목 | 해당 범위 | 상황 | 대응 | 결과 | 배운 점"]
    for r in db["cases"]:
        out.append(f"{r['case_id']} | {r['title_ko']} | {r['applies_to']} | {r['situation_ko']} | {r['response_ko']} | {r['outcome_ko']} | {r['learning_ko']}")
    out += ["", "## 주의 규칙 (G##)  이 근거를 쓸 때 반드시 지킨다"]
    for r in db["guardrails"]:
        out.append(f"{r['guardrail_id']} | {r['rule_ko']} | 처리: {r['handling_ko']} | 구별: {r['distinguish_ko']}")
    return "\n".join(out)


SYSTEM_COMMON = """당신은 한국의 동네 약국에서 약품 주문(발주)을 판단하는 약사 역할을 한다. 아래 '관측값'에 보이는 정보만으로 판단한다.

규칙
- 관측값에 없는 값(확인 전의 실제 재고, 앞으로 올 손님 수, 선택별 결과)은 모른다. 추측한 숫자를 사실처럼 쓰지 않는다.
- 선택지는 정해져 있다: 선반 확인(check_physical_stock), 보류 0팩·5팩 주문·10팩 주문(commit_choice), 판단 유보(defer).
- 선반 확인은 한 번만 할 수 있다. 확인하면 실제 재고가 공개되고 다시 판단한다.
- reason 은 2~4문장으로 쓴다. priorities 는 가장 중요하게 본 것 두 가지를 짧은 문구로 쓴다.
- 반드시 submit_decision 도구로 답한다."""

SYSTEM_B1 = """

이 판단에는 특정 약사에 대한 개인 자료가 주어지지 않는다. 일반적인 약사의 상식으로 판단하고 cited_ids 는 빈 배열로 둔다."""

SYSTEM_P0 = """

아래 '인터뷰 근거'는 판단 대상인 약사 1명을 인터뷰해 정리한 것이다. 이 약사가 말한 판단 방식과 제약을 따른다.
- 근거로 삼은 ID(E###, R##, I##)를 cited_ids 에 적는다. 목록에 없는 ID 를 만들지 않는다.
- 인터뷰가 직접 말하지 않은 수량 기준이나 임계값을 만들어 내지 않는다. 이번 상황에 적용한 추론이면 reason 에 '추론'이라고 밝힌다.
- '과거 근무처'나 '다른 약국'으로 표시된 내용을 현재 약국의 판단 근거로 단정하지 않는다.
- 주의 규칙(G01~G07)을 지킨다."""


def tool_schema(actions):
    return {
        "name": "submit_decision",
        "description": "관측값을 보고 내린 판단을 제출한다.",
        "input_schema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": actions, "description": "첫 행동 또는 최종 선택"},
                "qty_packs": {"type": "integer", "enum": [0, 5, 10], "description": "action 이 commit_choice 일 때만. 보류는 0"},
                "reason": {"type": "string", "description": "2~4문장"},
                "priorities": {"type": "array", "items": {"type": "string"}, "maxItems": 2, "description": "가장 중요하게 본 것 두 가지"},
                "cited_ids": {"type": "array", "items": {"type": "string"}, "description": "근거 ID. 개인 자료가 없으면 빈 배열"},
                "missing_info": {"type": "array", "items": {"type": "string"}, "description": "더 알고 싶은 정보"},
            },
            "required": ["action", "reason", "priorities", "cited_ids", "missing_info"],
        },
    }


def build_params(model, layer, card_id, rnd, prev, pkg):
    c = CARDS[card_id]
    system = [{"type": "text", "text": SYSTEM_COMMON + (SYSTEM_P0 if layer == "P0" else SYSTEM_B1)}]
    if layer == "P0":
        # 모든 요청이 같은 앞부분을 가지므로 캐시한다 (최소 길이를 넘는 경우에만 효과가 있다).
        system.append({"type": "text", "text": pkg, "cache_control": {"type": "ephemeral"}})
    if rnd == 1:
        user = "관측값\n" + observation_text(c) + "\n\n어떻게 하시겠습니까? submit_decision 으로 답하세요."
        actions = ACTIONS_R1
    else:
        user = ("관측값\n" + observation_text(c, c["physical"]) +
                f"\n\n처음 판단에서 선반 확인을 택했습니다. 그때 이유: {prev['reason']}\n"
                "이제 확인한 실제 재고를 반영해 최종 선택을 하세요. (보류·5팩·10팩 주문 중 하나이거나 판단 유보) submit_decision 으로 답하세요.")
        actions = ACTIONS_R2
    return dict(model=model, max_tokens=CFG["max_tokens"], system=system,
                messages=[{"role": "user", "content": user}],
                tools=[tool_schema(actions)], tool_choice={"type": "tool", "name": "submit_decision"})


# ---------------------------------------------------------------- 검증과 집계
def validate(step, layer, db, rnd):
    flags = []
    a = step.get("action")
    allowed = ACTIONS_R1 if rnd == 1 else ACTIONS_R2
    if a not in allowed:
        flags.append("action_not_allowed")
    if a == "commit_choice" and step.get("qty_packs") not in (0, 5, 10):
        flags.append("invalid_qty")
    ids = step.get("cited_ids") or []
    unknown = [i for i in ids if i not in db["ids"] and i != "U001"]
    if unknown:
        flags.append("unknown_ids:" + ",".join(unknown))
    if layer == "B1" and ids:
        flags.append("ids_given_without_interview")
    if layer == "P0" and a == "commit_choice" and not ids:
        flags.append("no_evidence_cited")
    if len(step.get("priorities") or []) != 2:
        flags.append("priorities_not_two")
    return flags


def parse_message(msg):
    """tool_use 블록에서 입력을 꺼낸다. 없으면 None."""
    for b in msg.content:
        if getattr(b, "type", "") == "tool_use":
            return dict(b.input)
    return None


def usage_of(msg):
    u = msg.usage
    return dict(input=u.input_tokens, output=u.output_tokens,
                cache_write=getattr(u, "cache_creation_input_tokens", 0) or 0,
                cache_read=getattr(u, "cache_read_input_tokens", 0) or 0)


def sum_usage(items):
    t = dict(input=0, output=0, cache_write=0, cache_read=0)
    for u in items:
        for k in t:
            t[k] += u.get(k, 0)
    return t


def est_cost(usage, model, batch):
    p = CFG.get("prices_per_million_usd", {}).get(model)
    if not p:
        return None
    d = p.get("batch_discount", 0.5) if batch else 1.0
    m = 1_000_000
    return d * (usage["input"] * p["input"] + usage["output"] * p["output"]
                + usage["cache_write"] * p.get("cache_write", p["input"] * 1.25)
                + usage["cache_read"] * p.get("cache_read", p["input"] * 0.1)) / m


def finalize(task, steps, layer, db, model):
    flags = []
    for s in steps:
        flags += [f"r{s['round']}:{f}" for f in s["flags"]]
    last = steps[-1]
    return dict(card=task[0], layer=layer, rep=task[2], model=model, steps=steps,
                first_action=steps[0].get("action"), final_action=last.get("action"),
                qty_packs=last.get("qty_packs") if last.get("action") == "commit_choice" else None,
                flags=flags, usage=sum_usage([s["usage"] for s in steps]))


def consistency(results):
    out = {}
    for r in results:
        k = f"{r['card']}|{r['layer']}"
        d = out.setdefault(k, dict(first_action={}, final={}, n=0))
        d["n"] += 1
        d["first_action"][r["first_action"]] = d["first_action"].get(r["first_action"], 0) + 1
        fin = r["final_action"] if r["qty_packs"] is None else f"commit_{r['qty_packs']}"
        d["final"][fin] = d["final"].get(fin, 0) + 1
    return out


# ---------------------------------------------------------------- 실행
def make_client():
    import anthropic
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY 환경변수가 없습니다. 키는 환경변수로만 넣고 저장소에는 두지 않습니다.")
    return anthropic.Anthropic()


def run_sync(client, model, tasks, layers_pkg, db):
    def one(task):
        card, layer, rep = task
        pkg = layers_pkg.get(layer)
        steps = []
        p1 = build_params(model, layer, card, 1, None, pkg)
        m1 = client.messages.create(**p1)
        d1 = parse_message(m1) or {"action": "none", "reason": "", "priorities": [], "cited_ids": [], "missing_info": []}
        steps.append(dict(round=1, **d1, usage=usage_of(m1), stop=m1.stop_reason, flags=validate(d1, layer, db, 1)))
        if d1.get("action") == "check_physical_stock":
            p2 = build_params(model, layer, card, 2, d1, pkg)
            m2 = client.messages.create(**p2)
            d2 = parse_message(m2) or {"action": "none", "reason": "", "priorities": [], "cited_ids": [], "missing_info": []}
            steps.append(dict(round=2, **d2, usage=usage_of(m2), stop=m2.stop_reason, flags=validate(d2, layer, db, 2)))
        print(f"  {card} {layer} #{rep}: {' → '.join(str(s.get('action')) + (':' + str(s.get('qty_packs')) if s.get('qty_packs') is not None else '') for s in steps)}", flush=True)
        return finalize(task, steps, layer, db, model)
    with ThreadPoolExecutor(max_workers=CFG["sync_concurrency"]) as ex:
        return list(ex.map(one, tasks))


def submit_and_wait(client, requests):
    batch = client.messages.batches.create(requests=requests)
    print(f"  배치 제출: {batch.id} ({len(requests)}건)", flush=True)
    while True:
        b = client.messages.batches.retrieve(batch.id)
        c = b.request_counts
        print(f"  상태 {b.processing_status}: 처리중 {c.processing} 성공 {c.succeeded} 오류 {c.errored} 취소 {c.canceled} 만료 {c.expired}", flush=True)
        if b.processing_status == "ended":
            break
        time.sleep(CFG["batch_poll_seconds"])
    got = {}
    for e in client.messages.batches.results(batch.id):
        got[e.custom_id] = e.result.message if e.result.type == "succeeded" else None
    return batch.id, got


def run_batch(client, model, tasks, layers_pkg, db):
    cid = lambda t, r: f"{t[0]}__{t[1]}__r{t[2]}__s{r}"
    req1 = [dict(custom_id=cid(t, 1), params=build_params(model, t[1], t[0], 1, None, layers_pkg.get(t[1]))) for t in tasks]
    bid1, got1 = submit_and_wait(client, req1)
    steps = {}
    need2 = []
    for t in tasks:
        m = got1.get(cid(t, 1))
        d = (parse_message(m) if m else None) or {"action": "none", "reason": "", "priorities": [], "cited_ids": [], "missing_info": []}
        steps[t] = [dict(round=1, **d, usage=usage_of(m) if m else dict(input=0, output=0, cache_write=0, cache_read=0),
                         stop=m.stop_reason if m else "error", flags=validate(d, t[1], db, 1))]
        if d.get("action") == "check_physical_stock":
            need2.append((t, d))
    batch_ids = [bid1]
    if need2:
        req2 = [dict(custom_id=cid(t, 2), params=build_params(model, t[1], t[0], 2, d, layers_pkg.get(t[1]))) for t, d in need2]
        bid2, got2 = submit_and_wait(client, req2)
        batch_ids.append(bid2)
        for t, d in need2:
            m = got2.get(cid(t, 2))
            d2 = (parse_message(m) if m else None) or {"action": "none", "reason": "", "priorities": [], "cited_ids": [], "missing_info": []}
            steps[t].append(dict(round=2, **d2, usage=usage_of(m) if m else dict(input=0, output=0, cache_write=0, cache_read=0),
                                 stop=m.stop_reason if m else "error", flags=validate(d2, t[1], db, 2)))
    return [finalize(t, steps[t], t[1], db, model) for t in tasks], batch_ids


def check_cards():
    """app/js/data.js 의 카드 조건과 이 파일의 CARDS 가 같은지 대조한다."""
    import re
    js = (ROOT / "app" / "js" / "data.js").read_text(encoding="utf-8")
    ok = True
    for cid, c in CARDS.items():
        m = re.search(r"id: '%s'.*?cond: mk\((\d+), D(\d)(?:, \{([^}]*)\})?\)" % cid, js, re.S)
        if not m:
            print(f"{cid}: data.js 에서 찾지 못함"); ok = False; continue
        cash, d, extra = int(m.group(1)), m.group(2), m.group(3) or ""
        arr = "10/7" if d == "1" else "10/8"
        phys = int(re.search(r"physical:\s*(\d+)", extra).group(1)) if "physical" in extra else 8
        age = int(re.search(r"ageH:\s*(\d+)", extra).group(1)) if "ageH" in extra else 12
        prior = "prior: true" in extra
        same = (cash, arr, phys, age, prior) == (c["cash"], c["arrival"], c["physical"], c["ageH"], c["prior"])
        print(f"{cid}: {'일치' if same else '불일치'}"); ok &= same
    return ok


def prompt_hash(pkg):
    """프롬프트 문구와 인터뷰 근거 묶음이 같은지 알아보는 지문. 다른 지문의 실행끼리는 같은 조건의 비교가 아니다."""
    h = hashlib.sha256()
    for s in (SYSTEM_COMMON, SYSTEM_B1, SYSTEM_P0, pkg, json.dumps(tool_schema(ACTIONS_R1), ensure_ascii=False, sort_keys=True)):
        h.update(s.encode("utf-8"))
    return h.hexdigest()[:10]


def reindex():
    """runs/*/results.json 을 훑어 runs/index.json 을 다시 만든다. 화면은 폴더 목록을 읽을 수 없어 이 파일로 실행 목록을 안다.
    runs/labels.json ({"실행번호": {"kind": "practice|eval", "note": "..."}}) 은 사람이 직접 고치며 이 함수는 건드리지 않는다."""
    labels = {}
    lp = RUNS / "labels.json"
    if lp.exists():
        labels = json.loads(lp.read_text(encoding="utf-8-sig"))
    items = []
    for p in sorted(RUNS.glob("*/results.json")):
        d = json.loads(p.read_text(encoding="utf-8"))
        res = d.get("results", [])
        items.append(dict(
            run_id=d["run_id"], created_at=d.get("created_at"), mode=d.get("mode"), model=d.get("model"),
            layers=d.get("layers"), cards=d.get("cards"), reps=d.get("reps"), n_results=len(res),
            n_flagged=sum(1 for r in res if r.get("flags")), est_cost_usd=d.get("est_cost_usd"),
            prompt_hash=d.get("prompt_hash"), kind=(labels.get(d["run_id"]) or {}).get("kind", "unlabeled"),
            note=(labels.get(d["run_id"]) or {}).get("note", ""),
        ))
    items.sort(key=lambda x: x["created_at"] or "", reverse=True)
    RUNS.mkdir(exist_ok=True)
    (RUNS / "index.json").write_text(json.dumps(dict(runs=items), ensure_ascii=False, indent=2), encoding="utf-8")
    return items


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--reindex", action="store_true", help="runs/index.json (실행 기록 목록)을 다시 만든다")
    ap.add_argument("--mode", choices=["sync", "batch"], default="sync")
    ap.add_argument("--model", default=None, help="dev | run | 모델 ID. 기본: sync=dev, batch=run")
    ap.add_argument("--layers", default=",".join(LAYERS))
    ap.add_argument("--cards", default="all")
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--run-id", default=None)
    ap.add_argument("--dry-run", action="store_true", help="요청 수와 토큰만 계산한다. 호출 비용 없음")
    ap.add_argument("--yes", action="store_true", help="비용이 드는 실행을 확인했다")
    ap.add_argument("--check-cards", action="store_true")
    a = ap.parse_args()

    if a.check_cards:
        sys.exit(0 if check_cards() else 1)
    if a.reindex:
        print(f"runs/index.json 을 다시 만들었습니다 (실행 {len(reindex())}건)")
        return

    model = a.model or ("dev" if a.mode == "sync" else "run")
    model = CFG["models"].get(model, model)
    layers = [x.strip() for x in a.layers.split(",") if x.strip()]
    cards = list(CARDS) if a.cards == "all" else [x.strip() for x in a.cards.split(",")]
    bad = [c for c in cards if c not in CARDS] + [l for l in layers if l not in LAYERS]
    if bad:
        sys.exit(f"알 수 없는 값: {bad}")
    db = load_db()
    pkg = interview_package(db)
    layers_pkg = {"P0": pkg}
    tasks = [(c, l, r) for c in cards for l in layers for r in range(1, a.reps + 1)]
    n_check = sum(1 for t in tasks if t[0] == "C05")  # 선반 확인이 일어날 가능성이 가장 큰 카드. 추가 호출 상한 추정용

    print(f"모델 {model} · 방식 {a.mode} · 층 {layers} · 카드 {len(cards)}장 · 반복 {a.reps} → 요청 {len(tasks)}건 (+선반 확인 후 재판단 최대 {len(tasks)}건)")
    print(f"인터뷰 자료 {len(pkg):,}자 (P0 에서만 전송, 전사 원문과 약사 응답은 전송하지 않음)")

    if a.dry_run:
        per_layer = len(cards) * a.reps
        try:
            client = make_client()
            tok = {}
            for l in layers:
                p = build_params(model, l, cards[0], 1, None, layers_pkg.get(l))
                r = client.messages.count_tokens(model=p["model"], system=p["system"], messages=p["messages"], tools=p["tools"], tool_choice=p["tool_choice"])
                tok[l] = r.input_tokens
            print("1회 호출 입력 토큰(실측, 무료 계산):", tok)
        except Exception as e:  # 키가 없거나 잘못된 경우에도 대략의 크기는 보여 준다
            print(f"토큰 실측 실패({type(e).__name__}): 글자 수로 대략 추정합니다. 한국어는 글자당 약 0.6~1 토큰이라 범위로 표시합니다.")
            tok = {}
            for l in layers:
                p = build_params(model, l, cards[0], 1, None, layers_pkg.get(l))
                chars = sum(len(b["text"]) for b in p["system"]) + len(p["messages"][0]["content"]) + len(json.dumps(p["tools"], ensure_ascii=False))
                tok[l] = (int(chars * 0.6), int(chars * 1.0))
            print("1회 호출 입력 토큰 추정 범위:", tok)
        lo = sum((t[0] if isinstance(t, tuple) else t) * per_layer for t in tok.values())
        hi = sum((t[1] if isinstance(t, tuple) else t) * per_layer for t in tok.values())
        print(f"1라운드 합계 입력 약 {lo:,}" + (f"~{hi:,}" if hi != lo else "") + " 토큰. 선반 확인 후 재판단이 일어나면 그만큼 늘어납니다. 캐시를 쓰면 P0 의 반복 호출 입력 비용이 크게 줄어듭니다.")
        print("dry-run 이라 추론 호출을 하지 않았고 아무것도 저장하지 않았습니다.")
        return

    if not a.yes:
        sys.exit("비용이 드는 실행입니다. 위 요청 수를 확인한 뒤 --yes 를 붙여 다시 실행하세요. (--dry-run 으로 먼저 토큰을 볼 수 있습니다)")

    client = make_client()
    run_id = a.run_id or dt.datetime.now().strftime("%Y%m%d-%H%M%S") + f"-{a.mode}"
    out_dir = RUNS / run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    started = dt.datetime.now().isoformat(timespec="seconds")
    batch_ids = []
    if a.mode == "sync":
        results = run_sync(client, model, tasks, layers_pkg, db)
    else:
        results, batch_ids = run_batch(client, model, tasks, layers_pkg, db)

    usage = sum_usage([r["usage"] for r in results])
    agg = dict(run_id=run_id, created_at=started, mode=a.mode, model=model, layers=layers, cards=cards, reps=a.reps,
               prompt_hash=prompt_hash(pkg), batch_ids=batch_ids, usage=usage, est_cost_usd=est_cost(usage, model, a.mode == "batch"),
               note="AI 시뮬레이션 출력이며 사실이 아니다. claims 로 되먹이지 않는다 (G04).",
               consistency=consistency(results), results=results)
    (out_dir / "results.json").write_text(json.dumps(agg, ensure_ascii=False, indent=2), encoding="utf-8")
    (RUNS / "latest.json").write_text(json.dumps(agg, ensure_ascii=False, indent=2), encoding="utf-8")
    reindex()
    flagged = [r for r in results if r["flags"]]
    print(f"\n저장: {out_dir / 'results.json'} 와 runs/latest.json")
    print(f"토큰 입력 {usage['input']:,} · 출력 {usage['output']:,} · 캐시 쓰기 {usage['cache_write']:,} · 캐시 읽기 {usage['cache_read']:,}")
    c = agg["est_cost_usd"]
    print("추정 비용: " + (f"${c:.3f}" if c is not None else "단가 미설정 (scripts/persona_config.json)"))
    print(f"검증 플래그가 있는 결과 {len(flagged)}건 / {len(results)}건")


if __name__ == "__main__":
    main()
