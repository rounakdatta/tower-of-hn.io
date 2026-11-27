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
  private jolt = { amp: 0, t: 0, dur: 0 };
  /** a small physical jolt (someone slams the table): decays over `dur` seconds */
  shake(amp: number, dur: number) { this.jolt = { amp, t: 0, dur }; }
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

  busy(now: number) { return (this.dur > 0 && now - this.t0 < this.dur) || !!this.route; }
  /** Drop any flight or glide under way (its end isn't run): the next cut is where the camera is. */
  halt() { this.route = null; this.dur = 0; }

  /**
   * One continuous flight through several points (a centripetal Catmull-Rom spline: no stop and no kink at any
   * of them), the gaze moving through its own points alongside. Speed eases in and out over the whole flight.
   */
  private route: { pos: THREE.CatmullRomCurve3; look: THREE.CatmullRomCurve3; t0: number; dur: number; done?: () => void } | null = null;
  fly(points: THREE.Vector3[], looks: THREE.Vector3[], dur: number, now: number, done?: () => void) {
    this.dur = 0;
    this.route = { pos: new THREE.CatmullRomCurve3(points, false, 'centripetal'), look: new THREE.CatmullRomCurve3(looks, false, 'centripetal'), t0: now, dur, done };
    this.drift.set(0, 0, 0); this.driftT = 0;
  }
  /** 0..1 along the current flight (1 when there is none) */
  progress(now: number) { return this.route ? Math.min(1, (now - this.route.t0) / this.route.dur) : 1; }

  update(now: number, dt: number) {
    if (this.route) {
      const r = this.route, k = Math.min(1, (now - r.t0) / r.dur), e = easeInOut(k);
      r.pos.getPointAt(e, this.pos);
      r.look.getPointAt(e, this.target);
      if (k >= 1) { this.route = null; r.done?.(); }
    } else if (this.dur > 0) {
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
    if (this.jolt.dur) {
      const j = this.jolt;
      j.t += dt;
      const k = 1 - j.t / j.dur;
      if (k <= 0) j.dur = 0;
      else {
        const a = j.amp * k * k;
        this.camera.position.x += Math.sin(j.t * 71) * a; this.camera.position.y += Math.sin(j.t * 53 + 1) * a; this.camera.position.z += Math.sin(j.t * 61 + 2) * a * 0.5;
      }
    }
    this.camera.lookAt(this.target);
    this.fov += (this.fovTarget - this.fov) * (1 - Math.exp(-dt * 3));
    const v = this.lens(this.fov);
    if (Math.abs(this.camera.fov - v) > 0.01) { this.camera.fov = v; this.camera.updateProjectionMatrix(); }
  }

  /** Shots are composed for 16:9; on a tall phone the lens widens so the framing (not the crop) stays the same. */
  private widen() { const a = this.camera.aspect; return a < 1.6 ? Math.min(2.3, 1.6 / a) : 1; }
  /** the camera's vertical field of view for a shot composed at `fov` */
  lens(fov: number) { return Math.min(88, (2 * Math.atan(Math.tan((fov * Math.PI) / 360) * this.widen()) * 180) / Math.PI); }
  /** half the horizontal field of view a shot composed at `fov` will really have (radians) */
  halfWidth(fov: number) { return Math.atan(Math.tan((this.lens(fov) * Math.PI) / 360) * this.camera.aspect); }
  /** Take over the lens as it is (from the tower's camera) instead of jumping to a widened one. */
  matchLens() { this.fov = this.fovTarget = (2 * Math.atan(Math.tan((this.camera.fov * Math.PI) / 360) / this.widen()) * 180) / Math.PI; }
}
