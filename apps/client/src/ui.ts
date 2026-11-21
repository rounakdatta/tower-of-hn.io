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

  /** The splash is in the page from the first paint (no black screen while loading); this makes it a door. */
  splash(onEnter: () => void) {
    const s = $('splash'), b = $('enter') as HTMLButtonElement;
    s.classList.add('show');
    b.disabled = false; b.textContent = 'Enter the tower';
    const go = () => { s.classList.remove('show'); s.classList.add('gone'); onEnter(); };
    b.addEventListener('click', go, { once: true });
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

  /** The floor in focus on the tower: its title big enough to read on a phone, and the one thing to do next. */
  focusCard(f: { rank: number; title: string; url: string; score: number; comments: number; act: number; people?: number } | null, onGo?: () => void) {
    const el = $('focus');
    if (!f) { el.classList.remove('show'); return; }
    const dom = domainOf(f.url);
    $('frank').textContent = String(f.rank);
    $('fname').textContent = f.title;
    $('fname').title = f.title;
    // the crowd first (how many different people are in there), then the rest
    const crowd = f.people ? `<span class="crowd"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="5.5" cy="5" r="2.4"/><circle cx="11" cy="5.6" r="2"/><path d="M1 13.5c.3-2.9 2.2-4.4 4.5-4.4s4.2 1.5 4.5 4.4zM10.3 13.5c-.1-1.6-.7-2.9-1.6-3.7.6-.4 1.4-.6 2.3-.6 2 0 3.5 1.3 3.8 4.3z"/></svg>${f.people} ${f.people === 1 ? 'person' : 'people'}</span> · ` : '';
    $('fmeta').innerHTML = `${crowd}${f.comments} comments${f.act ? ` · <b>${f.act} new</b>` : ''} · ${f.score} points${dom ? ' · ' + esc(dom) : ''}`;
    $('fmeta').title = `${f.people ?? '?'} people · ${f.comments} comments (${f.act} in the last 15 minutes) · ${f.score} points${dom ? ' · ' + dom : ''}`;
    $('fgo').setAttribute('aria-label', `Listen in on floor ${f.rank}: ${f.title}`);
    if (onGo) el.onclick = (e) => { e.stopPropagation(); onGo(); };
    el.classList.add('show');
  }

  /** The elevator: a tick per floor, the one in focus lit and numbered; drag or tap it to go up and down. */
  private ticks: HTMLElement[] = [];
  elevator(n: number, rank: number, heat: number[], pick: (rank: number) => void, crowd: number[] = []) {
    const el = $('elevator');
    if (this.ticks.length !== n) {
      el.innerHTML = '';
      this.ticks = Array.from({ length: n }, () => el.appendChild(document.createElement('i')));
      const num = el.appendChild(document.createElement('span'));
      num.className = 'num';
      const at = (y: number) => { const r = el.getBoundingClientRect(); return Math.max(0, Math.min(n - 1, Math.round((y - r.top) / r.height * (n - 1)))); };
      let held = false;
      el.onpointerdown = (e) => { held = true; el.setPointerCapture(e.pointerId); this.pick(at(e.clientY)); e.stopPropagation(); };
      el.onpointermove = (e) => { if (held) this.pick(at(e.clientY)); };
      el.onpointerup = el.onpointercancel = () => { held = false; };
      el.onkeydown = (e) => {
        const cur = Number(el.getAttribute('aria-valuenow') ?? 1) - 1;
        const step = e.key === 'ArrowDown' || e.key === 'PageDown' ? 1 : e.key === 'ArrowUp' || e.key === 'PageUp' ? -1 : 0;
        if (step) { e.preventDefault(); this.pick(cur + step); }
        else if (e.key === 'Home') { e.preventDefault(); this.pick(0); }
        else if (e.key === 'End') { e.preventDefault(); this.pick(n - 1); }
      };
    }
    this.pick = (r: number) => pick(Math.max(0, Math.min(n - 1, r)));
    // each tick as long as its floor is crowded: the rail is a picture of where the people are
    const most = Math.max(1, ...crowd);
    this.ticks.forEach((t, k) => {
      t.classList.toggle('on', k === rank); t.classList.toggle('hot', (heat[k] ?? 0) >= 5);
      t.style.width = k === rank ? '' : `${Math.round(5 + 11 * Math.sqrt((crowd[k] ?? 0) / most))}px`;
    });
    el.setAttribute('aria-valuemax', String(n));
    el.setAttribute('aria-valuenow', String(rank + 1));
    const num = el.querySelector('.num') as HTMLElement;
    num.textContent = String(rank + 1);
    const t = this.ticks[rank];
    if (t) num.style.top = `${t.offsetTop + 1}px`;
    el.classList.add('show');
  }
  private pick: (rank: number) => void = () => {};

  floorHeader(f: { rank: number; title: string; id: number; url?: string } | null) {
    const el = $('floorbar');
    if (!f) { el.classList.remove('show'); return; }
    $('ftitle').innerHTML = `<span class="rank">${f.rank}</span> <a href="https://news.ycombinator.com/item?id=${f.id}" target="_blank" rel="noopener">${esc(f.title)}</a>`;
    el.classList.add('show');
  }

  /**
   * A label over each of the liveliest tables (and the bar). Updated in place as the floor changes: rebuilding them
   * every revision (every few seconds while voicing runs) swallowed taps that landed mid-rebuild.
   */
  private labelKey = '';
  tableLabels(spots: TableSpot[], roomY: number, onPick: (s: TableSpot) => void, best?: TableSpot) {
    const box = $('labels');
    box.classList.toggle('show', this.labelsOn);
    const tables = spots.filter((x) => !x.bar).slice(0, 5), bar = spots.filter((x) => x.bar);
    const key = tables.map((x) => x.table.root).join(',') + `|${bar.length}`;
    const html = (s: TableSpot) => {
      const people = new Set(s.table.turns.map((t) => t.by)).size;
      const mins = s.table.turns.reduce((n, t) => n + (t.v ? t.v[1] : 18), 0) / 60;
      const start = best && s.table.root === best.table.root;
      return `${start ? '<i class="kick">Start here</i>' : ''}<b>${esc(s.table.turns[0].by)}${people > 1 ? ` <em>+${people - 1}</em>` : ''}</b><span>${s.table.turns.length} turns · ~${Math.max(1, Math.round(mins))} min</span>`;
    };
    if (key === this.labelKey && this.labels.length === tables.length + (bar.length ? 1 : 0)) {
      tables.forEach((s, k) => {
        const el = this.labels[k].el, h = html(s);
        if (el.innerHTML !== h) el.innerHTML = h;
        el.classList.toggle('best', !!best && s.table.root === best.table.root);
      });
      return;
    }
    this.labelKey = key;
    box.innerHTML = '';
    this.labels = [];
    for (const s of tables) {
      const el = document.createElement('button');
      el.className = 'tlabel';
      if (best && s.table.root === best.table.root) el.classList.add('best');
      el.innerHTML = html(s);
      el.onclick = (e) => { e.stopPropagation(); onPick(s); };
      box.appendChild(el);
      this.labels.push({ el, at: new THREE.Vector3(s.pos.x, roomY + 1.55, s.pos.z) });
    }
    if (bar.length) {
      const el = document.createElement('button');
      el.className = 'tlabel bar';
      el.innerHTML = `<b>The bar</b><span>${bar.length} one-liner${bar.length === 1 ? '' : 's'}</span>`;
      el.onclick = (e) => { e.stopPropagation(); onPick(bar[0]); };
      box.appendChild(el);
      this.labels.push({ el, at: new THREE.Vector3(bar[0].pos.x * 0.92, roomY + 1.7, bar[0].pos.z * 0.92) });
    }
  }
  clearLabels() { $('labels').innerHTML = ''; this.labels = []; this.labelKey = ''; this.showLabels(false); }
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
    if (!p || !/^https?:\/\//i.test(p.url)) { el.classList.remove('show'); return; }   // plain web links only
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
      // never cut off at the screen's edge: a label half off a phone is a button nobody can press
      const w = q.el.offsetWidth / 2 + 8;
      q.el.style.opacity = q.vis ? '' : '0';
      q.el.style.transform = `translate(-50%, -50%) translate(${Math.max(w, Math.min(innerWidth - w, q.x))}px, ${q.y}px)`;
    }
  }
}
