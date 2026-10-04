# 약국 디지털 페르소나 · 1차 데이터 구조

동네 약국 운영자의 판단을 시뮬레이션하기 위한 **CSV 데이터 묶음**입니다.
이 저장소는 `data/` 안의 **구조 파일 17개**와 별도의 **시계열 표 7개(`3_virtual/tables/`)** 로 이루어집니다.

> 구조 파일 17개 = 값을 설명하고 서로 잇는 파일. 시계열 표 7개 = 가상 약국의 날짜별 데이터 본문.
> 둘은 별개이므로 합쳐 24개로 세지 않고, 위처럼 나누어 부릅니다.

## 팀원 필독

**처음 오셨다면:** `docs/HANDOFF.md`(지금까지의 결정과 남은 작업) → `docs/SERVICE_SCREEN_SPEC.md`(화면 명세) 순서로 읽으세요.

### 이 저장소는 private입니다
인터뷰 원문(실제 인물 1명)이 들어 있습니다. 저장소를 공개로 바꾸거나, 데이터·화면을 팀 밖에 전달하지 마세요.
약사 응답 원본(`validation_responses/`, `responses_raw/`)과 외부 API 수집분(`fetched/`), `.env`는 `.gitignore`로 제외되어 있으니 올리지 마세요.

### 파일 수정 규칙
1. **`data/1_interview`, `2_world`, `3_virtual`의 CSV는 직접 고치지 마세요.** `source/`의 Excel이 원본이고, CSV를 고치면 다음 빌드에서 덮어써집니다.
   (사람이 채우는 열은 보존됩니다. 아래 "만드는 방법과 지킬 규칙" 참고)
2. **`source/*.xlsx`는 한 번에 한 명만 수정하세요.** Excel은 git으로 병합되지 않습니다. 수정하기 전에 팀 채널에 알리고,
   수정 후 바로 커밋·push 하세요. 두 명이 동시에 고치면 한쪽 변경이 사라집니다.
3. `data/0_common`, `4_bridge`, `5_validation`의 CSV는 직접 편집합니다. 이 경우 Excel을 건드릴 필요가 없습니다.
4. **수정 후에는 항상 순서대로 실행하세요.** 전부 통과해야 커밋합니다.
   ```
   python scripts/build.py          # Excel → CSV (Excel을 고친 경우)
   python scripts/validate.py       # 구조 검증 8가지
   python scripts/build_viewer.py   # 점검 화면 갱신
   ```
   최초 1회: `pip install openpyxl` (Python 3 필요)
5. 커밋할 때는 Excel 변경과 그 결과 CSV, `viewer/index.html`을 **같은 커밋**에 담으세요. 원본과 산출물이 어긋나지 않게 하기 위함입니다.

### 내용 규칙
- **화면에 나오는 가상 수치에는 "가상" 배지를 붙입니다.** 없는 수량·비율을 새로 만들지 않습니다.
- **시뮬레이션 출력은 사실이 아닙니다.** 이를 근거(`claims`)로 되먹이지 않습니다.
- **약사 2인 중 응답자는 1명입니다.** 약국 전체의 합의나 성향으로 단정하지 않습니다.
- 판단 근거를 보여 줄 때는 `claims`/`rules`의 ID(E###, R##)를 인용하고, 실제 CSV 문구만 씁니다.
- **팀원 실명은 문서와 화면에 쓰지 않습니다.** 역할로 표기합니다. (git 커밋 작성자 이름은 예외)
- 데이터 ID는 `DT_` 접두어(`DT_L11`), 열 이름은 영문 `snake_case` + `*_ko`.

### 작업 방식
- `main`에 바로 올리기보다 브랜치에서 작업하고 PR로 합치는 것을 권장합니다.
- OneDrive 같은 동기화 폴더 안에서 작업하면 `.git`이 꼬일 수 있습니다. 동기화되지 않는 경로(예: `C:\dev\`)에 clone하세요.
- `scripts/viewer_template.html`은 데이터가 없는 틀입니다. 점검 화면은 반드시 `viewer/index.html`을 여세요.

## 폴더와 파일

| 폴더 | 파일 | 역할 | 원본 |
|---|---|---|---|
| `0_common` | `enums.csv` | 모든 코드값의 사전 (허용되는 값 목록) | CSV 직접 편집 |
| | `entity_product.csv` | 품목 마스터 (가상 품목 코드, 실제 의약품 코드 자리) | CSV 직접 편집 (`item_seq`, `edi13`은 팀이 채움) |
| `1_interview` | `claims.csv` | 인터뷰 발언 근거 (E001…, U001) | Excel `interview_master.xlsx` |
| | `variables.csv` | 변수 85개 (인터뷰 쪽과 데이터 쪽을 잇는 중심 표) | 〃 + `data_classification.xlsx` |
| | `persona_profile.csv` | 인터뷰 약국 프로필 (서술 13행 + 확인된 사실값 5행) | 〃 |
| | `rules.csv` | 판단규칙 R01~R18 | 〃 |
| | `evidence_links.csv` | 발언·규칙·변수·프로필·사례 사이의 연결 (한 줄 = 연결 하나) | 위 파일들에서 자동 생성 |
| | `guardrails.csv` | 주의 규칙 G01~G07 | Excel `interview_extension.xlsx` |
| | `cases.csv` | 사례 기록 I01~I19 (실행/회고/가정/제안 반응 구분, 판단 에이전트 참고용) | Excel `interview_master.xlsx` (04_사건학습) |
| `2_world` | `data_sources.csv` | 공개·참고·가상 데이터 63종의 목록 | Excel `data_classification.xlsx` |
| | `key_registry.csv` | 데이터를 잇는 키(시군구, 요양기관기호 등)와 사용처 | 위 파일의 '연결 키' 문장에서 자동 추출 |
| | `variable_data_map.csv` | 변수 ↔ 데이터 연결 (88행, 변수 51개) | Excel `3_변수 대조` |
| `3_virtual` | `virtual_params.csv` | 가상값의 출처·값 성격·근거 등급 | Excel `virtual_dummy.xlsx` `파라미터` + 등급 열은 CSV 직접 편집 |
| | `field_defs.csv` | 시계열 표 열 정의 (영문 열 이름, 한글 이름, 단위, 역할) | Excel `필드정의` + 영문 이름 |
| | `tables/*.csv` (7개) | 날짜별 시계열 | Excel `virtual_dummy.xlsx` |
| `4_bridge` | `field_map.csv` | 데이터 열 → 시뮬레이터 상태 필드 대응 | CSV 직접 편집 |
| | `scenarios.csv` | 시나리오 정의(제안 단계) | CSV 직접 편집 |
| `5_validation` | `validation_ranges.csv` | 약사에게 물어볼 항목과 허용 오차 | CSV 직접 편집 |

시계열 7개: `calendar`(공통달력), `rx_daily`(L45 처방), `otc_hourly`(L47 일반약, 시간별), `inventory_daily`(L48 재고),
`cash_daily`(L49 현금), `payment_daily`(L50 결제), `supply_daily`(L52 공급).

## 연결 방식

파일은 **ID로만** 이어집니다. 값을 복사해 두지 않고 ID로 찾아갑니다.

- 변수 ID (`P001`, `S008`, …) : `variables.csv` 가 중심입니다.
- 근거 ID (`E001`) → `claims.csv`, 규칙 ID (`R01`) → `rules.csv`, 사례 ID (`I01`) → `cases.csv`, 연결은 `evidence_links.csv`
  (사례는 `case_cites_claim`/`case_illustrates_rule` 로 근거·규칙과 이어집니다)
- 데이터 ID는 `DT_L01` 처럼 **`DT_` 접두어**를 붙입니다. 변수 `L012`(결과·학습)와 데이터 `L12`가 헷갈리지 않게 하기 위함입니다.
- 품목 ID (`R001`, `O001`…) → `entity_product.csv`, 거래처 (`VA`/`VB`/`VC`) → `enums.csv`
- 시계열 표의 `pharmacy_id` 는 어느 약국의 데이터인지 가리킵니다. 지금은 가상 약국 `PH_DUMMY_01` 하나입니다.

한 가지 사실은 한 곳에만 둡니다. 예를 들어 품목 이름은 `entity_product.csv` 에만 있고,
`inventory_daily.csv` 는 `product_id` 만 갖습니다. 요일·휴진·연휴 구분은 `calendar.csv` 에만 있고 날짜로 찾아갑니다.

## 값에 붙는 표시 세 가지 (서로 다른 질문에 답합니다)

| 표시 | 위치 | 묻는 것 | 값 |
|---|---|---|---|
| `judgement` | `data_sources` | 이 데이터가 실제 개체 데이터인가 | real / reference / virtual |
| `value_origin` | `virtual_params` | 이 숫자는 어떻게 얻었나 | measured / derived / assumption / interview / decision |
| `support_grade` | `virtual_params` | 근거가 얼마나 탄탄한가 | A / B / C |

규칙: **`assumption` 은 A 가 될 수 없습니다.** `decision`(팀이 정한 설정값)은 등급 없이 비워 둡니다.

## 만드는 방법과 지킬 규칙

1. **1·2·3번 폴더는 Excel이 원본**입니다. `source/` 의 Excel 을 고치고 `python scripts/build.py` 를 실행합니다.
   CSV 를 직접 고치면 다음 실행 때 덮어써집니다. 단, 사람이 채우는 열(`slice1`, `support_grade`, `grade_reason_ko`,
   `profile_ref`, `action`, `publish_lag_days`, `item_seq`, `edi13`, `main_vendor_id`)은 키를 기준으로 **보존**됩니다.
2. **0·4·5번 폴더는 CSV 가 원본**입니다. 직접 편집합니다. (`build.py` 는 파일이 없을 때만 초안을 만듭니다.)
3. 변환된 파일에는 `source_file`, `source_sheet`, `generated_at` 열이 붙습니다. 어디서 왔는지 추적하기 위함입니다.
4. 열 이름은 영문 `snake_case`, 한글 이름은 `label_ko` / `*_ko` 열에 둡니다. 파일은 UTF-8 (BOM 포함)이라 Excel 에서 바로 열립니다.
5. 수정 후에는 `python scripts/validate.py` 를 실행합니다. 아래 8가지를 검사합니다.

### 검증 8가지

1. 모든 ID가 해당 파일에 실제로 있는가 (연결, 매핑, 필드 대응, 시나리오 대상, 시계열 열 포함)
2. 인터뷰 전용 변수 34개가 `variable_data_map` 에 없는가
3. 세계 데이터와 연결된 변수 51개가 모두 `variable_data_map` 에 있고, 그 데이터 ID가 `data_sources` 에 있는가
4. 코드값이 `enums.csv` 안에 있는가 (판정, 값 성격, 등급, 범주, 거래처, 품목 구분, 연결 종류 등)
5. 가상값마다 값 성격과 등급이 있고, `assumption` 이 A 가 아닌가
6. 인터뷰 프로필에 있는 속성은 `virtual_params` 가 `profile_ref` 로 가리키는가 (값을 따로 정의하지 않는다)
7. 변환 파일에 출처 열 3개가 있는가
8. 열 이름이 `snake_case` 이고 데이터 ID가 `DT_Lnn` 형식이며 `field_defs` 와 시계열 표 열이 일치하는가

## 이 묶음에서 알려진 한계 (1차)

- **`key_registry.csv` 는 키 사전과 사용처 목록을 한 파일에 합친 형태**입니다 (한 줄 = 키 하나가 한 데이터에 쓰인다는 뜻).
  키의 정규 형식(`canonical_format`)이 같은 키에서 반복됩니다. 2차에서 분리할 수 있습니다.
  키 추출은 '연결 키' 문장을 단어로 찾은 것이라 8개 데이터(L08, L09, L16, L36, L56, L57, L59, L63)는 키가 비어 있습니다.
- **가상 데이터 시계열은 7개만 변환했습니다.** 나머지(L46, L51, L53, L54, L55, L56, L57, L58, L59)는 2차에서 필요할 때 추가합니다.
- **가상 약국은 아직 인터뷰 약국과 다릅니다** (더미: 1층·개설 4년차·약사 1인 + 직원, 인터뷰: 2층·개업 3주차·약사 2인).
  `virtual_params.csv` 의 `action = regenerate_with_profile` 이 이를 표시합니다. 재생성 후 `pharmacy_id` 를 바꿉니다.
- 검증의 허용 오차(`tolerance_pct`)는 **비워 두었습니다.** 추후 과제입니다. 약사 응답 원본은 저장소에 올리지 않습니다.
- `scenarios.csv` 와 `field_map.csv` 는 **초안**입니다 (`status`가 `proposed` / `draft`). 슬라이스 확정 후 고칩니다.
- `field_defs.csv` 의 `role`(input/derived)은 제가 열 이름으로 구분한 초안이라 검토가 필요합니다.
- 더미의 이비인후과 휴진이 같은 건물 의원인지, 인근 기존 의원인지 확인이 필요합니다 (`field_map.csv` 메모 참고).

## 점검 화면

`python scripts/build_viewer.py` 를 실행하면 `viewer/index.html` 한 파일이 만들어집니다. 브라우저로 열면 됩니다(설치 불필요).
탭 ‘검색’에서는 ID나 인터뷰 발언 속 단어로 변수, 발언, 데이터, 가상값, 규칙을 한꺼번에 찾아 연결을 확인할 수 있습니다.
**`scripts/viewer_template.html` 은 데이터가 없는 틀이라 열어도 빈 화면이 나옵니다. 반드시 `viewer/index.html` 을 여세요.**
변수 85개가 근거 발언과 함께 나오는지, 데이터 63종이 변수와 이어지는지, 가상값 44개의 출처와 등급, 시계열 7개가 열 정의대로인지를 확인합니다.
구조 검증 8가지의 결과도 요약 탭에 나옵니다. CSV를 고친 뒤에는 다시 실행하세요.
실데이터·참고용 데이터의 실제 값은 아직 받아 오지 않았으므로(API 연동 전) 데이터 탭에서는 명세만 보입니다.

`virtual_params.csv` 의 `variable_id` 는 가상값이 어느 변수를 채우는지 가리키는 열입니다. 현재 값은 **후보**(`variable_link_status = candidate`)이므로
PM 확인 후 `confirmed` 로 바꿉니다.

## 폴더 구조

```
pharmacy-persona-data/
├─ README.md
├─ CLAUDE.md                    AI 작업 지침
├─ docs/                        HANDOFF, SERVICE_SCREEN_SPEC, MOCK_NOTES, NEXT_PROMPTS
├─ prototype/                   화면 목업 (building_mock)
├─ source/                      원본 Excel 4개
├─ viewer/index.html            점검 화면 (build_viewer.py 로 생성)
├─ scripts/
│   ├─ build.py                 Excel → CSV
│   ├─ validate.py              검증 8가지
│   └─ build_viewer.py          점검 화면 생성
└─ data/
    ├─ 0_common/                enums, entity_product
    ├─ 1_interview/             claims, variables, persona_profile, rules, evidence_links, guardrails, cases
    ├─ 2_world/                 key_registry, data_sources, variable_data_map
    ├─ 3_virtual/               virtual_params, field_defs, tables/ (7개)
    ├─ 4_bridge/                field_map, scenarios
    └─ 5_validation/            validation_ranges
```
