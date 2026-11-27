// The floor at a glance: the whole room in a small circle, turned so that whatever is ahead of you is up. Tables
// wear their mood (one palette with the signs: red a row, yellow laughter, blue thinking aloud), the ones talking
// right now pulse, the one you're with is ringed, and everyone else is a faint dot. Tap a table to walk over.
// Drawn at a dozen frames a second, on a 2D canvas: next to nothing.
import type { TableSpot } from './interior.ts';
import type { Turn } from './sync.ts';
import { ROOM } from './world.ts';
import { MOOD, tableMood } from './mood.ts';

type P = { x: number; z: number };

export class Minimap {
  private cv: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private px = 0;                                        // canvas size in device pixels
  private last = -1;
  private moods = new WeakMap<Turn[], { color: string }>();
  private view = { yaw: 0, spots: [] as TableSpot[] };
  onPick: (spot: TableSpot) => void = () => {};
  onWalk: (x: number, z: number) => void = () => {};

  constructor() {
    this.cv = document.createElement('canvas');
    this.cv.id = 'map';
    this.cv.setAttribute('role', 'img');
    this.cv.setAttribute('aria-label', 'Map of this floor: tap a table to walk over');
    document.body.appendChild(this.cv);
    this.g = this.cv.getContext('2d')!;
    // the map's own taps never reach the room behind it
    for (const ev of ['pointerdown', 'pointerup', 'pointermove', 'wheel'] as const) this.cv.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    // on a phone the small map opens big first (tables you can actually hit, with names); then a tap walks there
    this.cv.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this.big && matchMedia('(max-width: 699px)').matches) { this.open(true); return; }
      this.pick(e.offsetX, e.offsetY);
      this.open(false);
    });
    document.addEventListener('pointerdown', (e) => { if (this.big && e.target !== this.cv) { this.open(false); e.stopPropagation(); } }, true);
    // (its size, kept from the layout's own reports: read in draw(), after the frame's other writes to the page, it would
    // make the browser lay the page out again a dozen times a second)
    new ResizeObserver(() => { this.size = this.cv.clientWidth; this.last = -1; }).observe(this.cv);
  }
  private size = 0;

  private big = false;
  open(on: boolean) { this.big = on; this.cv.classList.toggle('big', on); this.last = -1; }
  show(on: boolean) { this.cv.classList.toggle('show', on); if (!on) { this.last = -1; this.open(false); } }

  private moodColor(turns: Turn[]) {
    let m = this.moods.get(turns);
    if (!m) { m = { color: MOOD[tableMood(turns).mood].color }; this.moods.set(turns, m); }
    return m.color;
  }

  /** where a world point lands on the map (heading up), in CSS pixels */
  private toMap(x: number, z: number, out: P) {
    const s = (this.size || this.cv.clientWidth) / 2, k = (s - 5) / ROOM.R, c = Math.cos(this.view.yaw), n = Math.sin(this.view.yaw);
    // right of you is the map's right; ahead of you is the map's up
    out.x = s + (x * -c + z * n) * k;
    out.z = s - (x * n + z * c) * k;
    return out;
  }

  private pick(mx: number, my: number) {
    const s = this.cv.clientWidth / 2, k = (s - 5) / ROOM.R, c = Math.cos(this.view.yaw), n = Math.sin(this.view.yaw);
    const u = (mx - s) / k, v = (s - my) / k;           // rightward, forward (metres, from the room's centre)
    const x = u * -c + v * n, z = u * n + v * c;
    let best: TableSpot | null = null, bd = Infinity;
    for (const sp of this.view.spots) {
      if (sp.bar) continue;
      const d = Math.hypot(sp.pos.x - x, sp.pos.z - z) - sp.radius;
      if (d < bd) { bd = d; best = sp; }
    }
    if (best && bd < 0.9) this.onPick(best);
    else if (Math.hypot(x, z) < ROOM.R - 0.6) this.onWalk(x, z);
  }

  /** (FLOOR_TIMELINE) `lit`: how lively each table is at the floor's moment (0: not open yet, drawn as a faint ring);
   *  `dots`: everyone in the room then, as x, z pairs */
  draw(now: number, spots: TableSpot[], you: P, yaw: number, o: { focus?: TableSpot | null; talking?: (s: TableSpot) => boolean; people?: { pose: { pos: P }; hidden?: boolean }[]; door?: P; lift?: number;
    lit?: (s: TableSpot) => number; dots?: ArrayLike<number>; dotCount?: number } = {}) {
    if (now - this.last < 0.08 && this.last >= 0) return;
    this.last = now;
    this.view.yaw = yaw; this.view.spots = spots;
    const css = this.size;
    if (!css) return;
    const dpr = Math.min(2, devicePixelRatio || 1), px = Math.round(css * dpr);
    if (px !== this.px) { this.cv.width = this.cv.height = this.px = px; }
    const g = this.g, s = css / 2, k = (s - 5) / ROOM.R, q: P = { x: 0, z: 0 };
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, css, css);
    // the room: a dark disc inside its glass
    g.beginPath(); g.arc(s, s, s - 1.5, 0, Math.PI * 2);
    g.fillStyle = 'rgba(12,14,20,0.66)'; g.fill();
    g.lineWidth = 1; g.strokeStyle = 'rgba(255,255,255,0.16)'; g.stroke();
    // the bar along its wall, the lift in the wall
    const bar = spots.find((x) => x.bar);
    if (bar) {
      this.toMap(bar.pos.x, bar.pos.z, q);
      const a = Math.atan2(q.z - s, q.x - s);
      g.beginPath(); g.arc(s, s, (ROOM.R - 1.05) * k, a - 0.42, a + 0.42);
      g.lineWidth = 3; g.lineCap = 'round'; g.strokeStyle = 'rgba(255,190,120,0.5)'; g.stroke();
    }
    if (o.door) {
      this.toMap(o.door.x, o.door.z, q);
      g.fillStyle = `rgba(255,205,140,${0.45 + 0.5 * (o.lift ?? 0)})`;
      g.fillRect(q.x - 2.5, q.z - 2.5, 5, 5);
    }
    // everyone, faintly: how full each part of the room is
    if (o.people || o.dots) {
      g.fillStyle = 'rgba(255,244,230,0.32)';
      for (const p of o.people ?? []) { if (p.hidden) continue; this.toMap(p.pose.pos.x, p.pose.pos.z, q); g.fillRect(q.x - 0.8, q.z - 0.8, 1.6, 1.6); }
      const d = o.dots, n = o.dotCount ?? (d ? d.length / 2 : 0);
      if (d) for (let i = 0; i < n; i++) { this.toMap(d[2 * i], d[2 * i + 1], q); g.fillRect(q.x - 0.7, q.z - 0.7, 1.4, 1.4); }
    }
    // the tables, in their moods
    const pulse = 0.5 + 0.5 * Math.sin(now * 5);
    for (const sp of spots) {
      if (sp.bar) continue;
      this.toMap(sp.pos.x, sp.pos.z, q);
      const r = Math.max(o.lit ? 2.2 : 3, sp.radius * k), color = this.moodColor(sp.table.turns), talking = o.talking?.(sp);
      // (a building's table that hasn't opened yet: a faint ring, waiting)
      const lit = o.lit ? o.lit(sp) : -1;
      if (lit === 0) { g.beginPath(); g.arc(q.x, q.z, r, 0, Math.PI * 2); g.lineWidth = 1; g.strokeStyle = 'rgba(255,244,232,0.22)'; g.stroke(); continue; }
      if (talking) {
        g.beginPath(); g.arc(q.x, q.z, r + 2 + pulse * 2.5, 0, Math.PI * 2);
        g.lineWidth = 1.5; g.strokeStyle = color; g.globalAlpha = 0.35 + 0.35 * (1 - pulse); g.stroke(); g.globalAlpha = 1;
      }
      g.beginPath(); g.arc(q.x, q.z, r, 0, Math.PI * 2);
      g.fillStyle = color; g.globalAlpha = talking ? 0.95 : lit > 0 ? 0.3 + 0.6 * lit : 0.38; g.fill(); g.globalAlpha = 1;
      if (o.focus === sp) { g.lineWidth = 1.6; g.strokeStyle = 'rgba(255,255,255,0.95)'; g.stroke(); }
    }
    // opened big: the busiest tables say what they are (a few words, so it stays a map), and what colours mean
    if (this.big) {
      g.font = '600 10.5px system-ui, -apple-system, sans-serif'; g.textBaseline = 'middle'; g.textAlign = 'left';
      const here = new Set(spots.filter((x) => !x.bar).map((x) => tableMood(x.table.turns).mood));
      const keys = ([['heated', MOOD.heated.color, 'heated'], ['laughing', MOOD.playful.color, 'playful'], ['thoughtful', MOOD.thoughtful.color, 'thoughtful'], ['sombre', MOOD.somber.color, 'somber'], ['tense', MOOD.tense.color, 'tense']] as const)
        .filter((k) => here.has(k[2] as never)).slice(0, 3);
      const widths = keys.map(([w]) => g.measureText(w).width + 18), total = widths.reduce((a, b) => a + b, 0);
      let lx = s - total / 2;
      const ly = s + (s - 6) * 0.5;                     // where the circle is still wide enough for the line
      keys.forEach(([w, c], i) => {
        g.beginPath(); g.arc(lx + 4, ly, 3.5, 0, Math.PI * 2); g.fillStyle = c; g.fill();
        g.fillStyle = 'rgba(255,244,232,0.8)'; g.fillText(w, lx + 11, ly);
        lx += widths[i];
      });
      g.font = '600 11px system-ui, -apple-system, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'top';
      const named = spots.filter((x) => !x.bar).sort((a, b) => b.table.turns.length - a.table.turns.length).slice(0, 7);
      for (const sp of named) {
        this.toMap(sp.pos.x, sp.pos.z, q);
        const words = (sp.table.gist ?? sp.table.turns[0]?.by ?? '').split(/\s+/).slice(0, 3).join(' ').replace(/[,.;:]$/, '');
        const text = words.length > 22 ? words.slice(0, 21) + '…' : words;
        const r = Math.max(3, sp.radius * k);
        g.lineWidth = 3; g.strokeStyle = 'rgba(8,8,12,0.85)'; g.strokeText(text, q.x, q.z + r + 3);
        g.fillStyle = 'rgba(255,244,232,0.92)'; g.fillText(text, q.x, q.z + r + 3);
      }
    }
    // you: a soft cone of what you see, and an arrow (always pointing up: the map turns, not you)
    this.toMap(you.x, you.z, q);
    const cone = g.createRadialGradient(q.x, q.z, 0, q.x, q.z, s * 0.55);
    cone.addColorStop(0, 'rgba(255,255,255,0.20)'); cone.addColorStop(1, 'rgba(255,255,255,0)');
    g.beginPath(); g.moveTo(q.x, q.z); g.arc(q.x, q.z, s * 0.55, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5); g.closePath();
    g.fillStyle = cone; g.fill();
    g.beginPath(); g.moveTo(q.x, q.z - 5.5); g.lineTo(q.x + 4, q.z + 4); g.lineTo(q.x, q.z + 2); g.lineTo(q.x - 4, q.z + 4); g.closePath();
    g.fillStyle = '#fff'; g.fill();
    g.lineWidth = 1; g.strokeStyle = 'rgba(0,0,0,0.5)'; g.stroke();
  }
}
