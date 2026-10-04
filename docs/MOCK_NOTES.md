# 3D 목업 코드 설명 (`prototype/building_mock.fragment.html`)

단일 파일(HTML + CSS + JS), Three.js r128을 CDN(`cdnjs.cloudflare.com`)에서 로드. 아티팩트 형식이라 `<html>`/`<head>` 없이 `<title>`로 시작한다. 완전한 문서는 `building_mock.html`.

## 구조 (스크립트 위에서 아래로)
1. `EV` — 근거 사전. R02·R03·R04·R05·R06·R08·R15·R17, E002·E003·E013·E014·E017, G02·G04·G07의 **실제 CSV 문구**(요약 포함). 앱화할 때는 CSV에서 읽도록 교체.
2. `FLOORS`, `FINFO`, `OBJ` — 층 6개와 층 설명, 클릭 가능한 물건 설명(연결 데이터는 "제안").
3. `simulate(P)` — 14일 가상 시뮬레이션. 입력 `P = {flu, ent, short, cash}`. 수요 = 14 + 호흡기 지수×0.45 + 휴진일 +9. 재고 시작 60, 매입가 2,800, 판매가 4,300(전부 임의 가상값). 발주량 = 목표 재고일수(현금 제약 2일, 아니면 3.5일) 기준 필요량 ÷ 예상 입고율. 제약: 현금 한도, 반품 회피 상한(내일 수요 4배). 선택지 4개(유지·소량·표준·대량)와 제약 통과 여부 계산. **LLM 호출 없음** — 이 자리에 에이전트를 붙인다.
4. Three.js 장면 — `box()` 헬퍼로 건물·가구를 상자로 구성. 층 그룹 `FG[i]`(각 층 3.1 높이), 2F는 약국(왼쪽)/이비인후과(오른쪽) 칸막이. 클릭 대상은 `pick[]`에 등록하고 `userData.obj`(물건 키)·`userData.fi`(층 번호)를 붙인다.
5. 카메라 — OrbitControls 없이 직접 구현(구면 좌표 `cur`/`goal`, 드래그 회전, 휠·핀치 줌, 우클릭·Shift 이동, 부드러운 보간). `fly(target, r, theta, phi)`로 이동. `selectFloor`, `selectObj`가 줌인 + 패널 갱신.
6. `renderPanel()` — 탭 4개(장면·판단·비교·신뢰). `decideHtml`(결정 카드), `compareHtml`(평시 대 현재), `trustHtml`.
7. `applyDay()` — 날짜 상태를 장면에 반영(진열대 색, 손님 수, 거리 환자, 비, 트럭, 선택지 카드, 스크린 캔버스 텍스처).
8. `loop()` — 애니메이션과 렌더. 라벨은 3D 좌표를 화면에 투영해 HTML로 겹침.
9. `window.__lab` — 디버깅용(카메라, `selectFloor`, `day`).

## 앱화할 때 바꿀 것
- `EV`/`FINFO`/`OBJ` → CSV(`claims`, `rules`, `guardrails`, `evidence_links`)에서 로드. 연결 데이터 문구는 `ui_bindings.csv`로.
- `simulate()` → 시뮬레이터 모듈(코드)과 LLM 에이전트 호출로 분리. 제약 검사는 코드가 수행.
- 수치 → `data/3_virtual/tables/*.csv`. 현재 하드코딩된 값을 쓰지 말 것.
- 비교 탭 → 페르소나 대 약사 비교(`docs/SERVICE_SCREEN_SPEC.md` 5절).

## 알려진 문제와 주의
- 층 벽 위에 유리 면이 겹쳐 바깥에서 볼 때 흐릿하다(의도한 단면 느낌이지만 가독성 개선 여지).
- 모바일에서는 라벨이 기본으로 꺼진다(너비 700 이하).
- 샌드박스에서는 CDN이 막혀 로컬 three로 검증했다. 배포본의 CDN 로드는 직접 확인 필요.
- 한국어 글꼴이 없는 환경에서는 캔버스 텍스트가 깨질 수 있다.
- 테스트: Playwright + `--use-gl=swiftshader`로 스크린샷 확인함. 일시정지·재생 루프는 자동 테스트하지 못했다.
