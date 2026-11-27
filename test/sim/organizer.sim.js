// Organizer page (tools/organizer.html): open enriched.json, filter, make new queues,
// download them, and check the userscript accepts the download as "saved queues only".
// Usage: node test/sim/organizer.sim.js   (or just: npm test)
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');
const { createStore } = require('../../youtube-shadow-queue.user.js');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'organizer.html'), 'utf8');
const id = (c) => c.repeat(11);
const NOW = Date.parse('2026-11-25T12:00:00Z'); // the page's clock is pinned to this, so dates never drift
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();
const video = (c, extra) => ({
  id: id(c), title: `Video ${c}`, channel: 'Chan 1', category: 'Education', topics: ['Health'],
  tags: ['Doctor'], seconds: 600, lists: ['Up next'], description: '', ...extra,
});
const enriched = {
  format: 'youtube-shadow-queue-enriched', version: 1, createdAt: '2026-11-25T12:00:00.000Z', source: 'b.json', backup: {},
  videos: {
    [id('A')]: video('A', { title: 'Knee pain explained', tags: ['Doctor', 'knee'], publishedAt: daysAgo(2) }),
    [id('B')]: video('B', { seconds: 200 }),
    [id('C')]: video('C', { channel: 'Chan 2', category: 'People & Blogs', topics: ['Society'], tags: [], seconds: 4000, publishedAt: daysAgo(400) }),
    [id('D')]: video('D', { channel: 'Chan 2', category: 'People & Blogs', topics: ['Society'], description: 'a secret word', publishedAt: daysAgo(5 * 366) }),
    [id('E')]: video('E', { title: '<img src=x onerror=alert(1)>', channel: 'Chan 3', category: 'Comedy', topics: [], lists: ['Played'] }),
    [id('F')]: { id: id('F'), title: 'Gone video', lists: ['Up next'], unavailable: true },
    [id('G')]: video('G', { category: 'Music', lists: ['Saved: Mix'], publishedAt: '2025-10-26T12:00:00Z' }), // a day short of 13 months
    [id('H')]: video('H', { category: 'Music', lists: ['Up next', 'Saved: Mix'] }),
    bad: { id: 'javascript:alert(1)', title: 'not a real id' },
  },
};

const errors = [];
const downloads = [];
function open(storage = {}) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/navigation|Could not load img/i.test(e.message)) errors.push(e.message); });
  const dom = new JSDOM(html, {
    url: 'http://localhost/organizer.html', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
      window.Date.now = () => NOW;
      if (!window.Blob.prototype.text) {
        window.Blob.prototype.text = function () {
          return new Promise((resolve) => { const r = new window.FileReader(); r.onload = () => resolve(r.result); r.readAsText(this); });
        };
      }
      const blobs = new Map();
      window.URL.createObjectURL = (b) => { const u = `blob:t/${blobs.size}`; blobs.set(u, b); return u; };
      window.URL.revokeObjectURL = () => {};
      window.HTMLAnchorElement.prototype.click = function () { if (this.download) downloads.push({ name: this.download, blob: blobs.get(this.href) }); };
    },
  });
  return dom.window;
}

(async () => {
  let window = open();
  let doc = window.document;
  const $ = (s) => doc.querySelector(s);
  const $$ = (s) => [...doc.querySelectorAll(s)];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const msg = () => $('#msg').textContent;
  const count = () => $('#count').textContent;
  async function choose(name, data) {
    const input = $('#file');
    Object.defineProperty(input, 'files', { value: [new window.File([JSON.stringify(data)], name)], configurable: true });
    input.dispatchEvent(new window.Event('change'));
    await wait(30);
  }
  const facetOpt = (label, value) => {
    const facet = $$('details.facet').find((d) => d.querySelector('summary').textContent.startsWith(label));
    return [...facet.querySelectorAll('label.opt')].find((l) => l.querySelector('.name').textContent === value);
  };
  const rowBox = (title) => $$('.row').find((r) => r.querySelector('a').textContent === title).querySelector('input');
  const groupCard = (name) => $$('.qcard').find((g) => g.querySelector('input').value === name);
  const button = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent.startsWith(text));

  // 1. Before a file: the welcome steps
  assert.equal($('#welcome').hidden, false);
  assert.equal($('#app').hidden, true);

  // 2. Wrong files get a clear message
  await choose('backup.json', { format: 'youtube-shadow-queue-backup', version: 1 });
  assert.match(msg(), /plain backup\. Run tools\/enrich\.mjs/);
  await choose('x.json', { hello: 1 });
  assert.match(msg(), /isn't an enriched\.json/);
  assert.equal($('#app').hidden, true);

  // 3. Open it: bad ids are dropped, titles are text (never HTML)
  await choose('enriched.json', enriched);
  assert.equal($('#app').hidden, false);
  assert.equal(count(), '8 videos');
  assert.ok(!$$('details.facet summary').some((x) => /Claude/.test(x.textContent)), "no Claude filter until tag.mjs has run");
  assert.equal($('.row a').href, `https://www.youtube.com/watch?v=${id('A')}`);
  assert.ok(!$$('.row img').some((img) => img.getAttribute('src') === 'x'), 'title HTML was not run');
  assert.ok($$('.row a').some((a) => a.textContent === '<img src=x onerror=alert(1)>'));
  assert.match($$('.row').find((r) => r.textContent.includes('Gone video')).textContent, /Unavailable/);

  // 4. Filters: within a filter = any of them; across filters = all of them; counts follow
  facetOpt('Category', 'People & Blogs').querySelector('input').click();
  assert.equal(count(), '2 videos of 8');
  assert.equal(facetOpt('Channel', 'Chan 2').querySelector('.n').textContent, '2');
  facetOpt('Category', 'Music').querySelector('input').click();
  assert.equal(count(), '4 videos of 8');
  button(doc, 'Clear all filters').click();
  facetOpt('Where it is now', 'Saved: Mix').querySelector('input').click();
  assert.equal(count(), '2 videos of 8', 'a video in several lists matches any one of them');
  button(doc, 'Clear all filters').click();
  facetOpt('Category', 'People & Blogs').querySelector('input').click();
  facetOpt('Category', 'Music').querySelector('input').click();
  facetOpt('Length', 'Over 1 hour').querySelector('input').click();
  assert.equal(count(), '1 video of 8');
  button(doc, 'Clear all filters').click();
  assert.equal(count(), '8 videos');

  // 4b. Upload dates: shown as "… ago" (exact date on hover), filterable, sortable
  const rowOf = (title) => $$('.row').find((r) => r.querySelector('a').textContent === title);
  assert.equal(rowOf('Knee pain explained').querySelector('.when').textContent, '2 days ago');
  assert.match(rowOf('Knee pain explained').querySelector('.when').title, /^Uploaded \w+/);
  assert.equal(rowOf('Video C').querySelector('.when').textContent, '13 months ago');
  assert.equal(rowOf('Video D').querySelector('.when').textContent, '5 years ago');
  assert.equal(rowOf('Video G').querySelector('.when').textContent, '12 months ago', 'counts whole calendar months');
  assert.equal(rowOf('Video B').querySelector('.when'), null, 'no date known: nothing shown');
  assert.equal(facetOpt('Uploaded', 'Past week').querySelector('.n').textContent, '1');
  assert.equal(facetOpt('Uploaded', '1–3 years ago').querySelector('.n').textContent, '2');
  assert.equal(facetOpt('Uploaded', 'Unknown date').querySelector('.n').textContent, '4');
  facetOpt('Uploaded', 'Over 3 years ago').querySelector('input').click();
  assert.equal(count(), '1 video of 8');
  button(doc, 'Clear all filters').click();
  const sortBy = (value) => { $('#sort').value = value; $('#sort').dispatchEvent(new window.Event('change')); };
  const firstTitles = () => $$('.row a').slice(0, 3).map((a) => a.textContent);
  sortBy('new');
  assert.deepEqual(firstTitles(), ['Knee pain explained', 'Video G', 'Video C']);
  sortBy('old');
  assert.deepEqual(firstTitles(), ['Video D', 'Video C', 'Video G']);
  assert.equal($$('.row a').at(-1).textContent, 'Video H', 'unknown dates last, in queue order');
  sortBy('queue');

  // 5. Search: titles, channels and tags; descriptions only when asked
  $('#search').value = 'KNEE';
  $('#search').dispatchEvent(new window.Event('input'));
  await wait(200);
  assert.equal(count(), '1 video of 8');
  $('#search').value = 'secret';
  $('#search').dispatchEvent(new window.Event('input'));
  await wait(200);
  assert.equal(count(), '0 videos of 8');
  $('#searchDesc').click();
  assert.equal(count(), '1 video of 8');
  button(doc, 'Clear all filters').click();

  // 6. Shift-click picks a range; a new queue gets them in queue order
  rowBox('Knee pain explained').click();
  rowBox('Video C').dispatchEvent(new window.MouseEvent('click', { bubbles: true, shiftKey: true }));
  assert.equal($('#selCount').textContent, '3 selected');
  $('#newName').value = 'Health';
  $('#create').click();
  assert.match(msg(), /Made "Health" with 3 videos/);
  assert.equal($('#selCount').textContent, '', 'selection cleared');
  assert.match(groupCard('Health').textContent, /3 videos · 1 h 20 min/);
  assert.equal($$('.chip.group').length, 3);

  // 7. "Not in a new queue yet" makes splitting everything easy
  facetOpt('New queues', 'Not in a new queue yet').querySelector('input').click();
  assert.equal(count(), '5 videos of 8');
  button(doc, 'Select all shown').click();
  $('#newName').value = 'health';
  $('#create').click();
  assert.match(msg(), /already a new queue called "health"/);
  $('#newName').value = 'Rest';
  $('#create').click();
  assert.equal(count(), '0 videos of 8');
  assert.match($('#rows').textContent, /No videos match/);
  assert.match(groupCard('Rest').textContent, /1 unavailable video will be left out/);
  button(doc, 'Clear all filters').click();

  // 8. Rename: clashes are refused, a good name sticks
  const restName = groupCard('Rest').querySelector('input');
  restName.value = 'HEALTH';
  restName.dispatchEvent(new window.Event('change'));
  assert.match(msg(), /"HEALTH" is already used/);
  assert.ok(groupCard('Rest'), 'name put back');
  restName.value = 'Later';
  restName.dispatchEvent(new window.Event('change'));
  assert.ok(groupCard('Later'));

  // 9. Show one queue, take a video out of it
  button(groupCard('Health'), 'Show').click();
  assert.equal(count(), '3 videos of 8');
  rowBox('Video B').click();
  button(groupCard('Health'), '− Remove 1').click();
  assert.match(msg(), /Removed 1 video from "Health"/);
  assert.equal(count(), '2 videos of 8');
  button(doc, 'Clear all filters').click();
  rowBox('Video B').click();
  button(groupCard('Health'), '+ Add 1 selected').click();
  assert.match(msg(), /Added 1 video to "Health"/);

  // 10. Download: a saved-queues-only file the userscript accepts
  assert.equal($('#exportBox').hidden, false);
  $('#export').click();
  assert.equal(downloads.length, 1);
  assert.match(downloads[0].name, /^youtube-queue-organized-\d{4}-\d\d-\d\d\.json$/);
  const file = JSON.parse(await downloads[0].blob.text());
  assert.equal(file.format, 'youtube-shadow-queue-backup');
  assert.equal(file.version, 2);
  assert.equal(file.queue, undefined, 'never carries a queue');
  assert.deepEqual(file.saved.map((q) => q.name), ['Health', 'Later']);
  assert.deepEqual(file.saved[0].items.map((v) => v.id[0]).join(''), 'ACB', 'Health keeps its order (B was added back last)');
  assert.ok(!file.saved[1].items.some((v) => v.id === id('F')), 'unavailable video left out');
  assert.ok(file.saved[0].at > file.saved[1].at, 'Saved tab (newest first) shows them in this order');
  const mem = new Map();
  const store = createStore({ getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) });
  store.playLast({ id: id('Z'), title: 'mine' });
  assert.equal(store.inspectBackup(file).savedOnly, true);
  const r = store.importBackup(file, 'merge');
  assert.equal(r.savedAdded, 2);
  assert.deepEqual(store.get().items.map((v) => v.id), [id('Z')], 'queue untouched');
  assert.deepEqual(store.listSaved().map((q) => q.name), ['Health', 'Later']);

  // 11. Bigger text and pictures off are remembered
  $('#bigger').click();
  assert.equal(doc.documentElement.style.getPropertyValue('--fs'), '20px');
  $('#thumbs').click();
  assert.equal($$('.row img').length, 0);

  // 12. Reopening the page brings the new queues back
  const saved = { 'shadowQueueOrganizer.v1': window.localStorage.getItem('shadowQueueOrganizer.v1') };
  window.close();
  window = open(saved);
  doc = window.document;
  assert.equal(doc.documentElement.style.getPropertyValue('--fs'), '20px');
  await choose('enriched.json', enriched);
  assert.match(msg(), /Your 2 new queues from last time are back/);
  assert.match(groupCard('Later')?.textContent ?? '', /5 videos/);
  window.close();
  window = open(saved);
  doc = window.document;
  const smaller = structuredClone(enriched);
  delete smaller.videos[id('H')]; // e.g. a newer backup where H was removed
  await choose('enriched.json', smaller);
  assert.match(msg(), /Your 2 new queues from last time are back/);
  assert.ok(groupCard('Health'));
  assert.match(groupCard('Later').textContent, /4 videos/, 'videos missing from the new file are dropped');

  // A new queue keeps queue order, whatever order you ticked them in
  rowBox('<img src=x onerror=alert(1)>').click();
  rowBox('Knee pain explained').click();
  $('#newName').value = 'Order';
  $('#create').click();
  $('#export').click();
  const again = JSON.parse(await downloads.at(-1).blob.text());
  assert.equal(again.saved.find((q) => q.name === 'Order').items.map((v) => v.id[0]).join(''), 'AE');

  // 13. Delete takes two clicks; Start over too
  const del = button(groupCard('Later'), 'Delete');
  del.click();
  assert.ok(groupCard('Later'), 'first click only asks');
  del.click();
  assert.equal(groupCard('Later'), undefined);
  $('#startOver').click();
  $('#startOver').click();
  assert.equal($$('.qcard').length, 0);
  assert.equal($('#exportBox').hidden, true);

  // 14. Groups from tools/tag.mjs: their own filter (with what's left) and a chip on each row
  const tagged = structuredClone(enriched);
  tagged.videos[id('A')].ai = 'Health explainers';
  tagged.videos[id('B')].ai = 'Health explainers';
  tagged.videos[id('C')].ai = 'Body language';
  await choose('enriched.json', tagged);
  assert.equal(facetOpt("Claude's groups", 'Health explainers').querySelector('.n').textContent, '2');
  assert.equal(facetOpt("Claude's groups", 'Not sorted by Claude yet').querySelector('.n').textContent, '5');
  facetOpt("Claude's groups", 'Body language').querySelector('input').click();
  assert.equal(count(), '1 video of 8');
  assert.equal($('.row .chip.ai').textContent, 'Body language');
  assert.equal($$('.row .chip.ai').length, 1);

  assert.deepEqual(errors, []);
  console.log('Organizer test: all checks passed');
  window.close();
})().catch((e) => { console.error('FAILED:', e.stack); process.exit(1); });
