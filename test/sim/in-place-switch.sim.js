// In-place ("soft") navigation test. Usage: node soft.js /path/to/youtube-shadow-queue.user.js
// Modes for the fake YouTube:
//   'full'     page AND player switch (normal YouTube)
//   'pageOnly' page switches, player stays on the old video (what Crest + PiP did)
//   'ignore'   nothing happens
const fs = require('fs');
const assert = require('assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');

const A = 'AAAAAAAAAAA', B = 'BBBBBBBBBBB', OLD = 'XXXXXXXXXXX';
function page(mode, { hasLoadVideoById = true } = {}) {
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', (e) => errors.push(e.message));
  const dom = new JSDOM(`<!doctype html><html><head></head><body>
    <ytd-app><div id="movie_player"><video></video></div></ytd-app></body></html>`,
    { url: `https://www.youtube.com/watch?v=${OLD}`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  const doc = window.document;
  window.localStorage.setItem('shadowQueue.v2', JSON.stringify({ current: null, items: [{ id: A, title: 'A' }, { id: B, title: 'B' }], played: [], paused: false }));
  const player = doc.getElementById('movie_player');
  const t = { window, doc, player, errors, navEvents: [], hard: [], loads: [], playerId: OLD };
  player.getVideoData = () => ({ video_id: t.playerId });
  if (hasLoadVideoById) player.loadVideoById = (id) => { t.loads.push(id); t.playerId = id; };
  doc.querySelector('ytd-app').addEventListener('yt-navigate', (e) => {
    t.navEvents.push(e.detail);
    if (mode === 'ignore') return;
    doc.dispatchEvent(new window.Event('yt-navigate-start'));
    window.history.pushState({}, '', e.detail.endpoint.commandMetadata.webCommandMetadata.url);
    if (mode === 'full') t.playerId = e.detail.endpoint.watchEndpoint.videoId;
  });
  const src = fs.readFileSync(process.argv[2], 'utf8')
    .replace('location.assign(', '__hard(')
    .replace('const NUDGE_MS = 1500;', 'const NUDGE_MS = 200;')           // speed up the test
    .replace('const NAV_FALLBACK_MS = 8000;', 'const NAV_FALLBACK_MS = 1200;');
  window.__hard = (u) => t.hard.push(u);
  window.eval(src);
  return t;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const end = (t) => t.player.querySelector('video').dispatchEvent(new t.window.Event('ended'));

(async () => {
  // 1. Normal YouTube: page and player switch → no nudge, no reload
  {
    const t = page('full');
    const video = t.player.querySelector('video');
    end(t);
    assert.equal(t.navEvents.length, 1);
    assert.equal(JSON.stringify(t.navEvents[0].endpoint.watchEndpoint), JSON.stringify({ videoId: A }));
    assert.equal(t.navEvents[0].endpoint.commandMetadata.webCommandMetadata.webPageType, 'WEB_PAGE_TYPE_WATCH');
    await wait(1600);
    assert.deepEqual(t.hard, [], 'no reload');
    assert.deepEqual(t.loads, [], 'no nudge needed');
    assert.equal(t.player.querySelector('video'), video, 'same <video> → PiP stays');
    t.window.dispatchEvent(new t.window.Event('pointerdown')); // awake, so no "Still watching?"
    end(t);
    await wait(400);
    assert.equal(t.window.location.href, `https://www.youtube.com/watch?v=${B}`);
    assert.deepEqual(t.errors, []);
    t.window.close();
  }
  // 2. Crest + PiP: page switches, player doesn't → loadVideoById into the same player
  {
    const t = page('pageOnly');
    const video = t.player.querySelector('video');
    end(t);
    await wait(100);
    assert.deepEqual(t.loads, [], 'gives YouTube a moment first');
    await wait(600);
    assert.deepEqual(t.loads, [A], 'player told to load the video');
    await wait(1000);
    assert.deepEqual(t.hard, [], 'no reload: player is on it now');
    assert.equal(t.player.querySelector('video'), video, 'same <video> → PiP stays');
    assert.equal(t.window.location.href, `https://www.youtube.com/watch?v=${A}`);
    assert.deepEqual(t.errors, []);
    t.window.close();
  }
  // 3. Page switches but the player has no loadVideoById → falls back to reload
  {
    const t = page('pageOnly', { hasLoadVideoById: false });
    end(t);
    await wait(1700);
    assert.deepEqual(t.hard, [`/watch?v=${A}`]);
    t.window.close();
  }
  // 4. YouTube ignores the request entirely → falls back to reload (no in-player load)
  {
    const t = page('ignore');
    end(t);
    await wait(300);
    assert.deepEqual(t.hard, [], 'waits before falling back');
    await wait(1400);
    assert.deepEqual(t.hard, [`/watch?v=${A}`], 'fell back to a normal page load');
    assert.deepEqual(t.loads, []);
    t.window.close();
  }
  console.log('Soft navigation test: all checks passed');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
