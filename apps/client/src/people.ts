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

/** Someone on their way across the room: the points ahead of them, how fast, and what to do on arrival. */
interface Walk { path: THREE.Vector3[]; speed: number; stride: number; face: number; onArrive?: () => void }
interface Person { name: string; look: Look; pose: Pose; parts: { hair: number; glasses: number; beard: number; hood: number }; expr: Expr; target: Expr; walk?: Walk; fade?: number }

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
    const n = normalLocal;
    const p = vec2(n.x, n.y);
    const face = instancedBufferAttribute(this.aFace);
    const skin = instancedBufferAttribute(this.aSkinL).xyz, hairP = instancedBufferAttribute(this.aHairP);
    const hairC = hairP.xyz, phase = fract(hairP.w), beard = step(1.5, hairP.w);
    const row = (k: number) => varying(textureLoad(this.exprTex, ivec2(int(k), int(instanceIndex))));
    const e0 = row(0), e1 = row(1), e2 = row(2), e3 = row(3);
    const open = e0.x, shape = e0.y, brow = e0.z, smile = e0.w;
    const lid = e1.x, browIn = e1.y, browAsym = e1.z, smileAsym = e1.w;
    const happy = e2.x, lidTilt = e2.y, blush = e2.z, teeth = e2.w;
    const gx = e3.x, gy = e3.y, flush = e3.z, blinkRate = e3.w;
    const front = smoothstep(0.25, 0.55, n.z);
    // eyes: in each eye's own frame, x measured toward the nose (so one formula serves both)
    const blink = step(0.982, fract(uTime.mul(float(0.23).mul(blinkRate.add(1))).add(phase.mul(7.3))));
    const gap = face.y.mul(0.27), er = face.x.mul(0.06);
    const eyeY = float(0.12).add(happy.mul(er).mul(0.22));                  // cheeks push smiling eyes up
    const eh = er.mul(clamp(lid.mul(float(1).sub(blink)), 0.07, 1.35)).mul(float(1).sub(happy.mul(0.97)));
    const xl = p.x.add(gap), xr = gap.sub(p.x);
    const dl = length(vec2(xl, p.y.sub(eyeY)).div(vec2(er, eh)));
    const dr = length(vec2(xr, p.y.sub(eyeY)).div(vec2(er, eh)));
    // anger: the upper lid slants down toward the nose and cuts the eye
    const cut = (x: ReturnType<typeof float>) => eyeY.add(eh.mul(float(1).sub(lidTilt.mul(0.75)))).sub(lidTilt.mul(er).mul(0.55).mul(x.div(er)));
    const underL = smoothstep(cut(xl).add(0.004), cut(xl).sub(0.004), p.y), underR = smoothstep(cut(xr).add(0.004), cut(xr).sub(0.004), p.y);
    const eyeL = smoothstep(1.06, 0.9, dl).mul(underL), eyeR = smoothstep(1.06, 0.9, dr).mul(underR);
    const eyes = max(eyeL, eyeR).mul(front);
    // a big dark iris inside a thin white reads on every skin tone, in any light; it looks a little ahead of the head
    const ix = gx.mul(er).mul(0.3), iy = gy.mul(eh).mul(0.26);
    const il = length(vec2(xl.sub(ix), p.y.sub(eyeY).sub(iy))).div(er.mul(0.76));
    const ir = length(vec2(xr.add(ix), p.y.sub(eyeY).sub(iy))).div(er.mul(0.76));
    const iris = smoothstep(1.08, 0.9, min(il, ir)).mul(eyes);
    const gl = length(vec2(xl.sub(er.mul(0.32)).sub(ix), p.y.sub(eyeY).sub(eh.mul(0.36)).sub(iy)));
    const gr = length(vec2(xr.add(er.mul(0.32)).add(ix), p.y.sub(eyeY).sub(eh.mul(0.36)).sub(iy)));
    const glint = smoothstep(er.mul(0.3), er.mul(0.16), min(gl, gr)).mul(eyes).mul(step(0.3, lid.mul(float(1).sub(blink)))).mul(float(1).sub(happy));
    // the lash line along the top of each eye: always a hint (definition), the whole arc when smiling or narrowed
    const arc = (d: ReturnType<typeof float>, x: ReturnType<typeof float>, under: ReturnType<typeof float>) =>
      smoothstep(0.2, 0.06, abs(d.sub(1))).mul(step(eyeY.sub(eh.mul(0.2)), p.y)).mul(smoothstep(1.15, 0.9, abs(x).div(er))).mul(max(under, happy));
    // laughing eyes close into arches (∩ ∩): the top of a lower, rounder ellipse, drawn as a thick line
    const arch = (x: ReturnType<typeof float>) => {
      const d = length(vec2(x.div(er), p.y.sub(eyeY.sub(er.mul(0.35))).div(er.mul(0.8))));
      return smoothstep(0.24, 0.1, abs(d.sub(1))).mul(step(eyeY.sub(er.mul(0.3)), p.y));
    };
    const arches = max(arch(xl), arch(xr)).mul(front).mul(smoothstep(0.45, 0.85, happy));
    const lash = max(max(arc(dl, xl, underL), arc(dr, xr, underR)).mul(front).mul(max(lidTilt.mul(0.9), 0.35)).mul(float(1).sub(happy)), arches);
    const lidLine = max(smoothstep(0.0045, 0.0015, abs(p.y.sub(cut(xl)))).mul(smoothstep(1.1, 0.8, abs(xl).div(er))),
      smoothstep(0.0045, 0.0015, abs(p.y.sub(cut(xr)))).mul(smoothstep(1.1, 0.8, abs(xr).div(er)))).mul(lidTilt).mul(front);
    // brows: up and down together, inner ends up (worry) or down (anger), one at a time (doubt), a slight arch
    const half = er.mul(1.1), thick = face.z.mul(0.013);
    const browY = eyeY.add(er.mul(1.7)).add(brow.mul(0.034)).sub(happy.mul(er).mul(0.1));
    const bl = xl.div(half), br = xr.div(half);
    const yl = browY.add(max(browAsym, 0).mul(0.03)).add(browIn.mul(0.036).mul(bl)).sub(bl.mul(bl).mul(0.006));
    const yr = browY.add(max(browAsym.negate(), 0).mul(0.03)).add(browIn.mul(0.036).mul(br)).sub(br.mul(br).mul(0.006));
    const browL = smoothstep(thick, thick.mul(0.55), abs(p.y.sub(yl))).mul(smoothstep(1.0, 0.85, abs(bl)));
    const browR = smoothstep(thick, thick.mul(0.55), abs(p.y.sub(yr))).mul(smoothstep(1.0, 0.85, abs(br)));
    const brows = max(browL, browR).mul(front);
    // mouth: narrows for round vowels, opens with the voice, curves with the smile, tilts in a smirk, shows teeth
    const mw = face.w.mul(0.1).mul(float(1).sub(max(shape, 0).mul(0.32)).add(max(float(0).sub(shape), 0).mul(0.12))).mul(teeth.mul(0.12).add(1));
    const mh = float(0.007).add(open.mul(0.085).mul(float(1).add(max(shape, 0).mul(0.3))));
    const xm = p.x.div(mw);
    const cy = float(-0.19).add(smile.mul(0.044).mul(xm.mul(xm))).sub(smile.mul(0.012)).add(smileAsym.mul(0.02).mul(xm));
    const dm = length(vec2(xm, p.y.sub(cy).div(mh)));
    const mouth = smoothstep(1.08, 0.92, dm).mul(front);
    const tooth = mouth.mul(smoothstep(cy.add(mh.mul(0.1)), cy.add(mh.mul(0.3)), p.y)).mul(teeth);
    const lip = smoothstep(1.35, 1.0, dm).mul(float(1).sub(mouth)).mul(front).mul(0.35);
    // cheeks: a little colour always, more when pleased or embarrassed, raised by a real smile
    const cheek = smoothstep(0.075, 0.0, length(vec2(abs(p.x).sub(0.17), p.y.add(0.075).sub(happy.mul(0.02))))).mul(front).mul(blush.mul(0.5).add(0.28));
    // beard: chin and jaw, never over the mouth
    const ring = smoothstep(0.96, 1.06, length(vec2(p.x.div(0.4), p.y.add(0.07).div(0.25))));
    const beardM = ring.mul(smoothstep(-0.02, -0.12, p.y)).mul(smoothstep(-0.25, 0.1, n.z)).mul(beard);
    let col: THREE.Node = mix(skin, skin.mul(vec3(1.16, 0.7, 0.66)), flush.mul(0.5).mul(smoothstep(-0.2, 0.4, n.z)));
    col = mix(col, vec3(0.95, 0.45, 0.42), cheek);
    col = mix(col, hairC.mul(0.85), beardM.mul(0.94));
    col = mix(col, skin.mul(0.62), lip);
    col = mix(col, vec3(0.3, 0.07, 0.08), mouth);
    col = mix(col, vec3(0.93, 0.9, 0.86), tooth);
    col = mix(col, hairC.mul(0.55).add(0.02), brows);
    col = mix(col, vec3(0.9, 0.87, 0.83), eyes);
    col = mix(col, vec3(0.05, 0.04, 0.045), iris);
    col = mix(col, vec3(1), glint);
    col = mix(col, vec3(0.06, 0.045, 0.05), max(lash, lidLine));
    return col as THREE.Node<'vec3'>;
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
  index(name: string) { return this.byName.get(name) ?? -1; }
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
    for (const a of [this.aSkinL, this.aHairP, this.aFace]) a.needsUpdate = true;
    this.exprTex.needsUpdate = true;
    this.flush();
  }

  /** One more person on the floor (someone who just came in): everyone else keeps their place, pose, face and walk. */
  add(name: string, pose: Pose): number {
    if (this.people.length >= MAX_PEOPLE) return -1;
    const keep = this.people.map((p) => ({ expr: { ...p.expr }, target: { ...p.target }, walk: p.walk }));
    const active = new Set(this.active);
    this.set([...this.people.map((p) => ({ name: p.name, pose: p.pose })), { name, pose }]);
    this.people.forEach((p, k) => {
      if (k >= keep.length) return;
      Object.assign(p.expr, keep[k].expr); Object.assign(p.target, keep[k].target); p.walk = keep[k].walk;
      this.writeExpr(k); this.place(k);
    });
    this.active = active;
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
    const stride = p.walk ? p.walk.stride : 0;
    const bob = expr.bounce * Math.abs(Math.sin(t * 13 + look.phase * 5)) * 0.035 + (p.walk ? Math.abs(Math.sin(stride)) * 0.028 : 0);   // laughter; footsteps
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
    p.walk = { path: path.map((v) => v.clone()), speed, stride: 0, face, onArrive };
    this.active.add(i);
  }
  isWalking(i: number) { return !!this.people[i]?.walk; }

  /** Advance everyone on the move: rise out of the chair, then step along the path, turning toward it. */
  private stepWalkers(dt: number) {
    for (const i of this.active) {
      const p = this.people[i], w = p?.walk;
      if (!p || !w) continue;
      if (p.pose.seated) {                                // up out of the chair first
        p.target.stand = 1;
        if (p.expr.stand < 0.92) continue;
        p.pose.seated = false; p.expr.stand = p.target.stand = 0;
      }
      const next = w.path[0];
      const dx = next.x - p.pose.pos.x, dz = next.z - p.pose.pos.z, d = Math.hypot(dx, dz);
      const step = Math.min(d, w.speed * dt);
      if (d > 1e-3) {
        p.pose.pos.x += (dx / d) * step; p.pose.pos.z += (dz / d) * step;
        const want = Math.atan2(dx, dz), da = Math.atan2(Math.sin(want - p.pose.facing), Math.cos(want - p.pose.facing));
        p.pose.facing += da * Math.min(1, dt * 7);
      }
      w.stride += step * 4.6;                             // about two steps a metre
      p.target.armL = Math.max(0, Math.sin(w.stride)) * 0.22; p.target.armR = Math.max(0, -Math.sin(w.stride)) * 0.22;
      p.target.lean = 0.12; p.target.turn = 0; p.target.yaw = 0;
      if (d - step < 0.02) {
        w.path.shift();
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

  update(dt: number) {
    if (!this.active.size) return;
    this.stepWalkers(dt);
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
