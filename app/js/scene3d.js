// 약국 건물 3D 장면 (Three.js r128 전역 THREE). 상자·원기둥으로 만든 설명용 구성이며 실제 약국의 모습이 아니다.
// 장면은 값을 계산하지 않는다. 앱이 넘겨 준 상태(setState)를 보여 줄 뿐이다.

const T = window.THREE;
const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export const VIEWS = {
  overview: { t: [-1.5, 4.6, 4], r: 24, th: 0.42, ph: 1.15 },
  pharmacy: { t: [-2.4, 4.4, 0], r: 12.5, th: 0.26, ph: 1.12 },
  stock: { t: [-4.6, 4.5, -3.2], r: 6.4, th: 0.3, ph: 1.14 },
  street: { t: [-1, 1.8, 8], r: 21, th: -0.55, ph: 1.22 },
  judge: { t: [0, 7.6, 2], r: 18, th: 0.45, ph: 1.1 },
  pharmacist: { t: [-3.4, 4.0, 0.1], r: 10.5, th: 0.5, ph: 1.2 },
  roof: { t: [0, 10, 0], r: 16, th: 0.7, ph: 1.0 },
};

export function createScene(container, opts = {}) {
  if (!T) return null;
  const hero = !!opts.hero;
  let renderer;
  try {
    renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
  } catch (e) {
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFSoftShadowMap;
  const canvas = renderer.domElement;
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  container.prepend(canvas);

  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(38, 1, 0.1, 220);
  // 흰 건축 모형처럼: 부드러운 하늘빛 + 그림자를 만드는 해
  scene.add(new T.HemisphereLight(0xffffff, 0xb8b8bd, 0.78));
  const sun = new T.DirectionalLight(0xffffff, 0.62);
  sun.position.set(10, 22, 16);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -26, right: 26, top: 26, bottom: -26, near: 1, far: 70 });
  sun.shadow.bias = -0.0008;
  scene.add(sun);

  const picks = [];
  const reg = (mesh, key) => { mesh.userData.key = key; picks.push(mesh); return mesh; };
  const lam = (color, extra = {}) => new T.MeshLambertMaterial({ color, ...extra });
  const box = (w, h, d, color, x, y, z, parent = scene, extra = {}) => {
    const m = new T.Mesh(new T.BoxGeometry(w, h, d), lam(color, extra));
    m.position.set(x, y, z);
    if (!extra.transparent) { m.castShadow = true; m.receiveShadow = true; }
    parent.add(m);
    return m;
  };
  // 벽·바닥판의 윤곽선. 흰 모형이 흰 배경에 묻히지 않게 한다.
  const EDGE = 0xb5b5bb;
  const outline = (mesh, color = EDGE) => { mesh.add(new T.LineSegments(new T.EdgesGeometry(mesh.geometry), new T.LineBasicMaterial({ color }))); return mesh; };
  const edgesOf = (mesh, color, dashed = false) => {
    const mat = dashed ? new T.LineDashedMaterial({ color, dashSize: 0.35, gapSize: 0.22 }) : new T.LineBasicMaterial({ color });
    const e = new T.LineSegments(new T.EdgesGeometry(mesh.geometry), mat);
    if (dashed) e.computeLineDistances();
    mesh.add(e);
    return e;
  };

  // ---- 땅·길
  const ground = new T.Mesh(new T.PlaneGeometry(120, 90), lam(0xdfdfdb));
  ground.rotation.x = -Math.PI / 2; ground.position.set(0, -0.03, 6);
  ground.receiveShadow = true;
  scene.add(ground);
  const walk = new T.Mesh(new T.PlaneGeometry(120, 3.2), lam(0xf6f6f4));
  walk.rotation.x = -Math.PI / 2; walk.position.set(0, -0.02, 5.6);
  walk.receiveShadow = true;
  scene.add(walk);
  const road = new T.Mesh(new T.PlaneGeometry(120, 4.6), lam(0xcfcfcc));
  road.rotation.x = -Math.PI / 2; road.position.set(0, -0.02, 9.5);
  road.receiveShadow = true;
  scene.add(road);
  // 차선 점선
  for (let x = -40; x <= 40; x += 3) { const l = new T.Mesh(new T.PlaneGeometry(1.4, 0.12), lam(0xffffff)); l.rotation.x = -Math.PI / 2; l.position.set(x, -0.01, 9.5); scene.add(l); }

  // ---- 건물 골격 (층 2개는 실제, 위 2개는 개념)
  const WALL = 0xfbfbfb, SLAB = 0xe4e4e8;
  outline(box(12.4, 0.25, 8.4, SLAB, 0, 0.1, 0));
  outline(box(12.4, 0.25, 8.4, SLAB, 0, 3, 0));
  // 2층 지붕은 반투명: 위에서 내려다볼 때 약국 안쪽(뒤편 재고 선반)이 가려지지 않게 한다.
  outline(box(12.4, 0.12, 8.4, 0xd8d8de, 0, 6, 0, scene, { transparent: true, opacity: 0.16, depthWrite: false }));
  [0, 3].forEach((y0) => {
    outline(box(12, 3, 0.2, WALL, 0, y0 + 1.6, -4));
    outline(box(0.2, 3, 8, WALL, -6, y0 + 1.6, 0));
    outline(box(0.2, 3, 8, WALL, 6, y0 + 1.6, 0));
    outline(box(12, 3, 0.05, 0xcfe6f5, 0, y0 + 1.6, 4, scene, { transparent: true, opacity: 0.12, depthWrite: false }), 0xc9d6df);
  });
  outline(box(0.2, 3, 8, WALL, -1, 1.6, 0));       // 1층 칸막이
  outline(box(0.2, 3, 8, WALL, 1.5, 4.6, 0));      // 2층 약국 | 이비인후과
  // 정면 간판 띠 (2층 약국 쪽은 파랑, 의원 쪽은 회색)
  box(7.4, 0.35, 0.12, 0x0066cc, -2.3, 6.25, 4.1);
  box(4.4, 0.35, 0.12, 0x9a9aa0, 3.8, 6.25, 4.1);
  box(12.2, 0.3, 0.12, 0xb9b9bf, 0, 3.15, 4.1);

  // ---- 1층: 로비 + 정형외과
  box(4.6, 0.05, 7.8, 0xe7e7e7, -3.5, 0.26, 0);
  const orthoFloor = reg(box(6.8, 0.05, 7.8, 0xe8e3d4, 2.5, 0.26, 0), 'ortho');
  reg(box(2.4, 0.9, 0.8, 0xb7a98d, 3.5, 0.75, -2.4), 'ortho');
  [0, 1, 2].forEach((i) => reg(box(0.9, 0.5, 0.5, 0xa7b4c0, 0.4 + i * 1.1, 0.55, 2.4), 'ortho'));

  // ---- 2층 약국 (왼쪽)
  const phFloor = reg(box(7.3, 0.05, 7.8, 0xe3eef9, -2.35, 3.26, 0), 'pharmacy');
  [-1.4, 0.2].forEach((x) => reg(outline(box(1.7, 2.3, 0.5, 0xf1f1f3, x, 4.5, -3.6)), 'pharmacy'));
  [-1.4, 0.2].forEach((x) => [0, 1, 2].forEach((r) => box(1.5, 0.18, 0.36, [0x6aa6a0, 0xd9a441, 0x8d7bc2][r], x, 3.9 + r * 0.65, -3.3)));
  // 재고 선반 (가상 단일 품목)
  const rack = new T.Group(); scene.add(rack);
  reg(box(2.8, 0.1, 0.9, 0x8b95a0, -4.6, 3.85, -3.3, rack), 'stock');
  reg(box(2.8, 0.1, 0.9, 0x8b95a0, -4.6, 4.65, -3.3, rack), 'stock');
  [-5.95, -3.25].forEach((x) => reg(box(0.1, 1.7, 0.9, 0x8b95a0, x, 4.2, -3.3, rack), 'stock'));
  const slotPos = (i) => [-4.6 + ((i % 5) - 2) * 0.5, i < 5 ? 4.05 : 4.85, -3.3];
  const ghosts = [], solids = [];
  const boxGeo = new T.BoxGeometry(0.4, 0.34, 0.5);
  for (let i = 0; i < 10; i++) {
    const [x, y, z] = slotPos(i);
    const g = new T.Mesh(boxGeo, new T.MeshBasicMaterial({ color: 0x7a55d6, transparent: true, opacity: 0.28, depthWrite: false }));
    g.position.set(x, y, z);
    g.add(new T.LineSegments(new T.EdgesGeometry(boxGeo), new T.LineBasicMaterial({ color: 0x7a55d6 })));
    g.visible = false; reg(g, 'stock'); rack.add(g); ghosts.push(g);
    const s = new T.Mesh(boxGeo, lam(0xc99a4b));
    s.position.set(x, y, z);
    s.add(new T.LineSegments(new T.EdgesGeometry(boxGeo), new T.LineBasicMaterial({ color: 0x6b4b17 })));
    s.visible = false; reg(s, 'stock'); rack.add(s); solids.push(s);
  }
  // 카운터, 약사
  reg(outline(box(3.4, 1, 1, 0xd9d9de, -2.6, 3.8, 0.9)), 'counter');
  const person = (color, x, z, opacity = 1) => {
    const g = new T.Group();
    const m = lam(color, opacity < 1 ? { transparent: true, opacity } : {});
    const body = new T.Mesh(new T.CylinderGeometry(0.2, 0.26, 0.9, 12), m); body.position.y = 0.45;
    const head = new T.Mesh(new T.SphereGeometry(0.2, 14, 12), m); head.position.y = 1.15;
    g.add(body, head); g.position.set(x, 3.15, z);
    return g;
  };
  const persona = person(0x0066cc, -3.2, 0.1); scene.add(persona);
  const other = person(0x8a949c, -1.9, 0.1, 0.4); scene.add(other);
  persona.traverse((o) => { if (o.isMesh) reg(o, 'persona'); });
  other.traverse((o) => { if (o.isMesh) reg(o, 'counter'); });
  // 소파 + 안마봉
  reg(box(1.9, 0.55, 0.8, 0x7f8fa3, -5.1, 3.55, 2.3), 'sofa');
  reg(box(1.9, 0.6, 0.18, 0x6c7c91, -5.1, 3.9, 2.65), 'sofa');
  const bar = new T.Mesh(new T.CylinderGeometry(0.05, 0.05, 0.55, 8), lam(0xd6453d));
  bar.rotation.z = Math.PI / 2.4; bar.position.set(-4.7, 3.95, 2.2); scene.add(bar); reg(bar, 'sofa');
  // 손님(수요 5명)
  const customers = [];
  for (let i = 0; i < 5; i++) {
    const c = person(0x2e9e5b, 0, 0); c.visible = false;
    c.traverse((o) => { if (o.isMesh) reg(o, 'customers'); });
    c.scale.setScalar(0.9); scene.add(c); customers.push(c);
  }

  // ---- 2층 이비인후과 (오른쪽)
  reg(box(4.3, 0.05, 7.8, 0xdde8f3, 3.75, 3.26, 0), 'ent');
  reg(box(2, 0.9, 0.8, 0xb4c3d3, 4.2, 3.75, -2.6), 'ent');
  [0, 1, 2, 3].forEach((i) => reg(box(0.6, 0.45, 0.6, 0x9fb2c7, 2.6 + i * 0.8, 3.55, 1.8), 'ent'));

  // ---- 개념 층 (실제 건물에는 없음)
  const judge = reg(box(12, 3, 8, 0x8e8e93, 0, 7.6, 0, scene, { transparent: true, opacity: 0.05, depthWrite: false }), 'judge');
  edgesOf(judge, 0x8e8e93, true);
  const roof = reg(box(4.4, 1.8, 3, 0x8e8e93, 0, 9.9, 0, scene, { transparent: true, opacity: 0.07, depthWrite: false }), 'roof');
  edgesOf(roof, 0x8e8e93, true);
  box(12.4, 0.12, 8.4, 0x8e8e93, 0, 9.05, 0, scene, { transparent: true, opacity: 0.08, depthWrite: false });

  // ---- 건너편 기존 이비인후과 (현재 시뮬레이션에 미반영)
  // 카메라와 약국 사이를 가리지 않도록 길 건너 왼쪽에 둔다.
  reg(outline(box(7, 6, 5, 0xf0f0f2, -17, 3, 15.5)), 'across');
  reg(box(6, 3.4, 0.1, 0xc9ccd2, -17, 1.7, 12.95), 'across');

  // ---- 도매 트럭과 입고 상자
  const truck = new T.Group();
  outline(box(3.6, 1.7, 1.7, 0xffffff, 0, 1.2, 0, truck));
  box(1.2, 1.3, 1.6, 0x0066cc, 2.4, 1.0, 0, truck);
  [-1.2, 1.2].forEach((x) => [-0.7, 0.7].forEach((z) => { const w = new T.Mesh(new T.CylinderGeometry(0.34, 0.34, 0.25, 14), lam(0x2c3338)); w.rotation.x = Math.PI / 2; w.position.set(x + (x > 0 ? 0.6 : 0), 0.35, z); truck.add(w); }));
  truck.traverse((o) => { if (o.isMesh) reg(o, 'truck'); });
  truck.rotation.y = 0;
  scene.add(truck);
  const TRUCK_AWAY = { x: -11, z: 9.3 }, TRUCK_HERE = { x: -3.4, z: 9.3 };
  truck.position.set(TRUCK_AWAY.x, 0, TRUCK_AWAY.z);
  const dropBoxes = [];
  for (let i = 0; i < 10; i++) {
    const b = new T.Mesh(boxGeo, lam(0xc99a4b));
    b.position.set(-5.6 + (i % 5) * 0.5, 0.45 + Math.floor(i / 5) * 0.36, 5.9);
    b.visible = false; reg(b, 'truck'); scene.add(b); dropBoxes.push(b);
  }

  // ---- 라벨 (HTML 겹침)
  const labelLayer = document.createElement('div');
  labelLayer.className = 'scene-labels';
  labelLayer.setAttribute('aria-hidden', 'true');
  container.appendChild(labelLayer);
  const labels = (opts.labels || []).map((l) => {
    const el = document.createElement('span');
    el.className = `scene-label ${l.cls || ''}`;
    el.textContent = l.text;
    labelLayer.appendChild(el);
    return { ...l, el, v: new T.Vector3(...l.at) };
  });
  const truckLabel = labels.find((l) => l.key === 'truck');
  let labelsOn = !hero;
  labelLayer.style.display = labelsOn ? '' : 'none';

  // ---- 카메라
  const cur = { t: new T.Vector3(), r: 30, th: 0.5, ph: 1.2 };
  const goal = { t: new T.Vector3(), r: 30, th: 0.5, ph: 1.2 };
  const apply = (o, v) => { o.t.set(...v.t); o.r = v.r; o.th = v.th; o.ph = v.ph; };
  const START = hero ? { t: [-2, 5.2, 3], r: 27, th: 0.5, ph: 1.16 } : VIEWS.overview;
  if (hero) picks.filter((m) => m.userData.key === 'across').forEach((m) => { m.visible = false; });
  apply(goal, START); apply(cur, START);
  let lastInput = 0;
  const place = () => {
    const s = Math.sin(cur.ph);
    camera.position.set(cur.t.x + cur.r * s * Math.sin(cur.th), cur.t.y + cur.r * Math.cos(cur.ph), cur.t.z + cur.r * s * Math.cos(cur.th));
    camera.lookAt(cur.t);
  };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const ctrl = {
    VIEWS,
    flyTo(name) {
      const v = VIEWS[name]; if (!v) return;
      apply(goal, v); lastInput = performance.now();
      if (reduceMotion()) { apply(cur, v); }
    },
    zoom(f) { goal.r = clamp(goal.r * f, 4, 46); lastInput = performance.now(); },
    rotate(dth, dph) { goal.th = clamp(goal.th + dth, -1.6, 1.6); goal.ph = clamp(goal.ph + dph, 0.35, 1.5); lastInput = performance.now(); },
    setLabels(on) { labelsOn = on; labelLayer.style.display = on ? '' : 'none'; },
    setTheme(dark) {
      ground.material.color.set(dark ? 0x1f1f22 : 0xdfdfdb);
      walk.material.color.set(dark ? 0x2a2a2e : 0xf6f6f4);
      road.material.color.set(dark ? 0x38383d : 0xcfcfcc);
    },
    /** v: {ghost, solid, truck:'away'|'arrived', drop, fulfilled, unmet} */
    setState(v) {
      ghosts.forEach((g, i) => { g.visible = i < (v.ghost || 0); });
      solids.forEach((s, i) => { s.visible = i < (v.solid || 0); });
      dropBoxes.forEach((b, i) => { b.visible = v.truck === 'arrived' && i < (v.drop || 0); });
      truckTarget = v.truck === 'arrived' ? TRUCK_HERE : TRUCK_AWAY;
      if (truckLabel) truckLabel.el.textContent = v.truck === 'arrived' ? '도매 트럭 · 입고 중 (가상)' : '도매 트럭 · 대기 (가상)';
      if (reduceMotion()) truck.position.set(truckTarget.x, 0, truckTarget.z);
      const f = v.fulfilled || 0, u = v.unmet || 0;
      customers.forEach((c, i) => {
        c.visible = i < f + u;
        if (!c.visible) return;
        const lost = i >= f;
        c.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); o.material.color.set(lost ? 0xd6453d : 0x2e9e5b); } });
        c.userData.home = lost ? [-5.2 + (i - f) * 0.65, 3.15, 3.5] : [-3.9 + i * 0.65, 3.15, 2.4];
        c.position.set(...c.userData.home);
      });
    },
    onPick(fn) { pickHandler = fn; },
    setVisible(v) { visible = v; if (v) { resize(); } },
    resize() { resize(); },
    dispose() { running = false; ro.disconnect(); io.disconnect(); renderer.dispose(); canvas.remove(); labelLayer.remove(); },
    get webgl() { return true; },
  };
  let truckTarget = TRUCK_AWAY;
  let pickHandler = null;
  let visible = true, running = true;

  // ---- 입력
  const ray = new T.Raycaster(), ndc = new T.Vector2();
  const pointers = new Map();
  let down = null, pinch = 0;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    down = { x: e.clientX, y: e.clientY, moved: 0 };
    pinch = 0; lastInput = performance.now();
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) { hoverCheck(e); return; }
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch) goal.r = clamp(goal.r * (pinch / d), 4, 46);
      pinch = d;
    } else {
      goal.th = clamp(goal.th - dx * 0.006, -1.6, 1.6);
      goal.ph = clamp(goal.ph - dy * 0.006, 0.35, 1.5);
    }
    if (down) down.moved += Math.abs(dx) + Math.abs(dy);
    p.x = e.clientX; p.y = e.clientY; lastInput = performance.now();
  });
  const up = (e) => {
    pointers.delete(e.pointerId);
    if (down && down.moved < 6 && pointers.size === 0) {
      const key = pickAt(e);
      if (key && pickHandler) pickHandler(key);
    }
    down = null; pinch = 0;
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  if (!hero) {
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); ctrl.zoom(Math.exp(e.deltaY * 0.0012)); }, { passive: false });
  }
  function pickAt(e) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(picks.filter((m) => m.visible), false)[0];
    return hit ? hit.object.userData.key : null;
  }
  function hoverCheck(e) { canvas.style.cursor = pickAt(e) ? 'pointer' : 'grab'; }
  canvas.style.cursor = 'grab';

  // ---- 크기, 가시성
  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize); ro.observe(container);
  const io = new IntersectionObserver((en) => { visible = en[0].isIntersecting; }, { threshold: 0.01 });
  io.observe(container);

  // ---- 루프
  const tmp = new T.Vector3();
  function frame(now) {
    if (!running) return;
    requestAnimationFrame(frame);
    if (!visible || document.hidden) return;
    const rm = reduceMotion();
    if (hero && !rm && now - lastInput > 2500) {
      goal.th = 0.5 + Math.sin(now * 0.00035) * 0.38;
      goal.ph = 1.17 + Math.sin(now * 0.0002) * 0.05;
    }
    const k = rm ? 1 : 0.12;
    cur.th += (goal.th - cur.th) * k; cur.ph += (goal.ph - cur.ph) * k; cur.r += (goal.r - cur.r) * k;
    cur.t.lerp(goal.t, k);
    place();
    if (!rm) {
      truck.position.x += (truckTarget.x - truck.position.x) * 0.06;
      customers.forEach((c, i) => { if (c.visible) c.position.y = 3.15 + Math.abs(Math.sin(now * 0.004 + i)) * 0.04; });
    }
    if (labelsOn) {
      const w = container.clientWidth, h = container.clientHeight;
      labels.forEach((l) => {
        if (l === truckLabel) l.v.set(truck.position.x, 2.9, truck.position.z);
        tmp.copy(l.v).project(camera);
        const show = tmp.z < 1 && Math.abs(tmp.x) < 1.05 && Math.abs(tmp.y) < 1.05;
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
