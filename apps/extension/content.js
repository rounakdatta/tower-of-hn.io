// The page and the extension talk through this script, on Tower of HN's own pages only (see manifest matches).
// The page can ask; only the extension's own confirmation window can make a post happen (background.js).
window.addEventListener('message', (e) => {
  if (e.source !== window || e.origin !== location.origin || !e.data || typeof e.data !== 'object') return;
  if (e.data.tohn === 'hello') {
    chrome.runtime.sendMessage({ kind: 'whoami' }, (r) => window.postMessage({ tohn: 'here', user: r?.user ?? '' }, location.origin));
  } else if (e.data.tohn === 'post') {
    const { parent, story, text } = e.data;
    if (!Number.isInteger(parent) || !Number.isInteger(story) || typeof text !== 'string' || !text.trim()) return;
    const answer = (ok, error) => window.postMessage({ tohn: 'posted', parent, ok, error }, location.origin);
    if (text.length > 8000) return answer(false, 'Too long for the extension (8,000 characters): post it on Hacker News’s own page');
    chrome.runtime.sendMessage({ kind: 'post', parent, story, text, from: location.origin }, (r) =>
      answer(!!r?.ok, r ? r.error ?? '' : 'The extension didn’t answer: try again, or post it on Hacker News’s own page'));
  }
});
