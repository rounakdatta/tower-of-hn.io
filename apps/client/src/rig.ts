// The camera rig: film cuts, smooth glides, and a slow drift so no shot is ever dead still.
import * as THREE from 'three/webgpu';
import { easeInOut } from './util.ts';

export class Rig {
  pos = new THREE.Vector3();
  target = new THREE.Vector3();
  private from = { p: new THREE.Vector3(), t: new THREE.Vector3() };
  private to = { p: new THREE.Vector3(), t: new THREE.Vector3() };
  private t0 = 0;
  private dur = 0;
  private drift = new THREE.Vector3();
  private driftT = 0;
  private arc = 1;
  fov = 45;
  fovTarget = 45;
  constructor(public camera: THREE.PerspectiveCamera) {}

  cut(p: THREE.Vector3, t: THREE.Vector3, drift = 0.18) {
    this.pos.copy(p); this.target.copy(t); this.dur = 0;
    this.drift.copy(t).sub(p).normalize().multiplyScalar(drift);   // dolly in slowly
    this.driftT = 0;
  }

  glide(p: THREE.Vector3, t: THREE.Vector3, dur: number, now: number, drift = 0, arc = 1) {
    this.arc = arc;
    this.from.p.copy(this.pos); this.from.t.copy(this.target);
    this.to.p.copy(p); this.to.t.copy(t);
    this.t0 = now; this.dur = dur;
    this.drift.copy(t).sub(p).normalize().multiplyScalar(drift); this.driftT = -dur;
  }

  busy(now: number) { return this.dur > 0 && now - this.t0 < this.dur; }

  update(now: number, dt: number) {
    if (this.dur > 0) {
      const k = Math.min(1, (now - this.t0) / this.dur), e = easeInOut(k);
      this.pos.lerpVectors(this.from.p, this.to.p, e);
      this.target.lerpVectors(this.from.t, this.to.t, e);
      // arc the path upward a little, like a crane, so glides never clip through things
      this.pos.y += Math.sin(Math.PI * k) * 0.35 * this.arc * this.from.p.distanceTo(this.to.p) / 10;
      if (k >= 1) this.dur = 0;
    }
    this.driftT += dt;
    const d = Math.max(0, Math.min(1, this.driftT / 8));
    this.camera.position.copy(this.pos).addScaledVector(this.drift, d);
    this.camera.lookAt(this.target);
    this.fov += (this.fovTarget - this.fov) * (1 - Math.exp(-dt * 3));
    // shots are composed for 16:9; on a tall phone widen the lens so the framing (not the crop) stays the same
    const a = this.camera.aspect, k = a < 1.6 ? Math.min(2.3, 1.6 / a) : 1;
    const v = Math.min(88, (2 * Math.atan(Math.tan((this.fov * Math.PI) / 360) * k) * 180) / Math.PI);
    if (Math.abs(this.camera.fov - v) > 0.01) { this.camera.fov = v; this.camera.updateProjectionMatrix(); }
  }
}
