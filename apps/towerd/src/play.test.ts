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
test('the floor timeline (FLOOR_TIMELINE) reaches head.play too: a flag the whitelist didn\'t know would never switch on', () => {
  assert.deepEqual(playFlags('stream,cue,quick,crowd,timeline,floor').on, ['stream', 'cue', 'quick', 'crowd', 'timeline', 'floor']);
});
test('fast (head.json every second in a room, behind a CDN) reaches head.play too', () => {
  assert.deepEqual(playFlags('stream,cue,quick,crowd,timeline,floor,fast').on, ['stream', 'cue', 'quick', 'crowd', 'timeline', 'floor', 'fast']);
});
