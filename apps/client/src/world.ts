// The world outside: sky, city, streets, snow, and the tower itself.
// Everything repeated is instanced; everything animated runs in shaders.
import * as THREE from 'three/webgpu';
import {
  uniform, instancedBufferAttribute, hash, step, fract, positionWorld, positionLocal, normalLocal, instanceIndex, mix,
  smoothstep, vec2, vec3, float, sin, uv, dot, floor as tfloor, abs, texture, max, min, normalize, pow, length, cos, clamp, cameraPosition,
  screenCoordinate,
} from 'three/tsl';
import { clamp as clampN, easeInOut } from './util.ts';

export const FLOORS = 30, FLOOR_H = 2.4, R = 7, LOBBY_H = 4.2;
/** the title sign along the top of each floor: its height, and its centre above the floor's centre */
const BAND_H = 0.56, BAND_Y = 0.84;
export const floorY = (rank: number) => LOBBY_H + (FLOORS - 1 - rank) * FLOOR_H + FLOOR_H / 2;
export const TOWER_TOP = LOBBY_H + FLOORS * FLOOR_H;

export const uTime = uniform(0);
export const uBeacon = uniform(0);     // 0..1, decays: a comment just landed
/** the neon sign on the crown: the name, and its orange "Of" (which buzzes on its own now and then) */
export const uNeon = uniform(0), uNeonOf = uniform(0);

export function buildSky(scene: THREE.Scene) {
  const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
  const d = normalize(positionLocal);
  const zenith = vec3(0.012, 0.018, 0.045), horizon = vec3(0.09, 0.1, 0.17), glow = vec3(0.32, 0.2, 0.16);
  const h = clamp(d.y, -0.2, 1);
  let col = mix(horizon, zenith, smoothstep(0.0, 0.55, h));
  col = col.add(glow.mul(pow(max(float(0), float(1).sub(abs(d.y).mul(6))), 3)).mul(0.35));        // city glow on the horizon
  const moonDir = normalize(vec3(-0.45, 0.42, -0.78));
  const md = max(float(0), dot(d, moonDir));
  col = col.add(vec3(0.75, 0.8, 0.95).mul(smoothstep(0.9993, 0.9996, md))).add(vec3(0.18, 0.2, 0.3).mul(pow(md, 60)));
  const cell = tfloor(d.mul(420));
  const r = hash(dot(cell, vec3(12.9898, 78.233, 45.164)));
  const twinkle = sin(uTime.mul(1.3).add(r.mul(80))).mul(0.4).add(0.6);
  col = col.add(vec3(1).mul(step(0.9975, r)).mul(smoothstep(0.05, 0.35, h)).mul(twinkle).mul(0.9));
  mat.colorNode = col;
  const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), mat);
  sky.renderOrder = -1;
  scene.add(sky);
}

export function buildCity(scene: THREE.Scene) {
  // ground with a street grid and moving headlight streaks
  const gmat = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0.05 });
  const p = positionWorld.xz;
  const g = vec2(fract(p.x.div(14)), fract(p.y.div(14)));
  const roadX = smoothstep(0.035, 0.0, abs(g.x.sub(0.5)).sub(0.46)), roadZ = smoothstep(0.035, 0.0, abs(g.y.sub(0.5)).sub(0.46));
  const dist = length(p);
  const nearTower = smoothstep(14, 24, dist);
  const carsX = step(0.975, fract(p.y.div(5).add(uTime.mul(0.9)).add(hash(tfloor(p.x.div(14))).mul(7)))).mul(roadX);
  const carsZ = step(0.975, fract(p.x.div(5).sub(uTime.mul(0.7)).add(hash(tfloor(p.y.div(14)).add(3)).mul(7)))).mul(roadZ);
  gmat.colorNode = mix(vec3(0.03, 0.035, 0.05), vec3(0.055, 0.05, 0.05), max(roadX, roadZ));
  gmat.emissiveNode = vec3(1.0, 0.55, 0.22).mul(max(roadX, roadZ).mul(0.025))
    .add(vec3(1.0, 0.82, 0.55).mul(carsX.add(carsZ)).mul(0.22)).mul(nearTower);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(700, 96), gmat);
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const N = 640;
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.75, metalness: 0.25 });
  const cell = tfloor(positionWorld.mul(vec3(1.9, 1.35, 1.9)));
  const r = hash(dot(cell, vec3(12.9898, 78.233, 37.719)));
  const bld = hash(float(instanceIndex).mul(3.7));
  const litFrac = mix(float(0.06), float(0.32), bld);
  const bands = step(0.42, fract(positionWorld.y.mul(1.35))).mul(step(0.38, fract(positionWorld.x.add(positionWorld.z).mul(1.9))));
  const walls = step(abs(normalLocal.y), 0.5);
  const warm = mix(vec3(1.0, 0.66, 0.36), vec3(1.0, 0.85, 0.62), hash(r.add(1.7)));
  const cool = vec3(0.55, 0.7, 1.0);
  const winCol = mix(warm, cool, step(0.88, hash(r.add(9.1))));
  const roofBlink = step(0.5, normalLocal.y).mul(step(length(positionLocal.xz), 0.06)).mul(step(0.97, bld)).mul(step(0.5, fract(uTime.mul(0.5).add(bld.mul(3)))));
  mat.colorNode = mix(vec3(0.05, 0.055, 0.07), vec3(0.08, 0.075, 0.08), bld);
  mat.emissiveNode = winCol.mul(step(float(1).sub(litFrac), r)).mul(bands).mul(walls).mul(0.95).add(vec3(1, 0.1, 0.05).mul(roofBlink).mul(3));
  const city = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, N);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < N; i++) {
    let x = 0, z = 0;
    for (let tries = 0; tries < 20; tries++) {
      // snap to blocks between streets so buildings never sit on a road
      x = (Math.round((rnd() - 0.5) * 34) + 0.5) * 14 + (rnd() - 0.5) * 6;
      z = (Math.round((rnd() - 0.5) * 34) + 0.5) * 14 + (rnd() - 0.5) * 6;
      if (Math.hypot(x, z) > 30) break;
    }
    const d = Math.hypot(x, z);
    const w = 5 + rnd() * 6, dd = 5 + rnd() * 6;
    const h = 5 + Math.pow(rnd(), 2.3) * (d < 90 ? 30 : 46) + (d > 160 ? rnd() * 20 : 0);
    q.setFromAxisAngle(up, (rnd() < 0.85 ? 0 : rnd() * 0.5));
    m.compose(new THREE.Vector3(x, h / 2, z), q, new THREE.Vector3(w, h, dd));
    city.setMatrixAt(i, m);
  }
  scene.add(city);
}

export function buildSnow(scene: THREE.Scene, count = 2600) {
  const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
  const i = float(instanceIndex);
  const fall = uTime.mul(mix(float(0.6), float(1.3), hash(i.add(3))));
  const y = fract(hash(i.add(1)).sub(fall.div(80))).mul(80);
  const x = hash(i.add(2)).sub(0.5).mul(90).add(sin(uTime.mul(0.6).add(i)).mul(0.8));
  const z = hash(i.add(4)).sub(0.5).mul(90).add(cos(uTime.mul(0.5).add(i.mul(1.3))).mul(0.8));
  mat.positionNode = vec3(x, y, z);
  mat.scaleNode = mix(float(0.05), float(0.13), hash(i.add(5)));
  const c = length(uv().sub(0.5));
  mat.colorNode = vec3(0.92, 0.95, 1.0);
  mat.opacityNode = smoothstep(0.5, 0.15, c).mul(0.75).mul(smoothstep(3, 9, length(vec3(x, y, z).sub(cameraPosition))));
  const snow = new THREE.Sprite(mat);
  snow.count = count;
  snow.frustumCulled = false;
  scene.add(snow);
  return snow;
}

// ---------------------------------------------------------------- the tower
type N = ReturnType<typeof float>;
/**
 * A floor's skin: glass panes between mullions, lit (or not) from inside, the crowd inside as silhouettes against
 * the light, the title band's strip kept dark. With `open`, the panes clear (a dithered dissolve, so the slab stays
 * opaque and depth-sorted) and you see into the room: used only by the one floor we're flying into.
 */
function floorMaterial(i: { glow: N; crowd: N; sel: N; pulse: N; seed: N; open?: N }) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.22, metalness: 0.85 });
  const { glow, crowd, sel, pulse, seed } = i;
  const u = uv().x, v = uv().y;
  const cols = 132.0;
  const wu = fract(u.mul(cols)), wv = v;
  const pane = step(0.2, wu).mul(step(wu, 0.8)).mul(step(0.14, wv)).mul(step(wv, 0.72));   // mullions; the top band is the title's
  const id = tfloor(u.mul(cols)).add(seed.mul(173.0));
  const r = hash(id);
  const lit = step(float(1).sub(max(glow, crowd.mul(0.85))), r);
  const flick = sin(uTime.mul(0.4).add(r.mul(60))).mul(0.05).add(0.95);
  const walls = step(abs(normalLocal.y), 0.5);
  const interiorTint = mix(mix(vec3(1.0, 0.55, 0.24), vec3(1.0, 0.82, 0.56), hash(id.add(7))), vec3(0.62, 0.78, 1.0), step(0.93, hash(id.add(13))));
  const dimRoom = vec3(0.08, 0.1, 0.16).mul(pane).mul(walls);           // unlit glass still reads as glass
  mat.colorNode = mix(vec3(0.03, 0.035, 0.05), vec3(0.05, 0.06, 0.08), pane);
  // the crowd: people inside, dark against the light, a place every 1.1 m round the floor, filled as more
  // different people join the story's conversation; some seated, some standing, swaying a little
  const um = u.mul(2 * Math.PI * R), place = tfloor(um.div(1.1)), at = fract(um.div(1.1));
  const who = hash(place.add(seed.mul(57.0)));
  const here = step(float(1).sub(crowd), who);
  const cx = float(0.5).add(hash(place.add(3.1)).sub(0.5).mul(0.42)).add(sin(uTime.mul(0.45).add(who.mul(40))).mul(0.07));
  const xm = at.sub(cx).mul(1.1), ym = v.mul(FLOOR_H * 0.94);
  const top = mix(float(1.14), float(1.6), step(0.62, hash(place.add(7.7))));
  const headD = length(vec2(xm, ym.sub(top))).sub(0.105);
  const bodyD = length(vec2(xm.div(0.23), ym.sub(top.sub(0.37)).div(0.3))).sub(1).mul(0.23);
  const person = smoothstep(0.012, -0.012, min(headD, bodyD)).mul(here);
  // up close, through clearing glass, the real room shows: its silhouettes and glow give way as it does
  const clear = i.open ? step(hash(screenCoordinate.x.add(screenCoordinate.y.mul(1931.7))).mul(0.999), i.open).mul(pane).mul(walls) : float(0);
  mat.emissiveNode = interiorTint.mul(pane).mul(lit).mul(flick).mul(walls).mul(float(0.78).add(pulse.mul(1.4))).mul(float(1).sub(person.mul(0.9)))
    .add(dimRoom.mul(0.25))
    .add(vec3(1.0, 0.42, 0.1).mul(sel).mul(walls).mul(step(0.72, v)).mul(0.6));
  if (i.open) { mat.opacityNode = float(1).sub(clear); mat.alphaTest = 0.5; }
  return mat;
}

interface Slot { sid: number | null; y: number; yTarget: number; r: number; dir: THREE.Vector2; anim: { t0: number; from: number; to: number; dur: number; out: number } | null; scale: number; scaleTarget: number }

export class Tower {
  floors: THREE.InstancedMesh;
  bands: THREE.InstancedMesh;
  slots: Slot[] = [];
  slotOf = new Map<number, number>();
  rankOf = new Map<number, number>();
  // packed in pairs (WebGPU allows eight vertex buffers): lit fraction + crowd, selected + pulse
  private aLight: THREE.InstancedBufferAttribute;
  private aState: THREE.InstancedBufferAttribute;
  private searchlights: THREE.Group;
  private atlas: HTMLCanvasElement;
  private atlasTex: THREE.CanvasTexture;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  hidden = -1;                          // slot whose slab is opened (we're inside it)
  /** the slot whose glass is clearing (flying in or out), and how far (0 solid .. 1 clear) */
  doorSlot = -1;
  private door!: THREE.Mesh;
  private u = { glow: uniform(0), crowd: uniform(0), sel: uniform(0), pulse: uniform(0), seed: uniform(0), open: uniform(0) };
  /** Clear a floor's glass as far as `open` (0..1); -1 puts the door away. */
  setDoor(slot: number, open = 0) {
    this.doorSlot = slot;
    this.u.open.value = open;
    if (slot < 0) { this.door.visible = false; return; }
    const light = this.aLight.array as Float32Array, st = this.aState.array as Float32Array;
    this.u.glow.value = light[slot * 2]; this.u.crowd.value = light[slot * 2 + 1];
    this.u.sel.value = st[slot * 3]; this.u.pulse.value = st[slot * 3 + 1]; this.u.seed.value = slot;
  }
  /** which way the title signs face (the camera's bearing): a copy of each title is always square to the viewer */
  faceYaw = 0.64;
  private sign!: THREE.Group;
  private qFace = new THREE.Quaternion();
  private yAxis = new THREE.Vector3(0, 1, 0);
  onMove: () => void = () => {};

  constructor(scene: THREE.Scene) {
    // lobby and crown
    const stone = new THREE.MeshStandardNodeMaterial({ color: 0x1a1c24, roughness: 0.6, metalness: 0.3 });
    const lobby = new THREE.Mesh(new THREE.CylinderGeometry(R + 1.6, R + 2.2, LOBBY_H, 72), stone);
    lobby.position.y = LOBBY_H / 2;
    const lobbyGlow = new THREE.MeshStandardNodeMaterial({ color: 0x120c08, roughness: 0.4 });
    lobbyGlow.emissiveNode = vec3(1.0, 0.68, 0.38).mul(smoothstep(0.15, 0.0, abs(uv().y.sub(0.35))).mul(0.9));
    const entrance = new THREE.Mesh(new THREE.CylinderGeometry(R + 1.62, R + 1.62, LOBBY_H * 0.9, 72, 1, true), lobbyGlow);
    entrance.position.y = LOBBY_H / 2;
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(R - 1.2, R + 0.2, 1.2, 72), stone);
    crown.position.y = TOWER_TOP + 0.6;
    const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.32, 9, 12), new THREE.MeshStandardNodeMaterial({ color: 0x2a2d38, metalness: 0.9, roughness: 0.25 }));
    spire.position.y = TOWER_TOP + 1.2 + 4.5;
    const beaconMat = new THREE.MeshBasicNodeMaterial();
    beaconMat.colorNode = vec3(1.0, 0.36, 0.05).mul(sin(uTime.mul(1.6)).mul(0.25).add(1.2).add(uBeacon.mul(5)));
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.42, 20, 14), beaconMat);
    beacon.position.y = TOWER_TOP + 1.2 + 9.2;
    this.sign = neonSign();
    scene.add(lobby, entrance, crown, spire, beacon, this.sign);

    // floors: one instanced draw for all thirty
    const geo = new THREE.CylinderGeometry(R, R, FLOOR_H * 0.94, 96, 1);
    this.aLight = new THREE.InstancedBufferAttribute(new Float32Array(FLOORS * 2), 2);
    this.aState = new THREE.InstancedBufferAttribute(new Float32Array(FLOORS * 3), 3);
    const light = instancedBufferAttribute(this.aLight), state = instancedBufferAttribute(this.aState);
    const mat = floorMaterial({ glow: light.x, crowd: light.y, sel: state.x, pulse: state.y, seed: float(instanceIndex) });
    this.floors = new THREE.InstancedMesh(geo, mat, FLOORS);
    this.floors.frustumCulled = false;
    // the door: one floor's slab on its own, its glass panes clearing (screen-door dissolve) as we fly in or out
    const u = this.u;
    this.door = new THREE.Mesh(geo, floorMaterial({ glow: float(u.glow), crowd: float(u.crowd), sel: float(u.sel), pulse: float(u.pulse), seed: float(u.seed), open: float(u.open) }));
    this.door.visible = false;
    this.door.frustumCulled = false;
    scene.add(this.door);

    // title bands: a lit sign along the top of every floor, its story's title three times round (one copy reads
    // whole from wherever you stand), bright on the floor in focus so it can be read from outside
    this.atlas = document.createElement('canvas');
    this.atlas.width = 2048; this.atlas.height = 2048;
    this.atlasTex = new THREE.CanvasTexture(this.atlas);
    this.atlasTex.colorSpace = THREE.SRGBColorSpace;
    this.atlasTex.anisotropy = 8;
    const bgeo = new THREE.CylinderGeometry(R + 0.02, R + 0.02, BAND_H, 160, 1, true);
    const aRow = new THREE.InstancedBufferAttribute(new Float32Array(FLOORS).map((_, i) => i), 1);
    bgeo.setAttribute('aRow', aRow);
    const bmat = new THREE.MeshStandardNodeMaterial({ roughness: 0.5, metalness: 0.2 });
    {
      const row = instancedBufferAttribute(aRow), sel = instancedBufferAttribute(this.aState).x;
      const tuv = vec2(fract(uv().x.mul(3)), float(1).sub(row.add(float(1).sub(uv().y)).div(32)));
      const t = texture(this.atlasTex, tuv);
      bmat.colorNode = vec3(0.02, 0.022, 0.03);
      bmat.emissiveNode = t.rgb.mul(sel.mul(1.25).add(0.9));
    }
    this.bands = new THREE.InstancedMesh(bgeo, bmat, FLOORS);
    this.bands.frustumCulled = false;
    scene.add(this.floors, this.bands);
    // searchlights from the crown: the tower is an event
    this.searchlights = new THREE.Group();
    this.searchlights.position.y = TOWER_TOP + 1.2;
    const beam = new THREE.ConeGeometry(13, 150, 32, 1, true);
    beam.translate(0, -75, 0); beam.rotateX(Math.PI);           // apex at the crown, opening upward
    const bm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false });
    bm.colorNode = vec3(1.0, 0.86, 0.66);
    bm.opacityNode = pow(uv().y, 2.6).mul(0.055);
    for (let k = 0; k < 2; k++) {
      const pivot = new THREE.Group();
      const cone = new THREE.Mesh(beam, bm);
      cone.rotation.z = 0.42;
      pivot.add(cone); pivot.rotation.y = k * Math.PI;
      this.searchlights.add(pivot);
    }
    scene.add(this.searchlights);
    for (let i = 0; i < FLOORS; i++) this.slots.push({ sid: null, y: floorY(i), yTarget: floorY(i), r: 0, dir: new THREE.Vector2(1, 0), anim: null, scale: 0, scaleTarget: 0 });
  }

  /** New front-page order: floors that jump slide out, travel, and slide back in. */
  setOrder(order: number[], titles: Record<number, [string, number, number, string, string]>, act: Record<number, number>, now: number, camDir: THREE.Vector2, people: Record<number, number> = {}) {
    const keep = new Set(order);
    let moved = false;
    this.slots.forEach((s) => { if (s.sid !== null && !keep.has(s.sid)) { this.slotOf.delete(s.sid); s.sid = null; s.scaleTarget = 0; } });
    order.forEach((sid, rank) => {
      let si = this.slotOf.get(sid);
      const target = floorY(rank);
      if (si === undefined) {
        si = this.slots.findIndex((s) => s.sid === null && s.scale < 0.01);
        if (si < 0) si = this.slots.findIndex((s) => s.sid === null);
        const s = this.slots[si];
        s.sid = sid; s.y = target; s.yTarget = target; s.r = 11; s.scale = 1; s.scaleTarget = 1;
        s.dir.set(-camDir.y, camDir.x);                  // sideways to the viewer, so the move reads
        s.anim = { t0: now, from: target, to: target, dur: 1.6, out: 11 };
        (this.aState.array as Float32Array)[si * 3 + 1] = 1;
        this.slotOf.set(sid, si);
      } else {
        const s = this.slots[si];
        const prevRank = this.rankOf.get(sid) ?? rank;
        if (Math.abs(prevRank - rank) >= 2) {
          s.anim = { t0: now, from: s.y, to: target, dur: 2.2, out: 4.4 }; s.dir.set(-camDir.y, camDir.x); moved = true;
          (this.aState.array as Float32Array)[si * 3 + 1] = 1;
        }
        s.yTarget = target; s.scaleTarget = 1;
      }
      this.rankOf.set(sid, rank);
      const t = titles[sid];
      if (t) this.label(si, rank, t);
      const light = this.aLight.array as Float32Array;
      light[si * 2] = clampN(0.1 + Math.log1p(act[sid] ?? 0) / 3.2 + Math.log1p(t?.[2] ?? 0) / 14, 0.08, 0.72);
      // front-page threads run from a handful of people to nearly a thousand: six hundred fill a floor
      light[si * 2 + 1] = clampN(Math.log1p(people[sid] ?? 0) / Math.log1p(600), 0.04, 0.92);
    });
    this.aLight.needsUpdate = true; this.aState.needsUpdate = true;
    if (moved) this.onMove();
  }

  /** what each slot's sign says now: a row is redrawn (and the 16 MB atlas re-uploaded) only when that changes */
  private drawn: string[] = [];
  private label(slot: number, rank: number, t: [string, number, number, string, string]) {
    const said = `${rank}|${t[0]}`;
    if (this.drawn[slot] === said) return;
    this.drawn[slot] = said;
    const g = this.atlas.getContext('2d')!, y = slot * 64;
    g.save();
    g.clearRect(0, y, 2048, 64);
    g.fillStyle = '#05060a'; g.fillRect(0, y, 2048, 64);
    // a copy of the sign is 2πR/3 ≈ 14.7 m by BAND_H (26:1), drawn from a 32:1 row: draw wide to stay true
    const k = 32 / (2 * Math.PI * R / 3 / BAND_H);
    g.scale(k, 1);
    const W = 2048 / k;
    g.textBaseline = 'middle';
    const sans = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
    g.font = `700 44px ${sans}`;
    g.fillStyle = '#ff7a2e'; g.fillText(`${rank + 1}`, 26, y + 34);
    g.font = `650 44px ${sans}`;
    g.fillStyle = '#f6efe4';
    let title = t[0];
    const maxW = W - 108 - 30;
    if (g.measureText(title).width > maxW) { while (title.length && g.measureText(title + '…').width > maxW) title = title.slice(0, -1); title = title.trimEnd() + '…'; }
    g.fillText(title, 108, y + 34);
    g.restore();
    this.atlasTex.needsUpdate = true;
  }

  /** A comment just landed on this story: its windows flash. */
  pulse(sid: number) {
    const si = this.slotOf.get(sid);
    if (si === undefined) return;
    (this.aState.array as Float32Array)[si * 3 + 1] = 1;
    this.aState.needsUpdate = true;
  }

  setSelected(slot: number) {
    const a = this.aState.array as Float32Array;
    for (let i = 0; i < FLOORS; i++) a[i * 3] = i === slot ? 1 : 0;
    this.aState.needsUpdate = true;
  }

  update(now: number, dt: number) {
    const v = new THREE.Vector3(), s3 = new THREE.Vector3();
    // three copies round each band: copy 0 is centred at 60°; the sign's two copies at 90°
    this.qFace.setFromAxisAngle(this.yAxis, this.faceYaw - Math.PI / 3);
    this.sign.rotation.y = this.faceYaw - Math.PI / 2;
    for (let i = 0; i < FLOORS; i++) {
      const s = this.slots[i];
      if (s.anim) {
        const k = (now - s.anim.t0) / s.anim.dur;
        if (k >= 1) { s.anim = null; s.r = 0; s.y = s.yTarget; }
        else {
          // out (0..0.25) -> travel (0.25..0.75) -> in (0.75..1)
          const out = k < 0.25 ? easeInOut(k / 0.25) : k < 0.75 ? 1 : 1 - easeInOut((k - 0.75) / 0.25);
          const travel = k < 0.25 ? 0 : k < 0.75 ? easeInOut((k - 0.25) / 0.5) : 1;
          s.r = out * s.anim.out;
          s.y = s.anim.from + (s.yTarget - s.anim.from) * travel;
        }
      } else {
        s.y += (s.yTarget - s.y) * (1 - Math.exp(-dt * 3));
      }
      s.scale += (s.scaleTarget - s.scale) * (1 - Math.exp(-dt * 4));
      const hide = i === this.hidden || s.sid === null;
      const sc = hide ? 0 : s.scale;
      v.set(s.dir.x * s.r, s.y, s.dir.y * s.r);
      this.floors.setMatrixAt(i, this.m.compose(v, this.q, s3.set(i === this.doorSlot ? 0 : sc, i === this.doorSlot ? 0 : sc, i === this.doorSlot ? 0 : sc)));
      if (i === this.doorSlot) { this.door.visible = !hide; this.door.position.copy(v); this.door.scale.setScalar(sc); }
      v.y = s.y + BAND_Y;
      this.bands.setMatrixAt(i, this.m.compose(v, this.qFace, s3.set(sc, sc, sc)));
    }
    this.floors.instanceMatrix.needsUpdate = true;
    this.bands.instanceMatrix.needsUpdate = true;
    const st = this.aState.array as Float32Array;
    let any = false;
    for (let i = 0; i < FLOORS; i++) if (st[i * 3 + 1] > 0) { st[i * 3 + 1] = Math.max(0, st[i * 3 + 1] - dt * 0.7); any = true; }
    if (any) this.aState.needsUpdate = true;
    this.searchlights.rotation.y = now * 0.12;
  }
}

/**
 * The name in neon, round the crown: two copies, so one always faces you. Tubes are drawn as glowing strokes on
 * a dark backing ring; the orange "Of" is its own layer so it can buzz while the rest holds steady.
 */
function neonSign() {
  const W = 2048, H = 256;
  const layer = (draw: (g: CanvasRenderingContext2D) => void) => {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d')!;
    // one copy is πr ≈ 20.6 m by 1.7 m (12:1) from an 8:1 canvas: draw narrow so the letters keep their shape
    g.scale(0.66, 1);
    g.font = '600 168px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
    g.textBaseline = 'middle'; g.lineJoin = 'round'; g.lineCap = 'round';
    draw(g);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  };
  const parts = ['Tower', 'Of', 'Han'];
  const widths = (g: CanvasRenderingContext2D) => parts.map((p) => g.measureText(p).width);
  const tube = (g: CanvasRenderingContext2D, text: string, x: number, glow: string, core: string) => {
    g.shadowColor = glow; g.shadowBlur = 26;
    g.strokeStyle = glow; g.lineWidth = 15; g.strokeText(text, x, H / 2);
    g.shadowBlur = 8;
    g.strokeStyle = core; g.lineWidth = 6; g.strokeText(text, x, H / 2);
  };
  const layout = (g: CanvasRenderingContext2D) => {
    const w = widths(g), gap = 6, total = w[0] + w[1] + w[2] + gap * 2;
    const x0 = (W / 0.66 - total) / 2;
    return [x0, x0 + w[0] + gap, x0 + w[0] + w[1] + gap * 2];
  };
  const base = layer((g) => { const x = layout(g); tube(g, 'Tower', x[0], '#ff9a6b', '#fff1e6'); tube(g, 'Han', x[2], '#ff9a6b', '#fff1e6'); });
  const of = layer((g) => { const x = layout(g); tube(g, 'Of', x[1], '#ff5a0a', '#ffd2b0'); });
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const tuv = vec2(fract(uv().x.mul(2)), uv().y);
  const a = texture(base, tuv), b = texture(of, tuv);
  mat.colorNode = a.rgb.mul(a.a).mul(uNeon).add(b.rgb.mul(b.a).mul(uNeonOf)).mul(2.2);
  const g = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(R - 0.45, R - 0.45, 1.7, 128, 1, true), mat);
  // the sign's dark backing: it reads as a sign with something behind it, and hides the far side's tubes
  const backing = new THREE.Mesh(new THREE.CylinderGeometry(R - 0.6, R - 0.6, 1.55, 96, 1, true), new THREE.MeshStandardNodeMaterial({ color: 0x0b0c10, roughness: 0.8, metalness: 0.3 }));
  g.add(backing, ring);
  g.position.y = TOWER_TOP + 1.2 + 0.95;
  return g;
}
