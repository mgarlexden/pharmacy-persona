#!/usr/bin/env python
"""공공데이터 값을 한 파일(data/2_world/derived/public_snapshot.csv)로 모은다.

흐름
  1) API 는 한 번만 부른다. 응답 원본은 fetched/public/ 에 저장한다 (git 이 무시한다).
     이미 받은 것은 다시 부르지 않는다. 새로 받으려면 --refresh.
  2) 내려받은 파일(전국 병의원·약국 현황, 약국 목록, 독감 주별 표)은 fetched/public_files/ 에서 읽는다.
  3) 시스템에 필요한 값만 뽑아 public_snapshot.csv 한 파일로 쓴다. 화면과 시뮬레이션은 이 파일만 읽는다.

원칙
  - 개별 의원·약국 이름과 좌표는 요약 파일에 넣지 않는다 (저장소가 공개라 약국이 특정될 수 있다). 개수와 구간만 남긴다.
  - 약국 위치는 저장소에 적지 않는다. 반경 계산은 --lat --lon 으로 넘길 때만 한다.
  - 값을 고치지 않는다. 합계·평균만 낸다. 기준(나쁨 등)을 새로 만들지 않는다.
  - 키는 .env 의 DATA_GO_KR_KEY. 출력에 찍지 않는다.

예)
  python scripts/build_public.py
  python scripts/build_public.py --lat 37.6 --lon 127.1 --refresh
"""
import argparse
import csv
import datetime as dt
import json
import math
import os
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import warnings
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from pathlib import Path

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "fetched" / "public"
FILES = ROOT / "fetched" / "public_files"
OUT = ROOT / "data" / "2_world" / "derived" / "public_snapshot.csv"
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

SIDO_CODE, SGG_CODE, SGG_NAME = "310000", "311000", "구리시"   # 심평원 코드(경기, 구리시)
DAY0, DAY1 = dt.date(2026, 9, 1), dt.date(2026, 10, 31)         # 시뮬레이션 9·10월
AIR_STATIONS = ["동구동", "교문동"]                              # 구리시 측정소 (측정소정보 API 로 확인)
ASOS_STN = ("108", "서울")                                       # 구리시에 ASOS 없음 → 서울. 거리는 미확인.
DRUG_CODES = {"114": "해열·진통·소염제", "222": "진해거담제", "229": "기타의 호흡기관용약"}
DRUG_FROM, DRUG_TO = (2024, 1), (2026, 8)                        # 응답이 비는 달은 건너뛴다

COLS = ["scope", "key", "variable_id", "label_ko", "value", "unit", "data_id", "basis", "period", "fetched_at", "note"]
ROWS = []


def add(scope, key, label, value, unit="", data_id="", basis="실측", period="", note="", variable_id=""):
    ROWS.append({"scope": scope, "key": key, "variable_id": variable_id, "label_ko": label, "value": value, "unit": unit,
                 "data_id": data_id, "basis": basis, "period": period, "fetched_at": NOW, "note": note})


NOW = dt.datetime.now().isoformat(timespec="seconds")


# ---------------------------------------------------------------- 키와 호출
def load_key():
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    key = os.environ.get("DATA_GO_KR_KEY", "").strip()
    if not key:
        sys.exit(".env 에 DATA_GO_KR_KEY 가 없습니다.")
    return urllib.parse.unquote(key)


def http(url, params, key, tries=4):
    q = dict(params)
    q["serviceKey"] = key
    full = url + "?" + urllib.parse.urlencode(q)
    last = ""
    for i in range(tries):
        try:
            req = urllib.request.Request(full, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}"
            if e.code not in (500, 502, 503, 504):
                break
        except Exception as e:
            last = type(e).__name__
        time.sleep(3 * (i + 1))
    raise RuntimeError(last)


def cached(name, refresh, fn):
    """fetched/public/<name> 이 있으면 그대로 읽고, 없거나 --refresh 면 fn() 으로 받아 저장한다."""
    RAW.mkdir(parents=True, exist_ok=True)
    p = RAW / name
    if p.exists() and not refresh:
        return json.loads(p.read_text(encoding="utf-8"))
    data = fn()
    p.write_text(json.dumps({"fetched_at": NOW, "data": data}, ensure_ascii=False), encoding="utf-8")
    return {"fetched_at": NOW, "data": data}


def when(obj):
    return obj.get("fetched_at", NOW)


# ---------------------------------------------------------------- 날짜별: 공휴일, 날씨, 미세먼지
def part_holidays(key, refresh):
    def go():
        t = http("https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo",
                 {"solYear": 2026, "_type": "json", "numOfRows": 100}, key)
        items = json.loads(t)["response"]["body"]["items"]["item"]
        return items if isinstance(items, list) else [items]
    obj = cached("holidays_2026.json", refresh, go)
    hol = {}
    for it in obj["data"]:
        if it.get("isHoliday") == "Y":
            d = str(it["locdate"])
            hol[f"{d[:4]}-{d[4:6]}-{d[6:]}"] = it["dateName"]
    return hol, when(obj)


def part_asos(key, refresh):
    end = min(DAY1, dt.date.today() - dt.timedelta(days=1))

    def go():
        t = http("https://apis.data.go.kr/1360000/AsosDalyInfoService/getWthrDataList",
                 {"dataType": "JSON", "dataCd": "ASOS", "dateCd": "DAY", "startDt": DAY0.strftime("%Y%m%d"),
                  "endDt": end.strftime("%Y%m%d"), "stnIds": ASOS_STN[0], "numOfRows": 100, "pageNo": 1}, key)
        return json.loads(t)["response"]["body"]["items"]["item"]
    obj = cached(f"asos_{ASOS_STN[0]}_{DAY0}_{DAY1}.json", refresh, go)
    return {r["tm"]: r for r in obj["data"]}, when(obj)


def part_air(key, refresh):
    out = {}
    for st in AIR_STATIONS:
        def go(st=st):
            t = http("https://apis.data.go.kr/B552584/ArpltnInforInqireSvc/getMsrstnAcctoRltmMesureDnsty",
                     {"returnType": "json", "numOfRows": 3000, "pageNo": 1, "stationName": st, "dataTerm": "3MONTH", "ver": "1.4"}, key)
            return json.loads(t)["response"]["body"]["items"]
        obj = cached(f"air_{st}.json", refresh, go)
        out[st] = (obj["data"], when(obj))
    return out


def num(v):
    try:
        return float(v)
    except Exception:
        return None


def air_daily(station_rows):
    """측정소별 시간 값 → 날짜별 평균. 값이 없는 시간('-')은 센다 않는다."""
    day = defaultdict(lambda: {"pm10": [], "pm25": []})
    for r in station_rows:
        ts = str(r.get("dataTime", ""))
        d = ts[:10]
        if ts.endswith(" 24:00"):          # 24:00 은 그날 마지막 시간
            pass
        for k, f in (("pm10", "pm10Value"), ("pm25", "pm25Value")):
            v = num(r.get(f))
            if v is not None:
                day[d][k].append(v)
    return day


# ---------------------------------------------------------------- 월별: 의약품 사용량
def part_drug(key, refresh):
    base = "https://apis.data.go.kr/B551182/msupUserInfoService1.2/getMeftDivAreaList1.2"
    rows = []
    y, m = DRUG_FROM
    stop = False
    months = []
    while (y, m) <= DRUG_TO:
        months.append(f"{y}{m:02d}")
        m += 1
        if m == 13:
            y, m = y + 1, 1

    def go():
        got = []
        for ym in months:
            for c in DRUG_CODES:
                t = http(base, {"diagYm": ym, "meftDivNo": c, "insupTp": "0", "cpmdPrscTp": "01", "sidoCd": SIDO_CODE,
                                "sgguCd": SGG_CODE, "numOfRows": 20, "pageNo": 1}, key)
                for it in ET.fromstring(t).findall(".//item"):
                    got.append({x.tag: (x.text or "") for x in it})
        return got
    obj = cached("drug_guri.json", refresh, go)
    agg = defaultdict(lambda: [0, 0])
    for r in obj["data"]:
        a = agg[(r["diagYm"], r["meftDivNo"])]
        a[0] += int(r.get("totUseQty") or 0)
        a[1] += int(r.get("msupUseAmt") or 0)
    return agg, when(obj)


# ---------------------------------------------------------------- 주별: 독감
def part_flu():
    p = FILES / "influenza_gyeonggi_weekly.csv"
    if not p.exists():
        return []
    raw = p.read_bytes()
    for enc in ("utf-8-sig", "cp949"):
        try:
            line = raw.decode(enc).splitlines()[0]
            break
        except Exception:
            continue
    cells = [c.strip() for c in line.split(",")]
    vals = [c for c in cells[1:] if c != ""]
    # 감염병포털 표: 2026-27 절기 36주부터 한 칸씩. 마지막 칸이 '집계 중'이면 비운다.
    return [(36 + i, num(v), v) for i, v in enumerate(vals)]


# ---------------------------------------------------------------- 고정: 파일에서
def read_xlsx_rows(path, want):
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True)
    it = wb.active.iter_rows(values_only=True)
    head = list(next(it))
    idx = {h: i for i, h in enumerate(head)}
    for r in it:
        if want(r, idx):
            yield r, idx


def hav_m(lat1, lon1, lat2, lon2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def part_fixed(lat, lon):
    cache = RAW / "guri_files.json"
    RAW.mkdir(parents=True, exist_ok=True)
    if cache.exists():
        d = json.loads(cache.read_text(encoding="utf-8"))
    else:
        print("  파일 3개를 읽는 중 (처음 한 번, 1~2분)…")
        clinics, pharms, subj = [], [], []
        for r, ix in read_xlsx_rows(FILES / "1.병원정보서비스(2026.6.).xlsx", lambda r, ix: r[ix["시군구코드명"]] == SGG_NAME):
            clinics.append({"id": r[ix["암호화요양기호"]], "type": r[ix["종별코드명"]], "open": str(r[ix["개설일자"]])[:10],
                            "doctors": r[ix["총의사수"]], "x": r[ix["좌표(X)"]], "y": r[ix["좌표(Y)"]], "addr": r[ix["주소"]]})
        for r, ix in read_xlsx_rows(FILES / "2.약국정보서비스(2026.6.).xlsx", lambda r, ix: r[ix["시군구코드명"]] == SGG_NAME):
            pharms.append({"open": str(r[ix["개설일자"]])[:10], "x": r[ix["좌표(X)"]], "y": r[ix["좌표(Y)"]]})
        ids = {c["id"] for c in clinics}
        for r, ix in read_xlsx_rows(FILES / "5.의료기관별상세정보서비스_03_진료과목정보(2026.6.).xlsx", lambda r, ix: r[ix["암호화요양기호"]] in ids):
            subj.append({"id": r[ix["암호화요양기호"]], "name": r[ix["진료과목코드명"]]})
        d = {"clinics": clinics, "pharms": pharms, "subj": subj}
        cache.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    return d


def hours_part():
    p = FILES / "경기 구리 약국_목록.xlsx"
    if not p.exists():
        return None
    import openpyxl
    wb = openpyxl.load_workbook(p, read_only=True)
    rows = list(wb.active.iter_rows(values_only=True))[1:]
    seen, uniq = set(), []
    for r in rows:
        k = (r[1], r[4])
        if k not in seen:      # 같은 약국이 두 줄(시간 이력)이면 첫 줄만
            seen.add(k)
            uniq.append(r)
    return len(rows), uniq


def parse_close(s):
    s = str(s or "").strip()
    if "~" not in s:
        return None
    try:
        h, m = s.split("~")[1].split(":")
        return int(h) * 60 + int(m)
    except Exception:
        return None



# ---------------------------------------------------------------- 팀 정리본(주변 의원·약국)
def part_team(path, cl, ph):
    """팀원이 공개자료로 정리한 주변 의원·약국 목록(이름·주소 포함)에서 개수와 구성만 뽑는다.
    기준점 좌표는 이 엑셀에서 읽어 교차 확인에만 쓰고 저장하지 않는다."""
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    rows = list(wb["01_전체목록"].iter_rows(values_only=True))
    hi = next(i for i, r in enumerate(rows) if r and r[0] == "기관ID")
    ix = {h: i for i, h in enumerate(rows[hi]) if h}
    body = [r for r in rows[hi + 1:] if r[0]]
    center = next(r for r in body if r[ix["표시·대표분야"]] == "기준 약국")
    lat, lon = float(center[ix["위도"]]), float(center[ix["경도"]])
    src, per = "팀 정리본", "2026-10-06 조회"
    basis = "팀 정리본(공개자료 확인 목록)"
    flag = {100: ix["100m 이내"], 200: ix["200m 이내"], 300: ix["300m 이내"]}
    kinds = [("의원", "의원"), ("치과의원", "치과"), ("한의원", "한의원"), ("약국", "주변 약국")]
    for rad, col in flag.items():
        sub = [r for r in body if r[col] == "Y"]
        tot = 0
        for tp, lab in kinds:
            n = sum(1 for r in sub if r[ix["구분"]] == tp)
            if tp != "약국":
                tot += n
            add("fixed", f"반경{rad}m", f"반경 {rad}m 안 {lab}", n, "곳", src, basis=basis, period=per,
                variable_id="X012" if tp == "약국" else "P011",
                note="직선거리, 기준 약국 제외. 현재 영업 전수조사 아님")
        add("fixed", f"반경{rad}m", f"반경 {rad}m 안 의료기관(의원·치과·한의원)", tot, "곳", src, basis=basis, period=per, variable_id="P011")
    # 같은 건물
    same = [r for r in body if r[ix["동일건물"]] == "Y" and r[ix["표시·대표분야"]] != "기준 약국"]
    add("fixed", "같은건물", "같은 건물 의료기관 수", len(same), "곳", src, basis=basis, period=per, variable_id="P011",
        note="도로명주소가 같은 기관(기준 약국 제외)")
    for r in same:
        add("fixed", "같은건물", f"같은 건물 {r[ix['구분']]}: {r[ix['표시·대표분야']]}", r[ix["층·호"]] or "", "", src, basis=basis,
            period=per, variable_id="P011", note="이름·주소는 저장하지 않음. 확인수준: " + str(r[ix["확인수준"]]))
        hours = str(r[ix["진료·영업시간"]] or "")
        if hours and hours != "미확인":
            add("fixed", "같은건물", f"같은 건물 {r[ix['표시·대표분야']]} 진료시간", hours, "", src, basis=basis, period=per, variable_id="X002",
                note="확인수준: " + str(r[ix["확인수준"]]) + ". 임시 휴진은 반영 안 됨")
    # 300m 안 의원의 대표분야
    sub = [r for r in body if r[flag[300]] == "Y" and r[ix["구분"]] == "의원"]
    for kw, lab in (("이비인후", "이비인후과"), ("정형", "정형외과"), ("소아", "소아청소년과"), ("내과", "내과"), ("마취통증", "마취통증의학과")):
        n = sum(1 for r in sub if kw in str(r[ix["표시·대표분야"]]))
        add("fixed", "반경300m", f"반경 300m 안 의원 중 {lab} 표시", n, "곳", src, basis=basis, period=per, variable_id="P010",
            note="대표분야 문구에 포함된 곳. 복수 진료 표기는 여러 분야에 셈")
    # 교차 확인: 심평원 2026.6 파일로 같은 기준점에서 계산
    for rad in (100, 200, 300):
        t = Counter(c["type"] for c in cl if c["x"] and hav_m(lat, lon, c["y"], c["x"]) <= rad)
        n = sum(1 for p in ph if p["x"] and hav_m(lat, lon, p["y"], p["x"]) <= rad)
        for tp, lab in (("의원", "의원"), ("치과의원", "치과"), ("한의원", "한의원")):
            add("fixed", f"반경{rad}m", f"[교차 확인] 반경 {rad}m 안 {lab}", t.get(tp, 0), "곳", "DT_L33", basis="계산(심평원 2026.6 파일)",
                period="2026.6 기준", note="팀 정리본과 같은 기준점. 기준점은 저장하지 않음")
        add("fixed", f"반경{rad}m", f"[교차 확인] 반경 {rad}m 안 주변 약국", n, "곳", "DT_L23", basis="계산(심평원 2026.6 파일)",
            period="2026.6 기준", note="팀 정리본과 같은 기준점. 기준 약국은 6월 이후 개업이라 파일에 없음")


# ---------------------------------------------------------------- 조립
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true", help="API 를 다시 부른다")
    ap.add_argument("--lat", type=float)
    ap.add_argument("--lon", type=float)
    ap.add_argument("--team-xlsx", default=str(FILES / "team_nearby.xlsx"), help="팀 정리본(주변 의원·약국) 엑셀")
    a = ap.parse_args()
    key = load_key()

    print("1) 공휴일·날씨·미세먼지·의약품 사용량 (API, 받아 둔 것은 재사용)")
    hol, t_h = part_holidays(key, a.refresh)
    asos, t_a = part_asos(key, a.refresh)
    air = part_air(key, a.refresh)
    drug, t_d = part_drug(key, a.refresh)

    # -- 날짜별
    adaily = {st: air_daily(rows) for st, (rows, _) in air.items()}
    t_air = max(t for _, t in air.values())
    wk = ["월", "화", "수", "목", "금", "토", "일"]
    d = DAY0
    while d <= DAY1:
        k = d.isoformat()
        add("daily", k, "요일", wk[d.weekday()], "", "", "계산", period=k)
        isholi = k in hol
        add("daily", k, "공휴일 여부", "Y" if isholi else "N", "", "DT_L17", period=k, variable_id="X001",
            note=hol.get(k, ""), )
        if isholi:
            add("daily", k, "공휴일 이름", hol[k], "", "DT_L17", period=k, variable_id="X001")
        if k in asos:
            r = asos[k]
            for lab, f, u in (("평균기온", "avgTa", "℃"), ("최저기온", "minTa", "℃"), ("최고기온", "maxTa", "℃")):
                add("daily", k, lab, r.get(f, ""), u, "DT_L18", period=k, note=f"{ASOS_STN[1]}({ASOS_STN[0]}) 관측소, 구리시 아님")
            add("daily", k, "일 강수량", r.get("sumRn") or "0", "mm", "DT_L18", period=k,
                note=f"{ASOS_STN[1]}({ASOS_STN[0]}) 관측소. 빈 칸은 강수 없음으로 둠")
        for lab, f in (("PM10 일평균", "pm10"), ("PM2.5 일평균", "pm25")):
            vals = {st: adaily[st][k][f] for st in AIR_STATIONS if k in adaily[st] and adaily[st][k][f]}
            if vals:
                means = [sum(v) / len(v) for v in vals.values()]
                add("daily", k, lab, round(sum(means) / len(means), 1), "㎍/㎥", "DT_L20", period=k,
                    note="측정소 " + "·".join(f"{st} {len(v)}시간" for st, v in vals.items()) + " 평균. 빈 시간 제외")
        d += dt.timedelta(days=1)
    # 출처 시각을 날짜별 행마다 다르게 두지 않고 데이터셋별로 바꿔 기록
    for r in ROWS:
        if r["scope"] == "daily":
            r["fetched_at"] = {"DT_L17": t_h, "DT_L18": t_a, "DT_L20": t_air}.get(r["data_id"], NOW)

    # -- 주별 독감
    for w, v, raw in part_flu():
        add("weekly", f"2026-27절기 {w}주", "인플루엔자 의사환자분율(경기)", "" if v is None else v, "외래 1,000명당",
            "DT_L11", period="2026-27 절기", variable_id="X005",
            note="질병관리청 감염병포털 표본감시, 경기 시도 단위(시군구 없음)" + ("" if v is not None else f". '{raw}' (아직 집계 전)"))

    # -- 월별 의약품
    for (ym, c), (q, amt) in sorted(drug.items()):
        if q == 0 and amt == 0:
            continue
        mk = f"{ym[:4]}-{ym[4:]}"
        add("monthly", mk, f"{DRUG_CODES[c]}({c}) 사용 수량", q, "정(개)", "DT_L10", period=mk,
            note="구리시, 조제기준, 보험자 구분 합계. 건강보험 청구분만(일반약 제외)")
        add("monthly", mk, f"{DRUG_CODES[c]}({c}) 사용 금액", amt, "원", "DT_L10", period=mk, note="구리시, 조제기준, 보험자 구분 합계")

    print("2) 고정 변수 (내려받은 파일)")
    f = part_fixed(a.lat, a.lon)
    cl, ph, sj = f["clinics"], f["pharms"], f["subj"]
    per = "2026.6 기준"
    add("fixed", "", "구리시 의료기관 수(종별 전체)", len(cl), "곳", "DT_L33", period=per, variable_id="P011")
    for tp, n in Counter(c["type"] for c in cl).most_common():
        add("fixed", "", f"구리시 {tp} 수", n, "곳", "DT_L33", period=per)
    ids = {c["id"] for c in cl if c["type"] == "의원"}
    cnt = Counter(s["name"] for s in sj if s["id"] in ids)
    for name, n in cnt.most_common():
        add("fixed", "", f"구리시 의원 중 {name} 진료과목", n, "곳", "DT_L34", period=per,
            note="한 의원이 여러 과목이면 과목마다 셈", variable_id="P010")
    add("fixed", "", "구리시 약국 수", len(ph), "곳", "DT_L23", period=per, variable_id="X012",
        note="2026-09 개업한 응답자 약국은 이 파일에 없음")

    h = hours_part()
    if h:
        n_rows, uniq = h
        n = len(uniq)
        def opened(i):
            return sum(1 for r in uniq if parse_close(r[i]) is not None)
        add("fixed", "", "구리시 약국 목록 수(중복 제외)", n, "곳", "DT_L40", period="2026-10 목록",
            note=f"원본 {n_rows}행 중 같은 약국 이름·주소 중복 제외")
        for lab, i in (("토요일 영업", 10), ("일요일 영업", 11), ("공휴일 영업", 12)):
            add("fixed", "", f"구리시 약국 중 {lab}", opened(i), "곳", "DT_L40", period="2026-10 목록")
        closes = [parse_close(r[5]) for r in uniq if parse_close(r[5]) is not None]
        if closes:
            add("fixed", "", "구리시 약국 월요일 마감 시각 중앙값", f"{int(statistics.median(closes)) // 60:02d}:{int(statistics.median(closes)) % 60:02d}", "", "DT_L40", period="2026-10 목록")
            add("fixed", "", "구리시 약국 중 월요일 20시 이후 마감", sum(1 for c in closes if c >= 20 * 60), "곳", "DT_L40", period="2026-10 목록")

    if a.lat is not None and a.lon is not None:
        for rad in (100, 300, 500):
            nc = sum(1 for c in cl if c["type"] == "의원" and c["x"] and hav_m(a.lat, a.lon, c["y"], c["x"]) <= rad)
            npx = sum(1 for p in ph if p["x"] and hav_m(a.lat, a.lon, p["y"], p["x"]) <= rad)
            add("fixed", f"반경{rad}m", f"반경 {rad}m 안 의원 수", nc, "곳", "DT_L33", period=per, variable_id="P011",
                note="기준 좌표는 저장하지 않음")
            add("fixed", f"반경{rad}m", f"반경 {rad}m 안 약국 수", npx, "곳", "DT_L23", period=per, variable_id="X012",
                note="기준 좌표는 저장하지 않음")
        dist = sorted(hav_m(a.lat, a.lon, p["y"], p["x"]) for p in ph if p["x"])
        if dist:
            add("fixed", "", "가장 가까운 약국까지 거리", int(dist[0]), "m", "DT_L23", period=per, note="기준 좌표는 저장하지 않음")
    elif Path(a.team_xlsx).exists():
        print("  팀 정리본(주변 의원·약국)에서 개수와 구성을 가져오고, 심평원 파일로 교차 확인")
        part_team(a.team_xlsx, cl, ph)
    else:
        print("  (--lat --lon 도 팀 정리본도 없어 반경 안 의원·약국 수는 건너뜀)")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8-sig", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=COLS)
        w.writeheader()
        w.writerows(ROWS)
    c = Counter(r["scope"] for r in ROWS)
    print(f"\n저장: {OUT.relative_to(ROOT)}  ({len(ROWS)}행: " + ", ".join(f"{k} {v}" for k, v in c.items()) + ")")


if __name__ == "__main__":
    main()
