// The overlay: a thin DOM layer over the scene. Quiet by default; cinematic at a table.
import * as THREE from 'three/webgpu';
import { esc, domainOf } from './util.ts';
import type { TableSpot } from './interior.ts';

const $ = (id: string) => document.getElementById(id)!;

export class UI {
  private camera!: THREE.PerspectiveCamera;
  private pinned: { el: HTMLElement; at: THREE.Vector3; dy: number }[] = [];
  private labels: { el: HTMLElement; at: THREE.Vector3 }[] = [];
  private v = new THREE.Vector3();
  private subTimer = 0;

  bind(camera: THREE.PerspectiveCamera) { this.camera = camera; }

  splash(onEnter: () => void) {
    const s = $('splash');
    s.classList.add('show');
    const go = () => { s.classList.remove('show'); s.classList.add('gone'); onEnter(); };
    $('enter').addEventListener('click', go, { once: true });
  }

  mode(m: 'tower' | 'floor' | 'table') {
    document.body.dataset.mode = m;
  }

  live(text: string) { $('live').textContent = text; }
  /** A cinematic title card when you arrive somewhere. */
  card(kicker: string, title: string) {
    const c = $('card');
    c.innerHTML = `<div class="k">${esc(kicker)}</div><div class="t">${esc(title)}</div>`;
    c.classList.remove('go'); void c.offsetWidth; c.classList.add('go');
  }
  private toastTimer = 0;
  toast(html: string) {
    const t = $('toast');
    t.innerHTML = html; t.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => t.classList.remove('show'), 3600);
  }
  flash() { const f = $('fade'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go'); }
  hint(text: string) { $('hint').textContent = text; }

  tip(d: { rank: number; title: string; url: string; score: number; comments: number; act: number } | null, x = 0, y = 0) {
    const el = $('tip');
    if (!d) { el.classList.remove('show'); return; }
    const dom = domainOf(d.url);
    el.innerHTML = `<div class="rank">${d.rank}</div><div class="body"><div class="t">${esc(d.title)}</div>`
      + `<div class="m">${dom ? esc(dom) + ' · ' : ''}${d.score} points · ${d.comments} comments${d.act ? ` · <b>${d.act} new in 15 min</b>` : ''}</div></div>`;
    el.style.transform = `translate(${Math.min(x + 18, innerWidth - 380)}px, ${Math.max(12, y - 24)}px)`;
    el.classList.add('show');
  }

  floorHeader(f: { rank: number; title: string; id: number; url?: string } | null) {
    const el = $('floorbar');
    if (!f) { el.classList.remove('show'); return; }
    $('ftitle').innerHTML = `<span class="rank">${f.rank}</span> <a href="https://news.ycombinator.com/item?id=${f.id}" target="_blank" rel="noopener">${esc(f.title)}</a>`;
    el.classList.add('show');
  }

  tableLabels(spots: TableSpot[], roomY: number, onPick: (s: TableSpot) => void) {
    const box = $('labels');
    box.innerHTML = '';
    box.classList.toggle('show', this.labelsOn);
    this.labels = [];
    for (const s of spots.filter((x) => !x.bar).slice(0, 5)) {
      const el = document.createElement('button');
      el.className = 'tlabel';
      const people = new Set(s.table.turns.map((t) => t.by)).size;
      const voiced = s.table.turns.some((t) => t.v);
      const mins = s.table.turns.reduce((n, t) => n + (t.v ? t.v[1] : 18), 0) / 60;
      el.innerHTML = `<b>${voiced ? '<i class="play">▶</i>' : ''}${esc(s.table.turns[0].by)}${people > 1 ? ` <em>+${people - 1}</em>` : ''}</b><span>${s.table.turns.length} turns · ~${Math.max(1, Math.round(mins))} min</span>`;
      el.onclick = (e) => { e.stopPropagation(); onPick(s); };
      box.appendChild(el);
      this.labels.push({ el, at: new THREE.Vector3(s.pos.x, roomY + 1.55, s.pos.z) });
    }
    const bar = spots.filter((s) => s.bar).length;
    if (bar) {
      const el = document.createElement('button');
      el.className = 'tlabel bar';
      el.innerHTML = `<b>The bar</b><span>${bar} one-liner${bar === 1 ? '' : 's'}</span>`;
      const b = spots.find((s) => s.bar)!;
      el.onclick = (e) => { e.stopPropagation(); onPick(b); };
      box.appendChild(el);
      this.labels.push({ el, at: new THREE.Vector3(b.pos.x * 0.92, roomY + 1.7, b.pos.z * 0.92) });
    }
  }
  clearLabels() { $('labels').innerHTML = ''; this.labels = []; this.showLabels(false); }
  private labelsOn = false;
  showLabels(on: boolean) { this.labelsOn = on; $('labels').classList.toggle('show', on); }

  subtitle(s: { name: string; to?: string; text: string; color: string; emotion: string } | null) {
    const el = $('subs');
    clearTimeout(this.subTimer);
    if (!s) { this.subTimer = window.setTimeout(() => el.classList.remove('show'), 350); return; }
    const text = s.text.length > 320 ? s.text.slice(0, 317) + '…' : s.text;
    el.innerHTML = `<span class="who" style="color:${s.color}">${esc(s.name)}${s.to && s.to !== s.name ? `<span class="to"> → ${esc(s.to)}</span>` : ''}</span><span class="said">${esc(text)}</span>`;
    el.dataset.tone = s.emotion;
    el.classList.add('show');
  }

  placard(p: { url: string; domain: string; at: THREE.Vector3 } | null) {
    this.pinned = this.pinned.filter((x) => x.el.id !== 'placard');
    const el = $('placard');
    if (!p) { el.classList.remove('show'); return; }
    el.innerHTML = `<span class="ico">↗</span>${esc(p.domain || 'link')}`;
    (el as HTMLAnchorElement).href = p.url;
    el.classList.add('show');
    this.pinned.push({ el, at: p.at.clone(), dy: -70 });
  }

  code(text: string | null) {
    const el = $('code');
    if (!text) { el.classList.remove('show'); return; }
    el.textContent = text;
    el.classList.add('show');
  }

  waiting(at: THREE.Vector3 | null) {
    this.pinned = this.pinned.filter((x) => x.el.id !== 'waiting');
    const el = $('waiting');
    if (!at) { el.classList.remove('show'); return; }
    el.classList.add('show');
    this.pinned.push({ el, at: at.clone(), dy: -54 });
  }

  /** Re-project everything pinned to the world. */
  update() {
    if (!this.camera) return;
    const place = (el: HTMLElement, at: THREE.Vector3, dy: number) => {
      this.v.copy(at).project(this.camera);
      const vis = this.v.z < 1 && Math.abs(this.v.x) < 1.2 && Math.abs(this.v.y) < 1.2;
      el.style.opacity = vis ? '' : '0';
      el.style.transform = `translate(-50%, -50%) translate(${(this.v.x * 0.5 + 0.5) * innerWidth}px, ${(-this.v.y * 0.5 + 0.5) * innerHeight + dy}px)`;
    };
    for (const p of this.pinned) place(p.el, p.at, p.dy);
    if (!this.labelsOn) return;
    // project labels, then nudge apart so none overlap
    const placed: { x: number; y: number; el: HTMLElement; vis: boolean }[] = [];
    for (const l of this.labels) {
      this.v.copy(l.at).project(this.camera);
      placed.push({ x: (this.v.x * 0.5 + 0.5) * innerWidth, y: (-this.v.y * 0.5 + 0.5) * innerHeight, el: l.el, vis: this.v.z < 1 && Math.abs(this.v.x) < 1.1 && Math.abs(this.v.y) < 1.1 });
    }
    placed.sort((a, b) => a.y - b.y);
    for (let i = 0; i < placed.length; i++) for (let j = 0; j < i; j++) {
      const a = placed[i], b = placed[j];
      if (Math.abs(a.x - b.x) < 175 && Math.abs(a.y - b.y) < 46) a.y = b.y + 46;
    }
    for (const q of placed) {
      q.el.style.opacity = q.vis ? '' : '0';
      q.el.style.transform = `translate(-50%, -50%) translate(${q.x}px, ${q.y}px)`;
    }
  }
}
