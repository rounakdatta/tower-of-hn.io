// People: soft vinyl-toy characters, one per HN user, assembled from their name.
// Faces are drawn per pixel by the shader from a few numbers (eyes, lids, brows,
// mouth open/shape/smile), so a face costs nothing and reads at any distance.
// Every body part is one instanced draw; per-frame CPU work only touches people
// who are speaking or reacting.
import * as THREE from 'three/webgpu';
import {
  instancedBufferAttribute, normalLocal, positionLocal, vec2, vec3, float, mix, smoothstep, length, min, max, clamp,
  step, fract, abs, sin, mx_noise_float, instanceIndex, floor as tfloor, output, dot, vec4,
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rngFor, pick, SKIN, OUTFIT, HAIR, hash32 } from './util.ts';
import { uTime } from './world.ts';

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
  yaw: number; nod: number; tilt: number;                                                // head
  lean: number; turn: number; stand: number; bounce: number;                             // body
  gaze: number; gazeY: number;                                                           // eyes (-1..1)
  armL: number; armR: number; spreadL: number; spreadR: number; aimR: number;           // arms
}
export const NEUTRAL: Expr = { open: 0, shape: 0, brow: 0, smile: 0.15, lid: 1, yaw: 0, nod: 0, tilt: 0, lean: 0, turn: 0, stand: 0, bounce: 0, gaze: 0, gazeY: 0, armL: 0, armR: 0, spreadL: 0, spreadR: 0, aimR: 0 };
const STAND_TALL = 2.5;           // a standing body vs a seated one (the chair hides the legs)

interface Person { name: string; look: Look; pose: Pose; parts: { hair: number; glasses: number; beard: number; hood: number }; expr: Expr; target: Expr }

function headGeo() { return new THREE.SphereGeometry(0.2, 32, 22); }

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
  const cap = (r: number, theta: number) => new THREE.SphereGeometry(r, 28, 14, 0, Math.PI * 2, 0, theta);
  const short = cap(0.213, 1.12);
  const long = mergeGeometries([cap(0.214, 1.3), (() => { const g = new THREE.CylinderGeometry(0.2, 0.17, 0.3, 24, 1, true, Math.PI * 0.62, Math.PI * 0.76); g.translate(0, -0.12, 0); return g; })()]);
  const bun = mergeGeometries([cap(0.213, 1.12), (() => { const g = new THREE.SphereGeometry(0.085, 16, 10); g.translate(0, 0.17, -0.12); return g; })()]);
  const beanie = mergeGeometries([cap(0.222, 1.05), (() => { const g = new THREE.TorusGeometry(0.2, 0.028, 10, 32); g.rotateX(Math.PI / 2); g.translate(0, 0.095, 0); return g; })(),
    (() => { const g = new THREE.SphereGeometry(0.045, 10, 8); g.translate(0, 0.235, 0); return g; })()]);
  // curly: a closed, round volume set up and back, so its front edge sits above the brows (eyes always show)
  const curly = (() => { const g = new THREE.SphereGeometry(0.25, 26, 18); g.translate(0, 0.095, -0.07); return g; })();
  const placeholder = new THREE.BoxGeometry(0.001, 0.001, 0.001);
  return [placeholder, short, long, bun, beanie, curly];
}

function glassesGeo() {
  const ring = (x: number) => { const g = new THREE.TorusGeometry(0.052, 0.009, 8, 24); g.translate(x, 0.035, 0.192); return g; };
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
  return new THREE.LatheGeometry(pts, 32);
}

function armGeo() {
  const g = new THREE.CapsuleGeometry(0.046, 0.22, 6, 12);
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
  private aDyn = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PEOPLE * 4), 4);
  private aFace = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PEOPLE * 4), 4);
  // packed to stay under WebGPU's 8 vertex buffers: skin rgb + eyelid, hair rgb + phase (+2 if bearded)
  private aSkinL = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PEOPLE * 4), 4);
  private aHairP = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PEOPLE * 4), 4);
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  active = new Set<number>();          // people whose transforms update every frame

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
    this.hands = new THREE.InstancedMesh(new THREE.SphereGeometry(0.052, 14, 10), handMat, MAX_PEOPLE * 2);
    this.hands.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PEOPLE * 6), 3);
    const hoodGeo = new THREE.TorusGeometry(0.135, 0.055, 10, 24, Math.PI);
    hoodGeo.rotateX(-Math.PI / 2);
    this.hoods = new THREE.InstancedMesh(hoodGeo, new THREE.MeshStandardNodeMaterial({ roughness: 0.75 }), MAX_PEOPLE);
    this.hoods.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PEOPLE * 3), 3);
    for (const im of [this.bodies, this.heads, this.arms, this.glasses, this.beards, this.hands, this.hoods, ...this.hair]) {
      im.frustumCulled = false;
      im.count = 0;
      this.group.add(im);
    }
  }

  /** The face, per pixel: skin, blush, eyes with a highlight, blinking lids, brows, a mouth that forms vowels. */
  private faceNode() {
    const n = normalLocal;
    const p = vec2(n.x, n.y);
    const dyn = instancedBufferAttribute(this.aDyn);           // open, shape, brow, smile
    // eye size, eye gap (+ gaze x in the fraction), brow thickness, mouth width (+ gaze y in the fraction)
    const face = instancedBufferAttribute(this.aFace);
    const skinL = instancedBufferAttribute(this.aSkinL), hairP = instancedBufferAttribute(this.aHairP);
    const skin = skinL.xyz, lid = skinL.w, hairC = hairP.xyz, phase = fract(hairP.w), beard = step(1.5, hairP.w);
    const front = smoothstep(0.25, 0.55, n.z);
    // eyes
    const blink = step(0.982, fract(uTime.mul(0.23).add(phase.mul(7.3))));
    const eyeY = float(0.12), gap = tfloor(face.y).mul(0.001 * 0.27), er = face.x.mul(0.06);
    const gx = fract(face.y).sub(0.5).div(0.45), gy = fract(face.w).sub(0.5).div(0.45);
    const eh = er.mul(clamp(lid.mul(float(1).sub(blink)), 0.07, 1.35));
    const dl = length(vec2(p.x.add(gap), p.y.sub(eyeY)).div(vec2(er, eh)));
    const dr = length(vec2(p.x.sub(gap), p.y.sub(eyeY)).div(vec2(er, eh)));
    const eyes = smoothstep(1.06, 0.9, min(dl, dr)).mul(front);
    // a big dark iris inside a thin white: reads on every skin tone, in any light
    // the irises look where the person looks, a little ahead of the head
    const ix = gx.mul(er).mul(0.3), iy = gy.mul(eh).mul(0.26);
    const il = length(vec2(p.x.add(gap).sub(ix), p.y.sub(eyeY).sub(iy))).div(er.mul(0.76));
    const ir = length(vec2(p.x.sub(gap).sub(ix), p.y.sub(eyeY).sub(iy))).div(er.mul(0.76));
    const iris = smoothstep(1.08, 0.9, min(il, ir)).mul(eyes);
    const gl = length(vec2(p.x.add(gap).sub(er.mul(0.32)).sub(ix), p.y.sub(eyeY).sub(eh.mul(0.36)).sub(iy)));
    const gr = length(vec2(p.x.sub(gap).sub(er.mul(0.32)).sub(ix), p.y.sub(eyeY).sub(eh.mul(0.36)).sub(iy)));
    const glint = smoothstep(er.mul(0.3), er.mul(0.16), min(gl, gr)).mul(eyes).mul(step(0.3, lid.mul(float(1).sub(blink))));
    // brows: raised when surprised (brow > 0), inner ends pulled down when cross (brow < 0)
    const b = dyn.z;
    const browY = eyeY.add(er.mul(1.7)).add(max(b, 0).mul(0.035));
    const drop = min(b, 0).mul(0.04);
    const half = er.mul(1.1), thick = face.z.mul(0.013);
    const xl = p.x.add(gap).div(half), xr = p.x.sub(gap).div(half);
    const yl = browY.add(drop.mul(xl)), yr = browY.sub(drop.mul(xr));
    const browL = smoothstep(thick, thick.mul(0.55), abs(p.y.sub(yl))).mul(smoothstep(1.0, 0.85, abs(xl)));
    const browR = smoothstep(thick, thick.mul(0.55), abs(p.y.sub(yr))).mul(smoothstep(1.0, 0.85, abs(xr)));
    const brows = max(browL, browR).mul(front);
    // mouth: width narrows for round vowels, opens with the voice, curves with the smile
    const open = dyn.x, shape = dyn.y, smile = dyn.w;
    const mw = tfloor(face.w).mul(0.001 * 0.1).mul(float(1).sub(max(shape, 0).mul(0.32)).add(max(float(0).sub(shape), 0).mul(0.12)));
    const mh = float(0.007).add(open.mul(0.085).mul(float(1).add(max(shape, 0).mul(0.3))));
    const xm = p.x.div(mw);
    const cy = float(-0.19).add(smile.mul(0.03).mul(xm.mul(xm))).sub(smile.mul(0.008));
    const dm = length(vec2(xm, p.y.sub(cy).div(mh)));
    const mouth = smoothstep(1.08, 0.92, dm).mul(front);
    const lip = smoothstep(1.35, 1.0, dm).mul(float(1).sub(mouth)).mul(front).mul(0.35);
    // cheeks
    const cheek = smoothstep(0.075, 0.0, length(vec2(abs(p.x).sub(0.17), p.y.add(0.075)))).mul(front).mul(0.28);
    // beard: chin and jaw, never over the mouth
    // a rounded chin curtain: everything outside an ellipse around the mouth, on the lower face
    const ring = smoothstep(0.96, 1.06, length(vec2(p.x.div(0.4), p.y.add(0.07).div(0.25))));
    const beardM = ring.mul(smoothstep(-0.02, -0.12, p.y)).mul(smoothstep(-0.25, 0.1, n.z)).mul(beard);
    let col = mix(skin, vec3(0.95, 0.45, 0.42), cheek);
    col = mix(col, hairC.mul(0.85), beardM.mul(0.94));
    col = mix(col, skin.mul(0.62), lip);
    col = mix(col, vec3(0.3, 0.07, 0.08), mouth);
    col = mix(col, hairC.mul(0.55).add(0.02), brows);
    col = mix(col, vec3(0.9, 0.87, 0.83), eyes);
    col = mix(col, vec3(0.05, 0.04, 0.045), iris);
    col = mix(col, vec3(1), glint);
    return col;
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
      (this.bodies.instanceColor!.array as Float32Array).set([look.outfit.r, look.outfit.g, look.outfit.b], i * 3);
      for (const k of [0, 1]) {
        (this.arms.instanceColor!.array as Float32Array).set([look.outfit.r * 0.9, look.outfit.g * 0.9, look.outfit.b * 0.9], (i * 2 + k) * 3);
        (this.hands.instanceColor!.array as Float32Array).set([look.skin.r, look.skin.g, look.skin.b], (i * 2 + k) * 3);
      }
      if (parts.hood >= 0) (this.hoods.instanceColor!.array as Float32Array).set([look.outfit.r * 0.82, look.outfit.g * 0.82, look.outfit.b * 0.82], parts.hood * 3);
      (this.aSkinL.array as Float32Array).set([look.skin.r, look.skin.g, look.skin.b, 1], i * 4);
      (this.aHairP.array as Float32Array).set([look.hair.r, look.hair.g, look.hair.b, look.phase + (look.beard ? 2 : 0)], i * 4);
      (this.aFace.array as Float32Array).set([look.eye, 0, look.brow, 0], i * 4);
      if (parts.hair >= 0) (this.hair[look.style].instanceColor!.array as Float32Array).set([look.hair.r, look.hair.g, look.hair.b], parts.hair * 3);
      if (parts.beard >= 0) (this.beards.instanceColor!.array as Float32Array).set([look.hair.r, look.hair.g, look.hair.b], parts.beard * 3);
      this.writeExpr(i);
      this.place(i);
    }
    this.bodies.count = this.heads.count = n;
    this.arms.count = n * 2;
    this.hair.forEach((im, s) => (im.count = hairCount[s]));
    this.glasses.count = g; this.beards.count = bd; this.hoods.count = hd; this.hands.count = n * 2;
    for (const a of [this.aSkinL, this.aHairP, this.aFace, this.aDyn]) a.needsUpdate = true;
    for (const im of [this.bodies, this.arms, this.beards, this.hands, this.hoods, ...this.hair]) im.instanceColor!.needsUpdate = true;
    this.flush();
  }

  /** Everyone who was performing goes back to a neutral, listening face (no frozen open mouths). */
  settle() {
    for (const i of this.active) {
      const p = this.people[i];
      if (!p) continue;
      for (const x of [p.expr, p.target]) Object.assign(x, NEUTRAL);
      this.writeExpr(i);
      this.place(i);
    }
    this.aDyn.needsUpdate = true; this.aSkinL.needsUpdate = true; this.aFace.needsUpdate = true;
    this.flush();
    this.active.clear();
  }

  index(name: string) { return this.people.findIndex((p) => p.name === name); }
  /**
   * Someone new takes person i's place (a newcomer to a long conversation): every look is rebuilt (hair, glasses
   * and hoods are shared instanced meshes), everyone else keeps their pose and expression.
   */
  recast(i: number, name: string) {
    if (!this.people[i] || this.people[i].name === name) return;
    const keep = this.people.map((p) => ({ name: p.name, pose: p.pose, expr: { ...p.expr }, target: { ...p.target } }));
    // a newcomer to a seat arrives half-standing and sits down into it (the chair tucks in with them)
    keep[i] = { name, pose: keep[i].pose, expr: { ...NEUTRAL, stand: keep[i].pose.seated ? 0.65 : 0 }, target: { ...NEUTRAL } };
    const active = new Set(this.active);
    this.set(keep.map(({ name, pose }) => ({ name, pose })));
    this.people.forEach((p, k) => { Object.assign(p.expr, keep[k].expr); Object.assign(p.target, keep[k].target); this.writeExpr(k); this.place(k); });
    this.active = active;
    for (const a of [this.aSkinL, this.aHairP, this.aFace, this.aDyn]) a.needsUpdate = true;
    this.flush();
  }

  /** stop updating someone every frame (they've eased back to rest) */
  release(i: number) { this.active.delete(i); }
  /** Seated people can stand: the chair steps back and the body rises. */
  private stature(p: Person) {
    const st = p.pose.seated ? p.expr.stand : 1;
    return { lift: p.pose.seated ? 0.42 * (1 - st) : 0, tall: 1 + (STAND_TALL - 1) * st, back: p.pose.seated ? 0.06 * st : 0, st };
  }

  headPos(i: number, out = new THREE.Vector3()) {
    const p = this.people[i];
    if (!p) return out.set(0, 0, 0);
    const { lift, tall, back } = this.stature(p);
    const yb = p.pose.facing + p.expr.turn, bodyH = 0.54 * p.look.height * tall, pitch = p.expr.lean * 0.25;
    const off = Math.sin(pitch) * bodyH;
    return out.set(p.pose.pos.x - Math.sin(p.pose.facing) * back + Math.sin(yb) * off,
      this.group.position.y + p.pose.pos.y + lift + bodyH * Math.cos(pitch) + 0.17,
      p.pose.pos.z - Math.cos(p.pose.facing) * back + Math.cos(yb) * off);
  }

  /** How far person i tips their head to look at world point `t` (in `nod` units: negative looks up). */
  pitchTo(i: number, t: THREE.Vector3) {
    const h = this.headPos(i, this.v2);
    const up = Math.atan2(t.y - h.y, Math.hypot(t.x - h.x, t.z - h.z));
    return Math.max(-1.3, Math.min(1.3, -up / 0.35));
  }
  private v2 = new THREE.Vector3();

  /** Where person i should look to face world point `t` (yaw relative to their body). */
  yawTo(i: number, t: THREE.Vector3) {
    const p = this.people[i];
    const a = Math.atan2(t.x - p.pose.pos.x, t.z - p.pose.pos.z) - p.pose.facing;
    return Math.atan2(Math.sin(a), Math.cos(a));
  }

  target(i: number) { return this.people[i]?.target; }

  /** Place person i: body (turned, leaning, maybe standing), head, hair, glasses, arms and hands. */
  private place(i: number) {
    const p = this.people[i], { pose, look, expr } = p;
    const { lift, tall, back, st } = this.stature(p);
    const t = uTimeValue();
    const yb = pose.facing + expr.turn;
    const bob = expr.bounce * Math.abs(Math.sin(t * 13 + look.phase * 5)) * 0.035;      // laughter
    const bx = pose.pos.x - Math.sin(pose.facing) * back, bz = pose.pos.z - Math.cos(pose.facing) * back;
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
    for (const side of [-1, 1]) {
      const lift_ = side < 0 ? expr.armL : expr.armR, spread = side < 0 ? expr.spreadL : expr.spreadR, aim = side > 0 ? expr.aimR : 0;
      this.e.set(-0.25 - lift_ * 1.1 + pitch, yb + aim, side * (0.18 + spread * 0.9), 'YXZ'); this.q.setFromEuler(this.e);
      const sx = side * 0.19 * look.width;
      this.v.set(bx + Math.cos(yb) * sx + Math.sin(yb) * off * 0.8, pose.pos.y + lift + bob + bodyH * 0.82, bz - Math.sin(yb) * sx + Math.cos(yb) * off * 0.8);
      this.arms.setMatrixAt(i * 2 + (side < 0 ? 0 : 1), this.m.compose(this.v, this.q, this.s.set(1, armY, 1)));
      const hand = new THREE.Vector3(0, -0.335 * armY, 0).applyQuaternion(this.q).add(this.v);
      this.hands.setMatrixAt(i * 2 + (side < 0 ? 0 : 1), this.m.compose(hand, this.q, this.s.set(1, 1, 1)));
    }
  }

  private writeExpr(i: number) {
    const { expr: x, look } = this.people[i];
    (this.aDyn.array as Float32Array).set([x.open, x.shape, x.brow, x.smile], i * 4);
    (this.aSkinL.array as Float32Array)[i * 4 + 3] = x.lid;
    // gaze rides in the fractions of two static numbers (WebGPU's 8 vertex buffers are all spoken for)
    const g = (v: number) => Math.max(0.001, Math.min(0.999, 0.5 + 0.45 * Math.max(-1, Math.min(1, v))));
    const f = this.aFace.array as Float32Array;
    f[i * 4 + 1] = Math.round(look.gap * 1000) + g(x.gaze);
    f[i * 4 + 3] = Math.round(look.mouth * 1000) + g(x.gazeY);
  }

  /** Ease active people toward their targets and upload what changed. */
  update(dt: number) {
    if (!this.active.size) return;
    for (const i of this.active) {
      const p = this.people[i];
      if (!p) continue;
      const k = 1 - Math.exp(-dt * 14), kSlow = 1 - Math.exp(-dt * 5);
      const e = p.expr, t = p.target;
      e.open += (t.open - e.open) * Math.min(1, k * 1.6);
      e.shape += (t.shape - e.shape) * k;
      e.brow += (t.brow - e.brow) * kSlow; e.smile += (t.smile - e.smile) * kSlow; e.lid += (t.lid - e.lid) * kSlow;
      const kTurn = 1 - Math.exp(-dt * 4), kStand = 1 - Math.exp(-dt * (t.stand > e.stand ? 9 : 3.4)), kArm = k * 0.55;
      e.yaw += (t.yaw - e.yaw) * kSlow; e.nod += (t.nod - e.nod) * k; e.lean += (t.lean - e.lean) * kSlow;
      e.tilt += (t.tilt - e.tilt) * kSlow; e.turn += (t.turn - e.turn) * kTurn; e.stand += (t.stand - e.stand) * kStand;
      e.bounce += (t.bounce - e.bounce) * k * 0.6;
      const kEye = 1 - Math.exp(-dt * 22);                                // eyes are quick
      e.gaze += (t.gaze - e.gaze) * kEye; e.gazeY += (t.gazeY - e.gazeY) * kEye;
      e.armL += (t.armL - e.armL) * kArm; e.armR += (t.armR - e.armR) * kArm;
      e.spreadL += (t.spreadL - e.spreadL) * kArm; e.spreadR += (t.spreadR - e.spreadR) * kArm; e.aimR += (t.aimR - e.aimR) * kSlow;
      this.writeExpr(i);
      this.place(i);
    }
    this.aDyn.needsUpdate = true; this.aSkinL.needsUpdate = true; this.aFace.needsUpdate = true;
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
