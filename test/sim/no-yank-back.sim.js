// Does an old play() safety-net reload override a video the user picked afterwards?
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const A = 'AAAAAAAAAAA', Z = 'ZZZZZZZZZZZ', OLD = 'XXXXXXXXXXX';
const dom = new JSDOM(`<!doctype html><html><head></head><body><ytd-app><div id="movie_player"><video></video></div></ytd-app></body></html>`,
  { url: `https://www.youtube.com/watch?v=${OLD}`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
const { window } = dom; const doc = window.document;
window.localStorage.setItem('shadowQueue.v2', JSON.stringify({ current: null, items: [{ id: A, title: 'A' }], played: [], paused: false }));
let playerId = OLD;
const player = doc.getElementById('movie_player');
player.getVideoData = () => ({ video_id: playerId });
// YouTube is slow to react (does nothing with our request)
const hard = [];
window.__hard = (u) => hard.push(u);
window.eval(fs.readFileSync(process.argv[2], 'utf8').replace('location.assign(', '__hard(')
  .replace('const NAV_FALLBACK_MS = 8000;', 'const NAV_FALLBACK_MS = 800;'));
player.querySelector('video').dispatchEvent(new window.Event('ended'));   // queue asks for A
setTimeout(() => {                                                         // user clicks video Z themselves
  window.history.pushState({}, '', `/watch?v=${Z}`); playerId = Z;
}, 200);
setTimeout(() => {
  { const ok = hard.length === 0; console.log(ok ? 'OK: user left alone on Z' : `BUG: user was on Z, then got sent to ${hard[0]}`); if (!ok) process.exitCode = 1; }
  window.close();
}, 1500);
