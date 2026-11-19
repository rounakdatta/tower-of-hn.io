// TowerOfHan: Hacker News as a living tower.
import * as THREE from 'three/webgpu';
import { pass, screenUV, smoothstep, vec3, hash, float, uniform } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LiveSync, type Floor, type Head } from './sync.ts';
import { AudioEngine } from './audio.ts';
import { buildSky, buildCity, buildSnow, Tower, uTime, uBeacon, floorY, FLOOR_H, R, TOWER_TOP } from './world.ts';
import { Interior, type TableSpot } from './interior.ts';
import { Crowd, setTimeValue } from './people.ts';
import { Director } from './director.ts';
import { Rig } from './rig.ts';
import { UI } from './ui.ts';

const params = new URLSearchParams(location.search);
const DATA = params.get('data') ?? `http://${location.hostname || 'localhost'}:8787/live/`;
const recording = params.has('record');
const autopilot = params.has('auto') || recording;
let leanBack = autopilot;            // hands-free: floor to floor, table to table

// ---------------------------------------------------------------- renderer + post
const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: params.has('webgl') });
renderer.setPixelRatio(Math.min(devicePixelRatio, recording ? 1 : 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
document.body.prepend(renderer.domElement);
await renderer.init();

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x0a0e1a, 0.0052);
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.05, 2400);
scene.add(new THREE.HemisphereLight(0x7080b0, 0x1a120c, 0.5));
const moon = new THREE.DirectionalLight(0xc3d2ff, 0.7);
moon.position.set(-60, 90, -100);
scene.add(moon);
// cutscene lighting: a cool rim behind whoever the camera looks at, only while seated
const rim = new THREE.DirectionalLight(0x9ec4ff, 0);
scene.add(rim, rim.target);

const pipeline = new THREE.RenderPipeline(renderer);
const scenePass = pass(scene, camera);
const color = scenePass.getTextureNode('output');
const uGrain = uniform(0);
/** 0..1 while a table turns heated: the frame closes in and warms a touch */
const uTension = uniform(0);
const vignette = smoothstep(float(0.95).sub(uTension.mul(0.2)), 0.3, screenUV.sub(0.5).length()).mul(uTension.mul(0.2).add(0.42)).add(float(0.58).sub(uTension.mul(0.2)));
const warm = vec3(uTension.mul(0.05).add(1), float(1).sub(uTension.mul(0.015)), float(1).sub(uTension.mul(0.05)));
const px = screenUV.mul(vec3(1920, 1080, 0).xy).floor();
const grain = hash(px.x.add(px.y.mul(7919.0)).add(uGrain.mul(104729.0))).sub(0.5).mul(0.02);
const uFocus = uniform(2), uBokeh = uniform(0);
const bloomed = bloom(color, 0.62, 0.45, 0.78);
const plainOut = color.add(bloomed).mul(vignette).mul(warm).add(grain);
const dofOut = dof(color, scenePass.getViewZNode(), uFocus, 0.9, uBokeh).add(bloomed).mul(vignette).mul(warm).add(grain);
pipeline.outputNode = plainOut;
let dofOn = false;
/** shallow focus only at the table: film-like close-ups, no cost elsewhere */
function setDof(on: boolean) {
  if (on === dofOn) return;
  dofOn = on;
  pipeline.outputNode = on ? dofOut : plainOut;
  pipeline.needsUpdate = true;
}

buildSky(scene);
buildCity(scene);
buildSnow(scene);
const tower = new Tower(scene);
const interior = new Interior();
const crowd = new Crowd();
scene.add(interior.group, crowd.group);

const ui = new UI();
ui.bind(camera);
const audio = new AudioEngine();
audio.virtual = recording;
const sync = new LiveSync(DATA);
const rig = new Rig(camera);
const director = new Director(sync, audio, crowd, rig, ui);
director.pushChair = (c, k) => interior.pushChair(c, k);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.dampingFactor = 0.06;
controls.autoRotate = true; controls.autoRotateSpeed = 0.35;
controls.minDistance = 24; controls.maxDistance = 260; controls.maxPolarAngle = Math.PI * 0.49;
controls.enablePan = false;
const HOME = { pos: new THREE.Vector3(96, 58, 128), target: new THREE.Vector3(0, TOWER_TOP * 0.5, 0) };
camera.position.copy(HOME.pos); controls.target.copy(HOME.target);

// ---------------------------------------------------------------- state
type Mode = 'tower' | 'floor' | 'table';
let mode: Mode = 'tower';
let clock = 0;
let activeStory = -1, activeFloor: Floor | null = null, roomY = 0, roomYaw = 0;
let spots: TableSpot[] = [];
let lastBlip = 0, deepLinked = false;
/** scene-clock timers: identical in live viewing and in deterministic recordings */
const timers: { at: number; fn: () => void }[] = [];
const after = (secs: number, fn: () => void) => timers.push({ at: clock + secs, fn });

const camDir2 = () => new THREE.Vector2(camera.position.x, camera.position.z).normalize();

sync.onHead = (h: Head, prev) => {
  tower.setOrder(h.tower, h.stories, h.act, clock, camDir2());
  const act = Object.values(h.act).reduce((a, b) => a + b, 0);
  ui.live(`live · ${act} comments in the last 15 minutes`);
  const talking = h.tower.reduce((n, id) => n + (h.stories[id]?.[2] ?? 0), 0);
  const st = document.getElementById('stats');
  if (st) st.textContent = `${h.tower.length} floors · ${talking.toLocaleString()} comments · ${act} in the last 15 minutes`;
  if (prev && mode !== 'tower' && activeStory >= 0 && !h.tower.includes(activeStory)) ui.hint('This story just left the front page.');
};
sync.onDelta = (d) => {
  if (d.turns?.length) {
    uBeacon.value = 1;
    for (const t of d.turns) tower.pulse(t.story);
    if (mode === 'tower' && clock - lastBlip > 1.2) { audio.sfx('blip'); lastBlip = clock; }
  }
};
tower.onMove = () => { if (mode === 'tower') audio.sfx('rumble'); };

// ---------------------------------------------------------------- navigation
async function enterFloor(sid: number) {
  if (!sync.head) return;
  const rank = sync.head.tower.indexOf(sid);
  const floor = await sync.floor(sid);
  if (!floor || rank < 0) return;
  activeStory = sid; activeFloor = floor;
  roomY = floorY(rank) - FLOOR_H * 0.47;
  const slot = tower.slotOf.get(sid) ?? -1;
  // the ride: from wherever we are to just outside this floor, then in through the glass
  mode = 'floor'; ui.mode('floor'); controls.enabled = false; controls.autoRotate = false;
  ui.tip(null);
  const out = new THREE.Vector2(camera.position.x, camera.position.z).normalize();
  const outside = new THREE.Vector3(out.x * (R + 8), roomY + 1.6, out.y * (R + 8));
  rig.pos.copy(camera.position); rig.target.copy(controls.target);
  rig.fovTarget = 45; rig.fov = camera.fov;
  rig.glide(outside, new THREE.Vector3(0, roomY + 0.8, 0), 2.4, clock, 0, 0.6);
  audio.sfx('whoosh');
  audio.setMode('floor');
  after(1.5, () => {
    if (activeStory !== sid) return;
    tower.hidden = slot;
    interior.group.position.y = roomY; crowd.group.position.y = roomY;
    interior.group.visible = true;
    roomYaw = Math.atan2(out.x, out.y);           // the room's front (its tables) faces the way we came in
    const lay = interior.layout(floor, roomYaw, deepTable);
    spots = lay.spots;
    crowd.set(lay.people);
    overview(clock, 2.0);
    audio.sfx('ding');
    ui.card(`Floor ${rank + 1} · ${floor.story.comments} comments`, floor.story.title);
    ui.floorHeader({ rank: rank + 1, title: floor.story.title, id: floor.story.id, url: floor.story.url });
    ui.tableLabels(spots, roomY, (s) => sit(s));
    after(2.0, () => { if (mode === 'floor') ui.showLabels(true); });
    ui.hint('Pick a table to sit down and listen');
    if (leanBack || deepLinked) after(deepLinked ? 1.8 : 3.2, () => { if (mode === 'floor') sit(bestSpot()); deepLinked = false; });
  });
  sync.watch(sid, (f) => {
    activeFloor = f;
    if (mode === 'table') director.refresh(f);
    else if (mode === 'floor') ui.tableLabels(spots.map((s) => ({ ...s, table: f.tables.find((t) => t.root === s.table.root) ?? s.table })), roomY, (s) => sit(s));
  });
}

function overview(now: number, dur: number) {
  const Y = new THREE.Vector3(0, 1, 0);
  const p = new THREE.Vector3(0.6, 0, R - 0.75).applyAxisAngle(Y, roomYaw).setY(roomY + 1.95);
  const t = new THREE.Vector3(0, 0, -0.4).applyAxisAngle(Y, roomYaw).setY(roomY + 0.45);
  rig.fovTarget = 58;
  rig.glide(p, t, dur, now, 0.4, 0);          // indoors: no crane arc, or we'd rise through the ceiling
}

let deepTable = Number(params.get('table') ?? 0);
let deepFrom = Number(params.get('from') ?? 0);
function bestSpot(): TableSpot {
  const convo = spots.filter((s) => !s.bar);
  if (deepTable) { const d = spots.find((s) => s.table.root === deepTable); deepTable = 0; if (d) return d; }
  return convo.find((s) => s.table.turns.filter((t) => t.v).length >= 2) ?? convo[0] ?? spots[0];
}

function sit(s: TableSpot | undefined) {
  if (!s || !activeFloor) return;
  if (s.bar && !s.tableOf) {
    // the bar plays its one-liners in turn, each from its own table
    const remarks = spots.filter((x) => x.bar);
    const c = remarks.reduce((v, x) => v.add(x.pos), new THREE.Vector3()).divideScalar(remarks.length);
    s = { index: -1, bar: true, pos: c, radius: 1.3, seats: remarks.flatMap((x) => x.seats),
      table: { root: -1, seated: [], standing: remarks.map((x) => x.table.turns[0].by), turns: remarks.map((x, k) => ({ ...x.table.turns[0], gapMs: k ? 750 : 0 })) },
      tableOf: new Map(remarks.map((x) => [x.table.turns[0].id, x.index])) };
  }
  mode = 'table'; ui.mode('table'); audio.setMode('table'); audio.sfx('sit'); ui.showLabels(false);
  ui.flash(); setDof(true);
  if (!recording) history.replaceState(null, '', `?story=${activeFloor.story.id}&table=${s.table.root}`);
  ui.hint('Esc to stand up · Space to pause · N for the next table');
  director.others = spots.filter((x) => !x.bar && x !== s).map((x) => ({ pos: x.pos, turns: x.table.turns }));
  director.jumpTo = deepFrom; deepFrom = 0;
  director.start(activeFloor, s, roomY, clock);
}

function nextTable() {
  if (!director.spot) return;
  const convo = spots.filter((s) => !s.bar);
  const k = convo.findIndex((s) => s.table.root === director.spot!.table.root);
  sit(convo[(k + 1) % convo.length]);
}
director.onEnd = () => {
  if (mode !== 'table') return;
  const convo = spots.filter((s) => !s.bar && s.table.turns.some((t) => t.v));
  const k = convo.findIndex((s) => s.table.root === director.spot?.table.root);
  if (leanBack && sync.head && (k < 0 || k >= Math.min(convo.length, 3) - 1)) {
    // done with this floor's best tables: ride to the next floor down the ranking
    const order = sync.head.tower, next = order[(order.indexOf(activeStory) + 1) % Math.min(order.length, 10)];
    leaveFloor();
    after(2.6, () => enterFloor(next));
  } else nextTable();
};
director.onNewReply = (by) => ui.toast(`<b>${by}</b> just replied on Hacker News`);

function standUp() {
  leanBack = false;
  director.stop(); setDof(false);
  mode = 'floor'; ui.mode('floor'); audio.setMode('floor');
  ui.hint('Pick a table to sit down and listen');
  overview(clock, 1.6);
  after(1.6, () => { if (mode === 'floor') ui.showLabels(true); });
}

function leaveFloor() {
  director.stop(); setDof(false);
  if (!recording) history.replaceState(null, '', location.pathname);
  if (activeStory >= 0) sync.unwatch(activeStory);
  activeStory = -1; activeFloor = null;
  mode = 'tower'; ui.mode('tower'); audio.setMode('tower');
  ui.floorHeader(null); ui.clearLabels(); ui.hint('Tap a floor to step inside');
  rig.glide(HOME.pos.clone().multiplyScalar(0.85), HOME.target, 2.2, clock);
  audio.sfx('whoosh');
  after(2.25, () => {
    if (mode !== 'tower') return;                 // they already rode up somewhere else
    tower.hidden = -1; interior.group.visible = false; crowd.set([]);
    camera.position.copy(rig.pos); controls.target.copy(rig.target);
    controls.enabled = true; controls.autoRotate = true;
  });
}

document.getElementById('back')!.onclick = () => { leanBack = false; leaveFloor(); };
document.getElementById('lean')!.onclick = () => {
  audio.ensure();
  const h = sync.head;
  if (!h) return;
  leanBack = true;
  const busiest = h.tower.slice(0, 10).reduce((a, b) => ((h.act[b] ?? 0) > (h.act[a] ?? 0) ? b : a), h.tower[0]);
  enterFloor(busiest);
};
document.getElementById('leave')!.onclick = () => standUp();
document.getElementById('next')!.onclick = () => nextTable();
document.getElementById('pause')!.onclick = (e) => { director.togglePause(); (e.target as HTMLElement).textContent = director.paused ? 'Play' : 'Pause'; };
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (mode === 'table') standUp(); else if (mode === 'floor') leaveFloor(); }
  else if (e.key === ' ' && mode === 'table') { e.preventDefault(); director.togglePause(); }
  else if ((e.key === 'n' || e.key === 'N') && mode === 'table') nextTable();
  else if (e.key === 'm' || e.key === 'M') audio.setMuted(!audio.muted);
  else if (mode === 'tower' && sync.head && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Enter')) {
    e.preventDefault();
    const order = sync.head.tower;
    const cur = hoverSlot >= 0 ? order.indexOf(tower.slots[hoverSlot].sid ?? -1) : -1;
    if (e.key === 'Enter') { if (cur >= 0) enterFloor(order[cur]); return; }
    const rank = Math.max(0, Math.min(order.length - 1, cur < 0 ? 0 : cur + (e.key === 'ArrowUp' ? -1 : 1)));
    const sid = order[rank], s = sync.head.stories[sid];
    hoverSlot = tower.slotOf.get(sid) ?? -1;
    tower.setSelected(hoverSlot); audio.sfx('tick');
    if (s) ui.tip({ rank: rank + 1, title: s[0], url: s[4], score: s[1], comments: s[2], act: sync.head.act[sid] ?? 0 }, innerWidth * 0.58, innerHeight * 0.42);
  }
});

// hover + click on the tower
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
let hoverSlot = -1, hoverTable = -1, downAt = 0, downXY = [0, 0];
renderer.domElement.addEventListener('pointermove', (e) => {
  if (mode === 'floor') {
    ptr.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(ptr, camera);
    const hit = ray.intersectObject(interior.tableMesh)[0];
    hoverTable = hit?.instanceId ?? -1;
    renderer.domElement.style.cursor = hoverTable >= 0 ? 'pointer' : '';
    return;
  }
  if (mode !== 'tower') return;
  ptr.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  const hit = ray.intersectObject(tower.floors)[0];
  const slot = hit?.instanceId ?? -1;
  if (slot !== hoverSlot) { hoverSlot = slot; tower.setSelected(slot); if (slot >= 0) audio.sfx('tick'); }
  const sid = slot >= 0 ? tower.slots[slot].sid : null;
  const h = sync.head;
  if (sid !== null && h?.stories[sid]) {
    const s = h.stories[sid];
    ui.tip({ rank: h.tower.indexOf(sid) + 1, title: s[0], url: s[4], score: s[1], comments: s[2], act: h.act[sid] ?? 0 }, e.clientX, e.clientY);
    renderer.domElement.style.cursor = 'pointer';
  } else { ui.tip(null); renderer.domElement.style.cursor = ''; }
});
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = performance.now(); downXY = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (performance.now() - downAt > 400 || Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]) > 8) return;
  if (mode === 'floor') {
    ptr.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(ptr, camera);
    const k = ray.intersectObject(interior.tableMesh)[0]?.instanceId;
    if (k !== undefined) sit(spots.filter((x) => !x.bar)[k]);
    return;
  }
  if (mode !== 'tower') return;
  const sid = hoverSlot >= 0 ? tower.slots[hoverSlot].sid : null;
  if (sid !== null) enterFloor(sid);
});
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

// ---------------------------------------------------------------- the loop
const fwd = new THREE.Vector3();
function frame(dt: number, draw = true) {
  clock += dt;
  for (let k = timers.length - 1; k >= 0; k--) if (timers[k].at <= clock) { const t = timers.splice(k, 1)[0]; t.fn(); }
  uTime.value = clock; setTimeValue(clock);
  uBeacon.value = Math.max(0, uBeacon.value - dt * 0.9);
  uGrain.value = (clock * 60) % 1000;
  uTension.value += ((mode === 'table' ? director.tension : 0) - uTension.value) * Math.min(1, dt * 1.2);
  const ev = 1.08 * (mode === 'table' ? director.exposure : 1);
  renderer.toneMappingExposure += (ev - renderer.toneMappingExposure) * Math.min(1, dt * 8);
  if (recording) audio.vclock = clock;
  tower.update(clock, dt);
  if (mode === 'tower' && controls.enabled) controls.update(dt);
  else rig.update(clock, dt);
  director.update(clock, dt);
  crowd.update(dt);
  ui.update();
  if (dofOn) { uFocus.value = camera.position.distanceTo(rig.target); uBokeh.value = 2.4; }
  rim.intensity += ((mode === 'table' ? 1.1 : 0) - rim.intensity) * Math.min(1, dt * 3);
  if (rim.intensity > 0.01) {
    const away = rig.target.clone().sub(camera.position).setY(0).normalize();
    rim.position.copy(rig.target).addScaledVector(away, 3).add(new THREE.Vector3(0, 1.6, 0));
    rim.target.position.copy(rig.target);
  }
  camera.getWorldDirection(fwd);
  audio.listener(camera.position, fwd, camera.up);
  if (draw) pipeline.render();
}

await sync.start();
ui.mode('tower');
ui.hint('Tap a floor to step inside');
if (recording) {
  (window as any).__tohn = {
    frame: (dt: number, draw = true) => frame(dt, draw),
    enter: (rank: number) => enterFloor(sync.head!.tower[rank]),
    orbit: (a: number, r = 150, h = 62, ty?: number) => { camera.position.set(Math.cos(a) * r, h, Math.sin(a) * r); controls.target.copy(HOME.target); if (ty !== undefined) controls.target.y = ty; },
    clock: () => clock,
    timeline: () => director.timeline(),
    mode: () => mode,
    shot: () => director.shot,
    /** debug: put the lens straight in front of someone's face (angle off their nose, metres away) */
    look: (name: string, off = 0, dist = 1.2) => {
      const i = crowd.index(name); if (i < 0) return null;
      const p = crowd.people[i], h = crowd.headPos(i), a = p.pose.facing + p.expr.turn + Math.max(-1.1, Math.min(1.1, p.expr.yaw)) + off;
      rig.cut(new THREE.Vector3(h.x + Math.sin(a) * dist, h.y, h.z + Math.cos(a) * dist), h, 0); rig.fovTarget = 31;
      return { look: p.look.style, glasses: p.look.glasses, hood: p.look.hood, expr: p.expr };
    },
    scene: () => ({
      cam: camera.position.toArray(), target: rig.target.toArray(), fov: camera.fov,
      table: director.spot ? { pos: director.spot.pos.toArray(), r: director.spot.radius } : null,
      people: crowd.people.map((p, i) => ({ name: p.name, head: crowd.headPos(i).toArray(), seated: p.pose.seated, stand: p.expr.stand, facing: p.pose.facing, turn: p.expr.turn, yaw: p.expr.yaw, at: director.spot?.seats.some((s) => s.name === p.name) })),
    }),
    swap: () => { const h = sync.head!; const t = h.tower.slice(); [t[2], t[7]] = [t[7], t[2]]; tower.setOrder(t, h.stories, h.act, clock, camDir2()); },
  };
  (window as any).__ready = true;
} else {
  let last = performance.now();
  renderer.setAnimationLoop(() => {
    const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000); last = now;
    frame(dt);
  });
  ui.splash(() => {
    audio.ensure();
    const story = Number(params.get('story') ?? 0);
    if (story && sync.head?.tower.includes(story)) { deepLinked = true; after(1.2, () => enterFloor(story)); }
    else if (autopilot) after(4, () => sync.head && enterFloor(sync.head.tower[0]));
  });
  // keep the conversation going when the tab is hidden (rAF stops; a timer keeps scheduling audio)
  let bg = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && mode === 'table') bg = window.setInterval(() => frame(0.25, false), 250);
    else { clearInterval(bg); last = performance.now(); }
  });
}
