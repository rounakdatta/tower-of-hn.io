import { test } from 'node:test';
import assert from 'node:assert/strict';
import { speakable, respell, quotes, sentences } from './speakable.ts';
import { playOrder, seat, voiceFor } from './conversation.ts';

test('verbatim words, jargon respelled', () => {
  const s = speakable('Just another set of examples of programmers who are bad at C.<p>EDIT: this is UB in nginx, see CVE-2026-123007.');
  assert.equal(s.segments.length, 2);
  assert.deepEqual(s.segments.map((x) => x.kind), ['say', 'say']);
  assert.match((s.segments[1] as any).text, /U\.B\. in engine-x, see C\.V\.E\. 2026, 123007\./);
  assert.match(s.display, /EDIT: this is UB in nginx/);            // subtitles keep what they wrote
});

test('a bare link becomes a placard, not speech', () => {
  const s = speakable('The patch seems like a bug that can happen anywhere<p><a href="https:&#x2F;&#x2F;github.com&#x2F;nginx&#x2F;nginx&#x2F;commit&#x2F;e27f5f" rel="nofollow">https:&#x2F;&#x2F;github.com&#x2F;nginx&#x2F;nginx&#x2F;commit&#x2F;e27f5f</a>');
  assert.deepEqual(s.segments.map((x) => x.kind), ['say', 'link']);
  assert.equal((s.segments[1] as any).domain, 'github.com');
  assert.equal((s.segments[1] as any).url, 'https://github.com/nginx/nginx/commit/e27f5f');
});

test('italics become spoken emphasis; code goes on the table', () => {
  const s = speakable('This is <i>not</i> the overflow.<p><pre><code>  let x = a - b;\n  copy(x);\n</code></pre>');
  assert.equal((s.segments[0] as any).text, 'This is (((not))) the overflow.');
  assert.equal(s.segments[1].kind, 'code');
  assert.equal((s.segments[1] as any).lines, 2);
});

test('a quote of the parent is recognised so its own voice can replay it', () => {
  const parent = { id: 7, text: 'Given that on modern CPUs cycles are quite fast, always-checked integer operations sound like an extremely good idea.' };
  const s = speakable('&gt; always-checked integer operations sound like an extremely good idea<p>Only if you can afford the branch.', parent);
  assert.equal(s.segments[0].kind, 'quote');
  assert.equal((s.segments[0] as any).of, 7);
  assert.ok(!quotes('something entirely different here', parent.text));
});

test('respell leaves words that merely contain a lexicon entry alone', () => {
  assert.equal(respell('JSONB columns and a json-schema'), 'JSONB columns and a json-schema');
  assert.equal(respell('Use SQLite, not MySQL.'), 'Use S-Q-Lite, not My-S-Q-L.');
});

test('sentences survive abbreviations', () => {
  assert.deepEqual(sentences('Use a lexicon, e.g. for nginx. Then test it. Done!'), ['Use a lexicon, e.g. for nginx.', 'Then test it.', 'Done!']);
});

test('play order: depth-first, quick replies, a beat when backtracking; dead comments skipped but their replies kept', () => {
  const t = { id: 1, by: 'a', text: 'x', kids: [
    { id: 2, by: 'b', text: 'x', kids: [{ id: 3, by: 'a', text: 'x' }] },
    { id: 4, by: 'c', text: 'x', dead: true, kids: [{ id: 5, by: 'd', text: 'x' }] },
  ] };
  const o = playOrder(t);
  assert.deepEqual(o.map((x) => x.id), [1, 2, 3, 5]);
  assert.deepEqual(o.map((x) => x.gapMs), [0, 220, 220, 800]);
  assert.equal(o[3].replyTo, 1);
  assert.deepEqual(seat(o, 2), { seated: ['a', 'b'], standing: ['d'] });
});

test('a voice is stable per person and unique at a table', () => {
  const v1 = voiceFor('K0nserv', new Set(), 115);
  assert.equal(voiceFor('K0nserv', new Set(), 115), v1);
  assert.notEqual(voiceFor('K0nserv', new Set([v1]), 115), v1);
});

test('moderation placeholders are skipped, their replies still play', () => {
  const t = playOrder({ id: 1, by: 'a', text: 'root', kids: [{ id: 2, by: 'b', text: '[delayed]', kids: [{ id: 3, by: 'c', text: 'still here' }] }] });
  assert.deepEqual(t.map((x) => x.id), [1, 3]);
  assert.equal(t[1].replyTo, 1);
});

test('opted-out users are left out, the conversation around them still plays', async () => {
  const { Live } = await import('./live.ts');
  const live = new Live({ snapshotEvery: 1 });
  live.upsert({ id: 1, type: 'story', title: 'S', kids: [2] });
  live.upsert({ id: 2, type: 'comment', by: 'a', text: 'root', parent: 1, kids: [3] });
  live.upsert({ id: 3, type: 'comment', by: 'quiet', text: 'please no', parent: 2, kids: [4] });
  live.upsert({ id: 4, type: 'comment', by: 'c', text: 'reply', parent: 3 });
  live.setTower([1]);
  live.optOut.add('quiet');
  live.touchAll();
  const r = live.tick(Date.now());
  const turns = r.snapshots[0].tables[0].turns;
  assert.deepEqual(turns.map((t) => t.by), ['a', 'c']);
});

test('a story that left long ago is forgotten whole, others untouched', async () => {
  const { Live } = await import('./live.ts');
  const live = new Live({ snapshotEvery: 1 });
  live.upsert({ id: 1, type: 'story', title: 'old', kids: [2] });
  live.upsert({ id: 2, type: 'comment', by: 'a', text: 'x', parent: 1, kids: [3] });
  live.upsert({ id: 3, type: 'comment', by: 'b', text: 'y', parent: 2 });
  live.upsert({ id: 10, type: 'story', title: 'new', kids: [11] });
  live.upsert({ id: 11, type: 'comment', by: 'c', text: 'z', parent: 10 });
  live.markVoiced(3, 'c/3.r.json', 1);
  assert.equal(live.forget(1), 3);
  assert.deepEqual([...live.items.keys()].sort(), [10, 11]);
  assert.equal(live.voiced.has(3), false);
  assert.equal(live.storyOf(11), 10);
});

test('every change a listener can hear makes a new revision: more clips, the final, a removed turn', async () => {
  const { Live } = await import('./live.ts');
  const live = new Live({ snapshotEvery: 1, base: 1000 });
  live.upsert({ id: 1, type: 'story', title: 'S', kids: [2] });
  live.upsert({ id: 2, type: 'comment', by: 'a', text: 'root', parent: 1, kids: [3] });
  live.upsert({ id: 3, type: 'comment', by: 'b', text: 'long reply', parent: 2 });
  live.setTower([1]);
  const revs: number[] = [];
  const step = (fn: () => void) => { fn(); live.touchAll(); const r = live.tick(Date.now()); revs.push(r.snapshots[0]?.rev ?? -1); };
  step(() => {});
  step(() => live.markVoiced(3, 'c/3.r.p1.json', 2));
  step(() => live.markVoiced(3, 'c/3.r.p2.json', 5));
  step(() => live.markVoiced(3, 'c/3.r.json', 9));
  step(() => live.upsert({ id: 3, type: 'comment', by: 'b', dead: true, parent: 2 }));
  step(() => {});                                                 // nothing changed: no new revision
  assert.ok(revs.slice(0, 5).every((r, k) => r > 1000 && (k === 0 || r > revs[k - 1])), String(revs));
  assert.equal(revs[5], -1);
});

test('revisions keep rising for a story that is forgotten and comes back', async () => {
  const { Live } = await import('./live.ts');
  const live = new Live({ snapshotEvery: 1, base: 5000 });
  live.upsert({ id: 1, type: 'story', title: 'S', kids: [2] });
  live.upsert({ id: 2, type: 'comment', by: 'a', text: 'x', parent: 1 });
  live.setTower([1]);
  const first = live.tick(Date.now()).snapshots[0].rev;
  live.setTower([]); live.forget(1);
  live.upsert({ id: 1, type: 'story', title: 'S', kids: [2] });
  live.upsert({ id: 2, type: 'comment', by: 'a', text: 'x', parent: 1 });
  live.setTower([1]);
  const again = live.tick(Date.now());
  assert.ok(again.snapshots[0].rev > first && again.head.epoch > 5000);
});
