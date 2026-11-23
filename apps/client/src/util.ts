// Small shared helpers: deterministic hashing, easing, springs, palettes.

export function hash32(s: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
  return h >>> 0;
}
/** A deterministic random stream for one name: the same person gets the same everything, everywhere. */
export function rngFor(s: string) {
  let a = hash32(s) || 1;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length) % xs.length];

export const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
export const easeOut = (k: number) => 1 - Math.pow(1 - k, 3);
/** Frame-rate independent exponential approach. */
export const damp = (a: number, b: number, rate: number, dt: number) => lerp(a, b, 1 - Math.exp(-rate * dt));

/** A critically damped spring: smooth, never overshoots, never "floats". */
export class Spring {
  v = 0;
  constructor(public x = 0, public stiffness = 60) {}
  step(target: number, dt: number) {
    const w = Math.sqrt(this.stiffness), x0 = this.x - target, e = Math.exp(-w * dt);
    const c = this.v + w * x0;
    this.x = target + (x0 + c * dt) * e;
    this.v = (this.v - c * w * dt) * e;
    return this.x;
  }
}

// Designer palettes: muted, warm, never garish. HN orange is reserved for meaning.
export const HN_ORANGE = '#ff6a1a';
export const SKIN = ['#f4d7c1', '#eac0a2', '#d9a77f', '#c68b62', '#a8704a', '#8a5538', '#6b3f28', '#4e2c1c'];
export const OUTFIT = ['#3b4a6b', '#5b6e8c', '#7a3e48', '#a3543f', '#c98b4a', '#d7b56d', '#6f8f72', '#3f6b5f',
  '#2f3a4a', '#8c6a8f', '#4b5d7a', '#9a4b5c', '#b7a28c', '#556b4f', '#2d5d7b', '#6e5a8a', '#c2c7cf', '#33373f'];
export const HAIR = ['#1b1714', '#2c211b', '#4a3122', '#6b4528', '#8c5a2e', '#b78a52', '#d8bf8a', '#8f8f93', '#d9d6d0', '#3a2a4f', '#2b5e63'];

export function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}
export function domainOf(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}
export function timeAgo(sec: number) {
  if (sec < 90) return 'just now';
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  return `${Math.round(sec / 3600)} h ago`;
}
