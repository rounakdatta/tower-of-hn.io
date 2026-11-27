// The reply sheet on its own, wired the way main.ts wires it (lazy, with the same callbacks), for the e2e tests:
// no 3D room, so it runs the same in Chromium, Firefox and WebKit, on desktops and phones.
import { you } from '../../src/you.ts';
import type { Reply, ReplyTarget } from '../../src/reply.ts';

you.wake();                                               // (the reply flag, on: as main.ts does when head.json says so)

const T: Record<string, ReplyTarget> = {
  bob: { id: 46100001, by: 'bob', story: 46100000, title: 'Show HN: A tower you can walk into' },
  carol: { id: 46100002, by: 'carol', story: 46100000, title: 'Show HN: A tower you can walk into' },
  dave: { id: 46000001, by: 'dave', story: 46000000, title: 'An old thread' },
  gone: { id: 46100003, by: '[deleted]', story: 46100000, title: 'Show HN: A tower you can walk into' },
};
const w = window as unknown as Record<string, unknown>;
const toasts: string[] = (w.__toasts = []) as string[];
let reply: Reply | null = null, sheet: Promise<Reply> | null = null;
function toast(html: string) { const t = document.getElementById('toast')!; t.innerHTML = html; t.classList.add('show'); toasts.push(t.textContent ?? ''); }
function replySheet() {
  return sheet ??= import('../../src/reply.ts').then(({ Reply }) => {
    const r = reply = new Reply();
    r.onListen = (on) => { w.__ducked = on; };
    r.onOpen = (on) => document.body.classList.toggle('reply-open', on);
    r.onLanded = (l) => { if (reply?.to?.id !== l.parent) toast(`Your reply to <b>${l.to}</b> is on Hacker News`); };
    return r;
  });
}
if (you.pending()) replySheet().then((r) => r.resume());
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-reply]')) b.onclick = () => replySheet().then((r) => r.show(T[b.dataset.reply!]));
addEventListener('keydown', (e) => { if (reply?.open && e.key === 'Escape') reply.escape(); });
w.__tohn = { you, open: (k: string) => replySheet().then((r) => r.show(T[k])), said: (k: string, text: string) => reply?.said(T[k].id, text), get reply() { return reply; } };
