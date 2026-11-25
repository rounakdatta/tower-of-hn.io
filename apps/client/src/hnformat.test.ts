// node --test apps/client/src/hnformat.test.ts — HN's formatting, as the preview shows it, and recognising your reply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hnHtml, hnPlain, asPosted, skeleton, yours } from './hnformat.ts';

test('blank lines separate paragraphs; single newlines stay inside one', () => {
  assert.equal(hnHtml('one\ntwo\n\nthree'), '<p>one\ntwo</p><p>three</p>');
  assert.equal(hnHtml('\n\n  \n'), '');
});

test('asterisks: italics, and the two ways to a literal asterisk', () => {
  assert.equal(hnHtml('*really* not'), '<p><i>really</i> not</p>');
  assert.equal(hnHtml('2*3*4'), '<p>2<i>3</i>4</p>');                 // HN does this too (formatdoc's reason for \*)
  assert.equal(hnHtml('a \\* b and c ** d'), '<p>a * b and c * d</p>');
  assert.equal(hnHtml('a lone * star'), '<p>a lone * star</p>');
});

test('after a blank line, two-space indented lines are code, kept verbatim and escaped', () => {
  assert.equal(hnHtml('Try:\n\n  for x in y:\n    f(x) < 3\n\nDone'), '<p>Try:</p><pre><code>  for x in y:\n    f(x) &lt; 3</code></pre><p>Done</p>');
  assert.equal(hnHtml('  starts as code'), '<pre><code>  starts as code</code></pre>');
  assert.equal(hnHtml('text\n  not code (no blank line before)'), '<p>text\n  not code (no blank line before)</p>');
});

test('urls become links, without trailing punctuation, shortened past 60 characters', () => {
  assert.equal(hnHtml('see https://example.com/a.'), '<p>see <a href="https://example.com/a" rel="nofollow noopener noreferrer" target="_blank">https://example.com/a</a>.</p>');
  assert.match(hnHtml('(https://en.wikipedia.org/wiki/Foo_(bar))'), /href="https:\/\/en\.wikipedia\.org\/wiki\/Foo_\(bar\)"/);
  const long = 'https://example.com/' + 'x'.repeat(80);
  assert.match(hnHtml(long), />https:\/\/example\.com\/x{40}\.\.\.<\/a>/);
  assert.match(hnHtml('<https://example.com/a_b>'), /^<p>&lt;<a href="https:\/\/example\.com\/a_b"/);
});

test('nothing typed becomes markup: tags, quotes in urls, and javascript: links stay text', () => {
  assert.equal(hnHtml('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.equal(hnHtml('javascript:alert(1)'), '<p>javascript:alert(1)</p>');
  assert.doesNotMatch(hnHtml('https://x.y/"onmouseover="alert(1)'), /href="[^"]*"onmouseover/);
  assert.doesNotMatch(hnHtml('<img src=x onerror=alert(1)>'), /<img/);
});

test('HN API html as plain text: paragraphs, entities, links', () => {
  assert.equal(hnPlain('First.<p>Second &amp; <a href="https://x.y/z" rel="nofollow">https://x.y/z</a> &#x27;ok&#x27; &gt;'), "First.\n\nSecond & https://x.y/z 'ok' >");
  assert.equal(hnPlain('<pre><code>  a &lt; b\n</code></pre>'), 'a < b');                // (trimmed: it's for reading and matching)
});

test('your words match what HN gives back for them (formatting and shortened links aside)', () => {
  const said = 'I think *this* is wrong.\n\nSee https://example.com/' + 'y'.repeat(70) + ' for the numbers.';
  const api = 'I think <i>this</i> is wrong.<p>See <a href="https://example.com/yyyy" rel="nofollow">https://example.com/yyyyyyyyyy...</a> for the numbers.';
  assert.equal(asPosted(said), skeleton(hnPlain(api)));
});

test('yours: by name, by your exact words, by your words with a typo fixed on HN; never by someone else\'s', () => {
  const text = 'The borrow checker is the reason this compiles at all, not LLVM.';
  assert.equal(yours({ by: 'alice', text: 'anything' }, text, 'alice'), 'name');
  assert.equal(yours({ by: 'bob', text: 'The borrow checker is the reason this compiles at all, not LLVM.' }, text, ''), 'exact');
  assert.equal(yours({ by: 'bob', text: 'The borrow checker is the reason this compiles at all, not LLVM itself.' }, text, ''), 'words');
  assert.equal(yours({ by: 'carol', text: 'I disagree: LLVM is why it compiles, the checker only rejects.' }, text, ''), '');
  assert.equal(yours({ by: 'bob', text: '[delayed]' }, text, ''), '');
  assert.equal(yours({ by: 'bob', text: 'Thanks!' }, 'thanks', ''), 'exact');
  assert.equal(yours({ by: 'bob', text: 'Thanks a lot!' }, 'thanks', ''), '');      // too short to match loosely
});
