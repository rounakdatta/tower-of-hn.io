import { test } from 'node:test';
import assert from 'node:assert/strict';
import { versionOf, sweep, liveLines, type Version } from './store.ts';

const H = 3_600_000, now = 100 * 24 * H, grace = 24 * H;
const v = (stem: string, reach: number, bytes = 100, tower = false): Version => ({ stem, files: [`${stem.slice(2)}.0.ogg`], bytes, reach, tower });

test('a version is every file of one voiced comment, and nothing else', () => {
  assert.equal(versionOf('50626967.871ee672.0.ogg'), 'c/50626967.871ee672');
  assert.equal(versionOf('50626967.871ee672.12.ogg'), 'c/50626967.871ee672');
  assert.equal(versionOf('50626967.871ee672.p3.json'), 'c/50626967.871ee672');
  assert.equal(versionOf('50626967.871ee672.json'), 'c/50626967.871ee672');
  for (const other of ['50626967.871ee672.0.ogg.tmp', '50626967.871ee672.json.tmp', 'x.871ee672.json', '50626967.json', '50626967.871ee67.json'])
    assert.equal(versionOf(other), null, other);
});

test('what the tower plays, or played within the grace, stays', () => {
  const r = sweep([v('c/1.aaaaaaaa', now, 100, true), v('c/2.bbbbbbbb', now - grace), v('c/3.cccccccc', now - 2 * H)],
    { now, grace, maxBytes: 1e9, marked: new Set(['c/1.aaaaaaaa', 'c/2.bbbbbbbb', 'c/3.cccccccc']) });
  assert.deepEqual(r.drop, []);
  assert.equal(r.marked.size, 0, 'and loses any mark it had');
  assert.equal(r.bytes, 300);
});

test('unplayable past the grace: marked first, deleted only if still so a pass later', () => {
  const old = v('c/4.dddddddd', now - grace - 1), never = v('c/5.eeeeeeee', 0);
  const first = sweep([old, never], { now, grace, maxBytes: 1e9, marked: new Set() });
  assert.deepEqual(first.drop, []);
  assert.deepEqual([...first.marked].sort(), ['c/4.dddddddd', 'c/5.eeeeeeee']);
  // a pass later, the second one turned out to be on a floor after all (say, rebuilt after a restart)
  const second = sweep([old, { ...never, reach: now, tower: true }], { now: now + 600_000, grace, maxBytes: 1e9, marked: first.marked });
  assert.deepEqual(second.drop.map((x) => x.stem), ['c/4.dddddddd']);
  assert.equal(second.marked.size, 0);
  assert.equal(second.bytes, 100);
});

test('over the cap: the longest unplayable go at once, never what the tower plays', () => {
  const tower = v('c/1.aaaaaaaa', now, 500, true), recent = v('c/2.bbbbbbbb', now - H, 300), older = v('c/3.cccccccc', now - 5 * H, 300);
  const r = sweep([recent, tower, older], { now, grace, maxBytes: 900, marked: new Set() });
  assert.deepEqual(r.drop.map((x) => x.stem), ['c/3.cccccccc']);
  assert.equal(r.bytes, 800);
  assert.equal(r.full, false);
  const tight = sweep([recent, tower, older], { now, grace, maxBytes: 400, marked: new Set() });
  assert.deepEqual(tight.drop.map((x) => x.stem), ['c/3.cccccccc', 'c/2.bbbbbbbb']);
  assert.equal(tight.bytes, 500);
  assert.equal(tight.full, true, 'the tower alone is over it: voice nothing new');
});

test('the voiced log keeps its live lines in order, however they were written, and never a torn one', () => {
  const line = (path: string) => JSON.stringify({ id: 1, path, dur: 1 });
  const spaced = '{"id": 3, "path": "c/3.cccccccc.json", "dur": 1}';     // (an older writer's json.dumps)
  const log = [line('c/1.aaaaaaaa.p1.json'), line('c/1.aaaaaaaa.json'), line('c/2.bbbbbbbb.json'), spaced, '{"id":4,"path":"c/4.dd'];
  const alive = new Set(['c/1.aaaaaaaa.json', 'c/3.cccccccc.json', 'c/4.dddddddd.json']);
  assert.deepEqual(liveLines(log, (p) => alive.has(p)), [line('c/1.aaaaaaaa.json'), spaced]);
  assert.deepEqual(liveLines([], () => true), []);
});
