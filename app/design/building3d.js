// 약국 건물 3D 디자인 (Three.js r128 전역 THREE).
// 팀원 목업(floor12 브랜치 prototype/building_mock.html)의 건물(1~2층), 인물, 손님 흐름을 옮겨 왔다.
// 시뮬레이터(app/js/app.js)는 createScene() 이 돌려주는 인터페이스로만 이 파일을 쓴다. 디자인을 고칠 때 시뮬레이션 코드를 건드릴 필요가 없다.
//
// 지킬 것
// - 장면은 값을 계산하지 않는다. 재고·입고·수요 결과는 앱이 setState 로 넘긴다.
// - 손님 흐름은 "재생 중"에만 움직인다 (setFlow({ running: true })).
// - 손님 수는 data/3_virtual/tables 의 가상 데이터(처방 건수, 시간대별 워크인)에서 온다. 시간대 분포·인내 시간·마스크 비율은 가정이다.
// - 위치·배치는 인터뷰에 없는 임의 배치다. 약국 내부 배치는 PHARMACY 설정과 buildPharmacy() 만 고치면 된다.

import { parseCSV } from '../js/data.js';

const T = window.THREE;
const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------------- 치수와 설정 (디자인 담당이 고치는 곳) ---------------- */
export const DIM = { W: 14, D: 8, FH: 3.1 };
const { W, D, FH } = DIM;
const FLOORS = [
  { id: '1F', slab: 0xcfc8b8, wall: 0xe9e3d4 },
  { id: '2F', slab: 0xcfc8b8, wall: 0xf0ebdd },
];
// 약국 내부 배치 (2층 왼쪽, x -7 ~ -0.5). 진열 구역은 L56(가상)의 구역 이름과 맞춘다.
export const PHARMACY = {
  rack: { x: -1.95, z: -3.45 }, // 시뮬레이션 품목 재고 선반 (전산 기록·실물 상자)
  counter: { x: -2.2, z: -0.7 },
  monitor: { x: -2.65, z: -0.88 }, // 카운터 위 전산 모니터
  phA: { x: -5.0, z: -2.2 }, // 응답자 약사
  phB: { x: -0.95, z: -1.85 }, // 다른 약사 (G07: 판단을 만들지 않음). 재고 선반을 가리지 않게 칸막이 쪽에 둔다
  demandRow: { x: -4.8, z: 0.05, step: 0.5 }, // 이 품목을 찾은 손님 (수요)
  zones: {
    '카운터 뒤 일반약장': { x: -6.7, z: 3.3, ax: 'x', len: 3.2, n: [0, 1], H: 2 },
    '카운터 앞 진열대': { x: -2.3, z: 0.6, ax: 'z', len: 1.3, n: [-1, 0], H: 1.6 },
    '계산대 옆': { x: -1.3, z: -0.2, ax: 'x', len: 0.7, n: [0, 1], H: 1.6 },
    '계산대 옆 냉장 쇼케이스': { x: -1.3, z: 0.3, ax: 'z', len: 1, n: [1, 0], H: 1.8 },
    '벽면 진열대 A': { x: -6.7, z: -0.6, ax: 'x', len: 1.4, n: [0, 1], H: 2 },
    '벽면 진열대 B': { x: -6.7, z: 0.4, ax: 'x', len: 1.3, n: [0, 1], H: 2 },
    '벽면 진열대 C': { x: -6.7, z: 1.4, ax: 'x', len: 1.2, n: [0, 1], H: 2 },
    '벽면 진열대 D': { x: -6.7, z: 2.4, ax: 'x', len: 1, n: [0, 1], H: 2 },
    '입구 쪽 진열대': { x: -2.0, z: 2.6, ax: 'z', len: 1.1, n: [-1, 0], H: 1.6 },
    '어린이 코너(입구 쪽 하단)': { x: -1.2, z: 2.0, ax: 'z', len: 0.9, n: [-1, 0], H: 0.75 },
    '대기 소파 옆': { x: -2.5, z: 3.1, ax: 'x', len: 0.5, n: [0, 1], H: 1.1 },
  },
  shelfY: { '하단': 0.35, '하단(아이 눈높이)': 0.35, '중단': 0.8, '손 닿는 높이': 0.75, '눈높이': 1.25, '상단': 1.7 },
  deptColor: { '일반의약품': 0x0f9b8c, '건강기능식품': 0x8b5cf6, '의약외품': 0xd4881f, '기타 잡화': 0x9aa3a8 },
};
// 손님 유입 경로별 옷 색 (팀원 목업과 같음)
export const ROUTE_COLOR = { ent: 0x0f9b8c, ex: 0xe0569b, oth: 0xd4881f, walk: 0x8b5cf6, inq: 0x3b82f6 };
export const ROUTE_LABEL = { ent: '같은 층 이비인후과 처방', ex: '건너편 휴진으로 넘어온 환자', oth: '1층 의원 처방', walk: '일반약 방문(워크인)', inq: '문의만 하고 감' };
// 약국을 나가는 손님 발 아래 원: 만족 이용 / 지연 이용 / 지연 이탈 (기준은 가정)
export const OUTCOME_COLOR = [0x2f8f4e, 0xe0a100, 0xd23b2a];
export const OUTCOME_LABEL = ['만족 이용', '지연 이용', '지연 이탈'];
// 가정값 (데이터 없음). 출처: 팀원 목업의 상수
const ASSUME = {
  rxHourWeight: [8, 14, 14, 12, 5, 9, 10, 10, 11, 7], // 09~18시 처방 환자 도착 비중
  inquiryPerWalk: 0.25, // 문의 방문 = 워크인의 25%
  addonRate: 0.18, // 처방 환자 중 진열대에 들르는 비율
  ageMix: { ent: [0.3, 0.55, 0.15], oth: [0.05, 0.5, 0.45], walk: [0.1, 0.7, 0.2], inq: [0.05, 0.65, 0.3], ex: [0.3, 0.55, 0.15] },
  patienceMin: { rx: 25, other: 12 }, // 이 시간 넘게 기다리면 이탈
  serviceMin: { rx: 3, walk: 1.5, inq: 1 },
  personsPerFigure: 2, // 인물 1명 = 손님 약 2명
};
const AGE = {
  child: { scale: 0.72, hair: 0x6b4a2b, sp: 1 },
  adult: { scale: 1, hair: 0x2a2320, sp: 1 },
  senior: { scale: 0.95, hair: 0xc9c9c9, sp: 0.7 },
};
const UMB = [0xd23b2a, 0x2f6fb5, 0xe0a100, 0x3a3f47, 0x2f8f4e];
const SKIN = 0xe8c9a0;
const DAY_MS = 90000; // 재생할 때 하루(09~19시)를 보여 주는 시간. 손님이 띄엄띄엄 오도록 길게 둔다 (setSpeed 로 바꾼다)
const OPEN_MIN = 540, CLOSE_MIN = 1140;

export const VIEWS = {
  overview: { t: [0, 3.2, 1.5], r: 27, th: 0.58, ph: 1.12 },
  pharmacy: { t: [-3.6, FH + 1.1, 0.4], r: 13, th: 0.32, ph: 1.1 },
  stock: { t: [-1.95, FH + 1.1, -3.2], r: 7, th: 0.18, ph: 0.98 },
  pharmacist: { t: [-4.9, FH + 1.5, -1.9], r: 9.5, th: 0.32, ph: 1.24 },
  street: { t: [-2, 1.6, 8.5], r: 23, th: -0.5, ph: 1.22 },
  // 오른쪽 창이 넓을 때: 건물이 화면 왼쪽에 오도록 시선을 오른쪽으로 민다
  overviewSide: { t: [3.6, 3.2, 1.5], r: 28, th: 0.58, ph: 1.12 },
};
// 1인칭(약사 시점) 프리셋: 카운터 뒤에 선 눈높이. yaw 0 = 입구(+z) 쪽, pitch 음수 = 아래
export const FPV = {
  front: { eye: [-3.1, FH + 1.78, -2.95], yaw: 0.1, pitch: -0.16, label: '카운터 전산' },
  shelf: { eye: [-2.15, FH + 1.7, -1.15], yaw: 2.98, pitch: -0.34, label: '재고 선반' },
};
// 라벨 위치 (app 의 SCENE_LABELS 키와 맞춘다)
const ANCHORS = {
  pharmacy: [-3.6, FH + 2.95, D / 2 + 0.2],
  ent: [3.5, FH + 2.95, D / 2 + 0.2],
  ortho: [3.6, 2.85, D / 2 + 0.2],
  persona: [PHARMACY.phA.x, FH + 2.75, PHARMACY.phA.z],
  stock: [PHARMACY.rack.x, FH + 2.35, PHARMACY.rack.z],
  across: [-15.5, 6.2, 2.9],
  goods: [-6.2, FH + 2.5, 1.2],
};

/* ---------------- 데이터 (가상) ---------------- */
let FLOW_DATA = null;
/** calendar.csv, rx_daily.csv, otc_hourly.csv 를 읽어 날짜별 손님 수를 만든다. 모두 가상 데이터다. */
export async function loadFlowData(base = '../data/3_virtual/tables/') {
  if (FLOW_DATA) return FLOW_DATA;
  const get = async (f) => { const r = await fetch(base + f); if (!r.ok) throw new Error(`${f} ${r.status}`); return parseCSV(await r.text()); };
  const [cal, rx, oh] = await Promise.all([get('calendar.csv'), get('rx_daily.csv'), get('otc_hourly.csv')]);
  const days = new Map();
  cal.forEach((r) => days.set(r.date, {
    date: r.date, open: r.is_open === 'Y', openHours: Number(r.open_hours) || 0, openType: r.open_type,
    ili: Number(r.influenza_ili_per_1000) || 0, entClosed: r.ent_closed === 'Y', month: Number(r.date.slice(5, 7)), im: 0, ent: 0, walk: new Array(10).fill(0),
  }));
  rx.forEach((r) => { const d = days.get(r.date); if (d) { d.im = Number(r.rx_count_internal) || 0; d.ent = Number(r.rx_count_ent) || 0; } });
  oh.forEach((r) => { const d = days.get(r.date); const h = Number(r.hour_band.slice(0, 2)) - 9; if (d && h >= 0 && h < 10) d.walk[h] = Number(r.walkin_buyers) || 0; });
  FLOW_DATA = days;
  return days;
}
let ITEMS = null;
export async function loadItems(url = './design/items.json') {
  if (ITEMS) return ITEMS;
  try { const r = await fetch(url); ITEMS = r.ok ? (await r.json()).items : []; } catch (e) { ITEMS = []; }
  return ITEMS;
}

/* ---------------- 장면 ---------------- */
export function createScene(container, opts = {}) {
  if (!T) return null;
  const hero = !!opts.hero;
  let renderer;
  try { renderer = new T.WebGLRenderer({ antialias: true, alpha: true }); } catch (e) { return null; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFSoftShadowMap;
  const canvas = renderer.domElement;
  canvas.setAttribute('aria-hidden', 'true');
  Object.assign(canvas.style, { display: 'block', width: '100%', height: '100%' });
  container.prepend(canvas);

  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(38, 1, 0.1, 300);
  scene.add(new T.HemisphereLight(0xffffff, 0x8a8f98, 0.85));
  const sun = new T.DirectionalLight(0xffffff, 0.8);
  sun.position.set(14, 30, 22); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 90 });
  sun.shadow.bias = -0.0006;
  scene.add(sun);

  const mats = {};
  const mat = (c, o) => { const k = c + JSON.stringify(o || {}); if (!mats[k]) mats[k] = new T.MeshStandardMaterial({ color: c, roughness: 0.85, metalness: 0, ...(o || {}) }); return mats[k]; };
  // box: 바닥(y)을 기준으로 놓는다 (팀원 목업과 같은 규칙)
  const box = (p, w, h, d, c, x, y, z, o = {}) => {
    const m = new T.Mesh(new T.BoxGeometry(w, h, d), o.m || mat(c, o.mo));
    m.position.set(x, y + h / 2, z); m.castShadow = !o.noShadow; m.receiveShadow = true; p.add(m); return m;
  };
  const picks = [];
  const reg = (mesh, key) => { mesh.userData.key = key; picks.push(mesh); return mesh; };
  const unreg = (mesh) => { const i = picks.indexOf(mesh); if (i >= 0) picks.splice(i, 1); };

  /* ---- 땅과 거리 */
  const ground = new T.Mesh(new T.PlaneGeometry(160, 160), new T.MeshStandardMaterial({ color: 0xbfc7b4, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.06; ground.receiveShadow = true; scene.add(ground);
  const sidewalk = box(scene, 60, 0.12, 2.4, 0xd8d4c8, 0, -0.06, D / 2 + 1.9, { noShadow: true });
  const road = box(scene, 80, 0.06, 6.4, 0x4a4e55, 0, -0.06, D / 2 + 6.2, { noShadow: true });
  for (let k = -8; k <= 8; k++) box(scene, 1.4, 0.02, 0.12, 0xe8e4d0, k * 3.8, 0, D / 2 + 6.2, { noShadow: true });
  for (const x of [-24, -9.5, 15, 22]) {
    const t = new T.Group(); t.position.set(x, 0, D / 2 + 3); scene.add(t);
    box(t, 0.18, 1, 0.18, 0x6b4a2a, 0, 0, 0);
    const c = new T.Mesh(new T.ConeGeometry(0.9, 2.1, 7), mat(0x4f8a52)); c.position.y = 2; c.castShadow = true; t.add(c);
  }

  /* ---- 건물 골격 (1~2층) */
  const bldg = new T.Group(); scene.add(bldg);
  const FG = [];
  const conceptMats = new Set(); // 개념 층 재질 (지금은 없음)
  const glassMat = new T.MeshStandardMaterial({ color: 0x9ec5d8, transparent: true, opacity: 0.1, roughness: 0.1, side: T.DoubleSide, depthWrite: false });
  FLOORS.forEach((f, i) => {
    const g = new T.Group(); g.position.y = i * FH; bldg.add(g); FG.push(g);
    // 개념 층(3층)은 반투명: 실제로 없는 층이고, 위에서 2층 약국 안을 가리지 않게 한다
    const ghost = f.concept ? { mo: { transparent: true, opacity: 0.16, depthWrite: false }, noShadow: true } : {};
    const slab = box(g, W + 0.8, 0.25, D + 0.8, f.slab, 0, 0, 0, f.concept ? { mo: { transparent: true, opacity: 0.22, depthWrite: false }, noShadow: true } : {});
    if (f.concept) { reg(slab, 'judge'); conceptMats.add(slab.material); }
    const wall = (w, h, d, x, z) => { const m = box(g, w, h, d, f.wall, x, 0.25, z, ghost); if (f.concept) { reg(m, 'judge'); conceptMats.add(m.material); } return m; };
    wall(W, FH - 0.25, 0.25, 0, -D / 2 + 0.125);
    wall(0.25, FH - 0.25, D, -W / 2 + 0.125, 0);
    wall(0.25, FH - 0.25, D, W / 2 - 0.125, 0);
    const gl = new T.Mesh(new T.PlaneGeometry(W, FH - 0.25), glassMat); gl.position.set(0, 0.25 + (FH - 0.25) / 2, D / 2); gl.raycast = () => {}; g.add(gl);
  });
  // 지붕: 반투명이라 위에서 내려다볼 때 안이 보인다
  box(bldg, W + 0.8, 0.18, D + 0.8, 0xb9bec6, 0, FLOORS.length * FH, 0, { mo: { transparent: true, opacity: 0.22, depthWrite: false }, noShadow: true });

  /* ---- 1층: 로비 + 정형외과 */
  {
    const g = FG[0];
    box(g, 2.2, 2.5, 1.6, 0x9aa4b0, -0.6, 0.25, -3.1); // 엘리베이터
    box(g, 2.6, 0.9, 0.8, 0xb98f5f, -4.6, 0.25, -2.2); // 안내 데스크
    box(g, 0.12, FH - 0.25, 5, 0xd8d0c0, 1.3, 0.25, -1.5);
    reg(box(g, 2.6, 0.9, 0.8, 0x7c8a9a, 4.4, 0.25, 1.4), 'ortho');
    reg(box(g, 2, 0.5, 0.9, 0xcfd6df, 5.2, 0.25, -2.4), 'ortho'); reg(box(g, 2, 0.5, 0.9, 0xcfd6df, 2.8, 0.25, -2.4), 'ortho');
    reg(box(g, 2.4, 0.5, 0.1, 0x7c8a9a, 4.4, 1.9, -3.82), 'ortho');
    for (let k = 0; k < 8; k++) reg(box(g, 0.5, 0.4, 0.5, 0x667788, 2.2 + (k % 4) * 0.7, 0.25, 2.6 + Math.floor(k / 4) * 0.9), 'ortho');
    box(g, 1.6, 2.3, 0.08, 0x6aa5c0, -1.2, 0.25, D / 2 - 0.04, { mo: { transparent: true, opacity: 0.5 } }); // 정문
  }

  /* ---- 인물 (팀원 목업의 makeChar: 가운·표정·마스크·우산·결과 원) */
  const faceTex = (kind) => {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    let x = null; try { x = c.getContext('2d'); } catch (e) { /* 캔버스 없음 */ }
    if (!x) return null;
    x.lineWidth = 5; x.lineCap = 'round'; x.strokeStyle = '#2a2320'; x.fillStyle = '#2a2320';
    const dot = (cx, cy) => { x.beginPath(); x.arc(cx, cy, 4.5, 0, 7); x.fill(); };
    const ln = (x1, y1, x2, y2) => { x.beginPath(); x.moveTo(x1, y1); x.lineTo(x2, y2); x.stroke(); };
    const arc = (cx, cy, r, a, b) => { x.beginPath(); x.arc(cx, cy, r, a * Math.PI, b * Math.PI); x.stroke(); };
    if (kind === 0) { arc(20, 28, 6, 1, 2); arc(44, 28, 6, 1, 2); arc(32, 38, 11, 0.15, 0.85); }
    else if (kind === 1) { dot(20, 26); dot(44, 26); arc(32, 36, 10, 0.2, 0.8); }
    else if (kind === 2) { dot(20, 26); dot(44, 26); ln(24, 46, 40, 46); }
    else if (kind === 3) { ln(14, 27, 26, 27); ln(38, 27, 50, 27); arc(32, 54, 10, 1.2, 1.8); }
    else { ln(12, 15, 27, 22); ln(52, 15, 37, 22); dot(20, 30); dot(44, 30); arc(32, 57, 11, 1.2, 1.8); }
    return new T.CanvasTexture(c);
  };
  const FACES = [0, 1, 2, 3, 4].map(faceTex);
  const setFace = (g, k) => { const f = g.userData.face; if (f && FACES[k] && f.material.map !== FACES[k]) { f.material.map = FACES[k]; f.material.needsUpdate = true; } };
  function makeChar(o) {
    const g = new T.Group(), parts = [];
    const add = (w, h, d, c, x, y, z, mo) => { const m = box(g, w, h, d, c, x, y, z, mo ? { mo } : {}); parts.push(m); return m; };
    const fade = o.opacity != null ? { transparent: true, opacity: o.opacity, depthWrite: false } : null;
    if (o.coat) { add(0.3, 0.16, 0.22, 0x39424a, 0, 0, 0); add(0.42, 0.66, 0.3, 0xffffff, 0, 0.14, 0); add(0.14, 0.22, 0.02, o.top, 0, 0.56, 0.151); }
    else { add(0.3, 0.36, 0.22, o.bottom, 0, 0, 0, fade); add(0.38, 0.42, 0.26, o.top, 0, 0.36, 0, fade); }
    add(0.28, 0.28, 0.28, SKIN, 0, 0.8, 0, fade);
    add(0.3, 0.09, 0.3, o.hair, 0, 1.05, 0, fade); add(0.3, 0.2, 0.06, o.hair, 0, 0.88, -0.15, fade);
    const f = new T.Mesh(new T.PlaneGeometry(0.26, 0.26), new T.MeshBasicMaterial({ map: FACES[2], transparent: true }));
    f.position.set(0, 0.94, 0.143); f.visible = !!FACES[2] && !fade; g.add(f);
    if (o.mask) add(0.24, 0.12, 0.02, 0xf4f7f8, 0, 0.82, 0.148);
    if (o.carry) add(0.22, 0.16, 0.16, 0xc99a4b, 0.25, 0.32, 0.12); // 약 상자를 든 손님
    if (o.umb) {
      const u = new T.Group(); box(u, 0.03, 0.75, 0.03, 0x444444, 0.22, 0.7, 0);
      const cn = new T.Mesh(new T.ConeGeometry(0.6, 0.24, 10), mat(o.umb)); cn.position.set(0.22, 1.55, 0); u.add(cn);
      u.visible = false; g.add(u); g.userData.umb = u;
    }
    if (o.status) { // 발 아래 결과 원만 쓴다 (머리 위 표시는 쓰지 않는다)
      const ring = new T.Mesh(new T.CircleGeometry(0.42, 20), new T.MeshBasicMaterial({ color: 0xffffff }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03; ring.visible = false; g.add(ring); g.userData.ring = ring;
    }
    g.scale.setScalar(o.scale || 1);
    g.userData.parts = parts; g.userData.face = f;
    return g;
  }

  /* ---- 2층: 약국 + 이비인후과 */
  const PH = PHARMACY;
  const ghosts = [], solids = [];
  let phA, phB, screenCv = null, screenTx = null;
  function drawScreen(sc) {
    if (!screenCv) return;
    const x = screenCv.getContext('2d'); if (!x) return;
    x.fillStyle = '#0f1a20'; x.fillRect(0, 0, 512, 320);
    x.fillStyle = '#7fd1c4'; x.font = '600 26px system-ui, sans-serif'; x.fillText(sc.title || '약국 전산 · 재고 조회', 28, 48);
    x.fillStyle = '#ffffff'; x.font = '800 92px system-ui, sans-serif'; x.fillText(sc.big || '-', 28, 160);
    x.fillStyle = '#c9d6dc'; x.font = '500 24px system-ui, sans-serif';
    (sc.lines || []).slice(0, 4).forEach((t, i) => x.fillText(t, 28, 208 + i * 30));
    screenTx.needsUpdate = true;
  }
  const demandFigs = [];
  function buildPharmacy(g) {
    box(g, 0.14, FH - 0.25, D, 0xd4cdbd, -0.5, 0.25, 0); // 약국 | 이비인후과 칸막이
    // 조제실 (유리벽 2장 + 조제대)
    reg(box(g, 3.8, 1.75, 0.12, 0xbfd3d6, -5.1, 0.25, -0.95, { mo: { transparent: true, opacity: 0.55 } }), 'pharmacy');
    reg(box(g, 0.12, 1.75, 2.9, 0xbfd3d6, -3.35, 0.25, -2.45, { mo: { transparent: true, opacity: 0.55 } }), 'pharmacy');
    reg(box(g, 3.5, 0.9, 0.6, 0xcdd6d8, -5.2, 0.25, -1.5), 'pharmacy');
    reg(box(g, 3.4, 1, 0.6, 0xb98d5a, PH.counter.x, 0.25, PH.counter.z), 'counter');
    // 약국 전산 모니터: 약사 쪽(-z)을 향한다. 관측값(전산 기록)만 띄운다 — setScreen()
    const M = PH.monitor;
    box(g, 0.08, 0.16, 0.08, 0x2c3338, M.x, 1.25, M.z);
    reg(box(g, 0.78, 0.5, 0.05, 0x1b2228, M.x, 1.41, M.z), 'counter');
    screenCv = document.createElement('canvas'); screenCv.width = 512; screenCv.height = 320;
    screenTx = new T.CanvasTexture(screenCv);
    const pl = new T.Mesh(new T.PlaneGeometry(0.72, 0.45), new T.MeshBasicMaterial({ map: screenTx }));
    pl.position.set(M.x, 1.66, M.z - 0.03); pl.rotation.y = Math.PI; g.add(pl); reg(pl, 'counter');
    reg(box(g, 1.2, 0.45, 0.6, 0x7fb5ae, -1.3, 0.25, 3.3), 'sofa');
    box(g, 1.5, 2.3, 0.08, 0x6aa5c0, -1.4, 0.25, D / 2 - 0.04, { mo: { transparent: true, opacity: 0.35 } }); // 약국 문
    // 약사 2명: A 는 응답자, B 는 다른 약사 (G07)
    phA = makeChar({ coat: true, top: 0x0f7f73, hair: 0x2a2320, scale: 1.6 });
    phA.position.set(PH.phA.x, 0.25, PH.phA.z); g.add(phA); phA.userData.parts.forEach((m) => reg(m, 'persona'));
    phB = makeChar({ coat: true, top: 0x6b8fb5, hair: 0x5a4632, scale: 1.6 });
    phB.position.set(PH.phB.x, 0.25, PH.phB.z); g.add(phB); phB.userData.parts.forEach((m) => reg(m, 'counter'));
    // 시뮬레이션 품목 재고 선반: 반투명 보라 = 전산 기록, 불투명 갈색 = 실물
    const R = PH.rack;
    reg(box(g, 2.5, 0.08, 0.7, 0x8b95a0, R.x, 0.62, R.z), 'stock');
    reg(box(g, 2.5, 0.08, 0.7, 0x8b95a0, R.x, 1.42, R.z), 'stock');
    [-1.25, 1.25].forEach((dx) => reg(box(g, 0.08, 1.7, 0.7, 0x8b95a0, R.x + dx, 0.25, R.z), 'stock'));
    const geo = new T.BoxGeometry(0.4, 0.34, 0.45);
    for (let i = 0; i < 10; i++) {
      const x = R.x + ((i % 5) - 2) * 0.46, y = (i < 5 ? 0.7 : 1.5) + 0.17;
      const gm = new T.Mesh(geo, new T.MeshBasicMaterial({ color: 0x7a55d6, transparent: true, opacity: 0.28, depthWrite: false }));
      gm.position.set(x, y, R.z); gm.add(new T.LineSegments(new T.EdgesGeometry(geo), new T.LineBasicMaterial({ color: 0x7a55d6 })));
      gm.visible = false; reg(gm, 'stock'); g.add(gm); ghosts.push(gm);
      const sm = new T.Mesh(geo, mat(0xc99a4b)); sm.castShadow = true;
      sm.position.set(x, y, R.z); sm.add(new T.LineSegments(new T.EdgesGeometry(geo), new T.LineBasicMaterial({ color: 0x6b4b17 })));
      sm.visible = false; reg(sm, 'stock'); g.add(sm); solids.push(sm);
    }
    // 이 품목을 찾은 손님 (하루 수요). 사 간 손님은 약 상자를 들고, 못 사고 간 손님은 흐리게
    for (let i = 0; i < 5; i++) {
      const pair = [makeChar({ top: 0x5b8def, bottom: 0x3a3f47, hair: 0x2a2320, carry: true }), makeChar({ top: 0x9aa0a8, bottom: 0x9aa0a8, hair: 0x9aa0a8, opacity: 0.35 })];
      pair.forEach((p) => { p.position.set(PH.demandRow.x + i * PH.demandRow.step, 0.25, PH.demandRow.z); p.rotation.y = Math.PI; p.visible = false; g.add(p); p.userData.parts.forEach((m) => reg(m, 'demand')); });
      demandFigs.push(pair);
    }
  }
  const entSeats = [], orthoSeats = [];
  {
    const g = FG[1];
    buildPharmacy(g);
    // 이비인후과
    reg(box(g, 2.4, 1, 0.7, 0x7fb5ae, 3.2, 0.25, 1.8), 'ent');
    reg(box(g, 2.6, 0.5, 0.9, 0xcfd6df, 5.2, 0.25, -2.6), 'ent');
    reg(box(g, 2.4, 0.55, 0.1, 0x4d7f99, 3.4, 1.9, -3.82), 'ent');
    const dr = makeChar({ coat: true, top: 0x4d7f99, hair: 0x2a2320 }); dr.position.set(5.2, 0.75, -2.6); g.add(dr); dr.userData.parts.forEach((m) => reg(m, 'ent'));
    for (let k = 0; k < 8; k++) reg(box(g, 0.6, 0.4, 0.5, 0x7a8a98, 1.2 + (k % 4) * 0.8, 0.25, -0.2 + Math.floor(k / 4) * 0.8), 'ent');
    box(g, 1.4, 2.3, 0.08, 0x6aa5c0, 5, 0.25, D / 2 - 0.04, { mo: { transparent: true, opacity: 0.35 } });
  }
  /* ---- 진열 상품 (가상 데이터 L56·L57, 위치 임의) */
  loadItems(opts.itemsUrl).then((items) => {
    const g = FG[1];
    Object.entries(PH.zones).forEach(([name, Z]) => {
      const isX = Z.ax === 'x';
      // 진열대 뒷판은 반투명으로: 상품과 약국 안이 가리지 않게 한다
      reg(box(g, isX ? Z.len : 0.1, Z.H, isX ? 0.1 : Z.len, 0xc9bda2, isX ? Z.x + Z.len / 2 : Z.x, 0.2, isX ? Z.z : Z.z + Z.len / 2, { mo: { transparent: true, opacity: 0.32, depthWrite: false }, noShadow: true }), 'goods');
      const cur = {};
      items.filter((it) => it.zone_ko === name).forEach((it) => {
        const w = it.faces * 0.2, c = cur[it.shelf_height_ko] || 0; cur[it.shelf_height_ko] = c + w + 0.04;
        const a = (isX ? Z.x : Z.z) + 0.05 + c + w / 2;
        const y = 0.2 + (PH.shelfY[it.shelf_height_ko] || 1) - 0.17;
        reg(box(g, isX ? w : 0.26, 0.34, isX ? 0.26 : w, PH.deptColor[it.department_ko] || 0x9aa3a8, isX ? a : Z.x + Z.n[0] * 0.2, y, isX ? Z.z + Z.n[1] * 0.2 : a), 'goods');
      });
    });
  });

  /* ---- 주변 건물·트럭·날씨 */
  const exg = new T.Group(); exg.position.set(-15.5, 0, -0.5); scene.add(exg);
  reg(box(exg, 6, 5.4, 6.4, 0xd7cfbf, 0, 0, 0), 'across');
  reg(box(exg, 4, 0.6, 0.12, 0x2d7f9a, 0, 3.9, 3.25), 'across');
  reg(box(exg, 4.4, 2.1, 0.1, 0x8ab6c9, 0, 1.2, 3.22, { mo: { transparent: true, opacity: 0.6 } }), 'across');
  const shutter = box(exg, 4.4, 2.2, 0.14, 0x707780, 0, 2.3, 3.28); shutter.visible = false;
  const nb = new T.Group(); nb.position.set(15.5, 0, -0.5); scene.add(nb);
  reg(box(nb, 6, 7.5, 6.4, 0xcfc6b2, 0, 0, 0), 'nbph'); reg(box(nb, 4, 0.5, 0.12, 0x8a8f98, 0, 2.6, 3.25), 'nbph');
  const truck = new T.Group(); scene.add(truck);
  reg(box(truck, 1.5, 1.7, 1.8, 0xd4881f, 2.2, 0.35, 0), 'truck');
  reg(box(truck, 4, 2.2, 1.9, 0xe9e6df, -0.2, 0.35, 0), 'truck');
  for (const x of [-1.6, -0.2, 1.9]) for (const z of [-0.95, 0.95]) { const w = new T.Mesh(new T.CylinderGeometry(0.38, 0.38, 0.3, 12), mat(0x1b1c1f)); w.rotation.x = Math.PI / 2; w.position.set(x, 0.38, z); truck.add(w); }
  const TRUCK_AWAY = -40, TRUCK_HERE = -3.6;
  truck.position.set(TRUCK_AWAY, 0, D / 2 + 5.2);
  let truckTarget = TRUCK_AWAY;
  const dropBoxes = [];
  for (let i = 0; i < 10; i++) {
    const b = box(scene, 0.4, 0.34, 0.45, 0xc99a4b, -5.2 + (i % 5) * 0.5, Math.floor(i / 5) * 0.36, D / 2 + 1.4);
    b.visible = false; reg(b, 'truck'); dropBoxes.push(b);
  }
  const clouds = new T.Group(); scene.add(clouds);
  const cmat = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 1, transparent: true, opacity: 0.85 });
  for (let k = 0; k < 7; k++) { const c = new T.Mesh(new T.SphereGeometry(2.6 + Math.random() * 1.4, 12, 8), cmat); c.scale.y = 0.45; c.position.set(-26 + k * 8 + Math.random() * 3, 22 + Math.random() * 3, -10 + Math.random() * 16); clouds.add(c); }
  const RN = 260, rp = new Float32Array(RN * 6);
  for (let k = 0; k < RN; k++) { const x = -30 + Math.random() * 60, z = -12 + Math.random() * 34, y = Math.random() * 26; rp.set([x, y, z, x, y - 0.9, z], k * 6); }
  const rg = new T.BufferGeometry(); rg.setAttribute('position', new T.BufferAttribute(rp, 3));
  const rain = new T.LineSegments(rg, new T.LineBasicMaterial({ color: 0x7aa6d6, transparent: true, opacity: 0.6 }));
  rain.visible = false; scene.add(rain);
  const haze = new T.Fog(0xd9d2c0, 30, 95);

  /* ---------------- 손님 흐름 ---------------- */
  const V = (x, z, floor) => new T.Vector3(x, floor * FH + 0.25, z);
  const P = {
    outL: V(-8, D / 2 + 2.6, 0), outR: V(8, D / 2 + 2.6, 0), front: V(-1.2, 4.3, 0), e1: V(-0.6, -1.6, 0), e2: V(-0.6, -1.6, 1), lobby: V(-1.2, 1, 0),
    oDoor: V(1.3, 0, 0), oIn: V(3, 2.5, 0), hall: V(-0.6, -0.8, 1), phDoor: V(-1.4, 3.4, 1), phIn: V(-2.2, 1, 1),
    entDoor: V(5, 3.4, 1), entIn: V(4, 1.5, 1),
    shelves: [V(-2.5, 1.2, 1), V(-6.0, -0.2, 1), V(-2.2, 3, 1), V(-5, 2.9, 1)],
  };
  for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) orthoSeats.push(V(2.2 + i * 0.7, 2.6 + j * 0.9 + 0.5, 0));
  for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) entSeats.push(V(1.2 + i * 0.8, -0.2 + j * 0.8 + 0.55, 1));
  const rnd = (a, b) => a + Math.random() * (b - a);
  const jit = (v) => v.clone().add(new T.Vector3(rnd(-0.25, 0.25), 0, rnd(-0.25, 0.25)));
  const st = (p) => ({ p: jit(p) });
  const outside = () => (Math.random() < 0.5 ? P.outL : P.outR);
  const up = (o) => [st(o), st(P.front), st(P.e1), st(P.e2), st(P.hall)];
  const down = (o) => [st(P.hall), st(P.e2), st(P.e1), st(P.front), st(o)];
  const toPh = () => [st(P.phDoor), st(P.phIn)], fromPh = () => [st(P.phIn), st(P.phDoor)];
  const addOn = () => (Math.random() < ASSUME.addonRate ? [{ p: jit(P.shelves[Math.floor(Math.random() * 4)]), stay: rnd(1, 3) }] : []);
  function route(type) {
    const o = outside(), back = outside();
    if (type === 'ent' || type === 'ex') {
      const seat = entSeats[Math.floor(Math.random() * entSeats.length)];
      return up(o).concat([st(P.entDoor), st(P.entIn), { p: jit(seat), stay: rnd(12, 30) }, st(P.entIn), st(P.entDoor)], toPh(), addOn(), [{ queue: true, svc: ASSUME.serviceMin.rx }], fromPh(), down(back));
    }
    if (type === 'oth') {
      const seat = orthoSeats[Math.floor(Math.random() * orthoSeats.length)];
      return [st(o), st(P.front), st(P.lobby), st(P.oDoor), st(P.oIn), { p: jit(seat), stay: rnd(12, 25) }, st(P.oIn), st(P.oDoor), st(P.lobby), st(P.e1), st(P.e2), st(P.hall)]
        .concat(toPh(), addOn(), [{ queue: true, svc: ASSUME.serviceMin.rx }], fromPh(), down(back));
    }
    if (type === 'walk') return up(o).concat(toPh(), [{ p: jit(P.shelves[Math.floor(Math.random() * 4)]), stay: rnd(2, 5) }, { queue: true, svc: ASSUME.serviceMin.walk }], fromPh(), down(back));
    return up(o).concat(toPh(), [{ queue: true, svc: ASSUME.serviceMin.inq }], fromPh(), down(back));
  }
  const qPos = (k) => V(-1.9 + Math.floor(k / 5) * 0.5, (k % 5) * 0.4, 1);

  const F = { date: null, day: null, demand: null, perFigure: ASSUME.personsPerFigure, min: OPEN_MIN, running: false, agents: [], queue: [], out: [0, 0, 0], spawned: 0, env: { rain: false, dust: null } };
  let dayMs = DAY_MS;
  let SIM_MIN_PER_MS = (CLOSE_MIN - OPEN_MIN) / dayMs; // 하루 90초면 재생 1초 = 약 7분
  const WALK_UNITS_PER_S = 5.5; // 시간을 압축한 연출이라 실제 걸음보다 빠르다
  const maskProb = () => {
    const ili = F.demand ? F.demand.ili : F.day ? F.day.ili : 0;
    let p = ili >= 15 ? Math.min(0.8, ili / 60) : 0.05; // 독감 지수 비례 (가정)
    if (dustOn()) p = Math.max(p, 0.6); // 미세먼지 나쁨 (가정)
    return p;
  };
  const dustOn = () => (F.env.dust != null ? F.env.dust : false);
  function rates(h) {
    if (F.demand) { const x = F.demand.hours[h - 9]; return x && x.open ? { oth: x.oth, ent: x.ent, walk: x.walk, inq: x.inq } : {}; }
    const d = F.day; if (!d || !d.open) return {};
    const i = h - 9; if (i < 0 || i >= 10) return {};
    const hoursOpen = Math.max(1, d.openHours || 10);
    const wts = ASSUME.rxHourWeight.slice(0, hoursOpen), sum = wts.reduce((a, b) => a + b, 0);
    const share = i < hoursOpen ? ASSUME.rxHourWeight[i] / sum : 0;
    const walk = d.walk[i] || 0;
    return { oth: d.im * share, ent: d.entClosed ? 0 : d.ent * share, walk, inq: walk * ASSUME.inquiryPerWalk };
  }
  function kill(a) {
    [a.g, a.guard].forEach((g) => { if (!g) return; g.parent && g.parent.remove(g); g.userData.parts.forEach((m) => { unreg(m); m.geometry.dispose(); }); g.userData.face.material.dispose(); });
    const q = F.queue.indexOf(a); if (q >= 0) F.queue.splice(q, 1);
  }
  function clearAgents() { F.agents.forEach(kill); F.agents.length = 0; F.queue.length = 0; F.out = [0, 0, 0]; F.spawned = 0; }
  function spawn(type) {
    if (F.agents.length > 100) return; // 화면 부담 상한. 바쁜 날에도 걸리지 않게 넉넉히 둔다
    const pr = ASSUME.ageMix[type], u = Math.random();
    const age = u < pr[0] ? 'child' : u < pr[0] + pr[1] ? 'adult' : 'senior', A = AGE[age];
    const col = ROUTE_COLOR[type], dark = new T.Color(col).multiplyScalar(0.55).getHex();
    const pm = maskProb(), umbC = UMB[Math.floor(Math.random() * UMB.length)];
    const path = route(type);
    const g = makeChar({ top: col, bottom: dark, hair: A.hair, scale: A.scale, mask: Math.random() < pm, umb: age === 'child' ? 0 : umbC, status: true });
    g.position.copy(path[0].p); scene.add(g);
    const a = { type, age, g, path, i: 1, wait: 0, inQ: false, serve: 0, svc: 0, qwait: 0, mood: type === 'ent' || type === 'oth' ? 2 : 1, sp: A.sp, guard: null, out: -1,
      patience: type === 'ent' || type === 'oth' ? ASSUME.patienceMin.rx : ASSUME.patienceMin.other };
    g.userData.parts.forEach((m) => reg(m, 'customers'));
    if (age === 'child') { // 어린이는 보호자와 함께 움직인다
      const gd = makeChar({ top: col, bottom: dark, hair: 0x2a2320, mask: Math.random() < pm, umb: umbC });
      gd.position.copy(g.position).add(new T.Vector3(0.45, 0, 0)); scene.add(gd);
      gd.userData.parts.forEach((m) => reg(m, 'customers')); a.guard = gd;
    }
    setFace(g, a.mood); F.agents.push(a); F.spawned++;
  }
  const tmpV = new T.Vector3(), side = new T.Vector3();
  function moveTo(a, tp, step) {
    const d = tp.clone().sub(a.g.position), L = d.length();
    if (L <= step) { a.g.position.copy(tp); return true; }
    if (Math.abs(d.x) + Math.abs(d.z) > 1e-4) a.g.rotation.y = Math.atan2(d.x, d.z);
    a.g.position.add(d.multiplyScalar(step / L));
    return false;
  }
  function followGuard(a) {
    if (!a.guard) return;
    side.set(Math.cos(a.g.rotation.y), 0, -Math.sin(a.g.rotation.y)).multiplyScalar(0.45);
    tmpV.copy(a.g.position).add(side);
    a.guard.position.lerp(tmpV, 0.35); a.guard.rotation.y = a.g.rotation.y;
  }
  function outcome(a, k) {
    a.out = k; F.out[k]++;
    const r = a.g.userData.ring; if (r) { r.material.color.set(OUTCOME_COLOR[k]); r.visible = true; }
    setFace(a.g, k === 0 ? 0 : k === 1 ? 2 : 4);
  }
  function setUmbrella(a) {
    const show = F.env.rain && a.g.position.z > D / 2 - 0.1; // 건물 밖에서만 편다
    [a.g, a.guard].forEach((g) => { if (g && g.userData.umb) g.userData.umb.visible = show; });
  }
  function tickFlow(dtMs) {
    if (!F.running || !(F.demand || F.day)) return;
    const dMin = dtMs * SIM_MIN_PER_MS;
    if (F.min < CLOSE_MIN && (F.demand ? F.demand.open : F.day.open)) {
      const h = Math.floor(F.min / 60), r = rates(h);
      for (const k in r) if (Math.random() < (r[k] / 60 / F.perFigure) * dMin) spawn(k);
    }
    F.min = Math.min(CLOSE_MIN + 120, F.min + dMin);
    const step = (dtMs / 1000) * WALK_UNITS_PER_S;
    for (let n = F.agents.length - 1; n >= 0; n--) {
      const a = F.agents[n];
      if (a.inQ) {
        const k = F.queue.indexOf(a), at = moveTo(a, qPos(k), step * a.sp);
        if (at) a.qwait += dMin; // 줄의 자리에 선 뒤부터 센다 (압축된 연출에서 걷는 시간이 대기로 잡히지 않게)
        const mk = a.qwait < 5 ? Math.min(a.mood, 2) : a.qwait < 10 ? 2 : a.qwait < 20 ? 3 : 4;
        if (mk > a.mood) { a.mood = mk; setFace(a.g, mk); }
        if (!(k === 0 && a.serve > 0) && a.qwait >= a.patience) { F.queue.splice(k, 1); a.inQ = false; a.i++; outcome(a, 2); }
        else if (k === 0 && at) { a.serve += dMin; if (a.serve >= a.svc) { F.queue.shift(); a.inQ = false; a.i++; outcome(a, a.qwait < 10 ? 0 : 1); } }
        followGuard(a); setUmbrella(a);
        continue;
      }
      if (a.wait > 0) { a.wait -= dMin; continue; }
      const s = a.path[a.i];
      if (!s) { kill(a); F.agents.splice(n, 1); continue; }
      if (s.queue) { a.inQ = true; a.serve = 0; a.svc = s.svc; F.queue.push(a); continue; }
      if (moveTo(a, s.p, step * a.sp)) { a.wait = s.stay || 0; a.i++; }
      followGuard(a); setUmbrella(a);
    }
  }

  /* ---- 라벨 (HTML 겹침) */
  const labelLayer = document.createElement('div');
  labelLayer.className = 'scene-labels'; labelLayer.setAttribute('aria-hidden', 'true');
  container.appendChild(labelLayer);
  const labels = (opts.labels || []).filter((l) => ANCHORS[l.key] || l.at).map((l) => {
    const el = document.createElement('span');
    el.className = `scene-label ${l.cls || ''}${l.action ? ' action' : ''}`; el.textContent = l.text; labelLayer.appendChild(el);
    if (l.action) { el.style.pointerEvents = 'auto'; el.style.cursor = 'pointer'; el.addEventListener('click', () => pickHandler && pickHandler(l.key)); }
    const at = ANCHORS[l.key] || l.at;
    return { ...l, el, v: new T.Vector3(...at) };
  });
  const truckLabel = labels.find((l) => l.key === 'truck');
  let labelsOn = !hero;
  labelLayer.style.display = labelsOn ? '' : 'none';

  /* ---- 카메라 */
  const cur = { t: new T.Vector3(), r: 30, th: 0.5, ph: 1.2 }, goal = { t: new T.Vector3(), r: 30, th: 0.5, ph: 1.2 };
  const apply = (o, v) => { o.t.set(...v.t); o.r = v.r; o.th = v.th; o.ph = v.ph; };
  const START = hero ? { t: [0, 4.2, 2], r: 33, th: 0.55, ph: 1.15 } : VIEWS.overview;
  apply(goal, START); apply(cur, START);
  let lastInput = 0;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  // 궤도 시점과 1인칭 시점을 오갈 때는 위치·시선을 부드럽게 섞는다 (blend 가 0 이 되면 바로 따라감)
  const FP = { on: false, eye: new T.Vector3(), yaw: 0, pitch: 0, gy: 0, gp: 0 };
  const camPos = new T.Vector3(), camLook = new T.Vector3(), wantPos = new T.Vector3(), wantLook = new T.Vector3();
  let blend = 0, camReady = false;
  const place = () => {
    if (FP.on) {
      FP.yaw += (FP.gy - FP.yaw) * 0.12; FP.pitch += (FP.gp - FP.pitch) * 0.12;
      wantPos.copy(FP.eye);
      wantLook.set(Math.sin(FP.yaw) * Math.cos(FP.pitch), Math.sin(FP.pitch), Math.cos(FP.yaw) * Math.cos(FP.pitch)).add(FP.eye);
    } else {
      // 세로 기준으로 맞추고, 화면 비율이 1.5보다 좁을 때만 뒤로 물러나 건물 좌우가 잘리지 않게 한다
      const r = cur.r * clamp(1.5 / camera.aspect, 0.95, 2.4);
      const s = Math.sin(cur.ph);
      wantPos.set(cur.t.x + r * s * Math.sin(cur.th), cur.t.y + r * Math.cos(cur.ph), cur.t.z + r * s * Math.cos(cur.th));
      wantLook.copy(cur.t);
    }
    if (!camReady || blend <= 0 || reduceMotion()) { camPos.copy(wantPos); camLook.copy(wantLook); camReady = true; blend = 0; }
    else { camPos.lerp(wantPos, 0.09); camLook.lerp(wantLook, 0.09); blend *= 0.95; if (blend < 0.02 && camPos.distanceTo(wantPos) < 0.05) blend = 0; }
    const fov = FP.on ? 62 : 38;
    if (Math.abs(camera.fov - fov) > 0.05) { camera.fov += (fov - camera.fov) * 0.1; camera.updateProjectionMatrix(); }
    camera.position.copy(camPos); camera.lookAt(camLook);
  };

  let pickHandler = null, visible = true, running = true, dark = false;
  const ctrl = {
    VIEWS,
    get dayMs() { return dayMs; },
    /** 재생 속도: 하루(09~19시)를 몇 ms 로 보여 줄지 */
    setSpeed(ms) { dayMs = Math.max(5000, ms); SIM_MIN_PER_MS = (CLOSE_MIN - OPEN_MIN) / dayMs; },
    /** 앱이 계산한 시간대별 손님 수(손님/시간)로 흐름을 만든다. null 이면 가상 데이터(calendar·rx_daily·otc_hourly)를 쓴다.
        d: { hours: [{oth, ent, walk, inq, open} × 10 (09~18시)], open, ili, perFigure } */
    setDemand(d) { F.demand = d || null; if (d && d.perFigure) F.perFigure = d.perFigure; else if (!d) F.perFigure = ASSUME.personsPerFigure; },
    /** 시계를 09시로 돌리고 손님을 비운다 */
    resetDay() { clearAgents(); F.min = OPEN_MIN; },
    flyTo(name) { const v = VIEWS[name]; if (!v) return; if (FP.on) { FP.on = false; blend = 1; } apply(goal, v); lastInput = performance.now(); if (reduceMotion()) apply(cur, v); },
    /** 약사 시점(1인칭). name: 'front' | 'shelf' */
    firstPerson(name = 'front') {
      const v = FPV[name]; if (!v) return;
      if (!FP.on) { FP.on = true; blend = 1; FP.yaw = v.yaw; FP.pitch = v.pitch; }
      FP.eye.set(...v.eye); FP.gy = v.yaw; FP.gp = v.pitch; lastInput = performance.now();
    },
    get isFirstPerson() { return FP.on; },
    /** 카운터 전산 모니터 내용. 관측값에 있는 값만 넘길 것 (숨은 실물 재고 금지) */
    setScreen(sc = {}) { drawScreen(sc); },
    /** 3층 판단실에 들어왔을 때 3층을 또렷하게 (on) / 다시 흐리게 (off) */
    setConceptFocus(on) { conceptMats.forEach((m) => { if (m.userData.base == null) m.userData.base = m.opacity; m.opacity = on ? Math.min(0.75, m.userData.base * 3.2) : m.userData.base; }); },
    setLabelHidden(key, hidden) { labels.forEach((l) => { if (l.key === key) l.hidden = hidden; }); },
    zoom(f) { if (FP.on) return; goal.r = clamp(goal.r * f, 4, 60); lastInput = performance.now(); },
    rotate(dth, dph) { if (FP.on) { FP.gy -= dth * 2; FP.gp = clamp(FP.gp - dph * 2, -0.9, 0.5); return; } goal.th = clamp(goal.th + dth, -1.6, 1.6); goal.ph = clamp(goal.ph + dph, 0.35, 1.5); lastInput = performance.now(); },
    /** 장면 속 지점의 화면 좌표 (말풍선 위치용). key: ANCHORS 키 또는 'personaHead' */
    anchorScreen(key) {
      const v = new T.Vector3();
      if (key === 'personaHead') { if (!phA) return null; phA.getWorldPosition(v); v.y += 2.05; }
      else if (ANCHORS[key]) v.set(...ANCHORS[key]); else return null;
      v.project(camera);
      const w = container.clientWidth, h = container.clientHeight;
      return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, visible: v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1 };
    },
    setLabels(on) { labelsOn = on; labelLayer.style.display = on ? '' : 'none'; },
    setTheme(d) {
      dark = d;
      ground.material.color.set(d ? 0x2a2d2a : 0xbfc7b4);
      sidewalk.material = mat(d ? 0x3a3a3c : 0xd8d4c8);
      road.material = mat(d ? 0x1f2125 : 0x4a4e55);
    },
    /** v: {ghost, solid, truck:'away'|'arrived', drop, fulfilled, unmet} — 시뮬레이션 품목의 상태 */
    setState(v) {
      ghosts.forEach((g, i) => { g.visible = i < (v.ghost || 0); });
      solids.forEach((s, i) => { s.visible = i < (v.solid || 0); });
      dropBoxes.forEach((b, i) => { b.visible = v.truck === 'arrived' && i < (v.drop || 0); });
      truckTarget = v.truck === 'arrived' ? TRUCK_HERE : TRUCK_AWAY;
      if (truckLabel) truckLabel.el.textContent = v.truck === 'arrived' ? '도매 트럭 · 입고 중 (가상)' : '도매 트럭 · 대기 (가상)';
      if (reduceMotion()) truck.position.x = truckTarget;
      const f = v.fulfilled || 0, u = v.unmet || 0;
      demandFigs.forEach(([got, lost], i) => { got.visible = i < f; lost.visible = i >= f && i < f + u; });
    },
    /** 손님 흐름. date: 'YYYY-MM-DD' 이면 그날 09시부터, null 이면 비운다. running: 재생 중일 때만 true */
    setFlow({ date, running: run } = {}) {
      if (date !== undefined && date !== F.date) {
        // 다른 날로 넘어가면 시계만 09시로 돌리고, 걷던 손님은 마저 나간다. null 이면 모두 비운다.
        if (!date) clearAgents(); else F.out = [0, 0, 0];
        F.date = date; F.min = OPEN_MIN;
        F.day = date && FLOW_DATA ? FLOW_DATA.get(date) || null : null;
      }
      if (run !== undefined) F.running = !!run && !reduceMotion();
    },
    /** 날씨 연출 (가상). 데이터가 없으면 맑음. rain: 우산·비, dust: 마스크 */
    setEnv(env = {}) {
      Object.assign(F.env, env);
      rain.visible = !!F.env.rain;
      scene.fog = dustOn() ? haze : null;
      F.agents.forEach(setUmbrella);
    },
    flowInfo() {
      const c = {}; F.agents.forEach((a) => { c[a.type] = (c[a.type] || 0) + 1; });
      return { date: F.date, clock: F.min, closed: F.min >= CLOSE_MIN, running: F.running, onScreen: F.agents.length, byRoute: c, outcomes: F.out.slice(), spawned: F.spawned, perFigure: F.perFigure, day: F.day, demand: F.demand };
    },
    onPick(fn) { pickHandler = fn; },
    setVisible(v) { visible = v; if (v) resize(); },
    resize() { resize(); },
    dispose() { running = false; clearAgents(); ro.disconnect(); io.disconnect(); renderer.dispose(); canvas.remove(); labelLayer.remove(); },
    get webgl() { return true; },
    get _flow() { return F; }, // 점검용 (preview.html, Playwright)
  };
  loadFlowData(opts.dataBase).catch(() => {}).then(() => { if (F.date && FLOW_DATA) F.day = FLOW_DATA.get(F.date) || null; });

  /* ---- 입력 */
  const ray = new T.Raycaster(), ndc = new T.Vector2();
  const pointers = new Map();
  let down0 = null, pinch = 0;
  canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); down0 = { moved: 0 }; pinch = 0; lastInput = performance.now(); });
  canvas.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) { canvas.style.cursor = pickAt(e) ? 'pointer' : 'grab'; return; }
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y); if (pinch) goal.r = clamp(goal.r * (pinch / d), 4, 60); pinch = d; }
    else if (FP.on) { FP.gy += dx * 0.004; FP.gp = clamp(FP.gp + dy * 0.003, -0.9, 0.5); }
    else { goal.th = clamp(goal.th - dx * 0.006, -1.6, 1.6); goal.ph = clamp(goal.ph - dy * 0.006, 0.35, 1.5); }
    if (down0) down0.moved += Math.abs(dx) + Math.abs(dy);
    p.x = e.clientX; p.y = e.clientY; lastInput = performance.now();
  });
  const upH = (e) => { pointers.delete(e.pointerId); if (down0 && down0.moved < 6 && pointers.size === 0) { const key = pickAt(e); if (key && pickHandler) pickHandler(key); } down0 = null; pinch = 0; };
  canvas.addEventListener('pointerup', upH); canvas.addEventListener('pointercancel', upH);
  if (!hero) canvas.addEventListener('wheel', (e) => { e.preventDefault(); ctrl.zoom(Math.exp(e.deltaY * 0.0012)); }, { passive: false });
  function pickAt(e) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(picks.filter((m) => m.visible && (!m.parent || m.parent.visible)), false)[0];
    return hit ? hit.object.userData.key : null;
  }
  canvas.style.cursor = 'grab';

  /* ---- 크기·가시성·루프 */
  function resize() { const w = container.clientWidth, h = container.clientHeight; if (!w || !h) return; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
  const ro = new ResizeObserver(resize); ro.observe(container);
  const io = new IntersectionObserver((en) => { visible = en[0].isIntersecting; }, { threshold: 0.01 }); io.observe(container);
  const tmp = new T.Vector3();
  let last = performance.now();
  function frame(now) {
    if (!running) return;
    requestAnimationFrame(frame);
    const dtMs = Math.min(50, now - last); last = now;
    if (!visible || document.hidden) return;
    const rm = reduceMotion();
    if (hero && !rm && now - lastInput > 2500) { goal.th = 0.55 + Math.sin(now * 0.00035) * 0.38; goal.ph = 1.16 + Math.sin(now * 0.0002) * 0.04; }
    const k = rm ? 1 : 0.12;
    cur.th += (goal.th - cur.th) * k; cur.ph += (goal.ph - cur.ph) * k; cur.r += (goal.r - cur.r) * k; cur.t.lerp(goal.t, k);
    place();
    if (!rm) {
      truck.position.x += (truckTarget - truck.position.x) * 0.05;
      clouds.children.forEach((c) => { c.position.x += dtMs * 0.00025; if (c.position.x > 34) c.position.x = -34; });
    }
    tickFlow(dtMs);
    if (rain.visible && !rm) { const a = rg.attributes.position; for (let i = 0; i < RN; i++) { let y = a.array[i * 6 + 1] - dtMs * 0.022; if (y < 0) y += 26; a.array[i * 6 + 1] = y; a.array[i * 6 + 4] = y - 0.9; } a.needsUpdate = true; }
    if (labelsOn) {
      const w = container.clientWidth, h = container.clientHeight;
      labels.forEach((l) => {
        if (l === truckLabel) l.v.set(truck.position.x, 3.3, truck.position.z);
        tmp.copy(l.v).project(camera);
        const show = !l.hidden && tmp.z < 1 && Math.abs(tmp.x) < 1.05 && Math.abs(tmp.y) < 1.05;
        l.el.style.display = show ? '' : 'none';
        if (show) l.el.style.transform = `translate(-50%,-50%) translate(${((tmp.x * 0.5 + 0.5) * w).toFixed(1)}px,${((-tmp.y * 0.5 + 0.5) * h).toFixed(1)}px)`;
      });
    }
    renderer.render(scene, camera);
  }
  resize(); place();
  requestAnimationFrame(frame);
  ctrl.setState({ ghost: 0, solid: 0, truck: 'away', fulfilled: 0, unmet: 0 });
  window.addEventListener('resize', resize);
  return ctrl;
}
