// The tower view's camera, and the hands on it. The tower is something you hold: drag it up or down and it
// moves with your finger, then settles on a floor; drag sideways to walk round it; pinch (or ctrl+wheel, a
// trackpad's pinch) to step closer or back. A tap on a floor brings it to you; a tap on the floor you're facing
// takes you in (main.ts decides). A wheel steps one floor at a time. Left alone, it slowly walks round.
//
// There is deliberately no double-tap: it would hold every tap for 300 ms to see if a second one follows.
import * as THREE from 'three/webgpu';
import { floorY, FLOORS, FLOOR_H, LOBBY_H, TOWER_TOP } from './world.ts';

/** the floor (rank) whose centre is nearest height y */
const rankAt = (y: number, n: number) => Math.max(0, Math.min(n - 1, Math.round(FLOORS - 1 - (y - LOBBY_H - FLOOR_H / 2) / FLOOR_H)));

interface Gesture { kind: 'pending' | 'v' | 'h' | 'pinch'; x0: number; y0: number; t0: number; yAt0: number; th0: number; d0: number; span0: number; trail: { t: number; y: number }[] }

export class TowerCam {
  static FOV = 45;
  theta = 0.64;                        // where round the tower we stand
  y = TOWER_TOP * 0.55;                // the height we look at (a floor's centre, once settled)
  yTarget = this.y;
  d = 150;                             // how far from the tower's axis
  dTarget = 150;
  rank = 0;                            // the floor in focus
  floors = FLOORS;                     // how many the tower has now
  enabled = false;
  /** how far above the middle of the screen the floor in focus sits (the card covers the bottom) */
  lift = 0.08;
  /** where the camera is looking: a ride out to a floor starts from here */
  look = new THREE.Vector3();
  /** how far right of centre the tower stands, as a fraction of the view's width (away from a card at the side) */
  shift = 0;
  private dRate = 1.3;                 // slow for the opening approach, brisk after
  private pinched = false;             // once someone sets their own distance, keep it
  private lastInput = -1e9;
  private ptrs = new Map<number, { x: number; y: number }>();
  private g: Gesture | null = null;
  private wheelAcc = 0;
  onFocus: (rank: number) => void = () => {};
  onTap: (x: number, y: number) => void = () => {};
  onTouch: () => void = () => {};

  constructor(private camera: THREE.PerspectiveCamera, private el: HTMLElement) {
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e, false));
    el.addEventListener('pointercancel', (e) => this.up(e, true));
    el.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    addEventListener('resize', () => { if (!this.pinched) this.dTarget = this.home(); });
  }

  /** the distance that frames the tower: portrait phones need to stand closer for the titles to read */
  home() { return innerWidth < innerHeight ? 42 : 44; }        // portrait: room for the rail beside the tower
  get dragging() { return this.g !== null && this.g.kind !== 'pending'; }

  /** Bring floor `rank` to the middle of the view (the spring does the moving). */
  focus(rank: number) {
    rank = Math.max(0, Math.min(this.floors - 1, rank));
    this.yTarget = floorY(rank);
    if (rank !== this.rank) { this.rank = rank; this.onFocus(rank); }
  }

  /** After the splash: from the wide establishing shot down to the top floor. */
  arrive(rank = 0) {
    this.enabled = true; this.dRate = 1.3;
    this.dTarget = this.pinched ? this.dTarget : this.home();
    this.rank = -1;
    this.focus(rank);
  }

  /** Where the camera stands and looks for floor `rank` at the current angle: the ride back out lands here. */
  pose(rank: number, pos = new THREE.Vector3(), look = new THREE.Vector3()) {
    const y = floorY(rank), d = this.pinched ? this.dTarget : this.home();
    const viewH = 2 * d * Math.tan(THREE.MathUtils.degToRad(TowerCam.FOV / 2));
    pos.set(Math.sin(this.theta) * d, y + d * 0.1, Math.cos(this.theta) * d);
    look.set(0, y - viewH * this.lift, 0).add(this.side(viewH));
    return { pos, look };
  }

  /** The tower pose for floor `rank` seen from bearing `theta` (the way out of a floor lands here). */
  poseAt(rank: number, theta: number) {
    const keep = this.theta;
    this.theta = theta;
    const r = this.pose(rank);
    this.theta = keep;
    return r;
  }

  /** Take over from wherever the camera is now (back from a floor): settle on `rank` from the same angle. */
  resume(rank: number) {
    this.theta = Math.atan2(this.camera.position.x, this.camera.position.z);
    this.y = this.yTarget = floorY(rank);
    this.d = this.pinched ? this.dTarget : (this.dTarget = this.home());
    this.rank = rank;
    this.enabled = true;
  }

  update(dt: number) {
    if (!this.g || this.g.kind !== 'v') this.y += (this.yTarget - this.y) * (1 - Math.exp(-dt * 5.5));
    this.d += (this.dTarget - this.d) * (1 - Math.exp(-dt * this.dRate));
    if (Math.abs(this.dTarget - this.d) < 0.5) this.dRate = 3.5;
    if (!this.g && performance.now() / 1000 - this.lastInput > 6) this.theta += dt * 0.045;
    // the tower's own lens (a floor's shots widen it for tall screens): ease back, never pop
    if (Math.abs(this.camera.fov - TowerCam.FOV) > 0.01) {
      this.camera.fov += (TowerCam.FOV - this.camera.fov) * (1 - Math.exp(-dt * 4));
      this.camera.updateProjectionMatrix();
    }
    const viewH = 2 * this.d * Math.tan(THREE.MathUtils.degToRad(TowerCam.FOV / 2));
    this.camera.position.set(Math.sin(this.theta) * this.d, this.y + this.d * 0.1, Math.cos(this.theta) * this.d);
    this.look.set(0, this.y - viewH * this.lift, 0).add(this.side(viewH));
    this.camera.lookAt(this.look);
  }

  /** aim a little to one side so the tower stands clear of the card (looking left of it puts it on the right) */
  private side(viewH: number) {
    const w = viewH * this.camera.aspect * this.shift;
    return this.offset.set(-Math.cos(this.theta) * w, 0, Math.sin(this.theta) * w);
  }
  private offset = new THREE.Vector3();

  private metresPerPx() { return 2 * this.d * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) / innerHeight; }   // the lens as it is now
  /** past the top or bottom floor the tower resists, like the end of a list */
  private soft(y: number) {
    const top = floorY(0), bottom = floorY(this.floors - 1);
    if (y > top) return top + (y - top) * 0.3;
    if (y < bottom) return bottom - (bottom - y) * 0.3;
    return y;
  }

  private down(e: PointerEvent) {
    if (!this.enabled) return;
    this.el.setPointerCapture(e.pointerId);
    this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.lastInput = performance.now() / 1000;
    this.onTouch();
    if (this.ptrs.size === 1) {
      this.g = { kind: 'pending', x0: e.clientX, y0: e.clientY, t0: performance.now(), yAt0: this.y, th0: this.theta, d0: this.d, span0: 0, trail: [] };
    } else if (this.ptrs.size === 2) {
      // a second finger abandons whatever the first one was starting
      const [a, b] = [...this.ptrs.values()];
      this.g = { kind: 'pinch', x0: 0, y0: 0, t0: performance.now(), yAt0: this.y, th0: this.theta, d0: this.dTarget, span0: Math.hypot(a.x - b.x, a.y - b.y) || 1, trail: [] };
    }
  }

  private move(e: PointerEvent) {
    if (!this.ptrs.has(e.pointerId) || !this.g) return;
    this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.lastInput = performance.now() / 1000;
    const g = this.g;
    if (g.kind === 'pinch') {
      if (this.ptrs.size < 2) return;
      const [a, b] = [...this.ptrs.values()];
      this.dTarget = Math.max(20, Math.min(120, g.d0 * g.span0 / (Math.hypot(a.x - b.x, a.y - b.y) || 1)));
      this.pinched = true;
      return;
    }
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (g.kind === 'pending') {
      if (Math.hypot(dx, dy) < 8) return;
      g.kind = Math.abs(dy) > Math.abs(dx) ? 'v' : 'h';       // one axis at a time: no diagonal drift
      g.x0 = e.clientX; g.y0 = e.clientY;
      return;
    }
    if (g.kind === 'h') { this.theta = g.th0 - (e.clientX - g.x0) / innerWidth * Math.PI; return; }
    // vertical: what's under the finger stays under the finger
    this.y = this.soft(g.yAt0 + (e.clientY - g.y0) * this.metresPerPx());
    g.trail.push({ t: performance.now(), y: this.y });
    if (g.trail.length > 8) g.trail.shift();
    const r = rankAt(this.y, this.floors);
    if (r !== this.rank) { this.rank = r; this.onFocus(r); }
  }

  private up(e: PointerEvent, cancelled: boolean) {
    if (!this.ptrs.delete(e.pointerId) || !this.g) return;
    const g = this.g;
    if (g.kind === 'pinch') { if (this.ptrs.size === 0) this.g = null; return; }
    this.g = null;
    if (cancelled) { this.focus(this.rank); return; }
    if (g.kind === 'pending') {
      if (performance.now() - g.t0 < 450) this.onTap(e.clientX, e.clientY);
      return;
    }
    if (g.kind === 'v') {
      // a fling carries on a little, then lands on the nearest floor
      const t = g.trail, last = t[t.length - 1], first = t.find((p) => last.t - p.t < 120) ?? t[0];
      const v = last && first && last.t > first.t ? (last.y - first.y) / ((last.t - first.t) / 1000) : 0;
      const r = rankAt(this.y + Math.max(-12, Math.min(12, v * 0.22)), this.floors);
      this.rank = -1;
      this.focus(r);
    }
  }

  private wheel(e: WheelEvent) {
    if (!this.enabled) return;
    e.preventDefault();
    this.lastInput = performance.now() / 1000;
    this.onTouch();
    const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1);
    if (e.ctrlKey) {                                   // a trackpad pinch arrives as ctrl+wheel
      this.dTarget = Math.max(20, Math.min(120, this.dTarget * Math.exp(dy * 0.01)));
      this.pinched = true;
      return;
    }
    this.wheelAcc += dy;
    if (Math.abs(this.wheelAcc) >= 50) {
      this.focus(this.rank + Math.sign(this.wheelAcc));
      this.wheelAcc = 0;
    }
  }
}
