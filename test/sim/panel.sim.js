// UI smoke test in a fake YouTube page. Usage: node smoke.js /path/to/youtube-shadow-queue.user.js
const fs = require('fs');
const assert = require('assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');

const vc = new VirtualConsole();
const errors = [];
vc.on('jsdomError', (e) => { if (!/navigation/i.test(e.message)) errors.push(e.message); });
vc.on('error', (e) => errors.push(String(e)));

const A = 'AAAAAAAAAAA', B = 'BBBBBBBBBBB', C = 'CCCCCCCCCCC';
const card = (id, t) => `<div class="r"><a href="/watch?v=${id}" id="video-title" title="${t}">${t}</a><button class="dots">⋮</button></div>`;
const D = 'DDDDDDDDDDD';
const hoverBtn = `<div class="ytThumbnailHoverOverlayToggleActionsViewModelButton"><button aria-label="Add to queue"><span class="ic">≡</span></button></div>`;
const dom = new JSDOM(`<!doctype html><html><head></head><body>
  <div class="r2"><a href="/watch?v=${D}" title="Video D"><img></a>${hoverBtn}<div class="ytThumbnailHoverOverlayToggleActionsViewModelButton"><button aria-label="Watch later" id="wl">W</button></div></div>
  ${card(B, 'Video B')}${card(C, 'Video C <img onerror=alert(1)>')}
  <div id="movie_player"><video></video></div>
  <ytd-popup-container><tp-yt-iron-dropdown><ytd-menu-popup-renderer><tp-yt-paper-listbox id="lb"><div>Add to queue</div></tp-yt-paper-listbox></ytd-menu-popup-renderer></tp-yt-iron-dropdown></ytd-popup-container>
</body></html>`, { url: 'https://www.youtube.com/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });

const { window } = dom;
const doc = window.document;
window.localStorage.setItem('shadowQueue.v2', JSON.stringify({ current: null, items: [{ id: A, title: 'Video A' }], played: [] }));

// Fake bits of YouTube that jsdom doesn't have.
const player = doc.getElementById('movie_player');
let playerVideo = A;
player.getVideoData = () => ({ video_id: playerVideo });
let closed = 0;
doc.querySelector('tp-yt-iron-dropdown').close = () => { closed++; };
const lb = doc.getElementById('lb');
lb.getClientRects = () => [{}]; // pretend the menu is visible
let leaked = 0;
lb.addEventListener('click', () => leaked++);
lb.addEventListener('mousedown', () => leaked++);

window.eval(fs.readFileSync(process.argv[2], 'utf8'));
const frames = () => new Promise((r) => setTimeout(r, 100));
const state = () => JSON.parse(window.localStorage.getItem('shadowQueue.v2') || 'null');
const q = (s) => doc.querySelector(s);
const qa = (s) => [...doc.querySelectorAll(s)];
const click = (n, opts = {}) => n.dispatchEvent(new window.MouseEvent('click', { bubbles: true, ...opts }));

(async () => {
  // 1. stored queue shown
  assert.equal(q('.sq-panel').hidden, false);
  assert.equal(q('.sq-badge').textContent, '1');

  // 2. ⋮ menu → Play last; nothing leaks into YouTube's menu
  click(qa('.dots')[0]);
  await frames();
  const items = qa('#lb .sq-item');
  assert.equal(items.length, 2, 'menu items injected');
  items[1].dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  click(items[1]);
  assert.equal(leaked, 0, 'no events leaked to YouTube menu');
  assert.equal(closed, 1, 'menu closed via dropdown.close()');
  assert.equal(qa('.sq-item').length, 0);
  // Play next for C via ⋮
  click(qa('.dots')[1]);
  await frames();
  click(qa('#lb .sq-item')[0]);
  assert.deepEqual(state().items.map((v) => v.id), [C, A, B]);
  assert.match(state().items[0].title, /<img/); // stored as text…
  // Already-queued video: ⋮ shows where it is + Remove, never Play next/last
  click(qa('.dots')[0]);
  await frames();
  const queuedItems = qa('#lb .sq-item').map((n) => n.textContent);
  assert.deepEqual(queuedItems, ['Already in queue · #3', 'Remove from queue']);
  click(qa('#lb .sq-item')[0]); // info line: does nothing
  assert.equal(qa('#lb .sq-item').length, 2);
  click(doc.body); // close menu → stale items cleaned up
  assert.equal(qa('.sq-item').length, 0);
  // Hover badge
  qa('.r a')[0].dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  await frames();
  assert.equal(q('.sq-pill').hidden, false);
  assert.equal(q('.sq-pill').textContent, 'In queue · #3');
  doc.body.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  await frames();
  assert.equal(q('.sq-pill').hidden, true);
  // Option+N on an already-queued video: no duplicate, toast says where it is
  qa('.r a')[0].dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  doc.body.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, altKey: true, code: 'KeyN' }));
  assert.deepEqual(state().items.map((v) => v.id), [C, A, B]);
  assert.match(q('.sq-toast').textContent, /Already in queue at #3/);

  click(q('.sq-fab'));
  assert.equal(q('.sq-title img'), null, '…and rendered as text, not HTML');

  // 3. Panel: 3 rows; select B → move to top
  assert.equal(qa('.sq-row').length, 3);
  click(qa('.sq-row .sq-check')[2]);
  assert.equal(q('.sq-selectall span').textContent, '1 selected');
  click(q('[aria-label="Move selected to top"]'));
  assert.deepEqual(state().items.map((v) => v.id), [B, C, A]);

  // 4. Shift-click range (rows 1..3) then bulk remove all but… check indeterminate first
  qa('.sq-row .sq-check').forEach((cb) => cb.checked && click(cb)); // clear
  click(qa('.sq-row .sq-check')[0]);
  const third = qa('.sq-row .sq-check')[2];
  third.dispatchEvent(new window.MouseEvent('click', { bubbles: true, shiftKey: true }));
  assert.equal(qa('.sq-row.is-selected').length, 3, 'shift-click selects a range');
  assert.equal(q('[aria-label="Select all"]').checked, true);
  click(q('[aria-label="Move selected down"]'));
  assert.deepEqual(state().items.map((v) => v.id), [B, C, A], 'whole list selected: nothing moves');

  // 5. Video ends → first item becomes "now playing" and stays listed until it ends
  doc.querySelector('[aria-label="Select all"]').click(); // untick all
  playerVideo = 'XXXXXXXXXXX';
  player.querySelector('video').dispatchEvent(new window.Event('ended'));
  assert.equal(state().current.id, B);
  assert.equal(q('.sq-now').hidden, false);
  assert.match(q('.sq-now .sq-title').textContent, /Video B/);
  assert.equal(qa('.sq-row').length, 2);
  // B and C play with nobody touching anything (fake clock moves forward)
  const vidEl = player.querySelector('video');
  let fake = Date.now() + 60000;
  window.Date.now = () => fake;
  const watch = (id) => {
    playerVideo = id;
    vidEl.dispatchEvent(new window.Event('playing'));
    fake += 120000;
    vidEl.dispatchEvent(new window.Event('ended'));
  };
  watch(B);
  assert.equal(state().current.id, C);
  assert.equal(q('.sq-prompt').hidden, true, 'one idle video: no prompt yet');
  watch(C);
  assert.equal(q('.sq-prompt').hidden, false, '"Still watching?" after 2 idle videos');
  assert.match(q('.sq-prompt .sq-rewind-btn').textContent, /Back to where I dozed off.*Video B/);
  assert.equal(state().current.id, A, 'next video waits in Now playing');
  assert.deepEqual(state().played.map((v) => [v.id, v.idle]), [[B, true], [C, true]]);
  click(qa('.sq-big-btn')[0]); // Stop for now
  assert.equal(q('.sq-prompt').hidden, true);
  // Panel banner offers the same one-click rewind; dismiss hides it
  assert.equal(q('.sq-doze').hidden, false);
  assert.match(q('.sq-doze-msg').textContent, /2 videos played with no activity/);
  click(q('.sq-doze [aria-label="Dismiss"]'));
  assert.equal(q('.sq-doze').hidden, true);

  // Played tab: newest first, 💤 shown, Play from here rebuilds the line
  const playedTab = qa('.sq-tab')[1];
  assert.match(playedTab.textContent, /Played · 2/);
  click(playedTab);
  const prows = qa('.sq-played');
  assert.equal(prows.length, 2);
  assert.match(prows[0].textContent, /Video C/);
  assert.match(prows[0].querySelector('.sq-meta').textContent, /💤 No activity · Ended/);
  assert.equal(q('.sq-tools').hidden, false, 'Played tab has the toolbar now');
  assert.equal(qa('.sq-played .sq-check').length, 2);
  assert.equal(qa('.sq-played .sq-from-btn').length, 2, 'Play from here kept');
  // tick the bottom one (B) and move it to the top
  click(qa('.sq-played .sq-check')[1]);
  assert.equal(q('.sq-selectall span').textContent, '1 selected');
  click(q('[aria-label="Move selected to top"]'));
  assert.deepEqual(state().played.slice().reverse().map((v) => v.id), [B, C], 'B now at the top');
  // move it back down, then select-all and check the Up next list is untouched
  click(q('[aria-label="Move selected down"]'));
  assert.deepEqual(state().played.slice().reverse().map((v) => v.id), [C, B]);
  assert.equal(state().current.id, A, 'queue untouched by history edits');
  click(qa('.sq-played .sq-check')[1]); // untick
  assert.equal(q('.sq-selectall span').textContent, 'Select all');
  assert.equal(q('.sq-clear').textContent, 'Clear history');
  click(prows[1].querySelector('.sq-from-btn')); // fell asleep during B
  assert.equal(state().current.id, B);
  assert.deepEqual(state().items.map((v) => v.id), [C, A]);
  assert.deepEqual(state().played, []);
  assert.match(q('.sq-tab:nth-child(2)').textContent, /Played · 0/, 'tabs stay visible (Saved tab needs them)');
  assert.equal(qa('.sq-row:not(.sq-played)').length, 2, 'back on Up next');

  // 6. Clear needs two taps
  click(q('.sq-clear'));
  assert.ok(state().current);
  click(q('.sq-clear'));
  assert.equal(state().current, null);
  assert.equal(q('.sq-panel').hidden, true);

  // 7. Option+L on a hovered video
  qa('.r a')[0].dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  doc.body.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, altKey: true, code: 'KeyL' }));
  assert.deepEqual(state().items.map((v) => v.id), [B]);

  // 8. Thumbnail hover "Add to queue" → end of OUR queue; YouTube never sees it
  let ytSaw = 0;
  const nativeBtn = q('.r2 [aria-label="Add to queue"]');
  nativeBtn.addEventListener('click', () => ytSaw++);
  doc.addEventListener('click', (e) => { if (e.target.closest('.r2')) ytSaw++; });
  click(q('.r2 .ic')); // click lands on the icon inside the button
  assert.equal(ytSaw, 0, 'YouTube handlers never ran');
  assert.deepEqual(state().items.map((v) => v.id), [B, D]);
  click(q('.r2 .ic'));
  assert.deepEqual(state().items.map((v) => v.id), [B, D], 'no duplicate');
  click(q('#wl')); // other overlay buttons are left alone
  assert.equal(ytSaw, 1, 'Watch later still reaches YouTube');
  click(nativeBtn, { altKey: true }); // Option-click → YouTube's own queue
  assert.equal(ytSaw, 3, 'Option-click reaches YouTube (button + page)');
  assert.deepEqual(state().items.map((v) => v.id), [B, D]);

  // 9. Resize: keyboard on the corner grip, saved, clamped, and reset
  const card = q('.sq-card');
  const ne = q('.sq-grip-ne');
  assert.equal(qa('.sq-grip').length, 3);
  ne.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(card.style.width, '340px', 'clamped to the minimum width');
  assert.equal(card.style.maxHeight, 'none');
  assert.deepEqual(JSON.parse(window.localStorage.getItem('shadowQueue.size')), { w: 340, h: 320 });
  window.localStorage.setItem('shadowQueue.size', JSON.stringify({ w: 99999, h: 99999 }));
  window.dispatchEvent(new window.Event('resize'));
  assert.equal(card.style.width, `${window.innerWidth - 32}px`, 'never wider than the window');
  ne.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
  assert.equal(card.style.width, '');
  assert.equal(window.localStorage.getItem('shadowQueue.size'), null);

  assert.deepEqual(errors, [], 'no runtime errors');
  console.log('UI smoke test: all checks passed');
  window.close();
})().catch((e) => { console.error('FAILED:', e.message, errors); process.exit(1); });
