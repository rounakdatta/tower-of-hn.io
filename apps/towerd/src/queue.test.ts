import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceQueue, band } from './queue.ts';

type J = { rev: string; id: number };
const clockAt = (t = { now: 1_000_000 }) => ({ t, now: () => t.now });
const make = (id: number) => ({ id, rev: 'r1' });

test('bands follow towerd\'s priorities', () => {
  assert.deepEqual([0, 99, 100, 199, 200, 999, 1000, 5000].map(band), [0, 0, 1, 1, 2, 2, 3, 3]);
});

test('claims take the most urgent job first, and a held job is never handed out twice', async () => {
  const c = clockAt(), q = new VoiceQueue<J>(c.now);
  q.plan([[1, 3000, 0], [2, 5, 0], [3, 150, 0]], make);
  const a = await q.claim('a').promise, b = await q.claim('b').promise, d = await q.claim('d').promise;
  assert.deepEqual([a?.id, b?.id, d?.id], [2, 3, 1]);
  const none = q.claim('e', 0, 10);
  assert.equal(await none.promise, null);
});

test('a waiting runner gets new work the moment it is planned', async () => {
  const c = clockAt(), q = new VoiceQueue<J>(c.now);
  const w = q.claim('a', 0, 5_000);
  q.plan([[7, 10, 0]], make);
  assert.equal((await w.promise)?.id, 7);
});

test('a lease that stops beating lapses, and its job goes to someone else', async () => {
  const c = clockAt(), q = new VoiceQueue<J>(c.now, 20_000);
  q.plan([[1, 10, 0]], make);
  const a = (await q.claim('a').promise)!, tok = a.lease!.token;
  c.t.now += 15_000;
  assert.ok(q.beat(tok));
  c.t.now += 15_000; q.sweep();
  assert.ok(q.get(tok), 'a beat 15 s ago keeps it');
  c.t.now += 21_000; q.sweep();
  assert.equal(q.get(tok), undefined);
  assert.equal(q.beat(tok), null, 'the old holder is told it lost it');
  assert.equal((await q.claim('b').promise)?.id, 1);
});

test('a patient runner (the fallback) waits while others are around, and takes everything when they are gone', async () => {
  const c = clockAt(), q = new VoiceQueue<J>(c.now);
  q.claim('fast', 0, 1).cancel();                    // a fast runner has been seen
  q.plan([[1, 10, 0]], make);
  const slow = q.claim('slow', 15, 60_000);
  c.t.now += 10_000; q.sweep();
  let got: unknown = 'pending';
  slow.promise.then((e) => { got = e?.id; });
  await new Promise((r) => setImmediate(r));
  assert.equal(got, 'pending', 'not before 15 s');
  c.t.now += 6_000; q.sweep();
  await new Promise((r) => setImmediate(r));
  assert.equal(got, 1, 'after 15 s it helps');
  // nobody else for a minute: no waiting at all
  q.plan([[1, 10, 0], [2, 10, 0]], make);
  c.t.now += 61_000;
  assert.equal((await q.claim('slow', 15).promise)?.id, 2);
});

test('someone waiting on something urgent makes the least urgent job yield, one per urgent job', async () => {
  const c = clockAt(), q = new VoiceQueue<J>(c.now);
  q.plan([[1, 3000, 0], [2, 5000, 0], [3, 250, 0]], make);
  const l1 = (await q.claim('a').promise)!, l2 = (await q.claim('b').promise)!, l3 = (await q.claim('c').promise)!;
  assert.deepEqual([l1.id, l2.id, l3.id], [3, 1, 2]);
  assert.equal(q.beat(l3.lease!.token)!.yield, false, 'nothing more urgent is waiting');
  q.plan([[1, 3000, 0], [2, 5000, 0], [3, 250, 0], [9, 4, 0]], make);   // someone sits down
  assert.equal(q.beat(l3.lease!.token)!.yield, true, 'the least urgent gives way');
  assert.equal(q.beat(l2.lease!.token)!.yield, false, 'only one per urgent job');
  assert.equal(q.beat(l1.lease!.token)!.yield, false, 'a floor in focus outranks background work, never the seat');
  q.release(l3.lease!.token);
  assert.equal((await q.claim('c').promise)?.id, 9);
  assert.equal(q.beat(l2.lease!.token)!.yield, false, 'once it is taken, nobody else yields');
});

test('an urgent job does not make anyone yield while an idle runner can take it', async () => {
  const c = clockAt(), q = new VoiceQueue<J>(c.now);
  q.plan([[1, 3000, 0]], make);
  const l1 = (await q.claim('a').promise)!;
  const idle = q.claim('b', 0, 5_000);
  q.plan([[1, 3000, 0], [2, 3, 0]], make);
  assert.equal((await idle.promise)?.id, 2);
  assert.equal(q.beat(l1.lease!.token)!.yield, false);
});

test('a held job keeps its runner when its urgency or depth changes, but not when its text does', async () => {
  const c = clockAt(), q = new VoiceQueue<J>(c.now);
  q.plan([[1, 3000, 2]], make);
  const l = (await q.claim('a').promise)!;
  q.plan([[1, 7, 0]], make);                         // someone sat down: all of it, now
  assert.deepEqual(q.beat(l.lease!.token), { yield: false, prio: 7, upto: 0 });
  q.plan([], make);                                  // nobody wants it any more: it is finished anyway
  assert.ok(q.get(l.lease!.token));
  const tok = l.lease!.token;
  q.plan([[1, 7, 0]], (id) => ({ id, rev: 'edited' }), () => 'edited');
  assert.equal(q.get(tok), undefined, 'the old text is dropped');
  assert.equal((await q.claim('b').promise)?.job.rev, 'edited');
});

test('finished jobs leave the queue; revoked ones refuse their runner', async () => {
  const c = clockAt(), q = new VoiceQueue<J>(c.now);
  q.plan([[1, 10, 0], [2, 11, 0]], make);
  const a = (await q.claim('a').promise)!, b = (await q.claim('b').promise)!, tb = b.lease!.token;
  assert.ok(q.finish(a.lease!.token));
  assert.equal(q.entries.has(1), false);
  q.revoke(2);
  assert.equal(q.beat(tb), null);
  assert.equal(q.finish(tb), false);
  assert.deepEqual(q.stats(), { queued: 0, held: 0, waiting: 0 });
});

test('the fallback is never the one asked to make room: a fast runner yields instead', async () => {
  const c = clockAt(), q = new VoiceQueue<J>(c.now);
  q.plan([[1, 5000, 0], [2, 5001, 0]], make);
  const fast = (await q.claim('fast').promise)!;
  c.t.now += 16_000;
  const slow = (await q.claim('slow', 15).promise)!;   // the fallback took an old background job
  assert.deepEqual([fast.id, slow.id], [1, 2]);
  q.plan([[1, 5000, 0], [2, 5001, 0], [9, 3, 0]], make);  // someone sits down; nobody is idle
  assert.equal(q.beat(slow.lease!.token)!.yield, false, 'the fallback could not take it anyway');
  assert.equal(q.beat(fast.lease!.token)!.yield, true, 'the fast runner gives way');
});

test('a seat its listener left becomes background work: it no longer outranks anyone', async () => {
  const c = clockAt(), q = new VoiceQueue<J>(c.now);
  q.plan([[1, 4, 0]], make);
  const l = (await q.claim('a').promise)!;
  q.plan([], make);
  assert.equal(q.beat(l.lease!.token)!.prio, 1000);
  q.plan([[2, 250, 0]], make);
  assert.equal(q.beat(l.lease!.token)!.yield, true, 'a floor in focus now goes first');
});
