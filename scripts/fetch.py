#!/usr/bin/env python
"""공공·민간 공개 데이터를 한 번에 받아 fetched/ 에 CSV 로 저장한다. 화면은 저장된 값만 읽는다.

원칙
- 목록과 호출 방법의 원본은 data/2_world/data_sources.csv (how_to_get, access_limit 열)다. 이 파일은 거기 적힌 주소와 요청 변수를 옮긴 것이다.
- 값을 고쳐 쓰지 않는다. 응답 항목을 평평하게 펴서 그대로 저장하고, 행마다 출처·받은 시각·요청 조건을 붙인다.
- 키는 환경변수 DATA_GO_KR_KEY (공공데이터포털 일반 인증키)로만 받는다. 저장소에는 두지 않는다. fetched/ 는 .gitignore 대상이다.
- 약국 좌표는 이 저장소에 적지 않는다. 필요한 때 --lat/--lon 으로 넘긴다.

현재 구현된 데이터셋 (data_sources.csv 의 how_to_get 에 요청 변수가 적힌 것)
  DT_L17  특일 정보(공휴일)          --year
  DT_L25  상가(상권)정보 반경 검색    --lat --lon --radius
  DT_L33  병원정보서비스 반경 검색    --lat --lon --radius
나머지 API 는 요청 변수를 확인한 뒤 REGISTRY 에 항목을 추가한다 (--list 로 상태를 본다).
파일 다운로드·웹 조회·가상 데이터 항목은 이 스크립트가 받지 않는다.

예)
  python scripts/fetch.py --list
  python scripts/fetch.py --only DT_L17 --year 2026
  python scripts/fetch.py --only DT_L25,DT_L33 --lat 37.5 --lon 127.0 --radius 500
"""
import argparse
import csv
import datetime as dt
import json
import os
import sys
import time
import urllib.parse
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for _s in (sys.stdout, sys.stderr):  # Windows 콘솔(cp949/cp1252)에서 한글이 깨지거나 오류가 나지 않게
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
SOURCES = ROOT / "data" / "2_world" / "data_sources.csv"
OUT = ROOT / "fetched"


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

# data_id -> 호출 정의. params 는 사용자가 넘기는 값으로 채운다.
REGISTRY = {
    "DT_L17": dict(
        url="https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo",
        fmt="json", needs=["year"], page_size=100,
        build=lambda a: {"solYear": a.year, "_type": "json"},
    ),
    "DT_L25": dict(
        url="https://apis.data.go.kr/B553077/api/open/sdsc2/storeListInRadius",
        fmt="json", needs=["lat", "lon"], page_size=1000,
        build=lambda a: {"cx": a.lon, "cy": a.lat, "radius": a.radius, "type": "json"},
    ),
    "DT_L33": dict(
        url="https://apis.data.go.kr/B551182/hospInfoServicev2/getHospBasisList",
        fmt="xml", needs=["lat", "lon"], page_size=1000,
        # xPos 는 경도, yPos 는 위도로 가정했다. 첫 호출 결과의 좌표로 확인할 것.
        build=lambda a: {"xPos": a.lon, "yPos": a.lat, "radius": a.radius},
    ),
}


# ---------------------------------------------------------------- 응답 해석
def flatten(d, prefix=""):
    out = {}
    for k, v in d.items():
        key = f"{prefix}{k}"
        if isinstance(v, dict):
            out.update(flatten(v, key + "."))
        elif isinstance(v, list):
            out[key] = json.dumps(v, ensure_ascii=False)
        else:
            out[key] = "" if v is None else v
    return out


def find_rows_json(obj):
    """중첩된 JSON 에서 처음 나오는 '딕셔너리 목록' 또는 item 하나를 행으로 꺼낸다."""
    if isinstance(obj, list):
        if obj and all(isinstance(x, dict) for x in obj):
            return obj
        return []
    if isinstance(obj, dict):
        if "item" in obj:
            it = obj["item"]
            return it if isinstance(it, list) else [it] if isinstance(it, dict) else []
        for v in obj.values():
            r = find_rows_json(v)
            if r:
                return r
    return []


def find_total_json(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k.lower() == "totalcount":
                try:
                    return int(v)
                except (TypeError, ValueError):
                    return None
            r = find_total_json(v)
            if r is not None:
                return r
    return None


def parse_json(text):
    data = json.loads(text)
    # 오류 응답: header.resultCode != 00 (공공데이터포털 공통 형식)
    code = msg = None
    def walk(o):
        nonlocal code, msg
        if isinstance(o, dict):
            if "resultCode" in o and code is None:
                code, msg = str(o["resultCode"]), o.get("resultMsg")
            for v in o.values():
                walk(v)
    walk(data)
    return [flatten(r) for r in find_rows_json(data)], find_total_json(data), code, msg


def parse_xml(text):
    root = ET.fromstring(text)
    code = root.findtext(".//resultCode")
    msg = root.findtext(".//resultMsg")
    total = root.findtext(".//totalCount")
    rows = [{c.tag: (c.text or "") for c in it} for it in root.iter("item")]
    return rows, int(total) if total and total.isdigit() else None, code, msg


# ---------------------------------------------------------------- 호출
def get_key():
    key = os.environ.get("DATA_GO_KR_KEY", "").strip()
    if not key:
        sys.exit("DATA_GO_KR_KEY 환경변수가 없습니다. 공공데이터포털에서 받은 일반 인증키를 환경변수로 넣으세요 (저장소에 적지 않습니다).")
    return urllib.parse.unquote(key) if "%" in key else key


def fetch_one(did, spec, args, key, session):
    params = spec["build"](args)
    rows_all, page, total = [], 1, None
    while page <= args.max_pages:
        q = dict(params, serviceKey=key, pageNo=page, numOfRows=spec["page_size"])
        r = session.get(spec["url"], params=q, timeout=30)
        r.raise_for_status()
        rows, tot, code, msg = (parse_json if spec["fmt"] == "json" else parse_xml)(r.text)
        if code not in (None, "00", "0", "INFO-000", "000"):
            sys.exit(f"{did}: 서버가 오류를 돌려줬습니다 (resultCode={code}, {msg}). 키, 요청 변수, 일일 호출 한도를 확인하세요.")
        total = tot if tot is not None else total
        rows_all += rows
        if not rows or (total is not None and len(rows_all) >= total):
            break
        page += 1
        time.sleep(0.2)
    return params, rows_all, total


def write_csv(did, rows, params, spec, fetched_at):
    OUT.mkdir(exist_ok=True)
    meta = {"_data_id": did, "_fetched_at": fetched_at, "_endpoint": spec["url"], "_params": json.dumps(params, ensure_ascii=False)}
    cols = []
    for r in rows:
        for k in r:
            if k not in cols:
                cols.append(k)
    cols += list(meta)
    path = OUT / f"{did}.csv"
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for r in rows:
            w.writerow({**r, **meta})
    return path


def update_manifest(entries):
    path = OUT / "manifest.csv"
    cols = ["data_id", "dataset_name", "provider", "rows", "fetched_at", "params", "access_limit_note", "file"]
    cur = {}
    if path.exists():
        with open(path, encoding="utf-8-sig", newline="") as f:
            cur = {r["data_id"]: r for r in csv.DictReader(f)}
    for e in entries:
        cur[e["data_id"]] = e
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for k in sorted(cur):
            w.writerow(cur[k])


def load_sources():
    with open(SOURCES, encoding="utf-8-sig", newline="") as f:
        return {r["data_id"]: r for r in csv.DictReader(f)}


def print_list():
    src = load_sources()
    kinds = {"auto": [], "pending": [], "manual": [], "virtual": []}
    for did, r in src.items():
        am = r["access_method"]
        if r["judgement"] == "virtual":
            kinds["virtual"].append(did)
        elif did in REGISTRY:
            kinds["auto"].append(did)
        elif "API" in am:
            kinds["pending"].append(did)
        else:
            kinds["manual"].append(did)
    print(f"구현됨(자동 수집) {len(kinds['auto'])}건: {', '.join(kinds['auto'])}")
    print(f"API 이지만 요청 변수 확인 필요 {len(kinds['pending'])}건: {', '.join(kinds['pending'])}")
    print(f"파일 다운로드·웹 조회·원자료 가공(수동) {len(kinds['manual'])}건: {', '.join(kinds['manual'])}")
    print(f"가상 데이터 {len(kinds['virtual'])}건 (받지 않음)")
    print("\n구현된 항목의 원본 설명:")
    for did in kinds["auto"]:
        r = src[did]
        print(f"- {did} {r['dataset_name'][:50]} | {r['access_limit'].splitlines()[1] if len(r['access_limit'].splitlines()) > 1 else ''}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--list", action="store_true", help="데이터셋별 수집 가능 여부를 본다 (호출 없음)")
    ap.add_argument("--only", default=None, help="쉼표로 구분한 data_id")
    ap.add_argument("--year", type=int, default=2026)
    ap.add_argument("--lat", type=float)
    ap.add_argument("--lon", type=float)
    ap.add_argument("--radius", type=int, default=500)
    ap.add_argument("--max-pages", type=int, default=50)
    a = ap.parse_args()

    if a.list or not a.only:
        print_list()
        if not a.only:
            return
    ids = [x.strip() for x in a.only.split(",") if x.strip()]
    unknown = [i for i in ids if i not in REGISTRY]
    if unknown:
        sys.exit(f"아직 구현되지 않은 데이터셋: {unknown}. --list 로 상태를 확인하세요.")
    for i in ids:
        miss = [n for n in REGISTRY[i]["needs"] if getattr(a, n) is None]
        if miss:
            sys.exit(f"{i} 에는 --{' --'.join(miss)} 가 필요합니다.")

    import requests
    key = get_key()
    src = load_sources()
    session = requests.Session()
    entries = []
    for did in ids:
        spec = REGISTRY[did]
        fetched_at = dt.datetime.now().isoformat(timespec="seconds")
        params, rows, total = fetch_one(did, spec, a, key, session)
        path = write_csv(did, rows, params, spec, fetched_at)
        r = src.get(did, {})
        entries.append(dict(data_id=did, dataset_name=r.get("dataset_name", ""), provider=r.get("provider", ""), rows=len(rows),
                            fetched_at=fetched_at, params=json.dumps(params, ensure_ascii=False),
                            access_limit_note=(r.get("access_limit", "").splitlines() or [""])[0], file=str(path.relative_to(ROOT))))
        print(f"{did}: {len(rows)}행 저장 → {path.relative_to(ROOT)} (서버가 알려 준 전체 {total})")
    update_manifest(entries)
    print("fetched/manifest.csv 를 갱신했습니다. 같은 요청 변수로 다시 받으면 덮어씁니다.")


if __name__ == "__main__":
    main()
