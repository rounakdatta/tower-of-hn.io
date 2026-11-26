// The room's flags reach the clients: every one the client knows, and nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playFlags } from './play.ts';

test('the crowd and the timeline reach head.play beside the ones already on (the crowd was dropped once: a whitelist that predated it)', () => {
  assert.deepEqual(playFlags('stream,cue,quick,crowd,timeline').on, ['stream', 'cue', 'quick', 'crowd', 'timeline']);
});
test('unset or empty: nothing on, as the room always was', () => {
  assert.deepEqual(playFlags(undefined), { on: [], unknown: [] });
  assert.deepEqual(playFlags(' , ').on, []);
});
test('a typo is left out and named, never passed on; case and spaces don\'t matter; each once', () => {
  assert.deepEqual(playFlags(' Crowd , crowd, timelne ,stream'), { on: ['crowd', 'stream'], unknown: ['timelne'] });
});
