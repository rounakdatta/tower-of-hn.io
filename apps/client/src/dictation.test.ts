// node --test apps/client/src/dictation.test.ts — what the microphone hears, into the reply box, words unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heard, join, glue, type Result } from './dictation.ts';

const R = (...xs: [string, boolean?][]): Result[] => xs.map(([t, fin]) => ({ isFinal: !!fin, 0: { transcript: t } }));

test('desktop Chrome: results are stretches, joined as said', () => {
  assert.equal(heard(R(['I think', true], [' the rust borrow checker', true], [' is', false]), false), 'I think the rust borrow checker is');
  assert.equal(heard(R(['very', true], [' very good', true]), false), 'very very good');    // a real repeat stays
});

test('Android Chrome: each result repeats the earlier ones; said once, not three times', () => {
  assert.equal(heard(R(['hello', true], ['hello world', true], ['hello world how are you', true]), true), 'hello world how are you');
  assert.equal(heard(R(['hello world', true], ['hello world how', false]), true), 'hello world how');
  assert.equal(heard(R(['first part', true], ['second part', true]), true), 'first part second part');   // not cumulative: kept
});

test('no spaces invented between Chinese or Japanese stretches', () => {
  assert.equal(heard(R(['今日は', true], ['いい天気', true]), false), '今日はいい天気');
});

test('joining: a capital only where a sentence starts, and one space between', () => {
  assert.equal(join('', 'hello world'), 'Hello world');
  assert.equal(join('I think', 'that is wrong'), 'I think that is wrong');            // not "I think That"
  assert.equal(join('Fine.', 'next point'), 'Fine. Next point');
  assert.equal(join('Fine. ', 'next point'), 'Fine. Next point');
  assert.equal(join('A list:\n', 'first'), 'A list:\nFirst');
  assert.equal(join('', 'iPhone sales'), 'iPhone sales');                              // not "IPhone"
  assert.equal(join('Well', ', maybe'), 'Well, maybe');
  assert.equal(join('kept as is', '   '), 'kept as is');
});

test('glue', () => {
  assert.equal(glue('end.', 'Next'), 'end. Next');
  assert.equal(glue('a', 'b'), 'a b');
  assert.equal(glue('a ', 'b'), 'a b');
  assert.equal(glue('数', '字'), '数字');
});
