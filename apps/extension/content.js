// The page and the extension talk through this script, on TowerOfHan's own pages only (see manifest matches).
// The page can ask; only the extension's own confirmation window can make a post happen (background.js).
window.addEventListener('message', (e) => {
  if (e.source !== window || e.origin !== location.origin || !e.data || typeof e.data !== 'object') return;
  if (e.data.tohn === 'hello') {
    chrome.runtime.sendMessage({ kind: 'whoami' }, (r) => window.postMessage({ tohn: 'here', user: r?.user ?? '' }, location.origin));
  } else if (e.data.tohn === 'post') {
    const { parent, story, text } = e.data;
    if (!Number.isInteger(parent) || !Number.isInteger(story) || typeof text !== 'string' || !text.trim() || text.length > 8000) return;
    chrome.runtime.sendMessage({ kind: 'post', parent, story, text, from: location.origin }, (r) =>
      window.postMessage({ tohn: 'posted', parent, ok: !!r?.ok, error: r?.error ?? '' }, location.origin));
  }
});
