# 서비스 화면 초안 (localhost)

`docs/SIMULATION_GUIDE.md`의 내용을 화면으로 옮긴 초안이다. 정적 파일이며 별도 설치가 필요 없다.

## 실행

저장소 루트에서 서버를 띄우고 브라우저로 연다. 파일을 직접 열면 CSV를 읽지 못해 동작하지 않는다.

```
python -m http.server 8765
```

http://localhost:8765/app/

## 구성

| 파일 | 역할 |
|---|---|
| `index.html` | 페이지 뼈대, 홈, 사용 가이드 본문 |
| `css/styles.css` | 디자인 토큰(라이트/다크), 컴포넌트 |
| `js/app.js` | 라우팅, 시뮬레이터 3단계, 비교·검증, 근거, 니즈, 온보딩 |
| `js/engine.js` | 재고·입고·구매약정 계산 (코드가 하는 일). 팀 참조팩의 규칙을 다시 구현 |
| `design/building3d.js` | 3D 건물 장면 (1~3층, 인물, 손님 흐름). 팀원 목업에서 옮긴 디자인 파일. 시뮬레이터는 `createScene()` 인터페이스로만 쓴다 |
| `design/preview.html` | 디자인만 따로 보는 화면 (날짜·재생·날씨 연출·재고 상태 조작). http://localhost:8765/app/design/preview.html |
| `design/items.json` | 진열 상품 (floor12 브랜치의 가상 데이터 L56·L57) |
| `js/scene3d.js` | 이전 3D 장면. 쓰지 않지만 되돌릴 수 있게 남겨 둠 (`app.js` 의 import 한 줄을 바꾸면 된다) |
| `js/data.js` | CSV 읽기, 상황 카드, 예시 응답, 니즈 카드, 에이전트 금지 목록. 관측 줄은 `data/4_bridge/card_variables.csv` 에서 만든다 |

근거 문구는 `data/1_interview/*.csv`를, 카드 변수표는 `data/4_bridge/`(cards, card_variables, variable_roles)를, 손님 흐름은 `data/3_virtual/tables/`(calendar, rx_daily, otc_hourly, 모두 가상)를 그대로 읽는다. 인터넷이 필요하다(Three.js, 글꼴 CDN).

## 알아 둘 것

- **시뮬레이터 흐름**: 건물 전체 → 3층 판단실(파란 "3F 판단실" 표시나 오른쪽 버튼)에서 미션 고르기 → 2층 약사 시점(1인칭: 카운터 전산 모니터, 뒤돌아 재고 선반)에서 판단 → 결과 재생. 오른쪽 창은 요약만 보여 주고, 자세한 내용은 3D 위 판단 창에 있다.
- **약사 보기**: 약사에게 다가가 생각 말풍선으로 '어떤 사람인가'(persona_profile.csv 의 정리 문장)를 하나씩 넘겨 본다. 약사의 말 그대로가 아니라 인터뷰 정리 문장이다. 개업 경과 일수는 개업일(2026-09-09, E001)과 오늘 날짜로 계산한다.
- 카운터 전산 모니터에는 관측값(전산 기록)만 띄운다. 확인 전의 실제 재고는 띄우지 않는다.

- **화면은 AI를 직접 호출하지 않는다.** 저장된 실행 결과(`runs/`)만 읽는다. 아래 "AI 답을 만들어 화면에서 보기".
- 수치는 모두 가정이다. `engine.js`의 계산은 팀 보고 검증표(18분기)와 일치하는지 화면 하단에서 자체 점검한다.
- 비교·검증 기록과 니즈 확인 상태는 브라우저 localStorage에만 저장된다. 저장소에 올라가지 않는다.
- 평가용 카드(확장형)는 아직 없다. 지금 카드 6장은 모두 연습용이다 (`docs/SIMULATION_GUIDE.md` 3.3).
- 3D 손님은 결과 **재생 중에만** 움직인다. 손님 수는 가상 데이터, 시간대 분포·대기 기준·마스크 비율은 가정이다. 날씨(비, 미세먼지)는 데이터가 없어 시뮬레이터에서는 맑음으로 고정이고, 연출은 `design/preview.html` 에서만 켤 수 있다. 약사와 AI에게 주지 않은 정보를 3D가 보여 주지 않게 하기 위해서다.

## AI 답을 만들어 화면에서 보기

화면은 AI를 직접 호출하지 않습니다. 터미널에서 AI에게 상황 카드를 풀게 하고 결과를 `runs/` 에 파일로 저장하면, 시뮬레이터의 "저장된 AI 답"과 "약사 답과 비교" 화면이 그 파일(`runs/latest.json`)을 읽습니다.

```
# 1) 호출 없이 요청 수와 토큰만 확인
python scripts/run_persona.py --dry-run

# 2) 개발 중: 한 건씩 바로 실행 (기본 Haiku)
python scripts/run_persona.py --mode sync --cards C01,C05 --reps 1 --yes

# 3) 실제 비교 실행: 일괄 실행 + 캐시 (기본 Sonnet), 6장 x B1/P0/P1 x 3회
python scripts/run_persona.py --mode batch --yes

# 4) 근거를 하나씩 빼 보기: P1 과, 규칙 R01·R02·R03·R08 을 각각 뺀 층을 함께 돌린다
python scripts/run_persona.py --mode batch --layers P1 --ablate cards --yes
```

- 키는 환경변수 `ANTHROPIC_API_KEY` 로만 넣습니다. 저장소에 적지 않습니다.
- 모델 이름과 단가는 `scripts/persona_config.json` 에서 바꿉니다. 단가를 비워 두면 비용 대신 토큰 수만 표시합니다.
- 보내는 것: 상황 카드의 "보이는 정보"와 `data/1_interview/` 의 정리된 CSV(발언, 규칙, 사례, 주의 규칙, 프로필). 전사 원문과 약사 응답 원본은 보내지 않습니다. B1 층에는 인터뷰 자료를 보내지 않습니다.
- 카드 조건의 원본은 `data/4_bridge/cards.csv`, 관측 문장의 원본은 `data/4_bridge/card_variables.csv` 입니다. `app/js/data.js` 의 `CARDS` 도 같은 조건을 갖습니다. 바꾼 뒤에는 `python scripts/run_persona.py --check-cards` 로 조건 일치와 변수 역할(입력 금지 변수를 쓰지 않았는지)을 검사합니다.
- 층: B1(일반 약사), P0(+인터뷰 근거), P1(+장면 입력: 날짜 사정·독감·주변 의원). 약사가 보는 정보와 같은 층은 P1 입니다.
- AI 출력은 사실이 아닙니다. `runs/` 는 `data/` 와 분리되어 있고 근거(claims)로 되먹이지 않습니다.
- 결과 파일에는 AI가 든 근거 번호가 실제 데이터에 있는지(없으면 플래그), B1이 근거 번호를 댔는지, 같은 입력의 반복 결과가 얼마나 일정한지, 판단 요인별 출처(`factor_summary`), 근거 빼 보기 비교(`ablation_summary`)가 함께 기록됩니다. 화면의 "실행 기록"에서 볼 수 있습니다.

## 공공·민간 데이터 미리 받기

```
python scripts/fetch.py --list                                   # 어떤 데이터를 받을 수 있는지 (호출 없음)
python scripts/fetch.py --only DT_L17 --year 2026                # 공휴일
python scripts/fetch.py --only DT_L25,DT_L33 --lat 위도 --lon 경도 --radius 500   # 주변 상가, 병원
```

- 키는 환경변수 `DATA_GO_KR_KEY`(공공데이터포털 일반 인증키)로 넣습니다.
- 목록과 호출 방법의 원본은 `data/2_world/data_sources.csv` 입니다. 현재 3건만 자동으로 받고, 나머지 API 32건은 요청 변수를 확인한 뒤 `scripts/fetch.py` 의 `REGISTRY` 에 추가합니다.
- 받은 값은 `fetched/<data_id>.csv` 에 응답 항목 그대로 저장되고, 행마다 출처·받은 시각·요청 조건이 붙습니다. `fetched/manifest.csv` 에 목록이 정리됩니다. `fetched/` 는 저장소에 올리지 않습니다.
- 약국의 좌표는 저장소에 적지 않고 실행할 때 넘깁니다.
