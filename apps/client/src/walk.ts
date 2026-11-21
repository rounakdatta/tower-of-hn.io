// On a floor, on foot. Drag to look round; tap the floor to walk there (a ring marks the spot); tap a table to go
// up to it (main.ts decides what a tap was). Arrow keys or WASD walk too, the wheel steps forward and back. Tables,
// people and the glass are in the way: you slide along them, never through.
//
// The view doesn't bob: a walking camera that bobs makes phones seasick.
import * as THREE from 'three/webgpu';
import { R } from './world.ts';

export const EYE = 1.5;                                  // eye height on a floor, metres

export interface Obstacle { x: number; z: number; r: number }

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
  onTap: (x: number, y: number) => void = () => {};
  onMove: () => void = () => {};
  private dest: { p: THREE.Vector3; face?: number } | null = null;
  private speed = 0;
  private keys = new Set<string>();
  private g: { x0: number; y0: number; t0: number; yaw0: number; pitch0: number; moved: boolean } | null = null;
  private marker: THREE.Mesh;
  private markerMat: THREE.MeshBasicMaterial;

  constructor(private camera: THREE.PerspectiveCamera, private el: HTMLElement, scene: THREE.Scene) {
    this.markerMat = new THREE.MeshBasicMaterial({ color: 0xffb27a, transparent: true, opacity: 0, depthWrite: false });
    this.marker = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.22, 40), this.markerMat);
    this.marker.rotation.x = -Math.PI / 2;
    this.marker.visible = false;
    scene.add(this.marker);
    el.addEventListener('pointerdown', (e) => {
      if (!this.enabled || !e.isPrimary) return;
      el.setPointerCapture(e.pointerId);
      this.g = { x0: e.clientX, y0: e.clientY, t0: performance.now(), yaw0: this.yaw, pitch0: this.pitch, moved: false };
    });
    el.addEventListener('pointermove', (e) => {
      const g = this.g;
      if (!this.enabled || !g || !e.isPrimary) return;
      const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
      if (!g.moved && Math.hypot(dx, dy) < 8) return;
      g.moved = true;
      // drag the world: the view follows the finger (a screen's width is a half turn)
      this.yaw = g.yaw0 + (dx / innerWidth) * Math.PI;
      this.pitch = Math.max(-0.6, Math.min(0.4, g.pitch0 + (dy / innerHeight) * 1.1));
    });
    el.addEventListener('pointerup', (e) => {
      const g = this.g;
      this.g = null;
      if (!this.enabled || !g || !e.isPrimary) return;
      if (!g.moved && performance.now() - g.t0 < 450) this.onTap(e.clientX, e.clientY);
    });
    el.addEventListener('pointercancel', () => { this.g = null; });
    el.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      const step = Math.max(-0.8, Math.min(0.8, -e.deltaY * 0.004));
      this.goTo(this.pos.clone().add(new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(step)), undefined, false);
    }, { passive: false });
    addEventListener('keydown', (e) => { if (this.enabled && !e.metaKey && !e.ctrlKey) this.keys.add(e.key.toLowerCase()); });
    addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    addEventListener('blur', () => this.keys.clear());
  }

  /** Stand here, looking this way (after the flight in, or after standing up from a table). */
  begin(pos: THREE.Vector3, yaw: number, pitch = -0.1) {
    this.pos.set(pos.x, 0, pos.z); this.yaw = yaw; this.pitch = pitch;
    this.dest = null; this.speed = 0; this.enabled = true;
  }

  /** Walk to p (inside the room), then face `face` if given. */
  goTo(p: THREE.Vector3, face?: number, mark = true) {
    const q = new THREE.Vector3(p.x, 0, p.z), r = Math.hypot(q.x, q.z);
    if (r > R - 0.6) q.multiplyScalar((R - 0.6) / r);
    this.dest = { p: q, face };
    if (mark) { this.marker.position.set(q.x, this.roomY + 0.025, q.z); this.marker.visible = true; this.markerMat.opacity = 0.9; }
  }

  get walking() { return !!this.dest || this.keys.size > 0; }

  update(dt: number) {
    if (!this.enabled) return;
    // keys: walk the way you're facing, step sideways
    let kx = 0, kz = 0;
    if (this.keys.has('arrowup') || this.keys.has('w')) kz += 1;
    if (this.keys.has('arrowdown') || this.keys.has('s')) kz -= 1;
    if (this.keys.has('a')) kx += 1;
    if (this.keys.has('d')) kx -= 1;
    if (this.keys.has('arrowleft')) this.yaw += dt * 1.6;
    if (this.keys.has('arrowright')) this.yaw -= dt * 1.6;
    const f = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)), side = new THREE.Vector3(f.z, 0, -f.x);
    const move = new THREE.Vector3();
    if (kx || kz) {
      this.dest = null;
      move.addScaledVector(f, kz).addScaledVector(side, kx).normalize().multiplyScalar(1.6 * dt);
    } else if (this.dest) {
      const to = this.dest.p.clone().sub(this.pos), d = to.length();
      // ease in, ease out: never a jolt
      this.speed = Math.min(1.5, this.speed + dt * 2.5, Math.max(0.25, d * 1.6));
      if (d < 0.04) {
        const face = this.dest.face;
        this.dest = null; this.speed = 0;
        if (face !== undefined) this.turnTo = face;
      } else {
        move.copy(to).multiplyScalar(Math.min(1, (this.speed * dt) / d));
        // turn toward where we're going when it's off to the side
        const want = Math.atan2(to.x, to.z), da = Math.atan2(Math.sin(want - this.yaw), Math.cos(want - this.yaw));
        if (Math.abs(da) > 0.35 && d > 0.6) this.yaw += da * Math.min(1, dt * 2.2);
      }
    }
    if (this.turnTo !== null) {
      const da = Math.atan2(Math.sin(this.turnTo - this.yaw), Math.cos(this.turnTo - this.yaw));
      this.yaw += da * Math.min(1, dt * 3);
      if (Math.abs(da) < 0.01) this.turnTo = null;
    }
    if (move.lengthSq() > 0) {
      this.pos.add(move);
      this.collide();
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
  private turnTo: number | null = null;

  /** Out of tables and people, inside the glass: push out along the shortest way (so you slide, never stick). */
  private collide() {
    for (let k = 0; k < 2; k++) {
      for (const o of this.obstacles()) {
        const dx = this.pos.x - o.x, dz = this.pos.z - o.z, d = Math.hypot(dx, dz);
        if (d < o.r && d > 1e-4) { this.pos.x = o.x + (dx / d) * o.r; this.pos.z = o.z + (dz / d) * o.r; }
      }
      const r = Math.hypot(this.pos.x, this.pos.z);
      if (r > R - 0.55) { this.pos.x *= (R - 0.55) / r; this.pos.z *= (R - 0.55) / r; }
    }
  }
}
