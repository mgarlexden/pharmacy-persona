#!/usr/bin/env python3
"""CSV 구조 검증 (8가지). 실행: python scripts/validate.py   종료 코드 0=통과, 1=실패"""
import csv, re, sys
from pathlib import Path

D = Path(__file__).resolve().parents[1] / "data"
errors, notes = [], []


def load(rel):
    with open(D / rel, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def cols(rel):
    with open(D / rel, encoding="utf-8-sig", newline="") as f:
        return next(csv.reader(f))


def fail(check, msg):
    errors.append(f"[{check}] {msg}")


claims, variables, rules = load("1_interview/claims.csv"), load("1_interview/variables.csv"), load("1_interview/rules.csv")
profile, guards = load("1_interview/persona_profile.csv"), load("1_interview/guardrails.csv")
cases = load("1_interview/cases.csv")
links = load("1_interview/evidence_links.csv")
dsrc, keys, vmap = load("2_world/data_sources.csv"), load("2_world/key_registry.csv"), load("2_world/variable_data_map.csv")
vparams, fdefs = load("3_virtual/virtual_params.csv"), load("3_virtual/field_defs.csv")
fmap, scen, vrange = load("4_bridge/field_map.csv"), load("4_bridge/scenarios.csv"), load("5_validation/validation_ranges.csv")
enums, prods = load("0_common/enums.csv"), load("0_common/entity_product.csv")
TABLES = {p.stem: p for p in (D / "3_virtual/tables").glob("*.csv")}

ids = {
    "claim": {r["claim_id"] for r in claims}, "variable": {r["variable_id"] for r in variables},
    "rule": {r["rule_id"] for r in rules}, "profile": {r["profile_id"] for r in profile},
    "guardrail": {r["guardrail_id"] for r in guards}, "data": {r["data_id"] for r in dsrc},
    "param": {r["param_id"] for r in vparams}, "product": {r["product_id"] for r in prods},
    "case": {r["case_id"] for r in cases},
}
ENUM = {}
for e in enums:
    ENUM.setdefault(e["enum_group"], set()).add(e["code"])

# 1. ID 존재
kind = lambda x: ("claim" if x in ids["claim"] else "variable" if x in ids["variable"] else "rule" if x in ids["rule"]
                  else "profile" if x in ids["profile"] else "guardrail" if x in ids["guardrail"]
                  else "case" if x in ids["case"] else None)
for r in links:
    for c in ("from_id", "to_id"):
        if not kind(r[c]):
            fail(1, f"evidence_links {r['link_id']}: {c}={r[c]} 가 어느 파일에도 없음")
for r in vmap:
    if r["variable_id"] not in ids["variable"]: fail(1, f"variable_data_map {r['map_id']}: 변수 {r['variable_id']} 없음")
    if r["data_id"] not in ids["data"]: fail(1, f"variable_data_map {r['map_id']}: 데이터 {r['data_id']} 없음")
for r in keys:
    if r["data_id"] not in ids["data"]: fail(1, f"key_registry: 데이터 {r['data_id']} 없음")
for r in fmap:
    if r["variable_id"] not in ids["variable"]: fail(1, f"field_map {r['field_key']}: 변수 {r['variable_id']} 없음")
    if r["param_id"] and r["param_id"] not in ids["param"]: fail(1, f"field_map {r['field_key']}: 파라미터 없음")
    t = r["source_table"]
    if t not in TABLES: fail(1, f"field_map {r['field_key']}: 표 {t} 없음")
    elif r["source_column"] not in cols(f"3_virtual/tables/{t}.csv"): fail(1, f"field_map {r['field_key']}: 열 {t}.{r['source_column']} 없음")
for r in scen:
    pool = ids.get({"variable": "variable", "param": "param", "rule": "rule"}.get(r["target_type"], ""), set())
    if r["target_id"] not in pool: fail(1, f"scenarios {r['scenario_id']}#{r['setting_order']}: 대상 {r['target_id']} 없음")
for r in vrange:
    if r["param_id"] not in ids["param"]: fail(1, f"validation_ranges {r['validation_id']}: 파라미터 없음")
for r in vparams:
    if r["variable_id"] and r["variable_id"] not in ids["variable"]: fail(1, f"virtual_params {r['param_id']}: 변수 {r['variable_id']} 없음")
    if r["primary_data_id"] and r["primary_data_id"] not in ids["data"]: fail(1, f"virtual_params {r['param_id']}: 데이터 {r['primary_data_id']} 없음")

# 2. 인터뷰 전용 변수는 variable_data_map 에 없어야 함
mapped = {r["variable_id"] for r in vmap}
only = {r["variable_id"] for r in variables if r["data_scope"] == "interview_only"}
for v in only & mapped: fail(2, f"인터뷰 전용 변수 {v} 가 variable_data_map 에 있음")
notes.append(f"인터뷰 전용 변수 {len(only)}개")

# 3. 세계 연결 변수는 모두 map 에 있고 data_sources 에 존재
linked = {r["variable_id"] for r in variables if r["data_scope"] == "world_linked"}
for v in linked - mapped: fail(3, f"world_linked 변수 {v} 가 variable_data_map 에 없음")
notes.append(f"세계 연결 변수 {len(linked)}개 / map 행 {len(vmap)}")

# 4. 코드는 enums 안에서만
def inenum(group, val, where):
    if val not in ENUM.get(group, set()): fail(4, f"{where}: '{val}' 은 enums.{group} 에 없음")
for r in dsrc: inenum("judgement", r["judgement"], f"data_sources {r['data_id']}")
for r in variables:
    inenum("variable_category", r["category_code"], f"variables {r['variable_id']}")
    inenum("data_scope", r["data_scope"], f"variables {r['variable_id']}")
for r in cases: inenum("applies_to", r["applies_to"], f"cases {r['case_id']}")
for r in links: inenum("link_type", r["link_type"], f"evidence_links {r['link_id']}")
for r in vparams:
    inenum("value_origin", r["value_origin"], f"virtual_params {r['param_id']}")
    inenum("action", r["action"], f"virtual_params {r['param_id']}")
    if r["support_grade"]: inenum("support_grade", r["support_grade"], f"virtual_params {r['param_id']}")
for r in fdefs: inenum("role", r["role"], f"field_defs {r['table_name']}.{r['column_en']}")
for r in prods:
    inenum("product_category", r["category_code"], f"entity_product {r['product_id']}")
    if r["main_vendor_id"]: inenum("vendor", r["main_vendor_id"], f"entity_product {r['product_id']}")
for t in ("payment_daily", "supply_daily"):
    for r in load(f"3_virtual/tables/{t}.csv"): inenum("vendor", r["vendor_id"], t)
for r in load("3_virtual/tables/inventory_daily.csv"):
    if r["product_id"] not in ids["product"]: fail(4, f"inventory_daily: product_id {r['product_id']} 가 entity_product 에 없음"); break

# 5. virtual_params: 출처·등급 필수, 가정은 A 불가
for r in vparams:
    if r["value_origin"] != "decision" and not r["support_grade"]:
        fail(5, f"virtual_params {r['param_id']} {r['label_ko']}: support_grade 비어 있음")
    if r["value_origin"] == "assumption" and r["support_grade"] == "A":
        fail(5, f"virtual_params {r['param_id']} {r['label_ko']}: 가정(assumption)은 등급 A 가 될 수 없음")
    if not r["grade_reason_ko"] and r["value_origin"] != "decision":
        fail(5, f"virtual_params {r['param_id']}: grade_reason_ko 비어 있음")

# 6. 프로필 속성을 virtual_params 에서 중복 정의하지 않음 (profile_ref 로만 참조)
pkeys = {r["key"] for r in profile if r["kind"] == "fact"}
for r in vparams:
    if r["profile_ref"] and r["profile_ref"] not in pkeys:
        fail(6, f"virtual_params {r['param_id']}: profile_ref={r['profile_ref']} 가 persona_profile 에 없음")
    if r["profile_ref"] and r["action"] not in ("regenerate_with_profile", "keep"):
        fail(6, f"virtual_params {r['param_id']}: profile_ref 가 있는 값의 action 이 부적절({r['action']})")

# 7. 변환 파일에는 출처 열 3개
for rel in ["1_interview/claims.csv", "1_interview/variables.csv", "1_interview/rules.csv", "1_interview/persona_profile.csv",
            "1_interview/guardrails.csv", "1_interview/cases.csv", "2_world/data_sources.csv", "3_virtual/virtual_params.csv",
            "3_virtual/field_defs.csv"] + [f"3_virtual/tables/{t}.csv" for t in TABLES]:
    miss = {"source_file", "source_sheet", "generated_at"} - set(cols(rel))
    if miss: fail(7, f"{rel}: 출처 열 {sorted(miss)} 없음")

# 8. 열 이름 snake_case, DT_ 형식, field_defs 와 표 열 일치
snake = re.compile(r"^[a-z][a-z0-9_]*$")
for p in D.rglob("*.csv"):
    for c in cols(str(p.relative_to(D))):
        if not snake.match(c): fail(8, f"{p.relative_to(D)}: 열 이름 '{c}' 가 snake_case 아님")
for r in dsrc:
    if not re.match(r"^DT_L\d{2}$", r["data_id"]): fail(8, f"data_sources: data_id {r['data_id']} 형식 오류")
defs = {}
for r in fdefs: defs.setdefault(r["table_name"], set()).add(r["column_en"])
for t, path in TABLES.items():
    actual = set(cols(f"3_virtual/tables/{t}.csv")) - {"source_file", "source_sheet", "generated_at"}
    if actual != defs.get(t, set()):
        fail(8, f"field_defs vs tables/{t}.csv: 차이 {sorted(actual ^ defs.get(t, set()))}")

if "--json" in sys.argv:
    import json
    out = []
    for e in errors:
        m = re.match(r"\[(\d)\] (.*)", e)
        out.append({"check": int(m.group(1)), "msg": m.group(2)})
    print(json.dumps({"errors": out, "notes": notes}, ensure_ascii=False))
    sys.exit(1 if errors else 0)
for n in notes: print("  ·", n)
if errors:
    print(f"\n실패 {len(errors)}건")
    for e in errors[:80]: print("  ✗", e)
    sys.exit(1)
print("\n8개 검사 모두 통과")
