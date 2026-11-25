// Export a saved queue to a YouTube playlist, against a fake YouTube API.
// Usage: node test/sim/export.sim.js youtube-shadow-queue.user.js   (or just: npm test)
const fs = require('fs');
const assert = require('assert/strict');
const { webcrypto } = require('node:crypto');
const { TextEncoder } = require('node:util');
const { JSDOM, VirtualConsole } = require('jsdom');

const PL = 'PLfakeplaylist0123456789';
const v = (c, title) => ({ id: c.repeat(11), title });
const MIX = [v('A', 'Video A'), v('B', 'Video B (deleted)'), v('C', 'Video C')];
const LONG = [v('D', 'D'), v('E', 'E'), v('F', 'F'), v('G', 'G')];

const vc = new VirtualConsole();
const errors = [];
vc.on('jsdomError', (e) => { if (!/navigation/i.test(e.message)) errors.push(e.message); });
const dom = new JSDOM('<!doctype html><html><head></head><body><ytd-app><div id="movie_player"><video></video></div></ytd-app></body></html>',
  { url: 'https://www.youtube.com/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
const { window } = dom;
const doc = window.document;

// What a browser has that jsdom lacks
Object.defineProperty(window, 'crypto', { value: webcrypto });
window.TextEncoder = TextEncoder;

// YouTube page settings + a signed-in session
window.ytcfg = { get: (k) => ({
  INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '2.20261120.01.00', visitorData: 'VIS' } },
  INNERTUBE_CLIENT_VERSION: '2.20261120.01.00', INNERTUBE_CONTEXT_CLIENT_NAME: 1, SESSION_INDEX: 0,
  DATASYNC_ID: '12345||',
}[k]) };
doc.cookie = 'SAPISID=abc123';

window.localStorage.setItem('shadowQueue.v2', JSON.stringify({ current: null, items: [], played: [] }));
window.localStorage.setItem('shadowQueue.saved', JSON.stringify([
  { name: 'Mix', items: MIX, at: 2 }, { name: 'Long', items: LONG, at: 1 },
]));

// Fake YouTube API. Rejects the newer login-hash form (to check the fallback), fails video B.
const requests = [];
let holdEdits = null; // when set, edit requests wait for this promise (lets us press Pause mid-run)
window.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  requests.push({ url, headers: opts.headers, body });
  const reply = (status, json) => ({ status, json: async () => json });
  if (/_u( |$)/.test(opts.headers.Authorization)) return reply(401, { error: { message: 'Unauthenticated' } });
  if (url.startsWith('/youtubei/v1/playlist/create')) return reply(200, { status: 'STATUS_SUCCEEDED', playlistId: PL });
  if (url.startsWith('/youtubei/v1/browse/edit_playlist')) {
    if (holdEdits) await holdEdits;
    const vid = body.actions[0].addedVideoId;
    return reply(200, { status: vid === 'BBBBBBBBBBB' ? 'STATUS_FAILED' : 'STATUS_SUCCEEDED' });
  }
  return reply(404, {});
};

window.eval(fs.readFileSync(process.argv[2], 'utf8').replace('const EXPORT_DELAY_MS = 1500;', 'const EXPORT_DELAY_MS = 5;'));

const q = (s) => doc.querySelector(s);
const qa = (s) => [...doc.querySelectorAll(s)];
const click = (n) => n.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const row = (name) => qa('.sq-saved').find((r) => r.querySelector('.sq-saved-name')?.textContent === name);
const saved = () => JSON.parse(window.localStorage.getItem('shadowQueue.saved'));
const exp = (name) => saved().find((s) => s.name === name).exp;
const btn = (r, label) => [...r.querySelectorAll('button, a')].find((b) => b.textContent.trim() === label);

(async () => {
  click(q('.sq-fab'));
  click(qa('.sq-tab')[2]);

  // 1. The form: title defaults to the queue name, privacy defaults to Private
  click(row('Mix').querySelector('[aria-label="Export to a YouTube playlist"]'));
  const form = row('Mix').querySelector('.sq-export');
  assert.match(form.textContent, /Export to a YouTube playlist/);
  assert.match(form.textContent, /Adds 3 videos .* one at a time/);
  const title = form.querySelector('input');
  assert.equal(title.value, 'Mix');
  assert.equal(form.querySelector('select').value, 'PRIVATE');
  // keys typed in the title must not reach YouTube's shortcuts
  let leaked = 0;
  doc.addEventListener('keydown', () => leaked++);
  title.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'k', bubbles: true }));
  assert.equal(leaked, 0);
  title.value = 'My Mix';
  title.dispatchEvent(new window.Event('input', { bubbles: true }));

  // 2. Run it
  click(btn(row('Mix'), 'Create playlist'));
  for (let i = 0; i < 100 && exp('Mix')?.status !== 'done'; i++) await wait(20);
  const done = row('Mix').querySelector('.sq-export');
  assert.match(done.textContent, /✓ Exported 2 of 3 to "My Mix" \(Private\) · 1 unavailable skipped/);
  assert.equal(done.querySelector('a.sq-open').href, `https://www.youtube.com/playlist?list=${PL}`);
  assert.equal(done.querySelector('a.sq-open').target, '_blank');
  assert.match(q('.sq-toast').textContent, /Playlist ready: "My Mix" \(2 videos\) · 1 unavailable skipped/);

  // 3. The requests look like youtube.com's own, and go only to youtube.com
  assert.ok(requests.every((r) => r.url.startsWith('/youtubei/v1/')), 'same-site only');
  const create = requests.filter((r) => r.url.startsWith('/youtubei/v1/playlist/create'));
  assert.equal(create.length, 2, 'newer login form refused → retried with the older one');
  assert.match(create[0].headers.Authorization, /^SAPISIDHASH \d+_[0-9a-f]{40}_u$/);
  assert.match(create[1].headers.Authorization, /^SAPISIDHASH \d+_[0-9a-f]{40}$/);
  assert.equal(create[1].headers['X-Origin'], 'https://www.youtube.com');
  assert.equal(create[1].headers['X-Youtube-Client-Version'], '2.20261120.01.00');
  assert.equal(create[1].body.context.client.clientName, 'WEB');
  assert.deepEqual([create[1].body.title, create[1].body.privacyStatus], ['My Mix', 'PRIVATE']);
  assert.ok(!JSON.stringify(requests).includes('abc123'), 'the login cookie itself is never sent');
  const edits = requests.filter((r) => r.url.startsWith('/youtubei/v1/browse/edit_playlist'));
  assert.deepEqual(edits.map((r) => r.body.actions[0].addedVideoId), MIX.map((x) => x.id));
  assert.ok(edits.every((r) => !/_u$/.test(r.headers.Authorization)), 'remembers which login form works');

  // 4. Pause mid-run, then Resume continues the same playlist
  requests.length = 0;
  let release;
  holdEdits = new Promise((r) => { release = r; });
  click(row('Long').querySelector('[aria-label="Export to a YouTube playlist"]'));
  click(btn(row('Long'), 'Create playlist'));
  await wait(50);
  assert.match(row('Long').querySelector('.sq-export').textContent, /Adding 1 of 4/);
  // while it runs: rename, delete and a second export are refused
  click(row('Long').querySelector('[aria-label="Rename"]'));
  assert.match(q('.sq-toast').textContent, /Pause the export before renaming/);
  click(row('Long').querySelector('[aria-label="Delete"]'));
  assert.match(q('.sq-toast').textContent, /Pause the export before deleting/);
  click(row('Mix').querySelector('[aria-label="Export to a YouTube playlist"]'));
  assert.match(q('.sq-toast').textContent, /One export at a time/);
  click(btn(row('Long'), 'Pause'));
  release(); holdEdits = null;
  for (let i = 0; i < 100 && exp('Long')?.status !== 'paused'; i++) await wait(20);
  assert.equal(exp('Long').next, 1, 'paused right after the video in progress');
  assert.match(row('Long').querySelector('.sq-export').textContent, /Paused at 1 of 4/);
  click(btn(row('Long'), 'Resume'));
  for (let i = 0; i < 100 && exp('Long')?.status !== 'done'; i++) await wait(20);
  assert.equal(requests.filter((r) => r.url.startsWith('/youtubei/v1/playlist/create')).length, 1, 'only one playlist made');
  assert.deepEqual(requests.filter((r) => r.url.includes('edit_playlist')).map((r) => r.body.actions[0].addedVideoId), LONG.map((x) => x.id));
  assert.equal(exp('Long').added, 4);

  // 5. Hide the result: progress cleared, playlist untouched
  click(row('Long').querySelector('[aria-label="Hide (the playlist stays on YouTube)"]'));
  assert.equal(exp('Long'), null);
  assert.equal(row('Long').querySelector('.sq-export'), null);

  // 6. A reload mid-export shows as Paused with Resume
  window.localStorage.setItem('shadowQueue.saved', JSON.stringify([
    { name: 'Mix', items: MIX, at: 2, exp: { playlistId: PL, next: 1, added: 1, skipped: [], status: 'running', title: 'My Mix', privacy: 'UNLISTED' } },
  ]));
  click(qa('.sq-tab')[2]);
  assert.match(row('Mix').querySelector('.sq-export').textContent, /Paused at 1 of 3/);
  assert.ok(btn(row('Mix'), 'Resume'));

  // 7. The form always makes a NEW playlist, even with a paused one around
  requests.length = 0;
  click(row('Mix').querySelector('[aria-label="Export to a YouTube playlist"]'));
  click(btn(row('Mix'), 'Create playlist'));
  for (let i = 0; i < 100 && exp('Mix')?.status !== 'done'; i++) await wait(20);
  assert.equal(requests.filter((r) => r.url.startsWith('/youtubei/v1/playlist/create')).length, 1, 'new playlist created');
  assert.equal(exp('Mix').privacy, 'PRIVATE');

  // 8. Signed out → clear message, nothing sent
  requests.length = 0;
  doc.cookie = 'SAPISID=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  click(row('Mix').querySelector('[aria-label="Export to a YouTube playlist"]'));
  click(btn(row('Mix'), 'Create playlist'));
  assert.match(q('.sq-toast').textContent, /Sign in to YouTube first/);
  assert.equal(requests.length, 0);

  assert.deepEqual(errors, []);
  console.log('Export test: all checks passed');
  window.close();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
