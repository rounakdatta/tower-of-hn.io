// The overlay: a thin DOM layer over the scene. Quiet by default; cinematic at a table.
import * as THREE from 'three/webgpu';
import { esc, domainOf } from './util.ts';
import { lookOf } from './people.ts';
import type { TableSpot } from './interior.ts';
import type { Line } from './performer.ts';
import { MOOD, moodOf, tableMood, deliveryWord, rowOf } from './mood.ts';

const $ = (id: string) => document.getElementById(id)!;

export class UI {
  private camera!: THREE.PerspectiveCamera;
  private pinned: { el: HTMLElement; at: THREE.Vector3; dy: number }[] = [];
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
  /** A short note at the top; with `act`, a note you can tap to go there (it stays a little longer). */
  toast(html: string, act?: () => void) {
    const t = $('toast');
    t.innerHTML = act ? `${html} <span class="go">→</span>` : html;
    t.classList.toggle('act', !!act);
    t.onclick = act ? (e) => { e.stopPropagation(); t.classList.remove('show'); act(); } : null;
    t.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => t.classList.remove('show'), act ? 6000 : 3600);
  }
  flash() { const f = $('fade'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go'); }
  hint(text: string) { $('hint').textContent = text; }
  /** under the aiming dot (first person at a desk): what a click would do */
  aim(text: string) { const el = $('aim'); if (el.textContent !== text) el.textContent = text; el.classList.toggle('show', !!text); }

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

  /** On foot beside a table: the one thing to do there. */
  sitDown(s: { name: string; go: () => void; key?: boolean } | null) {
    const el = $('sitdown');
    if (!s) { el.classList.remove('show'); return; }
    const label = `Sit down with ${s.name}`;
    if (el.dataset.label !== label) { el.dataset.label = label; el.innerHTML = `${esc(label)}${s.key ? ' <kbd>E</kbd>' : ''}`; }
    el.onclick = (e) => { e.stopPropagation(); s.go(); };
    el.classList.add('show');
  }

  /**
   * A commenter's card: their face (the same one they wear in the room), how long they've been on Hacker News, a
   * one-line summary of what they talk about with a few interests (written by AI from their public comments, and
   * labelled so), their own bio, and what they've said on this floor. `refresh`: the summary arrived for an open card.
   */
  profile(p: { name: string; said: number; tables: number; data: null | { karma?: number; created?: number; about?: string; brief?: string; interests?: string[]; role?: string } } | null, refresh = false) {
    const el = $('profile');
    if (!p) { el.classList.remove('show'); el.dataset.name = ''; document.body.classList.remove('card-open'); return; }
    if (refresh && el.dataset.name !== p.name) return;          // they closed it, or opened someone else's
    document.body.classList.add('card-open');
    el.dataset.name = p.name;
    const d = p.data;
    const since = d?.created ? new Date(d.created * 1000).getFullYear() : 0;
    const meta = d ? [d.karma !== undefined ? `${d.karma.toLocaleString()} karma` : '', since ? `on Hacker News since ${since}` : ''].filter(Boolean).join(' · ') : '';
    const here = p.said ? `${p.said} comment${p.said === 1 ? '' : 's'} on this floor${p.tables > 1 ? `, at ${p.tables} tables` : ''}` : '';
    const brief = d?.brief
      ? `<p class="brief">${esc(d.brief)}</p>${d.interests?.length ? `<div class="chips">${d.interests.slice(0, 6).map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}<p class="ai">Summarised by AI from their public comments</p>`
      : d ? '' : '<p class="brief wait">Reading their comments…</p>';
    const about = d?.about ? `<blockquote>${esc(d.about)}</blockquote>` : '';
    el.innerHTML = `<button class="x" type="button" aria-label="Close">×</button>
      <div class="who">${avatar(p.name)}<div><h2>${esc(p.name)}</h2>${d?.role ? `<div class="role">${esc(d.role)}</div>` : ''}<div class="meta">${esc(meta)}</div></div></div>
      ${brief}${about}
      <div class="foot"><span class="here">${esc(here)}</span><a href="https://news.ycombinator.com/user?id=${encodeURIComponent(p.name)}" target="_blank" rel="noopener">On Hacker News ↗</a></div>`;
    (el.querySelector('.x') as HTMLElement).onclick = () => this.profile(null);
    el.classList.add('show');
  }

  floorHeader(f: { rank: number; title: string; id: number; url?: string } | null) {
    const el = $('floorbar');
    if (!f) { el.classList.remove('show'); return; }
    $('ftitle').innerHTML = `<span class="rank">${f.rank}</span> <a href="https://news.ycombinator.com/item?id=${f.id}" target="_blank" rel="noopener">${esc(f.title)}</a>`;
    el.classList.add('show');
  }

  /**
   * Signs over the tables near you, to find your way and choose where to stand: what each table is about (the first
   * words of the comment that started it) in its mood's colour, and, at a table that is talking, who has the floor
   * and how they're saying it. Only the nearest few in view, above the heads (never over faces), and never piled on
   * each other: a sign that would overlap a nearer one waits until there's room. Built once per floor; placed every
   * frame without reading layout (each sign's size is measured only when its words change).
   */
  private signData: { spots: TableSpot[]; roomY: number; onPick: (s: TableSpot) => void; best?: TableSpot } | null = null;
  private signPool: { el: HTMLButtonElement; key: string; w: number; h: number; spot: TableSpot | null }[] = [];
  private labelsOn = false;
  tableLabels(spots: TableSpot[], roomY: number, onPick: (s: TableSpot) => void, best?: TableSpot) {
    this.signData = { spots, roomY, onPick, best };
    $('labels').classList.toggle('show', this.labelsOn);
  }
  clearLabels() { $('labels').innerHTML = ''; this.signPool = []; this.signData = null; this.showLabels(false); }
  showLabels(on: boolean) { this.labelsOn = on; $('labels').classList.toggle('show', on); }
  /** the "start here" kick stays until you've chosen a table yourself */
  chosen = false;
  private cand: { s: TableSpot; d: number; x: number; y: number }[] = [];
  private rects: { x: number; y: number; w: number; h: number }[] = [];
  signs(you: THREE.Vector3, focus: TableSpot | null, speaking: (s: TableSpot) => Line | null) {
    const data = this.signData;
    if (!data || !this.labelsOn || !this.camera) return;
    const compact = innerWidth < 700, max = compact ? 4 : 6, box = $('labels');
    // candidates: tables in front of you, near enough to matter, the one you're with first, then the nearest
    this.cand.length = 0;
    for (const s of data.spots) {
      const d = Math.hypot(s.pos.x - you.x, s.pos.z - you.z);
      if (d > (s.bar ? 7.5 : 11.5) || (s === focus && d < s.radius + 0.4)) continue;   // too far, or right on top of it
      this.v.set(s.bar ? s.pos.x * 0.92 : s.pos.x, data.roomY + (s.bar ? 2.0 : 2.08), s.bar ? s.pos.z * 0.92 : s.pos.z).project(this.camera);
      if (this.v.z >= 1 || Math.abs(this.v.x) > 1.05 || this.v.y > 1.05 || this.v.y < -0.6) continue;
      this.cand.push({ s, d: s === focus ? -1 : d + (s.bar ? 2 : 0), x: (this.v.x * 0.5 + 0.5) * innerWidth, y: (-this.v.y * 0.5 + 0.5) * innerHeight });
    }
    this.cand.sort((p, q) => p.d - q.d);
    this.rects.length = 0;
    let used = 0;
    for (const c of this.cand) {
      if (used >= max) break;
      const slot = this.signPool[used] ?? this.newSign(box);
      this.fill(slot, c.s, data, c.s === focus, speaking(c.s), compact);
      const k = c.s === focus ? 1.04 : Math.max(0.8, Math.min(1, 1.08 - c.d * 0.035));
      const w = slot.w * k, h = slot.h * k, x = Math.max(w / 2 + 8, Math.min(innerWidth - w / 2 - 8, c.x)), y = Math.max(h / 2 + 64, c.y - h / 2);
      if (this.rects.some((r) => Math.abs(r.x - x) < (r.w + w) / 2 + 6 && Math.abs(r.y - y) < (r.h + h) / 2 + 4)) continue;
      this.rects.push({ x, y, w, h });
      slot.el.style.transform = `translate(${(x - slot.w / 2).toFixed(1)}px, ${(y - slot.h / 2).toFixed(1)}px) scale(${k.toFixed(3)})`;
      slot.el.style.opacity = c.s === focus ? '1' : String(Math.max(0.72, 1 - c.d * 0.03).toFixed(2));
      slot.el.classList.add('on');
      used++;
    }
    for (let i = used; i < this.signPool.length; i++) { const p = this.signPool[i]; if (p.spot) { p.el.classList.remove('on'); p.spot = null; } }
  }
  private newSign(box: HTMLElement) {
    const el = document.createElement('button');
    el.className = 'tlabel';
    box.appendChild(el);
    const slot = { el, key: '', w: 0, h: 0, spot: null as TableSpot | null };
    el.onclick = (e) => { e.stopPropagation(); if (slot.spot && this.signData) this.signData.onPick(slot.spot); };
    this.signPool.push(slot);
    return slot;
  }
  private fill(slot: { el: HTMLButtonElement; key: string; w: number; h: number; spot: TableSpot | null }, s: TableSpot, data: NonNullable<UI['signData']>, focus: boolean, line: Line | null, compact: boolean) {
    slot.spot = s;
    const t = s.table, people = new Set(t.turns.map((u) => u.by)).size, mood = tableMood(t.turns).mood;
    const now = line ? moodOf(line.side.emotion, line.side.stance, line.side.intensity) : mood;
    const word = line ? deliveryWord(line.side.emotion, line.side.stance, line.side.intensity) : '';
    const kick = !this.chosen && data.best === s ? 'Start here' : '';
    const key = `${t.root}|${focus}|${line ? line.turn.by + ':' + word : ''}|${mood}|${people}|${kick}|${compact}`;
    if (key === slot.key) return;
    slot.key = key;
    let html: string;
    if (s.bar) html = `<b class="gist">The bar</b><span class="meta">${t.turns.length} one-liner${t.turns.length === 1 ? '' : 's'}</span>`;
    else {
      const gist = t.gist ? (compact && t.gist.length > 46 ? t.gist.slice(0, 44).replace(/\s+\S*$/, '') + '…' : t.gist) : '';
      const row = rowOf(t.turns);
      const meta = line
        ? `<em style="color:${MOOD[now].color}">${esc(line.turn.by)}</em>${word ? ` · ${esc(word)}` : ' is speaking'}`
        : `${row && (mood === 'heated' || mood === 'tense') ? `${esc(row[0])} ⇄ ${esc(row[1])}` : `${people} ${people === 1 ? 'person' : 'people'}`}${mood !== 'calm' ? ` · <em style="color:${MOOD[mood].color}">${MOOD[mood].word}</em>` : ''}`;
      html = `${kick ? `<i class="kick">${kick}</i>` : ''}<b class="gist"><i class="dot" style="background:${MOOD[now].color}"></i>${gist ? `“${esc(gist)}”` : `${esc(t.turns[0]?.by ?? '')}${people > 1 ? ` <em>+${people - 1}</em>` : ''}`}</b><span class="meta">${meta}</span>`;
    }
    slot.el.innerHTML = html;
    slot.el.classList.toggle('focus', focus);
    slot.el.classList.toggle('best', !!kick);
    slot.el.classList.toggle('talk', !!line);
    slot.el.style.transform = 'none';
    slot.w = slot.el.offsetWidth; slot.h = slot.el.offsetHeight;   // measured once per change of words
  }

  subtitle(s: { name: string; to?: string; text: string; color: string; emotion: string; stance?: string; intensity?: number } | null) {
    const el = $('subs');
    clearTimeout(this.subTimer);
    if (!s) { this.subTimer = window.setTimeout(() => el.classList.remove('show'), 350); return; }
    const text = s.text.length > 320 ? s.text.slice(0, 317) + '…' : s.text;
    // how it's being said, in the mood's colour (nothing for a plain line)
    const word = deliveryWord(s.emotion, s.stance, s.intensity), m = moodOf(s.emotion, s.stance, s.intensity);
    const how = word ? `<span class="how" style="color:${MOOD[m].color};border-color:${MOOD[m].color}55">${esc(word)}</span>` : '';
    el.innerHTML = `<span class="who" style="color:${s.color}">${esc(s.name)}${s.to && s.to !== s.name ? `<span class="to"> → ${esc(s.to)}</span>` : ''}</span>${how}<span class="said">${esc(text)}</span>`;
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

  }
}

/** A commenter's face as a small drawing: the same skin, hair, glasses and beard as their character in the room. */
function avatar(name: string) {
  const l = lookOf(name), hex = (c: { getHexString(): string }) => '#' + c.getHexString();
  const skin = hex(l.skin), hair = hex(l.hair), out = hex(l.outfit);
  const e = 3.2 * l.eye, gx = 9 * l.gap;
  const hairPath = [
    '',                                                                                        // bald
    '<path d="M14 40c0-17 12-26 26-26s26 9 26 26c-6-7-15-11-26-11s-20 4-26 11z" fill="HAIR"/>',   // short
    '<path d="M13 42c0-19 12-28 27-28s27 9 27 28v20c-3-12-6-24-27-30-21 6-24 18-27 30z" fill="HAIR"/>', // long
    '<circle cx="40" cy="13" r="7" fill="HAIR"/><path d="M14 40c0-17 12-26 26-26s26 9 26 26c-6-7-15-11-26-11s-20 4-26 11z" fill="HAIR"/>', // bun
    '<path d="M12 38c0-18 12-27 28-27s28 9 28 27z" fill="OUT"/><rect x="11" y="33" width="58" height="7" rx="3.5" fill="OUT"/>',   // beanie
    '<circle cx="40" cy="30" r="27" fill="HAIR"/>',                                             // curly
  ][l.style] ?? '';
  return `<svg class="ava" viewBox="0 0 80 80" aria-hidden="true">
    <rect width="80" height="80" rx="40" fill="#141821"/>
    <path d="M14 80c2-12 12-18 26-18s24 6 26 18z" fill="${out}"/>
    ${l.style === 5 ? hairPath.replace('HAIR', hair) : ''}
    <circle cx="40" cy="42" r="24" fill="${skin}"/>
    ${l.beard ? `<path d="M18 46c2 14 10 20 22 20s20-6 22-20c-6 6-12 8-22 8s-16-2-22-8z" fill="${hair}"/>` : ''}
    ${l.style !== 5 ? hairPath.replace(/HAIR/g, hair).replace(/OUT/g, out) : ''}
    <ellipse cx="${40 - gx}" cy="41" rx="${e + 1.3}" ry="${e + 1.6}" fill="#f2ede4"/><ellipse cx="${40 + gx}" cy="41" rx="${e + 1.3}" ry="${e + 1.6}" fill="#f2ede4"/>
    <circle cx="${40 - gx}" cy="41.5" r="${e}" fill="#141012"/><circle cx="${40 + gx}" cy="41.5" r="${e}" fill="#141012"/>
    ${l.glasses ? `<circle cx="${40 - gx}" cy="41" r="${e + 4.6}" fill="none" stroke="#17181d" stroke-width="2.2"/><circle cx="${40 + gx}" cy="41" r="${e + 4.6}" fill="none" stroke="#17181d" stroke-width="2.2"/><path d="M${40 - gx + e + 4.6} 41h${2 * gx - 2 * (e + 4.6)}" stroke="#17181d" stroke-width="2"/>` : ''}
    <path d="M33 53q7 5 14 0" fill="none" stroke="#5a1f1f" stroke-width="2.2" stroke-linecap="round"/>
  </svg>`;
}
