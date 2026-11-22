// On a floor, on foot, as in a first-person game, and as good on a phone as at a desk.
//   Desktop: click and the mouse looks around (pointer lock; Esc gives it back); WASD or the arrows walk, Shift
//   hurries. A dot in the middle aims: click someone to meet them, a table to go up to it, the floor to walk there;
//   E sits down. Without the lock, dragging looks around too.
//   Phone: the left thumb walks (a stick appears wherever it lands), the right thumb looks round; a tap goes to
//   whatever was tapped (someone: their card; a table: beside it; the floor: there).
// Tables, people and the glass are in the way: you slide along them, never through. Steps ease in and out, and the
// view never bobs (a walking camera that bobs makes phones seasick).
import * as THREE from 'three/webgpu';
import { R } from './world.ts';

export const EYE = 1.5;                                  // eye height on a floor, metres

export interface Obstacle { x: number; z: number; r: number }

const WALK = 1.45, HURRY = 2.6;                          // metres a second
const ACCEL = 6.5;                                       // m/s², both ways: a step starts and stops, never a jolt
const LOOK = 0.0023;                                     // radians per mouse pixel, captured
const STICK = 52;                                        // px: how far the thumb stick reaches
const TAP_MS = 450, TAP_PX = 9;

interface Drag { x0: number; y0: number; t0: number; yaw0: number; pitch0: number; moved: boolean; stick: boolean }

export class WalkCam {
  enabled = false;
  pos = new THREE.Vector3();                             // on the floor (y unused)
  yaw = 0;                                               // facing: 0 looks toward +z
  pitch = -0.1;
  roomY = 0;
  /** where the camera looks: a cut to the table (sitting down) starts from here */
  look = new THREE.Vector3();
  /** what's in the way right now (tables, people) */
  obstacles: () => Obstacle[] = () => [];
  /** the lens for a composition fov (the rig widens it on tall screens) */
  lens: (fov: number) => number = (f) => f;
  /** a walking line round the tables (room.ts); straight by default */
  route: (a: THREE.Vector3, b: THREE.Vector3) => THREE.Vector3[] = (_a, b) => [b];
  onTap: (x: number, y: number) => void = () => {};
  onMove: () => void = () => {};
  /** E (or Enter): sit at the table you're beside */
  onUse: () => void = () => {};
  /** the mouse was captured or let go */
  onLock: (locked: boolean) => void = () => {};
  /** the mouse is captured (first person at a desk): the dot in the middle aims */
  locked = false;
  /** the last time the capture ended (an Esc that ended it must not also leave the floor) */
  unlockedAt = 0;
  private dest: { path: THREE.Vector3[]; face?: number } | null = null;
  private vel = new THREE.Vector2();                     // walking velocity on the floor (x, z)
  private keys = new Set<string>();
  private hurry = false;
  private drags = new Map<number, Drag>();
  private stickId = -1;
  private stickV = new THREE.Vector2();                  // the stick's push: x right, y forward, length <= 1
  private stickEl: HTMLDivElement;
  private knobEl: HTMLDivElement;
  private marker: THREE.Mesh;
  private markerMat: THREE.MeshBasicMaterial;
  private turnTo: number | null = null;
  private stall = { t: 0, left: Infinity };
  private obs: Obstacle[] = [];

  constructor(private camera: THREE.PerspectiveCamera, private el: HTMLElement, scene: THREE.Scene) {
    this.markerMat = new THREE.MeshBasicMaterial({ color: 0xffb27a, transparent: true, opacity: 0, depthWrite: false });
    this.marker = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.22, 40), this.markerMat);
    this.marker.rotation.x = -Math.PI / 2;
    this.marker.visible = false;
    scene.add(this.marker);
    // the thumb stick: a ring where the thumb landed, a knob that follows it
    this.stickEl = document.createElement('div'); this.stickEl.id = 'stick';
    this.knobEl = document.createElement('div'); this.knobEl.className = 'knob';
    this.stickEl.appendChild(this.knobEl);
    document.body.appendChild(this.stickEl);

    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', (e) => this.end(e.pointerId));
    el.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      const step = Math.max(-0.8, Math.min(0.8, -e.deltaY * 0.004));
      this.goTo(new THREE.Vector3(this.pos.x + Math.sin(this.yaw) * step, 0, this.pos.z + Math.cos(this.yaw) * step), undefined, false);
    }, { passive: false });
    addEventListener('keydown', (e) => {
      if (!this.enabled || e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement)?.closest?.('input, textarea, [contenteditable]')) return;
      const k = e.key.toLowerCase();
      this.hurry = e.shiftKey;
      if (k === 'e' || k === 'enter') { this.onUse(); return; }
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) { e.preventDefault(); this.keys.add(k); }
    });
    addEventListener('keyup', (e) => { this.keys.delete(e.key.toLowerCase()); this.hurry = e.shiftKey; });
    addEventListener('blur', () => { this.keys.clear(); this.hurry = false; });
    document.addEventListener('pointerlockchange', () => {
      const was = this.locked;
      this.locked = document.pointerLockElement === this.el;
      if (was && !this.locked) this.unlockedAt = performance.now();
      if (was !== this.locked) this.onLock(this.locked);
    });
  }

  /** Stand here, looking this way (after the flight in, or after standing up from a table). */
  begin(pos: THREE.Vector3, yaw: number, pitch = -0.1) {
    this.pos.set(pos.x, 0, pos.z); this.yaw = yaw; this.pitch = pitch;
    this.stop(); this.vel.set(0, 0); this.enabled = true;
  }
  /** Off the floor (sitting down, leaving): the mouse is given back, the stick put away. */
  disable() {
    this.enabled = false; this.keys.clear(); this.drags.clear(); this.endStick(); this.vel.set(0, 0);
    if (this.locked) document.exitPointerLock();
  }
  /** Capture the mouse (from a click, as browsers require). */
  capture() {
    if (this.locked || !this.enabled) return;
    try { (this.el.requestPointerLock() as unknown as Promise<void> | undefined)?.catch?.(() => {}); } catch { /* not allowed here */ }
  }
  release() { if (this.locked) document.exitPointerLock(); }

  /** Walk to p (inside the room, never into a table or a person), round whatever is in between, then face `face`. */
  goTo(p: THREE.Vector3, face?: number, mark = true) {
    const q = new THREE.Vector3(p.x, 0, p.z);
    for (const o of this.obstacles()) {                  // a tap on a table or a person: the nearest place beside it
      const dx = q.x - o.x, dz = q.z - o.z, d = Math.hypot(dx, dz);
      if (d >= o.r) continue;
      const ux = d > 1e-3 ? dx / d : this.pos.x - o.x, uz = d > 1e-3 ? dz / d : this.pos.z - o.z, n = Math.hypot(ux, uz) || 1;
      q.set(o.x + (ux / n) * (o.r + 0.05), 0, o.z + (uz / n) * (o.r + 0.05));
    }
    const r = Math.hypot(q.x, q.z);
    if (r > R - 0.6) q.multiplyScalar((R - 0.6) / r);
    this.dest = { path: this.route(this.pos, q), face };
    this.stall = { t: 0, left: Infinity };
    if (mark) { this.marker.position.set(q.x, this.roomY + 0.025, q.z); this.marker.visible = true; this.markerMat.opacity = 0.9; }
  }

  get walking() { return !!this.dest || this.keys.size > 0 || this.stickV.lengthSq() > 0 || this.vel.lengthSq() > 0.01; }

  // ---------------------------------------------------------------- pointers: a mouse, a thumb stick, a look drag
  private down(e: PointerEvent) {
    if (!this.enabled) return;
    if (e.pointerType === 'mouse' && this.locked) {      // captured: a click acts on what the dot is on
      this.drags.set(e.pointerId, { x0: 0, y0: 0, t0: performance.now(), yaw0: this.yaw, pitch0: this.pitch, moved: false, stick: false });
      return;
    }
    // a thumb low on the left walks; anything else looks round
    const stick = e.pointerType !== 'mouse' && this.stickId < 0 && e.clientX < innerWidth * 0.45 && e.clientY > innerHeight * 0.36;
    try { this.el.setPointerCapture(e.pointerId); } catch { /* gone already */ }
    this.drags.set(e.pointerId, { x0: e.clientX, y0: e.clientY, t0: performance.now(), yaw0: this.yaw, pitch0: this.pitch, moved: false, stick });
    if (stick) {
      this.stickId = e.pointerId;
      this.stickEl.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
      this.knobEl.style.transform = 'translate(-50%, -50%)';
      this.stickEl.classList.add('show');
    }
  }
  private move(e: PointerEvent) {
    if (!this.enabled) return;
    if (this.locked && e.pointerType === 'mouse') {
      this.yaw -= e.movementX * LOOK;
      this.pitch = Math.max(-0.75, Math.min(0.5, this.pitch - e.movementY * LOOK));
      return;
    }
    const g = this.drags.get(e.pointerId);
    if (!g) return;
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (!g.moved && Math.hypot(dx, dy) < TAP_PX) return;
    g.moved = true;
    if (g.stick) {
      const d = Math.hypot(dx, dy), k = d > STICK ? STICK / d : 1;
      this.knobEl.style.transform = `translate(calc(-50% + ${dx * k}px), calc(-50% + ${dy * k}px))`;
      // a small dead zone, then a gentle curve: a light push strolls, a full one walks
      const m = Math.min(1, d / STICK), live = Math.max(0, (m - 0.12) / 0.88);
      this.stickV.set(d ? (dx / d) * live : 0, d ? (-dy / d) * live : 0).multiplyScalar(0.35 + 0.65 * live);
      if (live > 0) { this.dest = null; this.onMove(); }
      return;
    }
    // drag the world: the view follows the finger (a screen's width is a half turn)
    this.yaw = g.yaw0 + (dx / innerWidth) * Math.PI;
    this.pitch = Math.max(-0.75, Math.min(0.5, g.pitch0 + (dy / innerHeight) * 1.1));
  }
  private up(e: PointerEvent) {
    const g = this.drags.get(e.pointerId);
    this.end(e.pointerId);
    if (!this.enabled || !g) return;
    const quick = performance.now() - g.t0 < TAP_MS && !g.moved;
    if (e.pointerType === 'mouse' && this.locked) { if (quick) this.onTap(innerWidth / 2, innerHeight / 2); return; }
    if (!quick) return;
    // a click on a desk captures the mouse (first person); a tap on a phone goes where it was tapped
    if (e.pointerType === 'mouse' && matchMedia('(hover: hover)').matches && this.capturable(e.clientX, e.clientY)) this.capture();
    else this.onTap(e.clientX, e.clientY);
  }
  /** a click on someone or a table acts at once; a click on open floor captures the mouse instead */
  capturable: (x: number, y: number) => boolean = () => true;
  private end(id: number) {
    this.drags.delete(id);
    if (id === this.stickId) this.endStick();
  }
  private endStick() {
    this.stickId = -1; this.stickV.set(0, 0);
    this.stickEl.classList.remove('show');
  }

  private f = new THREE.Vector3();
  private to = new THREE.Vector3();
  private want = new THREE.Vector2();

  update(dt: number) {
    if (!this.enabled) return;
    // what you're asking for: keys and the stick, as forward and rightward amounts
    let fwd = 0, right = 0;
    if (this.keys.has('w') || this.keys.has('arrowup')) fwd += 1;
    if (this.keys.has('s') || this.keys.has('arrowdown')) fwd -= 1;
    if (this.keys.has('d')) right += 1;
    if (this.keys.has('a')) right -= 1;
    if (this.keys.has('arrowleft')) this.yaw += dt * 1.8;
    if (this.keys.has('arrowright')) this.yaw -= dt * 1.8;
    fwd += this.stickV.y; right += this.stickV.x;
    const n = Math.hypot(fwd, right);
    if (n > 1) { fwd /= n; right /= n; }
    const f = this.f.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const want = this.want.set(0, 0);
    if (n > 0.01) {
      this.dest = null; this.turnTo = null;
      const speed = this.hurry ? HURRY : WALK;
      // forward is (sin, cos) of the yaw; right is a quarter turn clockwise of it
      want.set(f.x * fwd - f.z * right, f.z * fwd + f.x * right).multiplyScalar(speed);
    } else if (this.dest) {
      const path = this.dest.path;
      // past a corner of the route: on to the next leg without slowing
      while (path.length > 1 && Math.hypot(path[0].x - this.pos.x, path[0].z - this.pos.z) < 0.3) path.shift();
      const to = this.to.set(path[0].x - this.pos.x, 0, path[0].z - this.pos.z), d = to.length();
      let left = d;
      for (let k = 1; k < path.length; k++) left += Math.hypot(path[k].x - path[k - 1].x, path[k].z - path[k - 1].z);
      // stuck against someone standing in the way: stop rather than tread on the spot
      this.stall.t += dt;
      if (this.stall.t > 0.6) { if (this.stall.left - left < 0.08) { this.stop(); left = 0; } this.stall = { t: 0, left }; }
      if (this.dest && path.length === 1 && d < 0.05) {
        const face = this.dest.face;
        this.stop();
        if (face !== undefined) this.turnTo = face;
      } else if (this.dest) {
        // ease out over what's left of the whole way
        const speed = Math.min(WALK, Math.max(0.3, left * 1.7));
        want.set(to.x / (d || 1), to.z / (d || 1)).multiplyScalar(speed);
        // turn toward where we're going when it's off to the side
        const aim = Math.atan2(to.x, to.z), da = Math.atan2(Math.sin(aim - this.yaw), Math.cos(aim - this.yaw));
        if (Math.abs(da) > 0.35 && left > 0.6 && this.drags.size === 0 && !this.locked) this.yaw += da * Math.min(1, dt * 2.2);
      }
    }
    // velocity eases toward what's asked (both speeding up and slowing down)
    const dvx = want.x - this.vel.x, dvz = want.y - this.vel.y, dv = Math.hypot(dvx, dvz), lim = ACCEL * dt;
    if (dv > lim) this.vel.x += (dvx / dv) * lim, this.vel.y += (dvz / dv) * lim;
    else this.vel.copy(want);
    if (this.turnTo !== null) {
      const da = Math.atan2(Math.sin(this.turnTo - this.yaw), Math.cos(this.turnTo - this.yaw));
      this.yaw += da * Math.min(1, dt * 3);
      if (Math.abs(da) < 0.01) this.turnTo = null;
    }
    if (this.vel.lengthSq() > 1e-6) {
      this.pos.x += this.vel.x * dt; this.pos.z += this.vel.y * dt;
      this.obs = this.obstacles();
      const bx = this.pos.x, bz = this.pos.z;
      this.collide(this.obs);
      // sliding along something: keep only the part of the velocity that isn't into it
      if (dt > 0) {
        const cx = (this.pos.x - bx) / dt, cz = (this.pos.z - bz) / dt, c = Math.hypot(cx, cz), k = c > 3 ? 3 / c : 1;
        this.vel.x += cx * 0.5 * k; this.vel.y += cz * 0.5 * k;
      }
      this.onMove();
    }
    if (this.marker.visible) {
      this.markerMat.opacity = this.dest ? 0.9 : Math.max(0, this.markerMat.opacity - dt * 2.5);
      if (this.markerMat.opacity <= 0) this.marker.visible = false;
    }
    // the camera: eye height, the lens eased to the walking one
    const fov = this.lens(56);
    if (Math.abs(this.camera.fov - fov) > 0.01) { this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 4); this.camera.updateProjectionMatrix(); }
    this.camera.position.set(this.pos.x, this.roomY + EYE, this.pos.z);
    this.look.set(this.pos.x + Math.sin(this.yaw) * Math.cos(this.pitch) * 3, this.roomY + EYE + Math.sin(this.pitch) * 3, this.pos.z + Math.cos(this.yaw) * Math.cos(this.pitch) * 3);
    this.camera.lookAt(this.look);
  }
  private stop() { this.dest = null; }

  /** Out of tables and people, inside the glass: push out along the shortest way (so you slide, never stick). */
  private collide(obs: Obstacle[]) {
    for (let k = 0; k < 2; k++) {
      for (const o of obs) {
        const dx = this.pos.x - o.x, dz = this.pos.z - o.z, d = Math.hypot(dx, dz);
        if (d < o.r && d > 1e-4) { this.pos.x = o.x + (dx / d) * o.r; this.pos.z = o.z + (dz / d) * o.r; }
      }
      const r = Math.hypot(this.pos.x, this.pos.z);
      if (r > R - 0.55) { this.pos.x *= (R - 0.55) / r; this.pos.z *= (R - 0.55) / r; }
    }
  }
}
