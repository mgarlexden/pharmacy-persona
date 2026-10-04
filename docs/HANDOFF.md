# 인수인계 — 지금까지의 모든 결정과 상태

작성: 2026-10-05, Claude(Cowork) 대화 → VS Code의 Claude Code로 이어받기 위한 문서.
같이 읽을 것: `CLAUDE.md`(규칙), `README.md`(데이터 구조), `docs/SERVICE_SCREEN_SPEC.md`(화면 명세), `docs/MOCK_NOTES.md`(목업 코드 설명), `docs/NEXT_PROMPTS.md`(바로 붙여넣을 작업 프롬프트).

## 0. 프로젝트 배경
- SDIC × 넥스트페이먼츠 산학협력 "소상공인 디지털 페르소나". 15명(AI & Architecture / Research).
- 온톨로지 기반 PoC로 **동네 약국 운영자 1명**의 판단을 시뮬레이션한다. 구성: 시뮬레이터(코드) + LLM 판단 에이전트 + UI/UX.
- 근거 자료는 **인터뷰 1건**(개업 3주차, 약사 2인, 2층 약국)뿐이다. 추가 인터뷰는 나중에.
- 이 서비스를 쓰는 사람은 약국 운영자가 아니라 **넥스트페이먼츠 측**이다.

## 1. 목적과 검증 방식 (확정)
- 목적: 이 디지털 페르소나가 **실제 인물을 얼마나 대변하는지**, **어떤 의사결정 체계를 갖는지** 시뮬레이션으로 확인.
- 실제 약사 = **검증자**. 인터뷰에 없는 상황을 만들어 AI에게 묻고, 같은 상황을 실제 약사에게도 물어 두 답을 비교한다.
- 약사의 새 답변이나 새 약사 인터뷰는 **새 근거로 `claims`에 추가**한다(시뮬레이션 학습 자료).
- **시뮬레이션 출력을 "사실"로 가정해 다시 반영하지 않는다**(G04).
- 가상 데이터 수치의 현실성 검증(실제 약사에게 오차 n% 이내 확인)은 **추후 과제**. `validation_ranges.tolerance_pct`는 의도적으로 비어 있다.
- 범위 한계: 인터뷰 1건이므로 "이 약사 1명을 얼마나 닮았나"까지만 말할 수 있다. 동네 약국 일반의 대변은 주장하지 않는다. 약사 2인 중 응답자는 1명이다(G07). 화면에도 이 범위 문구를 넣을 것.

## 2. 데이터 현황 (완료)
`README.md`가 상세 설명. 요약:
- 구조 파일 16개(`data/`) + 가상 시계열 7개(`data/3_virtual/tables/`). `python scripts/validate.py` 8가지 검증 통과.
- 폴더: `0_common`(enums, entity_product) / `1_interview`(claims 98, variables 85, persona_profile 18, rules 18, evidence_links 366, guardrails 7) / `2_world`(data_sources 63 = 실 31·참고 17·가상 15, key_registry 107, variable_data_map 88) / `3_virtual`(virtual_params 44, field_defs 95, tables ×7) / `4_bridge`(field_map, scenarios) / `5_validation`(validation_ranges 30).
- 1·2·3번 폴더 원본 = `source/*.xlsx`(→ `build.py`), 0·4·5번 = CSV 직접 편집.
- 세 가지 표시: `judgement`(real/reference/virtual), `value_origin`(measured/derived/assumption/interview/decision), `support_grade`(A/B/C, 가정은 A 불가).
- **아직 없는 것:** 사례 기록 `cases.csv`(I01~I19, 원본 `source/interview_master.xlsx` 04_사건학습), 가상 시트 9개(L46, L51, L53~L59), 8개 데이터(L08, L09, L16, L36, L56, L57, L59, L63)의 키 추출, 공공/민간 데이터의 **실제 값**(API 미연동).
- **초안:** `field_map.csv`(draft), `scenarios.csv`(SC01 proposed), `field_defs.role`.
- **불일치:** 가상 약국(1층·개설 4년차·약사 1+직원) ≠ 인터뷰 약국(2층·3주차·약사 2인). `virtual_params.action = regenerate_with_profile`.
- `virtual_params.variable_id`는 후보(`candidate`)이며 팀 확인 후 `confirmed`.

## 3. 서비스 화면 (설계 결정)
상세는 `docs/SERVICE_SCREEN_SPEC.md`. 요약:
- **건물 메타포**: 층 = 메뉴. 줌 3단계(건물 → 층 → 물건). 아래층은 세계(약국·병원·거리), 윗층은 판단.
- 옥상 관제실(근거·검증) / 5F 인력(2차, 잠김) / 4F 진열(2차, 잠김) / **3F 발주 판단실(슬라이스 1)** / **2F 약국+신규 이비인후과(인터뷰 사실 E002·E003)** / 1F 로비+정형외과 / 거리(날씨·환자·도매 트럭·건너편 기존 이비인후과).
- 하루 턴: 외부 사건 → 시뮬레이터(코드) 상태 갱신 → LLM 에이전트 행동 제안 → 코드가 제약 검사 → 결과가 다음 날로.
- 의사결정 시각화: 선택지 카드 4장 + 결정 카드(행동·이유와 근거 ID·제약 검사·확신도·"무엇이 바뀌면 판단이 달라지나").
- 슬라이스 1 후보(미확정): 감기·독감 유행 + 기존 이비인후과 휴진 + 도매 품절 + 신규약국 현금 제약 → 발주 판단. 근거 규칙 R02·R03·R04·R08.
- 레퍼런스: Two Point Hospital/Campus, Project Hospital, Oxygen Not Included(오버레이), Tiny Tower(2D 단면). 사진은 못 가져왔으므로 위키/스팀 페이지에서 직접 확인.
- 약국 위치는 2층으로 확정 제안(인터뷰 사실). 교정 치과(E014)는 층 정보가 없어 그리지 않음.

## 4. 목업
- 파일: `prototype/building_mock.html`(브라우저로 바로 열기), `prototype/building_mock.fragment.html`(claude.ai 아티팩트용 원본).
- Claude 아티팩트(비공개, 소유자만): 구조도 https://claude.ai/artifact/CJh6iX6ps2FX7ynR3AoLjD (공개 링크) / CSV 점검 화면 https://claude.ai/artifact/SADGUqDM6TKLpQmyXuSYLu / 서비스 목업 https://claude.ai/artifact/892BiwrwtSJm1PhZGH4RgW. 2·3번은 비공개라 팀 공유 시 공유 메뉴에서 열어야 한다.
- **한계(반드시 팀에 알릴 것):** 수치는 임의의 가상값이며 CSV와 연결되어 있지 않다. 결정은 LLM이 아니라 `simulate()`의 규칙 계산. R02 등 규칙·발언 문구만 실제 CSV 내용.
- **없는 것:** AI 답 대 실제 약사 답 비교 화면, 규칙별 일치도, 대변 범위 문구. 목적상 가장 중요한 화면이다.

## 5. 다음 작업 (우선순위 제안)
1. 검증 비교 화면(AI 판단 ↔ 약사 응답 ↔ 규칙별 일치 ↔ 새 근거 추가 흐름).
2. 로컬 앱화: CSV를 읽어 화면 구동, 에이전트 호출부와 제약 검사 코드 분리. (기술 스택은 아직 미정 — Claude Code가 제안 후 확인받을 것)
3. `cases.csv`, 가상 시트 9개 변환, `ui_bindings.csv`, `pharmacy_layout.json`.
4. `fetch.py`(공공/민간 데이터 사전 수집, `fetched/`는 git 제외).
5. 가상 약국을 인터뷰 프로필로 재생성.

## 6. 팀이 정해야 할 것
슬라이스 확정 / 시뮬레이션 지역(서울?) / `cases.csv` 포함 / 일치도 허용 기준(n%) / 슬라이스 변수 15~20개 / `variable_id` 후보 확정 / 같은 건물 이비인후과 휴진 vs 인근 기존 의원 휴진 해석.

## 7. 일정 (2026-10-05 기준)
- 월 21:00 구현 피드백 회의 → 월 밤~새벽 PoC 완성 → **화 14:00 대표님 미팅 시연**.
- 시간이 촉박하다. PoC는 "목업 + 검증 비교 화면의 최소 동작"을 목표로 범위를 줄일 것.

## 8. 대화에서 정해진 작업 방식
- 사용자는 PM이며 한국어로 소통한다. 쉽게 설명하는 방식을 선호한다(데이터·온톨로지 전문가가 비전문가에게 설명하듯).
- 파일을 만들지 말라고 한 적이 있다. 이번에는 요청 시에만 만들고, 구조에 없는 파일은 먼저 확인받는다.
- 산출물(화면·문서)에 팀원 실명을 쓰지 않는다. 역할로 쓴다.
- 확인하지 않은 사실을 단정하지 않는다. 출처 제공자 이름도 확인 후 쓴다(과거에 틀린 사례 있음).
- 외부로 나가는 행동(push, 공유, 메시지 전송)은 실행 전에 확인받는다.
