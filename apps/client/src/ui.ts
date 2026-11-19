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
    this.labels = [];
    for (const s of spots) {
      if (s.bar) continue;
      const el = document.createElement('button');
      el.className = 'tlabel';
      const people = s.table.seated.length + s.table.standing.length;
      const voiced = s.table.turns.filter((t) => t.v).length;
      const mins = s.table.turns.reduce((n, t) => n + (t.v ? t.v[1] : 18), 0) / 60;
      el.innerHTML = `<b>${esc(s.table.turns[0].by)}</b> and ${people - 1} other${people === 2 ? '' : 's'}<span>${s.table.turns.length} turns · ~${Math.max(1, Math.round(mins))} min${voiced ? '' : ' · not voiced yet'}</span>`;
      el.onclick = (e) => { e.stopPropagation(); onPick(s); };
      box.appendChild(el);
      this.labels.push({ el, at: new THREE.Vector3(s.pos.x, roomY + 1.55, s.pos.z) });
    }
    const bar = spots.filter((s) => s.bar).length;
    if (bar) {
      const el = document.createElement('div');
      el.className = 'tlabel bar';
      el.innerHTML = `<b>The bar</b><span>${bar} one-off remark${bar === 1 ? '' : 's'}</span>`;
      box.appendChild(el);
      const b = spots.find((s) => s.bar)!;
      this.labels.push({ el, at: new THREE.Vector3(b.pos.x * 0.92, roomY + 1.7, b.pos.z * 0.92) });
    }
  }
  clearLabels() { $('labels').innerHTML = ''; this.labels = []; }

  subtitle(s: { name: string; text: string; color: string; emotion: string } | null) {
    const el = $('subs');
    clearTimeout(this.subTimer);
    if (!s) { this.subTimer = window.setTimeout(() => el.classList.remove('show'), 350); return; }
    const text = s.text.length > 320 ? s.text.slice(0, 317) + '…' : s.text;
    el.innerHTML = `<span class="who" style="color:${s.color}">${esc(s.name)}</span><span class="said">${esc(text)}</span>`;
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
    for (const l of this.labels) place(l.el, l.at, 0);
  }
}
