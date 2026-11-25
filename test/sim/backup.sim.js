// Backup & restore: download a backup and a CSV, then import with Merge and Replace.
// Usage: node test/sim/backup.sim.js youtube-shadow-queue.user.js   (or just: npm test)
const fs = require('fs');
const assert = require('assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');

const v = (c, title = `Video ${c}`) => ({ id: c.repeat(11), title });
const vc = new VirtualConsole();
const errors = [];
vc.on('jsdomError', (e) => { if (!/navigation/i.test(e.message)) errors.push(e.message); });
const dom = new JSDOM('<!doctype html><html><head></head><body><ytd-app><div id="movie_player"><video></video></div></ytd-app></body></html>',
  { url: 'https://www.youtube.com/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
const { window } = dom;
const doc = window.document;
window.fetch = async () => { throw new Error('offline'); };
// Real browsers have Blob.text(); jsdom doesn't, so add it for the test.
if (!window.Blob.prototype.text) {
  window.Blob.prototype.text = function () {
    return new Promise((resolve, reject) => {
      const r = new window.FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsText(this);
    });
  };
}

const NOW = Date.now();
window.localStorage.setItem('shadowQueue.v2', JSON.stringify({
  current: v('E'), items: [v('A'), v('B')],
  played: [{ ...v('C'), idle: false, at: NOW - 60000 }, { ...v('D'), idle: true, at: NOW - 30000 }],
}));
window.localStorage.setItem('shadowQueue.saved', JSON.stringify([{ name: 'Mix', items: [v('A'), v('C')], at: 1 }]));

// Capture downloads instead of saving files
const downloads = [];
const blobs = new Map();
window.URL.createObjectURL = (blob) => { const u = `blob:test/${blobs.size}`; blobs.set(u, blob); return u; };
window.URL.revokeObjectURL = () => {};
window.HTMLAnchorElement.prototype.click = function () { if (this.download) downloads.push({ name: this.download, blob: blobs.get(this.href) }); };

window.eval(fs.readFileSync(process.argv[2], 'utf8'));

const q = (s) => doc.querySelector(s);
const qa = (s) => [...doc.querySelectorAll(s)];
const click = (n) => n.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const toast = () => q('.sq-toast').textContent;
const state = () => JSON.parse(window.localStorage.getItem('shadowQueue.v2'));
const ids = (list) => list.map((x) => x.id[0]).join('');
const savedNames = () => JSON.parse(window.localStorage.getItem('shadowQueue.saved')).map((s) => s.name).sort();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function chooseFile(name, text) {
  const input = q('.sq-foot-tools input[type=file]');
  Object.defineProperty(input, 'files', { value: [new window.File([text], name, { type: 'application/json' })], configurable: true });
  input.dispatchEvent(new window.Event('change'));
  await wait(30);
}

(async () => {
  click(q('.sq-fab'));

  // 1. Download a backup
  click(q('[aria-label="Download a backup (.json): queue, history and saved queues"]'));
  assert.equal(downloads.length, 1);
  assert.match(downloads[0].name, /^youtube-queue-backup-\d{4}-\d\d-\d\d\.json$/);
  const backupText = await downloads[0].blob.text();
  const backup = JSON.parse(backupText);
  assert.equal(backup.format, 'youtube-shadow-queue-backup');
  assert.equal(backup.queue.current.id, v('E').id);
  assert.equal(ids(backup.queue.items), 'AB');
  assert.equal(backup.saved[0].name, 'Mix');
  assert.match(toast(), /Backup downloaded: 3 videos up next, 1 saved queues/);

  // 2. Download a CSV list
  click(q('[aria-label="Download a list for spreadsheets (.csv)"]'));
  assert.match(downloads[1].name, /^youtube-queue-\d{4}-\d\d-\d\d\.csv$/);
  const csv = await downloads[1].blob.text();
  const firstBytes = await new Promise((resolve) => {
    const r = new window.FileReader();
    r.onload = () => resolve([...new Uint8Array(r.result).slice(0, 3)]);
    r.readAsArrayBuffer(downloads[1].blob);
  });
  assert.deepEqual(firstBytes, [0xef, 0xbb, 0xbf], 'starts with the UTF-8 marker Excel needs');
  assert.match(csv, /^\ufeff?list,position,title,url,ended,no_activity\r\n/);
  assert.match(csv, /Now playing,0,Video E,https:\/\/www\.youtube\.com\/watch\?v=EEEEEEEEEEE/);
  assert.match(csv, /Saved: Mix,2,Video C,/);

  // 3. Things change after the backup…
  window.localStorage.setItem('shadowQueue.v2', JSON.stringify({ current: null, items: [v('B'), v('F')], played: [] }));
  window.localStorage.setItem('shadowQueue.saved', JSON.stringify([{ name: 'mix', items: [v('F')], at: 2 }]));

  // 4. Import with Merge
  await chooseFile('youtube-queue-backup.json', backupText);
  const box = q('.sq-import');
  assert.equal(box.hidden, false);
  assert.match(box.textContent, /youtube-queue-backup\.json · /);
  assert.match(box.textContent, /3 videos up next · 2 played · 1 saved queue(?!s)/);
  click(qa('.sq-import .sq-big-btn').find((b) => b.textContent === 'Merge'));
  assert.equal(box.hidden, true);
  assert.equal(ids(state().items), 'BFEA', 'yours first, then the backup videos you did not have');
  assert.equal(state().played.length, 2);
  assert.deepEqual(savedNames(), ['Mix (imported)', 'mix'], 'same name, different videos → kept both');
  assert.match(toast(), /Added 2 videos · 1 already queued · 2 to history · 1 saved as "\(imported\)"/);
  assert.equal(q('.sq-badge').textContent, '4', 'panel refreshed');

  // 5. Import with Replace (needs two clicks)
  await chooseFile('youtube-queue-backup.json', backupText);
  const replace = qa('.sq-import .sq-big-btn').find((b) => b.textContent === 'Replace all');
  click(replace);
  assert.equal(replace.textContent, 'Click again to replace');
  assert.equal(ids(state().items), 'BFEA', 'first click changes nothing');
  click(replace);
  assert.equal(state().current.id, v('E').id);
  assert.equal(ids(state().items), 'AB');
  assert.deepEqual(savedNames(), ['Mix']);
  assert.match(toast(), /Restored: 3 videos up next, 2 played, 1 saved queues/);

  // 6. Cancel and Escape leave everything alone
  await chooseFile('b.json', backupText);
  q('.sq-import').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(q('.sq-import').hidden, true);
  await chooseFile('b.json', backupText);
  click(qa('.sq-import .sq-big-btn').find((b) => b.textContent === 'Cancel'));
  assert.equal(q('.sq-import').hidden, true);
  assert.equal(ids(state().items), 'AB');

  // 7. Wrong files get a clear message and change nothing
  await chooseFile('notes.txt', 'hello');
  assert.match(toast(), /isn't a queue backup \(not readable\)/);
  await chooseFile('other.json', JSON.stringify({ some: 'thing' }));
  assert.match(toast(), /isn't a queue backup from this script/);
  await chooseFile('future.json', JSON.stringify({ format: 'youtube-shadow-queue-backup', version: 9 }));
  assert.match(toast(), /newer version of the script/);
  assert.equal(q('.sq-import').hidden, true);
  assert.equal(ids(state().items), 'AB');

  assert.deepEqual(errors, []);
  console.log('Backup & restore test: all checks passed');
  window.close();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
