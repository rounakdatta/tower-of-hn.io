// People: soft vinyl-toy characters, one per HN user, assembled from their name.
// Faces are drawn per pixel by the shader from a few numbers (eyes, lids, brows,
// mouth open/shape/smile), so a face costs nothing and reads at any distance.
// Every body part is one instanced draw; per-frame CPU work only touches people
// who are speaking or reacting.
import * as THREE from 'three/webgpu';
import {
  instancedBufferAttribute, normalLocal, positionLocal, vec2, vec3, float, mix, smoothstep, length, min, max, clamp,
  step, fract, abs, sin, mx_noise_float, instanceIndex, output, dot, vec4, textureLoad, ivec2, int, varying,
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rngFor, pick, SKIN, OUTFIT, HAIR, hash32 } from './util.ts';
import { uTime, R } from './world.ts';
import { faceColor } from './face.ts';

export const MAX_PEOPLE = 220;
const HAIR_STYLES = 6;             // 0 bald (no mesh) .. 5

export interface Look {
  skin: THREE.Color; outfit: THREE.Color; hair: THREE.Color; style: number; glasses: boolean; beard: boolean;
  height: number; width: number; eye: number; gap: number; brow: number; mouth: number; phase: number; hood: boolean;
}

export function lookOf(name: string): Look {
  const r = rngFor(name);
  const style = Math.floor(r() * HAIR_STYLES);
  return {
    skin: new THREE.Color(pick(r, SKIN)), outfit: new THREE.Color(pick(r, OUTFIT)),
    hair: new THREE.Color(r() < 0.06 ? pick(r, ['#3a2a4f', '#2b5e63', '#7a2f3a']) : pick(r, HAIR.slice(0, 9))),
    style, glasses: r() < 0.36, beard: r() < 0.15,
    height: 0.93 + r() * 0.14, width: 0.9 + r() * 0.22,
    eye: 0.86 + r() * 0.34, gap: 0.86 + r() * 0.26, brow: 0.8 + r() * 0.6, mouth: 0.85 + r() * 0.35, phase: r(),
    hood: r() < 0.32,                // appended last: never reshuffle existing looks
  };
}

export interface Pose {
  pos: THREE.Vector3; facing: number; seated: boolean;
}

/** Live expression of one person, eased toward targets every frame. */
export interface Expr {
  open: number; shape: number; brow: number; smile: number; lid: number;                // face
  /** inner brow ends: + up (worried, sad), - down (cross); one brow raised (+ left, - right); a smirk (+ left up) */
  browIn: number; browAsym: number; smileAsym: number;
  /** eyes that close into smiling arcs; upper lids slanted in anger; faster blinking (nerves) */
  happy: number; lidTilt: number; blinkRate: number;
  /** cheeks; teeth in an open mouth (a grin, a snarl); a face going red */
  blush: number; teeth: number; flush: number;
  yaw: number; nod: number; tilt: number;                                                // head
  lean: number; turn: number; stand: number; bounce: number;                             // body
  gaze: number; gazeY: number;                                                           // eyes (-1..1)
  armL: number; armR: number; spreadL: number; spreadR: number; aimR: number;           // arms
}
export const NEUTRAL: Expr = {
  open: 0, shape: 0, brow: 0, smile: 0.15, lid: 1, browIn: 0, browAsym: 0, smileAsym: 0, happy: 0, lidTilt: 0, blinkRate: 0, blush: 0, teeth: 0, flush: 0,
  yaw: 0, nod: 0, tilt: 0, lean: 0, turn: 0, stand: 0, bounce: 0, gaze: 0, gazeY: 0, armL: 0, armR: 0, spreadL: 0, spreadR: 0, aimR: 0,
};
const STAND_TALL = 2.5;           // a standing body vs a seated one (the chair hides the legs)

/** Someone on their way across the room: the points ahead of them, and what to do on arrival. Their numbers that
 *  change every frame live in `n` (a Float64Array: plain object fields holding fractions get re-boxed on every write
 *  in V8, which made garbage each frame): pace (eased: people speed up and slow down), stride, progress toward the
 *  next point (to notice a blocked way), where this frame's step started (NaN: not stepping), and which way round
 *  things they go (1: the other way, after being held up). */
interface Walk { path: THREE.Vector3[]; speed: number; face: number; onArrive?: () => void; n: Float64Array }
const W_V = 0, W_STRIDE = 1, W_BEST = 2, W_STUCK = 3, W_X0 = 4, W_Z0 = 5, W_SIDE = 6;
interface Person {
  name: string; look: Look; pose: Pose; parts: { hair: number; glasses: number; beard: number; hood: number }; expr: Expr; target: Expr; walk?: Walk; fade?: number;
  /** a standing person stepped aside to let someone squeeze past (room space, metres); it eases back to nothing */
  shove?: { x: number; z: number };
  /** not in the room just now (CROWD_V2: back at their place in the audience, drawn there): drawn as nothing, in nobody's
   *  way, their slot kept for when they come forward again */
  hidden?: boolean;
}

/** How far each hair style reaches from the head's centre, sideways (the head itself is 0.2 m): what a head needs. */
const HEAD_ROOM = [0.2, 0.215, 0.216, 0.215, 0.23, 0.245];
const headRoom = (p: Person) => HEAD_ROOM[p.look.style] ?? 0.215;
/** How much of the floor someone's body takes (a disc): their shoulders, and a chair behind them if they're seated. */
const bodyRoom = (p: Person) => 0.215 * p.look.width + (p.pose.seated ? 0.06 : 0);
/** What a walker steers round: the wider of body and head. */
function roomOf(p: Person) { return Math.max(bodyRoom(p), headRoom(p)); }
const SHOVE_MAX = 0.25;           // how far someone standing steps aside for a passer-by
/** lengths without Math.hypot: it's a variadic built-in that optimised code doesn't inline, so every call boxed its
 *  numbers into garbage (thousands a frame here); these compile to a few multiplies and one sqrt */
const len = (x: number, z: number) => Math.sqrt(x * x + z * z);
const S_X = 0, S_Z = 1, S_ME = 2, S_WX = 3, S_WZ = 4, S_VX = 5, S_VZ = 6, S_EASE = 7, S_SIDE = 8;   // a walker's steering, in Crowd.sv
const len3 = (x: number, y: number, z: number) => Math.sqrt(x * x + y * y + z * z);

function headGeo() { return new THREE.SphereGeometry(0.2, 28, 18); }

/**
 * Skin has a shoulder, like film: brightness above a knee rolls off instead of clipping. A face close under a
 * table lamp (someone standing up) stays a face; faces in ordinary light never reach the knee.
 */
function skinRolloff() {
  // measured: lit faces at a table sit at 0.25–0.5 (linear luminance); standing under a lamp doubles that
  const c = output.rgb, l = dot(c, vec3(0.2126, 0.7152, 0.0722)).max(1e-4);
  const over = l.sub(0.45).max(0);
  const rolled = over.div(over.mul(3).add(1)).add(min(l, 0.45));
  return vec4(c.mul(rolled.div(l)), output.a);
}

function hairGeos(): THREE.BufferGeometry[] {
  const cap = (r: number, theta: number) => new THREE.SphereGeometry(r, 24, 12, 0, Math.PI * 2, 0, theta);
  const short = cap(0.213, 1.12);
  const long = mergeGeometries([cap(0.214, 1.3), (() => { const g = new THREE.CylinderGeometry(0.2, 0.17, 0.3, 24, 1, true, Math.PI * 0.62, Math.PI * 0.76); g.translate(0, -0.12, 0); return g; })()]);
  const bun = mergeGeometries([cap(0.213, 1.12), (() => { const g = new THREE.SphereGeometry(0.085, 12, 8); g.translate(0, 0.17, -0.12); return g; })()]);
  const beanie = mergeGeometries([cap(0.222, 1.05), (() => { const g = new THREE.TorusGeometry(0.2, 0.028, 8, 24); g.rotateX(Math.PI / 2); g.translate(0, 0.095, 0); return g; })(),
    (() => { const g = new THREE.SphereGeometry(0.045, 8, 6); g.translate(0, 0.235, 0); return g; })()]);
  // curly: a closed, round volume set up and back, so its front edge sits above the brows (eyes always show)
  const curly = (() => { const g = new THREE.SphereGeometry(0.25, 22, 14); g.translate(0, 0.095, -0.07); return g; })();
  const placeholder = new THREE.BoxGeometry(0.001, 0.001, 0.001);
  return [placeholder, short, long, bun, beanie, curly];
}

function glassesGeo() {
  const ring = (x: number) => { const g = new THREE.TorusGeometry(0.052, 0.009, 6, 16); g.translate(x, 0.035, 0.192); return g; };
  const bridge = new THREE.CylinderGeometry(0.006, 0.006, 0.05, 6); bridge.rotateZ(Math.PI / 2); bridge.translate(0, 0.045, 0.2);
  return mergeGeometries([ring(-0.062), ring(0.062), bridge]);
}

function beardGeo() {
  const g = new THREE.SphereGeometry(0.207, 24, 12, Math.PI * 0.05, Math.PI * 0.9, Math.PI * 0.52, Math.PI * 0.4);
  g.rotateY(-Math.PI / 2 + Math.PI * 0.5);
  return g;
}

function torsoGeo() {
  const pts = [[0, 0], [0.15, 0], [0.205, 0.07], [0.215, 0.2], [0.205, 0.34], [0.18, 0.44], [0.12, 0.51], [0.05, 0.535], [0, 0.54]]
    .map(([x, y]) => new THREE.Vector2(x, y));
  return new THREE.LatheGeometry(pts, 24);
}

function armGeo() {
  const g = new THREE.CapsuleGeometry(0.046, 0.22, 4, 10);
  g.translate(0, -0.155, 0);        // pivot at the shoulder
  return g;
}

export class Crowd {
  group = new THREE.Group();
  people: Person[] = [];
  private bodies: THREE.InstancedMesh;
  private heads: THREE.InstancedMesh;
  private arms: THREE.InstancedMesh;
  private hair: THREE.InstancedMesh[] = [];
  private glasses: THREE.InstancedMesh;
  private beards: THREE.InstancedMesh;
  private hands: THREE.InstancedMesh;
  private hoods: THREE.InstancedMesh;
  // what a face is doing, a row of four RGBA texels per person, read by instance index: as many channels as a face
  // needs, without spending WebGPU's eight vertex buffers (see writeExpr for the layout)
  private exprData = new Float32Array(MAX_PEOPLE * 16);
  private exprTex = new THREE.DataTexture(this.exprData, 4, MAX_PEOPLE, THREE.RGBAFormat, THREE.FloatType);
  /** static: eye size, eye gap, brow thickness, mouth width */
  private aFace = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PEOPLE * 4), 4);
  // packed to stay under WebGPU's 8 vertex buffers: skin rgb, hair rgb + phase (+2 if bearded)
  private aSkinL = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PEOPLE * 4), 4);
  private aHairP = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PEOPLE * 4), 4);
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private hand = new THREE.Vector3();
  active = new Set<number>();          // people whose transforms update every frame
  /** standing people stepped aside for a passer-by, easing back (placed every frame until they're home) */
  private shoved = new Set<number>();
  /** what walkers keep clear of besides people (the tables, the lens), room space; refreshed in place */
  keepClear: () => { x: number; z: number; r: number }[] = () => [];
  /**
   * Who is near whom, without asking everyone: people bucketed in 1 m cells once a frame (only in a frame that needs
   * it), as linked lists in typed arrays: no garbage at all. Anyone a check cares about (a metre at most) is in the
   * 3x3 cells round it. The floor is 2R across: GRID cells a side, the edges clamped.
   */
  private static readonly GRID = 2 * R + 4;
  private cellHead = new Int32Array(Crowd.GRID * Crowd.GRID).fill(-1);
  private cellNext = new Int32Array(MAX_PEOPLE).fill(-1);
  // fixed buffers and counts, never `length = 0` (that drops an array's storage in V8, and every push regrows it)
  private nearby = new Int32Array(MAX_PEOPLE);
  private nearbyN = 0;
  private near2 = new Int32Array(MAX_PEOPLE);
  private walkers = new Int32Array(MAX_PEOPLE);
  private frameNo = 0;
  private gridFrame = -1;
  private static cellAt(v: number) { const c = Math.floor(v) + Crowd.GRID / 2; return c < 0 ? 0 : c >= Crowd.GRID ? Crowd.GRID - 1 : c; }
  private bucket() {
    this.gridFrame = this.frameNo;
    this.cellHead.fill(-1);
    for (let j = 0; j < this.people.length; j++) {
      const q = this.people[j], sh = q.shove;
      if (q.hidden) continue;
      const c = Crowd.cellAt(q.pose.pos.x + (sh ? sh.x : 0)) * Crowd.GRID + Crowd.cellAt(q.pose.pos.z + (sh ? sh.z : 0));
      this.cellNext[j] = this.cellHead[c]; this.cellHead[c] = j;
    }
  }
  /** everyone in the 3x3 cells round cell (cx, cz), into `nearby` (the first `nearbyN`; copy it to keep it). Cells,
   *  not metres: whole numbers cross a call without being boxed, so the hot loops create no garbage asking. */
  private around(cx: number, cz: number) {
    if (this.gridFrame !== this.frameNo) this.bucket();   // built on first use in a frame, and only then
    const out = this.nearby, G = Crowd.GRID;
    let n = 0;
    for (let a = cx - 1; a <= cx + 1; a++) {
      if (a < 0 || a >= G) continue;
      for (let b = cz - 1; b <= cz + 1; b++) {
        if (b < 0 || b >= G) continue;
        for (let j = this.cellHead[a * G + b]; j >= 0; j = this.cellNext[j]) out[n++] = j;
      }
    }
    this.nearbyN = n;
  }

  constructor() {
    // bodies: a soft lathe torso, outfit-coloured, gently breathing
    const bgeo = torsoGeo();
    const bmat = new THREE.MeshStandardNodeMaterial({ roughness: 0.62, metalness: 0.0 });
    const breathe = sin(uTime.mul(1.6).add(fract(instancedBufferAttribute(this.aHairP).w).mul(6.28))).mul(0.008);
    bmat.positionNode = positionLocal.mul(vec3(float(1).add(breathe), float(1).add(breathe.mul(0.6)), float(1).add(breathe)));
    bmat.colorNode = mix(vec3(1).mul(0.72), vec3(1), smoothstep(0.0, 0.3, positionLocal.y));   // multiplied by instance colour
    this.bodies = new THREE.InstancedMesh(bgeo, bmat, MAX_PEOPLE);
    this.bodies.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PEOPLE * 3), 3);

    // heads: the face lives here
    const hgeo = headGeo();
    const hmat = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0.0 });   // satin vinyl: a soft sheen, never a white blowout under a lamp
    hmat.colorNode = this.faceNode();
    hmat.outputNode = skinRolloff();
    this.heads = new THREE.InstancedMesh(hgeo, hmat, MAX_PEOPLE);

    const amat = new THREE.MeshStandardNodeMaterial({ roughness: 0.65 });
    this.arms = new THREE.InstancedMesh(armGeo(), amat, MAX_PEOPLE * 2);
    this.arms.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PEOPLE * 6), 3);

    const hairMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.75 });
    hairMat.positionNode = positionLocal.add(normalLocal.mul(mx_noise_float(positionLocal.mul(17).add(float(instanceIndex).mul(3.7))).mul(0.016)));
    hairGeos().forEach((g) => {
      const im = new THREE.InstancedMesh(g, hairMat, MAX_PEOPLE);
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PEOPLE * 3), 3);
      im.count = 0;
      this.hair.push(im);
    });
    this.glasses = new THREE.InstancedMesh(glassesGeo(), new THREE.MeshStandardNodeMaterial({ color: 0x14161c, roughness: 0.3, metalness: 0.6 }), MAX_PEOPLE);
    this.beards = new THREE.InstancedMesh(beardGeo(), hairMat, MAX_PEOPLE);
    this.beards.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PEOPLE * 3), 3);
    const handMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.5 });
    handMat.outputNode = skinRolloff();
    this.hands = new THREE.InstancedMesh(new THREE.SphereGeometry(0.052, 10, 7), handMat, MAX_PEOPLE * 2);
    this.hands.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PEOPLE * 6), 3);
    const hoodGeo = new THREE.TorusGeometry(0.135, 0.055, 8, 18, Math.PI);
    hoodGeo.rotateX(-Math.PI / 2);
    this.hoods = new THREE.InstancedMesh(hoodGeo, new THREE.MeshStandardNodeMaterial({ roughness: 0.75 }), MAX_PEOPLE);
    this.hoods.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PEOPLE * 3), 3);
    for (const im of [this.bodies, this.heads, this.arms, this.glasses, this.beards, this.hands, this.hoods, ...this.hair]) {
      im.frustumCulled = false;
      im.count = 0;
      this.group.add(im);
    }
  }

  /**
   * The face, per pixel: skin, cheeks, eyes with a highlight that blink, squint into smiling arcs or narrow under
   * slanted lids; brows that rise, knit, worry or arch one at a time; a mouth that forms vowels, smiles, smirks
   * and shows its teeth; and a flush when someone gets heated. Faces are small on a toy's round head, so every
   * shape is drawn bold enough to read from across the table.
   */
  private faceNode() {
    const hairP = instancedBufferAttribute(this.aHairP);
    const row = (k: number) => varying(textureLoad(this.exprTex, ivec2(int(k), int(instanceIndex))));
    return faceColor({ n: normalLocal, face: instancedBufferAttribute(this.aFace), skin: instancedBufferAttribute(this.aSkinL).xyz, hair: hairP.xyz,
      phase: fract(hairP.w), beard: step(1.5, hairP.w), e0: row(0), e1: row(1), e2: row(2), e3: row(3) });
  }

  /** Replace everyone on the floor. */
  set(people: { name: string; pose: Pose }[]) {
    this.people = [];
    this.active.clear();
    const hairCount = new Array(HAIR_STYLES).fill(0);
    let g = 0, bd = 0, hd = 0;
    const n = Math.min(people.length, MAX_PEOPLE);
    for (let i = 0; i < n; i++) {
      const { name, pose } = people[i];
      const look = lookOf(name);
      const neutral: Expr = { ...NEUTRAL };
      const parts = { hair: look.style > 0 ? hairCount[look.style]++ : -1, glasses: look.glasses ? g++ : -1, beard: -1, hood: look.hood ? hd++ : -1 };
      this.people.push({ name, look, pose, parts, expr: { ...neutral }, target: { ...neutral } });
      this.shoved.delete(i);
      (this.bodies.instanceColor!.array as Float32Array).set([look.outfit.r, look.outfit.g, look.outfit.b], i * 3);
      for (const k of [0, 1]) {
        (this.arms.instanceColor!.array as Float32Array).set([look.outfit.r * 0.9, look.outfit.g * 0.9, look.outfit.b * 0.9], (i * 2 + k) * 3);
        (this.hands.instanceColor!.array as Float32Array).set([look.skin.r, look.skin.g, look.skin.b], (i * 2 + k) * 3);
      }
      if (parts.hood >= 0) (this.hoods.instanceColor!.array as Float32Array).set([look.outfit.r * 0.82, look.outfit.g * 0.82, look.outfit.b * 0.82], parts.hood * 3);
      (this.aSkinL.array as Float32Array).set([look.skin.r, look.skin.g, look.skin.b, 1], i * 4);
      (this.aHairP.array as Float32Array).set([look.hair.r, look.hair.g, look.hair.b, look.phase + (look.beard ? 2 : 0)], i * 4);
      (this.aFace.array as Float32Array).set([look.eye, look.gap, look.brow, look.mouth], i * 4);
      if (parts.hair >= 0) (this.hair[look.style].instanceColor!.array as Float32Array).set([look.hair.r, look.hair.g, look.hair.b], parts.hair * 3);
      if (parts.beard >= 0) (this.beards.instanceColor!.array as Float32Array).set([look.hair.r, look.hair.g, look.hair.b], parts.beard * 3);
      this.writeExpr(i);
      this.place(i);
    }
    this.byName = new Map(this.people.map((p, k) => [p.name, k]));
    this.bodies.count = this.heads.count = n;
    this.arms.count = n * 2;
    this.hair.forEach((im, s) => (im.count = hairCount[s]));
    this.glasses.count = g; this.beards.count = bd; this.hoods.count = hd; this.hands.count = n * 2;
    for (const a of [this.aSkinL, this.aHairP, this.aFace]) a.needsUpdate = true;
    this.exprTex.needsUpdate = true;
    for (const im of [this.bodies, this.arms, this.beards, this.hands, this.hoods, ...this.hair]) im.instanceColor!.needsUpdate = true;
    this.flush();
  }

  /** Everyone who was performing goes back to a neutral, listening face (no frozen open mouths). */
  /** Everyone (or just `only`) back to neutral, at once: walkers keep going. */
  settle(only?: number[]) {
    const set = only ? new Set(only.filter((i) => this.active.has(i))) : this.active;
    for (const i of set) {
      const p = this.people[i];
      if (!p || p.walk) continue;                         // someone on their way somewhere keeps going
      for (const x of [p.expr, p.target]) Object.assign(x, NEUTRAL);
      this.writeExpr(i);
      this.place(i);
    }
    this.exprTex.needsUpdate = true;
    this.flush();
    if (only) { for (const i of set) if (!this.people[i]?.walk) this.active.delete(i); }
    else this.active = new Set([...this.active].filter((i) => this.people[i]?.walk));
  }

  private byName = new Map<string, number>();
  index(name: string) { const i = this.byName.get(name); return i === undefined || this.people[i].hidden ? -1 : i; }

  /** Someone steps into the room (CROWD_V2): their old slot if they had one, else a new one, else the slot of someone
   *  long gone (hidden). Their index, or -1 if the room's crowd is full of people who are all here. */
  show(name: string, pose: Pose): number {
    let i = this.byName.get(name) ?? -1;
    if (i >= 0 && !this.people[i].hidden) return i;
    if (i >= 0) {
      const p = this.people[i];
      p.hidden = false; p.pose = { ...pose, pos: pose.pos.clone() }; p.walk = undefined; p.shove = undefined;
      Object.assign(p.expr, NEUTRAL); Object.assign(p.target, NEUTRAL);
      this.writeExpr(i); this.place(i); this.exprTex.needsUpdate = true; this.flush();
      return i;
    }
    if (this.people.length < MAX_PEOPLE) return this.add(name, { ...pose, pos: pose.pos.clone() });
    i = this.people.findIndex((p) => p.hidden);
    if (i < 0) return -1;
    this.recast(i, name);
    return this.show(name, pose);
  }
  /** Person i leaves the room for their place in the audience (drawn as nothing; their slot is kept). */
  hide(i: number) {
    const p = this.people[i];
    if (!p || p.hidden) return;
    p.hidden = true; p.walk = undefined; p.shove = undefined;
    this.active.delete(i); this.shoved.delete(i);
    this.place(i); this.flush();
  }
  isHidden(i: number) { return !!this.people[i]?.hidden; }
  /**
   * Someone new takes person i's place (a newcomer to a long conversation): every look is rebuilt (hair, glasses
   * and hoods are shared instanced meshes), everyone else keeps their pose and expression.
   */
  recast(i: number, name: string) {
    if (!this.people[i] || this.people[i].name === name) return;
    const keep = this.people.map((p) => ({ name: p.name, pose: p.pose, expr: { ...p.expr }, target: { ...p.target }, shove: p.shove, hidden: p.hidden, walk: p.walk }));
    // a newcomer to a seat arrives half-standing and sits down into it (the chair tucks in with them)
    keep[i] = { name, pose: keep[i].pose, expr: { ...NEUTRAL, stand: keep[i].pose.seated ? 0.65 : 0 }, target: { ...NEUTRAL }, shove: undefined, hidden: false, walk: undefined };
    const active = new Set(this.active), shoved = new Set(this.shoved);
    this.set(keep.map(({ name, pose }) => ({ name, pose })));
    this.people.forEach((p, k) => { Object.assign(p.expr, keep[k].expr); Object.assign(p.target, keep[k].target); p.shove = keep[k].shove; p.hidden = keep[k].hidden; p.walk = keep[k].walk; this.writeExpr(k); this.place(k); });
    this.shoved = shoved;
    this.active = active;
    for (const a of [this.aSkinL, this.aHairP, this.aFace]) a.needsUpdate = true;
    this.exprTex.needsUpdate = true;
    this.flush();
  }

  /** One more person on the floor (someone who just came in): everyone else keeps their place, pose, face and walk. */
  add(name: string, pose: Pose): number {
    if (this.people.length >= MAX_PEOPLE) return -1;
    const keep = this.people.map((p) => ({ expr: { ...p.expr }, target: { ...p.target }, walk: p.walk, shove: p.shove, hidden: p.hidden }));
    const active = new Set(this.active), shoved = new Set(this.shoved);
    this.set([...this.people.map((p) => ({ name: p.name, pose: p.pose })), { name, pose }]);
    this.people.forEach((p, k) => {
      if (k >= keep.length) return;
      Object.assign(p.expr, keep[k].expr); Object.assign(p.target, keep[k].target); p.walk = keep[k].walk; p.shove = keep[k].shove; p.hidden = keep[k].hidden;
      this.writeExpr(k); this.place(k);
    });
    this.active = active; this.shoved = shoved;
    const i = this.people.length - 1;
    this.active.add(i);
    this.exprTex.needsUpdate = true;
    this.flush();
    return i;
  }

  /** the person under a ray (their head or body), or -1 */
  pick(ray: THREE.Raycaster) {
    const hit = ray.intersectObjects([this.heads, this.bodies], false)[0];
    return hit?.instanceId ?? -1;
  }

  /** stop updating someone every frame (they've eased back to rest) */
  release(i: number) { if (!this.people[i]?.walk) this.active.delete(i); }
  /** Just the height of person i's head (what headPos gives as y), at a sixth of the cost: one cosine. A seated head
   *  and a standing one are usually far enough apart in height that their sideways positions never need working out. */
  private headY(i: number) {
    const p = this.people[i], st = p.pose.seated ? p.expr.stand : 1;
    const lift = p.pose.seated ? 0.42 * (1 - st) : 0, tall = 1 + (STAND_TALL - 1) * st;
    return this.group.position.y + p.pose.pos.y + lift + 0.54 * p.look.height * tall * Math.cos(p.expr.lean * 0.25) + 0.17;
  }

  headPos(i: number, out = new THREE.Vector3()) {
    const p = this.people[i];
    if (!p) return out.set(0, 0, 0);
    // seated people can stand: the chair steps back and the body rises (inlined, no garbage: this is asked a few
    // thousand times a frame while people walk and lean)
    const st = p.pose.seated ? p.expr.stand : 1;
    const lift = p.pose.seated ? 0.42 * (1 - st) : 0, tall = 1 + (STAND_TALL - 1) * st, back = p.pose.seated ? 0.06 * st : 0;
    const yb = p.pose.facing + p.expr.turn, bodyH = 0.54 * p.look.height * tall, pitch = p.expr.lean * 0.25;
    const off = Math.sin(pitch) * bodyH;
    return out.set(p.pose.pos.x + (p.shove?.x ?? 0) - Math.sin(p.pose.facing) * back + Math.sin(yb) * off,
      this.group.position.y + p.pose.pos.y + lift + bodyH * Math.cos(pitch) + 0.17,
      p.pose.pos.z + (p.shove?.z ?? 0) - Math.cos(p.pose.facing) * back + Math.cos(yb) * off);
  }

  /** How far person i tips their head to look at world point `t` (in `nod` units: negative looks up). */
  pitchTo(i: number, t: THREE.Vector3) {
    const h = this.headPos(i, this.v2);
    const up = Math.atan2(t.y - h.y, len(t.x - h.x, t.z - h.z));
    return Math.max(-1.3, Math.min(1.3, -up / 0.35));
  }
  private v2 = new THREE.Vector3();

  /** Where person i should look to face world point `t` (yaw relative to their body). */
  yawTo(i: number, t: THREE.Vector3) {
    const p = this.people[i];
    const a = Math.atan2(t.x - p.pose.pos.x - (p.shove?.x ?? 0), t.z - p.pose.pos.z - (p.shove?.z ?? 0)) - p.pose.facing;
    return Math.atan2(Math.sin(a), Math.cos(a));
  }

  target(i: number) { return this.people[i]?.target; }

  /** Place person i: body (turned, leaning, maybe standing), head, hair, glasses, arms and hands. */
  private place(i: number) {
    const p = this.people[i], { pose, look, expr } = p;
    if (p.hidden) { this.placeNowhere(i); return; }
    const st = p.pose.seated ? expr.stand : 1;           // standing up out of the chair (as in headPos)
    const lift = p.pose.seated ? 0.42 * (1 - st) : 0, tall = 1 + (STAND_TALL - 1) * st, back = p.pose.seated ? 0.06 * st : 0;
    const t = uTimeValue();
    const yb = pose.facing + expr.turn;
    const stride = p.walk ? p.walk.n[W_STRIDE] : 0;
    const bob = expr.bounce * Math.abs(Math.sin(t * 13 + look.phase * 5)) * 0.035 + (p.walk ? Math.abs(Math.sin(stride)) * 0.028 : 0);   // laughter; footsteps
    const bx = pose.pos.x + (p.shove?.x ?? 0) - Math.sin(pose.facing) * back, bz = pose.pos.z + (p.shove?.z ?? 0) - Math.cos(pose.facing) * back;
    const bodyH = 0.54 * look.height * tall, pitch = expr.lean * 0.25;
    this.e.set(pitch, yb, 0, 'YXZ'); this.q.setFromEuler(this.e);
    this.v.set(bx, pose.pos.y + lift + bob, bz);
    this.bodies.setMatrixAt(i, this.m.compose(this.v, this.q, this.s.set(look.width, look.height * tall, look.width)));
    if (p.parts.hood >= 0) {
      this.e.set(0.15 + pitch, yb, 0, 'YXZ'); this.q.setFromEuler(this.e);
      this.v.set(bx - Math.sin(yb) * 0.03, pose.pos.y + lift + bob + bodyH * 0.93, bz - Math.cos(yb) * 0.03);
      this.hoods.setMatrixAt(p.parts.hood, this.m.compose(this.v, this.q, this.s.set(look.width, 1, look.width)));
    }
    // head: follows the lean, turns further than the torso, tilts, tips back when laughing
    const off = Math.sin(pitch) * bodyH;
    this.e.set(expr.nod * 0.35 + expr.lean * 0.1 - expr.bounce * 0.22, yb + clampYaw(expr.yaw), expr.tilt * 0.32 + Math.sin(t * 0.7 + look.phase * 9) * 0.03, 'YXZ');
    this.q.setFromEuler(this.e);
    this.v.set(bx + Math.sin(yb) * off, pose.pos.y + lift + bodyH * Math.cos(pitch) + 0.17 + bob * 1.3, bz + Math.cos(yb) * off);
    this.m.compose(this.v, this.q, this.s.set(1, 1, 1));
    this.heads.setMatrixAt(i, this.m);
    if (p.parts.hair >= 0) this.hair[look.style].setMatrixAt(p.parts.hair, this.m);
    if (p.parts.glasses >= 0) this.glasses.setMatrixAt(p.parts.glasses, this.m);
    if (p.parts.beard >= 0) this.beards.setMatrixAt(p.parts.beard, this.m);
    // arms: lift forward, spread out (or across), and the right one can aim at someone
    const armY = 1 + 0.3 * st;
    for (let side = -1; side <= 1; side += 2) {
      const lift_ = side < 0 ? expr.armL : expr.armR, spread = side < 0 ? expr.spreadL : expr.spreadR, aim = side > 0 ? expr.aimR : 0;
      this.e.set(-0.25 - lift_ * 1.1 + pitch, yb + aim, side * (0.18 + spread * 0.9), 'YXZ'); this.q.setFromEuler(this.e);
      const sx = side * 0.19 * look.width;
      this.v.set(bx + Math.cos(yb) * sx + Math.sin(yb) * off * 0.8, pose.pos.y + lift + bob + bodyH * 0.82, bz - Math.sin(yb) * sx + Math.cos(yb) * off * 0.8);
      this.arms.setMatrixAt(i * 2 + (side < 0 ? 0 : 1), this.m.compose(this.v, this.q, this.s.set(1, armY, 1)));
      const hand = this.hand.set(0, -0.335 * armY, 0).applyQuaternion(this.q).add(this.v);
      this.hands.setMatrixAt(i * 2 + (side < 0 ? 0 : 1), this.m.compose(hand, this.q, this.s.set(1, 1, 1)));
    }
  }

  /** every part of person i at zero size (not in the room) */
  private placeNowhere(i: number) {
    const p = this.people[i];
    this.m.makeScale(0, 0, 0);
    this.bodies.setMatrixAt(i, this.m); this.heads.setMatrixAt(i, this.m);
    this.arms.setMatrixAt(i * 2, this.m); this.arms.setMatrixAt(i * 2 + 1, this.m);
    this.hands.setMatrixAt(i * 2, this.m); this.hands.setMatrixAt(i * 2 + 1, this.m);
    if (p.parts.hair >= 0) this.hair[p.look.style].setMatrixAt(p.parts.hair, this.m);
    if (p.parts.glasses >= 0) this.glasses.setMatrixAt(p.parts.glasses, this.m);
    if (p.parts.beard >= 0) this.beards.setMatrixAt(p.parts.beard, this.m);
    if (p.parts.hood >= 0) this.hoods.setMatrixAt(p.parts.hood, this.m);
  }

  /** row i: [open shape brow smile] [lid browIn browAsym smileAsym] [happy lidTilt blush teeth] [gaze gazeY flush blinkRate] */
  private writeExpr(i: number) {
    const x = this.people[i].expr, c = (v: number) => Math.max(-1, Math.min(1, v));
    this.exprData.set([x.open, x.shape, x.brow, x.smile, x.lid, x.browIn, x.browAsym, x.smileAsym,
      x.happy, x.lidTilt, x.blush, x.teeth, c(x.gaze), c(x.gazeY), x.flush, x.blinkRate], i * 16);
  }

  /** Ease active people toward their targets and upload what changed. */
  /**
   * Walk person i along `path` (room space, on the floor). Someone seated gets up first; on arrival they stand,
   * facing `face`. Walkers stay active (updated every frame) until they arrive.
   */
  walkTo(i: number, path: THREE.Vector3[], face: number, onArrive?: () => void, speed = 1.25) {
    const p = this.people[i];
    if (!p || !path.length) return;
    if (p.shove) { p.pose.pos.x += p.shove.x; p.pose.pos.z += p.shove.z; p.shove.x = p.shove.z = 0; }   // set off from where they stand
    const n = new Float64Array(7);
    n[W_V] = p.walk ? p.walk.n[W_V] : 0; n[W_BEST] = Infinity; n[W_X0] = n[W_Z0] = NaN;
    p.walk = { path: path.map((v) => v.clone()), speed, face, onArrive, n };
    this.active.add(i);
  }
  isWalking(i: number) { return !!this.people[i]?.walk; }

  /**
   * Advance everyone on the move: rise out of the chair, then walk the path as people do. They speed up and slow
   * down, and nobody walks through anybody: each walker bends round whoever is near (a push away, a slide past on the
   * side they're already passing, a slower step in a crowd), and then, for certain, no two bodies overlap. Seated
   * people and tables don't move; someone standing steps aside a little to let a walker squeeze by, and eases back.
   * Only walkers do this work (a few at a time), against everyone on the floor: a few thousand sums a frame.
   */
  private stepWalkers(dt: number) {
    let clear: { x: number; z: number; r: number }[] | null = null;   // asked for once someone actually steps
    const walkers = this.walkers;                         // once a frame: the active set is walked once, not six times
    let nw = 0;
    for (const i of this.active) if (this.people[i]?.walk) walkers[nw++] = i;
    for (let wi = 0; wi < nw; wi++) {
      const i = walkers[wi], p = this.people[i], w = p.walk!;
      if (p.pose.seated) {                                // up out of the chair first
        p.target.stand = 1;
        if (p.expr.stand < 0.92) continue;
        p.pose.seated = false; p.expr.stand = p.target.stand = 0;
      }
      clear ??= this.clearNow;
      const pos = p.pose.pos, next = w.path[0], me = roomOf(p);
      const dx = next.x - pos.x, dz = next.z - pos.z, d = len(dx, dz);
      const wx = d > 1e-3 ? dx / d : 0, wz = d > 1e-3 ? dz / d : 0;   // where they mean to go
      const sv = this.sv;
      sv[S_X] = pos.x; sv[S_Z] = pos.z; sv[S_ME] = me; sv[S_WX] = wx; sv[S_WZ] = wz; sv[S_VX] = wx; sv[S_VZ] = wz; sv[S_EASE] = 1; sv[S_SIDE] = w.n[W_SIDE];
      this.around(Crowd.cellAt(pos.x), Crowd.cellAt(pos.z));
      const nb = this.nearby, nn = this.nearbyN;
      for (let k = 0; k < nn; k++) {
        const j = nb[k];
        if (j === i) continue;
        const q = this.people[j], sh = q.shove;
        this.steer(q.pose.pos.x + (sh ? sh.x : 0), q.pose.pos.z + (sh ? sh.z : 0), roomOf(q));
      }
      for (let k = 0; k < clear.length; k++) this.steer(clear[k].x, clear[k].z, clear[k].r);
      let vx = sv[S_VX], vz = sv[S_VZ];
      const ease = sv[S_EASE], vl = len(vx, vz);
      if (vl > 1e-4) { vx /= vl; vz /= vl; }
      // their pace: up to speed at about two metres a second squared, slowing in a crowd and for the last metre
      const last = w.path.length === 1;
      const want = w.speed * ease * (last ? Math.max(0.3, Math.min(1, d / 0.8)) : 1);
      const wn = w.n;
      wn[W_V] += Math.max(-2.6 * dt, Math.min(2.2 * dt, want - wn[W_V]));
      const step = Math.min(wn[W_V] * dt, d + 0.05);
      wn[W_X0] = pos.x; wn[W_Z0] = pos.z;
      pos.x += vx * step; pos.z += vz * step;
    }
    if (!clear) return;
    // then nobody inside anybody: a few rounds over every walker together (one fix can make another, in a jam);
    // done as soon as a round has nothing left to fix
    for (let round = 0; round < 4; round++) {
      let fixed = 0;
      for (let wi = 0; wi < nw; wi++) { const p = this.people[walkers[wi]]; if (p.walk && !p.pose.seated) { this.separate(walkers[wi], clear); fixed += this.moved[0]; } }
      if (fixed < 1e-3) break;
    }
    for (let wi = 0; wi < nw; wi++) {
      const i = walkers[wi], p = this.people[i], w = p.walk;
      if (!w || p.pose.seated || Number.isNaN(w.n[W_X0])) continue;
      const wn = w.n, x0 = wn[W_X0], z0 = wn[W_Z0];
      const pos = p.pose.pos, next = w.path[0];
      const moved = len(pos.x - x0, pos.z - z0);
      if (moved > 1e-4) {                                 // face the way they actually move
        const head = Math.atan2(pos.x - x0, pos.z - z0), da = Math.atan2(Math.sin(head - p.pose.facing), Math.cos(head - p.pose.facing));
        p.pose.facing += da * Math.min(1, dt * 7);
      }
      wn[W_X0] = NaN;
      wn[W_STRIDE] += moved * 4.6;                        // about two steps a metre
      p.target.armL = Math.max(0, Math.sin(wn[W_STRIDE])) * 0.22; p.target.armR = Math.max(0, -Math.sin(wn[W_STRIDE])) * 0.22;
      p.target.lean = 0.12; p.target.turn = 0; p.target.yaw = 0;
      // a detour round a table is passed within a step or so (people cut corners); their place at the table, exactly.
      // A way that stays blocked (no 10 cm gained in 2.5 s: someone stood in it): on to the next point, or, near their
      // place, stop where they are (a second is enough to see it's taken)
      const left = len(next.x - pos.x, next.z - pos.z), last = w.path.length === 1;
      if (left < wn[W_BEST] - 0.1) { wn[W_BEST] = left; wn[W_STUCK] = 0; }
      else if ((wn[W_STUCK] += dt) >= 1 && wn[W_STUCK] - dt < 1) wn[W_SIDE] = 1 - wn[W_SIDE];   // a second held up (pressed
      // into a pocket by whatever they're going round, on the side nearer their way): round the other side
      if (left < (last ? 0.06 : 0.35) || wn[W_STUCK] > (last && left < 0.6 ? 1 : 2.5)) {
        w.path.shift(); wn[W_BEST] = Infinity; wn[W_STUCK] = 0; wn[W_SIDE] = 0;
        if (!w.path.length) {
          p.walk = undefined;
          p.target.armL = p.target.armR = 0; p.target.lean = 0.05;
          // turn to the table smoothly: the body keeps its heading and eases round (turn decays to the new facing)
          const prev = p.pose.facing;
          p.pose.facing = w.face;
          p.expr.turn = Math.atan2(Math.sin(prev - w.face), Math.cos(prev - w.face)); p.target.turn = 0;
          w.onArrive?.();
        }
      }
    }
  }

  /** a walker's steering, accumulated (a Float64Array, reused: no closure, no boxed numbers per walker per frame) */
  private sv = new Float64Array(9);
  /** Bend the walker in `sv` round one thing at (ox, oz) of radius r: a push away, a slide past on the side they're
   *  already nearer, a slower step when it's close ahead. */
  private steer(ox: number, oz: number, r: number) {
    const v = this.sv, ax = v[S_X] - ox, az = v[S_Z] - oz, dist = len(ax, az), reach = v[S_ME] + r + 0.45;
    if (dist >= reach || dist < 1e-4) return;
    const wx = v[S_WX], wz = v[S_WZ], nx = ax / dist, nz = az / dist, push = (reach - dist) / reach, ahead = -(nx * wx + nz * wz);
    v[S_VX] += nx * push * 1.4; v[S_VZ] += nz * push * 1.4;
    if (ahead > 0) {                                      // in the way: round them, on the side already nearer
      let tx = -nz, tz = nx;
      const along = tx * wx + tz * wz;
      // an exact tie (head-on) keeps it: each passes on its own side. Held up that way, they try the other.
      if ((along < 0) !== (v[S_SIDE] > 0.5)) { tx = -tx; tz = -tz; }
      v[S_VX] += tx * push * ahead * 1.6; v[S_VZ] += tz * push * ahead * 1.6;
      v[S_EASE] = Math.min(v[S_EASE], 0.35 + 0.65 * (dist / reach));
    }
  }

  /** Walker i out of everyone (and every table, and the lens), exactly: two walkers share the correction; someone
   *  standing gives way a little (up to SHOVE_MAX, and it eases back); the seated, the tables and the lens don't. */
  private moved = new Float64Array(1);                    // how far the last separate() moved its walker
  private separate(i: number, clear: { x: number; z: number; r: number }[]) {
    const p = this.people[i], pos = p.pose.pos, me = roomOf(p), mb = bodyRoom(p), mh = headRoom(p), hi = this.hA, hj = this.hB;
    const x0 = pos.x, z0 = pos.z;
    {
      this.headPos(i, hi);
      const near = this.near2;                          // a copy (freeAt asks around() again inside the loop)
      this.around(Crowd.cellAt(pos.x), Crowd.cellAt(pos.z));
      const nn = this.nearbyN, nb = this.nearby;
      for (let k = 0; k < nn; k++) near[k] = nb[k];
      for (let k = 0; k < nn; k++) {
        const j = near[k];
        if (j === i) continue;
        const q = this.people[j], sx = q.shove?.x ?? 0, sz = q.shove?.z ?? 0;
        const ax = pos.x - (q.pose.pos.x + sx), az = pos.z - (q.pose.pos.z + sz), dist = len(ax, az);
        if (dist >= me + roomOf(q) + 0.4) continue;       // nowhere near (a standing lean moves a head up to ~0.3 m)
        // bodies need their shoulders apart; heads, a lean apart from their bodies, need their hair apart, but only
        // sideways as much as their heights don't already part them (a seated head below a standing one)
        let over = mb + bodyRoom(q) + 0.02 - dist, nx = dist > 1e-5 ? ax / dist : 1, nz = dist > 1e-5 ? az / dist : 0;
        const rr = mh + headRoom(q) + 0.01, dy = Math.abs(hi.y - this.headY(j));
        if (dy < rr) {                                    // heads at nearly the same height: where exactly are they?
          this.headPos(j, hj);
          const hx = hi.x - hj.x, hz = hi.z - hj.z, hd = len(hx, hz), oh = Math.sqrt(rr * rr - dy * dy) - hd;
          // heads (a lean ahead of their bodies) apart along the line between them: they move with their bodies
          if (oh > over) { over = oh; if (hd > 1e-5) { nx = hx / hd; nz = hz / hd; } }
        }
        if (over <= 0) continue;
        if (q.walk && !q.pose.seated) {                   // both moving: each gives half (someone still getting up
                                                          // out of their chair is seated until they're up)
          pos.x += nx * over / 2; pos.z += nz * over / 2; q.pose.pos.x -= nx * over / 2; q.pose.pos.z -= nz * over / 2;
        } else if (!q.pose.seated) {                      // standing: they shift aside, as far as they will, into free room
          let tx = sx - nx * over * 0.5, tz = sz - nz * over * 0.5;
          const want = len(tx, tz);
          if (want > SHOVE_MAX) { tx *= SHOVE_MAX / want; tz *= SHOVE_MAX / want; }
          this.at[0] = q.pose.pos.x + tx; this.at[1] = q.pose.pos.z + tz;
          if (!this.freeAt(j, i)) { tx = sx; tz = sz; }   // hemmed in: they can't
          const gave = len(tx - sx, tz - sz);
          if (gave > 0) { const sh = (q.shove ??= { x: 0, z: 0 }); sh.x = tx; sh.z = tz; this.shoved.add(j); }
          pos.x += nx * (over - gave); pos.z += nz * (over - gave);
        } else { pos.x += nx * over; pos.z += nz * over; }
        this.headPos(i, hi);                              // they moved: their head with them
      }
      for (let k = 0; k < clear.length; k++) {
        const o = clear[k], ax = pos.x - o.x, az = pos.z - o.z, dist = len(ax, az), min = me + o.r;
        if (dist < min && dist > 1e-5) { pos.x = o.x + (ax / dist) * min; pos.z = o.z + (az / dist) * min; }
      }
      const r = len(pos.x, pos.z);                 // inside the glass
      if (r > R - 0.6) { pos.x *= (R - 0.6) / r; pos.z *= (R - 0.6) / r; }
    }
    this.moved[0] = len(pos.x - x0, pos.z - z0);
  }
  private hA = new THREE.Vector3();
  private hB = new THREE.Vector3();

  /** Is there room for person j at `this.at` (x, z), apart from `but` (the one pushing them): for their body, and for
   *  their head, which goes where the body goes? (The point comes in a reused object: numbers passed to a call that
   *  isn't inlined get boxed into garbage.) */
  private at = new Float64Array(2);
  private freeAt(j: number, but: number) {
    const q = this.people[j], r = bodyRoom(q), hr = headRoom(q), x = this.at[0], z = this.at[1], hj = this.hC, hk = this.hD;
    this.headPos(j, hj);
    hj.x += x - q.pose.pos.x - (q.shove?.x ?? 0); hj.z += z - q.pose.pos.z - (q.shove?.z ?? 0);
    this.around(Crowd.cellAt(x), Crowd.cellAt(z));
    const nb = this.nearby, nn = this.nearbyN;
    for (let n = 0; n < nn; n++) {
      const k = nb[n];
      if (k === j || k === but) continue;
      const o = this.people[k], d = len(x - o.pose.pos.x - (o.shove?.x ?? 0), z - o.pose.pos.z - (o.shove?.z ?? 0));
      if (d < r + bodyRoom(o) + 0.02) return false;
      const rr = hr + headRoom(o) + 0.01;                 // heads: as separate() and roomToLean() see them
      if (d > rr + 0.37 || Math.abs(hj.y - this.headY(k)) >= rr) continue;
      this.headPos(k, hk);
      if (len3(hj.x - hk.x, hj.y - hk.y, hj.z - hk.z) < rr) return false;
    }
    const clear = this.clearNow;                           // never into a table, nor into the lens
    for (let c = 0; c < clear.length; c++) if (len(x - clear[c].x, z - clear[c].z) < r + clear[c].r) return false;
    return true;
  }
  /** what's kept clear this frame (keepClear(), asked once a frame while anyone walks or eases back) */
  private clearNow: { x: number; z: number; r: number }[] = [];
  private hC = new THREE.Vector3();
  private hD = new THREE.Vector3();

  /** How much room person i takes (for checks): their body's disc, their head's ball. */
  extent(i: number) { const p = this.people[i]; return p ? { body: bodyRoom(p), head: headRoom(p), shoveX: p.shove?.x ?? 0, shoveZ: p.shove?.z ?? 0 } : null; }

  /**
   * Leaning in only as far as there's room: someone leaning toward the table (or toward whoever they're answering)
   * stops short of the head in front of them, as people do, instead of leaning into it. Heads are balls (with their
   * hair) at their real heights, so a seated head below a standing one is no obstacle. Only for people leaning.
   */
  private roomToLean(i: number) {
    const p = this.people[i], e = p.expr, hi = this.hA, hj = this.hB, mh = headRoom(p);
    for (let tries = 0; tries < 3 && e.lean > 0.02; tries++) {
      this.headPos(i, hi);
      let worst = 0;
      this.around(Crowd.cellAt(hi.x), Crowd.cellAt(hi.z));
      const nb = this.nearby, nn = this.nearbyN;
      for (let k = 0; k < nn; k++) {
        const j = nb[k];
        if (j === i) continue;
        const q = this.people[j];
        // a head is never more than ~0.35 m (a full standing lean) from its body: far bodies cost no trigonometry
        if (len(q.pose.pos.x + (q.shove?.x ?? 0) - hi.x, q.pose.pos.z + (q.shove?.z ?? 0) - hi.z) > mh + headRoom(q) + 0.37) continue;
        if (Math.abs(hi.y - this.headY(j)) >= mh + headRoom(q) + 0.01) continue;   // a head well above or below
        this.headPos(j, hj);
        const over = mh + headRoom(q) + 0.01 - len3(hi.x - hj.x, hi.y - hj.y, hi.z - hj.z);
        if (over > worst) worst = over;
      }
      if (worst <= 0) return;
      // the lean moves the head forward by about sin(0.25 * lean) * body height: give back that much, and a little
      const tall = 1 + (STAND_TALL - 1) * (p.pose.seated ? e.stand : 1), body = 0.54 * p.look.height * tall;
      const reach = Math.sin(e.lean * 0.25) * body, keep = Math.max(0, reach - worst - 0.01);
      e.lean = keep > 0 ? Math.asin(Math.min(1, keep / body)) / 0.25 : 0;
    }
  }

  /** Someone who stepped aside drifts back to their place (over a second or two), unless still pressed. */
  private settleShoves(dt: number) {
    const k = Math.exp(-dt * 1.6);
    for (const j of this.shoved) {
      const p = this.people[j], sh = p?.shove;
      if (!sh) { this.shoved.delete(j); continue; }
      this.at[0] = p.pose.pos.x + sh.x * k; this.at[1] = p.pose.pos.z + sh.z * k;
      if (this.freeAt(j, -1)) {                          // back toward their place, unless someone's in the way
        sh.x *= k; sh.z *= k;
        if (len(sh.x, sh.z) < 0.002) { sh.x = sh.z = 0; this.shoved.delete(j); }   // kept (zero): no garbage next time
      }
      if (!this.active.has(j)) this.place(j);            // drawn where they stand, pressed or easing back
    }
  }

  update(dt: number) {
    if (!this.active.size && !this.shoved.size) return;
    this.frameNo++;
    this.clearNow = this.keepClear();
    this.stepWalkers(dt);
    this.settleShoves(dt);
    for (const i of this.active) {
      const p = this.people[i];
      if (!p) continue;
      const k = 1 - Math.exp(-dt * 14), kSlow = 1 - Math.exp(-dt * 5);
      const e = p.expr, t = p.target;
      e.open += (t.open - e.open) * Math.min(1, k * 1.6);
      e.shape += (t.shape - e.shape) * k;
      e.brow += (t.brow - e.brow) * kSlow; e.smile += (t.smile - e.smile) * kSlow; e.lid += (t.lid - e.lid) * kSlow;
      const kFace = 1 - Math.exp(-dt * 9);                                 // brows flash, eyes crinkle: quicker
      e.browIn += (t.browIn - e.browIn) * kSlow; e.browAsym += (t.browAsym - e.browAsym) * kFace; e.smileAsym += (t.smileAsym - e.smileAsym) * kSlow;
      e.happy += (t.happy - e.happy) * kFace; e.lidTilt += (t.lidTilt - e.lidTilt) * kSlow; e.blinkRate = t.blinkRate;
      e.blush += (t.blush - e.blush) * kSlow * 0.6; e.teeth += (t.teeth - e.teeth) * kFace; e.flush += (t.flush - e.flush) * kSlow * 0.5;
      const kTurn = 1 - Math.exp(-dt * 4), kStand = 1 - Math.exp(-dt * (t.stand > e.stand ? 9 : 3.4)), kArm = k * 0.55;
      e.yaw += (t.yaw - e.yaw) * kSlow; e.nod += (t.nod - e.nod) * k; e.lean += (t.lean - e.lean) * kSlow;
      e.tilt += (t.tilt - e.tilt) * kSlow; e.turn += (t.turn - e.turn) * kTurn; e.stand += (t.stand - e.stand) * kStand;
      e.bounce += (t.bounce - e.bounce) * k * 0.6;
      const kEye = 1 - Math.exp(-dt * 22);                                // eyes are quick
      e.gaze += (t.gaze - e.gaze) * kEye; e.gazeY += (t.gazeY - e.gazeY) * kEye;
      e.armL += (t.armL - e.armL) * kArm; e.armR += (t.armR - e.armR) * kArm;
      e.spreadL += (t.spreadL - e.spreadL) * kArm; e.spreadR += (t.spreadR - e.spreadR) * kArm; e.aimR += (t.aimR - e.aimR) * kSlow;
      if (e.lean > 0.02 && !p.walk) this.roomToLean(i);
      this.writeExpr(i);
      this.place(i);
    }
    this.exprTex.needsUpdate = true;
    this.flush();
  }

  private flush() {
    for (const im of [this.bodies, this.heads, this.arms, this.glasses, this.beards, this.hands, this.hoods, ...this.hair]) im.instanceMatrix.needsUpdate = true;
  }

  /** Stable per-person randomness for gestures and reactions. */
  seed(i: number, salt: number) { return (hash32(this.people[i]?.name ?? '', salt) % 1000) / 1000; }
}

const clampYaw = (y: number) => Math.max(-1.1, Math.min(1.1, y));
let _t = 0;
export function setTimeValue(t: number) { _t = t; }
function uTimeValue() { return _t; }
