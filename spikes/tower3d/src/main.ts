// TowerOfHan — spike 0. Throwaway code: proves the shape, not the art.
// Live HN front page as a tower (1 draw call for all floors), a night city
// (1 draw call), and a floor interior where every character is instanced
// (bodies 1 call, heads 1 call) with shader-drawn faces and talking mouths.
import * as THREE from 'three/webgpu';
import {
  uniform, instancedBufferAttribute, hash, step, fract, positionWorld, instanceIndex, mix, smoothstep,
  vec3, float, sin, uv, dot, floor as tfloor, normalLocal, abs, positionLocal, clamp,
} from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const FLOORS = 30, FLOOR_H = 1.6, R = 7;
const HN = 'https://hacker-news.firebaseio.com/v0';
const params = new URLSearchParams(location.search);
const recording = params.has('record');

// ---------------------------------------------------------------- renderer
const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: params.has('webgl') });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.prepend(renderer.domElement);
await renderer.init();
const backendName = (renderer.backend as any).isWebGPUBackend ? 'WebGPU' : 'WebGL2';

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d16);
scene.fog = new THREE.Fog(0x0b0d16, 70, 300);
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.05, 1200);
camera.position.set(58, 40, 78);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, FLOORS * FLOOR_H * 0.45, 0);
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0x8a96c8, 0x0c0c14, 0.7));
const moon = new THREE.DirectionalLight(0xc8d6ff, 0.9);
moon.position.set(-40, 90, 30);
scene.add(moon);
const uTime = uniform(0);
const uEnv = uniform(0); // 1 = mouths follow real speech loudness

// ---------------------------------------------------------------- ground + city (1 draw call)
const ground = new THREE.Mesh(new THREE.CircleGeometry(400, 64), new THREE.MeshStandardNodeMaterial({ color: 0x0d0f17, roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const CITY = 520;
const cityMat = new THREE.MeshStandardNodeMaterial({ color: 0x141826, roughness: 0.85, metalness: 0.2 });
{
  const cell = tfloor(positionWorld.mul(vec3(2.2, 1.7, 2.2)));
  const rnd = hash(dot(cell, vec3(12.9898, 78.233, 37.719)));
  const bands = step(0.45, fract(positionWorld.y.mul(1.7))).mul(step(0.4, fract(positionWorld.x.add(positionWorld.z).mul(2.2))));
  const walls = step(abs(normalLocal.y), 0.5);
  cityMat.emissiveNode = mix(vec3(1.0, 0.7, 0.4), vec3(0.6, 0.75, 1.0), step(0.93, rnd)).mul(step(0.8, rnd)).mul(bands).mul(walls).mul(0.8);
}
const city = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), cityMat, CITY);
{
  const m = new THREE.Matrix4(), rng = mulberry32(7);
  for (let i = 0; i < CITY; i++) {
    const a = rng() * Math.PI * 2, d = 40 + Math.pow(rng(), 0.8) * 240;
    const w = 5 + rng() * 10, h = 4 + Math.pow(rng(), 2.4) * 34 + (d > 150 ? rng() * 30 : 0), dd = 5 + rng() * 10;
    m.compose(new THREE.Vector3(Math.cos(a) * d, h / 2, Math.sin(a) * d), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * Math.PI), new THREE.Vector3(w, h, dd));
    city.setMatrixAt(i, m);
  }
}
scene.add(city);

// ---------------------------------------------------------------- the tower (1 draw call)
const floorGeo = new THREE.CylinderGeometry(R, R, FLOOR_H * 0.9, 72, 1);
const aGlow = new THREE.InstancedBufferAttribute(new Float32Array(FLOORS), 1);
const aSel = new THREE.InstancedBufferAttribute(new Float32Array(FLOORS), 1);
floorGeo.setAttribute('aGlow', aGlow);
floorGeo.setAttribute('aSel', aSel);
const floorMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.3, metalness: 0.7 });
{
  const glow = instancedBufferAttribute(aGlow), sel = instancedBufferAttribute(aSel);
  const wu = fract(uv().x.mul(110)), wv = uv().y;
  const shape = step(0.16, wu).mul(step(wu, 0.84)).mul(step(0.2, wv)).mul(step(wv, 0.82));
  const r = hash(tfloor(uv().x.mul(110)).add(float(instanceIndex).mul(131.0)));
  const lit = step(float(1).sub(glow), r);                 // busier story => more lit windows
  const flicker = sin(uTime.mul(0.6).add(r.mul(50))).mul(0.06).add(0.94);
  const walls = step(abs(normalLocal.y), 0.5);
  floorMat.colorNode = vec3(0.05, 0.06, 0.09);
  floorMat.emissiveNode = mix(vec3(1.0, 0.6, 0.28), vec3(1.0, 0.86, 0.62), r).mul(shape).mul(lit).mul(flicker).mul(walls).mul(1.7)
    .add(vec3(1.0, 0.42, 0.08).mul(sel).mul(walls).mul(0.35));
}
const tower = new THREE.InstancedMesh(floorGeo, floorMat, FLOORS);
tower.frustumCulled = false;
scene.add(tower);
const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.3, 7, 12), new THREE.MeshStandardNodeMaterial({ color: 0x20232e, metalness: 0.8, roughness: 0.3 }));
spire.position.y = FLOORS * FLOOR_H + 3.5; scene.add(spire);
const beaconMat = new THREE.MeshBasicNodeMaterial(); beaconMat.colorNode = vec3(1.0, 0.4, 0.0).mul(sin(uTime.mul(2.0)).mul(0.35).add(1.1));
const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.45, 16, 12), beaconMat); beacon.position.y = FLOORS * FLOOR_H + 7.2; scene.add(beacon);

// ---------------------------------------------------------------- live data
type Story = { id: number; title: string; score: number; descendants: number; kids?: number[]; by: string };
const stories = new Map<number, Story>();
const slotOf = new Map<number, number>();          // story id -> instance slot (stable while on the page)
const slotStory: (number | null)[] = Array(FLOORS).fill(null);
const slotY = new Float32Array(FLOORS).fill(-FLOOR_H * 2);
const slotTarget = new Float32Array(FLOORS).fill(-FLOOR_H * 2);
const prevDesc = new Map<number, { n: number; t: number }>();
const labels: THREE.Sprite[] = [];
let order: number[] = [];

async function poll() {
  const top: number[] = (await (await fetch(`${HN}/topstories.json`)).json()).slice(0, FLOORS);
  order = top;
  const items: Story[] = await Promise.all(top.map(async (id) => (await fetch(`${HN}/item/${id}.json`)).json()));
  const now = performance.now() / 1000;
  const keep = new Set(top);
  slotStory.forEach((sid, s) => { if (sid !== null && !keep.has(sid)) { slotStory[s] = null; slotOf.delete(sid); } });
  items.forEach((it, rank) => {
    if (!it) return;
    stories.set(it.id, it);
    let s = slotOf.get(it.id);
    if (s === undefined) { s = slotStory.indexOf(null); slotStory[s] = it.id; slotOf.set(it.id, s); slotY[s] = -FLOOR_H * 2; }
    slotTarget[s] = (FLOORS - 1 - rank) * FLOOR_H + FLOOR_H / 2;
    const p = prevDesc.get(it.id);
    const perMin = p ? Math.max(0, (it.descendants - p.n) / Math.max(0.5, (now - p.t) / 60)) : 0;
    prevDesc.set(it.id, { n: it.descendants || 0, t: now });
    aGlow.array[s] = Math.min(1, 0.12 + Math.log1p(it.descendants || 0) / 9 + Math.log1p(perMin) / 3);
    setLabel(s, rank, it);
  });
  aGlow.needsUpdate = true;
}

function setLabel(slot: number, rank: number, it: Story) {
  let sp = labels[slot];
  if (!sp) {
    const c = document.createElement('canvas'); c.width = 1024; c.height = 64;
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
    mat.map = tex;
    sp = new THREE.Sprite(mat); sp.scale.set(16, 1, 1); sp.renderOrder = 2;
    labels[slot] = sp; scene.add(sp);
  }
  const tex = (sp.material as any).map as THREE.CanvasTexture, c = tex.image as HTMLCanvasElement, g = c.getContext('2d')!;
  g.clearRect(0, 0, c.width, c.height);
  g.font = '600 30px ui-sans-serif, system-ui, sans-serif'; g.textBaseline = 'middle';
  g.fillStyle = '#ff9a3c'; g.fillText(String(rank + 1).padStart(2, ' '), 8, 34);
  g.fillStyle = '#f2eee8'; g.fillText(trim(g, it.title, 760), 64, 34);
  g.fillStyle = '#9aa3b8'; g.font = '26px ui-sans-serif, system-ui, sans-serif';
  g.fillText(`${it.score}▲ ${it.descendants ?? 0}💬`, 840, 34);
  tex.needsUpdate = true;
}
function trim(g: CanvasRenderingContext2D, s: string, w: number) {
  if (g.measureText(s).width <= w) return s;
  while (s.length && g.measureText(s + '…').width > w) s = s.slice(0, -1);
  return s + '…';
}

// ---------------------------------------------------------------- floor interior: tables + instanced characters
const MAX_CHARS = 160, MAX_TABLES = 14;
const interior = new THREE.Group(); interior.visible = false; scene.add(interior);
const plate = new THREE.Mesh(new THREE.CircleGeometry(R - 0.15, 72), new THREE.MeshStandardNodeMaterial({ color: 0x2a2320, roughness: 0.6 }));
plate.rotation.x = -Math.PI / 2; interior.add(plate);
const ceilingLight = new THREE.PointLight(0xffd6a0, 30, 16, 1.6); ceilingLight.position.set(0, 1.35, 0); interior.add(ceilingLight);
const tableMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 0.06, 40), new THREE.MeshStandardNodeMaterial({ color: 0x6b4a33, roughness: 0.5 }), MAX_TABLES);
interior.add(tableMesh);

const aCol = new THREE.InstancedBufferAttribute(new Float32Array(MAX_CHARS * 3), 3);
const aSpeak = new THREE.InstancedBufferAttribute(new Float32Array(MAX_CHARS), 1);
const aPhase = new THREE.InstancedBufferAttribute(new Float32Array(MAX_CHARS), 1);
const bodyGeo = new THREE.CapsuleGeometry(0.15, 0.3, 4, 10);
const headGeo = new THREE.SphereGeometry(0.13, 24, 16);
for (const g of [bodyGeo, headGeo]) { g.setAttribute('aCol', aCol); g.setAttribute('aSpeak', aSpeak); g.setAttribute('aPhase', aPhase); }
const col = instancedBufferAttribute(aCol), speak = instancedBufferAttribute(aSpeak), phase = instancedBufferAttribute(aPhase);
const bob = sin(uTime.mul(1.7).add(phase.mul(6.283))).mul(0.008)
  .add(speak.mul(abs(sin(uTime.mul(7.0).add(phase.mul(6.283)))).mul(0.018)));
const bodyMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.75 });
bodyMat.colorNode = col;
bodyMat.positionNode = positionLocal.add(vec3(0, bob, 0));
const headMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.6 });
{
  // A whole face in the fragment shader: eyes, blink, and a mouth whose opening follows "speech".
  const n = normalLocal;
  const blink = step(0.985, fract(uTime.mul(0.23).add(phase.mul(3.1))));
  const eye = (x: number) => smoothstep(0.12, 0.095, n.sub(vec3(x, 0.24, 0.94)).length()).mul(float(1).sub(blink));
  const eyes = eye(-0.32).add(eye(0.32));
  const open = speak.mul(mix(abs(sin(uTime.mul(13.0).add(phase.mul(9.0)))), float(1), uEnv)).mul(0.16).add(0.025);
  const ell = n.x.div(0.24).mul(n.x.div(0.24)).add(n.y.add(0.3).div(open).mul(n.y.add(0.3).div(open)));
  const mouth = step(ell, float(1)).mul(step(0.0, n.z));
  const skin = col.mul(0.35).add(vec3(0.62, 0.5, 0.42));
  headMat.colorNode = mix(mix(skin, vec3(0.05, 0.04, 0.05), clamp(eyes, 0, 1)), vec3(0.32, 0.06, 0.08), mouth);
  headMat.positionNode = positionLocal.add(vec3(0, bob.mul(1.4), 0));
}
const bodies = new THREE.InstancedMesh(bodyGeo, bodyMat, MAX_CHARS);
const heads = new THREE.InstancedMesh(headGeo, headMat, MAX_CHARS);
bodies.frustumCulled = heads.frustumCulled = false;
interior.add(bodies, heads);

type Utt = { by: string; text: string; table: number; id?: number; gapMs?: number };
let script: Utt[] = [], seats = new Map<string, number[]>(), activeFloorSlot = -1;
const seatPos = new Map<string, THREE.Vector3>(); let tableCenters: THREE.Vector3[] = [], tableRadius: number[] = [], lastCue = -1;

async function enterFloor(slot: number) {
  const sid = slotStory[slot]; if (sid == null) return;
  const st = stories.get(sid)!;
  activeFloorSlot = slot;
  titleEl.textContent = st.title;
  const manifest = await fetch(`/data/floors/${sid}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  let threads: any[];
  if (manifest) {
    threads = manifest.tables.map((t: any) => ({ seated: t.seated, turns: t.turns }));
  } else {
    const tree = await (await fetch(`https://hn.algolia.com/api/v1/items/${sid}`)).json();
    const rankOf = new Map((st.kids || []).map((k, i) => [k, i]));
    threads = (tree.children || []).filter((c: any) => c.text)
      .sort((a: any, b: any) => (rankOf.get(a.id) ?? 1e9) - (rankOf.get(b.id) ?? 1e9)).slice(0, MAX_TABLES);
  }
  // lay tables on rings across the floor plate
  const m = new THREE.Matrix4(); let ci = 0; seats = new Map(); script = [];
  const pos: THREE.Vector3[] = []; seatPos.clear(); tableRadius = [];
  threads.forEach((_: any, i: number) => {
    const ring = i < 5 ? 2.6 : 5.0, k = i < 5 ? i : i - 5, n = i < 5 ? Math.min(5, threads.length) : Math.max(1, threads.length - 5);
    const a = (k / n) * Math.PI * 2 + (i < 5 ? 0.3 : 0);
    pos.push(new THREE.Vector3(Math.cos(a) * ring, 0, Math.sin(a) * ring));
  });
  threads.forEach((th: any, ti: number) => {
    const people: string[] = []; const order: Utt[] = [];
    if (th.turns) { people.push(...th.seated); order.push(...th.turns.map((t: any) => ({ by: t.by, text: t.display, table: ti, id: t.id, gapMs: t.gapMs }))); }
    else (function walk(c: any) { if (c.text && c.author) { if (!people.includes(c.author)) people.push(c.author); order.push({ by: c.author, text: clean(c.text), table: ti }); } (c.children || []).forEach(walk); })(th);
    const seated = people.slice(0, 9);
    const tr = 0.42 + seated.length * 0.05; tableRadius[ti] = tr;
    m.compose(pos[ti].clone().setY(0.42), new THREE.Quaternion(), new THREE.Vector3(tr, 1, tr));
    tableMesh.setMatrixAt(ti, m);
    seated.forEach((who, j) => {
      if (ci >= MAX_CHARS) return;
      const a = (j / seated.length) * Math.PI * 2;
      const p = pos[ti].clone().add(new THREE.Vector3(Math.cos(a) * (tr + 0.28), 0, Math.sin(a) * (tr + 0.28)));
      const face = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(pos[ti].x - p.x, pos[ti].z - p.z));
      seatPos.set(`${ti}:${who}`, p.clone());
      m.compose(p.clone().setY(0.38), face, new THREE.Vector3(1, 1, 1)); bodies.setMatrixAt(ci, m);
      m.compose(p.clone().setY(0.74), face, new THREE.Vector3(1, 1, 1)); heads.setMatrixAt(ci, m);
      const h = hashStr(who); const c = new THREE.Color().setHSL((h % 360) / 360, 0.45, 0.45);
      aCol.setXYZ(ci, c.r, c.g, c.b); aPhase.setX(ci, (h % 1000) / 1000); aSpeak.setX(ci, 0);
      seats.set(`${ti}:${who}`, [...(seats.get(`${ti}:${who}`) || []), ci]); ci++;
    });
    script.push(...order.slice(0, 40).filter((u) => seated.includes(u.by)));
  });
  tableCenters = pos; lastCue = -1;
  tableMesh.count = threads.length; bodies.count = heads.count = ci;
  tableMesh.instanceMatrix.needsUpdate = bodies.instanceMatrix.needsUpdate = heads.instanceMatrix.needsUpdate = true;
  aCol.needsUpdate = aPhase.needsUpdate = aSpeak.needsUpdate = true;
  interior.position.y = slotTarget[slot] - FLOOR_H * 0.45;
  interior.visible = true; backBtn.style.display = 'block';
  // focus on the first table's conversation
  script = script.filter((u) => u.table === 0).concat(script.filter((u) => u.table !== 0));
  uttIndex = -1; uttEnds = 0;
  await buildTimeline(clock + 3.0);
  const y = interior.position.y;
  flyTo(new THREE.Vector3(pos[0].x * 0.2 + 0.5, y + 1.15, pos[0].z * 0.2 + R - 1.2), new THREE.Vector3(pos[0].x, y + 0.6, pos[0].z), 2.6);
}
function leaveFloor() {
  interior.visible = false; activeFloorSlot = -1; backBtn.style.display = 'none'; titleEl.textContent = ''; subEl.innerHTML = '';
  flyTo(new THREE.Vector3(58, 40, 78), new THREE.Vector3(0, FLOORS * FLOOR_H * 0.45, 0), 2.2);
}

// speaking: real clips when the voice worker has made them, else a placeholder clock
type Cue = { id: number; by: string; table: number; start: number; dur: number; env: number[]; text: string };
let timeline: Cue[] = [];
let audioCtx: AudioContext | null = null;
async function buildTimeline(t0: number) {
  timeline = []; uEnv.value = 0;
  let t = t0;
  for (const u of script.filter((x) => x.table === 0 && x.id)) {
    const pack = await fetch(`/data/c/${u.id}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!pack) continue;
    t += timeline.length ? (u.gapMs ?? 300) / 1000 : 0;
    timeline.push({ id: u.id!, by: u.by, table: 0, start: t, dur: pack.dur, env: pack.env, text: u.text });
    t += pack.dur;
  }
  if (!timeline.length) return;
  uEnv.value = 1;
  (window as any).__timeline = timeline.map(({ id, by, start, dur }) => ({ id, by, start, dur }));
  if (!recording) {
    audioCtx ??= new AudioContext();
    await audioCtx.resume();
    const base = audioCtx.currentTime - clock;
    for (const c of timeline) {
      const buf = await audioCtx.decodeAudioData(await (await fetch(`/data/c/${c.id}.ogg`)).arrayBuffer());
      const src = audioCtx.createBufferSource(); src.buffer = buf; src.connect(audioCtx.destination);
      src.start(Math.max(audioCtx.currentTime, base + c.start));
    }
  }
}
let uttIndex = -1, uttEnds = 0;
function stepConversation(t: number) {
  if (activeFloorSlot < 0) return;
  if (timeline.length) {
    aSpeak.array.fill(0);
    const c = timeline.find((x) => t >= x.start && t < x.start + x.dur);
    if (c && c.id !== lastCue) {
      lastCue = c.id;
      const sp = seatPos.get(`${c.table}:${c.by}`), ctr = tableCenters[c.table];
      if (sp && ctr) {
        const y = interior.position.y, dir = sp.clone().sub(ctr).setY(0).normalize();
        const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(0.35);
        const camPos = ctr.clone().sub(dir.clone().multiplyScalar((tableRadius[c.table] ?? 0.6) + 1.15)).add(side).setY(y + 1.05);
        flyTo(camPos, sp.clone().setY(y + 0.7), 1.1);
      }
    }
    if (c) {
      const v = (c.env[Math.floor((t - c.start) * 30)] ?? 0) / 255;
      for (const i of seats.get(`${c.table}:${c.by}`) || []) aSpeak.array[i] = v;
      subEl.innerHTML = `<b>${esc(c.by)}</b> ${esc(c.text.length > 240 ? c.text.slice(0, 240) + '…' : c.text)}`;
    }
    aSpeak.needsUpdate = true;
    return;
  }
  if (!script.length || t < uttEnds) return;
  aSpeak.array.fill(0);
  uttIndex = (uttIndex + 1) % script.length;
  const u = script[uttIndex];
  for (const i of seats.get(`${u.table}:${u.by}`) || []) aSpeak.array[i] = 1;
  aSpeak.needsUpdate = true;
  const words = u.text.split(/\s+/).length;
  uttEnds = t + Math.min(9, Math.max(2.2, words / 2.6));
  subEl.innerHTML = `<b>${esc(u.by)}</b> ${esc(u.text.length > 220 ? u.text.slice(0, 220) + '…' : u.text)}`;
}

// ---------------------------------------------------------------- camera flights, picking, loop
let flight: { from: THREE.Vector3; to: THREE.Vector3; fromT: THREE.Vector3; toT: THREE.Vector3; t0: number; dur: number } | null = null;
let clock = 0;
function flyTo(to: THREE.Vector3, target: THREE.Vector3, dur: number) {
  flight = { from: camera.position.clone(), to, fromT: controls.target.clone(), toT: target, t0: clock, dur };
}
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
let hoverSlot = -1;
renderer.domElement.addEventListener('pointermove', (e) => {
  ptr.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  const hit = ray.intersectObject(tower)[0];
  hoverSlot = hit?.instanceId ?? -1;
});
renderer.domElement.addEventListener('click', () => { if (activeFloorSlot < 0 && hoverSlot >= 0) enterFloor(hoverSlot); });
const backBtn = document.getElementById('back')!, subEl = document.getElementById('sub')!, titleEl = document.getElementById('title')!, hud = document.getElementById('hud')!;
backBtn.onclick = leaveFloor;

const m4 = new THREE.Matrix4(), q0 = new THREE.Quaternion(), s1 = new THREE.Vector3(1, 1, 1), tmp = new THREE.Vector3(), toCam = new THREE.Vector3();
let fpsAvg = 60, last = performance.now();
function frame(dt: number, draw = true) {
  clock += dt; uTime.value = clock;
  for (let s = 0; s < FLOORS; s++) {
    slotY[s] += (slotTarget[s] - slotY[s]) * (1 - Math.exp(-dt * 2.5));
    const hidden = s === activeFloorSlot || slotStory[s] === null;
    m4.compose(tmp.set(0, slotY[s], 0), q0, hidden ? new THREE.Vector3(0, 0, 0) : s1);
    tower.setMatrixAt(s, m4);
    aSel.array[s] = s === hoverSlot ? 1 : 0;
    const lab = labels[s];
    if (lab) {
      lab.visible = activeFloorSlot < 0 && slotStory[s] !== null;
      toCam.set(camera.position.x, 0, camera.position.z).normalize();
      lab.position.set(toCam.x * (R + 0.6), slotY[s], toCam.z * (R + 0.6));
    }
  }
  tower.instanceMatrix.needsUpdate = true; aSel.needsUpdate = true;
  if (flight) {
    const k = Math.min(1, (clock - flight.t0) / flight.dur), e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    camera.position.lerpVectors(flight.from, flight.to, e); controls.target.lerpVectors(flight.fromT, flight.toT, e);
    if (k >= 1) flight = null;
  }
  stepConversation(clock);
  controls.update();
  if (!draw) return;
  renderer.render(scene, camera);
  const info = renderer.info.render;
  hud.textContent = `${backendName} · ${recording ? '' : fpsAvg.toFixed(0) + ' fps · '}${info.drawCalls} draws · ${(info.triangles / 1000).toFixed(0)}k tris\nfloors ${slotStory.filter((x) => x !== null).length} · city ${CITY} · characters ${activeFloorSlot >= 0 ? bodies.count : 0}`;
}

addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

await poll();
if (!recording) setInterval(poll, 30_000);
if (recording) {
  // deterministic capture: the harness calls __frame(1/30) and screenshots after each
  (window as any).__frame = (dt: number, draw = true) => frame(dt, draw);
  (window as any).__clock = () => clock;
  (window as any).__enter = (rank: number) => enterFloor(slotOf.get(order[rank])!);
  (window as any).__orbit = (a: number, r = 96, h = 40) => { camera.position.set(Math.cos(a) * r, h, Math.sin(a) * r); controls.target.set(0, FLOORS * FLOOR_H * 0.5, 0); };
  (window as any).__ready = true;
} else {
  renderer.setAnimationLoop(() => {
    const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000); last = now;
    fpsAvg += (1 / Math.max(dt, 1e-3) - fpsAvg) * 0.05;
    frame(dt);
  });
}

// ---------------------------------------------------------------- utils
function hashStr(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function mulberry32(a: number) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function clean(h: string) { const d = document.createElement('div'); d.innerHTML = h.replace(/<p>/g, ' '); return (d.textContent || '').replace(/\s+/g, ' ').trim(); }
function esc(s: string) { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!)); }
