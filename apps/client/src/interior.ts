// A floor's interior: a warm room in the tower, tables for conversations,
// a bar for one-off remarks, and the people placed at them.
import * as THREE from 'three/webgpu';
import { positionWorld, vec3, fract, smoothstep, abs, hash, floor as tfloor, mix, float, uv, sin } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { R, FLOOR_H, uTime } from './world.ts';
import type { Floor, Table } from './sync.ts';
import type { Pose } from './people.ts';

export interface TableSpot { index: number; table: Table; pos: THREE.Vector3; radius: number; seats: { name: string; pos: THREE.Vector3; facing: number; seated: boolean }[]; bar: boolean; /** bar only: comment -> its table */ tableOf?: Map<number, number> }

const MAX_TABLES = 10, MAX_BAR = 12, BAR_ANGLE = -Math.PI / 2, BAR_SPAN = 1.25;

export class Interior {
  group = new THREE.Group();
  tableMesh: THREE.InstancedMesh;
  private chairMesh: THREE.InstancedMesh;
  private lampMesh: THREE.InstancedMesh;
  private lights: THREE.PointLight[] = [];
  spots: TableSpot[] = [];

  constructor() {
    // floor: warm wood planks
    const fmat = new THREE.MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0.0 });
    const plank = fract(positionWorld.x.mul(2.2));
    const id = tfloor(positionWorld.x.mul(2.2));
    const tone = hash(id.add(tfloor(positionWorld.z.mul(0.5).add(hash(id).mul(3)))));
    fmat.colorNode = mix(vec3(0.24, 0.14, 0.08), vec3(0.34, 0.2, 0.11), tone).mul(smoothstep(0.0, 0.04, plank).mul(0.25).add(0.75));
    const floor = new THREE.Mesh(new THREE.CircleGeometry(R - 0.04, 96), fmat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.01;
    // a soft rug under the conversation area
    const rmat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95 });
    const rr = uv().sub(0.5).length();
    rmat.colorNode = mix(vec3(0.18, 0.07, 0.06), vec3(0.28, 0.12, 0.08), smoothstep(0.32, 0.5, rr).mul(sin(rr.mul(80)).mul(0.5).add(0.5)).mul(0.6));
    const rug = new THREE.Mesh(new THREE.CircleGeometry(4.2, 64), rmat);
    rug.rotation.x = -Math.PI / 2; rug.position.y = 0.02; rug.position.z = 0.6;
    // ceiling (the floor above's slab is hidden from inside, so give the room a lid)
    const cmat = new THREE.MeshStandardNodeMaterial({ color: 0x14100d, roughness: 0.9, side: THREE.DoubleSide });
    const ceil = new THREE.Mesh(new THREE.CircleGeometry(R, 72), cmat);
    ceil.rotation.x = Math.PI / 2; ceil.position.y = FLOOR_H * 0.93;
    // window mullions all the way round: you are inside a tower
    const posts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.06, FLOOR_H * 0.93, 0.08), new THREE.MeshStandardNodeMaterial({ color: 0x1b1d24, metalness: 0.8, roughness: 0.3 }), 56);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion();
    for (let i = 0; i < 56; i++) {
      const a = (i / 56) * Math.PI * 2;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), a);
      posts.setMatrixAt(i, m.compose(new THREE.Vector3(Math.sin(a) * (R - 0.05), FLOOR_H * 0.465, Math.cos(a) * (R - 0.05)), q, new THREE.Vector3(1, 1, 1)));
    }
    // the bar: a curved counter along the back
    const bmat = new THREE.MeshStandardNodeMaterial({ roughness: 0.35, metalness: 0.2 });
    bmat.colorNode = vec3(0.16, 0.08, 0.05);
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(R - 1.05, R - 1.05, 0.95, 64, 1, true, Math.PI - BAR_SPAN / 2, BAR_SPAN), bmat);
    bar.position.y = 0.475;
    bar.material.side = THREE.DoubleSide;
    const topMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.25, metalness: 0.1 });
    topMat.colorNode = vec3(0.32, 0.2, 0.12);
    const barTop = new THREE.Mesh(new THREE.RingGeometry(R - 1.32, R - 0.85, 64, 1, BAR_ANGLE - BAR_SPAN / 2 + Math.PI, BAR_SPAN), topMat);
    barTop.rotation.x = -Math.PI / 2; barTop.position.y = 0.96;
    // a glowing shelf of bottles behind the bar
    const shelfMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.4 });
    shelfMat.colorNode = vec3(0.05, 0.04, 0.04);
    shelfMat.emissiveNode = vec3(1.0, 0.62, 0.3).mul(smoothstep(0.45, 0.5, fract(uv().x.mul(40))).mul(smoothstep(0.3, 0.7, uv().y)).mul(0.35));
    const shelf = new THREE.Mesh(new THREE.CylinderGeometry(R - 0.25, R - 0.25, 0.7, 64, 1, true, Math.PI - BAR_SPAN / 2, BAR_SPAN), shelfMat);
    shelf.position.y = 1.0; shelf.material.side = THREE.DoubleSide;

    // tables (top + stem + foot), chairs, pendant lamps: one instanced draw each
    const top = new THREE.CylinderGeometry(1, 1, 0.05, 48); top.translate(0, 0.74, 0);
    const stem = new THREE.CylinderGeometry(0.05, 0.05, 0.7, 12); stem.translate(0, 0.37, 0);
    const foot = new THREE.CylinderGeometry(0.28, 0.32, 0.03, 24); foot.translate(0, 0.015, 0);
    const tmat = new THREE.MeshStandardNodeMaterial({ roughness: 0.3, metalness: 0.05 });
    tmat.colorNode = mix(vec3(0.3, 0.16, 0.09), vec3(0.42, 0.24, 0.13), smoothstep(0.6, 1.0, uv().y));
    this.tableMesh = new THREE.InstancedMesh(mergeGeometries([top, stem, foot]), tmat, MAX_TABLES);
    const seat = new THREE.BoxGeometry(0.36, 0.05, 0.36); seat.translate(0, 0.42, 0);
    const back = new THREE.BoxGeometry(0.36, 0.42, 0.04); back.translate(0, 0.64, -0.17);
    const legs = [[-0.15, -0.15], [0.15, -0.15], [-0.15, 0.15], [0.15, 0.15]].map(([x, z]) => { const g = new THREE.CylinderGeometry(0.018, 0.018, 0.42, 6); g.translate(x, 0.21, z); return g; });
    this.chairMesh = new THREE.InstancedMesh(mergeGeometries([seat, back, ...legs]), new THREE.MeshStandardNodeMaterial({ color: 0x2b211c, roughness: 0.6 }), 160);
    const lampMat = new THREE.MeshBasicNodeMaterial();
    lampMat.colorNode = vec3(1.0, 0.78, 0.5).mul(float(2.2).add(sin(uTime.mul(2.0)).mul(0.03)));
    const shade = new THREE.ConeGeometry(0.24, 0.2, 24, 1, true); shade.translate(0, FLOOR_H * 0.8, 0);
    const bulb = new THREE.SphereGeometry(0.06, 12, 8); bulb.translate(0, FLOOR_H * 0.77, 0);
    const cord = new THREE.CylinderGeometry(0.005, 0.005, FLOOR_H * 0.1, 4); cord.translate(0, FLOOR_H * 0.88, 0);
    this.lampMesh = new THREE.InstancedMesh(mergeGeometries([shade, bulb, cord]), lampMat, MAX_TABLES + 3);
    for (const im of [this.tableMesh, this.chairMesh, this.lampMesh]) { im.frustumCulled = false; im.count = 0; }
    // warm light: a few lights for the whole room, placed over the busiest tables
    for (let i = 0; i < 3; i++) {
      const l = new THREE.PointLight(0xffc48a, 9, 7.5, 1.6);
      this.lights.push(l);
      this.group.add(l);
    }
    const fill = new THREE.HemisphereLight(0xffd7b0, 0x2a1c14, 0.55);
    this.group.add(floor, rug, ceil, posts, bar, barTop, shelf, this.tableMesh, this.chairMesh, this.lampMesh, fill);
    this.group.visible = false;
  }

  /** Lay the room out for this floor and return where everyone stands or sits. */
  layout(floor: Floor, yaw = 0): { spots: TableSpot[]; people: { name: string; pose: Pose }[] } {
    const convo = floor.tables.map((t, i) => ({ t, i })).filter(({ t }) => t.turns.length >= 2).slice(0, MAX_TABLES);
    const remarks = floor.tables.map((t, i) => ({ t, i })).filter(({ t }) => t.turns.length === 1).slice(0, MAX_BAR);
    // conversation tables on two rings, keeping clear of the bar at the back
    const places: THREE.Vector3[] = [];
    const inner = Math.min(3, convo.length), outer = convo.length - inner;
    for (let k = 0; k < inner; k++) {
      const a = Math.PI / 2 + (k - (inner - 1) / 2) * 1.25;
      places.push(new THREE.Vector3(Math.cos(a) * 1.9, 0, Math.sin(a) * 1.9 + 0.3));
    }
    for (let k = 0; k < outer; k++) {
      const span = Math.PI * 1.25, a = Math.PI / 2 - span / 2 + (outer === 1 ? span / 2 : (k / (outer - 1)) * span);
      places.push(new THREE.Vector3(Math.cos(a) * 4.5, 0, Math.sin(a) * 4.5 + 0.2));
    }
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const people: { name: string; pose: Pose }[] = [];
    const spots: TableSpot[] = [];
    let chair = 0;
    convo.forEach(({ t, i }, k) => {
      const pos = places[k];
      const seated = t.seated.slice(0, 8), standing = t.standing.slice(0, 5);
      const radius = 0.42 + seated.length * 0.055;
      this.tableMesh.setMatrixAt(k, m.compose(pos, q.identity(), s.set(radius, 1, radius)));
      if (k < MAX_TABLES) this.lampMesh.setMatrixAt(k, m.compose(pos, q.identity(), s.set(1, 1, 1)));
      const seats: TableSpot['seats'] = [];
      seated.forEach((name, j) => {
        const a = (j / seated.length) * Math.PI * 2 + k * 0.7;
        const p = pos.clone().add(new THREE.Vector3(Math.cos(a) * (radius + 0.3), 0, Math.sin(a) * (radius + 0.3)));
        const facing = Math.atan2(pos.x - p.x, pos.z - p.z);
        seats.push({ name, pos: p, facing, seated: true });
        q.setFromAxisAngle(up, facing);
        if (chair < 160) this.chairMesh.setMatrixAt(chair++, m.compose(p.clone().sub(new THREE.Vector3(Math.sin(facing), 0, Math.cos(facing)).multiplyScalar(0.02)), q, s.set(1, 1, 1)));
      });
      standing.forEach((name, j) => {
        const a = (j / Math.max(1, standing.length)) * Math.PI * 2 + 0.4 + k;
        const p = pos.clone().add(new THREE.Vector3(Math.cos(a) * (radius + 0.95), 0, Math.sin(a) * (radius + 0.95)));
        seats.push({ name, pos: p, facing: Math.atan2(pos.x - p.x, pos.z - p.z), seated: false });
      });
      for (const st of seats) people.push({ name: st.name, pose: { pos: st.pos, facing: st.facing, seated: st.seated } });
      spots.push({ index: i, table: t, pos, radius, seats, bar: false });
    });
    // the bar: one-off remarks, standing along the counter, facing into the room
    remarks.forEach(({ t, i }, k) => {
      const a = BAR_ANGLE + (remarks.length === 1 ? 0 : (k / (remarks.length - 1) - 0.5) * (BAR_SPAN - 0.15));
      const p = new THREE.Vector3(Math.cos(a) * (R - 1.6), 0, Math.sin(a) * (R - 1.6));
      const name = t.turns[0].by;
      const facing = Math.atan2(-p.x, -p.z) + (k % 2 ? 0.25 : -0.25);
      people.push({ name, pose: { pos: p, facing, seated: false } });
      spots.push({ index: i, table: t, pos: p, radius: 0.3, seats: [{ name, pos: p, facing, seated: false }], bar: true });
    });
    this.tableMesh.count = convo.length;
    this.lampMesh.count = Math.min(convo.length, MAX_TABLES);
    this.chairMesh.count = chair;
    for (const im of [this.tableMesh, this.chairMesh, this.lampMesh]) im.instanceMatrix.needsUpdate = true;
    // lights over the first tables (the best by HN's ranking), else spread
    this.lights.forEach((l, k) => {
      const p = places[k] ?? new THREE.Vector3(Math.cos(k * 2.1) * 3, 0, Math.sin(k * 2.1) * 3);
      l.position.set(p.x, FLOOR_H * 0.72, p.z);
    });
    // turn the room to face the way we came in: rotate everything placed in world space
    this.group.rotation.y = yaw;
    const Y = new THREE.Vector3(0, 1, 0), seen = new Set<THREE.Vector3>();
    const rot = (v: THREE.Vector3) => { if (!seen.has(v)) { seen.add(v); v.applyAxisAngle(Y, yaw); } };
    for (const sp of spots) { rot(sp.pos); for (const st of sp.seats) { rot(st.pos); st.facing += yaw; } }
    people.length = 0;
    for (const sp of spots) for (const st of sp.seats) people.push({ name: st.name, pose: { pos: st.pos, facing: st.facing, seated: st.seated } });
    this.spots = spots;
    return { spots, people };
  }
}
