// The audience: everyone in a room who isn't at a table right now, standing where the hall put them (hall.ts), alive
// however many there are. Nobody here costs the CPU a thing per frame: each person is a few numbers in a texture (where
// they stand, their colours, their face), and the vertex shader does the living: breathing, a slow sway, a blink, heads
// that turn to whoever is speaking (a ripple, nearest first, never in step), and reactions that travel through the room
// from the table (a laugh, a gasp, nods). People are drawn at three levels of detail by distance, and only those in
// view: every few frames the CPU sorts the room into three lists of indices (a few thousand numbers), and that is all.
import * as THREE from 'three/webgpu';
import {
  Fn, uniform, textureLoad, ivec2, int, float, vec2, vec3, vec4, sin, cos, atan, clamp, smoothstep, mix, step, abs, max,
  normalLocal, normalGeometry, positionGeometry, varying, attribute, hash, screenCoordinate, select, length, texture,
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { lookOf, type Look } from './people.ts';
import { faceColor } from './face.ts';
import { uTime } from './world.ts';
import type { Place } from './hall.ts';

/** people per texture row; texels per person */
const ROW = 64, TEXELS = 6;
const STAND = 0.54 * 2.5;            // a standing body's height (people.ts: 0.54 m lathe, STAND_TALL 2.5)
/** levels of detail: near (under MID m), far, distant (past FAR m) */
const MID = 6.5, FAR = 15;
/** how often the lists are rebuilt (seconds), unless the camera jumps */
const SORT_EVERY = 0.2;

export const REACT = { none: 0, nod: 1, laugh: 2, gasp: 3, lean: 4 } as const;
/** which ripple wins when two meet (by REACT index): a gasp over a laugh over leaning in over nods */
const RANK = [0, 1, 3, 4, 2];
export type Reaction = keyof typeof REACT;

function torso(seg: number, rings = 1) {
  const pts = [[0, 0], [0.15, 0], [0.205, 0.07], [0.215, 0.2], [0.205, 0.34], [0.18, 0.44], [0.12, 0.51], [0.05, 0.535], [0, 0.54]]
    .filter((_, k) => rings > 1 || k % 2 === 0 || k === 8).map(([x, y]) => new THREE.Vector2(x, y * 2.5));
  return new THREE.LatheGeometry(pts, seg);
}
/** a standing body with its arms down and its hands: one geometry, `part` 0 body, 1 arms, 2 hands */
function bodyGeo(seg: number, detail: number) {
  const parts: THREE.BufferGeometry[] = [];
  const tag = (g: THREE.BufferGeometry, k: number) => { g.deleteAttribute('uv'); g.setAttribute('part', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(k), 1)); return g; };
  parts.push(tag(torso(seg, detail), 0));
  for (const side of [-1, 1]) {
    const arm = new THREE.CapsuleGeometry(0.046, 0.29, detail > 1 ? 3 : 1, detail > 1 ? 8 : 5);
    arm.translate(0, -0.2, 0); arm.rotateX(-0.12); arm.rotateZ(side * 0.16);
    arm.translate(side * 0.19, STAND * 0.82, 0.02);
    parts.push(tag(arm, 1));
    if (detail > 1) { const h = new THREE.SphereGeometry(0.052, 8, 6); h.translate(side * 0.25, STAND * 0.82 - 0.43, 0.06); parts.push(tag(h, 2)); }
  }
  return mergeGeometries(parts);
}
function headGeo(w: number, h: number) { const g = new THREE.SphereGeometry(0.2, w, h); g.deleteAttribute('uv'); return g; }

export class Audience {
  group = new THREE.Group();
  /** how many people the textures hold */
  n = 0;
  names: string[] = [];
  places: Place[] = [];
  /** per person: [x y z facing] [skin phase] [outfit height] [hair width] [eye gap brow mouth] [style glasses beard level] */
  private data = new Float32Array(0);
  private tex = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  /** per person, changing: [when they join (narration turn; -1 always here), away at a table (0/1), since (s), -] */
  private live = new Float32Array(0);
  private liveTex = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  private meshes: { body: THREE.Mesh; head: THREE.Mesh; pid: THREE.InstancedBufferAttribute; hpid: THREE.InstancedBufferAttribute }[] = [];
  /** the shaders' inputs */
  readonly u = {
    data: texture(this.tex), live: texture(this.liveTex),
    focusA: uniform(new THREE.Vector3()), focusB: uniform(new THREE.Vector3()), focusT: uniform(-100),
    react: uniform(new THREE.Vector4(0, 0, -100, 0)), reactAmp: uniform(0),
    /** the playhead (in narration turns, eased): who has joined by now */
    at: uniform(1e9),
  };
  private lastSort = -1;
  private camAt = new THREE.Vector3(1e9, 0, 0);
  private camDir = new THREE.Vector3();
  private frustum = new THREE.Frustum();
  private m = new THREE.Matrix4();
  private sph = new THREE.Sphere();
  private atTarget = 1e9;
  /** ground-level people bucketed by metre (the director asks who stands near a shot) */
  private grid = new Map<number, number[]>();

  constructor() {
    const lods: [number, number, number, number][] = [[16, 2, 20, 14], [10, 2, 12, 9], [6, 1, 8, 6]];
    const bodyMat = this.bodyMaterial(), headMat = this.headMaterial();
    for (const [seg, detail, hw, hh] of lods) {
      const bg = new THREE.InstancedBufferGeometry().copy(bodyGeo(seg, detail) as unknown as THREE.InstancedBufferGeometry);
      const hg = new THREE.InstancedBufferGeometry().copy(headGeo(hw, hh) as unknown as THREE.InstancedBufferGeometry);
      const pid = new THREE.InstancedBufferAttribute(new Float32Array(1), 1), hpid = new THREE.InstancedBufferAttribute(new Float32Array(1), 1);
      bg.setAttribute('pid', pid); hg.setAttribute('pid', hpid);
      bg.instanceCount = hg.instanceCount = 0;
      const body = new THREE.Mesh(bg, bodyMat), head = new THREE.Mesh(hg, headMat);
      for (const o of [body, head]) { o.frustumCulled = false; this.group.add(o); }
      this.meshes.push({ body, head, pid, hpid });
    }
  }

  /** texel k of person `pid`, in the vertex shader */
  private T(k: number) {
    const pid = int(attribute('pid', 'float'));
    return textureLoad(this.u.data, ivec2(pid.mod(ROW).mul(TEXELS).add(k), pid.div(ROW)));
  }
  private L() {
    const pid = int(attribute('pid', 'float'));
    return textureLoad(this.u.live, ivec2(pid.mod(ROW), pid.div(ROW)));
  }

  /**
   * Everything a person's shader needs, from their texels: where they stand, how they're turned, whether they're here
   * (joined, not away at a table), and what the room is doing to them (a reaction passing through).
   */
  private person() {
    const P0 = this.T(0), P1 = this.T(1), P2 = this.T(2), P3 = this.T(3), live = this.L();
    const pos = P0.xyz, facing = P0.w, phase = P1.w, height = P2.w, width = P3.w;
    // here: joined by the playhead (a ripple in join order as it moves), and not standing at a table right now
    const joined = select(live.x.lessThan(0), float(1), smoothstep(live.x.sub(0.5), live.x.add(0.5), this.u.at));
    const awayK = clamp(uTime.sub(live.z).div(0.35), 0, 1);
    const here = joined.mul(select(live.y.greaterThan(0.5), float(1).sub(awayK), awayK.max(step(live.z, float(-50)))));
    // a reaction travels out from where it happened, 4 m a second, each person a little in their own time
    const R = this.u.react, d = length(vec2(pos.x.sub(R.x), pos.z.sub(R.y)));
    const tl = uTime.sub(R.z).sub(d.div(4)).sub(phase.mul(0.3));
    const env = smoothstep(0, 0.25, tl).mul(float(1).sub(smoothstep(1.1, 2.1, tl))).mul(this.u.reactAmp);
    const kind = R.w;
    const is = (k: number) => step(abs(kind.sub(k)), float(0.5)).mul(env);
    return { pos, facing, phase, height, width, here, tl, nod: is(REACT.nod), laugh: is(REACT.laugh), gasp: is(REACT.gasp), lean: is(REACT.lean), P1, P2, P3 };
  }

  private bodyMaterial() {
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.62, metalness: 0 });
    const vHere = varying(float(0)), vCol = varying(vec3(0));
    mat.positionNode = Fn(() => {
      const p = this.person();
      const local = positionGeometry.toVar();
      const breathe = sin(uTime.mul(1.6).add(p.phase.mul(6.28))).mul(0.008);
      local.assign(local.mul(vec3(p.width.mul(breathe.add(1)), p.height.mul(breathe.mul(0.6).add(1)), p.width.mul(breathe.add(1)))));
      // a slow sway and a shift of weight; leaning in, or back, with the room
      const sway = sin(uTime.mul(0.31).add(p.phase.mul(6.28))).mul(0.045);
      const pitch = p.lean.mul(0.16).sub(p.gasp.mul(0.12)).add(p.laugh.mul(abs(sin(p.tl.mul(11)))).mul(-0.05));
      const cy = cos(pitch), sy = sin(pitch);
      const y1 = local.y.mul(cy).sub(local.z.mul(sy)), z1 = local.y.mul(sy).add(local.z.mul(cy));
      const a = p.facing.add(sway), ca = cos(a), sa = sin(a);
      const x2 = local.x.mul(ca).add(z1.mul(sa)), z2 = local.x.negate().mul(sa).add(z1.mul(ca));
      const bounce = abs(sin(p.tl.mul(13))).mul(0.03).mul(p.laugh);
      // arriving or leaving: they grow from a little smaller as they fade in (never a pop)
      const s = mix(float(0.8), float(1), p.here).mul(step(0.002, p.here));
      const n = normalGeometry, ny = n.y.mul(cy).sub(n.z.mul(sy)), nz = n.y.mul(sy).add(n.z.mul(cy));
      normalLocal.assign(vec3(n.x.mul(ca).add(nz.mul(sa)), ny, n.x.negate().mul(sa).add(nz.mul(ca))));
      vHere.assign(p.here);
      const part = attribute('part', 'float');
      vCol.assign(select(part.greaterThan(1.5), p.P1.xyz, p.P2.xyz.mul(select(part.greaterThan(0.5), float(0.9), mix(float(0.72), float(1), smoothstep(0, 0.75, positionGeometry.y))))));
      return vec3(x2, y1.add(bounce), z2).mul(s).add(p.pos);
    })();
    mat.colorNode = vCol;
    mat.maskNode = this.dither(vHere);
    return mat;
  }

  private headMaterial() {
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0 });
    const vHere = varying(float(0)), vSkin = varying(vec4(0)), vHair = varying(vec4(0)), vFace = varying(vec4(0)), vLook = varying(vec4(0)), vReact = varying(vec4(0));
    mat.positionNode = Fn(() => {
      const p = this.person(), P4 = this.T(4), P5 = this.T(5);
      const style = P5.x;
      const n = normalGeometry;
      // hair, as volume: each style lifts the head's skin where its hair is (the colour is painted below)
      const cap = (y0: number) => smoothstep(y0 - 0.08, y0 + 0.04, n.y);
      const isS = (k: number) => step(abs(style.sub(k)), float(0.5));
      const lift = cap(0.43).mul(0.013).mul(isS(1).add(isS(3)))
        .add(max(cap(0.27), smoothstep(0.1, -0.25, n.z).mul(step(-0.75, n.y))).mul(0.014).mul(isS(2)))
        .add(cap(0.5).mul(0.024).mul(isS(4)))
        .add(max(cap(0.2), smoothstep(-0.1, -0.4, n.z).mul(step(-0.3, n.y))).mul(0.05).mul(isS(5)))
        .add(smoothstep(0.82, 0.97, n.dot(vec3(0, 0.82, -0.57))).mul(0.07).mul(isS(3)));
      const local = positionGeometry.add(n.mul(lift)).toVar();
      // where the head is: on top of the body, swaying with it
      const sway = sin(uTime.mul(0.31).add(p.phase.mul(6.28))).mul(0.045);
      const top = float(STAND).mul(p.height).add(0.17);
      const headAt = p.pos.add(vec3(0, top, 0));
      // where they look: whoever is speaking (from A to B, a beat later the further they are, each in their own time);
      // one in eight are elsewhere, as people in a crowd are
      const lag = length(p.pos.sub(this.u.focusB)).mul(0.05).add(p.phase.mul(0.45)).add(0.12);
      const w = smoothstep(this.u.focusT.add(lag), this.u.focusT.add(lag).add(0.9), uTime);
      const F = mix(this.u.focusA, this.u.focusB, w);
      const to = F.sub(headAt);
      const yawRaw = atan(to.x, to.z).sub(p.facing.add(sway));
      const yawW = atan(sin(yawRaw), cos(yawRaw));
      const elsewhere = step(p.phase, float(0.125));
      const yaw = mix(clamp(yawW, -1.05, 1.05), sin(uTime.mul(0.2).add(p.phase.mul(40))).mul(0.6), elsewhere);
      const pitchTo = atan(to.y.negate(), length(vec2(to.x, to.z))).clamp(-0.45, 0.75);
      const nod = sin(uTime.mul(0.9).add(p.phase.mul(10.7))).mul(0.03).add(sin(p.tl.mul(8)).mul(0.12).mul(p.nod)).sub(p.laugh.mul(0.14)).sub(p.gasp.mul(0.08));
      const pitch = mix(pitchTo, float(0.05), elsewhere).add(nod);
      const roll = sin(uTime.mul(0.7).add(p.phase.mul(9))).mul(0.03);
      // the head's rotation: roll, then pitch (nodding), then yaw (body facing + sway + where they look)
      const cr = cos(roll), sr = sin(roll), cp = cos(pitch), sp = sin(pitch), a = p.facing.add(sway).add(yaw), ca = cos(a), sa = sin(a);
      const rot = (v: ReturnType<typeof vec3>) => {
        const x0 = v.x.mul(cr).sub(v.y.mul(sr)), y0 = v.x.mul(sr).add(v.y.mul(cr));
        const y1 = y0.mul(cp).sub(v.z.mul(sp)), z1 = y0.mul(sp).add(v.z.mul(cp));
        return vec3(x0.mul(ca).add(z1.mul(sa)), y1, x0.negate().mul(sa).add(z1.mul(ca)));
      };
      const bounce = abs(sin(p.tl.mul(13))).mul(0.039).mul(p.laugh);
      const s = mix(float(0.8), float(1), p.here).mul(step(0.002, p.here));
      normalLocal.assign(rot(normalGeometry));
      vHere.assign(p.here);
      vSkin.assign(p.P1); vHair.assign(vec4(p.P3.xyz, style)); vFace.assign(P4);
      // the eyes cover what the neck can't: past the head's turn, they look the rest of the way
      vLook.assign(vec4(clamp(yawW.sub(clamp(yawW, -1.05, 1.05)).mul(1.6).add(yaw.mul(0.3)), -1, 1).mul(float(1).sub(elsewhere)), clamp(pitchTo.negate().mul(0.5), -1, 1), P5.y, P5.z));
      vReact.assign(vec4(p.laugh, p.gasp, p.nod, p.lean));
      return rot(local).mul(s).add(headAt.sub(p.pos).mul(s)).add(p.pos).add(vec3(0, bounce, 0));
    })();
    // the face listens: a resting smile of their own, eyes on the speaker, the room's reaction on it
    const n = normalLocal, rest = vSkin.w.mul(0.25);
    const laugh = vReact.x, gasp = vReact.y;
    const col = faceColor({
      n, face: vFace, skin: vSkin.xyz, hair: vHair.xyz, phase: vSkin.w, beard: vLook.w,
      e0: vec4(laugh.mul(0.3).add(gasp.mul(0.25)), gasp.mul(0.8), gasp.mul(0.9).add(laugh.mul(0.2)), rest.add(0.12).add(laugh.mul(0.8))),
      e1: vec4(float(1).add(gasp.mul(0.25)).sub(laugh.mul(0.3)), gasp.mul(0.3), float(0), float(0)),
      e2: vec4(laugh, float(0), laugh.mul(0.4), laugh.mul(0.7)),
      e3: vec4(vLook.x, vLook.y, float(0), float(0)),
    });
    mat.colorNode = this.hairAndGlasses(col, n, vHair, vFace, vLook.z);
    mat.maskNode = this.dither(vHere);
    return mat;
  }

  /** hair painted over the head where each style has it (its volume was lifted in the vertex shader), and glasses */
  private hairAndGlasses(col: THREE.Node<'vec3'>, n: typeof normalLocal, hair: ReturnType<typeof vec4>, face: ReturnType<typeof vec4>, glasses: ReturnType<typeof float>) {
    const style = hair.w, isS = (k: number) => step(abs(style.sub(k)), float(0.5));
    const cap = (y0: number) => smoothstep(y0 - 0.015, y0 + 0.015, n.y);
    const mask = cap(0.43).mul(isS(1).add(isS(3)))
      .add(max(cap(0.27), smoothstep(0.08, -0.12, n.z).mul(step(-0.72, n.y))).mul(isS(2)))
      .add(cap(0.5).mul(isS(4)))
      .add(max(cap(0.2), smoothstep(-0.05, -0.25, n.z).mul(step(-0.3, n.y))).mul(isS(5)))
      .clamp(0, 1);
    const band = smoothstep(0.43, 0.46, n.y).mul(smoothstep(0.56, 0.53, n.y)).mul(isS(4));          // a beanie's turn-up
    let c: THREE.Node<'vec3'> = mix(col, hair.xyz.mul(mix(float(0.9), float(0.7), band)), mask);
    // glasses: two dark rims round the eyes, on the front of the face
    const p = vec2(n.x, n.y), gap = face.y.mul(0.27), front = smoothstep(0.25, 0.55, n.z);
    const ring = (x: ReturnType<typeof float>) => smoothstep(0.05, 0.028, abs(length(vec2(x, p.y.sub(0.14))).sub(0.24)));
    const rims = max(ring(p.x.add(gap)), ring(p.x.sub(gap))).mul(front).mul(glasses);
    c = mix(c, vec3(0.07, 0.075, 0.09), rims);
    return c;
  }

  /** fading in or out: an ordered dither on the pixel grid (no transparency to sort, no flicker frame to frame) */
  private dither(here: ReturnType<typeof float>) {
    const h = hash(screenCoordinate.x.add(screenCoordinate.y.mul(57)).floor());
    return here.greaterThan(h.mul(0.98).add(0.01));
  }

  /** Everyone in the hall, in the order they were placed. Their looks come from their names (as at the tables). */
  set(names: string[], places: (Place | null)[]) {
    const n = names.length;
    this.n = n; this.names = names.slice();
    this.places = places.map((p) => p ?? { x: 0, z: 0, y: -100, level: 0, facing: 0 });
    const rows = Math.max(1, Math.ceil(n / ROW));
    this.data = new Float32Array(ROW * TEXELS * rows * 4);
    this.live = new Float32Array(ROW * rows * 4);
    this.grid.clear();
    for (let i = 0; i < n; i++) {
      const pl = this.places[i], lk: Look = lookOf(names[i]), o = ((Math.floor(i / ROW) * ROW * TEXELS) + (i % ROW) * TEXELS) * 4;
      this.data.set([pl.x, pl.y, pl.z, pl.facing, lk.skin.r, lk.skin.g, lk.skin.b, lk.phase, lk.outfit.r, lk.outfit.g, lk.outfit.b, lk.height,
        lk.hair.r, lk.hair.g, lk.hair.b, lk.width, lk.eye, lk.gap, lk.brow, lk.mouth, lk.style, lk.glasses ? 1 : 0, lk.beard ? 1 : 0, pl.level], o);
      this.live.set([-1, 0, -100, 0], i * 4);
      if (pl.level === 0 && places[i]) { const k = cellKey(pl.x, pl.z); (this.grid.get(k) ?? this.grid.set(k, []).get(k)!).push(i); }
    }
    this.tex.dispose(); this.liveTex.dispose();
    this.tex = new THREE.DataTexture(this.data, ROW * TEXELS, rows, THREE.RGBAFormat, THREE.FloatType);
    this.liveTex = new THREE.DataTexture(this.live, ROW, rows, THREE.RGBAFormat, THREE.FloatType);
    this.tex.needsUpdate = this.liveTex.needsUpdate = true;
    this.u.data.value = this.tex; this.u.live.value = this.liveTex;
    for (const m of this.meshes) {
      for (const [g, a] of [[m.body.geometry, 'pid'], [m.head.geometry, 'pid']] as const) {
        const attr = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, n)), 1);
        attr.setUsage(THREE.DynamicDrawUsage);
        (g as THREE.InstancedBufferGeometry).setAttribute(a, attr);
      }
      m.pid = m.body.geometry.getAttribute('pid') as THREE.InstancedBufferAttribute;
      m.hpid = m.head.geometry.getAttribute('pid') as THREE.InstancedBufferAttribute;
      (m.body.geometry as THREE.InstancedBufferGeometry).instanceCount = (m.head.geometry as THREE.InstancedBufferGeometry).instanceCount = 0;
    }
    this.atTarget = 1e9; this.u.at.value = 1e9;
    this.lastSort = -1;
  }

  /** One more person (someone new on the floor, out of the lift earlier): at the end of the list; the textures grow by a
   *  row when they're full (64 people), so this is cheap. Their index. */
  append(name: string, place: Place): number {
    const i = this.n, rows = Math.ceil((i + 1) / ROW);
    if (rows * ROW * TEXELS * 4 > this.data.length) {
      const names = this.names.concat(name), places = this.places.concat(place), live = this.live.slice(0, i * 4);
      this.set(names, places);
      this.live.set(live); this.liveTex.needsUpdate = true;
      return i;
    }
    const lk: Look = lookOf(name), o = ((Math.floor(i / ROW) * ROW * TEXELS) + (i % ROW) * TEXELS) * 4;
    this.data.set([place.x, place.y, place.z, place.facing, lk.skin.r, lk.skin.g, lk.skin.b, lk.phase, lk.outfit.r, lk.outfit.g, lk.outfit.b, lk.height,
      lk.hair.r, lk.hair.g, lk.hair.b, lk.width, lk.eye, lk.gap, lk.brow, lk.mouth, lk.style, lk.glasses ? 1 : 0, lk.beard ? 1 : 0, place.level], o);
    this.live.set([-1, 0, -100, 0], i * 4);
    this.names.push(name); this.places.push(place); this.n++;
    if (place.level === 0) { const k = cellKey(place.x, place.z); (this.grid.get(k) ?? this.grid.set(k, []).get(k)!).push(i); }
    for (const m of this.meshes) for (const at of [m.pid, m.hpid]) if (at.array.length < this.n) {
      // (the index lists hold everyone at most: grow them with the room)
      const g = at === m.pid ? m.body.geometry : m.head.geometry, next = new THREE.InstancedBufferAttribute(new Float32Array(this.n + 64), 1);
      next.setUsage(THREE.DynamicDrawUsage); g.setAttribute('pid', next);
      if (at === m.pid) m.pid = next; else m.hpid = next;
    }
    this.tex.needsUpdate = this.liveTex.needsUpdate = true;
    this.lastSort = -1;
    return i;
  }

  /** Person i (an index into set()'s names) steps out to a table (true), or back to their place (false). `fade`: seconds. */
  away(i: number, away: boolean, now: number, fade = true) {
    if (i < 0 || i >= this.n) return;
    const o = i * 4;
    if ((this.live[o + 1] > 0.5) === away) return;
    this.live[o + 1] = away ? 1 : 0;
    this.live[o + 2] = fade ? now : -100;
    this.liveTex.needsUpdate = true;
    this.lastSort = -1;
  }
  isAway(i: number) { return this.live[i * 4 + 1] > 0.5; }

  /** When each person joins (a narration turn; null: everyone is here, as on the floor), and where the playhead is. */
  joins(keys: ArrayLike<number> | null) {
    for (let i = 0; i < this.n; i++) this.live[i * 4] = keys ? keys[i] : -1;
    this.liveTex.needsUpdate = true;
    this.lastSort = -1;
  }
  /** the playhead, in turns: eased toward it (scrubbing ripples people in and out in join order), or set at once */
  playhead(k: number, ease = true) { this.atTarget = k; if (!ease) this.u.at.value = k; this.lastSort = -1; }
  /** is person i in the room right now (joined, and not away at a table)? */
  present(i: number) { const o = i * 4; return this.live[o + 1] < 0.5 && (this.live[o] < 0 || this.live[o] <= this.u.at.value + 0.5); }

  /** Heads turn to whoever is speaking now (a world point), a ripple from those nearest. `now`: the scene clock. */
  focus(at: THREE.Vector3, now: number) {
    const u = this.u, k = smooth01((now - u.focusT.value - 0.12) / 1.2), y = at.y - this.group.position.y;
    if (Math.abs(u.focusB.value.x - at.x) + Math.abs(u.focusB.value.y - y) + Math.abs(u.focusB.value.z - at.z) < 0.15) return;
    u.focusA.value.lerpVectors(u.focusA.value, u.focusB.value, k);           // from wherever heads had got to
    u.focusB.value.set(at.x, y, at.z); u.focusT.value = now;
  }
  /** A reaction ripples out from (x, z) through everyone here: a laugh, a gasp, nods, leaning in. */
  react(kind: Reaction, x: number, z: number, now: number, amp = 1) {
    // one ripple at a time: a smaller one (nods for points) never cuts off a bigger one still going through the room
    const r = this.u.react.value, k = REACT[kind];
    if (now - r.z < 2.6 && now >= r.z - 0.5 && RANK[k] < RANK[r.w | 0]) return;
    r.set(x, z, now, k); this.u.reactAmp.value = amp;
  }

  /** Once a frame: ease the playhead; every SORT_EVERY seconds (or when the camera jumps) sort who is drawn how. */
  update(camera: THREE.PerspectiveCamera, now: number, dt: number) {
    if (!this.n) return;
    const at = this.u.at.value, to = this.atTarget;
    if (at !== to) this.u.at.value = Math.abs(to - at) < 0.02 ? to : at + (to - at) * Math.min(1, dt * 6);
    camera.getWorldDirection(this.camDir);
    const jumped = camera.position.distanceToSquared(this.camAt) > 0.36;
    if (!jumped && now - this.lastSort < SORT_EVERY && this.lastSort >= 0) return;
    this.lastSort = now; this.camAt.copy(camera.position);
    this.sort(camera);
  }

  private sort(camera: THREE.PerspectiveCamera) {
    // a slightly wider frustum than the lens, so a glide between sorts never shows anyone missing at the edges
    const fov = camera.fov;
    camera.updateMatrixWorld();                           // (the rig has just moved it: this frame's view, not the last one's)
    camera.fov = Math.min(170, fov * 1.25); camera.updateProjectionMatrix();
    this.m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.m);
    camera.fov = fov; camera.updateProjectionMatrix();
    const y0 = this.group.position.y, cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    const lists = this.meshes.map((m) => m.pid.array as Float32Array), counts = [0, 0, 0];
    for (let i = 0; i < this.n; i++) {
      const o = i * 4;
      if (this.live[o + 1] > 0.5 && this.live[o + 2] < -50) continue;                 // away, no fade to show
      if (this.live[o] >= 0 && this.live[o] > Math.max(this.u.at.value, this.atTarget) + 0.6) continue;   // not joined yet
      const d = ((Math.floor(i / ROW) * ROW * TEXELS) + (i % ROW) * TEXELS) * 4;
      const x = this.data[d], y = this.data[d + 1] + y0 + 0.9, z = this.data[d + 2];
      this.sph.center.set(x, y, z); this.sph.radius = 1.1;
      if (!this.frustum.intersectsSphere(this.sph)) continue;
      const dist = Math.hypot(x - cx, y - cy, z - cz), l = dist < MID ? 0 : dist < FAR ? 1 : 2;
      lists[l][counts[l]++] = i;
    }
    this.meshes.forEach((m, l) => {
      const n = counts[l];
      for (const a of [m.pid, m.hpid]) {
        if (a !== m.pid) (a.array as Float32Array).set((m.pid.array as Float32Array).subarray(0, n));
        a.clearUpdateRanges(); a.addUpdateRange(0, Math.max(1, n)); a.needsUpdate = true;
      }
      (m.body.geometry as THREE.InstancedBufferGeometry).instanceCount = (m.head.geometry as THREE.InstancedBufferGeometry).instanceCount = n;
    });
  }

  /** how many are drawn at each level of detail (for checks) */
  drawn() { return this.meshes.map((m) => (m.body.geometry as THREE.InstancedBufferGeometry).instanceCount); }
  /** triangles the audience sends the GPU this frame (for checks: the budget is in triangles, not people) */
  triangles() {
    const tris = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.attributes.position.count) / 3;
    return this.meshes.reduce((n, m) => n + (tris(m.body.geometry) + tris(m.head.geometry)) * (m.body.geometry as THREE.InstancedBufferGeometry).instanceCount, 0);
  }

  /** The person whose head is under a ray (anyone here), or -1. */
  pick(ray: THREE.Ray) {
    let best = -1, bestT = Infinity;
    const c = new THREE.Vector3(), y0 = this.group.position.y;
    for (let i = 0; i < this.n; i++) {
      if (!this.present(i)) continue;
      this.headAt(i, c); c.y += y0;
      const t = ray.closestPointToPoint(c, new THREE.Vector3()).distanceTo(c) < 0.24 ? ray.origin.distanceTo(c) : Infinity;
      if (t < bestT) { bestT = t; best = i; }
    }
    return best;
  }
  /** person i's head, room space (their resting pose) */
  headAt(i: number, out: THREE.Vector3) {
    const d = ((Math.floor(i / ROW) * ROW * TEXELS) + (i % ROW) * TEXELS) * 4;
    return out.set(this.data[d], this.data[d + 1] + STAND * this.data[d + 11] + 0.17, this.data[d + 2]);
  }
  /** everyone here on the ground within r of (x, z): their indices (for the director: who could block a shot) */
  near(x: number, z: number, r: number, out: number[]) {
    out.length = 0;
    const k0 = Math.floor(x - r), k1 = Math.floor(x + r), j0 = Math.floor(z - r), j1 = Math.floor(z + r);
    for (let a = k0; a <= k1; a++) for (let b = j0; b <= j1; b++) for (const i of this.grid.get(cellKey(a + 0.5, b + 0.5)) ?? []) {
      if (!this.present(i)) continue;
      const p = this.places[i];
      if (Math.hypot(p.x - x, p.z - z) <= r) out.push(i);
    }
    return out;
  }
}

const cellKey = (x: number, z: number) => (Math.floor(x) + 64) * 256 + (Math.floor(z) + 64);
const smooth01 = (x: number) => { const c = Math.max(0, Math.min(1, x)); return c * c * (3 - 2 * c); };
