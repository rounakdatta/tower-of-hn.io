const id = location.hash.slice(1);
chrome.runtime.sendMessage({ kind: 'confirm-get', id }, (p) => {
  if (!p) { document.body.textContent = 'This request has gone.'; return; }
  document.getElementById('text').textContent = p.text;
  document.getElementById('where').textContent = `A reply to comment ${p.parent} (news.ycombinator.com/item?id=${p.story})`;
});
const decide = (yes) => chrome.runtime.sendMessage({ kind: 'confirm', id, yes }, () => window.close());
document.getElementById('yes').onclick = () => decide(true);
document.getElementById('no').onclick = () => decide(false);
