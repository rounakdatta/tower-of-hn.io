// You, as far as this page knows: your Hacker News name (kept in this browser only, and only once you've posted from
// here or typed it), whether the companion extension is installed, and the answers to you that are worth a note.
// Small and loaded with the page; the reply sheet itself (reply.ts) loads the first time you reply.
const HN = 'https://hacker-news.firebaseio.com/v0';
const KEY = 'tohn-me', HANDOFF = 'tohn-handoff';
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };   // storage can be off

export const you = {
  /** your Hacker News username, or '' */
  me: read(KEY) ?? '',
  /** the companion extension answered (it posts with your own HN session) */
  ext: false,
  set(name: string) {
    const n = name.trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 15);
    you.me = n;
    try { if (n) localStorage.setItem(KEY, n); else localStorage.removeItem(KEY); } catch { /* private mode */ }
  },
  /** a reply handed to HN in the last half hour and not seen there yet (a reload, or a phone that dropped the tab) */
  pending: () => { try { const h = JSON.parse(read(HANDOFF) ?? 'null'); return !!h && Date.now() - h.at < 1_800_000; } catch { return false; } },
};

// a companion extension says hello through the page (its content script listens on our origin, and only there)
addEventListener('message', (e) => {
  if (e.source !== window || !e.data || typeof e.data !== 'object' || e.data.tohn !== 'here') return;
  you.ext = true;
  if (!you.me && typeof e.data.user === 'string' && e.data.user) you.set(e.data.user);
});
window.postMessage({ tohn: 'hello' }, location.origin);

/**
 * Replies to you, anywhere on Hacker News: your recent comments, checked every couple of minutes while the page is
 * open and visible, for answers that weren't there before. (The HN API answers browsers directly: nothing of yours
 * goes through our server.)
 */
export class Replies {
  private seen = new Set<number>();
  private primed = false;
  private timer = 0;
  onReply: (r: { id: number; by: string; parent: number; story?: number }) => void = () => {};

  private name = '';
  start(me: () => string) {
    clearInterval(this.timer);
    const tick = async () => {
      const name = me();
      if (!name || document.hidden) return;
      if (name !== this.name) { this.name = name; this.seen.clear(); this.primed = false; }
      try {
        const u = await (await fetch(`${HN}/user/${encodeURIComponent(name)}.json`)).json() as { submitted?: number[] } | null;
        const mine = (u?.submitted ?? []).slice(0, 25);
        const items = await Promise.all(mine.map((id) => fetch(`${HN}/item/${id}.json`).then((r) => r.json()).catch(() => null))) as ({ id: number; kids?: number[]; type?: string; parent?: number } | null)[];
        for (const it of items) {
          if (!it || it.type !== 'comment') continue;
          for (const k of it.kids ?? []) {
            if (this.seen.has(k)) continue;
            this.seen.add(k);
            if (!this.primed) continue;                 // the first look only learns what's there already
            const r = await (await fetch(`${HN}/item/${k}.json`)).json() as { by?: string; dead?: boolean; deleted?: boolean } | null;
            if (r?.by && !r.dead && !r.deleted && r.by !== name) this.onReply({ id: k, by: r.by, parent: it.id });
          }
        }
        this.primed = true;
      } catch { /* offline: next time */ }
    };
    tick();
    this.timer = window.setInterval(tick, 120_000);
  }
}
