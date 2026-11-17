// Two queue actions in a row while YouTube is slow: only the LATEST may fall back to a reload.
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const A = 'AAAAAAAAAAA', B = 'BBBBBBBBBBB';
const dom = new JSDOM(`<!doctype html><html><head></head><body><ytd-app><div id="movie_player"><video></video></div></ytd-app></body></html>`,
  { url: 'https://www.youtube.com/watch?v=XXXXXXXXXXX', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
const { window } = dom; const doc = window.document;
window.localStorage.setItem('shadowQueue.v2', JSON.stringify({ current: null, items: [{ id: A, title: 'A' }, { id: B, title: 'B' }], played: [], paused: false }));
doc.getElementById('movie_player').getVideoData = () => ({ video_id: 'XXXXXXXXXXX' }); // YouTube never reacts
const hard = []; window.__hard = (u) => hard.push(u);
window.eval(fs.readFileSync(process.argv[2], 'utf8').replace('location.assign(', '__hard(').replace('const NAV_FALLBACK_MS = 8000;', 'const NAV_FALLBACK_MS = 800;'));
doc.querySelector('.sq-fab').click();
const playBtn = (i) => [...doc.querySelectorAll('.sq-row [aria-label="Play now"]')][i];
playBtn(0).click();                                  // Play now: A
setTimeout(() => playBtn(0).click(), 300);           // then Play now: B (now first in list)
setTimeout(() => {
  { const ok = JSON.stringify(hard) === JSON.stringify([`/watch?v=${B}`]); console.log(ok ? 'OK: only the latest (B) fell back' : `BUG: ${JSON.stringify(hard)}`); if (!ok) process.exitCode = 1; }
  window.close();
}, 1800);
