#!/usr/bin/env python3
"""Excel 원본(source/) -> CSV(data/) 변환 스크립트.

- 1_interview, 2_world, 3_virtual 은 Excel 이 원본이다. 이 스크립트가 CSV 로 바꾼다.
- 사람이 CSV 에서 직접 채우는 열(AUTHORED)은 다시 실행해도 보존된다(키 기준 병합).
- 0_common, 4_bridge, 5_validation 은 CSV 가 원본이다. 이 스크립트는 파일이 없을 때 초안만 만든다.
실행:  python scripts/build.py
"""
import csv, re, datetime, sys
from pathlib import Path
import openpyxl

ROOT = Path(__file__).resolve().parents[1]
SRC, DATA = ROOT / "source", ROOT / "data"
NOW = datetime.datetime.now().strftime("%Y-%m-%dT%H:%M")
PHARMACY_ID = "PH_DUMMY_01"          # 가상 약국. 인터뷰 약국으로 재생성하면 PH_INTERVIEW_01 등으로 교체
PROV = ["source_file", "source_sheet", "generated_at"]


# ───────────────────────── 공통 도구 ─────────────────────────
def clean(v):
    if v is None:
        return ""
    if isinstance(v, datetime.datetime):
        return v.strftime("%Y-%m-%d")
    if isinstance(v, float):
        return str(int(v)) if v == int(v) else repr(round(v, 6))
    return str(v).replace("\r", "").strip()


def sheet_rows(xlsx, sheet, header_row, first_row=None, id_col=0):
    """header_row 다음부터, id_col 이 비어 있지 않은 행만 dict 목록으로."""
    ws = openpyxl.load_workbook(SRC / xlsx, data_only=True)[sheet]
    first_row = first_row or header_row + 1
    rows = list(ws.iter_rows(min_row=first_row, values_only=True))
    return [[clean(c) for c in r] for r in rows if r and r[id_col] not in (None, "")]


def write(rel, rows, cols, key=None, authored=(), defaults=None):
    """CSV 를 쓴다. authored 열은 기존 파일에 값이 있으면 보존한다."""
    path = DATA / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    old = {}
    if key and authored and path.exists():
        with open(path, encoding="utf-8-sig", newline="") as f:
            for r in csv.DictReader(f):
                old[r[key]] = r
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore", lineterminator="\n")
        w.writeheader()
        for r in rows:
            r = dict(r)
            if key and r.get(key) in old:
                for c in authored:
                    if old[r[key]].get(c, "") != "":
                        r[c] = old[r[key]][c]
            w.writerow({c: r.get(c, "") for c in cols})
    print(f"  {rel}  ({len(rows)}행)")


def prov(file, sheet):
    return {"source_file": file, "source_sheet": sheet, "generated_at": NOW}


def expand_ids(text):
    """'P001, S002 L001~L003' -> ['P001','S002','L001','L002','L003']"""
    out = []
    for m in re.finditer(r"([A-Z])(\d+)(?:\s*[~∼-]\s*(?:[A-Z])?(\d+))?", text or ""):
        p, a, b = m.group(1), m.group(2), m.group(3)
        if b:
            for n in range(int(a), int(b) + 1):
                out.append(f"{p}{n:0{len(a)}d}")
        else:
            out.append(f"{p}{a}")
    return list(dict.fromkeys(out))


CATEGORY = {"1": "fixed_attribute", "2": "structural_constraint", "3": "internal_state",
            "4": "external_trigger", "5": "decision_rule", "6": "outcome_learning"}
MASTER, EXT, CLS, DUMMY = "interview_master.xlsx", "interview_extension.xlsx", "data_classification.xlsx", "virtual_dummy.xlsx"

links = {}   # (from, to, type) -> set(출처)


def link(a, b, t, src):
    if a and b:
        links.setdefault((a, b, t), set()).add(src)


# ───────────────────────── 1_interview ─────────────────────────
def build_interview():
    print("[1_interview]")
    # claims
    claims = sheet_rows(MASTER, "01_근거대장", 5)
    out = []
    for r in claims:
        out.append(dict(claim_id=r[0], topic_ko=r[1], applies_to=r[2], record_type=r[3], quote_ko=r[4],
                        summary_ko=r[5], source_location=r[7], **prov(MASTER, "01_근거대장")))
        for t in expand_ids(r[6]):
            tt = "claim_supports_rule" if t[0] == "R" else "claim_supports_variable"
            if t[0] != "I":
                link(r[0], t, tt, "claims.연결 항목")
    write("1_interview/claims.csv", out, ["claim_id", "topic_ko", "applies_to", "record_type", "quote_ko",
          "summary_ko", "source_location"] + PROV)

    # variables  (+ 변수 대조의 data_scope)
    scope = {r[0]: (r[3], r[4]) for r in sheet_rows(CLS, "3_변수 대조", 4)}
    out = []
    for r in sheet_rows(MASTER, "02_변수사전", 5):
        s = scope.get(r[0], ("", ""))
        linked = s[0] == "목록 반영"
        out.append(dict(variable_id=r[0], category_code=CATEGORY[r[1][0]], category_ko=r[1], label_ko=r[2],
                        interview_finding_ko=r[3], usage_note_ko=r[4], applies_to=r[6], impl_name=r[7],
                        value_format=r[8], data_scope="world_linked" if linked else "interview_only",
                        data_scope_note="" if linked else s[1], slice1="", **prov(MASTER, "02_변수사전")))
        for c in expand_ids(r[5]):
            link(c, r[0], "claim_supports_variable", "variables.근거 ID")
    VARS = {o["variable_id"]: o for o in out}
    write("1_interview/variables.csv", out, ["variable_id", "category_code", "category_ko", "label_ko",
          "interview_finding_ko", "usage_note_ko", "applies_to", "impl_name", "value_format", "data_scope",
          "data_scope_note", "slice1"] + PROV, key="variable_id", authored=["slice1"])

    # rules
    out = []
    for r in sheet_rows(MASTER, "03_규칙대장", 5):
        out.append(dict(rule_id=r[0], title_ko=r[1], statement_type=r[2], situation_ko=r[3], info_considered_ko=r[4],
                        judgement_ko=r[5], reading_note_ko=r[6], **prov(MASTER, "03_규칙대장")))
        for c in expand_ids(r[7]):
            link(c, r[0], "claim_supports_rule", "rules.근거 ID")
        for v in expand_ids(r[8]):
            link(r[0], v, "rule_uses_variable", "rules.연결 변수")
    write("1_interview/rules.csv", out, ["rule_id", "title_ko", "statement_type", "situation_ko",
          "info_considered_ko", "judgement_ko", "reading_note_ko"] + PROV)

    # persona_profile : 06 서술 + 확인된 사실값
    out, n = [], 0
    for r in sheet_rows(MASTER, "06_페르소나정리", 5):
        n += 1
        pid = f"PF{n:02d}"
        out.append(dict(profile_id=pid, kind="narrative", section_ko=r[0], key="", value="", unit="",
                        summary_ko=r[1], detail_ko=r[2], **prov(MASTER, "06_페르소나정리")))
        for v in expand_ids(r[3]):
            link(pid, v, "profile_uses_variable", "persona_profile.연결 변수")
        for c in expand_ids(r[4]):
            if c[0] in "EU":
                link(pid, c, "profile_cites_claim", "persona_profile.근거·사례")
    facts = [  # key, value, unit, variable_id, 설명
        ("pharmacy.floor", "2", "층", "P001", "약국이 있는 층"),
        ("pharmacy.operating_age", "3", "주", "P002", "인터뷰 당시 개업 후 경과"),
        ("pharmacy.opened_on", "2026-09-09", "date", "P002", "개업일(E001)"),
        ("pharmacy.pharmacist_count", "2", "명", "P004", "운영 약사 수"),
        ("pharmacy.otc_buyers_per_day", "10~15", "명/일", "S013", "응답자 표현. 근사 범위"),
    ]
    for k, val, unit, var, note in facts:
        n += 1
        pid = f"PF{n:02d}"
        out.append(dict(profile_id=pid, kind="fact", section_ko="확인된 사실값", key=k, value=val, unit=unit,
                        summary_ko=note, detail_ko="", source_file=MASTER, source_sheet="02_변수사전 + 직접 입력",
                        generated_at=NOW))
        link(pid, var, "profile_uses_variable", "persona_profile.fact")
        for (a, b, t) in list(links):
            if t == "claim_supports_variable" and b == var:
                link(pid, a, "profile_cites_claim", "persona_profile.fact(변수의 근거)")
    write("1_interview/persona_profile.csv", out, ["profile_id", "kind", "section_ko", "key", "value", "unit",
          "summary_ko", "detail_ko"] + PROV)

    # guardrails
    GCHECK = {"G01": "scope_field", "G02": "value_origin_and_null", "G03": "no_auto_substitution_basis",
              "G04": "generated_vs_observed", "G05": "latest_statement_wins", "G06": "plan_vs_action",
              "G07": "respondent_scope"}
    out = []
    for r in sheet_rows(EXT, "04_RAG주의", 5):
        out.append(dict(guardrail_id=r[0], rule_ko=r[1], applies_at=r[2], handling_ko=r[3], distinguish_ko=r[4],
                        check_type=GCHECK.get(r[0], ""), **prov(EXT, "04_RAG주의")))
        for c in expand_ids(r[5]):
            link(r[0], c, "guardrail_cites_claim", "guardrails.근거")
    write("1_interview/guardrails.csv", out, ["guardrail_id", "rule_ko", "applies_at", "handling_ko",
          "distinguish_ko", "check_type"] + PROV)

    # cases (04_사건학습, I01~I19)
    out = []
    for r in sheet_rows(MASTER, "04_사건학습", 5):
        out.append(dict(case_id=r[0], title_ko=r[1], applies_to=r[2], record_type=r[3], situation_ko=r[4],
                        trigger_ko=r[5], considered_ko=r[6], response_ko=r[7], outcome_ko=r[8], learning_ko=r[9],
                        **prov(MASTER, "04_사건학습")))
        for c in expand_ids(r[10]):
            if c[0] in "EU":
                link(r[0], c, "case_cites_claim", "cases.근거 ID")
        for t in expand_ids(r[11]):
            if t[0] == "R":
                link(r[0], t, "case_illustrates_rule", "cases.연결 규칙")
    write("1_interview/cases.csv", out, ["case_id", "title_ko", "applies_to", "record_type", "situation_ko",
          "trigger_ko", "considered_ko", "response_ko", "outcome_ko", "learning_ko"] + PROV)

    # evidence_links (long format, 한 줄 = 연결 하나)
    out = []
    for i, ((a, b, t), s) in enumerate(sorted(links.items(), key=lambda x: (x[0][2], x[0][0], x[0][1])), 1):
        out.append(dict(link_id=f"LK{i:04d}", from_id=a, to_id=b, link_type=t, derived_from=";".join(sorted(s))))
    write("1_interview/evidence_links.csv", out, ["link_id", "from_id", "to_id", "link_type", "derived_from"])
    return VARS


# ───────────────────────── 2_world ─────────────────────────
KEYS = [  # key_id, label, type, 정규 형식, 매칭 정규식
    ("K_SIDO", "시도", "region", "행정표준코드 2자리(서울=11) 또는 시도명", r"시도"),
    ("K_SIGUNGU", "시군구", "region", "행정표준코드 5자리", r"시군구"),
    ("K_ADMDONG", "행정동", "region", "행정동코드 8자리", r"행정동"),
    ("K_BJD", "법정동", "region", "법정동코드 10자리", r"법정동"),
    ("K_ADDR", "주소", "address", "도로명/지번 주소 문자열", r"주소"),
    ("K_COORD", "좌표", "address", "WGS84 위경도", r"좌표|위경도"),
    ("K_YKIHO", "요양기관기호", "entity", "심평원 요양기관기호(암호화본 포함)", r"요양기관기호|ykiho|hpid"),
    ("K_MNGNO", "관리번호", "entity", "인허가 관리번호(MNG_NO)", r"관리번호"),
    ("K_STOREID", "상가업소번호", "entity", "소상공인진흥공단 bizesId", r"상가업소번호|bizesId"),
    ("K_ITEMSEQ", "품목기준코드", "product", "식약처 ITEM_SEQ", r"품목기준코드|ITEM_SEQ"),
    ("K_EDI", "보험/표준 코드", "product", "보험코드 9자리 / 표준코드 13자리", r"보험코드|(?<!행정)표준코드|EDI"),
    ("K_ATC", "약효·성분 분류", "product", "ATC 또는 약효분류 3자리, 주성분코드 9자리", r"ATC|약효분류|주성분코드"),
    ("K_FEECODE", "수가코드", "product", "Z1000 등", r"수가코드"),
    ("K_DATE", "날짜·기간", "time", "YYYY-MM-DD / 연도 / ISO주차", r"날짜|연도|주차|절기"),
    ("K_SCHOOL", "학교·학원 코드", "entity", "학교코드 / 학원지정번호", r"학교 코드|학원 지정번호"),
    ("K_COMPLEX", "아파트 단지", "entity", "단지코드", r"단지코드"),
    ("K_PNU", "필지", "entity", "필지고유번호(PNU)", r"PNU"),
    ("K_INDUSTRY", "업종", "category", "업종명 / 업종코드", r"업종"),
    ("K_STATION", "관측 지점", "entity", "기상 지점번호 / 측정소명 / 특보구역", r"지점번호|측정소|특보구역"),
    ("K_TRADEAREA", "상권", "region", "상권코드", r"상권코드|상권"),
]


def build_world():
    print("[2_world]")
    det = {r[0]: r for r in sheet_rows(CLS, "1_상세 조사", 4)}
    lst = {r[0]: r for r in sheet_rows(CLS, "2_데이터 목록", 4)}
    JMAP = {"실데이터": "real", "참고용": "reference", "가상": "virtual"}
    out, keyrows = [], []
    for did, d in det.items():
        l = lst.get(did, [""] * 10)
        judg = JMAP.get(d[16]) or JMAP.get(l[6], "")
        out.append(dict(data_id=f"DT_{did}", area_ko=d[1], item_ko=d[2], origin_note=l[3], provider=d[4],
                        dataset_name=d[5], judgement=judg, exists_status=d[6], access_method=d[7], format=d[8],
                        spatial_unit=d[9], time_unit=d[10], period=d[11], refresh_cycle=d[12], main_fields=d[13],
                        key_text=d[14], access_limit=d[15], denominator_needed=d[17], simulator_use=d[18],
                        check_status=d[19], link=d[20], remark=d[21], how_to_get=d[22], owner=d[23],
                        publish_lag_days="", **prov(CLS, "1_상세 조사 + 2_데이터 목록")))
        txt = d[14] or ""
        for kid, lab, typ, fmt, rx in KEYS:
            m = re.search(rx, txt)
            if m:
                keyrows.append(dict(key_id=kid, label_ko=lab, key_type=typ, canonical_format=fmt,
                                    data_id=f"DT_{did}", matched_text=m.group(0)))
    write("2_world/data_sources.csv", out, ["data_id", "area_ko", "item_ko", "origin_note", "provider",
          "dataset_name", "judgement", "exists_status", "access_method", "format", "spatial_unit", "time_unit",
          "period", "refresh_cycle", "main_fields", "key_text", "access_limit", "denominator_needed",
          "simulator_use", "check_status", "link", "remark", "how_to_get", "owner", "publish_lag_days"] + PROV,
          key="data_id", authored=["publish_lag_days"])
    keyrows.sort(key=lambda r: (r["key_id"], r["data_id"]))
    write("2_world/key_registry.csv", keyrows, ["key_id", "label_ko", "key_type", "canonical_format", "data_id",
          "matched_text"])
    out = []
    for r in sheet_rows(CLS, "3_변수 대조", 4):
        if r[3] != "목록 반영":
            continue
        for d in expand_ids(r[4]):
            out.append(dict(map_id=f"VM{len(out)+1:03d}", variable_id=r[0], data_id=f"DT_{d}", mapping_note=""))
    write("2_world/variable_data_map.csv", out, ["map_id", "variable_id", "data_id", "mapping_note"])


# ───────────────────────── 3_virtual ─────────────────────────
ORIGIN = {"결정": "decision", "파생": "derived", "실측": "measured", "실측(참고용)": "measured",
          "실측(법령)": "measured", "실측 기반 가정": "assumption", "가정": "assumption",
          "인터뷰": "interview", "인터뷰 기반 가정": "assumption", "재현": "decision"}
# 라벨 -> (등급, 근거, 조치, profile_ref)   등급 규칙: assumption 은 A 가 될 수 없다.
GRADE = {
    "시뮬 기간": ("", "팀 결정값", "keep", ""),
    "영업일": ("A", "2026 공휴일 22일(L17)과 일치 확인", "keep", ""),
    "약국 평균 연매출": ("A", "국세청 공표 통계(L01)", "keep", ""),
    "연매출 중앙값 근처": ("B", "분포를 '8억 근처'로 근사해 읽음", "keep", ""),
    "개설약사 평균 사업소득": ("A", "국세청 공표 통계(L02)", "keep", ""),
    "약국 진료비 중 약품비 비중": ("A", "심평원 공표 통계(L03) 직접 계산", "keep", ""),
    "약국 수": ("A", "건보공단 2025-12-31 기준값(L04)", "keep", ""),
    "3일분 조제료": ("A", "수가 점수 × 환산지수(L05)", "keep", ""),
    "일수별 조제료(5·7·15·30·31+일)": ("B", "3일분 실측값 기준 가산 근사. L05 원표로 교체 필요", "replace_with_real", ""),
    "내과 평일 기본 처방건수": ("B", "전국 평균 83건/일의 80%를 두 과로 나눔(비율은 가정)", "keep", ""),
    "이비인후과 평일 기본 처방건수": ("B", "위와 동일", "keep", ""),
    "요일계수(월~토)": ("C", "근거 자료 없음. 일반적 관찰에 의존", "validate_with_pharmacist", ""),
    "연휴 후 / 연휴 전 계수": ("C", "근거 자료 없음", "validate_with_pharmacist", ""),
    "수요일 이비인후과 계수": ("C", "의원 1곳의 진료시간 예시 1건에 근거", "validate_with_pharmacist", ""),
    "호흡기지수 1월/8월": ("B", "서울 진해거담제 금액 비로 계산한 대리지표. 약국 단위 아님", "keep", ""),
    "인플루엔자 고정점": ("A", "질병관리청 공표 수치(L11, 참고용 지표의 고정점)", "keep", ""),
    "본인부담률": ("B", "법정 비율이나 연령·정액 구간을 무시한 단순화", "keep", ""),
    "일반약 워크인 구매자": ("B", "인터뷰 10~15명/일의 중앙값. 개업 3주차 관찰", "keep", "pharmacy.otc_buyers_per_day"),
    "처방환자 추가구매율": ("C", "근거 없음", "validate_with_pharmacist", ""),
    "1인 구매 수량": ("C", "근거 없음", "validate_with_pharmacist", ""),
    "대표 일반약 가격": ("A", "일반의약품 판매가 조사의 대표 품목 가격(L13)", "keep", ""),
    "씨잘정·동화록소닌정 상한금액": ("A", "보건복지부 약가 고시(L12)", "keep", ""),
    "전문약 목표 재고일수 / 일반약": ("B", "인터뷰의 '주 단위 발주'에서 환산", "keep", ""),
    "긴급 발주 기준 잔여일수": ("B", "인터뷰의 '오늘·내일 버틸지' 판단에서 환산", "keep", ""),
    "전산 오차 발생 확률(전문/일반)": ("C", "근거 없음", "validate_with_pharmacist", ""),
    "카드 결제 비율": ("C", "근거 없음", "validate_with_pharmacist", ""),
    "카드 수수료": ("A", "금융위원회 우대수수료율(L08)", "keep", ""),
    "임대료": ("B", "서울 단가 × 전국 중앙값 면적의 조합", "keep", ""),
    "정규 직원 / 파트 인건비": ("B", "최저임금 × 근로시간 + 4대보험 계산", "keep", ""),
    "기타 운영비": ("C", "항목별 근거 없음", "validate_with_pharmacist", ""),
    "대표 인출": ("B", "평균 사업소득 ÷ 12 수준으로 맞춤", "keep", ""),
    "시작 현금": ("C", "근거 없음. 시나리오 변수로 다룸", "scenario_variable", ""),
    "공단 지급 시차": ("C", "주간 청구 후 입금이라는 일반 설명뿐", "validate_with_pharmacist", ""),
    "금융비용 할인 상한": ("A", "약사법 시행규칙 별표 2(L09)", "keep", ""),
    "거래처별 적용 할인율": ("B", "법정 상한 이내라는 범위만 근거", "validate_with_pharmacist", ""),
    "반품 환급률": ("B", "인터뷰의 '미반품·임박품 제한·80% 환급' 발언에서 구성", "keep", ""),
    "기본 결품률": ("C", "근거 없음", "validate_with_pharmacist", ""),
    "영업면적": ("B", "전국 중앙값 50㎡. 단, 가상 약국 1층과 인터뷰 약국 2층이 충돌", "regenerate_with_profile", "pharmacy.floor"),
    "공간 용량": ("C", "근거 없음", "validate_with_pharmacist", ""),
    "DUR 경고율 / 심사 조정률": ("C", "근거 없음", "validate_with_pharmacist", ""),
    "서비스 시간(처방·일반약·문의)": ("C", "근거 없음", "validate_with_pharmacist", ""),
    "일반약 마진율": ("C", "업계 통념 수준", "validate_with_pharmacist", ""),
    "장비 연 고장률": ("C", "인터뷰에서 고장·수리 사실만 확인. 빈도는 근거 없음", "validate_with_pharmacist", ""),
    "난수 시드": ("", "재현용 설정값", "keep", ""),
}


# 가상값 -> 대표 변수 1개 (후보. PM 확인 필요. variable_link_status 로 확정 여부 표시)
VAR_OF = {
    "영업일": "X001", "약국 평균 연매출": "P018", "연매출 중앙값 근처": "P018", "개설약사 평균 사업소득": "C001",
    "약국 진료비 중 약품비 비중": "P018", "3일분 조제료": "P018", "일수별 조제료(5·7·15·30·31+일)": "P018",
    "내과 평일 기본 처방건수": "P018", "이비인후과 평일 기본 처방건수": "P018", "요일계수(월~토)": "X001",
    "연휴 후 / 연휴 전 계수": "X001", "수요일 이비인후과 계수": "X002", "호흡기지수 1월/8월": "X005",
    "인플루엔자 고정점": "X005", "본인부담률": "C001", "일반약 워크인 구매자": "S013", "처방환자 추가구매율": "S013",
    "1인 구매 수량": "X009", "대표 일반약 가격": "S023", "씨잘정·동화록소닌정 상한금액": "S023",
    "전문약 목표 재고일수 / 일반약": "S008", "긴급 발주 기준 잔여일수": "S008", "전산 오차 발생 확률(전문/일반)": "S004",
    "카드 결제 비율": "C001", "카드 수수료": "C001", "임대료": "C001", "정규 직원 / 파트 인건비": "C001",
    "기타 운영비": "C001", "대표 인출": "C001", "시작 현금": "S011", "공단 지급 시차": "C001",
    "금융비용 할인 상한": "C002", "거래처별 적용 할인율": "C002", "반품 환급률": "C003", "기본 결품률": "X006",
    "영업면적": "C006", "공간 용량": "C006", "DUR 경고율 / 심사 조정률": "P022", "서비스 시간(처방·일반약·문의)": "S019",
    "일반약 마진율": "S023", "장비 연 고장률": "S021",
}

# 시계열 7개: 시트 -> (파일명, 열 영문명 목록, 중복이라 버리는 열)
TABLES = {
    "00_공통달력": ("calendar", ["date", "weekday_ko", "month", "iso_week", "holiday_name", "is_open", "open_type",
                    "open_hours", "holiday_adjacency", "ent_closed", "influenza_ili_per_1000", "respiratory_index"], []),
    "L45_처방건수·조제료": ("rx_daily", ["date", "weekday_ko", "is_open", "rx_count_internal", "rx_count_ent",
                    "rx_count_total", "avg_rx_days", "dispensing_fee_total_krw", "drug_cost_total_krw", "rx_total_krw",
                    "dispensing_fee_per_rx_krw", "rx_total_per_rx_krw", "copay_krw", "insurer_paid_krw", "ent_closed",
                    "holiday_adjacency"], ["weekday_ko", "is_open", "ent_closed", "holiday_adjacency"]),
    "L47_일반약 판매(시간별)": ("otc_hourly", ["date", "weekday_ko", "hour_band", "walkin_buyers", "rx_addon_buyers",
                    "buyers_total", "units_sold", "sales_krw", "cold_units", "analgesic_patch_units", "digestive_units",
                    "supplement_units", "other_units", "stockout_lost_units"], ["weekday_ko"]),
    "L48_재고수량·잔여일수": ("inventory_daily", ["date", "weekday_ko", "product_id", "product_name_ko", "category_ko",
                    "unit", "opening_physical_stock", "receipts", "usage_sales_units", "stockout_units",
                    "closing_physical_stock", "closing_system_stock", "system_physical_gap", "avg_daily_use_7d",
                    "days_of_supply", "order_qty", "order_type", "supplied_qty", "month_end_count",
                    "supply_shortage_period"], ["weekday_ko", "product_name_ko", "category_ko", "unit"]),
    "L49_현금여력·구매대금": ("cash_daily", ["date", "weekday_ko", "opening_cash_krw", "cash_receipts_krw",
                    "card_deposits_net_krw", "insurer_deposits_krw", "wholesale_payments_krw", "fixed_costs_krw",
                    "fixed_cost_detail", "closing_cash_krw", "unpaid_wholesale_krw", "purchase_burden_ratio",
                    "cash_runway_days", "is_negative"], ["weekday_ko"]),
    "L50_결제주기": ("payment_daily", ["date", "weekday_ko", "vendor_id", "payment_terms", "finance_discount_band",
                    "discount_rate_pct", "purchases_krw", "returns_refund_krw", "payment_target",
                    "payment_gross_krw", "finance_discount_krw", "payment_net_krw", "unpaid_balance_krw"], ["weekday_ko"]),
    "L52_공급조건·주문가능": ("supply_daily", ["date", "weekday_ko", "vendor_id", "delivery_terms", "order_cutoff",
                    "min_order_krw", "same_day_delivery", "order_lines", "stockout_lines", "stockout_rate",
                    "shortage_items"], ["weekday_ko"]),
}
VENDOR = {"A 대형 의약품도매(주거래)": "VA", "B 지역 의약품도매": "VB", "C 제약사·건기식 직거래": "VC"}
CATCODE = {"R": "prescription_drug", "O": "otc_drug", "H": "health_supplement", "D": "drink_quasi_drug", "Q": "other_goods"}
INPUT_COLS = {"date", "holiday_name", "is_open", "open_type", "open_hours", "holiday_adjacency", "ent_closed",
              "influenza_ili_per_1000", "order_qty", "order_type", "min_order_krw", "order_cutoff", "delivery_terms",
              "payment_terms", "discount_rate_pct", "vendor_id", "product_id", "hour_band", "month", "iso_week"}


def build_virtual():
    print("[3_virtual]")
    ws_rows = sheet_rows(DUMMY, "파라미터", 1)
    out = []
    for i, r in enumerate(ws_rows, 1):
        label, val, unit, kind, basis, used = r[:6]
        g = GRADE.get(label)
        if g is None:
            print("   ! 등급 매핑 없음:", label)
            g = ("", "", "keep", "")
        m = re.search(r"\bL(\d{2})\b", basis)
        out.append(dict(param_id=f"VP{i:02d}", label_ko=label, value_text=val, unit=unit,
                        value_origin=ORIGIN[kind], source_kind_ko=kind, support_grade=g[0], grade_reason_ko=g[1],
                        basis_ko=basis, used_in=used, primary_data_id=f"DT_L{m.group(1)}" if m else "",
                        profile_ref=g[3], action=g[2], variable_id=VAR_OF.get(label, ""),
                        variable_link_status="candidate" if VAR_OF.get(label) else "", **prov(DUMMY, "파라미터")))
    write("3_virtual/virtual_params.csv", out, ["param_id", "label_ko", "value_text", "unit", "value_origin",
          "source_kind_ko", "support_grade", "grade_reason_ko", "basis_ko", "used_in", "primary_data_id",
          "variable_id", "variable_link_status", "profile_ref", "action"] + PROV, key="param_id",
          authored=["support_grade", "grade_reason_ko", "profile_ref", "action", "variable_id", "variable_link_status"])

    # 시계열 표 + field_defs
    fdefs = {(r[0], r[1]): r for r in sheet_rows(DUMMY, "필드정의", 1, id_col=0)}
    fd_out = []
    wb = openpyxl.load_workbook(SRC / DUMMY, data_only=True, read_only=True)
    for sheet, (stem, en, drop) in TABLES.items():
        ws = wb[sheet]
        rows = list(ws.iter_rows(values_only=True))
        ko = [clean(c) for c in rows[0]]
        assert len(ko) == len(en), (sheet, len(ko), len(en))
        keep = [i for i, e in enumerate(en) if e not in drop]
        cols = ["pharmacy_id"] + [en[i] for i in keep] + PROV
        recs = []
        for r in rows[1:]:
            if not r or r[0] in (None, ""):
                continue
            d = {"pharmacy_id": PHARMACY_ID, **prov(DUMMY, sheet)}
            for i in keep:
                v = clean(r[i])
                if en[i] == "vendor_id":
                    v = VENDOR.get(v, v)
                if en[i] == "product_id":
                    v = v
                d[en[i]] = v
            recs.append(d)
        write(f"3_virtual/tables/{stem}.csv", recs, cols)
        for i in keep:
            f = fdefs.get((sheet, ko[i]), [""] * 9)
            fd_out.append(dict(table_name=stem, column_en=en[i], column_ko=ko[i], data_type=f[2], unit=f[3].replace("L48 '단위' 열", "entity_product.unit"),
                               is_primary_key=f[4], min_value=f[5], max_value=f[6], example=f[7], description_ko=f[8],
                               role="input" if en[i] in INPUT_COLS else "derived", **prov(DUMMY, "필드정의")))
        for c in ["pharmacy_id"]:
            fd_out.append(dict(table_name=stem, column_en=c, column_ko="약국 ID", data_type="문자", unit="",
                               is_primary_key="", min_value="", max_value="", example=PHARMACY_ID,
                               description_ko="이 행이 속한 약국. 가상 약국은 PH_DUMMY_01", role="input",
                               **prov(DUMMY, "필드정의")))
    write("3_virtual/field_defs.csv", fd_out, ["table_name", "column_en", "column_ko", "data_type", "unit",
          "is_primary_key", "min_value", "max_value", "example", "description_ko", "role"] + PROV,
          key=None)
    return out


# ───────────────────────── 0_common ─────────────────────────
def build_common(params):
    print("[0_common]")
    prods, seen = [], set()
    for r in sheet_rows(DUMMY, "L56_상품구성·진열위치", 1):
        prods.append(dict(product_id=r[0], name_ko=r[1], category_code=CATCODE[r[0][0]], unit="",
                          group_ko=r[3], main_vendor_id=VENDOR.get(r[10], ""), item_seq="", edi13=""))
        seen.add(r[0])
    units = {}
    for r in sheet_rows(DUMMY, "L48_재고수량·잔여일수", 1, id_col=2):
        units[r[2]] = (r[3], r[5])
    for pid, (nm, un) in units.items():
        for p in prods:
            if p["product_id"] == pid:
                p["unit"] = un
        if pid not in seen:
            prods.append(dict(product_id=pid, name_ko=nm, category_code=CATCODE[pid[0]], unit=un, group_ko="",
                              main_vendor_id="", item_seq="", edi13=""))
    prods.sort(key=lambda p: p["product_id"])
    write("0_common/entity_product.csv", prods, ["product_id", "name_ko", "category_code", "unit", "group_ko",
          "main_vendor_id", "item_seq", "edi13"], key="product_id", authored=["item_seq", "edi13", "main_vendor_id"])

    E = []

    def grp(g, items):
        for code, ko, desc in items:
            E.append(dict(enum_group=g, code=code, label_ko=ko, description_ko=desc))
    grp("judgement", [("real", "실데이터", "개체 한 곳 단위로 공개된 데이터"), ("reference", "참고용", "지역 단위 등. 분모로 나눠 규모를 바꿔 씀"),
                      ("virtual", "가상", "공개 자료가 없어 팀이 만든 데이터")])
    grp("value_origin", [("measured", "실측", "공개 통계·고시 등을 그대로 옮긴 값"), ("derived", "파생", "실측값끼리 계산해 얻은 값"),
                         ("assumption", "가정", "근거가 약하거나 팀이 정한 값. 등급 A 불가"), ("interview", "인터뷰", "인터뷰 발언에서 온 값"),
                         ("decision", "결정", "팀이 정한 설정값(기간, 시드 등)")])
    grp("support_grade", [("A", "충분", "공표 자료나 법령으로 직접 확인"), ("B", "부분", "근거는 있으나 단위·지역·시점이 다르거나 변환을 거침"),
                          ("C", "약함", "근거가 없거나 일반 상식 수준. 약사 검증 우선 대상")])
    grp("variable_category", [("fixed_attribute", "고정 속성", ""), ("structural_constraint", "구조적 제약", ""),
                              ("internal_state", "내부 동적 상태", ""), ("external_trigger", "외부 환경·트리거", ""),
                              ("decision_rule", "판단규칙", ""), ("outcome_learning", "결과·학습", "")])
    grp("data_scope", [("world_linked", "세계 데이터와 연결", "variable_data_map 에 행이 있음"),
                       ("interview_only", "인터뷰 전용", "공개·가상 데이터 대상이 아님")])
    grp("link_type", [("claim_supports_variable", "발언→변수", ""), ("claim_supports_rule", "발언→규칙", ""),
                      ("rule_uses_variable", "규칙→변수", ""), ("profile_uses_variable", "프로필→변수", ""),
                      ("profile_cites_claim", "프로필→발언", ""), ("guardrail_cites_claim", "가드레일→발언", ""),
                      ("case_cites_claim", "사례→발언", ""), ("case_illustrates_rule", "사례→규칙", "")])
    grp("role", [("input", "입력", "시뮬레이터가 읽는 값"), ("derived", "파생", "다른 열에서 계산되는 값")])
    grp("product_category", [(c, ko, "") for c, ko in [("prescription_drug", "전문의약품"), ("otc_drug", "일반의약품"),
                             ("health_supplement", "건강기능식품"), ("drink_quasi_drug", "마시는 의약외품"),
                             ("other_goods", "기타 의약외품·잡화")]])
    grp("vendor", [("VA", "대형 의약품도매(주거래)", ""), ("VB", "지역 의약품도매", ""), ("VC", "제약사·건기식 직거래", "")])
    grp("action", [("keep", "유지", ""), ("replace_with_real", "실데이터로 교체", ""), ("scenario_variable", "시나리오 변수", ""),
                   ("validate_with_pharmacist", "약사 검증 대상", ""), ("regenerate_with_profile", "인터뷰 프로필로 재생성", "")])
    applies_vals = {r[2] for r in sheet_rows(MASTER, "01_근거대장", 5) if r[2]} | \
                   {r[2] for r in sheet_rows(MASTER, "04_사건학습", 5) if r[2]}
    grp("applies_to", [(c, c, "") for c in sorted(applies_vals)])
    write("0_common/enums.csv", E, ["enum_group", "code", "label_ko", "description_ko"])


# ───────────────────────── 4_bridge / 5_validation (초안) ─────────────────────────
FIELD_MAP = [  # field_key, 설명, table, column, variable, param, kind, 변환 메모
    ("event.calendar.is_open", "영업 여부", "calendar", "is_open", "X001", "", "event", ""),
    ("event.calendar.holiday_adjacency", "연휴 전후 구분", "calendar", "holiday_adjacency", "X001", "", "event", ""),
    ("event.clinic_schedule.ent_closed", "이비인후과 휴진 여부", "calendar", "ent_closed", "X003", "", "event",
     "확인 필요: 더미의 휴진이 같은 건물 의원인지 인근 기존 의원인지. 인터뷰는 '기존 의원 휴진 → 신규 의원 혼잡'"),
    ("event.epidemic.influenza_ili", "인플루엔자 의사환자분율", "calendar", "influenza_ili_per_1000", "X005", "", "event", ""),
    ("event.epidemic.respiratory_index", "호흡기 처방지수", "calendar", "respiratory_index", "X005", "", "event", ""),
    ("state.rx_volume.total", "일 처방 건수", "rx_daily", "rx_count_total", "P018", "", "state", ""),
    ("state.book_stock", "전산 재고", "inventory_daily", "closing_system_stock", "S001", "", "state", "품목별"),
    ("state.physical_stock", "실물 재고", "inventory_daily", "closing_physical_stock", "S002", "", "state", "품목별"),
    ("state.stock_gap", "전산-실물 오차", "inventory_daily", "system_physical_gap", "S004", "", "state", ""),
    ("state.expected_coverage", "잔여일수", "inventory_daily", "days_of_supply", "S008", "", "state", "인터뷰는 '오늘·내일 버틸지'의 체감 판단. 수치 환산은 가정"),
    ("state.recent_usage", "최근 7일 일평균 사용", "inventory_daily", "avg_daily_use_7d", "S008", "", "state", ""),
    ("event.supplier.order_supplied", "실제 공급 수량", "inventory_daily", "supplied_qty", "X006", "", "event", "order_qty 와 비교해 품절 판정"),
    ("event.supplier.stockout_rate", "거래처 결품률", "supply_daily", "stockout_rate", "X006", "", "event", ""),
    ("constraint.supplier.same_day_delivery", "당일 배송 가능", "supply_daily", "same_day_delivery", "C015", "", "constraint", ""),
    ("constraint.supplier.order_cutoff", "주문 마감", "supply_daily", "order_cutoff", "C015", "", "constraint", ""),
    ("constraint.supplier.min_order", "최소 주문금액", "supply_daily", "min_order_krw", "C015", "", "constraint", ""),
    ("constraint.working_capital.closing_cash", "기말 현금", "cash_daily", "closing_cash_krw", "C001", "", "constraint", "시작 현금은 시나리오 변수(VP 시작 현금)"),
    ("constraint.working_capital.unpaid", "미지급 도매대금", "cash_daily", "unpaid_wholesale_krw", "C001", "", "constraint", ""),
    ("state.purchase_pressure.runway_days", "현금 여력일수", "cash_daily", "cash_runway_days", "S011", "", "state", ""),
    ("state.purchase_pressure.burden_ratio", "구매대금 부담률", "cash_daily", "purchase_burden_ratio", "S011", "", "state", ""),
    ("constraint.payment_terms.terms", "결제 조건", "payment_daily", "payment_terms", "C002", "", "constraint", ""),
    ("constraint.payment_terms.discount_rate", "금융비용 할인율", "payment_daily", "discount_rate_pct", "C002", "", "constraint", ""),
    ("state.otc_buyer_count", "일반약 구매자 수", "otc_hourly", "buyers_total", "S013", "", "state", "인터뷰 10~15명/일과 비교"),
]
SCENARIO = [  # order, target_type, target_id, 설정, 입력묶음, 메모
    (1, "variable", "X005", "감기·독감 유행기(호흡기지수가 높은 구간)를 시뮬 기간에서 고른다", "T2", "구간 날짜는 팀이 정함"),
    (2, "variable", "X003", "기존 이비인후과 휴진일을 유행기 안에 둔다", "T2", "휴진일 수·날짜는 팀이 정함"),
    (3, "variable", "X006", "주력 품목 하나가 거래처에서 공급 부족인 날을 둔다", "T2", "품목은 entity_product 에서 고름"),
    (4, "param", "VP31", "시작 현금을 신규 약국 수준으로 제한한다", "T3", "근거 없는 가정값. 시나리오 변수로 취급"),
    (5, "variable", "S008", "품목별 잔여일수가 긴급 기준에 가까워진 날 판단을 요청한다", "T1", "긴급 기준 1.5일은 가정(VP 긴급 발주 기준)"),
    (6, "rule", "R02", "잔여량으로 오늘·내일 감당 가능성 판단", "T1", "기대 행동: 발주 여부·수량 제안(제약 검사는 코드가 수행)"),
    (7, "rule", "R03", "개업 초기 자금·재고 부담을 함께 고려", "T3", ""),
]


def build_authored(params):
    print("[4_bridge / 5_validation]  (파일이 이미 있으면 유지)")
    pm = {p["label_ko"]: p["param_id"] for p in params}
    p = DATA / "4_bridge/field_map.csv"
    if not p.exists():
        rows = [dict(field_key=k, label_ko=l, source_table=t, source_column=c, variable_id=v, param_id=pa,
                     field_kind=kind, transform_note=n, status="draft") for k, l, t, c, v, pa, kind, n in FIELD_MAP]
        write("4_bridge/field_map.csv", rows, ["field_key", "label_ko", "source_table", "source_column",
              "variable_id", "param_id", "field_kind", "transform_note", "status"])
    p = DATA / "4_bridge/scenarios.csv"
    if not p.exists():
        rows = []
        for o, tt, tid, s, bundle, note in SCENARIO:
            if tt == "param":
                tid = pm.get("시작 현금", tid)
            rows.append(dict(scenario_id="SC01", scenario_label_ko="감기·독감 + 휴진 + 도매 품절 + 신규약국 현금 제약 → 발주 판단",
                             status="proposed", setting_order=o, target_type=tt, target_id=tid, setting_ko=s,
                             input_bundle_id=bundle, note=note))
        write("4_bridge/scenarios.csv", rows, ["scenario_id", "scenario_label_ko", "status", "setting_order",
              "target_type", "target_id", "setting_ko", "input_bundle_id", "note"])
    p = DATA / "5_validation/validation_ranges.csv"
    rows = []
    for q in params:
        if q["value_origin"] == "decision" or q["support_grade"] not in ("B", "C"):
            continue
        rows.append(dict(validation_id=f"VR{len(rows)+1:02d}", param_id=q["param_id"], label_ko=q["label_ko"],
                         value_shown=q["value_text"], unit=q["unit"], support_grade=q["support_grade"],
                         question_ko=f"{q['label_ko']}이(가) {q['value_text']}{(' ' + q['unit']) if q['unit'] else ''}"
                                     f" 정도인 것은 동네 처방형 약국 기준으로 현실적입니까?",
                         tolerance_pct="", range_low="", range_high="", status="not_asked", note=""))
    write("5_validation/validation_ranges.csv", rows, ["validation_id", "param_id", "label_ko", "value_shown",
          "unit", "support_grade", "question_ko", "tolerance_pct", "range_low", "range_high", "status", "note"],
          key="param_id", authored=["tolerance_pct", "range_low", "range_high", "status", "note"])


if __name__ == "__main__":
    build_interview()
    build_world()
    params = build_virtual()
    build_common(params)
    build_authored(params)
    print("완료.", NOW)
