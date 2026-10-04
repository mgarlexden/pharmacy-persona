# 바로 붙여넣는 프롬프트 모음 (VS Code의 Claude Code용)

## 0. 시작 프롬프트 (새 세션 첫 메시지)
```
이 저장소는 "약국 디지털 페르소나" PoC야. 먼저 CLAUDE.md, docs/HANDOFF.md, docs/SERVICE_SCREEN_SPEC.md, docs/MOCK_NOTES.md, README.md를 읽고 아래를 알려줘.
1) 프로젝트 목적과 사용자, 검증 방식을 네 말로 3~4문장으로
2) 데이터 구조(16개 + 7개)에서 아직 없거나 초안인 것
3) 목업(prototype/building_mock.html)이 실제로 하는 것과 하지 않는 것
4) 내가 지금 결정해줘야 하는 것
그리고 python scripts/validate.py 를 돌려서 8가지가 통과하는지, git·Node·Python 버전, 사용 가능한 도구 목록도 확인해줘. 확인이 끝나기 전에는 파일을 수정하지 마.
```

## 1. 로컬 앱으로 만들기
```
prototype/building_mock.html 을 localhost에서 도는 앱으로 바꿔줘. 조건:
- 기술 스택은 먼저 2~3개 후보와 장단점을 알려주고 내가 고르면 진행
- data/ 의 CSV를 읽어서 화면을 구동 (EV/FINFO/OBJ와 수치 하드코딩 제거)
- 시뮬레이터, 제약 검사, LLM 에이전트 호출부를 서로 다른 모듈로 분리. 에이전트는 일단 규칙 기반 스텁으로 두고 인터페이스만 정의
- 가상 수치에는 "가상" 배지 유지, CLAUDE.md의 규칙 준수
- 오늘 밤 PoC 마감이라 범위를 줄여서 동작하는 최소 버전부터
```

## 2. 검증 비교 화면
```
docs/SERVICE_SCREEN_SPEC.md 5절을 기준으로 "페르소나 대 실제 약사 비교" 화면을 추가해줘.
- 새 상황 입력 → AI 판단 → 약사 답 수동 입력 → 규칙별 일치/부분/불일치 표시
- 약사 답을 새 근거(claims)로 추가하는 버튼 (시뮬레이션 출력은 근거로 추가 불가, G04)
- 화면에 "인터뷰 1건, 응답자 1인 범위" 문구 표시
- 약사 응답 원본은 .gitignore 되는 폴더에만 저장
수치 일치 기준(n%)은 비워 두고 설정값으로 빼줘.
```

## 3. cases.csv 만들기
```
source/interview_master.xlsx 의 04_사건학습(I01~I19)을 data/1_interview/cases.csv 로 만들어줘.
- build.py 의 기존 규칙(출처 열 3개, 영문 snake_case + *_ko, UTF-8 BOM)을 따르고
- evidence_links 에 case 연결 종류가 필요한지 검토해서 enums/validate.py 까지 같이 고치고
- python scripts/validate.py 가 통과하는지 확인
README 의 "알려진 한계" 도 갱신해줘. 구조에 없던 파일이니, 만들기 전에 열 구성안을 먼저 보여줘.
```

## 4. 나머지 가상 시트 9개 변환
```
source/virtual_dummy.xlsx 의 L46, L51, L53~L59 시트를 data/3_virtual/tables/ 로 변환해줘.
build.py 의 TABLES 방식을 따르고(영문 열 이름, 중복 열 제거, pharmacy_id), field_defs 와 validate.py 8번 검사가 통과해야 해.
```

## 5. fetch.py (공공/민간 데이터 사전 수집)
```
공공/민간 데이터를 API로 받아 fetched/ 에 저장하는 scripts/fetch.py 를 만들어줘.
- data/2_world/data_sources.csv 에서 API 방식인 실데이터/참고 데이터만 대상으로
- 작은 건 CSV, 큰 건 DB/제외(.gitignore), 화면은 저장된 값만 읽음
- API 키는 환경변수로만 받고 코드·저장소에 넣지 말 것. 먼저 호출 계획(어떤 데이터, 어떤 키가 필요한지)을 표로 보여줘.
```

## 6. 깃 올리기 전 점검
```
GitHub에 올리기 전에 점검해줘.
- .gitignore 확인 (fetched/, node_modules/, 약사 응답 원본)
- source/ 에 실제 인터뷰 내용이 있으니 저장소를 Private 으로 하라는 안내를 README 에 추가
- 팀원 실명이 산출물에 없는지 검색
- python scripts/validate.py 통과 확인
git init 과 첫 커밋까지만 하고, push 는 내가 확인한 뒤에 할게.
```
