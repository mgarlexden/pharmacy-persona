#!/usr/bin/env python3
"""reference/가상데이터_더미파일.xlsx -> data/floor12.json 변환 스크립트.

floor12.html(1~2층 개인 작업본)에 박혀 있던 DAYS·ITEMS 배열의 원본 데이터를
엑셀에서 직접 뽑아 JSON으로 분리한다. HTML에는 이 값을 다시 박지 않는다.

현재는 ITEMS(진열 품목, L56+L57)만 만든다. DAYS(날짜별 가상데이터, 00_공통달력+L45+...)는
날짜·달력 기능을 이식할 때 이 스크립트에 추가한다.

실행:  python scripts/build_data.py
"""
import json
from pathlib import Path
import openpyxl

ROOT = Path(__file__).resolve().parents[1]
XLSX = ROOT / "reference" / "가상데이터_더미파일.xlsx"
OUT = ROOT / "data" / "floor12.json"

# floor12.html의 SEASTXT(코드→문구)를 거꾸로 뒤집은 것. L56 '계절성' 열의 문구와
# 정확히 같은 글자여야 한다(다르면 KeyError로 바로 알 수 있게 둔다).
SEASON_KEY = {
    "겨울 감기 유행 연동": "cold",
    "감기 유행 약하게 연동": "coldw",
    "연휴 전날 1.5배": "eve15",
    "연휴 전날 3배": "eve3",
    "여름(7~8월) 1.5배": "sum78",
    "여름(6~8월) 1.3배": "sum68",
    "봄 황사·미세먼지 1.6배": "dust",
    "없음": "none",
}


def load_items():
    wb = openpyxl.load_workbook(XLSX, data_only=True, read_only=True)
    l56 = {r[0]: r for r in wb["L56_상품구성·진열위치"].iter_rows(min_row=2, values_only=True) if r[0]}
    l57 = {r[0]: r for r in wb["L57_상품별마진"].iter_rows(min_row=2, values_only=True) if r[0]}

    items = []
    for code, r in l56.items():
        _, name, dept, category, zone, height, faces, weight, _pct, season_ko, _vendor = r
        if dept == "전문의약품":
            continue  # 조제실 전용(비공개 진열) — 손님이 보는 진열 품목이 아니다
        _, _, _, _, price, _cost, margin_pct, *_ = l57[code]
        items.append({
            "code": code,
            "name_ko": name,
            "department_ko": dept,
            "category_ko": category,
            "zone_ko": zone,
            "shelf_height_ko": height,
            "faces": faces,
            "sales_weight": weight,
            "season_key": SEASON_KEY[season_ko],
            "season_ko": season_ko,
            "price_krw": price,
            "margin_pct": margin_pct,
        })
    return items


def main():
    items = load_items()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps({"items": items}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"  data/floor12.json  (items {len(items)}개)")


if __name__ == "__main__":
    main()
