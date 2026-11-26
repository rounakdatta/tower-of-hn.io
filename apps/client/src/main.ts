// Tower of HN: Hacker News as a living tower.
import * as THREE from 'three/webgpu';
import { pass, screenUV, smoothstep, vec3, hash, float, uniform } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { LiveSync, type Floor, type Head } from './sync.ts';
import { AudioEngine } from './audio.ts';
import { buildSky, buildCity, buildSnow, Tower, uTime, uBeacon, uNeon, uNeonOf, floorY, FLOOR_H, R, TOWER_TOP } from './world.ts';
import { TowerCam } from './towercam.ts';
import { Interior, uLift, type TableSpot } from './interior.ts';
import { Room } from './room.ts';
import { Mixer } from './mixer.ts';
import { WalkCam, EYE } from './walk.ts';
import { Minimap } from './minimap.ts';
import { MOOD, moodOf, tableMood, rowOf } from './mood.ts';
import { you, Replies } from './you.ts';
import type { Reply, ReplyTarget, Landed } from './reply.ts';
import { Crowd, setTimeValue } from './people.ts';
import { Audience } from './audience.ts';
import { Stage } from './stage.ts';
import { Director } from './director.ts';
import { esc, hash32 } from './util.ts';
import { Rig } from './rig.ts';
import { UI } from './ui.ts';

const params = new URLSearchParams(location.search);
// development: towerd on its own port next to Vite; production: towerd serves this page, so the same origin
const DATA = params.get('data') ?? (import.meta.env.DEV ? `http://${location.hostname || 'localhost'}:8787/live/` : '/live/');
const recording = params.has('record');
const autopilot = (params.has('auto') || recording) && !params.has('manual');   // ?record&manual: recordings on foot
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
/** lite: no bloom, no shallow focus (a phone whose GPU can't keep up even at 1x gets these back as frame rate) */
const liteOut = color.mul(vignette).mul(warm);
let dofOn = false, lite = params.has('lite');
pipeline.outputNode = lite ? liteOut : plainOut;
/** shallow focus only at the table: film-like close-ups, no cost elsewhere */
function setDof(on: boolean) {
  if (on === dofOn) return;
  dofOn = on;
  pipeline.outputNode = lite ? liteOut : on ? dofOut : plainOut;
  pipeline.needsUpdate = true;
}
function goLite() {
  if (lite) return;
  lite = true;
  pipeline.outputNode = liteOut; pipeline.needsUpdate = true;
  console.info('render: lite (no bloom, no depth of field)');
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
audio.virtual = recording && !params.has('realaudio');   // ?realaudio: stepped frames, a real audio clock (to check the mix)
const sync = new LiveSync(DATA);
const rig = new Rig(camera);
const director = new Director(sync, audio, crowd, rig, ui);
director.pushChair = (c, k) => interior.pushChair(c, k);
// the room: one person per commenter, who walks between tables and in from the lift; every table near you talks
const room = new Room(crowd);
const mixer = new Mixer(sync, audio, crowd, room);
mixer.pushChair = (c, k) => interior.pushChair(c, k);
director.room = room; director.ambient = true;
// CROWD_V2 (head.play "crowd", or ?play=crowd): a room that fits any crowd: tables keep a few people at their front,
// everyone else stands in the audience (galleries above, if the floor needs them) and steps forward to speak
const audience = new Audience();
const stage = new Stage(crowd, audience, interior, room);
scene.add(audience.group);
stage.clock = () => clock;
director.galleries = () => interior.galleryCount;
const crowdV2 = () => sync.play('crowd');
const frustum = new THREE.Frustum(), projView = new THREE.Matrix4();
stage.seen = (p) => {
  projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(projView);
  return frustum.containsPoint(p) && p.distanceTo(camera.position) < 16;
};
room.spawn = (name, at, facing) => {
  // out of the lift, a step apart and a step in (the doorway is at the glass): several arriving together don't stand in
  // one spot, and nobody starts outside the room (`facing` points into it)
  const a = facing + ((hash32(name, 17) % 628) / 628 - 0.5) * Math.PI, r = 0.12 + (hash32(name, 19) % 100) / 400;
  at.x += Math.sin(a) * r; at.z += Math.cos(a) * r;
  const i = crowd.add(name, { pos: at, facing, seated: false });
  if (i >= 0) { uLift.value = 1; audio.sfx('ding'); }
  return i;
};

const cam = new TowerCam(camera, renderer.domElement);
const walk = new WalkCam(camera, renderer.domElement, scene);
walk.lens = (f) => rig.lens(f);
// what's in the way, refreshed in place (asked for every step: no new objects each frame)
const obstacleList: { x: number; z: number; r: number }[] = [];
walk.obstacles = () => {
  let n = 0;
  const put = (x: number, z: number, r: number) => { const o = (obstacleList[n++] ??= { x: 0, z: 0, r: 0 }); o.x = x; o.z = z; o.r = r; };
  for (const s of spots) if (!s.bar) put(s.pos.x, s.pos.z, s.radius + 0.42);
  for (const p of crowd.people) if (!p.hidden) put(p.pose.pos.x + (p.shove?.x ?? 0), p.pose.pos.z + (p.shove?.z ?? 0), 0.34);   // where they stand
  if (room.stage) for (let i = 0; i < audience.n; i++) { const pl = audience.places[i]; if (pl.level === 0 && audience.present(i)) put(pl.x, pl.z, 0.34); }
  obstacleList.length = n;
  return obstacleList;
};
walk.route = (a, b) => room.route(a, b);
// what walkers keep clear of besides people: the tables (their tops), and the lens (where you stand, or the camera at
// a table), so nobody walks through you or through the shot. Refreshed in place, as the obstacles above are.
const clearList: { x: number; z: number; r: number }[] = [];
crowd.keepClear = () => {                              // asked every frame anyone animates: no closure, no new objects
  let n = 0;
  for (const s of spots) {
    if (s.bar) continue;
    const o = (clearList[n++] ??= { x: 0, z: 0, r: 0 }); o.x = s.pos.x; o.z = s.pos.z; o.r = s.radius + 0.05;
  }
  if (mode !== 'tower') { const o = (clearList[n++] ??= { x: 0, z: 0, r: 0 }); o.x = camera.position.x; o.z = camera.position.z; o.r = 0.3; }
  // (CROWD_V2) the audience on the ground: walkers keep to the lanes, never through anyone standing in their place
  if (room.stage) for (let i = 0; i < audience.n; i++) {
    const pl = audience.places[i];
    if (pl.level !== 0 || !audience.present(i)) continue;
    const o = (clearList[n++] ??= { x: 0, z: 0, r: 0 }); o.x = pl.x; o.z = pl.z; o.r = 0.27;
  }
  if (clearList.length !== n) clearList.length = n;
  return clearList;
};
walk.onMove = () => {
  if (walkHint) { walkHint = false; localStorage.setItem('tohn-walk', '1'); if (!walk.locked) ui.hint(''); tapHint = false; }
  if (touch && !localStorage.getItem('tohn-stick')) { localStorage.setItem('tohn-stick', '1'); walk.ghost(false); }
};
walk.onUse = () => { const t = nearTable(); if (t) sit(t, true); };
// a click on someone or a table acts at once; a click on open floor takes the mouse (first person)
walk.capturable = (x, y) => !aimAt(x, y).kind;
walk.onLock = (locked) => {
  document.body.classList.toggle('fps', locked);
  if (locked) ui.profile(null);                          // back to the room: a card left open would sit under the dot
  if (mode !== 'floor') return;
  // captured: the keys, briefly (the label under the dot carries the rest); let go: nothing (they know now)
  ui.hint(locked ? 'WASD walk · E sit · Esc frees the mouse' : '');
  if (locked) { const at = clock; after(6, () => { if (walk.locked && clock - at >= 5.9) ui.hint(''); }); }
  if (!locked) ui.aim('');
};
// ---------------------------------------------------------------- replying, by voice (reply.ts, loaded the first time)
let reply: Reply | null = null;
let sheet: Promise<Reply> | null = null;
const replies = new Replies();
let pausedForReply = false;
function replySheet() {
  return sheet ??= import('./reply.ts').then(({ Reply }) => {
    const r = reply = new Reply();
    r.onListen = (on) => audio.duck(on);
    r.onOpen = (on) => {
      document.body.classList.toggle('reply-open', on);
      // seated: the table waits while you answer (you won't miss a word), and goes on when you're done
      if (on && mode === 'table' && !director.paused) { director.togglePause(); pausedForReply = true; syncPause(); }
      if (!on && pausedForReply) {
        pausedForReply = false;
        if (director.paused) director.togglePause();
        else if (audio.ctx?.state === 'suspended') audio.ctx.resume().catch(() => {});
        syncPause();
      }
      if (on) { walk.release(); ui.profile(null); }
      // whoever you're answering turns to you while you do
      const by = r.to?.by ?? replyingTo;
      if (by && on) { if (mode === 'table') director.glanceAt(by, camera.position, 900); else mixer.glanceAt(by, camera.position, 900); }
      if (by && !on) { director.glanceAt(by, camera.position, 0); mixer.glanceAt(by, camera.position, 0); }
      replyingTo = on ? by : '';
    };
    r.onLanded = (l) => replyLanded(l);
    return r;
  }).catch((e) => { sheet = null; throw e; });
}
let replyingTo = '';
/** your reply is on Hacker News (the sheet says so itself, if it's open on that comment) */
function replyLanded(l: Landed) {
  if (reply?.to?.id === l.parent) return;
  ui.toast(`Your reply to <b>${esc(l.to)}</b> is on Hacker News`, () => window.open(`https://news.ycombinator.com/item?id=${l.id}`, '_blank', 'noopener'));
}
// back with a reply handed to HN before a reload (a phone can drop this tab while you're there): keep watching for it
if (you.pending()) replySheet().then((r) => r.resume()).catch(() => {});
director.isMe = (n) => !!you.me && n === you.me;
director.onWho = (n, turn) => showProfile(n, turn);
function syncPause() { const b = document.getElementById('pause'); if (b) b.textContent = director.paused ? 'Play' : 'Pause'; }
/** Answer `by`: their comment at the table you're at, else at the nearest table they've spoken at, the latest. */
function replyTo(by: string, prefer?: number) {
  if (!activeFloor) return;
  const at = (mode === 'table' ? director.spot : nearTable()) ?? null;
  const theirs = (s: TableSpot) => s.table.turns.filter((u) => u.by === by);
  let id = prefer;
  if (!id) {
    const here = at ? theirs(at) : [];
    const pool = here.length ? here : spots.filter((s) => !s.bar).sort((a, b) => Math.hypot(a.pos.x - walk.pos.x, a.pos.z - walk.pos.z) - Math.hypot(b.pos.x - walk.pos.x, b.pos.z - walk.pos.z)).flatMap(theirs);
    id = pool.reduce((m, u) => Math.max(m, u.id), 0) || undefined;
  }
  if (!id) return;
  const t: ReplyTarget = { id, by, story: activeFloor.story.id, title: activeFloor.story.title };
  const u = spots.flatMap((s) => s.table.turns).find((x) => x.id === id);
  replySheet().then((r) => {
    r.show(t);
    if (u?.v) sync.sidecar(u.v[0]).then((side) => r.said(id, side.clips.map((c) => c.t).join(' '))).catch(() => {});
  }, () => ui.toast('Couldn’t open the reply sheet: check your connection'));
}
/** Seated: answer whoever is speaking (or spoke last). */
function replyHere() {
  if (mode !== 'table' || !director.spot) return;
  const line = director.line, turns = director.spot.table.turns, last = turns[Math.max(0, director.turnAt - 1)];
  const u = line?.turn ?? last;
  if (u) replyTo(u.by, u.id);
}
document.getElementById('answer')?.addEventListener('click', (e) => { e.stopPropagation(); replyHere(); });
if (!matchMedia('(hover: none)').matches) { const b = document.getElementById('answer'); if (b) b.innerHTML = 'Reply <kbd>R</kbd>'; }
// a reply to you somewhere else on Hacker News: a note (the floor you're on handles its own, below)
const heard = new Set<number>();
replies.onReply = (r) => {
  if (heard.has(r.id)) return;
  if (spots.some((s) => !s.bar && s.table.turns.some((u) => u.id === r.parent))) return;   // it'll walk in here (the floor announces it)
  heard.add(r.id);
  ui.toast(`<b>${esc(r.by)}</b> replied to you on Hacker News`, () => window.open(`https://news.ycombinator.com/item?id=${r.id}`, '_blank', 'noopener'));
};
replies.start(() => you.me);

// the floor at a glance: tap a table there to walk over
const map = new Minimap();
map.onPick = (s) => walkToTable(s);
map.onWalk = (x, z) => { if (walk.enabled) { chose = ui.chosen = true; walk.goTo(new THREE.Vector3(x, 0, z)); } };
/** Walk up to a table (from its sign, the map, or a tap on it): beside it, facing it. */
function walkToTable(s: TableSpot) {
  if (s.bar) { sit(s, true); return; }
  if (!walk.enabled) return;
  chose = ui.chosen = true;
  const p = standAt(s, walk.pos);
  walk.goTo(p, Math.atan2(s.pos.x - p.x, s.pos.z - p.z));
}
const HINT_TOUCH = 'Tap a sign to walk over';
const HINT_DESK = 'Click a sign to walk over · click the floor to look around';
let tapHint = false;
const HOME = { pos: new THREE.Vector3(96, 58, 128), target: new THREE.Vector3(0, TOWER_TOP * 0.5, 0) };
camera.position.copy(HOME.pos); camera.lookAt(HOME.target);

// ---------------------------------------------------------------- state
type Mode = 'tower' | 'floor' | 'table';
let mode: Mode = 'tower';
let entered = false;                     // past the splash: the tower is in your hands
const touch = matchMedia('(hover: none)').matches;
let clock = 0;
let activeStory = -1, activeFloor: Floor | null = null, roomY = 0, roomYaw = 0;
let spots: TableSpot[] = [];
let lastBlip = 0, deepLinked = false;
/** scene-clock timers: identical in live viewing and in deterministic recordings */
const timers: { at: number; fn: () => void }[] = [];
const after = (secs: number, fn: () => void) => timers.push({ at: clock + secs, fn });

const camDir2 = () => new THREE.Vector2(camera.position.x, camera.position.z).normalize();

sync.onHead = (h: Head, prev) => {
  tower.setOrder(h.tower, h.stories, h.act, clock, camDir2(), h.people, h.heat);
  cam.floors = h.tower.length;
  // the focus is a story, not a height: when the front page reorders, it follows its story
  const r = focusSid >= 0 ? h.tower.indexOf(focusSid) : -1;
  if (r >= 0 && r !== cam.rank) { cam.rank = r; cam.yTarget = floorY(r); }
  else if (r < 0 && cam.rank >= 0 && h.tower[cam.rank] !== undefined) focusSid = h.tower[cam.rank];
  if (cam.enabled) showFocus();
  const act = Object.values(h.act).reduce((a, b) => a + b, 0);
  ui.live(`${innerWidth < 380 ? '' : 'live · '}${act} new comments in 15 min`);   // a small phone: the green dot says live
  const talking = h.tower.reduce((n, id) => n + (h.stories[id]?.[2] ?? 0), 0);
  const st = document.getElementById('stats');
  if (st) st.textContent = `${h.tower.length} floors · ${talking.toLocaleString()} comments · ${act} landed in the last 15 minutes`;
  // a floor where voices are raised says so from the street, once (not the one in focus: its card already does)
  for (const [k, id] of h.tower.entries()) {
    if ((h.heat?.[id] ?? 0) < 0.4 || rowSeen.has(id)) continue;
    if (k === cam.rank && mode === 'tower') { rowSeen.add(id); continue; }
    if (towerNote(`<b>Floor ${k + 1}</b> is heated: voices are raised`, id)) rowSeen.add(id);
    break;
  }
  if (prev && mode !== 'tower' && activeStory >= 0 && !h.tower.includes(activeStory)) ui.hint('This story just left the front page.');
  // (CROWD_V2) the story's points went up while we're in its room: the hall nods along, out from the table we're with
  const up = room.stage && prev && activeStory >= 0 ? (h.stories[activeStory]?.[1] ?? 0) - (prev.stories[activeStory]?.[1] ?? 0) : 0;
  if (up > 0) {
    const at = mode === 'table' ? director.spot : mixer.focus;
    if (at && !at.bar) audience.react('nod', at.pos.x, at.pos.z, clock + 0.2, Math.min(1, 0.35 + up * 0.08));
  }
};
sync.onDelta = (d) => {
  if (d.turns?.length) {
    uBeacon.value = 1;
    for (const t of d.turns) tower.pulse(t.story);
    if (mode === 'tower' && clock - lastBlip > 1.2) { audio.sfx('blip'); lastBlip = clock; }
    // the window that just flashed, named: the first few times, so the flash and the blip mean something
    const t = d.turns[0], r = sync.head?.tower.indexOf(t.story) ?? -1;
    if (landed < 3 && r >= 0 && towerNote(`<b>${esc(t.turn.by)}</b> just commented on floor ${r + 1}`, t.story)) landed++;
  }
};
/** The tower's notes (a named landing, a heated floor): only outside, one at a time, never a stream. Tap to go. */
let towerNoteAt = -1e9, landed = 0;
const rowSeen = new Set<number>();
function towerNote(html: string, sid: number) {
  if (recording || mode !== 'tower' || !entered || arriving || leanBack || clock - towerNoteAt < 20 || $id('toast').classList.contains('show')) return false;   // never over a reply to you
  towerNoteAt = clock;
  ui.toast(html, () => { const r = sync.head?.tower.indexOf(sid) ?? -1; if (r >= 0 && mode === 'tower') cam.focus(r); });
  return true;
}
tower.onMove = () => { if (mode === 'tower') audio.sfx('rumble'); };

// ---------------------------------------------------------------- the tower: the floor in focus
let focusSid = -1;
const $id = (id: string) => document.getElementById(id)!;
let arriving = false;                    // the swoop down from the sky: the card and the rail wait until it lands
function showFocus() {
  const h = sync.head;
  if (!h || focusSid < 0 || mode !== 'tower') return;
  const s = h.stories[focusSid], rank = h.tower.indexOf(focusSid);
  if (!s || rank < 0) return;
  tower.setSelected(tower.slotOf.get(focusSid) ?? -1);
  $id('focus').classList.toggle('first', navHint);
  // while arriving, the card is filled but not shown, so the camera can frame for it and land without a jump
  ui.focusCard({ rank: rank + 1, title: s[0], url: s[4], score: s[1], comments: s[2], act: h.act[focusSid] ?? 0, people: h.people?.[focusSid], heat: h.heat?.[focusSid] }, () => enterFloor(focusSid, true, true), !arriving);
  frameCard();
  if (arriving) return;
  ui.elevator(h.tower.length, rank, h.tower.map((id) => h.act[id] ?? 0), (k) => cam.focus(k), h.tower.map((id) => h.people?.[id] ?? 0), h.tower.map((id) => h.heat?.[id] ?? 0));
}
/** The card covers the bottom of a phone: the floor in focus sits in the middle of what's left. Where the card
 *  sits at one side instead (a wide screen, a phone on its side), the tower stands clear of it on the other. */
function frameCard() {
  const box = $id('focus').getBoundingClientRect();
  const beside = box.width < innerWidth * 0.66;
  cam.lift = beside ? 0.03 : Math.max(0.03, Math.min(0.16, (innerHeight - box.top) / innerHeight / 2));
  cam.shift = !beside ? 0 : box.left < innerWidth * 0.3 ? 0.12 : -0.2;
}
cam.onFocus = (rank) => {
  const sid = sync.head?.tower[rank];
  if (sid === undefined) return;
  focusSid = sid;
  hush();
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
function warmSoon(sid: number) { clearTimeout(warmTimer); warmTimer = window.setTimeout(() => { prewarm(sid, 1); peek(sid); }, 650); }

// Voices through the glass: stop on a floor and someone inside is heard, muffled, before you go in ("Listen in" is
// literal). One line, from a clip prewarm fetches anyway, so it costs nothing; it stops when you move on or go in.
let preview: { stop(): void } | undefined, peekSeq = 0;
function hush() { peekSeq++; preview?.stop(); preview = undefined; }
async function peek(sid: number) {
  if (recording || !audio.live || document.hidden) return;
  const me = ++peekSeq;                  // a newer peek, or a hush, makes this one stand down
  const f = await sync.floor(sid).catch(() => null);
  const ready = f?.tables.filter((t) => t.turns.length >= 2 && t.turns[0].v).slice(0, 3) ?? [];
  const v = ready[Math.floor(Math.random() * ready.length)]?.turns[0].v;
  if (!v) return;
  try {
    const clip = (await sync.sidecar(v[0])).clips[0];
    const buf = clip && await audio.load(sync.url(clip.u));
    if (!buf || me !== peekSeq || mode !== 'tower' || focusSid !== sid || arriving || leanBack || document.hidden) return;
    preview?.stop();
    // straight ahead and still: the tower camera drifts round on its own, and a voice placed in the world would slide off
    preview = audio.murmur(buf, audio.now() + 0.1, null, 0.09);
  } catch { /* nothing voiced there yet: the glass stays quiet */ }
}
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

/** the floor whose glass is clearing as we fly in or out (-1: none) */
let doorSlot = -1;
/** they picked a table themselves (hands-free and deep links otherwise sit at the best one) */
let chose = false;
let walkHint = !localStorage.getItem('tohn-walk');
/**
 * Into a floor. The room is built before we leave (behind its glass), so nothing pops in: one unbroken flight
 * to the window, through glass that clears as we come close (people already talking inside), to where you'll
 * stand. Then you're on foot. `listen` is what they asked for (Listen in): the room is already talking.
 */
async function enterFloor(sid: number, push = false, listen = false) {
  void listen;
  hush();
  if (!sync.head) return;
  const rank = sync.head.tower.indexOf(sid);
  const floor = await sync.floor(sid);
  if (!floor || rank < 0) return;
  if (activeStory >= 0 && activeStory !== sid) sync.unwatch(activeStory);
  activeStory = sid; activeFloor = floor; focusSid = sid;
  roomY = floorY(rank) - FLOOR_H * 0.47;
  const slot = tower.slotOf.get(sid) ?? -1;
  prewarm(sid, 2);
  nav(`?story=${sid}`, push && mode === 'tower');
  mode = 'floor'; ui.mode('floor'); cam.enabled = false; walk.disable(); awake();
  ui.tip(null); ui.hint(''); ui.sitDown(null);
  const out = new THREE.Vector2(camera.position.x, camera.position.z).normalize();
  roomYaw = Math.atan2(out.x, out.y);           // the room's front (its tables) faces the way we came in
  interior.group.position.y = roomY; crowd.group.position.y = roomY; walk.roomY = roomY;
  interior.group.visible = true; interior.presence(0);
  const lay = interior.layout(floor, roomYaw, deepTable);
  spots = lay.spots;
  const v2 = crowdV2();
  room.stage = v2 ? stage : null; director.audience = v2 ? audience : null;
  crowd.set(v2 ? stage.trim(spots, lay.people) : lay.people);
  if (!v2) { audience.set([], []); interior.galleries(0); }
  room.reset(spots, interior.door);
  mixer.exclude = null;
  mixer.start(floor, spots);
  doorSlot = slot; tower.setDoor(slot, 0);
  ui.floorHeader({ rank: rank + 1, title: floor.story.title, id: floor.story.id, url: floor.story.url });
  const at = (r: number, h: number) => new THREE.Vector3(out.x * r, roomY + h, out.y * r);
  const centre = new THREE.Vector3(0, roomY + 1.05, 0);
  // where you'll stand: just in from the glass, clear of anyone (a head right in front of the lens is no welcome)
  const free = (q: THREE.Vector3) => crowd.people.every((pp) => pp.hidden || Math.hypot(pp.pose.pos.x - q.x, pp.pose.pos.z - q.z) > 0.75)
    && spots.every((sp) => sp.bar || Math.hypot(sp.pos.x - q.x, sp.pos.z - q.z) > sp.radius + 1.5);
  // (search near where we come in: a little either side along the glass, a little further in)
  let stand = at(R - 1.7, EYE);
  for (let k = 1; k < 30 && !free(stand); k++) {
    const a = roomYaw + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.12, r = R - 1.5 - (k % 3) * 0.45;
    stand = new THREE.Vector3(Math.sin(a) * r, roomY + EYE, Math.cos(a) * r);
  }
  // (CROWD_V2) everyone else on the floor takes their place in the hall, clear of where you land and of the bar and lift
  if (v2) stage.fill(floor, [...interior.keepClear(), { x: stand.x, z: stand.z, r: 1.35 }, { x: out.x * (R - 0.6), z: out.y * (R - 0.6), r: 1.2 }], roomY);
  rig.pos.copy(camera.position); rig.target.copy(cam.look);
  rig.matchLens(); rig.fovTarget = 56;                     // the flight starts with the lens as it is: no pop
  const far = camera.position.distanceTo(at(R + 14, 3.2));
  // evenly spaced and level on the way in: a long first leg made the spline dip a floor before the glass
  // through the middle of the windows (they run from 0.3 to 1.6 m), never the title sign above them
  rig.fly([camera.position.clone(), at(R + 14, 2.4), at(R + 5.5, 1.35), at(R + 1.6, 1.15), at(R - 0.4, 1.2), stand],
    [cam.look.clone(), new THREE.Vector3(0, roomY + 1.1, 0), new THREE.Vector3(0, roomY + 1.0, 0), centre, centre.clone(), centre.clone()],
    Math.max(2.6, Math.min(4.0, 2.0 + far / 26)), clock, () => {
      if (activeStory !== sid || mode !== 'floor') return;
      walk.begin(stand, Math.atan2(-stand.x, -stand.z));     // facing into the room
      const crowdN = v2 ? stage.people : sync.head?.people?.[sid] ?? 0;
      ui.card(`Floor ${rank + 1} · ${floor.story.comments.toLocaleString('en-US')} comments${crowdN > 1 ? ` · ${crowdN.toLocaleString('en-US')} people` : ''}`, floor.story.title);
      ui.tableLabels(spots, roomY, walkToTable, bestSpot(false));
      ui.showLabels(true); map.show(true);
      chose = ui.chosen = false;
      metNoted.clear(); lampLine.clear();
      const first = bestSpot(false);
      if (first && !first.bar) lampNow.set(first, [1, 0.42, 0.1, 1]);
      const empty = !spots.some((x) => !x.bar), remarks = spots.some((x) => x.bar);
      // nobody here yet (a story that's just gone up): say so, and lean back moves on down the tower. Otherwise, the
      // first time only: on a phone the ghost stick teaches walking and, a few seconds in, one line says how to go
      // somewhere; at a desk, one line, until the first walk or click
      if (empty) ui.hint(remarks ? 'Only one-liners so far: they’re at the bar' : 'Nobody’s talking on this floor yet: new comments walk in by the lift');
      else if (walkHint && !touch) ui.hint(HINT_DESK);
      else if (walkHint && touch) after(4, () => { if (mode === 'floor' && walkHint) { tapHint = true; ui.hint(HINT_TOUCH); after(8, () => { if (tapHint) { tapHint = false; ui.hint(''); } }); } });
      else ui.hint('');
      if (empty && leanBack) after(3, () => { if (mode === 'floor' && leanBack && sync.head) { const o = sync.head.tower; enterFloor(o[(o.indexOf(activeStory) + 1) % Math.min(o.length, 10)], true); } });
      if (touch && !localStorage.getItem('tohn-stick')) walk.ghost(true);
      if (leanBack || deepLinked) after(deepLinked ? 1.2 : 2.4, () => { if (mode === 'floor' && !chose) sit(bestSpot()); deepLinked = false; });
    });
  audio.sfx('whoosh');
  audio.setMode('floor');
  sync.watch(sid, (f) => {
    activeFloor = f;
    // the room keeps up with the floor (new turns, audio that just landed): a table you sit at next starts current
    for (const sp of spots) {
      if (sp.bar && sp.index < 0) continue;
      const k = f.tables.findIndex((t) => t.root === sp.table.root);
      if (k < 0) continue;
      const seated = mode === 'table' && director.spot === sp;
      if (seated) continue;
      if (!sp.bar) {
        // a comment that just landed on Hacker News: its author comes in by the lift (or over from their table)
        // and says it next, as they would in a real room
        const known = new Set(sp.table.turns.map((u) => u.id));
        for (const u of f.tables[k].turns) {
          if (known.has(u.id)) continue;
          mixer.breaking(sp, u);
          const me = you.me, parent = u.replyTo !== undefined ? f.tables[k].turns.find((x) => x.id === u.replyTo) : undefined;
          if (me && u.by === me) { mixer.spotlight(sp, u.id); ui.toast(`<b>That’s you</b>, walking in to say it`, () => walkToTable(sp)); continue; }
          if (me && parent?.by === me && !heard.has(u.id)) {
            // someone answered you: said next at its table, and brought to your ears wherever you are on the floor
            heard.add(u.id);
            mixer.spotlight(sp, u.id);
            ui.toast(`<b>${esc(u.by)}</b> replied to you`, () => walkToTable(sp));
            continue;
          }
          news(u.by);
        }
      }
      sp.table = f.tables[k]; sp.index = k;
    }
    if (mode === 'table' && !params.has('freeze')) director.refresh(f);     // ?freeze: a take that live HN can't rewrite mid-shot
    else if (mode === 'floor') ui.tableLabels(spots, roomY, walkToTable, bestSpot(false));
    if (mode === 'floor') prewarm(sid, 2);              // still standing here a minute on: keep the first words coming
  });
}

/** New comments on this floor, in a note: one at a time is news; a hot thread's flood is one note every 45 seconds
 *  ("X and 3 others just commented"), never a stack of them. */
let newsAt = 0, newsQ: string[] = [], newsDue = false, newsFloor = -1;
function news(by: string) {
  if (newsFloor !== activeStory) { newsQ = []; newsFloor = activeStory; }
  newsQ.push(by);
  if (newsDue) return;
  newsDue = true;
  after(Math.max(0.8, newsAt - clock), () => {
    newsDue = false; newsAt = clock + 45;
    const q = [...new Set(newsQ)]; newsQ = [];
    if (!q.length || mode === 'tower' || newsFloor !== activeStory) return;
    ui.toast(q.length === 1 ? `<b>${esc(q[0])}</b> just commented on Hacker News` : `<b>${esc(q[0])}</b> and ${q.length - 1} other${q.length > 2 ? 's' : ''} just commented`);
  });
}

let deepTable = Number(params.get('table') ?? 0);
let deepFrom = Number(params.get('from') ?? 0);
/** The table to start at: a deep link's, else the first lively one whose first words are ready (or soonest). */
function bestSpot(consume = true): TableSpot {
  const convo = spots.filter((s) => !s.bar);
  if (deepTable) { const d = spots.find((s) => s.table.root === deepTable); if (consume) deepTable = 0; if (d) return d; }
  return convo.find((s) => s.table.turns.filter((t) => t.v).length >= 2) ?? convo.find((s) => s.table.turns[0].v) ?? convo[0] ?? spots[0];
}

/** Where you stand at a table: at its edge, toward `from`, inside the glass. */
function standAt(sp: TableSpot, from: THREE.Vector3) {
  const away = new THREE.Vector3(from.x - sp.pos.x, 0, from.z - sp.pos.z);
  if (away.lengthSq() < 1e-4) away.set(sp.pos.x || 1, 0, sp.pos.z);
  away.normalize();
  const p = new THREE.Vector3(sp.pos.x + away.x * (sp.radius + 1.05), 0, sp.pos.z + away.z * (sp.radius + 1.05));
  const r = Math.hypot(p.x, p.z);
  if (r > R - 0.65) p.multiplyScalar((R - 0.65) / r);
  return p;
}

function sit(s: TableSpot | undefined, push = false) {
  if (!s || !activeFloor) return;
  const fromFloor = mode === 'floor';
  chose = true;
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
  // the table we leave (next table) goes back to the room where we left it; this one comes to the director from
  // where the room had got to: the conversation you were overhearing goes on
  if (mode === 'table' && director.spot && !director.spot.bar && director.spot !== s) mixer.handBack(director.spot, director.said);
  const from = s.bar ? 0 : mixer.take(s);
  mixer.exclude = s;
  if (walk.enabled) { rig.pos.copy(camera.position); rig.target.copy(walk.look); rig.matchLens(); walk.disable(); }
  walk.ghost(false);
  ui.aim('');
  ui.sitDown(null);
  mode = 'table'; ui.mode('table'); audio.setMode('table'); audio.sfx('sit'); ui.showLabels(false); map.show(false); awake();
  (window.requestIdleCallback ?? setTimeout)(() => replySheet().catch(() => {}));   // seated: the reply sheet, ready (it isn't in the first load)
  subLine = null; ui.subtitle(null);
  ui.flash(); setDof(true);
  nav(`?story=${activeFloor.story.id}&table=${s.table.root}`, fromFloor && depth === 1);
  media(activeFloor.story.title, s.table.turns[0]?.by);
  // (short: it shares the bottom with the seat's controls)
  ui.hint(touch ? '' : 'Esc stand up · Space pause · N next · R reply');
  director.others = spots.filter((x) => !x.bar && x !== s).map((x) => ({ pos: x.pos, turns: x.table.turns }));
  director.jumpTo = deepFrom; deepFrom = 0;
  director.skipIds = new Set((params.get('skip') ?? '').split(',').filter(Boolean).map(Number));
  director.start(activeFloor, s, roomY, clock, from);
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
    after(2.9, () => enterFloor(next));
  } else nextTable();
};
director.onNewReply = (by) => ui.toast(you.me && by === you.me ? '<b>That’s you</b>, by the lift: here it comes' : `<b>${esc(by)}</b> just replied on Hacker News`);

/** Up from the table and on your feet beside it, facing it: the room plays on, this table where you left it. */
function standUp() {
  leanBack = false;
  const sp = director.spot, said = director.said;
  director.stop(); setDof(false);
  if (sp && !sp.bar) mixer.handBack(sp, said);
  mixer.exclude = null;
  mode = 'floor'; ui.mode('floor'); audio.setMode('floor'); awake();
  ui.hint('');
  const c = sp?.pos ?? new THREE.Vector3(0, 0, 0);
  const p = standAt(sp ?? { pos: c, radius: 0.6 } as TableSpot, camera.position);
  const stand = new THREE.Vector3(p.x, roomY + EYE, p.z), look = new THREE.Vector3(c.x, roomY + 1.0, c.z);
  rig.pos.copy(camera.position);
  rig.fly([camera.position.clone(), camera.position.clone().lerp(stand, 0.5).setY(roomY + EYE), stand], [rig.target.clone(), look, look.clone()], 1.3, clock, () => {
    if (mode !== 'floor') return;
    walk.begin(stand, Math.atan2(c.x - stand.x, c.z - stand.z));
    ui.tableLabels(spots, roomY, walkToTable, bestSpot(false));
    ui.showLabels(true); map.show(true);
  });
}

/** Back out through the glass in front of you, still facing the room: the tower comes into view as you pull away,
 *  and the glass closes behind you before the room goes (frame() clears it once you're well out). */
function leaveFloor() {
  const look0 = walk.enabled ? walk.look.clone() : rig.target.clone();
  director.stop(); setDof(false); mixer.exclude = null;
  nav(location.pathname, false);
  const left = activeStory;
  if (activeStory >= 0) sync.unwatch(activeStory);
  activeStory = -1; activeFloor = null;
  mode = 'tower'; ui.mode('tower'); audio.setMode('tower'); awake();
  walk.disable(); walk.ghost(false); ui.aim('');
  ui.floorHeader(null); ui.clearLabels(); map.show(false); ui.hint(''); ui.sitDown(null); ui.profile(null);
  subLine = null; ui.subtitle(null);
  const r = Math.max(0, sync.head?.tower.indexOf(left) ?? cam.rank);
  focusSid = sync.head?.tower[r] ?? focusSid;
  if (tower.slotOf.has(left)) doorSlot = tower.slotOf.get(left)!;
  const p = camera.position.clone(), dir = new THREE.Vector3(p.x, 0, p.z);
  if (dir.lengthSq() < 0.25) dir.set(-Math.sin(walk.yaw), 0, -Math.cos(walk.yaw));
  dir.normalize();
  const { pos, look } = cam.poseAt(r, Math.atan2(dir.x, dir.z));
  const centre = new THREE.Vector3(0, roomY + 1.05, 0);
  rig.pos.copy(p); rig.target.copy(look0); rig.matchLens(); rig.fovTarget = 45;
  rig.fly([p, new THREE.Vector3(dir.x * (R - 0.3), roomY + 1.65, dir.z * (R - 0.3)), new THREE.Vector3(dir.x * (R + 6), roomY + 2.3, dir.z * (R + 6)), pos],
    [look0, centre, new THREE.Vector3(0, roomY + 1.2, 0), look], 2.8, clock, () => {
      if (mode !== 'tower') return;
      cam.resume(r);
      showFocus();
    });
  audio.sfx('whoosh');
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
  // (an Esc that gave the mouse back is only that: it doesn't also leave the floor)
  if (reply?.open) { if (e.key === 'Escape') reply.escape(); return; }      // typing a reply never drives the room
  if (e.key === 'Escape') { if (walk.locked || performance.now() - walk.unlockedAt < 500) return; if (mode === 'table') stepOut(1); else if (mode === 'floor') { leanBack = false; stepOut(1); } }
  else if (e.key === ' ' && mode === 'table') { e.preventDefault(); director.togglePause(); }
  else if ((e.key === 'n' || e.key === 'N') && mode === 'table') nextTable();
  else if (e.key === 'm' || e.key === 'M') audio.setMuted(!audio.muted);
  else if ((e.key === 'r' || e.key === 'R') && !e.metaKey && !e.ctrlKey && !e.altKey && !reply?.open && !(e.target as HTMLElement)?.closest?.('input, textarea')) {
    e.preventDefault();
    if (mode === 'table') replyHere();
    else if (mode === 'floor' && walk.locked) { const a = aimAt(innerWidth / 2, innerHeight / 2); const who = nameAt(a); if (who) replyTo(who); }
  }
  else if (mode === 'tower' && cam.enabled && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Enter') && document.activeElement?.id !== 'elevator') {
    e.preventDefault();
    if (e.key === 'Enter') { if (focusSid >= 0) enterFloor(focusSid, true, true); return; }
    cam.focus(cam.rank + (e.key === 'ArrowUp' ? -1 : 1));
  }
});

// hover (a mouse: touch has no hover, so a tap on the tower focuses first) and taps in the room
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
let hoverSlot = -1, downAt = 0, downXY = [0, 0], hoverAt = 0;
renderer.domElement.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || cam.dragging) return;
  ptr.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  if (mode === 'floor') {
    if (walk.locked || performance.now() - hoverAt < 50) return;   // captured: the dot aims instead; else 20 checks a second
    hoverAt = performance.now();
    // someone under the mouse: their name, and a click opens their card; a table: a click walks over; open floor:
    // a click takes the mouse (first person)
    const a = aimAt(e.clientX, e.clientY);
    renderer.domElement.style.cursor = a.kind ? 'pointer' : 'crosshair';
    ui.aim(nameAt(a) ?? '');
    const tag = document.getElementById('aim')!;
    if (nameAt(a)) { tag.style.left = `${e.clientX}px`; tag.style.top = `${e.clientY + 18}px`; }
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
// (looking round isn't choosing: only walking somewhere, a sign, the map or sitting down puts "start here" away)
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = performance.now(); downXY = [e.clientX, e.clientY]; });
// at a table, a tap on someone opens their card
renderer.domElement.addEventListener('pointerup', (e) => {
  if (mode !== 'table' || performance.now() - downAt > 400 || Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]) > 8) return;
  ptr.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  const i = crowd.pick(ray);
  if (i >= 0) showProfile(crowd.people[i].name);
  else if (room.stage) { const a = audience.pick(ray.ray); if (a >= 0) showProfile(audience.names[a]); }
});
const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hitPoint = new THREE.Vector3();
/** What's at a point on the screen: someone, a table, or the floor (and where). */
function aimAt(x: number, y: number): { kind: 'person'; i: number } | { kind: 'audience'; name: string } | { kind: 'table'; spot: TableSpot } | { kind: 'floor' | null; at?: THREE.Vector3 } {
  ptr.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  const i = crowd.pick(ray);
  if (i >= 0) return { kind: 'person', i };
  if (room.stage) { const a = audience.pick(ray.ray); if (a >= 0) return { kind: 'audience', name: audience.names[a] }; }
  const hit = ray.intersectObject(interior.tableMesh)[0];
  const sp = hit?.instanceId !== undefined ? spots.filter((x) => !x.bar)[hit.instanceId] : undefined;
  if (sp && (!hit || hit.distance < 14)) return { kind: 'table', spot: sp };
  floorPlane.constant = -roomY;
  return { kind: null, at: ray.ray.intersectPlane(floorPlane, hitPoint) ? hitPoint.clone() : undefined };
}
/** whoever is at a point on the screen (at a table, or in the audience), by name */
function nameAt(a: ReturnType<typeof aimAt>) { return a.kind === 'person' ? crowd.people[a.i].name : a.kind === 'audience' ? a.name : null; }
/** the table you're standing beside (close enough to sit), if any */
function nearTable() {
  let best: TableSpot | null = null, bd = 1.45;
  for (const s of spots) { if (s.bar) continue; const d = Math.hypot(s.pos.x - walk.pos.x, s.pos.z - walk.pos.z) - s.radius; if (d < bd) { bd = d; best = s; } }
  return best;
}
walk.onTap = (x, y) => {
  const a = aimAt(x, y);
  if (a.kind !== 'person') { chose = ui.chosen = true; if (tapHint) { tapHint = false; ui.hint(''); } }
  if (a.kind === 'person') { walk.release(); showProfile(crowd.people[a.i].name); return; }
  if (a.kind === 'audience') { walk.release(); showProfile(a.name); return; }
  if (a.kind === 'table') {
    if (nearTable() === a.spot) sit(a.spot, true);                              // already beside it: sit down
    else walkToTable(a.spot);
    return;
  }
  if (a.at) walk.goTo(a.at);
};

// ---------------------------------------------------------------- commenters: who they are
const profiles = new Map<string, Promise<unknown>>();
function showProfile(name: string, prefer?: number) {
  const here = spots.filter((s) => s.table.turns.some((t) => t.by === name));
  const said = here.reduce((n, s) => n + s.table.turns.filter((t) => t.by === name).length, 0);
  let p = profiles.get(name);
  if (!p) {
    // busy writing other cards: once more after a moment. Nothing at all: the card stays, without the summary
    const get = (again: boolean): Promise<unknown> => fetch(`/profile/${encodeURIComponent(name)}`)
      .then((r) => (r.ok ? r.json() : r.status === 503 && again ? new Promise((ok) => setTimeout(ok, 3000)).then(() => get(false)) : null))
      .catch(() => null);
    p = get(true);
    profiles.set(name, p);
    p.then((x) => { if (!x) profiles.delete(name); });
  }
  ui.meet(name);
  // the card leads somewhere: to their table (the nearest one they've spoken at), when that's not where you are
  const near = here.slice().sort((a, b) => Math.hypot(a.pos.x - walk.pos.x, a.pos.z - walk.pos.z) - Math.hypot(b.pos.x - walk.pos.x, b.pos.z - walk.pos.z))[0];
  const go = mode === 'floor' && near && nearTable() !== near ? () => walkToTable(near) : undefined;
  const answer = said ? () => replyTo(name, prefer) : undefined;
  ui.profile({ name, said, tables: here.length, go, reply: answer, data: null });
  p.then((data) => ui.profile({ name, said, tables: here.length, go, reply: answer, data: (data ?? {}) as never }, true));
}
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); showFocus(); });

/**
 * Compile the room's shaders (tables, people and their faces, the clearing glass) while the splash is up, out of
 * sight far below the city: the first flight into a floor would otherwise stall a phone right as it begins.
 */
async function warmShaders() {
  const vis = interior.group.visible;
  interior.group.position.y = crowd.group.position.y = -400; interior.group.visible = true;
  crowd.set([{ name: 'warm-up', pose: { pos: new THREE.Vector3(0, 0, 0), facing: 0, seated: true } }]);
  tower.setDoor(0, 0.5); tower.update(clock, 0);
  try { await renderer.compileAsync(scene, camera); } catch { /* then they compile on first use */ }
  if (mode === 'tower' && doorSlot < 0) {
    crowd.set([]); interior.group.visible = vis;
    tower.setDoor(-1); tower.update(clock, 0);
  }
}

// ---------------------------------------------------------------- the lock screen and control centre: what's playing
function media(title: string, by?: string) {
  const ms = navigator.mediaSession;
  if (!ms || recording || typeof MediaMetadata === 'undefined') return;
  ms.metadata = new MediaMetadata({ title, artist: by ? `${by} and others, on Tower of HN` : 'Tower of HN', album: 'Hacker News, live' });
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
// it catches when you come in, stutters, holds; now and then its orange "of" buzzes. Steady if motion is reduced.
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
const fwd = new THREE.Vector3(), focusAt = new THREE.Vector3();
let aimTick = 0, lampTick = 0, rowToastAt = 0;
let lastNear: TableSpot | null = null;
/** On foot, the table you're with is subtitled (as the one you sit at is): you can follow it, and see how it's said. */
let subLine: object | null = null;
function walkSubtitles() {
  const l = mixer.focus ? mixer.speaking(mixer.focus) : null;
  if (l === subLine) return;
  subLine = l;
  if (!l) { ui.subtitle(null); return; }
  const look = crowd.people[l.who]?.look;
  const to = l.clip.who === l.turn.by && l.turn.replyTo ? mixer.focus!.table.turns.find((u) => u.id === l.turn.replyTo)?.by : undefined;
  const name = l.clip.who, turn = l.turn;
  ui.subtitle({ name, to, text: l.clip.t, color: look ? `#${look.outfit.clone().lerp(new THREE.Color(1, 1, 1), 0.45).getHexString()}` : '#ff9a3c', emotion: l.side.emotion, stance: l.side.stance, intensity: l.side.intensity,
    you: !!you.me && name === you.me, onWho: () => showProfile(name, turn.by === name ? turn.id : undefined) });
}
/** Each table's lamp wears its mood: a hot line (a row, laughter) flares on its first frame and settles warm; quiet
 *  moods stay quiet (cool light pools badly in a warm room); a table's history is only a faint tint. A row breaking
 *  out across the room is heard (palms on a table) and gets a note; so does someone you've met, talking elsewhere. */
const lampNow = new Map<TableSpot, [number, number, number, number]>();
const lampLine = new Map<TableSpot, object | null>();
const HOT = new Set(['heated', 'tense', 'playful', 'upbeat']);
let noteAt = 0;
const metNoted = new Set<string>();
function lampMoods(dt: number) {
  let k = 0;
  for (const s of spots) {
    if (s.bar) continue;
    const line = mode === 'table' && director.spot === s ? director.line : mixer.speaking(s);
    const cur = lampNow.get(s) ?? [1, 0.9, 0.8, 0];
    let rgb: [number, number, number] = MOOD.calm.rgb, a = 0;
    const fresh = !!line && lampLine.get(s) !== line.turn;   // a new comment started here (per comment, not per clip)
    if (fresh && you.me && line!.turn.by === you.me) { cur[0] = 1; cur[1] = 0.42; cur[2] = 0.1; cur[3] = 0.95; }   // there you are
    if (line) {
      const m = moodOf(line.side.emotion, line.side.stance, line.side.intensity);
      if (m !== 'calm') {
        rgb = MOOD[m].rgb; a = HOT.has(m) ? 0.55 : 0.3;
        if (fresh && HOT.has(m)) { cur[0] = rgb[0]; cur[1] = rgb[1]; cur[2] = rgb[2]; cur[3] = 0.95; }
      }
      const away = mode === 'floor' && s !== mixer.focus, d = Math.hypot(s.pos.x - walk.pos.x, s.pos.z - walk.pos.z);
      if (fresh && away && m === 'heated' && (line.side.intensity ?? 0) >= 0.6) {
        if (d < 9) audio.sfxAt('thump', { x: s.pos.x, y: roomY + 0.76, z: s.pos.z }, audio.now() + 0.05);
        if (d > 2.5 && clock > rowToastAt && clock > noteAt) {
          rowToastAt = clock + 90; noteAt = clock + 20;
          const sp = s, row = rowOf(s.table.turns);
          ui.toast(row ? `<b>${esc(row[0])}</b> ⇄ <b>${esc(row[1])}</b> are going at it` : `<b>${esc(line.turn.by)}</b> is getting heated at a table nearby`, () => walkToTable(sp));
        }
      } else if (fresh && away && d > 2.5 && ui.met.has(line.turn.by) && !metNoted.has(line.turn.by) && clock > noteAt) {
        metNoted.add(line.turn.by); noteAt = clock + 20;
        const sp = s;
        ui.toast(`<b>${esc(line.turn.by)}</b> is talking at a table nearby (you met them)`, () => walkToTable(sp));
      }
    } else { const m = tableMood(s.table.turns).mood; if (m !== 'calm') { rgb = MOOD[m].rgb; a = 0.15; } }
    lampLine.set(s, line ? line.turn : null);
    const e = Math.min(1, dt * 2.5);
    for (let c = 0; c < 3; c++) cur[c] += (rgb[c] - cur[c]) * e;
    cur[3] += (a - cur[3]) * e;
    lampNow.set(s, cur);
    interior.lampMood(k++, cur[0], cur[1], cur[2], cur[3]);
  }
}
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
  sync.relaxed = mode === 'tower'; sync.listening = mode === 'table';
  if (mode === 'tower' && (cam.enabled || !entered)) { cam.update(dt); tower.faceYaw = cam.theta; }
  else if (mode === 'floor' && walk.enabled) walk.update(dt);
  else rig.update(clock, dt);
  if (activeFloor || doorSlot >= 0) { camera.getWorldDirection(fwd); mixer.update(camera.position, fwd, dt); }
  uLift.value = Math.max(0, uLift.value - dt * 0.45);
  // the floor we fly into (or out of): its glass clears as we come close; inside, there is no slab at all; well
  // out again, behind closed glass, the room goes
  if (doorSlot >= 0) {
    const p = camera.position, rad = Math.hypot(p.x, p.z) - R;
    // inside: within the glass, and between this floor and the top of its hall (a floor with galleries rises through
    // the floors above it)
    const top = interior.galleryCount ? interior.hallTop() : FLOOR_H * 0.8 + 1.2;
    if (rad < -0.1 && p.y > roomY + 1.2 - FLOOR_H * 0.8 && p.y < roomY + top) { tower.hidden = doorSlot; tower.inside = interior.galleryCount > 0; interior.presence(1); }
    else {
      tower.hidden = -1; tower.inside = false;
      const k = Math.max(0, Math.min(1, (9 - rad) / 7.5));
      tower.setDoor(doorSlot, k * k * (3 - 2 * k));
      interior.presence(Math.max(0, Math.min(1, (12 - rad) / 9)));
      if (mode === 'tower' && rad > 11) {
        tower.setDoor(-1); doorSlot = -1;
        interior.group.visible = false; crowd.set([]); mixer.stop(); spots = [];
        audience.set([], []); interior.galleries(0); room.stage = null; director.audience = null;
      }
    }
  }
  // on foot beside a table: offer to sit down there
  if (mode === 'floor' && walk.enabled) {
    const here = nearTable();
    if (here && here !== lastNear) mixer.greet(here, camera.position);                     // they notice you
    lastNear = here;
    const t = walk.walking ? null : here;
    ui.sitDown(t ? { name: t.table.turns[0]?.by ?? '', go: () => sit(t, true), key: !touch } : null);
    ui.signs(walk.pos, mixer.focus, (s) => mixer.speaking(s));
    walkSubtitles();
    map.draw(clock, spots, walk.pos, walk.yaw, { focus: mixer.focus, talking: (s) => !!mixer.speaking(s), people: room.stage ? crowd.people.filter((p) => !p.hidden) : crowd.people, door: interior.door, lift: uLift.value });
    // first person at a desk: what the dot in the middle is on, and what a click would do
    if (walk.locked && ++aimTick % 6 === 0) {
      const a = aimAt(innerWidth / 2, innerHeight / 2);
      ui.aim(nameAt(a) ? `${nameAt(a)} · click to meet them · R to reply` : a.kind === 'table' ? (nearTable() === a.spot ? 'Click or E to sit down' : 'Click to walk over') : '');
    }
  } else if (mode === 'floor') ui.sitDown(null);
  neonTick(clock);
  if ((mode === 'floor' || mode === 'table') && ++lampTick % 4 === 0) lampMoods(dt * 4);
  director.update(clock, dt);
  crowd.update(dt);
  if (room.stage && interior.group.visible) {
    stage.tidy(audio.now());
    // on foot, heads turn to whoever is speaking at the table you're with (seated, the director says who)
    if (mode === 'floor' && mixer.focus) { const l = mixer.speaking(mixer.focus); if (l && l.who >= 0) audience.focus(crowd.headPos(l.who, focusAt), clock); }
    audience.update(camera, clock, dt);
  }
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
/** Inside: the sign lights, the camera comes down to the top floor, and (first visit) how to move is shown. */
function arrive() {
  entered = true;
  neon.at = clock;
  towerNoteAt = clock - 12;                   // the tower's first note waits until you've had a look
  $id('fhint').textContent = touch ? 'or drag the tower to change floors' : 'or scroll to change floors';
  // the door opens, the camera comes down and the sign catches; then the card rises, and the floor speaks
  arriving = true;
  cam.arrive(0);
  const land = () => { if (!arriving) return; arriving = false; showFocus(); peek(focusSid); };
  after(1.6, land);
  if (!recording) setTimeout(land, 2600);   // slow first frames (shaders compiling) never hold the card back for long
}
// ?probe: decode one clip exactly as playback does, and describe it (tests the native and the WebAssembly Opus paths)
if (params.has('probe')) (window as any).__probe = async (url: string) => {
  audio.ensure();
  const b = await audio.load(url);
  let peak = 0;
  for (const x of b.getChannelData(0)) peak = Math.max(peak, Math.abs(x));
  return { seconds: b.duration, rate: b.sampleRate, channels: b.numberOfChannels, peak };
};
// ?debug: a few handles on the live page (real audio, real time), for checking the room's mix
if (params.has('debug')) (window as any).__dbg = {
  enter: (rank: number) => enterFloor(sync.head!.tower[rank]),
  mix: () => ({ focus: mixer.focus ? spots.filter((x) => !x.bar).indexOf(mixer.focus) : -1, levels: mixer.levels(), mode, ctx: audio.ctx?.state }),
  tables: () => spots.filter((sp) => !sp.bar).map((sp, k) => ({ k, x: sp.pos.x, z: sp.pos.z })),
  walkTo: (x: number, z: number) => walk.goTo(new THREE.Vector3(x, 0, z)),
  lookAt: (x: number, z: number) => { walk.yaw = Math.atan2(x - walk.pos.x, z - walk.pos.z); },
  sit: () => sit(bestSpot()),
  peeking: () => !!preview,
};
if (recording) {
  (window as any).__tohn = {
    frame: (dt: number, draw = true) => frame(dt, draw),
    enter: (rank: number) => enterFloor(sync.head!.tower[rank]),
    orbit: (a: number, r = 150, _h = 62, ty?: number) => { cam.theta = a; cam.d = cam.dTarget = r; cam.y = cam.yTarget = ty ?? TOWER_TOP * 0.5; },
    focus: (rank: number) => cam.focus(rank),
    leave: () => leaveFloor(),
    walkTo: (x: number, z: number) => walk.goTo(new THREE.Vector3(x, 0, z)),
    /** debug: call someone (or a stranger, who comes by lift) over to the k-th table */
    callOver: (name: string, k: number) => room.callOver(name, spots.filter((sp) => !sp.bar)[k], audio.now()),
    tables: () => spots.filter((sp) => !sp.bar).map((sp, k) => ({ k, x: +sp.pos.x.toFixed(2), z: +sp.pos.z.toFixed(2), people: sp.seats.map((st) => st.name) })),
    lookAt: (x: number, z: number) => { walk.yaw = Math.atan2(x - walk.pos.x, z - walk.pos.z); },
    ensureAudio: () => audio.ensure(),
    /** what a frame costs the GPU: draw calls, triangles, and what's held */
    info: () => { const i = (renderer as unknown as { info: { render: Record<string, number>; memory: Record<string, number> } }).info; return { render: { ...i.render }, memory: { ...i.memory }, dpr: renderer.getPixelRatio(), audioRate: audio.ctx?.sampleRate ?? 0, lite }; },
    /** replying: seated, to whoever is speaking; or to someone by name */
    replyHere: () => replyHere(),
    replyTo: (name: string) => replyTo(name),
    setMe: (name: string) => you.set(name),
    /** a reply to you landing at the k-th table: brought to your ears wherever you stand */
    spotlight: (k: number) => { const sp = spots.filter((x) => !x.bar)[k]; const u = sp?.table.turns.find((x) => !x.v) ?? sp?.table.turns[0]; if (sp && u) mixer.spotlight(sp, u.id); },
    where: () => ({ x: +walk.pos.x.toFixed(2), z: +walk.pos.z.toFixed(2), yaw: +walk.yaw.toFixed(2), walking: walk.walking, locked: walk.locked, aim: document.getElementById('aim')?.textContent ?? '' }),
    towerDebug: () => ({ roomY, doorSlot, hidden: tower.hidden, cam: camera.position.toArray().map((v) => +v.toFixed(2)),
      slots: tower.slots.map((sl, i) => ({ i, sid: sl.sid, rank: sync.head?.tower.indexOf(sl.sid ?? -1), y: +sl.y.toFixed(2), label: (tower as unknown as { drawn: string[] }).drawn[i] })).filter((x) => x.rank !== undefined && x.rank >= 0 && x.rank < 5) }),
    standUp: () => standUp(),
    sit: () => sit(bestSpot()),
    profile: (name: string) => showProfile(name),
    people: () => crowd.people.map((p, i) => { const e = crowd.extent(i)!; return { i, name: p.name, x: p.pose.pos.x + e.shoveX, z: p.pose.pos.z + e.shoveZ, walking: crowd.isWalking(i), body: e.body, head: e.head, hidden: !!p.hidden }; }).filter((p) => !p.hidden),
    /** for timing the crowd's own work (record mode only) */
    crowd,
    /** debug: the lens anywhere (room space: y from the floor), looking at a point, with a field of view */
    lens: (x: number, y: number, z: number, tx: number, ty: number, tz: number, fov = 50) => { rig.cut(new THREE.Vector3(x, roomY + y, z), new THREE.Vector3(tx, roomY + ty, tz), 0); rig.fovTarget = fov; },
    /** a plan of the room from above (for checks): tables, the people at them, the audience on the ground, the lens */
    plan: () => ({ R, tables: spots.filter((s) => !s.bar).map((s) => [+s.pos.x.toFixed(2), +s.pos.z.toFixed(2), +s.radius.toFixed(2)]),
      crowd: crowd.people.map((p, i) => [+(p.pose.pos.x + (p.shove?.x ?? 0)).toFixed(2), +(p.pose.pos.z + (p.shove?.z ?? 0)).toFixed(2), p.pose.seated ? 1 : 0, crowd.isWalking(i) ? 1 : 0, p.hidden ? 1 : 0, +(crowd.extent(i)?.body ?? 0.2).toFixed(2)]),
      audience: audience.places.map((p, i) => [+p.x.toFixed(2), +p.z.toFixed(2), p.level, audience.present(i) ? 1 : 0]),
      cam: [+camera.position.x.toFixed(2), +(camera.position.y - roomY).toFixed(2), +camera.position.z.toFixed(2)], target: [+rig.target.x.toFixed(2), +rig.target.z.toFixed(2)], galleries: interior.galleryCount }),
    /** (CROWD_V2) the hall: galleries, everyone on the floor, the audience, how many are drawn at each level of detail */
    hall: () => ({ on: !!room.stage, tiers: interior.galleryCount, people: stage.people, audience: audience.n, drawn: audience.drawn(),
      present: Array.from({ length: audience.n }, (_, i) => audience.present(i)).filter(Boolean).length,
      crowd: crowd.people.filter((p) => !p.hidden).length, slots: crowd.people.length,
      triangles: { audience: audience.triangles(), crowd: crowd.triangles() } }),
    fov: () => camera.fov,
    /** who is acting right now (anyone the crowd is animating), and how far: stand, arms, lean, mouth */
    acting: () => [...crowd.active].map((i) => { const p = crowd.people[i], e = p?.expr; return e ? { name: p.name, stand: +e.stand.toFixed(2), armR: +e.armR.toFixed(2), armL: +e.armL.toFixed(2), lean: +e.lean.toFixed(2), open: +e.open.toFixed(2), smile: +e.smile.toFixed(2), flush: +e.flush.toFixed(2) } : null; }).filter(Boolean),
    /** the table you're with (heard clearly), and what each nearby table is saying */
    plans: () => mixer.plans(),
    mix: () => ({ levels: mixer.levels(), focus: mixer.focus ? spots.filter((x) => !x.bar).indexOf(mixer.focus) : -1, speaking: spots.filter((x) => !x.bar).map((sp, k) => { const l = mixer.speaking(sp); return l ? { k, by: l.turn.by, who: l.who, emotion: l.side.emotion } : null; }).filter(Boolean) }),
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
    swap: () => { const h = sync.head!; const t = h.tower.slice(); [t[2], t[7]] = [t[7], t[2]]; tower.setOrder(t, h.stories, h.act, clock, camDir2(), h.people, h.heat); },
  };
  document.getElementById('splash')!.classList.remove('show');   // recordings start inside
  document.body.classList.remove('door');
  arrive();
  (window as any).__ready = true;
} else {
  // Pacing: never more than 60 frames a second (a 120 Hz phone would draw everything twice), and 30 at a table on
  // a phone (lips follow a 30 Hz track; the rest moves slowly), which halves the GPU's work for a long listen.
  // If frames still come late, the resolution steps down a quarter at a time; with room to spare, back up.
  let last = performance.now(), lastDraw = 0, slow = 0, quick = 0, settle = 3, ceil = Infinity;
  // a pixel ratio that was too slow once isn't tried again (no flicking back and forth, no reallocating targets)
  const to = (r: number) => { if (r < dpr) ceil = Math.min(ceil, dpr); dpr = r; renderer.setPixelRatio(dpr); slow = quick = 0; settle = 1.5; };
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    // a phone standing still on a floor needs no more than a table does (mouths move at 30 Hz): 60 only while moving
    const gap = touch && (mode === 'table' || (mode === 'floor' && walk.enabled && !walk.busy)) ? 1000 / 30 : 1000 / 60;
    if (now - lastDraw < gap - 4) return;
    const interval = now - lastDraw;
    lastDraw = now;
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    frame(dt);
    settle -= dt;
    if (settle > 0 || interval > 250) return;          // start-up, shader compiles, a backgrounded tab
    if (interval > gap * 1.45) { slow += dt; quick = 0; } else if (interval < gap * 1.15) { quick += dt; slow = 0; }
    if (slow > 2 && dpr > 1) to(Math.max(1, dpr - 0.25));
    // still slow at 1x: the post effects go, then a little resolution
    else if (slow > 3 && !lite) { goLite(); slow = 0; settle = 1.5; }
    else if (slow > 3 && lite && dpr > 0.75) to(0.75);
    else if (quick > 12 && dpr + 0.25 < ceil && dpr < (lite ? 1 : DPR_CAP)) to(Math.min(lite ? 1 : DPR_CAP, dpr + 0.25));
  });
  warmShaders();
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
