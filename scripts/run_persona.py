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
import re
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
# 카드 조건의 원본은 data/4_bridge/cards.csv, 관측 문장의 원본은 data/4_bridge/card_variables.csv 다.
# app/js/data.js 의 CARDS 도 같은 값을 가진다 (--check-cards 로 대조).
BRIDGE = ROOT / "data" / "4_bridge"
CAL = ["2026-10-06", "2026-10-07", "2026-10-08"]
# 10/6 통화 뒤: 통장 잔액·외상 한도는 판단 조건에서 뺐고, 수량 할인(10팩 이상 bulk 단가)을 넣었다. 재고는 선반+창고 합계.
UNIT_COST, BULK_MIN, CAPACITY, DUE = 10000, 10, 20, "2026-11-05"  # 최대 수량 10→20: 10이 상한이라 AI 답이 10으로 몰렸다
PRIOR_ARRIVAL = "2026-10-07"
PRIOR_PACKS = 5
ACTIONS_R1 = ["check_physical_stock", "commit_choice", "defer"]
ACTIONS_R2 = ["commit_choice", "defer"]
# B1 일반 약사 / P0 +인터뷰 근거 / P1 +장면 입력(공공·민간·가상 달력). 약사 본인은 P1 과 같은 정보를 본다.
LAYERS = ["B1", "P0", "P1", "P2"]  # P2 = P1 + 10/6 약사 통화 응답을 근거로 포함
STRATEGIES = ["need_only", "fill_discount", "other"]  # 필요한 만큼만 / 할인 구간까지 / 그 외
FACTOR_SOURCES = ["interview", "scene", "observation", "assumption", "general_knowledge"]
EMPTY = {"action": "none", "reason": "", "priorities": [], "cited_ids": [], "missing_info": [], "factors": []}
DROPS = {}  # 하나씩 빼 보기 층 -> 뺀 ID 집합 (main 에서 채운다)


def _read(p):
    with open(p, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def load_cards():
    out = {}
    for r in _read(BRIDGE / "cards.csv"):
        out[r["card_id"]] = dict(bulk=int(r["bulk_unit_krw"]) if r["bulk_unit_krw"] else None, arrival=r["arrival_date"], book=int(r["book_packs"]),
                                 physical=int(r["physical_packs"]), ageH=int(r["record_age_h"]), prior=r["prior_order"] == "Y",
                                 ret=r["return_ok"] != "N", hint=r["shortage_hint"] == "Y", cutoff=r["cutoff"] == "Y", tight=r["tight_space"] == "Y",
                                 kind=r["kind"], changed=[x for x in r["changed_variable_ids"].split(";") if x])
    return out


CARDS = load_cards()
# 지금 카드의 근거(app/js/data.js 의 basis)에 쓰인 규칙 + 장면 입력(연휴·의원 일정)을 받치는 R08. --ablate cards 의 대상
CARD_RULES = ["R01", "R02", "R03", "R08"]
OBS_ROWS = _read(BRIDGE / "card_variables.csv")


def won(n):
    return f"{n:,}원"


def day_label(iso):
    return f"{int(iso[5:7])}/{int(iso[8:10])}"


def fill(tpl, c):
    """card_variables.csv 의 {형식:이름} 자리표시를 채운다. app/js/app.js 의 fillObs 와 같은 규칙이다."""
    import re
    prior_n = PRIOR_PACKS if c["prior"] else 0
    ctx = dict(c, UNIT=UNIT_COST, CAP=CAPACITY, DUE=DUE, PRIOR_ARR=PRIOR_ARRIVAL, D0=CAL[0], D1=CAL[1], D2=CAL[2], BULK_MIN=BULK_MIN,
               PRIOR_N=prior_n, POS_BOOK=c["book"] + prior_n, POS_PHYS=c["physical"] + prior_n,
               DISC=round((1 - c["bulk"] / UNIT_COST) * 100) if c["bulk"] else 0)
    fmt = {"won": won, "date": day_label, "n": str}
    return re.sub(r"\{(\w+):(\w+)\}", lambda m: fmt[m.group(1)](ctx[m.group(2)]), tpl)


def obs_lines(card_id, c, checked, scene):
    """보여 줄 관측 줄. 카드 전용 줄이 같은 순서의 공통(*) 줄을 덮는다. scene=False 면 장면 입력 줄을 뺀다."""
    want = {"always", "checked" if checked else "unchecked", "prior" if c["prior"] else "no_prior",
            "bulk" if c["bulk"] else "no_bulk", "ret_ok" if c["ret"] else "ret_no", "hint" if c["hint"] else "no_hint"}
    if c["cutoff"]:
        want.add("cutoff")
    if c["tight"]:
        want.add("tight")
    rows = {}
    for r in OBS_ROWS:
        if r["card_id"] not in ("*", card_id) or r["show_when"] not in want:
            continue
        if r["layer"] == "scene" and not scene:
            continue
        key = r["line_order"]
        if key in rows and rows[key]["card_id"] == card_id and r["card_id"] == "*":
            continue
        rows[key] = r
    return [rows[k] for k in sorted(rows, key=int)]


def observation_text(card_id, c, checked=False, scene=True):
    """약사와 AI 에게 똑같이 보여 주는 정보. 확인 전의 실제 재고, 앞으로의 손님 수, 선택별 결과는 넣지 않는다."""
    return "\n".join(f"- {r['obs_label_ko']}: {fill(r['obs_text_ko'], c)}" for r in obs_lines(card_id, c, checked, scene))


def has_scene(layer):
    return layer.startswith("P1") or layer == "P2"


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
    db["links"] = read_csv("evidence_links.csv")
    db["answer_ids"] = {a["id"] for a in answer_items()}
    return db


def ablation_ids(db, rule_id):
    """하나씩 빼 보기 단위: 규칙 하나 + 그 규칙을 받치는 발언(claim_supports_rule) + 그 규칙을 보여 주는 사례(case_illustrates_rule)."""
    out = {rule_id}
    for l in db["links"]:
        if l["to_id"] == rule_id and l["link_type"] in ("claim_supports_rule", "case_illustrates_rule"):
            out.add(l["from_id"])
    return out


def interview_package(db, drop=frozenset()):
    """P0·P1 에서 보낸다. 모두 정리된 문장이며 source_location, 전사 원문은 넣지 않는다. drop 의 ID 는 뺀다 (하나씩 빼 보기)."""
    keep = lambda i: i not in drop
    out = ["# 인터뷰 근거 (판단 대상 약사 1명)", "", "## 프로필"]
    for r in db["profile"]:
        if r["kind"] == "fact":
            out.append(f"- {r['summary_ko']}: {r['value']}{r['unit'] if r['unit'] != 'date' else ''}")
        else:
            out.append(f"- [{r['section_ko']}] {r['summary_ko']} — {r['detail_ko']}")
    out += ["", "## 발언 (E###)  형식: ID | 주제 | 해당 범위 | 유형 | 원문 일부 | 요약"]
    for r in db["claims"]:
        if not keep(r["claim_id"]):
            continue
        out.append(f"{r['claim_id']} | {r['topic_ko']} | {r['applies_to']} | {r['record_type']} | {r['quote_ko']} | {r['summary_ko']}")
    out += ["", "## 규칙 (R##)  형식: ID | 제목 | 상황 | 고려한 정보 | 판단 | 읽을 때 주의"]
    for r in db["rules"]:
        if not keep(r["rule_id"]):
            continue
        out.append(f"{r['rule_id']} | {r['title_ko']} | {r['situation_ko']} | {r['info_considered_ko']} | {r['judgement_ko']} | {r['reading_note_ko']}")
    out += ["", "## 사례 (I##)  형식: ID | 제목 | 해당 범위 | 상황 | 대응 | 결과 | 배운 점"]
    for r in db["cases"]:
        if not keep(r["case_id"]):
            continue
        out.append(f"{r['case_id']} | {r['title_ko']} | {r['applies_to']} | {r['situation_ko']} | {r['response_ko']} | {r['outcome_ko']} | {r['learning_ko']}")
    out += ["", "## 주의 규칙 (G##)  이 근거를 쓸 때 반드시 지킨다"]
    for r in db["guardrails"]:
        out.append(f"{r['guardrail_id']} | {r['rule_ko']} | 처리: {r['handling_ko']} | 구별: {r['distinguish_ko']}")
    return "\n".join(out)


ANSWERS_CSV = ROOT / "data" / "5_validation" / "pharmacist_answers.csv"


def answer_items():
    """10/6 통화 응답 중 판단에 쓸 수 있는 줄. 파일 순서대로 T01, T02... 번호를 붙인다 (화면도 같은 규칙이다).
    약사가 한 말을 팀원이 정리해 전달한 것이다. 문구는 바꾸지 않고, 내부 카드 번호·파일 이름이 든 문장만 뺀다."""
    out = []
    for r in _read(ANSWERS_CSV):
        text = " / ".join(x for x in ((r.get("realism_ko") or "").strip(), (r.get("answer_ko") or "").strip()) if x)
        if not text:
            continue
        sents = [x.strip() for x in re.split(r"(?<=[.다])\s+", (r.get("note_ko") or "").strip()) if x.strip()]
        premise = " ".join(re.sub(r"\s*\(C\d+[^)]*\)", "", x) for x in sents if not re.search(r"card_id|카드|일치율|당시 C|통장 잔액 60", x))
        out.append(dict(id=f"T{len(out) + 1:02d}", question=(r.get("question_ko") or "").strip(), text=text, premise=premise,
                        source="2026-10-06 통화 (전사 또는 팀원이 정리해 전달, 약사 직접 인용 아님)"))
    return out


def answers_package():
    out = ["", "## 10/6 추가 통화 응답 (T##)  같은 약사에게 따로 물은 답. 팀원이 정리해 전달한 것이며 약사 직접 인용이 아니다",
           "형식: ID | 질문 | 답 | 질문의 전제 · 출처. 답하지 않은 수량을 만들어 내지 않는다."]
    for a in answer_items():
        out.append(f"{a['id']} | {a['question'] or '(원래 질문지에 대한 전체 평가)'} | {a['text']} | {a['premise']} {a['source']}".rstrip())
    return "\n".join(out)


SYSTEM_COMMON = """당신은 한국의 동네 약국에서 약품 주문(발주)을 판단하는 약사 역할을 한다. 아래 '관측값'에 보이는 정보만으로 판단한다.

규칙
- 관측값에 없는 값(확인 전의 실제 재고, 앞으로 올 손님 수, 선택별 결과)은 모른다. 추측한 숫자를 사실처럼 쓰지 않는다.
- 선택지는 정해져 있다: 실물 확인(선반과 창고, check_physical_stock), 주문(commit_choice: qty_packs 를 0~20 사이 정수로 적는다. 0은 보류), 판단 유보(defer).
- 주문이면 strategy 도 고른다. need_only: 필요한 만큼만 최소로 / fill_discount: 할인 구간 수량까지 채워서 / other: 그 밖. 할인이 없으면 fill_discount 를 쓰지 않는다.
- 관측값의 숫자(기간, 수량, 날짜)를 바꾸어 쓰지 않는다. 최근 판매 기간은 관측값에 적힌 그대로다. 재고는 '재고 위치'(보유 + 이미 넣은 주문)를 기준으로 본다.
- 실물 확인은 한 번만 할 수 있다. 확인하면 선반과 창고를 합친 실제 재고가 공개되고 다시 판단한다.
- reason 은 2~4문장으로 쓴다. priorities 는 가장 중요하게 본 것 두 가지를 짧은 문구로 쓴다.
- factors 에는 이번 판단에 실제로 쓴 요인을 1~5개 적고, 요인마다 출처를 하나 고른다.
  interview: 아래 인터뷰 근거에서 온 것 (ids 에 E###/R##/I##/T## 를 반드시 적는다)
  scene: 관측값 중 날짜 사정·독감·주변 의원 같은 외부 환경 줄에서 온 것
  observation: 관측값의 재고·판매량·도매상 조건(단가·입고일) 숫자에서 온 것
  assumption: 관측값에 없어 스스로 가정한 것
  general_knowledge: 인터뷰와 관측값 어디에도 없는 일반 상식에서 온 것
  일반 상식이나 가정을 썼으면 숨기지 말고 그대로 표시한다. 그렇게 표시하는 것은 감점이 아니다.
- 반드시 submit_decision 도구로 답한다."""

SYSTEM_B1 = """

이 판단에는 특정 약사에 대한 개인 자료가 주어지지 않는다. 일반적인 약사의 상식으로 판단하고 cited_ids 는 빈 배열로 둔다. factors 에 interview 를 쓰지 않는다."""

SYSTEM_P0 = """

아래 '인터뷰 근거'는 판단 대상인 약사 1명을 인터뷰해 정리한 것이다. 이 약사가 말한 판단 방식과 제약을 따른다.
- 판단의 근거는 인터뷰 근거와 관측값이다. 이 둘로 정할 수 없는 부분만 일반 상식으로 채우고, 그때는 factors 에 general_knowledge 로 표시한다.
- 근거로 삼은 ID(E###, R##, I##, 있으면 T##)를 cited_ids 에 적는다. 목록에 없는 ID 를 만들지 않는다.
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
                "qty_packs": {"type": "integer", "minimum": 0, "maximum": CAPACITY, "description": "action 이 commit_choice 일 때만. 0~%d 정수. 보류는 0" % CAPACITY},
                "strategy": {"type": "string", "enum": STRATEGIES, "description": "commit_choice 이고 수량이 1 이상일 때: need_only 필요한 만큼만 / fill_discount 할인 구간까지 / other"},
                "reason": {"type": "string", "description": "2~4문장"},
                "priorities": {"type": "array", "items": {"type": "string"}, "maxItems": 2, "description": "가장 중요하게 본 것 두 가지"},
                "cited_ids": {"type": "array", "items": {"type": "string"}, "description": "근거 ID. 개인 자료가 없으면 빈 배열"},
                "missing_info": {"type": "array", "items": {"type": "string"}, "description": "더 알고 싶은 정보"},
                "factors": {
                    "type": "array", "minItems": 1, "maxItems": 5, "description": "판단에 실제로 쓴 요인과 그 출처",
                    "items": {
                        "type": "object",
                        "properties": {
                            "factor": {"type": "string", "description": "요인 (짧은 문구)"},
                            "source": {"type": "string", "enum": FACTOR_SOURCES},
                            "ids": {"type": "array", "items": {"type": "string"}, "description": "source 가 interview 일 때 근거 ID"},
                        },
                        "required": ["factor", "source", "ids"],
                    },
                },
            },
            "required": ["action", "reason", "priorities", "cited_ids", "missing_info", "factors"],
        },
    }


def build_params(model, layer, card_id, rnd, prev, pkg):
    c = CARDS[card_id]
    personal = layer != "B1"
    system = [{"type": "text", "text": SYSTEM_COMMON + (SYSTEM_P0 if personal else SYSTEM_B1)}]
    if personal:
        # 같은 층의 모든 요청이 같은 앞부분을 가지므로 캐시한다 (최소 길이를 넘는 경우에만 효과가 있다).
        system.append({"type": "text", "text": pkg, "cache_control": {"type": "ephemeral"}})
    scene = has_scene(layer)
    if rnd == 1:
        user = "관측값\n" + observation_text(card_id, c, False, scene) + "\n\n어떻게 하시겠습니까? submit_decision 으로 답하세요."
        actions = ACTIONS_R1
    else:
        user = ("관측값\n" + observation_text(card_id, c, True, scene) +
                f"\n\n처음 판단에서 실물 확인(선반과 창고)을 택했습니다. 그때 이유: {prev['reason']}\n"
                "이제 확인한 실제 재고를 반영해 최종 선택을 하세요. (0~20팩 중 수량을 정해 주문하거나, 판단 유보) submit_decision 으로 답하세요.")
        actions = ACTIONS_R2
    return dict(model=model, max_tokens=CFG["max_tokens"], system=system,
                messages=[{"role": "user", "content": user}],
                tools=[tool_schema(actions)], tool_choice={"type": "tool", "name": "submit_decision"})


# ---------------------------------------------------------------- 검증과 집계
def validate(step, layer, db, rnd, card):
    flags = []
    a = step.get("action")
    allowed = ACTIONS_R1 if rnd == 1 else ACTIONS_R2
    if a not in allowed:
        flags.append("action_not_allowed")
    q = step.get("qty_packs")
    if a == "commit_choice" and not (isinstance(q, int) and not isinstance(q, bool) and 0 <= q <= CAPACITY):
        flags.append("invalid_qty")
    if a == "commit_choice" and isinstance(q, int) and q > 0:
        if step.get("strategy") not in STRATEGIES:
            flags.append("strategy_missing")
        elif step.get("strategy") == "fill_discount" and not CARDS[card]["bulk"]:
            flags.append("discount_tag_without_discount")
    text = " ".join([step.get("reason") or ""] + list(step.get("priorities") or []))
    bad = [m for m in re.findall(r"(\d+)\s*일(?:간|\s*(?:동안|연속|내내))", text) if m != "3"]
    if bad:
        flags.append("period_mismatch:" + ",".join(sorted(set(bad))))  # 관측값은 '사흘'이다 (검토본 D11)
    factors = step.get("factors") or []
    if step.get("_malformed"):
        flags.append("output_reshaped")
    fids = [i for f in factors for i in (f.get("ids") or [])]
    ids = list(dict.fromkeys((step.get("cited_ids") or []) + fids))
    unknown = [i for i in ids if i not in db["ids"] and i != "U001" and not (layer == "P2" and i in db["answer_ids"])]
    if unknown:
        flags.append("unknown_ids:" + ",".join(unknown))
    removed = [i for i in ids if i in DROPS.get(layer, ())]
    if removed:
        flags.append("cites_removed_id:" + ",".join(removed))
    if layer == "B1" and ids:
        flags.append("ids_given_without_interview")
    if layer != "B1" and a == "commit_choice" and not ids:
        flags.append("no_evidence_cited")
    if len(step.get("priorities") or []) != 2:
        flags.append("priorities_not_two")
    if not factors:
        flags.append("no_factors")
    for f in factors:
        src = f.get("source")
        if src == "interview" and not f.get("ids"):
            flags.append("interview_factor_without_ids")
        if src == "interview" and layer == "B1":
            flags.append("interview_factor_in_b1")
        if src == "scene" and not has_scene(layer):
            flags.append("scene_factor_without_scene")
    return list(dict.fromkeys(flags))


def parse_message(msg):
    """tool_use 블록에서 입력을 꺼낸다. 없으면 None."""
    for b in msg.content:
        if getattr(b, "type", "") == "tool_use":
            return normalize(dict(b.input))
    return None


def normalize(d):
    """모델이 목록을 문자열로 보내는 경우가 있다. 값을 고치지 않고 형식만 펴고, 펴야 했다는 사실을 표시한다."""
    bad = False
    for k in ("factors", "cited_ids", "priorities", "missing_info"):
        v = d.get(k)
        if isinstance(v, str):
            try:
                d[k] = json.loads(v)
            except ValueError:
                d[k] = [v] if v.strip() else []
            bad = True
    fs = []
    for f in d.get("factors") or []:
        if isinstance(f, dict):
            fs.append(f)
        else:
            fs.append({"factor": str(f), "source": "", "ids": []})
            bad = True
    d["factors"] = fs
    if bad:
        d["_malformed"] = True
    return d


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


def final_key(r):
    return r["final_action"] if r["qty_packs"] is None else f"commit_{r['qty_packs']}"


def majority(vals):
    """가장 많이 나온 값. 동률이면 'split'."""
    c = {}
    for v in vals:
        c[v] = c.get(v, 0) + 1
    if not c:
        return None
    top = sorted(c.items(), key=lambda x: -x[1])
    return "split" if len(top) > 1 and top[0][1] == top[1][1] else top[0][0]


def factor_summary(results):
    """층별로 최종 판단의 요인 출처를 센다. general_knowledge 비율이 '인터뷰·관측값 밖에서 온 몫'의 자기 보고다."""
    out = {}
    for r in results:
        d = out.setdefault(r["layer"], {s: 0 for s in FACTOR_SOURCES})
        for f in r["steps"][-1].get("factors") or []:
            if f.get("source") in d:
                d[f["source"]] += 1
    for d in out.values():
        n = sum(d.values())
        d["total"] = n
        d["general_knowledge_share"] = round(d["general_knowledge"] / n, 3) if n else None
    return out


def ablation_summary(results, drops):
    """P1 과 'P1-규칙' 층을 카드별로 비교한다. 다수 선택이 바뀌면 그 규칙 묶음이 판단에 쓰였다는 신호다 (원인 확정은 아니다)."""
    if not drops:
        return []
    by = {}
    for r in results:
        by.setdefault((r["card"], r["layer"]), []).append(r)
    rows = []
    for layer, ids in drops.items():
        rule = layer.split("-", 1)[1]
        for card in sorted({r["card"] for r in results}):
            base, abl = by.get((card, "P1"), []), by.get((card, layer), [])
            if not base or not abl:
                continue
            bf, af = majority([final_key(r) for r in base]), majority([final_key(r) for r in abl])
            b1, a1 = majority([r["first_action"] for r in base]), majority([r["first_action"] for r in abl])
            rows.append(dict(rule=rule, layer=layer, card=card, removed_ids=sorted(ids), base_final=bf, ablated_final=af,
                             base_first=b1, ablated_first=a1, n_base=len(base), n_ablated=len(abl),
                             changed=("unclear" if "split" in (bf, af) else "yes" if (bf != af or b1 != a1) else "no")))
    return rows


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


PARTIAL = None  # 끝난 결과를 한 건씩 적어 두는 파일 (중간에 멈춰도 --resume 으로 이어서 한다)
AUTO_TOOL = set()  # 도구 선택을 강제할 수 없는 모델 (claude-sonnet-5-5 등). 이 모델은 tool_choice=auto 로 부르고 시스템 지시로 도구 사용을 요구한다


def create(client, **p):
    if p["model"] in AUTO_TOOL:
        p = dict(p, tool_choice={"type": "auto"})
    try:
        return client.messages.create(**p)
    except Exception as e:
        if "tool_choice" in str(e):
            AUTO_TOOL.add(p["model"])
            return client.messages.create(**dict(p, tool_choice={"type": "auto"}))
        raise


def run_sync(client, model, tasks, layers_pkg, db):
    def one(task):
        card, layer, rep = task
        pkg = layers_pkg.get(layer)
        steps = []
        p1 = build_params(model, layer, card, 1, None, pkg)
        m1 = create(client, **p1)
        d1 = parse_message(m1) or dict(EMPTY)
        steps.append(dict(round=1, **d1, usage=usage_of(m1), stop=m1.stop_reason, flags=validate(d1, layer, db, 1, card)))
        if d1.get("action") == "check_physical_stock":
            p2 = build_params(model, layer, card, 2, d1, pkg)
            m2 = create(client, **p2)
            d2 = parse_message(m2) or dict(EMPTY)
            steps.append(dict(round=2, **d2, usage=usage_of(m2), stop=m2.stop_reason, flags=validate(d2, layer, db, 2, card)))
        print(f"  {card} {layer} #{rep}: {' → '.join(str(s.get('action')) + (':' + str(s.get('qty_packs')) if s.get('qty_packs') is not None else '') for s in steps)}", flush=True)
        res = finalize(task, steps, layer, db, model)
        if PARTIAL:
            with open(PARTIAL, "a", encoding="utf-8") as f:
                f.write(json.dumps(res, ensure_ascii=False) + "\n")
        return res
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
        d = (parse_message(m) if m else None) or dict(EMPTY)
        steps[t] = [dict(round=1, **d, usage=usage_of(m) if m else dict(input=0, output=0, cache_write=0, cache_read=0),
                         stop=m.stop_reason if m else "error", flags=validate(d, t[1], db, 1, t[0]))]
        if d.get("action") == "check_physical_stock":
            need2.append((t, d))
    batch_ids = [bid1]
    if need2:
        req2 = [dict(custom_id=cid(t, 2), params=build_params(model, t[1], t[0], 2, d, layers_pkg.get(t[1]))) for t, d in need2]
        bid2, got2 = submit_and_wait(client, req2)
        batch_ids.append(bid2)
        for t, d in need2:
            m = got2.get(cid(t, 2))
            d2 = (parse_message(m) if m else None) or dict(EMPTY)
            steps[t].append(dict(round=2, **d2, usage=usage_of(m) if m else dict(input=0, output=0, cache_write=0, cache_read=0),
                                 stop=m.stop_reason if m else "error", flags=validate(d2, t[1], db, 2, t[0])))
    return [finalize(t, steps[t], t[1], db, model) for t in tasks], batch_ids


def check_cards():
    """카드 정의 점검: (1) app/js/data.js 의 조건이 cards.csv 와 같은가 (2) 관측 줄과 바꾼 변수가 입력 가능한 변수인가."""
    import re
    js = (ROOT / "app" / "js" / "data.js").read_text(encoding="utf-8")
    ok = True
    for cid, c in CARDS.items():
        m = re.search(r"id: '%s'.*?cond: mk\(D(\d)(?:, \{([^}]*)\})?\)" % cid, js, re.S)
        if not m:
            print(f"{cid}: data.js 에서 찾지 못함"); ok = False; continue
        d, extra = m.group(1), m.group(2) or ""
        bulk = int(re.search(r"bulk:\s*(\d+)", extra).group(1)) if "bulk" in extra else None
        arr = CAL[int(d)]
        phys = int(re.search(r"physical:\s*(\d+)", extra).group(1)) if "physical" in extra else 8
        age = int(re.search(r"ageH:\s*(\d+)", extra).group(1)) if "ageH" in extra else 12
        prior = "prior: true" in extra
        ret, hint, cutoff, tight = "ret: false" not in extra, "hint: true" in extra, "cutoff: true" in extra, "tight: true" in extra
        same = (bulk, arr, phys, age, prior, ret, hint, cutoff, tight) == (c["bulk"], c["arrival"], c["physical"], c["ageH"], c["prior"], c["ret"], c["hint"], c["cutoff"], c["tight"])
        print(f"{cid}: data.js 와 cards.csv {'일치' if same else '불일치'}"); ok &= same
    roles = {r["variable_id"]: r for r in _read(BRIDGE / "variable_roles.csv")}
    used = [(f"card_variables {r['card_id']}/{r['line_order']}", v) for r in OBS_ROWS for v in r["variable_ids"].split(";") if v]
    used += [(f"cards {cid}", v) for cid, c in CARDS.items() for v in c["changed"]]
    for where, v in used:
        if v not in roles:
            print(f"{where}: {v} 는 variables.csv 에 없는 변수"); ok = False
        elif roles[v]["card_input_allowed"] != "Y":
            print(f"{where}: {v} ({roles[v]['sim_role_ko']}) 는 입력으로 쓸 수 없는 변수"); ok = False
    for r in OBS_ROWS:
        if r["layer"] == "scene" and not any(roles.get(v, {}).get("sim_role") == "scene_input" for v in r["variable_ids"].split(";")):
            print(f"card_variables {r['card_id']}/{r['line_order']}: 장면 입력 줄인데 장면 입력 변수가 없음"); ok = False
    print("변수 점검:", "통과" if ok else "실패")
    return ok


def prompt_hash(pkg):
    """프롬프트 문구, 인터뷰 근거 묶음, 카드 변수표가 같은지 알아보는 지문. 다른 지문의 실행끼리는 같은 조건의 비교가 아니다."""
    h = hashlib.sha256()
    cards = json.dumps(CARDS, ensure_ascii=False, sort_keys=True) + json.dumps(OBS_ROWS, ensure_ascii=False, sort_keys=True)
    for s in (SYSTEM_COMMON, SYSTEM_B1, SYSTEM_P0, pkg, cards, json.dumps(tool_schema(ACTIONS_R1), ensure_ascii=False, sort_keys=True)):
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
    ap.add_argument("--ablate", default="", help="하나씩 빼 보기: 규칙 ID 를 쉼표로 (예: R01,R03) 또는 'cards' (카드 근거에 쓰인 규칙 전부). 규칙마다 'P1-규칙' 층이 추가된다")
    ap.add_argument("--resume", action="store_true", help="같은 --run-id 의 partial.jsonl 에 있는 결과는 다시 부르지 않고 이어서 한다")
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
    layers_pkg = {"P0": pkg, "P1": pkg, "P2": pkg + "\n" + answers_package()}
    rules = sorted({r["rule_id"] for r in db["rules"]})
    abl = CARD_RULES if a.ablate == "cards" else [x.strip() for x in a.ablate.split(",") if x.strip()]
    if [x for x in abl if x not in rules]:
        sys.exit(f"알 수 없는 규칙: {[x for x in abl if x not in rules]}")
    if abl and "P1" not in layers:
        layers.append("P1")  # 비교 기준
    for rule in abl:
        ids = ablation_ids(db, rule)
        DROPS[f"P1-{rule}"] = ids
        layers_pkg[f"P1-{rule}"] = interview_package(db, frozenset(ids))
        layers.append(f"P1-{rule}")
    tasks = [(c, l, r) for c in cards for l in layers for r in range(1, a.reps + 1)]

    print(f"모델 {model} · 방식 {a.mode} · 층 {layers} · 카드 {len(cards)}장 · 반복 {a.reps} → 요청 {len(tasks)}건 (+선반 확인 후 재판단 최대 {len(tasks)}건)")
    if "P2" in layers:
        print(f"P2: 10/6 약사 통화 응답 {len(answer_items())}줄을 근거에 추가 ({', '.join(x['id'] for x in answer_items())})")
    print(f"인터뷰 자료 {len(pkg):,}자 (P0·P1·P2 에서만 전송, 전사 원문은 전송하지 않음. 약사 통화 응답 T## 는 P2 에서만 전송)")
    for l, ids in DROPS.items():
        print(f"  {l}: {len(ids)}개 ID 를 뺌 ({', '.join(sorted(ids))})")

    if a.dry_run:
        per_layer = len(cards) * a.reps
        try:
            client = make_client()
            tok = {}
            for l in dict.fromkeys(layers):
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
    global PARTIAL
    done = []
    if a.mode == "sync":
        PARTIAL = out_dir / "partial.jsonl"
        if a.resume and PARTIAL.exists():
            done = [json.loads(x) for x in PARTIAL.read_text(encoding="utf-8").splitlines() if x.strip()]
            have = {(r["card"], r["layer"], r["rep"]) for r in done}
            tasks = [t for t in tasks if t not in have]
            print(f"이어서 실행: 끝난 {len(done)}건은 건너뛰고 {len(tasks)}건을 다시 부릅니다")
        elif PARTIAL.exists():
            PARTIAL.unlink()
        results = done + run_sync(client, model, tasks, layers_pkg, db)
    else:
        results, batch_ids = run_batch(client, model, tasks, layers_pkg, db)

    usage = sum_usage([r["usage"] for r in results])
    agg = dict(run_id=run_id, created_at=started, mode=a.mode, model=model, layers=layers, cards=cards, reps=a.reps,
               prompt_hash=prompt_hash(pkg), batch_ids=batch_ids, usage=usage, est_cost_usd=est_cost(usage, model, a.mode == "batch"),
               note="AI 시뮬레이션 출력이며 사실이 아니다. claims 로 되먹이지 않는다 (G04).",
               ablations={l: sorted(ids) for l, ids in DROPS.items()},
               consistency=consistency(results), factor_summary=factor_summary(results),
               ablation_summary=ablation_summary(results, DROPS), results=results)
    (out_dir / "results.json").write_text(json.dumps(agg, ensure_ascii=False, indent=2), encoding="utf-8")
    (RUNS / "latest.json").write_text(json.dumps(agg, ensure_ascii=False, indent=2), encoding="utf-8")
    reindex()
    flagged = [r for r in results if r["flags"]]
    print(f"\n저장: {out_dir / 'results.json'} 와 runs/latest.json")
    print(f"토큰 입력 {usage['input']:,} · 출력 {usage['output']:,} · 캐시 쓰기 {usage['cache_write']:,} · 캐시 읽기 {usage['cache_read']:,}")
    c = agg["est_cost_usd"]
    print("추정 비용: " + (f"${c:.3f}" if c is not None else "단가 미설정 (scripts/persona_config.json)"))
    print(f"검증 플래그가 있는 결과 {len(flagged)}건 / {len(results)}건")
    for l, d in agg["factor_summary"].items():
        print(f"  {l}: 요인 {d['total']}개 중 일반 상식 {d['general_knowledge']}개")
    changed = [r for r in agg["ablation_summary"] if r["changed"] == "yes"]
    if agg["ablation_summary"]:
        print(f"하나씩 빼 보기: {len(agg['ablation_summary'])}개 비교 중 판단이 바뀐 것 {len(changed)}개")


if __name__ == "__main__":
    main()
