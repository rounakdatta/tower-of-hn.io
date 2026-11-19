// The world outside: sky, city, streets, snow, and the tower itself.
// Everything repeated is instanced; everything animated runs in shaders.
import * as THREE from 'three/webgpu';
import {
  uniform, instancedBufferAttribute, hash, step, fract, positionWorld, positionLocal, normalLocal, instanceIndex, mix,
  smoothstep, vec2, vec3, float, sin, uv, dot, floor as tfloor, abs, texture, max, min, normalize, pow, length, cos, clamp,
} from 'three/tsl';
import { clamp as clampN, easeInOut } from './util.ts';

export const FLOORS = 30, FLOOR_H = 2.4, R = 7, LOBBY_H = 4.2;
export const floorY = (rank: number) => LOBBY_H + (FLOORS - 1 - rank) * FLOOR_H + FLOOR_H / 2;
export const TOWER_TOP = LOBBY_H + FLOORS * FLOOR_H;

export const uTime = uniform(0);
export const uBeacon = uniform(0);     // 0..1, decays: a comment just landed

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
  const roofBlink = step(0.5, normalLocal.y).mul(step(0.97, bld)).mul(step(0.5, fract(uTime.mul(0.5).add(bld.mul(3)))));
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
  mat.opacityNode = smoothstep(0.5, 0.15, c).mul(0.75);
  const snow = new THREE.Sprite(mat);
  snow.count = count;
  snow.frustumCulled = false;
  scene.add(snow);
  return snow;
}

// ---------------------------------------------------------------- the tower
interface Slot { sid: number | null; y: number; yTarget: number; r: number; dir: THREE.Vector2; anim: { t0: number; from: number; to: number; dur: number; out: number } | null; scale: number; scaleTarget: number }

export class Tower {
  floors: THREE.InstancedMesh;
  bands: THREE.InstancedMesh;
  slots: Slot[] = [];
  slotOf = new Map<number, number>();
  rankOf = new Map<number, number>();
  private aGlow: THREE.InstancedBufferAttribute;
  private aSel: THREE.InstancedBufferAttribute;
  private atlas: HTMLCanvasElement;
  private atlasTex: THREE.CanvasTexture;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  hidden = -1;                          // slot whose slab is opened (we're inside it)
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
    scene.add(lobby, entrance, crown, spire, beacon);

    // floors: one instanced draw for all thirty
    const geo = new THREE.CylinderGeometry(R, R, FLOOR_H * 0.94, 96, 1);
    this.aGlow = new THREE.InstancedBufferAttribute(new Float32Array(FLOORS), 1);
    this.aSel = new THREE.InstancedBufferAttribute(new Float32Array(FLOORS), 1);
    geo.setAttribute('aGlow', this.aGlow); geo.setAttribute('aSel', this.aSel);
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.22, metalness: 0.85 });
    {
      const glow = instancedBufferAttribute(this.aGlow), sel = instancedBufferAttribute(this.aSel);
      const u = uv().x, v = uv().y;
      const cols = 132.0;
      const wu = fract(u.mul(cols)), wv = v;
      const pane = step(0.12, wu).mul(step(wu, 0.88)).mul(step(0.12, wv)).mul(step(wv, 0.74));   // leave the top band for the title
      const id = tfloor(u.mul(cols)).add(float(instanceIndex).mul(173.0));
      const r = hash(id);
      const lit = step(float(1).sub(glow), r);
      const flick = sin(uTime.mul(0.4).add(r.mul(60))).mul(0.05).add(0.95);
      const walls = step(abs(normalLocal.y), 0.5);
      const interiorTint = mix(vec3(1.0, 0.58, 0.26), vec3(1.0, 0.83, 0.58), hash(id.add(7)));
      const dimRoom = vec3(0.08, 0.1, 0.16).mul(pane).mul(walls);           // unlit glass still reads as glass
      mat.colorNode = mix(vec3(0.03, 0.035, 0.05), vec3(0.05, 0.06, 0.08), pane);
      mat.emissiveNode = interiorTint.mul(pane).mul(lit).mul(flick).mul(walls).mul(1.9)
        .add(dimRoom.mul(0.25))
        .add(vec3(1.0, 0.42, 0.1).mul(sel).mul(walls).mul(step(0.72, v)).mul(0.6));
    }
    this.floors = new THREE.InstancedMesh(geo, mat, FLOORS);
    this.floors.frustumCulled = false;

    // title bands: one instanced ring per floor, text from a shared atlas
    this.atlas = document.createElement('canvas');
    this.atlas.width = 2048; this.atlas.height = 2048;
    this.atlasTex = new THREE.CanvasTexture(this.atlas);
    this.atlasTex.colorSpace = THREE.SRGBColorSpace;
    this.atlasTex.anisotropy = 8;
    const bgeo = new THREE.CylinderGeometry(R + 0.02, R + 0.02, 0.34, 128, 1, true);
    const aRow = new THREE.InstancedBufferAttribute(new Float32Array(FLOORS).map((_, i) => i), 1);
    bgeo.setAttribute('aRow', aRow);
    const bmat = new THREE.MeshStandardNodeMaterial({ roughness: 0.5, metalness: 0.2 });
    {
      const row = instancedBufferAttribute(aRow);
      const tuv = vec2(fract(uv().x.mul(2)), float(1).sub(row.add(float(1).sub(uv().y)).div(32)));
      const t = texture(this.atlasTex, tuv);
      bmat.colorNode = vec3(0.02, 0.022, 0.03);
      bmat.emissiveNode = t.rgb.mul(1.35);
    }
    this.bands = new THREE.InstancedMesh(bgeo, bmat, FLOORS);
    this.bands.frustumCulled = false;
    scene.add(this.floors, this.bands);
    for (let i = 0; i < FLOORS; i++) this.slots.push({ sid: null, y: floorY(i), yTarget: floorY(i), r: 0, dir: new THREE.Vector2(1, 0), anim: null, scale: 0, scaleTarget: 0 });
  }

  /** New front-page order: floors that jump slide out, travel, and slide back in. */
  setOrder(order: number[], titles: Record<number, [string, number, number, string, string]>, act: Record<number, number>, now: number, camDir: THREE.Vector2) {
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
        s.sid = sid; s.y = target; s.yTarget = target; s.r = 9; s.scale = 1; s.scaleTarget = 1;
        s.dir.copy(camDir);
        s.anim = { t0: now, from: target, to: target, dur: 1.4, out: 9 };
        this.slotOf.set(sid, si);
      } else {
        const s = this.slots[si];
        const prevRank = this.rankOf.get(sid) ?? rank;
        if (Math.abs(prevRank - rank) >= 2) {
          s.anim = { t0: now, from: s.y, to: target, dur: 2.0, out: 2.6 }; s.dir.copy(camDir); moved = true;
        }
        s.yTarget = target; s.scaleTarget = 1;
      }
      this.rankOf.set(sid, rank);
      const t = titles[sid];
      if (t) this.label(si, rank, t);
      (this.aGlow.array as Float32Array)[si] = clampN(0.1 + Math.log1p(act[sid] ?? 0) / 3.2 + Math.log1p(t?.[2] ?? 0) / 14, 0.08, 1);
    });
    this.aGlow.needsUpdate = true;
    if (moved) this.onMove();
  }

  private label(slot: number, rank: number, t: [string, number, number, string, string]) {
    const g = this.atlas.getContext('2d')!, y = slot * 64;
    g.clearRect(0, y, 2048, 64);
    g.fillStyle = '#05060a'; g.fillRect(0, y, 2048, 64);
    g.textBaseline = 'middle';
    g.font = '600 34px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
    g.fillStyle = '#ff7a2e'; g.fillText(`${rank + 1}`, 28, y + 33);
    g.fillStyle = '#f3ede4';
    let title = t[0];
    const maxW = 1560;
    if (g.measureText(title).width > maxW) { while (title.length && g.measureText(title + '…').width > maxW) title = title.slice(0, -1); title += '…'; }
    g.fillText(title, 96, y + 33);
    g.font = '500 26px ui-sans-serif, system-ui, sans-serif';
    g.fillStyle = '#9aa3b6';
    const meta = `${t[1]} points · ${t[2]} comments`;
    g.fillText(meta, 2020 - g.measureText(meta).width, y + 34);
    this.atlasTex.needsUpdate = true;
  }

  setSelected(slot: number) {
    const a = this.aSel.array as Float32Array;
    for (let i = 0; i < FLOORS; i++) a[i] = i === slot ? 1 : 0;
    this.aSel.needsUpdate = true;
  }

  update(now: number, dt: number) {
    const v = new THREE.Vector3(), s3 = new THREE.Vector3();
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
      this.floors.setMatrixAt(i, this.m.compose(v, this.q, s3.set(sc, sc, sc)));
      v.y = s.y + FLOOR_H * 0.36;
      this.bands.setMatrixAt(i, this.m.compose(v, this.q, s3.set(sc, sc, sc)));
    }
    this.floors.instanceMatrix.needsUpdate = true;
    this.bands.instanceMatrix.needsUpdate = true;
  }
}
