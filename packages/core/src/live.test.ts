import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Live } from './live.ts';

const story = { id: 100, type: 'story', title: 'Show HN: a tower', score: 10, descendants: 2, kids: [101, 104], by: 'op' };
const c = (id: number, parent: number, by: string, kids: number[] = []) => ({ id, type: 'comment', parent, by, text: `comment ${id}`, kids });

test('first tick builds the floor, snapshots it, and emits one delta', () => {
  const live = new Live();
  for (const it of [story, c(101, 100, 'a', [102]), c(102, 101, 'b'), c(104, 100, 'c')]) live.upsert(it);
  live.setTower([100]);
  const out = live.tick(1000);
  assert.equal(out.delta?.epoch, 1);
  assert.deepEqual(out.delta?.tower, [100]);
  assert.equal(out.delta?.turns?.length, 3);
  assert.equal(out.snapshots.length, 1);
  assert.deepEqual(out.snapshots[0].tables.map((t) => t.turns.map((u) => u.id)), [[101, 102], [104]]);
  assert.deepEqual(out.head.floors, { 100: 1 });
});

test('a quiet tick emits nothing new; a late reply lands mid-table with its position', () => {
  const live = new Live();
  for (const it of [story, c(101, 100, 'a', [102]), c(102, 101, 'b'), c(104, 100, 'c')]) live.upsert(it);
  live.setTower([100]);
  live.tick(1000);
  assert.equal(live.tick(3000).delta, undefined);
  // someone answers 101 again: HN ranks the new reply 105 first under 101
  live.upsert(c(105, 101, 'd'));
  live.upsert(c(101, 100, 'a', [105, 102]));
  const out = live.tick(5000);
  assert.equal(out.delta?.epoch, 2);
  assert.deepEqual(out.delta?.turns?.map((t) => [t.table, t.at, t.turn.id]), [[0, 1, 105]]);
  assert.equal(out.head.floors[100], 2);
  assert.equal(out.snapshots.length, 0);                    // deltas until the next snapshot is due
});

test('rank changes and deletions travel in the delta', () => {
  const live = new Live();
  const other = { id: 200, type: 'story', title: 'Other', score: 5, descendants: 0, kids: [] };
  for (const it of [story, other, c(101, 100, 'a'), c(104, 100, 'c')]) live.upsert(it);
  live.setTower([100, 200]);
  live.tick(1000);
  live.setTower([200, 100]);
  live.upsert({ id: 104, deleted: true });
  const out = live.tick(3000);
  assert.deepEqual(out.delta?.tower, [200, 100]);
  assert.deepEqual(out.delta?.gone, [104]);
});

test('a voice is fixed at first sight: a late reply that reshuffles seats cannot change it', () => {
  const live = new Live();
  for (const it of [story, c(101, 100, 'a', [102]), c(102, 101, 'b', [103]), c(103, 102, 'a'), c(104, 100, 'c')]) live.upsert(it);
  live.setTower([100]);
  const t = live.tick(1000).snapshots[0].tables[0].turns;
  assert.equal(t[0].voice, t[2].voice);                      // 'a' keeps one voice within the table
  const vb = t[1].voice;
  live.upsert(c(106, 101, 'z'));                              // a newcomer slots in before 'b'
  live.upsert(c(101, 100, 'a', [106, 102]));
  const d = live.tick(3000).delta!;
  assert.equal(d.turns?.[0].turn.by, 'z');
  assert.equal(live.voiceOf('b'), vb);                        // b's existing audio stays valid
  assert.equal(live.voiceOf('a'), t[0].voice);
});

test('a voiced comment bumps its floor and travels in the delta; head carries titles and activity', () => {
  const live = new Live({ snapshotEvery: 1 });
  const now = Date.now();
  for (const it of [story, { ...c(101, 100, 'a'), time: Math.floor(now / 1000) - 60 }, c(104, 100, 'c')]) live.upsert(it);
  live.setTower([100]);
  const first = live.tick(now);
  assert.equal(first.head.stories[100][0], 'Show HN: a tower');
  assert.equal(first.head.act[100], 1);
  live.markVoiced(101, 'c/101.ab12.json', 7.5);
  const out = live.tick(now + 2000);
  assert.deepEqual(out.delta?.voiced, [{ id: 101, v: ['c/101.ab12.json', 7.5] }]);
  assert.equal(out.head.floors[100], 2);
  assert.deepEqual(out.snapshots[0].tables[0].turns[0].v, ['c/101.ab12.json', 7.5]);
});
