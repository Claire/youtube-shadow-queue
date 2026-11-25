// Violentmonkey storage, auto-play switch, saved queues.
// Usage: node test/sim/storage-autoplay-saved.sim.js youtube-shadow-queue.user.js   (or just: npm test)
const fs = require('fs');
const assert = require('assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');
const vc = new VirtualConsole();
const errors = [];
vc.on('jsdomError', (e) => { if (!/navigation/i.test(e.message)) errors.push(e.message); });

const A = 'AAAAAAAAAAA', B = 'BBBBBBBBBBB', C = 'CCCCCCCCCCC', D = 'DDDDDDDDDDD';
const dom = new JSDOM(`<!doctype html><html><head></head><body>
  <div id="movie_player"><video></video></div></body></html>`,
  { url: 'https://www.youtube.com/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
const { window } = dom;
const doc = window.document;

// A stray copy in YouTube's localStorage must be IGNORED when Violentmonkey storage exists
window.localStorage.setItem('shadowQueue.v2', JSON.stringify({ current: null, items: [{ id: D, title: 'stray' }], played: [] }));
window.localStorage.setItem('yt-own-key', 'youtube data');

// Fake Violentmonkey storage, already holding the real data
const gm = new Map();
gm.set('shadowQueue.v2', JSON.stringify({ current: null, items: [{ id: A, title: 'Video A' }, { id: B, title: 'Video B' }], played: [] }));
gm.set('shadowQueue.size', JSON.stringify({ w: 500, h: 400 }));
const listeners = [];
window.GM_getValue = (k, d) => (gm.has(k) ? gm.get(k) : d);
window.GM_setValue = (k, v) => gm.set(k, v);
window.GM_deleteValue = (k) => gm.delete(k);
window.GM_addValueChangeListener = (k, fn) => listeners.push([k, fn]);
window.fetch = async () => { throw new Error('offline'); };

const player = doc.getElementById('movie_player');
let playerVideo = 'XXXXXXXXXXX';
player.getVideoData = () => ({ video_id: playerVideo });
const navigations = [];
window.eval(fs.readFileSync(process.argv[2], 'utf8').replace('location.assign(', '__nav(')); // record "play" calls
window.__nav = (u) => navigations.push(u);

const q = (s) => doc.querySelector(s);
const qa = (s) => [...doc.querySelectorAll(s)];
const click = (n, o = {}) => n.dispatchEvent(new window.MouseEvent('click', { bubbles: true, ...o }));
const gmState = () => JSON.parse(gm.get('shadowQueue.v2'));
const ids = () => gmState().items.map((v) => v.id[0]).join('');
const toastText = () => q('.sq-toast').textContent;
const tabSaved = () => qa('.sq-tab')[2];

// --- 1. Uses Violentmonkey storage only
assert.deepEqual(gmState().items.map((v) => v.id), [A, B], 'reads Violentmonkey storage');
assert.equal(q('.sq-badge').textContent, '2', 'stray localStorage copy ignored');
assert.equal(window.localStorage.getItem('yt-own-key'), 'youtube data', "YouTube's own data untouched");
assert.equal(q('.sq-card').style.width, '500px', 'panel size read from Violentmonkey storage');
assert.deepEqual(listeners.map(([k]) => k), ['shadowQueue.v2', 'shadowQueue.saved'], 'syncs other tabs via Violentmonkey');

// --- 2. Auto-play switch
click(q('.sq-fab'));
const sw = q('.sq-switch');
assert.equal(sw.getAttribute('aria-checked'), 'true');
assert.equal(q('.sq-switch-text').textContent, 'On');
click(sw);
assert.equal(gmState().paused, true);
assert.equal(sw.getAttribute('aria-checked'), 'false');
assert.equal(q('.sq-switch-text').textContent, 'Off');
assert.equal(q('.sq-fab').classList.contains('is-off'), true);
assert.equal(q('.sq-fab-off').hidden, false);
assert.match(q('.sq-sub').textContent, /waiting/);
assert.match(toastText(), /Auto-play Off/);
// a video ends while Off → nothing happens
player.querySelector('video').dispatchEvent(new window.Event('ended'));
assert.equal(navigations.length, 0, 'no auto-play while Off');
assert.equal(ids(), 'AB');
assert.equal(gmState().current, null);
// Option+P turns it back On; next end plays the queue
doc.body.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, altKey: true, code: 'KeyP' }));
assert.equal(gmState().paused, false);
assert.equal(q('.sq-fab-off').hidden, true);
player.querySelector('video').dispatchEvent(new window.Event('ended'));
assert.deepEqual(navigations, [`/watch?v=${A}`], 'auto-play On: plays the next one');

// --- 3. Saved tab
click(tabSaved());
assert.equal(q('.sq-savebar').hidden, false);
assert.equal(q('.sq-tools').hidden, true);
assert.equal(q('.sq-clear').hidden, true, 'no Clear all on the Saved tab');
assert.match(q('.sq-empty').textContent, /No saved queues yet/);
click(q('.sq-save-btn'));
assert.match(toastText(), /Type a name first/);
const name = q('.sq-savebar .sq-input');
name.value = 'Cabin videos';
// typing in the box must not reach YouTube's shortcuts
let leaked = 0;
doc.addEventListener('keydown', () => leaked++);
name.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'k', bubbles: true }));
assert.equal(leaked, 0);
name.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
assert.match(toastText(), /Saved "Cabin videos" \(2 videos\)/);
assert.equal(name.value, '');
assert.match(tabSaved().textContent, /Saved · 1/);
assert.equal(qa('.sq-saved').length, 1);
assert.match(q('.sq-saved-name').textContent, /Cabin videos/);
assert.match(q('.sq-saved .sq-meta').textContent, /2 videos · saved/);
// same name again → two-tap overwrite
name.value = 'cabin VIDEOS';
click(q('.sq-save-btn'));
assert.match(toastText(), /already exists/);
assert.match(q('.sq-save-btn').textContent, /Replace it/);
click(q('.sq-save-btn'));
assert.match(toastText(), /Saved "cabin VIDEOS"/);
assert.equal(qa('.sq-saved').length, 1);

// --- 4. Load: + End, + Front, Replace (two-tap because queue isn't empty)
window.GM_setValue('shadowQueue.v2', JSON.stringify({ current: null, items: [{ id: C, title: 'C' }, { id: B, title: 'B' }], played: [], paused: false }));
click(tabSaved());
const loadBtn = (label) => qa('.sq-saved .sq-load-btn').find((b) => b.textContent === label);
click(loadBtn('+ End'));
assert.equal(ids(), 'CBA', 'A added at the end, B already there stays put');
assert.match(toastText(), /Added 1 video .* to the end · 1 already queued/);
assert.equal(qa('.sq-tab')[0].getAttribute('aria-selected'), 'true', 'jumps to Up next after loading');
click(tabSaved());
click(loadBtn('+ Front'));
assert.equal(ids(), 'ABC', 'saved order first');
click(tabSaved());
click(loadBtn('Replace'));
assert.equal(ids(), 'ABC', 'first tap only arms it');
assert.match(toastText(), /replaces your current queue/);
assert.equal(loadBtn('Click again') != null, true);
click(loadBtn('Click again'));
assert.equal(ids(), 'AB');
assert.match(toastText(), /Queue replaced with "cabin VIDEOS" \(2 videos\)/);

// --- 5. Rename (Enter) and Escape
click(tabSaved());
click(q('.sq-saved [aria-label="Rename"]'));
const ren = q('.sq-saved .sq-input');
assert.equal(ren.value, 'cabin VIDEOS');
ren.value = 'Cabin build';
ren.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
assert.match(q('.sq-saved-name').textContent, /Cabin build/);
// a refresh while typing (another tab changes the queue) keeps what you typed and doesn't save it
click(q('.sq-saved [aria-label="Rename"]'));
q('.sq-saved .sq-input').value = 'Half-typ';
q('.sq-saved .sq-input').dispatchEvent(new window.Event('input', { bubbles: true }));
listeners.find(([k]) => k === 'shadowQueue.v2')[1]('shadowQueue.v2', null, null, true); // remote change → redraw
assert.equal(q('.sq-saved .sq-input').value, 'Half-typ', 'draft survives the redraw');
assert.equal(JSON.parse(gm.get('shadowQueue.saved'))[0].name, 'Cabin build', 'nothing saved yet');
q('.sq-saved .sq-input').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
click(q('.sq-saved [aria-label="Rename"]'));
assert.equal(q('.sq-saved .sq-input').value, 'Cabin build', 'reopening starts from the real name');
q('.sq-saved .sq-input').value = 'nope';
q('.sq-saved .sq-input').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
assert.match(q('.sq-saved-name').textContent, /Cabin build/);

// --- 6. Delete (two-tap)
click(q('.sq-saved [aria-label="Delete"]'));
assert.equal(qa('.sq-saved').length, 1, 'first tap only arms it');
click(q('.sq-saved [aria-label="Click again to delete"]'));
assert.equal(qa('.sq-saved').length, 0);
assert.match(toastText(), /Deleted "Cabin build"/);

// --- 7. Another tab changes the queue → this tab redraws
const before = q('.sq-badge').textContent;
gm.set('shadowQueue.v2', JSON.stringify({ current: null, items: [{ id: D, title: 'D' }], played: [], paused: false }));
listeners.find(([k]) => k === 'shadowQueue.v2')[1]('shadowQueue.v2', null, null, true);
assert.notEqual(q('.sq-badge').textContent, before);
assert.equal(q('.sq-badge').textContent, '1');

assert.deepEqual(errors, [], 'no runtime errors');
console.log('Storage / auto-play / saved-queues test: all checks passed');
window.close();
