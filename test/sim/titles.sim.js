// Title smoke test. Usage: node titles.js /path/to/youtube-shadow-queue.user.js
const fs = require('fs');
const assert = require('assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');
const vc = new VirtualConsole();
const errors = [];
vc.on('jsdomError', (e) => errors.push(e.message));

const X = 'ZLOrgc9vNwk', OLD = 'OOOOOOOOOOO';
const dom = new JSDOM(`<!doctype html><html><head></head><body>
  <div class="card">
    <a href="/watch?v=${X}" id="thumb"><img><span>New</span><span>12:34</span></a>
    <h3><a href="/watch?v=${X}">How the real title looks</a></h3>
    <button class="dots">⋮</button>
  </div>
  <div id="movie_player"><video></video></div>
</body></html>`, { url: 'https://www.youtube.com/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
const { window } = dom;
window.localStorage.setItem('shadowQueue.v2', JSON.stringify({ current: null, items: [{ id: OLD, title: 'new' }], played: [] }));

const calls = [];
window.fetch = async (url) => {
  calls.push(url);
  const id = new URL(new URL(url, 'https://www.youtube.com').searchParams.get('url')).searchParams.get('v');
  const titles = { [X]: 'Official title from YouTube', [OLD]: 'Repaired old title' };
  return { ok: true, json: async () => ({ title: titles[id] }) };
};

window.eval(fs.readFileSync(process.argv[2], 'utf8'));
const items = () => JSON.parse(window.localStorage.getItem('shadowQueue.v2')).items;
const wait = () => new Promise((r) => setTimeout(r, 50));

(async () => {
  await wait();
  assert.equal(items()[0].title, 'Repaired old title', 'old "new" entry repaired on load');
  assert.match(calls[0], /^\/oembed\?format=json&url=https%3A%2F%2Fwww\.youtube\.com%2Fwatch%3Fv%3DOOOOOOOOOOO$/);

  window.document.querySelector('#thumb').dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  window.document.body.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, altKey: true, code: 'KeyL' }));
  assert.equal(items()[1].title, 'How the real title looks', 'scraped the title link, not the "New" badge');
  assert.match(window.document.querySelector('.sq-toast').textContent, /How the real title looks/);
  await wait();
  assert.equal(items()[1].title, 'Official title from YouTube', 'official title swapped in');

  // Offline: lookup fails quietly, scraped title stays
  window.fetch = async () => { throw new Error('offline'); };
  window.localStorage.setItem('shadowQueue.v2', JSON.stringify({ current: null, items: [], played: [] }));
  window.document.body.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, altKey: true, code: 'KeyN' }));
  await wait();
  assert.equal(items()[0].title, 'How the real title looks');

  assert.deepEqual(errors, []);
  console.log('Title smoke test: all checks passed');
  window.close();
})().catch((e) => { console.error('FAILED:', e.message, errors); process.exit(1); });
