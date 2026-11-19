// TowerOfHan: Hacker News as a living tower.
import * as THREE from 'three/webgpu';
import { pass, screenUV, smoothstep, vec3, hash, float, uniform } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
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

const pipeline = new THREE.RenderPipeline(renderer);
const scenePass = pass(scene, camera);
const color = scenePass.getTextureNode('output');
const uGrain = uniform(0);
const vignette = smoothstep(0.95, 0.3, screenUV.sub(0.5).length()).mul(0.42).add(0.58);
const px = screenUV.mul(vec3(1920, 1080, 0).xy).floor();
const grain = hash(px.x.add(px.y.mul(7919.0)).add(uGrain.mul(104729.0))).sub(0.5).mul(0.02);
pipeline.outputNode = color.add(bloom(color, 0.62, 0.45, 0.78)).mul(vignette).add(grain);

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
let lastBlip = 0;

const camDir2 = () => new THREE.Vector2(camera.position.x, camera.position.z).normalize();

sync.onHead = (h: Head, prev) => {
  tower.setOrder(h.tower, h.stories, h.act, clock, camDir2());
  const act = Object.values(h.act).reduce((a, b) => a + b, 0);
  ui.live(`live · ${act} comments in the last 15 minutes`);
  if (prev && mode !== 'tower' && activeStory >= 0 && !h.tower.includes(activeStory)) ui.hint('This story just left the front page.');
};
sync.onDelta = (d) => {
  if (d.turns?.length) {
    uBeacon.value = 1;
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
  rig.glide(outside, new THREE.Vector3(0, roomY + 0.8, 0), 2.4, clock);
  audio.sfx('whoosh');
  audio.setMode('floor');
  setTimeout(() => {
    if (activeStory !== sid) return;
    tower.hidden = slot;
    interior.group.position.y = roomY; crowd.group.position.y = roomY;
    interior.group.visible = true;
    roomYaw = Math.atan2(out.x, out.y);           // the room's front (its tables) faces the way we came in
    const lay = interior.layout(floor, roomYaw);
    spots = lay.spots;
    crowd.set(lay.people);
    overview(clock, 2.0);
    audio.sfx('ding');
    ui.floorHeader({ rank: rank + 1, title: floor.story.title, id: floor.story.id, url: floor.story.url });
    ui.tableLabels(spots, roomY, (s) => sit(s));
    ui.hint('Pick a table to sit down and listen');
    if (autopilot) setTimeout(() => { if (mode === 'floor') sit(bestSpot()); }, recording ? 0 : 2600);
  }, recording ? 0 : 1500);
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
  rig.glide(p, t, dur, now, 0.4);
}

function bestSpot(): TableSpot {
  const convo = spots.filter((s) => !s.bar);
  return convo.find((s) => s.table.turns.filter((t) => t.v).length >= 2) ?? convo[0] ?? spots[0];
}

function sit(s: TableSpot | undefined) {
  if (!s || !activeFloor) return;
  if (s.bar) return;
  mode = 'table'; ui.mode('table'); audio.setMode('table'); audio.sfx('sit');
  ui.hint('Esc to stand up · Space to pause · N for the next table');
  director.start(activeFloor, s, roomY, clock);
}

function nextTable() {
  if (!director.spot) return;
  const convo = spots.filter((s) => !s.bar);
  const k = convo.findIndex((s) => s.table.root === director.spot!.table.root);
  sit(convo[(k + 1) % convo.length]);
}
director.onEnd = () => { if (mode === 'table') nextTable(); };

function standUp() {
  director.stop();
  mode = 'floor'; ui.mode('floor'); audio.setMode('floor');
  ui.hint('Pick a table to sit down and listen');
  overview(clock, 1.6);
}

function leaveFloor() {
  director.stop();
  if (activeStory >= 0) sync.unwatch(activeStory);
  activeStory = -1; activeFloor = null;
  mode = 'tower'; ui.mode('tower'); audio.setMode('tower');
  ui.floorHeader(null); ui.clearLabels(); ui.hint('Tap a floor to step inside');
  rig.glide(HOME.pos.clone().multiplyScalar(0.85), HOME.target, 2.2, clock);
  audio.sfx('whoosh');
  setTimeout(() => {
    tower.hidden = -1; interior.group.visible = false; crowd.set([]);
    camera.position.copy(rig.pos); controls.target.copy(rig.target);
    controls.enabled = true; controls.autoRotate = true;
  }, recording ? 0 : 2250);
}

document.getElementById('back')!.onclick = () => leaveFloor();
document.getElementById('leave')!.onclick = () => standUp();
document.getElementById('next')!.onclick = () => nextTable();
document.getElementById('pause')!.onclick = (e) => { director.togglePause(); (e.target as HTMLElement).textContent = director.paused ? 'Play' : 'Pause'; };
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (mode === 'table') standUp(); else if (mode === 'floor') leaveFloor(); }
  else if (e.key === ' ' && mode === 'table') { e.preventDefault(); director.togglePause(); }
  else if ((e.key === 'n' || e.key === 'N') && mode === 'table') nextTable();
  else if (e.key === 'm' || e.key === 'M') audio.setMuted(!audio.muted);
});

// hover + click on the tower
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
let hoverSlot = -1, downAt = 0, downXY = [0, 0];
renderer.domElement.addEventListener('pointermove', (e) => {
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
  if (mode !== 'tower' || performance.now() - downAt > 400 || Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]) > 8) return;
  const sid = hoverSlot >= 0 ? tower.slots[hoverSlot].sid : null;
  if (sid !== null) enterFloor(sid);
});
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

// ---------------------------------------------------------------- the loop
const fwd = new THREE.Vector3();
function frame(dt: number, draw = true) {
  clock += dt;
  uTime.value = clock; setTimeValue(clock);
  uBeacon.value = Math.max(0, uBeacon.value - dt * 0.9);
  uGrain.value = (clock * 60) % 1000;
  if (recording) audio.vclock = clock;
  tower.update(clock, dt);
  if (mode === 'tower' && controls.enabled) controls.update(dt);
  else rig.update(clock, dt);
  director.update(clock, dt);
  crowd.update(dt);
  ui.update();
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
    orbit: (a: number, r = 150, h = 62) => { camera.position.set(Math.cos(a) * r, h, Math.sin(a) * r); controls.target.copy(HOME.target); },
    clock: () => clock,
    timeline: () => director.timeline(),
    mode: () => mode,
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
    if (autopilot) setTimeout(() => sync.head && enterFloor(sync.head.tower[0]), 4000);
  });
}
