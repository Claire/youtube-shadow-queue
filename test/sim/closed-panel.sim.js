// Closed panel: no row building; opening it shows fresh data.
const fs = require('fs');
const assert = require('assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');
const A = 'AAAAAAAAAAA', B = 'BBBBBBBBBBB';
const dom = new JSDOM(`<!doctype html><html><head></head><body>
  <div class="card"><a href="/watch?v=${B}" title="Video B">Video B</a></div></body></html>`,
  { url: 'https://www.youtube.com/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
const { window } = dom; const doc = window.document;
window.localStorage.setItem('shadowQueue.v2', JSON.stringify({ current: null, items: [{ id: A, title: 'A' }], played: [] }));
window.fetch = async () => { throw new Error('offline'); };
window.eval(fs.readFileSync(process.argv[2], 'utf8'));
assert.equal(doc.querySelectorAll('.sq-row').length, 0, 'closed: no rows built');
doc.querySelector('.card a').dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
doc.body.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, altKey: true, code: 'KeyL' }));
assert.equal(doc.querySelector('.sq-badge').textContent, '2', 'Queue button still updates while closed');
assert.equal(doc.querySelectorAll('.sq-row').length, 0, 'still no rows while closed');
doc.querySelector('.sq-fab').click();
assert.equal(doc.querySelectorAll('.sq-row').length, 2, 'opening shows the fresh list');
console.log('Closed-panel test: all checks passed');
