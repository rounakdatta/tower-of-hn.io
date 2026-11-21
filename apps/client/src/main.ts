// TowerOfHan: Hacker News as a living tower.
import * as THREE from 'three/webgpu';
import { pass, screenUV, smoothstep, vec3, hash, float, uniform } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { LiveSync, type Floor, type Head } from './sync.ts';
import { AudioEngine } from './audio.ts';
import { buildSky, buildCity, buildSnow, Tower, uTime, uBeacon, uNeon, uNeonOf, floorY, FLOOR_H, R, TOWER_TOP } from './world.ts';
import { TowerCam } from './towercam.ts';
import { Interior, type TableSpot } from './interior.ts';
import { Crowd, setTimeValue } from './people.ts';
import { Director } from './director.ts';
import { esc } from './util.ts';
import { Rig } from './rig.ts';
import { UI } from './ui.ts';

const params = new URLSearchParams(location.search);
// development: towerd on its own port next to Vite; production: towerd serves this page, so the same origin
const DATA = params.get('data') ?? (import.meta.env.DEV ? `http://${location.hostname || 'localhost'}:8787/live/` : '/live/');
const recording = params.has('record');
const autopilot = params.has('auto') || recording;
let leanBack = autopilot;            // hands-free: floor to floor, table to table

// ---------------------------------------------------------------- renderer + post
const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: params.has('webgl') });
const DPR_CAP = Math.min(devicePixelRatio, recording ? 1 : 1.75);
let dpr = DPR_CAP;
renderer.setPixelRatio(dpr);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
document.body.prepend(renderer.domElement);
try { await renderer.init(); } catch (e) {
  // neither WebGPU nor WebGL2: say so on the door instead of leaving it waking forever
  const b = document.getElementById('enter') as HTMLButtonElement | null;
  if (b) b.textContent = 'This browser can’t draw the tower: try a recent Chrome, Safari or Firefox';
  throw e;
}

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

const cam = new TowerCam(camera, renderer.domElement);
const HOME = { pos: new THREE.Vector3(96, 58, 128), target: new THREE.Vector3(0, TOWER_TOP * 0.5, 0) };
camera.position.copy(HOME.pos); camera.lookAt(HOME.target);

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
  tower.setOrder(h.tower, h.stories, h.act, clock, camDir2(), h.people);
  cam.floors = h.tower.length;
  // the focus is a story, not a height: when the front page reorders, it follows its story
  const r = focusSid >= 0 ? h.tower.indexOf(focusSid) : -1;
  if (r >= 0 && r !== cam.rank) { cam.rank = r; cam.yTarget = floorY(r); }
  else if (r < 0 && cam.rank >= 0 && h.tower[cam.rank] !== undefined) focusSid = h.tower[cam.rank];
  if (cam.enabled) showFocus();
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

// ---------------------------------------------------------------- the tower: the floor in focus
let focusSid = -1;
const $id = (id: string) => document.getElementById(id)!;
function showFocus() {
  const h = sync.head;
  if (!h || focusSid < 0 || mode !== 'tower') return;
  const s = h.stories[focusSid], rank = h.tower.indexOf(focusSid);
  if (!s || rank < 0) return;
  tower.setSelected(tower.slotOf.get(focusSid) ?? -1);
  ui.focusCard({ rank: rank + 1, title: s[0], url: s[4], score: s[1], comments: s[2], act: h.act[focusSid] ?? 0, people: h.people?.[focusSid] }, () => enterFloor(focusSid, true, true));
  ui.elevator(h.tower.length, rank, h.tower.map((id) => h.act[id] ?? 0), (k) => cam.focus(k), h.tower.map((id) => h.people?.[id] ?? 0));
  // the card covers the bottom of a phone: the floor in focus sits in the middle of what's left. Where the card
  // sits at one side instead (a wide screen, a phone on its side), the tower stands clear of it on the other.
  const box = $id('focus').getBoundingClientRect();
  const beside = box.width < innerWidth * 0.66;
  cam.lift = beside ? 0.03 : Math.max(0.03, Math.min(0.16, (innerHeight - box.top) / innerHeight / 2));
  cam.shift = !beside ? 0 : box.left < innerWidth * 0.3 ? 0.12 : -0.2;
  $id('focus').classList.toggle('first', navHint);
}
cam.onFocus = (rank) => {
  const sid = sync.head?.tower[rank];
  if (sid === undefined) return;
  focusSid = sid;
  showFocus();
  if (mode === 'tower') { audio.sfx('tick'); if (touch && cam.dragging) navigator.vibrate?.(5); }   // a detent per floor under the finger (Android)
  warmSoon(sid);
};
cam.onTouch = () => { if (navHint) { navHint = false; localStorage.setItem('tohn-nav', '1'); $id('focus').classList.remove('first'); } };
let navHint = !localStorage.getItem('tohn-nav');
cam.onTap = (x, y) => {
  ptr.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  const slot = ray.intersectObject(tower.floors)[0]?.instanceId;
  const sid = slot !== undefined ? tower.slots[slot].sid : null;
  if (sid === null || !sync.head) return;
  const rank = sync.head.tower.indexOf(sid);
  if (rank === cam.rank) enterFloor(sid, true, true);     // the floor you're facing: in you go
  else cam.focus(rank);                                   // another: it comes to you first
};

// Pre-emption: voicing starts before anyone asks. A floor you stop on (not one you scroll past) has its tables'
// first words voiced and fetched; walking onto a floor goes further. By the time you sit, someone can speak.
const warmedAt = new Map<string, number>();
let warmTimer = 0;
function warmSoon(sid: number) { clearTimeout(warmTimer); warmTimer = window.setTimeout(() => prewarm(sid, 1), 650); }
async function prewarm(sid: number, level: 1 | 2) {
  if (recording) return;
  const key = `${sid}:${level}`;
  if (performance.now() - (warmedAt.get(key) ?? -1e9) < 55_000) return;
  warmedAt.set(key, performance.now());
  sync.warm(sid, level);
  const f = await sync.floor(sid);
  if (!f || !audio.live) return;
  // fetch and decode what's already voiced at the best tables, so the first line plays the moment you sit
  for (const t of f.tables.filter((x) => x.turns.length >= 2).slice(0, level === 2 ? 6 : 3)) {
    const v = t.turns[0].v;
    if (v) sync.sidecar(v[0]).then((side) => side.clips.slice(0, 2).forEach((c) => audio.load(sync.url(c.u)).catch(() => {}))).catch(() => {});
  }
}

// ---------------------------------------------------------------- navigation
// Every step in that someone takes is a history entry, so the back gesture (the first thing a phone user tries)
// steps back out: table, then floor, then the tower. Steps the autopilot takes replace the entry instead.
let depth = 0;                                           // entries we've pushed, so we never step back off the site
function nav(url: string, push: boolean) {
  if (recording) return;
  if (push) { history.pushState({ tohn: ++depth }, '', url); } else history.replaceState(history.state, '', url);
}
/** Step out `steps` levels: through history when we put the entries there, directly otherwise. */
function stepOut(steps: number) {
  if (!recording && depth >= steps) { history.go(-steps); return; }   // popstate does the rest
  depth = Math.max(0, depth - steps);
  if (mode === 'table' && steps === 1) standUp(); else leaveFloor();
}
addEventListener('popstate', () => {
  depth = Math.max(0, (history.state?.tohn as number | undefined) ?? 0);
  const q = new URLSearchParams(location.search);
  if (!q.get('story')) { if (mode !== 'tower') { leanBack = false; leaveFloor(); } }
  else if (!q.get('table') && mode === 'table') standUp();
});

/** listen: they asked to hear it (Listen in, a tap on the floor), so unless they pick a table, we sit them at the best */
let chose = false;
async function enterFloor(sid: number, push = false, listen = false) {
  if (!sync.head) return;
  const rank = sync.head.tower.indexOf(sid);
  const floor = await sync.floor(sid);
  if (!floor || rank < 0) return;
  activeStory = sid; activeFloor = floor; focusSid = sid;
  roomY = floorY(rank) - FLOOR_H * 0.47;
  const slot = tower.slotOf.get(sid) ?? -1;
  prewarm(sid, 2);
  nav(`?story=${sid}`, push && mode === 'tower');
  // the ride: from wherever we are to just outside this floor, then in through the glass
  mode = 'floor'; ui.mode('floor'); cam.enabled = false; awake();
  ui.tip(null); ui.hint('');
  const out = new THREE.Vector2(camera.position.x, camera.position.z).normalize();
  const outside = new THREE.Vector3(out.x * (R + 8), roomY + 1.6, out.y * (R + 8));
  rig.pos.copy(camera.position); rig.target.copy(cam.look);
  rig.matchLens(); rig.fovTarget = 45;                     // the ride starts with the lens as it is: no pop
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
    ui.tableLabels(spots, roomY, (s) => sit(s, true), bestSpot(false));
    after(2.0, () => { if (mode === 'floor') ui.showLabels(true); });
    chose = false;
    ui.hint(listen && !leanBack ? 'Sitting down at the liveliest table · tap to choose another' : 'Pick a table to sit down and listen');
    if (leanBack || deepLinked || listen) after(deepLinked ? 1.8 : listen ? 2.8 : 3.2, () => {
      if (mode === 'floor' && !chose) sit(bestSpot(), listen && !leanBack);
      deepLinked = false;
    });
  });
  sync.watch(sid, (f) => {
    activeFloor = f;
    // the room keeps up with the floor (new turns, audio that just landed): a table you sit at next starts current
    for (const sp of spots) {
      if (sp.bar && sp.index < 0) continue;
      const k = f.tables.findIndex((t) => t.root === sp.table.root);
      if (k >= 0 && !(mode === 'table' && director.spot === sp)) { sp.table = f.tables[k]; sp.index = k; }
    }
    if (mode === 'table' && !params.has('freeze')) director.refresh(f);     // ?freeze: a take that live HN can't rewrite mid-shot
    else if (mode === 'floor') ui.tableLabels(spots, roomY, (s) => sit(s, true), bestSpot(false));
    if (mode === 'floor') prewarm(sid, 2);              // still standing here a minute on: keep the first words coming
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
/** The table to start at: a deep link's, else the first lively one whose first words are ready (or soonest). */
function bestSpot(consume = true): TableSpot {
  const convo = spots.filter((s) => !s.bar);
  if (deepTable) { const d = spots.find((s) => s.table.root === deepTable); if (consume) deepTable = 0; if (d) return d; }
  return convo.find((s) => s.table.turns.filter((t) => t.v).length >= 2) ?? convo.find((s) => s.table.turns[0].v) ?? convo[0] ?? spots[0];
}

function sit(s: TableSpot | undefined, push = false) {
  if (!s || !activeFloor) return;
  const fromFloor = mode === 'floor';
  // always the table as the floor has it now (its turns and audio move on while we stand here)
  if (!s.bar) {
    const k = activeFloor.tables.findIndex((t) => t.root === s!.table.root);
    if (k >= 0) { s.table = activeFloor.tables[k]; s.index = k; }
  }
  if (s.bar && !s.tableOf) {
    // the bar plays its one-liners in turn, each from its own table
    const remarks = spots.filter((x) => x.bar);
    const c = remarks.reduce((v, x) => v.add(x.pos), new THREE.Vector3()).divideScalar(remarks.length);
    s = { index: -1, bar: true, pos: c, radius: 1.3, seats: remarks.flatMap((x) => x.seats),
      table: { root: -1, seated: [], standing: remarks.map((x) => x.table.turns[0].by), turns: remarks.map((x, k) => ({ ...x.table.turns[0], gapMs: k ? 750 : 0 })) },
      tableOf: new Map(remarks.map((x) => [x.table.turns[0].id, x.index])) };
  }
  mode = 'table'; ui.mode('table'); audio.setMode('table'); audio.sfx('sit'); ui.showLabels(false); awake();
  ui.flash(); setDof(true);
  nav(`?story=${activeFloor.story.id}&table=${s.table.root}`, fromFloor && depth === 1);
  media(activeFloor.story.title, s.table.turns[0]?.by);
  ui.hint('Esc to stand up · Space to pause · N for the next table');
  director.others = spots.filter((x) => !x.bar && x !== s).map((x) => ({ pos: x.pos, turns: x.table.turns }));
  director.jumpTo = deepFrom; deepFrom = 0;
  director.skipIds = new Set((params.get('skip') ?? '').split(',').filter(Boolean).map(Number));
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
director.onNewReply = (by) => ui.toast(`<b>${esc(by)}</b> just replied on Hacker News`);

function standUp() {
  leanBack = false;
  director.stop(); setDof(false);
  mode = 'floor'; ui.mode('floor'); audio.setMode('floor'); awake();
  ui.hint('Pick a table to sit down and listen');
  overview(clock, 1.6);
  after(1.6, () => { if (mode === 'floor') ui.showLabels(true); });
}

function leaveFloor() {
  director.stop(); setDof(false);
  nav(location.pathname, false);
  const left = activeStory;
  if (activeStory >= 0) sync.unwatch(activeStory);
  activeStory = -1; activeFloor = null;
  mode = 'tower'; ui.mode('tower'); audio.setMode('tower'); awake();
  ui.floorHeader(null); ui.clearLabels(); ui.hint('');
  // back out through the glass to stand facing the floor you were on: it stays in focus
  const r = Math.max(0, sync.head?.tower.indexOf(left) ?? cam.rank);
  focusSid = sync.head?.tower[r] ?? focusSid;
  const { pos, look } = cam.pose(r);
  rig.glide(pos, look, 2.2, clock);
  audio.sfx('whoosh');
  after(2.25, () => {
    if (mode !== 'tower') return;                 // they already rode up somewhere else
    tower.hidden = -1; interior.group.visible = false; crowd.set([]);
    cam.resume(r);
    showFocus();
  });
}

document.getElementById('back')!.onclick = () => { leanBack = false; stepOut(mode === 'table' ? 2 : 1); };
document.getElementById('lean')!.onclick = () => {
  audio.ensure();
  const h = sync.head;
  if (!h) return;
  leanBack = true;
  const busiest = h.tower.slice(0, 10).reduce((a, b) => ((h.act[b] ?? 0) > (h.act[a] ?? 0) ? b : a), h.tower[0]);
  enterFloor(busiest, true);
};
document.getElementById('leave')!.onclick = () => stepOut(1);
document.getElementById('next')!.onclick = () => nextTable();
document.getElementById('pause')!.onclick = (e) => { director.togglePause(); (e.target as HTMLElement).textContent = director.paused ? 'Play' : 'Pause'; };
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (mode === 'table') stepOut(1); else if (mode === 'floor') { leanBack = false; stepOut(1); } }
  else if (e.key === ' ' && mode === 'table') { e.preventDefault(); director.togglePause(); }
  else if ((e.key === 'n' || e.key === 'N') && mode === 'table') nextTable();
  else if (e.key === 'm' || e.key === 'M') audio.setMuted(!audio.muted);
  else if (mode === 'tower' && cam.enabled && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Enter') && document.activeElement?.id !== 'elevator') {
    e.preventDefault();
    if (e.key === 'Enter') { if (focusSid >= 0) enterFloor(focusSid, true, true); return; }
    cam.focus(cam.rank + (e.key === 'ArrowUp' ? -1 : 1));
  }
});

// hover (a mouse: touch has no hover, so a tap on the tower focuses first) and taps in the room
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
let hoverSlot = -1, downAt = 0, downXY = [0, 0];
renderer.domElement.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || cam.dragging) return;
  ptr.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  if (mode === 'floor') {
    renderer.domElement.style.cursor = ray.intersectObject(interior.tableMesh)[0] ? 'pointer' : '';
    return;
  }
  if (mode !== 'tower' || !cam.enabled) return;
  const slot = ray.intersectObject(tower.floors)[0]?.instanceId ?? -1;
  const sid = slot >= 0 ? tower.slots[slot].sid : null;
  const h = sync.head;
  if (slot !== hoverSlot) hoverSlot = slot;
  if (sid !== null && sid !== focusSid && h?.stories[sid]) {
    const s = h.stories[sid];
    ui.tip({ rank: h.tower.indexOf(sid) + 1, title: s[0], url: s[4], score: s[1], comments: s[2], act: h.act[sid] ?? 0 }, e.clientX, e.clientY);
  } else ui.tip(null);
  renderer.domElement.style.cursor = sid !== null ? 'pointer' : 'grab';
});
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = performance.now(); downXY = [e.clientX, e.clientY]; if (mode === 'floor') { chose = true; ui.hint('Pick a table to sit down and listen'); } });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (mode !== 'floor' || performance.now() - downAt > 400 || Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]) > 8) return;
  ptr.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  const k = ray.intersectObject(interior.tableMesh)[0]?.instanceId;
  if (k !== undefined) sit(spots.filter((x) => !x.bar)[k], true);
});
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); showFocus(); });

// ---------------------------------------------------------------- the lock screen and control centre: what's playing
function media(title: string, by?: string) {
  const ms = navigator.mediaSession;
  if (!ms || recording || typeof MediaMetadata === 'undefined') return;
  ms.metadata = new MediaMetadata({ title, artist: by ? `${by} and others, on TowerOfHan` : 'TowerOfHan', album: 'Hacker News, live' });
}
if (navigator.mediaSession && !recording) {
  const ms = navigator.mediaSession;
  const toggle = (want: boolean) => { if (mode === 'table' && director.paused === want) { director.togglePause(); $id('pause').textContent = director.paused ? 'Play' : 'Pause'; } };
  ms.setActionHandler('play', () => toggle(true));
  ms.setActionHandler('pause', () => toggle(false));
  try { ms.setActionHandler('nexttrack', () => { if (mode === 'table') nextTable(); }); } catch { /* not offered */ }
}

// ---------------------------------------------------------------- the screen stays on while there's something to hear
// (phones dim and lock after half a minute untouched, which ended conversations mid-sentence)
let wake: { release(): Promise<void> } | null = null;
async function awake() {
  const want = mode !== 'tower' || leanBack;
  const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void>; addEventListener(e: string, f: () => void): void }> } }).wakeLock;
  if (!wl || recording) return;
  if (want && !wake && document.visibilityState === 'visible') {
    try { const w = await wl.request('screen'); wake = w; w.addEventListener('release', () => { if (wake === w) wake = null; }); } catch { /* refused (battery saver): the old behaviour */ }
  } else if (!want && wake) { const w = wake; wake = null; w.release().catch(() => {}); }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') awake(); });

// ---------------------------------------------------------------- the neon sign
// it catches when you come in, stutters, holds; now and then its orange "Of" buzzes. Steady if motion is reduced.
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const neon = { at: -1, buzzAt: 9, n: 0 };
function neonTick(now: number) {
  if (neon.at < 0) { uNeon.value = uNeonOf.value = 0; return; }
  if (reduceMotion) { uNeon.value = uNeonOf.value = 1; return; }
  const k = now - neon.at;
  const step = (seq: [number, number][]) => seq.reduce((v, [t, x]) => (k >= t ? x : v), 0);
  let base = step([[0, 0], [0.12, 1], [0.2, 0.15], [0.3, 0.85], [0.36, 0.2], [0.5, 1]]);
  let of = step([[0, 0], [0.55, 0.4], [0.62, 0], [0.7, 1]]);
  if (now > neon.buzzAt) { neon.buzzAt = now + 7 + ((neon.n++ * 7919) % 9); }
  const b = now - (neon.buzzAt - 7 - (((neon.n - 1) * 7919) % 9));
  if (k > 1 && b >= 0 && b < 0.49) of = [1, 0.2, 1, 0.35, 1, 0.1, 1][Math.floor(b / 0.07)] ?? 1;
  const hum = 1 + Math.sin(now * 37) * 0.015;
  base *= hum; of *= hum;
  uNeon.value = base; uNeonOf.value = of;
}

// ---------------------------------------------------------------- the loop
const fwd = new THREE.Vector3();
function frame(dt: number, draw = true) {
  clock += dt;
  for (let k = timers.length - 1; k >= 0; k--) if (timers[k].at <= clock) { const t = timers.splice(k, 1)[0]; t.fn(); }
  uTime.value = clock; setTimeValue(clock);
  uBeacon.value = Math.max(0, uBeacon.value - dt * 0.9);
  uGrain.value = (clock * 60) % 1000;
  uTension.value += ((mode === 'table' ? director.tension : 0) - uTension.value) * Math.min(1, dt * 1.2);
  // at a table, skin never blooms (a face under a lamp was glowing white); the lamps, windows and the city still do
  const th = (bloomed as unknown as { threshold: { value: number } }).threshold;
  th.value += ((mode === 'table' ? 1.3 : mode === 'tower' ? 0.92 : 0.78) - th.value) * Math.min(1, dt * 3);
  const ev = 1.08 * (mode === 'table' ? director.exposure : 1);
  renderer.toneMappingExposure += (ev - renderer.toneMappingExposure) * Math.min(1, dt * 8);
  if (recording) audio.vclock = clock;
  tower.update(clock, dt);
  if (mode === 'tower' && (cam.enabled || !entered)) { cam.update(dt); tower.faceYaw = cam.theta; }
  else rig.update(clock, dt);
  neonTick(clock);
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

for (let a = 0; ; a++) {
  try { await sync.start(); break; } catch {
    const b = document.getElementById('enter') as HTMLButtonElement | null;
    if (b && a >= 1) b.textContent = 'Reaching Hacker News…';
    await new Promise((r) => setTimeout(r, Math.min(15000, 1500 * 2 ** a)));
  }
}
ui.mode('tower');
let entered = false;                     // past the splash: the tower is in your hands
const touch = matchMedia('(hover: none)').matches;
/** Inside: the sign lights, the camera comes down to the top floor, and (first visit) how to move is shown. */
function arrive() {
  entered = true;
  neon.at = clock;
  cam.arrive(0);
  $id('fhint').textContent = touch ? 'or drag the tower to change floors' : 'or scroll to change floors';
}
// ?probe: decode one clip exactly as playback does, and describe it (tests the native and the WebAssembly Opus paths)
if (params.has('probe')) (window as any).__probe = async (url: string) => {
  audio.ensure();
  const b = await audio.load(url);
  let peak = 0;
  for (const x of b.getChannelData(0)) peak = Math.max(peak, Math.abs(x));
  return { seconds: b.duration, rate: b.sampleRate, channels: b.numberOfChannels, peak };
};
if (recording) {
  (window as any).__tohn = {
    frame: (dt: number, draw = true) => frame(dt, draw),
    enter: (rank: number) => enterFloor(sync.head!.tower[rank]),
    orbit: (a: number, r = 150, _h = 62, ty?: number) => { cam.theta = a; cam.d = cam.dTarget = r; cam.y = cam.yTarget = ty ?? TOWER_TOP * 0.5; },
    focus: (rank: number) => cam.focus(rank),
    leave: () => leaveFloor(),
    fov: () => camera.fov,
    /** debug: hold a face (any Expr fields) on someone, for the face sheet */
    face: (name: string, e: Record<string, number>) => { const i = crowd.index(name); if (i < 0) return false; crowd.active.add(i); Object.assign(crowd.target(i)!, e); return true; },
    clock: () => clock,
    timeline: () => director.timeline(),
    mode: () => mode,
    shot: () => director.shot,
    /** debug: stand someone up (outside a table scene the director leaves them be) */
    stand: (name: string, k = 1) => { const i = crowd.index(name); if (i < 0) return false; crowd.active.add(i); crowd.target(i)!.stand = k; return true; },
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
    swap: () => { const h = sync.head!; const t = h.tower.slice(); [t[2], t[7]] = [t[7], t[2]]; tower.setOrder(t, h.stories, h.act, clock, camDir2(), h.people); },
  };
  document.getElementById('splash')!.classList.remove('show');   // recordings start inside
  arrive();
  (window as any).__ready = true;
} else {
  // Pacing: never more than 60 frames a second (a 120 Hz phone would draw everything twice), and 30 at a table on
  // a phone (lips follow a 30 Hz track; the rest moves slowly), which halves the GPU's work for a long listen.
  // If frames still come late, the resolution steps down a quarter at a time; with room to spare, back up.
  let last = performance.now(), lastDraw = 0, slow = 0, quick = 0, settle = 3;
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const gap = mode === 'table' && touch ? 1000 / 30 : 1000 / 60;
    if (now - lastDraw < gap - 4) return;
    const interval = now - lastDraw;
    lastDraw = now;
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    frame(dt);
    settle -= dt;
    if (settle > 0 || interval > 250) return;          // start-up, shader compiles, a backgrounded tab
    if (interval > gap * 1.45) { slow += dt; quick = 0; } else if (interval < gap * 1.15) { quick += dt; slow = 0; }
    if (slow > 2 && dpr > 1) { dpr = Math.max(1, dpr - 0.25); renderer.setPixelRatio(dpr); slow = 0; settle = 1.5; }
    else if (quick > 12 && dpr < DPR_CAP) { dpr = Math.min(DPR_CAP, dpr + 0.25); renderer.setPixelRatio(dpr); quick = 0; settle = 1.5; }
  });
  ui.splash(() => {
    audio.ensure();
    arrive();
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
