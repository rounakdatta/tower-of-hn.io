// The building, drawn (FLOOR_TIMELINE): the hall that holds a whole floor (building.ts says where everything is),
// its wood floor, its glass, a high dark ceiling with a skylight, and every table with its chairs and its lamp. All
// of it is a handful of instanced draws however many tables there are, and nothing here costs the CPU per frame but
// a few numbers per table: how lit each table is (it opens dark and lights with its first comment), how lively (a
// comment brightens its lamp and the warm pool of light under it, which fades as the table goes quiet), and which
// one has the floor. Those are what you see from across the hall, or from above while scrubbing: where the
// conversation is, and how much of it there is.
//
// Coming in from the tower, the hall is first only as wide as the tower's own room (the glass you flew through);
// then its walls draw back to where the floor needs them, a warm line running out across the boards ahead of them,
// and everything beyond appears as the line passes. Everything of the hall is drawn only inside that circle (uClip).
import * as THREE from 'three/webgpu';
import { positionWorld, vec3, fract, smoothstep, hash, floor as tfloor, mix, float, uv, sin, uniform, instancedBufferAttribute, length, vec2, abs, min } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FLOOR_H, uTime, R as TOWER_R } from './world.ts';
import { uLift } from './interior.ts';
import type { Plan } from './building.ts';

/** towerd's floors have at most 60 tables */
export const HALL_TABLES = 64;
const HALL_CHAIRS = HALL_TABLES * 8;
const Y_AXIS = new THREE.Vector3(0, 1, 0);
/** a pendant lamp hangs this high over its table */
const LAMP_Y = FLOOR_H * 0.8;

/** how a table looks right now: opened (0..1, eased), its glow (0..), whether it has the floor (0..1, eased) */
export interface TableLook { lit: number; glow: number; focus: number }

export class HallView {
  group = new THREE.Group();
  /** the hall is drawn inside this radius (room space, round the middle): the walls drawing back as you come in */
  readonly uClip = uniform(TOWER_R);
  /** the warm line at the clip's edge while it moves (0: none) */
  readonly uEdge = uniform(0);
  R = TOWER_R;
  height = FLOOR_H * 0.93;
  private floorMesh: THREE.Mesh;
  private ceil: THREE.Mesh;
  private edge: THREE.Mesh;
  private posts: THREE.InstancedMesh;
  private tables: THREE.InstancedMesh;
  private chairs: THREE.InstancedMesh;
  private lamps: THREE.InstancedMesh;
  private pools: THREE.InstancedMesh;
  /** per table: [lit, glow (eased, for the light), focus, -] */
  private aTable: THREE.InstancedBufferAttribute;
  /** per chair: its table's lit (a chair of a table that hasn't opened is pushed in, in the dark) */
  private aChair: THREE.InstancedBufferAttribute;
  private chairOf: Int16Array = new Int16Array(HALL_CHAIRS);
  private postsAt = -1;
  private postCount = 0;
  private reveal: { from: number; to: number; at: number; dur: number } | null = null;
  /** the lift, in the hall's glass */
  readonly lift = new THREE.Group();
  /** Put the lift in the glass in the direction of (x, z) from the middle (the door the room was given), facing in. */
  setLift(x: number, z: number) {
    const d = Math.hypot(x, z) || 1, r = this.R - 0.14;
    this.lift.position.set((x / d) * r, 1.06, (z / d) * r);
    this.lift.lookAt(0, 1.06 + this.group.position.y, 0);
  }
  /** the three warm lights of the room: over the liveliest tables, moving with the conversation */
  lights: THREE.PointLight[] = [];
  private fill: THREE.HemisphereLight;

  constructor() {
    const inside = this.inside();
    // the floor: the tower's warm planks, laid across the whole hall (world-space: the boards don't stretch as it grows)
    const fmat = new THREE.MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0.0 });
    const plank = fract(positionWorld.x.mul(2.2)), id = tfloor(positionWorld.x.mul(2.2));
    const tone = hash(id.add(tfloor(positionWorld.z.mul(0.5).add(hash(id).mul(3)))));
    fmat.colorNode = mix(vec3(0.24, 0.14, 0.08), vec3(0.34, 0.2, 0.11), tone).mul(smoothstep(0.0, 0.04, plank).mul(0.25).add(0.75));
    this.floorMesh = new THREE.Mesh(new THREE.CircleGeometry(1, 160), fmat);
    this.floorMesh.rotation.x = -Math.PI / 2; this.floorMesh.position.y = 0.012;
    // the ceiling: dark wood, a skylight over the middle of the hall (the night, a few stars), a ring of warm light
    const cmat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    const rr = uv().sub(0.5).length().mul(2);
    const star = smoothstep(0.996, 0.999, hash(tfloor(uv().mul(420)).dot(vec2(1, 57))));
    cmat.colorNode = mix(vec3(0.075, 0.09, 0.15), vec3(0.03, 0.035, 0.06), smoothstep(0.05, 0.34, rr)).add(star.mul(0.7).mul(smoothstep(0.36, 0.2, rr)))
      .mul(smoothstep(0.36, 0.34, rr)).add(vec3(0.045, 0.036, 0.03).mul(smoothstep(0.34, 0.36, rr)))
      .add(vec3(1.0, 0.7, 0.42).mul(smoothstep(0.01, 0.0, abs(rr.sub(0.35))).mul(1.4)));
    this.ceil = new THREE.Mesh(new THREE.CircleGeometry(1, 128), cmat);
    this.ceil.rotation.x = Math.PI / 2;
    // the warm line where the hall is being revealed
    const emat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const er = uv().sub(0.5).length().mul(2);
    emat.colorNode = vec3(1.0, 0.68, 0.38).mul(smoothstep(0.94, 1.0, er).mul(smoothstep(1.0, 0.995, er)).mul(this.uEdge).mul(2.2));
    this.edge = new THREE.Mesh(new THREE.CircleGeometry(1, 160), emat);
    this.edge.rotation.x = -Math.PI / 2; this.edge.position.y = 0.02;
    // the glass's mullions, all the way round (placed by update(): they stand at the clip's edge while the walls move)
    this.posts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.07, 1, 0.09), new THREE.MeshStandardNodeMaterial({ color: 0x1b1d24, metalness: 0.8, roughness: 0.3 }), 420);
    this.posts.count = 0;

    // tables, chairs, lamps, and the pools of light under the tables: one instanced draw each
    this.aTable = new THREE.InstancedBufferAttribute(new Float32Array(HALL_TABLES * 4), 4);
    this.aChair = new THREE.InstancedBufferAttribute(new Float32Array(HALL_CHAIRS), 1);
    const look = instancedBufferAttribute(this.aTable);
    const lit = look.x, glow = look.y, focus = look.z;
    const top = new THREE.CylinderGeometry(1, 1, 0.05, 48); top.translate(0, 0.74, 0);
    const stem = new THREE.CylinderGeometry(0.05, 0.05, 0.7, 12); stem.translate(0, 0.37, 0);
    const foot = new THREE.CylinderGeometry(0.28, 0.32, 0.03, 24); foot.translate(0, 0.015, 0);
    const tmat = new THREE.MeshStandardNodeMaterial({ roughness: 0.3, metalness: 0.05 });
    // (a table that hasn't opened yet is the same wood, a shade darker: furniture waiting, not missing)
    tmat.colorNode = mix(vec3(0.3, 0.16, 0.09), vec3(0.42, 0.24, 0.13), smoothstep(0.6, 1.0, uv().y)).mul(mix(float(0.55), float(1), lit));
    tmat.maskNode = inside;
    this.tables = new THREE.InstancedMesh(mergeGeometries([top, stem, foot]), tmat, HALL_TABLES);
    const seat = new THREE.BoxGeometry(0.36, 0.05, 0.36); seat.translate(0, 0.42, 0);
    const back = new THREE.BoxGeometry(0.36, 0.42, 0.04); back.translate(0, 0.64, -0.17);
    const legs = [[-0.15, -0.15], [0.15, -0.15], [-0.15, 0.15], [0.15, 0.15]].map(([x, z]) => { const g = new THREE.CylinderGeometry(0.018, 0.018, 0.42, 6); g.translate(x, 0.21, z); return g; });
    const cm = new THREE.MeshStandardNodeMaterial({ roughness: 0.6 });
    cm.colorNode = vec3(0.17, 0.13, 0.11).mul(mix(float(0.6), float(1), instancedBufferAttribute(this.aChair)));
    cm.maskNode = inside;
    this.chairs = new THREE.InstancedMesh(mergeGeometries([seat, back, ...legs]), cm, HALL_CHAIRS);
    // the lamp: dark until the table opens; then warm, brighter with every comment, a touch brighter still with the floor
    const lmat = new THREE.MeshBasicNodeMaterial();
    // (the tower's own lamps burn at about 2.2: a quiet open table a little under that, a busy one a little over)
    const warmth = lit.mul(float(1.35).add(min(glow, float(2.0)).mul(0.45))).add(focus.mul(0.3));
    lmat.colorNode = mix(vec3(0.05, 0.045, 0.04), vec3(1.0, 0.7, 0.4).mul(warmth.add(sin(uTime.mul(2.0)).mul(0.02))), smoothstep(0.0, 0.08, lit));
    lmat.maskNode = inside;
    const shade = new THREE.ConeGeometry(0.24, 0.2, 24, 1, true); shade.translate(0, LAMP_Y, 0);
    const bulb = new THREE.SphereGeometry(0.06, 12, 8); bulb.translate(0, LAMP_Y - 0.03, 0);
    this.lamps = new THREE.InstancedMesh(mergeGeometries([shade, bulb]), lmat, HALL_TABLES);
    // the pool of light on the boards under a table: what reads from the far side of the hall (and from above)
    const pmat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const d = uv().sub(0.5).length().mul(2);
    const pool = smoothstep(1.0, 0.0, d).pow(1.6);
    pmat.colorNode = vec3(1.0, 0.62, 0.3).mul(pool.mul(lit.mul(float(0.05).add(min(glow, float(2.5)).mul(0.11))).add(focus.mul(0.08))));
    pmat.maskNode = inside;
    this.pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), pmat, HALL_TABLES);
    for (const im of [this.posts, this.tables, this.chairs, this.lamps, this.pools]) { im.frustumCulled = false; im.count = 0; }
    this.pools.renderOrder = 1;
    for (let i = 0; i < 3; i++) { const l = new THREE.PointLight(0xffc48a, 0, 9, 1.6); this.lights.push(l); this.group.add(l); }
    this.fill = new THREE.HemisphereLight(0xffd7b0, 0x2a1c14, 0.5);
    // the lift, in the glass (setLift puts it where the door is): a dark frame round a warm doorway that brightens as
    // someone comes in (uLift, as in the tower's own room), its chime the sign someone has walked in
    const frame = new THREE.Mesh(new THREE.BoxGeometry(1.25, 2.12, 0.1), new THREE.MeshStandardNodeMaterial({ color: 0x23201d, metalness: 0.7, roughness: 0.35 }));
    const glowMat = new THREE.MeshBasicNodeMaterial();
    glowMat.colorNode = vec3(1.0, 0.74, 0.46).mul(uLift.mul(2.4).add(0.18));
    const doorway = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 1.95), glowMat);
    doorway.position.z = 0.06;
    (frame.material as THREE.MeshStandardNodeMaterial).maskNode = inside; glowMat.maskNode = inside;
    this.lift.add(frame, doorway);
    // (no cords: from above, the hall's worth of them crossed the whole picture; the lamps hang in the dark)
    this.group.add(this.floorMesh, this.edge, this.ceil, this.posts, this.tables, this.chairs, this.lamps, this.pools, this.fill, this.lift);
    this.group.visible = false;
  }

  /** drawn only inside the clip circle (room space: the group sits on the tower's axis) */
  inside() {
    return length(vec2(positionWorld.x, positionWorld.z)).lessThan(this.uClip);
  }

  /** Lay the hall out for a floor's plan (room space, already turned to face the way we came in). */
  build(plan: Plan, roomY: number) {
    this.R = plan.R;
    // a high hall for a wide floor (a ceiling at a man's height over fifty metres of floor is a cellar), never lower
    // than the tower's own room
    this.height = Math.max(FLOOR_H * 0.93, Math.min(11, plan.R * 0.3));
    this.group.position.y = roomY;
    this.ceil.position.y = this.height;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    let chair = 0;
    const n = Math.min(HALL_TABLES, plan.tables.length);
    for (let k = 0; k < n; k++) {
      const t = plan.tables[k];
      this.tables.setMatrixAt(k, m.compose(p.set(t.x, 0, t.z), q.identity(), s.set(t.r, 1, t.r)));
      this.lamps.setMatrixAt(k, m.compose(p.set(t.x, 0, t.z), q.identity(), s.set(1, 1, 1)));
      const pr = t.r + 2.2;
      this.pools.setMatrixAt(k, m.compose(p.set(t.x, 0.025, t.z), q.identity(), s.set(pr * 2, 1, pr * 2)));
      for (const st of t.seats) {
        if (chair >= HALL_CHAIRS) break;
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), st.facing);
        // (the chair sits a little back from where its sitter's body is: the seat under them, the back behind)
        const bx = st.x - Math.sin(st.facing) * 0.02, bz = st.z - Math.cos(st.facing) * 0.02;
        this.chairs.setMatrixAt(chair, m.compose(p.set(bx, 0, bz), q, s.set(1, 1, 1)));
        this.chairOf[chair++] = k;
      }
      this.aTable.setXYZW(k, 0, 0, 0, 0);
    }
    for (const im of [this.tables, this.lamps, this.pools]) { im.count = n; im.instanceMatrix.needsUpdate = true; }
    this.chairs.count = chair; this.chairs.instanceMatrix.needsUpdate = true;
    (this.aChair.array as Float32Array).fill(0);
    this.aTable.needsUpdate = true; this.aChair.needsUpdate = true;
    this.postsAt = -1;
    this.group.visible = true;
  }

  /** Every frame, the tables as they are now (what the floor's clock says, eased by the caller). */
  setTables(looks: ArrayLike<TableLook>) {
    const a = this.aTable.array as Float32Array, n = Math.min(this.tables.count, looks.length);
    let changed = false;
    for (let k = 0; k < n; k++) {
      const l = looks[k], o = k * 4;
      if (a[o] !== l.lit || a[o + 1] !== l.glow || a[o + 2] !== l.focus) { a[o] = l.lit; a[o + 1] = l.glow; a[o + 2] = l.focus; changed = true; }
    }
    if (!changed) return;
    this.aTable.needsUpdate = true;
    const c = this.aChair.array as Float32Array;
    for (let i = 0; i < this.chairs.count; i++) c[i] = a[this.chairOf[i] * 4];
    this.aChair.needsUpdate = true;
  }

  /** the room's three warm lights over these tables (indices; fewer: the rest go dark), and how bright overall */
  /** how much of the room's light reaches the scene (0..1): faded in as we fly up to the glass, as the tower's room is */
  presence = 0;
  light(plan: Plan, which: number[], k: number) {
    k *= this.presence;
    this.lights.forEach((l, i) => {
      const t = plan.tables[which[i] ?? -1];
      if (!t) { l.intensity = 0; return; }
      l.position.set(t.x, LAMP_Y + 0.2, t.z);
      l.intensity = 9 * k;
    });
    this.fill.intensity = 0.42 * k + 0.08;
  }

  /** The walls draw back from the tower's glass to the hall's own, over `dur` seconds (0: at once). */
  open(now: number, dur = 1.8) {
    if (dur <= 0 || this.R <= TOWER_R + 0.01) { this.uClip.value = this.R + 0.6; this.reveal = null; this.uEdge.value = 0; this.place(this.R); return; }
    this.reveal = { from: TOWER_R, to: this.R + 0.6, at: now, dur };
  }
  /** ...and close in again (flying out): the hall is the tower's room again by the time we reach the glass */
  close(now: number, dur = 0.9) { this.reveal = { from: this.uClip.value, to: TOWER_R, at: now, dur }; }
  /** where the walls are, before they draw back (flying in: the tower's room) */
  shut() { this.reveal = null; this.uClip.value = TOWER_R; this.uEdge.value = 0; this.place(TOWER_R); }
  get opening() { return this.reveal !== null; }

  /** Per frame: the walls, if they're moving. */
  update(now: number) {
    const r = this.reveal;
    if (r) {
      const k = Math.min(1, Math.max(0, (now - r.at) / r.dur)), e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      this.uClip.value = r.from + (r.to - r.from) * e;
      this.uEdge.value = Math.sin(Math.PI * k) * (r.to > r.from ? 1 : 0.5);
      if (k >= 1) { this.reveal = null; this.uEdge.value = 0; }
    }
    const wall = Math.min(this.R, this.uClip.value);
    if (Math.abs(wall - this.postsAt) > 0.01) this.place(wall);
  }

  private tmp = { m: new THREE.Matrix4(), q: new THREE.Quaternion(), p: new THREE.Vector3(), s: new THREE.Vector3() };
  /** the floor, the ceiling, the edge line and the glass at radius w */
  private place(w: number) {
    this.postsAt = w;
    const fr = Math.max(0.1, w - 0.02);
    this.floorMesh.scale.set(fr, fr, 1);
    this.ceil.scale.set(w, w, 1);
    this.edge.scale.set(this.uClip.value, this.uClip.value, 1);
    this.edge.visible = this.uEdge.value > 0.001;
    const n = Math.min(420, Math.max(56, Math.round((Math.PI * 2 * w) / (w > 9 ? 1.6 : 0.8))));
    const { m, q, p, s } = this.tmp, h = this.height;
    s.set(1, h, 1);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      q.setFromAxisAngle(Y_AXIS, a);
      this.posts.setMatrixAt(i, m.compose(p.set(Math.sin(a) * (w - 0.05), h / 2, Math.cos(a) * (w - 0.05)), q, s));
    }
    this.posts.count = n; this.postCount = n;
    this.posts.instanceMatrix.needsUpdate = true;
  }

  /** the hall's materials on scraps, for the renderer to compile at start (so the first floor doesn't stall); take it away after */
  warm(): THREE.Object3D {
    const g = new THREE.Group(), geo = new THREE.PlaneGeometry(0.1, 0.1);
    for (const im of [this.tables, this.chairs, this.lamps, this.pools, this.posts]) g.add(new THREE.InstancedMesh(geo, im.material as THREE.Material, 1));
    g.add(new THREE.Mesh(geo, this.floorMesh.material as THREE.Material), new THREE.Mesh(geo, this.ceil.material as THREE.Material), new THREE.Mesh(geo, this.edge.material as THREE.Material));
    return g;
  }

  hide() { this.group.visible = false; this.reveal = null; }
  get posts$() { return this.postCount; }
}
