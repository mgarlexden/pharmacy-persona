#!/usr/bin/env python3
"""CSV -> 점검 화면(viewer/index.html) 한 파일. 실행: python scripts/build_viewer.py
브라우저에서 viewer/index.html 을 열면 됩니다. CSV 를 고친 뒤에는 다시 실행하세요."""
import csv, json, subprocess, sys, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
D = ROOT / "data"


def load(rel):
    with open(D / rel, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


claims = load("1_interview/claims.csv"); variables = load("1_interview/variables.csv"); rules = load("1_interview/rules.csv")
profile = load("1_interview/persona_profile.csv"); guards = load("1_interview/guardrails.csv"); links = load("1_interview/evidence_links.csv")
dsrc = load("2_world/data_sources.csv"); keys = load("2_world/key_registry.csv"); vmap = load("2_world/variable_data_map.csv")
vparams = load("3_virtual/virtual_params.csv"); fdefs = load("3_virtual/field_defs.csv")
fmap = load("4_bridge/field_map.csv"); vrange = load("5_validation/validation_ranges.csv"); prods = load("0_common/entity_product.csv")
enums = load("0_common/enums.csv")

# 구조 검증 결과
res = subprocess.run([sys.executable, str(ROOT / "scripts/validate.py"), "--json"], capture_output=True, text=True, encoding="utf-8")
vj = json.loads(res.stdout)
CHECK_TITLES = ["모든 참조 ID가 대상 파일에 있는가", "인터뷰 전용 변수가 variable_data_map에 없는가",
                "세계 연결 변수가 모두 data_sources와 이어지는가", "코드값이 enums 안에 있는가",
                "가상값마다 값 성격·등급이 있고 가정이 A가 아닌가", "프로필 속성을 virtual_params에서 따로 정의하지 않는가",
                "변환 파일에 출처 열 3개가 있는가", "열 이름 snake_case · DT_ 형식 · field_defs 일치"]
checks = [{"n": i + 1, "title": t, "msgs": [e["msg"] for e in vj["errors"] if e["check"] == i + 1]} for i, t in enumerate(CHECK_TITLES)]

# 색인
def group(rows, k, v, typ=None):
    g = {}
    for r in rows:
        if typ is None or r["link_type"] == typ:
            g.setdefault(r[k], []).append(r[v])
    return g

claims_of_var = group(links, "to_id", "from_id", "claim_supports_variable")
claims_of_rule = group(links, "to_id", "from_id", "claim_supports_rule")
vars_of_rule = group(links, "from_id", "to_id", "rule_uses_variable")
rules_of_var = group(links, "to_id", "from_id", "rule_uses_variable")
claims_of_pf = group(links, "from_id", "to_id", "profile_cites_claim")
vars_of_pf = group(links, "from_id", "to_id", "profile_uses_variable")
claims_of_g = group(links, "from_id", "to_id", "guardrail_cites_claim")
data_of_var = {}
used_by_data = {}
for r in vmap:
    data_of_var.setdefault(r["variable_id"], []).append(r["data_id"])
    used_by_data.setdefault(r["data_id"], []).append(r["variable_id"])
keys_of_data = {}
for r in keys:
    keys_of_data.setdefault(r["data_id"], []).append(r["key_id"])
params_of_var = {}
for p in vparams:
    if p["variable_id"]:
        params_of_var.setdefault(p["variable_id"], []).append(p["param_id"])
fields_of_var = {}
for r in fmap:
    fields_of_var.setdefault(r["variable_id"], []).append({"key": r["field_key"], "table": r["source_table"], "col": r["source_column"]})
valid_of_param = {r["param_id"]: r for r in vrange}
pgrade = {p["param_id"]: p["support_grade"] for p in vparams}
CAT_KO = {}
for v in variables:
    CAT_KO[v["category_code"]] = v["category_ko"].split(" ", 1)[1] if " " in v["category_ko"] else v["category_ko"]

out_vars = []
for v in variables:
    vid = v["variable_id"]
    cl, dt, ps = claims_of_var.get(vid, []), data_of_var.get(vid, []), params_of_var.get(vid, [])
    bad = not cl or (v["data_scope"] == "world_linked" and not dt)
    weak = any(pgrade[p] == "C" for p in ps)
    out_vars.append(dict(id=vid, label=v["label_ko"], cat=v["category_code"], catKo=CAT_KO[v["category_code"]], scope=v["data_scope"],
                         scopeNote=v["data_scope_note"], finding=v["interview_finding_ko"], implName=v["impl_name"], fmt=v["value_format"],
                         claims=cl, data=dt, params=ps, fields=fields_of_var.get(vid, []), rules=rules_of_var.get(vid, []),
                         status="bad" if bad else "weak" if weak else "ok"))

out_data = []
for d in dsrc:
    out_data.append(dict(id=d["data_id"], item=d["item_ko"], area=d["area_ko"], judgement=d["judgement"], provider=d["provider"],
                         dataset=d["dataset_name"], access=d["access_method"], format=d["format"], spatial=d["spatial_unit"],
                         time=d["time_unit"], period=d["period"], refresh=d["refresh_cycle"], keyText=d["key_text"],
                         keys=keys_of_data.get(d["data_id"], []), usedBy=used_by_data.get(d["data_id"], []), check=d["check_status"],
                         how=d["how_to_get"]))

out_params = []
for p in vparams:
    vr = valid_of_param.get(p["param_id"])
    out_params.append(dict(id=p["param_id"], label=p["label_ko"], value=p["value_text"], unit=p["unit"], origin=p["value_origin"],
                           grade=p["support_grade"], reason=p["grade_reason_ko"], basis=p["basis_ko"], usedIn=p["used_in"],
                           dataId=p["primary_data_id"], variable=p["variable_id"], linkStatus=p["variable_link_status"],
                           profileRef=p["profile_ref"], action=p["action"],
                           validation={"question": vr["question_ko"], "status": vr["status"]} if vr else None))


# 파일 안내 (path: 역할 종류, 하는 일, 담고 있는 것, 가리키는 곳 → 가리켜지는 곳, 원본)
FILES = [
 ("0_common/enums.csv", "사전", "모든 파일이 쓰는 코드값 목록", "판정(실/참고/가상), 값 성격, 등급 A·B·C, 변수 범주, 연결 종류, 품목 구분, 거래처 3곳 등 허용되는 값과 한글 뜻", "다른 모든 파일의 코드 열이 이 목록에서 값을 찾음", "스크립트 초안 후 CSV 직접 편집"),
 ("0_common/entity_product.csv", "사전", "품목 마스터", "품목 32개(전문약 7, 일반약 등). 이름, 구분, 단위, 주 거래처, 실제 의약품 코드 자리(item_seq, edi13)", "inventory_daily 의 product_id 가 여기를 가리킴", "더미 L48·L56 + CSV 직접 편집"),
 ("1_interview/claims.csv", "내용", "인터뷰에서 약사가 한 말의 원장", "발언 98건. 주제, 적용 대상, 원문 발췌, 정리한 내용, 원문 줄번호", "evidence_links 가 이 ID(E###, U###)를 가리킴", "interview_master.xlsx 01_근거대장"),
 ("1_interview/variables.csv", "사전·중심", "페르소나를 구성하는 변수 85개. 인터뷰 쪽과 데이터 쪽을 잇는 허브", "변수 ID, 범주 6가지, 이름, 인터뷰에서 파악한 내용, 데이터 연결 여부(세계 연결/인터뷰 전용), slice1", "variable_data_map, evidence_links, field_map, virtual_params 가 변수 ID를 가리킴", "interview_master.xlsx 02_변수사전 + 분류표 변수 대조"),
 ("1_interview/persona_profile.csv", "내용", "인터뷰 약국의 프로필", "서술 13행(주변 의료기관, 자금·재고 등)과 확인된 사실값 5행(2층, 개업 3주차, 약사 2인 등)", "evidence_links 가 프로필 ID(PF##)로 근거와 변수를 이음. virtual_params 의 profile_ref 가 가리킴", "interview_master.xlsx 06_페르소나정리 + 사실값"),
 ("1_interview/rules.csv", "내용", "운영자의 판단 규칙 R01~R18", "상황, 확인하는 정보, 운영자의 판단 방식, 발언 성격(현재 행동·원칙·제안 반응)", "evidence_links 가 규칙 ID를 가리킴", "interview_master.xlsx 03_규칙대장"),
 ("1_interview/evidence_links.csv", "연결", "발언·규칙·변수·프로필 사이의 연결을 한 줄씩 적은 표", "연결 366줄. 종류 6가지(발언→변수, 발언→규칙, 규칙→변수, 프로필→변수, 프로필→발언, 가드레일→발언)", "from_id/to_id 가 claims, variables, rules, persona_profile, guardrails 의 ID를 가리킴", "위 파일들의 ID 열에서 자동 생성"),
 ("1_interview/guardrails.csv", "내용", "에이전트가 지켜야 할 주의 규칙 G01~G07", "현재·과거 구분, 없는 수량 만들지 않기, 생성 결과와 관측 결과 분리 등 7개와 적용 시점", "evidence_links 가 가드레일 ID를 가리킴", "interview_extension.xlsx 04_RAG주의"),
 ("1_interview/cases.csv", "내용", "판단 에이전트가 참고할 사례 기록 I01~I19", "실행 회고·기대-결과 회고·설명용 가정·제안 반응 등으로 구분된 상황·계기·고려한 것·실제 행동·결과·알게 된 점", "evidence_links 가 사례 ID를 가리킴 (case_cites_claim, case_illustrates_rule)", "interview_master.xlsx 04_사건학습"),
 ("2_world/data_sources.csv", "사전", "공개·참고·가상 데이터 63종의 명세서", "제공처, 접근 방법, 공간·시간 단위, 판정(실/참고/가상), 연결 키 문장, 받는 방법. 실제 값은 없음", "variable_data_map, key_registry, virtual_params 가 데이터 ID(DT_L##)를 가리킴", "data_classification.xlsx 1_상세 조사 + 2_데이터 목록"),
 ("2_world/key_registry.csv", "사전·연결", "데이터를 서로 잇는 열쇠(시군구, 요양기관기호 등)와 그 사용처", "표준 키 20종이 어느 데이터에 쓰이는지 107줄", "data_id 로 data_sources 를 가리킴", "연결 키 문장에서 자동 추출"),
 ("2_world/variable_data_map.csv", "연결", "변수와 데이터의 연결표", "변수 51개가 어느 데이터 ID와 이어지는지 88줄. 인터뷰 전용 변수 34개는 없음", "variable_id → variables, data_id → data_sources", "data_classification.xlsx 3_변수 대조"),
 ("3_virtual/virtual_params.csv", "내용·검증", "가상값의 출처 대장", "가상값 44개의 값, 값 성격(실측·파생·가정·인터뷰·결정), 근거 등급, 등급 이유, 대표 변수, 조치", "variable_id → variables, primary_data_id → data_sources, profile_ref → persona_profile", "virtual_dummy.xlsx 파라미터 + 등급(직접 편집)"),
 ("3_virtual/field_defs.csv", "사전", "시계열 표 7개의 열 정의", "열의 영어 이름, 한글 이름, 타입, 단위, 허용 범위, 입력/파생 구분", "table_name 이 tables/ 폴더의 파일 이름과 같음", "virtual_dummy.xlsx 필드정의 + 영어 이름"),
 ("3_virtual/tables/calendar.csv", "내용", "날짜별 공통 달력", "365일의 요일, 공휴일, 영업 여부, 연휴 전후, 이비인후과 휴진, 인플루엔자 지수, 호흡기 처방지수", "다른 시계열이 date 열로 이 표를 찾음", "virtual_dummy.xlsx 00_공통달력"),
 ("3_virtual/tables/rx_daily.csv", "내용", "날짜별 처방 건수와 조제료", "내과·이비인후과 처방건수, 조제료, 약품비, 본인부담금 (365일)", "date → calendar", "virtual_dummy.xlsx L45"),
 ("3_virtual/tables/otc_hourly.csv", "내용", "시간대별 일반약 판매", "구매자 수, 판매 수량·금액, 품목군별 수량, 품절로 못 판 수량 (2,690행)", "date → calendar", "virtual_dummy.xlsx L47"),
 ("3_virtual/tables/inventory_daily.csv", "내용", "품목별 날짜별 재고", "실물·전산 재고, 입고, 사용량, 결품, 잔여일수, 발주 수량·구분, 실제 공급 수량 (4,745행)", "product_id → entity_product, date → calendar", "virtual_dummy.xlsx L48"),
 ("3_virtual/tables/cash_daily.csv", "내용", "날짜별 현금 여력", "현금 수입, 카드·공단 입금, 도매 결제 지출, 고정비, 기말 현금, 미지급 대금, 현금 여력일수", "date → calendar", "virtual_dummy.xlsx L49"),
 ("3_virtual/tables/payment_daily.csv", "내용", "거래처별 결제 주기", "결제 조건, 금융비용 할인 구간과 할인율, 매입액, 결제액, 미지급 잔액 (거래처 3곳 × 365일)", "vendor_id → enums(vendor), date → calendar", "virtual_dummy.xlsx L50"),
 ("3_virtual/tables/supply_daily.csv", "내용", "거래처별 공급 조건과 주문 가능 상태", "배송 조건, 주문 마감, 최소 주문금액, 주문·결품 라인 수, 결품률, 공급부족 품목 (거래처 3곳 × 365일)", "vendor_id → enums(vendor), date → calendar", "virtual_dummy.xlsx L52"),
 ("4_bridge/field_map.csv", "연결", "데이터 열을 시뮬레이터 상태 칸에 대응시키는 표 (초안)", "시뮬레이터 필드 이름, 어느 표의 어느 열에서 오는지, 대응 변수, 변환 메모", "variable_id → variables, source_table/source_column → 3_virtual/tables", "CSV 직접 편집 (초안)"),
 ("4_bridge/scenarios.csv", "내용", "시나리오 정의 (제안 단계)", "감기·독감 + 휴진 + 도매 품절 + 신규약국 현금 제약 → 발주 판단. 설정 순서와 대상", "target_id → variables / virtual_params / rules", "CSV 직접 편집 (초안)"),
 ("5_validation/validation_ranges.csv", "검증", "약사에게 확인할 값과 질문", "등급 B·C 가상값 30개의 질문 문장. 허용 오차(tolerance_pct)와 응답 상태는 비어 있음", "param_id → virtual_params", "virtual_params 에서 자동 초안 + CSV 직접 편집"),
]

# 시계열
prod_ids = {r["product_id"] for r in prods}
out_tables, tables_ok = [], 0
fd_by = {}
for r in fdefs:
    fd_by.setdefault(r["table_name"], {})[r["column_en"]] = r
PROVC = {"source_file", "source_sheet", "generated_at"}
for path in sorted((D / "3_virtual/tables").glob("*.csv")):
    with open(path, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    name = path.stem
    cols, issues = [], 0
    for c in [c for c in rows[0].keys() if c not in PROVC]:
        vals = [r[c] for r in rows]
        nonempty = [x for x in vals if x != ""]
        nums = [num(x) for x in nonempty]
        numeric = bool(nonempty) and all(n is not None for n in nums)
        amin = amax = ""
        if numeric:
            amin, amax = min(nums), max(nums)
            amin, amax = (int(amin) if amin == int(amin) else round(amin, 4)), (int(amax) if amax == int(amax) else round(amax, 4))
        elif c == "date" and nonempty:
            amin, amax = min(nonempty), max(nonempty)
        fd = fd_by.get(name, {}).get(c)
        issue = ""
        if not fd:
            issue = "열 정의 없음"
        else:
            dmin, dmax = num(fd["min_value"]), num(fd["max_value"])
            if numeric and dmin is not None and amin < dmin: issue = "정의 최소보다 작음"
            if numeric and dmax is not None and amax > dmax: issue = "정의 최대보다 큼"
        if c == "product_id" and any(x not in prod_ids for x in nonempty): issue = "entity_product에 없는 품목"
        issues += bool(issue)
        cols.append(dict(en=c, ko=fd["column_ko"] if fd else "", type=fd["data_type"] if fd else "", unit=fd["unit"] if fd else "",
                         role=fd["role"] if fd else "", dmin=fd["min_value"] if fd else "", dmax=fd["max_value"] if fd else "",
                         amin=amin, amax=amax, nulls=len(vals) - len(nonempty), issue=issue))
    dates = [r["date"] for r in rows if r.get("date")]
    tables_ok += issues == 0
    out_tables.append(dict(name=name, rows=len(rows), cols=cols, issues=issues, sheet=rows[0]["source_sheet"],
                           span=f"{min(dates)} ~ {max(dates)}" if dates else "", preview=[{c["en"]: r[c["en"]] for c in cols} for r in rows[:10]]))

out_rules = [dict(id=r["rule_id"], title=r["title_ko"], type=r["statement_type"], claims=claims_of_rule.get(r["rule_id"], []),
                  vars=vars_of_rule.get(r["rule_id"], [])) for r in rules]
out_guards = [dict(id=g["guardrail_id"], rule=g["rule_ko"], at=g["applies_at"], check=g["check_type"], claims=claims_of_g.get(g["guardrail_id"], [])) for g in guards]
out_profile = [dict(id=p["profile_id"], kind=p["kind"], section=p["section_ko"], key=p["key"], value=p["value"], unit=p["unit"],
                    summary=p["summary_ko"], claims=claims_of_pf.get(p["profile_id"], []), vars=vars_of_pf.get(p["profile_id"], [])) for p in profile]


PROVC2 = {"source_file", "source_sheet", "generated_at"}
out_files = []
for path, kind, what, has, refs, src in FILES:
    with open(D / path, encoding="utf-8-sig", newline="") as f:
        frows = list(csv.DictReader(f))
    cols = list(frows[0].keys()) if frows else []
    prev = [{c: (r[c][:70] + "…" if len(r[c]) > 70 else r[c]) for c in cols if c not in PROVC2} for r in frows[:5]]
    out_files.append(dict(path=path, folder=path.split("/")[0], name=path.split("/")[-1], kind=kind, what=what, has=has, refs=refs,
                          src=src, rows=len(frows), cols=[c for c in cols if c not in PROVC2], prov=any(c in PROVC2 for c in cols), preview=prev))
assert len(out_files) == 24 and len(list((D).rglob("*.csv"))) == 24, "FILES 목록과 실제 CSV 수가 다름"

need_grade = [p for p in vparams if p["value_origin"] != "decision"]
unused = [d["data_id"] for d in dsrc if d["data_id"] not in used_by_data]
nokey = [d["data_id"] for d in dsrc if d["data_id"] not in keys_of_data and d["key_text"]]
no_var_params = [p["label_ko"] for p in vparams if not p["variable_id"]]
cand = sum(1 for p in vparams if p["variable_link_status"] == "candidate")
c_grade = sum(1 for p in vparams if p["support_grade"] == "C")
todo = []
if unused: todo.append(f"변수와 이어지지 않은 데이터 <b>{len(unused)}개</b> ({', '.join(x[3:] for x in unused)}). 분모나 검증 기준값처럼 의도된 것인지 확인하세요.")
if cand: todo.append(f"가상값의 대표 변수 <b>{cand}개</b>가 후보 상태입니다. 확인하면 variable_link_status를 confirmed로 바꾸세요. 변수가 없는 가상값: {', '.join(no_var_params)}")
if c_grade: todo.append(f"등급 C 가상값 <b>{c_grade}개</b>는 근거가 약해 약사 검증의 우선 대상입니다. 허용 오차(tolerance_pct)는 아직 비어 있습니다.")
if nokey: todo.append(f"연결 키 문장은 있으나 표준 키가 추출되지 않은 데이터 <b>{len(nokey)}개</b> ({', '.join(x[3:] for x in nokey)}).")
slice_n = sum(1 for v in variables if v["slice1"])
todo.append(f"슬라이스 변수로 표시된 변수 <b>{slice_n}개</b> (목표 15~20개). variables.csv의 slice1 열에 표시합니다.")
nocode = sum(1 for r in prods if not r["item_seq"])
todo.append(f"실제 의약품 코드(item_seq)가 비어 있는 품목 <b>{nocode}개</b>.")
drafts = sum(1 for r in fmap if r["status"] == "draft")
todo.append(f"초안 상태의 시뮬레이터 필드 대응 <b>{drafts}행</b>(field_map)과 시나리오 제안 <b>{len(set(r['scenario_id'] for r in load('4_bridge/scenarios.csv')))}개</b>.")

summary = dict(vars=len(variables), varsWithClaim=sum(1 for v in out_vars if v["claims"]), rules=len(rules),
               rulesWithClaim=sum(1 for r in out_rules if r["claims"]), data=len(dsrc), dataUsed=len(dsrc) - len(unused),
               params=len(vparams), paramsNeedGrade=len(need_grade), paramsGraded=sum(1 for p in need_grade if p["support_grade"]),
               paramsLinked=len(vparams) - len(no_var_params), tables=len(out_tables), tablesOk=tables_ok, todo=todo)

payload = dict(generatedAt=datetime.datetime.now().strftime("%Y-%m-%d %H:%M"), checks=checks, summary=summary,
               counts=f"변수 {len(variables)} · 근거 {len(claims)} · 규칙 {len(rules)} · 데이터 {len(dsrc)} · 가상값 {len(vparams)}",
               claims={c["claim_id"]: dict(topic=c["topic_ko"], quote=c["quote_ko"], loc=c["source_location"]) for c in claims},
               categories=[[k, v] for k, v in CAT_KO.items()], areas=list(dict.fromkeys(d["area_ko"] for d in dsrc)),
               files=out_files, variables=out_vars, data=out_data, params=out_params, tables=out_tables, rules=out_rules, guardrails=out_guards, profile=out_profile)

tpl = (ROOT / "scripts/viewer_template.html").read_text(encoding="utf-8")
js = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
fragment = tpl.replace("/*DATA*/null;", js + ";\nD.dataById=Object.fromEntries(D.data.map(x=>[x.id,x]));\nD.paramById=Object.fromEntries(D.params.map(x=>[x.id,x]));\nD.ruleById=Object.fromEntries(D.rules.map(x=>[x.id,x]));", 1)
assert "/*DATA*/" not in fragment
full = ('<!doctype html>\n<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>\n'
        + fragment + "\n</body></html>\n")
(ROOT / "viewer").mkdir(exist_ok=True)
(ROOT / "viewer/index.html").write_text(full, encoding="utf-8")
(ROOT / "viewer/.fragment.html").write_text(fragment, encoding="utf-8")   # 아티팩트 게시용 (doctype 없음)
print(f"viewer/index.html 생성 ({len(full)//1024} KB) · 구조 검증 {'통과' if not vj['errors'] else '실패 ' + str(len(vj['errors']))}")
