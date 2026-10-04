# 서비스 화면 명세 (초안)

사용자: 넥스트페이먼츠 측. 목적: 디지털 페르소나가 실제 인물을 얼마나 대변하는지, 어떤 의사결정 체계를 갖는지 시뮬레이션으로 확인.
상태 표시: **[확정]** 사용자가 정함 / **[제안]** Claude 제안, 팀 확인 필요.

## 1. 화면은 두 흐름으로 쓰인다
**A. 시뮬레이션 보기 [제안]** — 왜 하는가: 페르소나가 어떤 상황에서 어떤 근거로 판단하는지 눈으로 확인. 무엇을 보여 주나: 하루가 지나며 바뀌는 환경, 에이전트의 선택지, 결정 카드(근거 ID 포함).

**B. 검증 비교 [확정된 방식 / 화면은 제안]**
1. 인터뷰에 없는 상황 입력(`scenarios`에 추가).
2. AI(페르소나) 판단 생성.
3. 같은 상황을 실제 약사에게 질문, 답을 수동 입력.
4. 두 답을 나란히 놓고 규칙별 일치/부분/불일치 표시.
5. 약사의 새 답변을 새 근거(`claims`)로 추가(출처·시점 보존). 시뮬레이션 출력은 근거로 추가하지 않는다(G04).

## 2. 요소별 주요 기능 [제안]
| 요소 | 기능 | 쓰는 데이터 |
|---|---|---|
| 건물 탐색 | 전체 보기, 층 선택, 줌 3단계, 회전, 층 분리 | `persona_profile`(층) |
| 층별 장면 | 약국 층(조제실·카운터·진열대·약사 2명), 신규 이비인후과, 정형외과, 거리 | `calendar`, `rx_daily`, `inventory_daily`, `supply_daily` |
| 시뮬레이션 조작 | 시나리오 선택·조건 변경, 재생/정지/배속, 14일 타임라인 | `scenarios`, `virtual_params` |
| 판단실(3층) | 선택지 카드, 결정 카드, 제약 검사 | `rules`, `claims`, `guardrails` |
| HUD·비교 | 현금·처방·재고일수, 시나리오 간 비교 → **페르소나 대 약사 비교로 확장** | `cash_daily`, `rx_daily`, 검증 응답 |
| 근거 열람 | E###/R## 클릭 → 원문(실제 CSV 문구) | `evidence_links` |
| 신뢰(옥상) | 가상 배지, 근거 등급 A/B/C, 구조 검증 결과, 대변 범위 문구, 가드레일 | `data_sources`, `virtual_params`, `guardrails` |

## 3. 데이터 → 시각 매핑 [제안, `ui_bindings.csv`로 확정 필요]
| 데이터 | 시각 |
|---|---|
| `calendar` 휴진 표시 | 이비인후과 대기 인원, 건너편 의원 셔터 |
| `inventory_daily.days_of_supply` | 감기약 진열대 색(≥3.5 초록 / ≥1.5 주황 / <1.5 빨강) |
| `inventory_daily.closing_physical_stock` | 선반 채움 높이 |
| `supply_daily.supplied_qty` | 도매 트럭 적재량·도착 여부 |
| `rx_daily.rx_count_total` | 약국 안 손님 수, HUD |
| `cash_daily.closing_cash_krw` | HUD |
| 환경 변수(감기·독감 지수) | 날씨, 거리 환자 수 |
| `persona_profile.floor` | 약국이 몇 층인지 |
| 결정 카드 JSON | 3층 스크린·선택지 카드, 판단 탭 |

## 4. 결정 카드 JSON (제안 스키마)
```json
{
  "scenario_id": "SC01", "day": 3, "date": "2026-10-08",
  "action": {"type": "order", "item": "감기약 A", "qty": 32, "label": "표준"},
  "confidence": "보통",
  "reasons": [{"text": "...", "refs": ["R02"], "origin": "interview|virtual"}],
  "constraints": [{"id": "cash_cap", "pass": true, "detail": "한도 185개"}],
  "options": [{"label": "유지|소량|표준|대량", "qty": 0, "ok": true, "dos": 1.0, "cash_left": 0}],
  "what_would_change": ["..."],
  "guardrails_applied": ["G02", "G04", "G07"]
}
```
`origin = virtual`인 이유(근거 발언 없음)는 반드시 가상 배지를 붙인다(G02).

## 5. 검증 비교 레코드 (제안)
```json
{
  "case_id": "V001", "situation_ko": "...", "in_interview": false,
  "ai_answer": {"action": "...", "reasons": [], "refs": []},
  "pharmacist_answer": {"text": "...", "recorded_at": "...", "respondent": "응답자 1인"},
  "agreement": [{"rule_id": "R02", "match": "match|partial|mismatch", "note": ""}],
  "added_as_claim_id": null
}
```
수치 일치 기준(n%)은 팀이 정할 때까지 비워 둔다. 약사 응답 원본은 저장소에 올리지 않는다(`.gitignore`).

## 6. 화면에 반드시 들어갈 문구 [제안]
- "이 값은 가상입니다"(가상 배지).
- "인터뷰 1건에 근거한 결과로, 응답자 1인의 판단 범위만 대변합니다."
- "시뮬레이션 출력은 사실로 저장되지 않습니다."
