// Unit tests for the queue logic. Run with:  npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore, SAVED_KEY, idFromHref, looksBadTitle, pickTitle, KEY, MAX_ITEMS, HISTORY_SIZE } = require('../youtube-shadow-queue.user.js');

// A fake localStorage, so tests don't need a browser.
const fakeStorage = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    has: (k) => m.has(k),
  };
};
const vid = (c) => ({ id: c.repeat(11), title: c });
const [A, B, C, D] = ['A', 'B', 'C', 'D'].map(vid);
const ids = (s) => s.items.map((v) => v.id[0]).join('');

test('playNext goes to the front, playLast to the back', () => {
  const s = createStore(fakeStorage());
  s.playLast(A); s.playLast(B);
  assert.equal(ids(s.playNext(C)), 'CAB');
});

test('re-adding a queued video does nothing (no duplicates, no moving)', () => {
  const s = createStore(fakeStorage());
  [A, B, C].forEach(s.playLast);
  assert.equal(ids(s.playNext(C)), 'ABC');
  assert.equal(ids(s.playLast(A)), 'ABC');
});

test('position: 0 = now playing, 1..n = spot in line, -1 = not queued', () => {
  const s = createStore(fakeStorage());
  [A, B, C].forEach(s.playLast);
  s.start(A.id);
  assert.equal(s.position(A.id), 0);
  assert.equal(s.position(B.id), 1);
  assert.equal(s.position(C.id), 2);
  assert.equal(s.position(D.id), -1);
});

test('adding the now-playing video is ignored', () => {
  const s = createStore(fakeStorage());
  [A, B].forEach(s.playLast);
  s.start(A.id);
  assert.equal(ids(s.playLast(A)), 'B');
});

test('start: item becomes now playing and stays until it ends', () => {
  const s = createStore(fakeStorage());
  [A, B, C].forEach(s.playLast);
  assert.equal(s.start(B.id).id, B.id);
  assert.equal(s.get().current.id, B.id);
  assert.equal(ids(s.get()), 'AC');
  assert.equal(s.start('zzzzzzzzzzz'), null);
  assert.equal(s.get().current.id, B.id); // unchanged
});

test('advance: current ends → it is dropped and the next one becomes current', () => {
  const s = createStore(fakeStorage());
  [A, B].forEach(s.playLast);
  assert.equal(s.advance('xxxxxxxxxxx').id, A.id); // nothing current yet: first item starts
  assert.equal(s.get().current.id, A.id);
  assert.equal(s.advance(A.id).id, B.id);
  assert.equal(s.advance(B.id), null);
  assert.deepEqual(s.get().current, null);
  assert.deepEqual(s.get().items, []);
});

test('advance: some other video ended → resume the unfinished current one', () => {
  const s = createStore(fakeStorage());
  [A, B].forEach(s.playLast);
  s.start(A.id);
  assert.equal(s.advance(D.id).id, A.id);
  assert.equal(ids(s.get()), 'B');
});

test('advance: an ended video that is also in up-next gets removed', () => {
  const s = createStore(fakeStorage());
  [A, B, C].forEach(s.playLast);
  s.start(A.id);
  s.advance(B.id); // you opened B yourself and watched it
  assert.equal(ids(s.get()), 'C');
});

test('bulk move up/down keeps selected items together', () => {
  const s = createStore(fakeStorage());
  [A, B, C, D].forEach(s.playLast);
  assert.equal(ids(s.move([B.id, D.id], -1)), 'BADC');
  assert.equal(ids(s.move([B.id, A.id], -1)), 'BADC'); // already at the top
  assert.equal(ids(s.move([B.id, D.id], 1)), 'ABCD');
  assert.equal(ids(s.move([C.id, D.id], 1)), 'ABCD'); // already at the bottom
  assert.equal(ids(s.move(A.id, 1)), 'BACD');          // a single id works too
});

test('moveToEdge keeps the selected items in their order', () => {
  const s = createStore(fakeStorage());
  [A, B, C, D].forEach(s.playLast);
  assert.equal(ids(s.moveToEdge([D.id, B.id], 'top')), 'BDAC');
  assert.equal(ids(s.moveToEdge([B.id, D.id], 'bottom')), 'ACBD');
});

test('remove one or many, removeCurrent, clear', () => {
  const s = createStore(fakeStorage());
  [A, B, C, D].forEach(s.playLast);
  assert.equal(ids(s.remove(A.id)), 'BCD');
  assert.equal(ids(s.remove([B.id, D.id])), 'C');
  s.start(C.id);
  assert.equal(s.removeCurrent().current, null);
  s.playLast(A);
  const cleared = s.clear();
  assert.equal(cleared.current, null);
  assert.deepEqual(cleared.items, []);
});

test('persists across a "browser restart" (new store, same storage)', () => {
  const storage = fakeStorage();
  const s = createStore(storage);
  [A, B].forEach(s.playLast);
  s.start(A.id);
  const after = createStore(storage).get();
  assert.equal(after.current.id, A.id);
  assert.equal(ids(after), 'B');
});

test('rejects bad IDs and survives corrupted or blocked storage', () => {
  const storage = fakeStorage();
  const s = createStore(storage);
  s.playNext({ id: '<script>', title: 'x' });
  assert.deepEqual(s.get().items, []);
  const empty = { current: null, items: [], played: [], paused: false };
  storage.setItem(KEY, '{not json');
  assert.deepEqual(s.get(), empty);
  storage.setItem(KEY, JSON.stringify({ current: { id: 'bad' }, items: [A, A, { id: 1 }], played: 'junk' }));
  assert.deepEqual(s.get(), { ...empty, items: [{ id: A.id, title: 'A' }] });
  assert.deepEqual(createStore(null).get(), empty); // blocked localStorage
});

test('titles are trimmed and capped; queue is capped', () => {
  const s = createStore(fakeStorage());
  s.playLast({ id: A.id, title: '  ' + 'x'.repeat(300) });
  assert.equal(s.get().items[0].title.length, 200);
  for (let i = 0; i < MAX_ITEMS + 10; i++) s.playLast({ id: String(i).padStart(11, '0') });
  assert.equal(s.get().items.length, MAX_ITEMS);
});

test('a full queue refuses new videos without dropping existing ones', () => {
  const s = createStore(fakeStorage());
  for (let i = 0; i < MAX_ITEMS; i++) s.playLast({ id: String(i).padStart(11, '0') });
  assert.equal(s.isFull(), true);
  const before = s.get().items.map((v) => v.id);
  s.playLast(B);
  s.playNext(C);
  assert.deepEqual(s.get().items.map((v) => v.id), before); // last item NOT pushed out
  assert.equal(s.position(B.id), -1);
  s.remove(before[0]);
  assert.equal(s.isFull(), false);
  s.playNext(C);
  assert.equal(s.position(C.id), 1);
});

test('idFromHref handles watch, shorts, and junk', () => {
  assert.equal(idFromHref('/watch?v=dQw4w9WgXcQ&t=10s'), 'dQw4w9WgXcQ');
  assert.equal(idFromHref('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(idFromHref('/watch?v=short'), null);
  assert.equal(idFromHref('/channel/abc'), null);
});

const played = (s) => s.get().played.map((v) => v.id[0]).join('');

test('finished queue videos go to history, oldest first, with idle flag and time', () => {
  const s = createStore(fakeStorage());
  [A, B, C].forEach(s.playLast);
  s.advance('xxxxxxxxxxx');              // A starts
  s.advance(A.id);                       // A ends (awake) → B
  s.advance(B.id, { idle: true });       // B ends (asleep) → C
  assert.equal(played(s), 'AB');
  const [a, b] = s.get().played;
  assert.equal(a.idle, false);
  assert.equal(b.idle, true);
  assert.ok(b.at > 0);
  assert.equal(s.get().current.id, C.id);
});

test('a random non-queue video ending does not enter history', () => {
  const s = createStore(fakeStorage());
  s.playLast(A);
  s.advance(D.id);
  assert.equal(played(s), '');
});

test('"Play now" moves the replaced current video into history', () => {
  const s = createStore(fakeStorage());
  [A, B].forEach(s.playLast);
  s.start(A.id);
  s.start(B.id);
  assert.equal(played(s), 'A');
});

test('replayFrom puts that video and everything after it back in line, in order', () => {
  const s = createStore(fakeStorage());
  [A, B, C, D].forEach(s.playLast);
  s.advance('xxxxxxxxxxx');          // A current
  s.advance(A.id);                   // B current
  s.advance(B.id, { idle: true });   // C current
  // fell asleep during B: replay from B → B now, then C (unfinished), then D
  const r = s.replayFrom(B.id);
  assert.equal(r.ok, true);
  assert.equal(r.video.id, B.id);
  assert.equal(s.get().current.id, B.id);
  assert.equal(ids(s.get()), 'CD');
  assert.equal(played(s), 'A');
  assert.deepEqual(s.replayFrom(D.id), { ok: false, reason: 'missing' });
});

test('replayFrom refuses when it would overflow the queue', () => {
  const s = createStore(fakeStorage());
  s.playLast(A);
  s.advance('xxxxxxxxxxx');
  s.advance(A.id);                                    // A in history, queue empty
  for (let i = 0; i < MAX_ITEMS; i++) s.playLast({ id: String(i).padStart(11, '0') });
  s.advance('xxxxxxxxxxx');                           // one becomes current, MAX-1 waiting
  s.playLast(B);                                      // queue full again
  assert.deepEqual(s.replayFrom(A.id), { ok: false, reason: 'full' });
  assert.equal(played(s), 'A');                       // nothing lost
});

test('history: re-watched video moves to the end, capped, and cleared separately', () => {
  const s = createStore(fakeStorage());
  [A, B].forEach(s.playLast);
  s.advance('xxxxxxxxxxx'); s.advance(A.id); s.advance(B.id);
  s.playLast(A); s.advance('xxxxxxxxxxx'); s.advance(A.id);
  assert.equal(played(s), 'BA');
  s.clear();
  assert.equal(played(s), 'BA');                      // "Clear all" keeps history
  s.clearHistory();
  assert.equal(played(s), '');
  for (let i = 0; i < HISTORY_SIZE + 5; i++) {
    const v = { id: String(i).padStart(11, '0') };
    s.playLast(v); s.advance('xxxxxxxxxxx'); s.advance(v.id);
  }
  assert.equal(s.get().played.length, HISTORY_SIZE);
  assert.equal(s.get().played.at(-1).id, String(HISTORY_SIZE + 4).padStart(11, '0')); // newest kept
});

test('sleepStart: oldest video in the trailing run of 💤 videos', () => {
  const s = createStore(fakeStorage());
  const [E] = ['E'].map(vid);
  [A, B, C, D, E].forEach(s.playLast);
  s.advance('xxxxxxxxxxx');
  s.advance(A.id, { idle: true });   // an old doze, broken by…
  s.advance(B.id);                   // …an awake video
  assert.equal(s.sleepStart(), null, 'last video was awake: no doze run');
  s.advance(C.id, { idle: true });
  s.advance(D.id, { idle: true });
  const st = s.sleepStart();
  assert.equal(st.video.id, C.id);
  assert.equal(st.count, 2);
  s.replayFrom(st.video.id);         // one click rewinds: C now, then D, then E
  assert.equal(s.get().current.id, C.id);
  assert.equal(ids(s.get()), 'DE');
  assert.equal(s.sleepStart(), null);
});

test('pickTitle skips thumbnail badges like "New" and durations', () => {
  const id = 'ZLOrgc9vNwk';
  assert.equal(pickTitle([{ textContent: ' New ' }, { textContent: 'The real video title' }], id), 'The real video title');
  assert.equal(pickTitle([{ textContent: '12:34' }, { title: 'From the title attribute', textContent: 'x' }], id), 'From the title attribute');
  assert.equal(pickTitle([{ textContent: 'New  12:34' }, { textContent: 'Short title' }], id), 'Short title'); // badges run together
  assert.equal(pickTitle([{ textContent: 'LIVE' }], id), id);
});

test('looksBadTitle flags ids, badges and durations only', () => {
  assert.equal(looksBadTitle('new', 'ZLOrgc9vNwk'), true);
  assert.equal(looksBadTitle('1:02:03', 'ZLOrgc9vNwk'), true);
  assert.equal(looksBadTitle('ZLOrgc9vNwk', 'ZLOrgc9vNwk'), true);
  assert.equal(looksBadTitle('New 4K 12:34', 'ZLOrgc9vNwk'), true);
  assert.equal(looksBadTitle('New Year fireworks', 'ZLOrgc9vNwk'), false);
  assert.equal(looksBadTitle('Live at Wembley 1986', 'ZLOrgc9vNwk'), false);
});

test('rename fixes a title in now playing, up next and history', () => {
  const s = createStore(fakeStorage());
  [A, B, C].forEach(s.playLast);
  s.advance('xxxxxxxxxxx'); s.advance(A.id); // A in history, B current
  s.rename(A.id, 'Real A'); s.rename(B.id, 'Real B'); s.rename(C.id, '  Real C  ');
  s.rename(C.id, '   ');                     // blank is ignored
  const st = s.get();
  assert.equal(st.played[0].title, 'Real A');
  assert.equal(st.current.title, 'Real B');
  assert.equal(st.items[0].title, 'Real C');
});

test('auto-play switch: paused is saved and survives other changes', () => {
  const storage = fakeStorage();
  const s = createStore(storage);
  assert.equal(s.get().paused, false);
  s.setPaused(true);
  s.playLast(A);
  s.advance('xxxxxxxxxxx');
  assert.equal(createStore(storage).get().paused, true, 'still off after a "restart"');
  s.setPaused(false);
  assert.equal(s.get().paused, false);
});

test('saveAs: saves now playing + up next; names are unique ignoring capitals', () => {
  const s = createStore(fakeStorage());
  assert.deepEqual(s.saveAs('  '), { ok: false, reason: 'noname' });
  assert.deepEqual(s.saveAs('Empty'), { ok: false, reason: 'empty' });
  [A, B, C].forEach(s.playLast);
  s.start(A.id);
  assert.deepEqual(s.saveAs('  Cabin   videos '), { ok: true, count: 3 });
  const [q] = s.listSaved();
  assert.equal(q.name, 'Cabin videos');
  assert.deepEqual(q.items.map((v) => v.id[0]).join(''), 'ABC');
  assert.deepEqual(s.saveAs('cabin VIDEOS'), { ok: false, reason: 'exists' });
  s.remove(B.id);
  assert.deepEqual(s.saveAs('cabin videos', { overwrite: true }), { ok: true, count: 2 });
  assert.equal(s.listSaved().length, 1);
  assert.equal(s.listSaved()[0].items.length, 2);
});

test('loadSaved replace / front / end', () => {
  const s = createStore(fakeStorage());
  const [E] = ['E'].map(vid);
  [A, B, C].forEach(s.playLast);
  s.saveAs('abc');
  s.clear();
  [C, D].forEach(s.playLast);
  s.start(D.id); // D now playing, C up next

  // end: only ones not already queued; C stays where it is
  assert.deepEqual(s.loadSaved('ABC', 'end'), { ok: true, added: 2, already: 1, skipped: 0 });
  assert.equal(s.get().current.id, D.id);
  assert.equal(ids(s.get()), 'CAB');

  // front: saved order goes first, already-queued ones move up
  s.playLast(E);
  assert.deepEqual(s.loadSaved('abc', 'front'), { ok: true, added: 0, already: 3, skipped: 0 });
  assert.equal(ids(s.get()), 'ABCE');

  // replace: becomes the whole queue
  assert.deepEqual(s.loadSaved('abc', 'replace'), { ok: true, added: 3, already: 0, skipped: 0 });
  assert.equal(s.get().current, null);
  assert.equal(ids(s.get()), 'ABC');

  assert.deepEqual(s.loadSaved('nope', 'end'), { ok: false, reason: 'missing' });
});

test('loadSaved never goes past the queue limit and reports what did not fit', () => {
  const s = createStore(fakeStorage());
  [A, B].forEach(s.playLast);
  s.saveAs('two');
  s.clear();
  for (let i = 0; i < MAX_ITEMS - 1; i++) s.playLast({ id: String(i).padStart(11, '0') });
  assert.deepEqual(s.loadSaved('two', 'end'), { ok: true, added: 1, already: 0, skipped: 1 });
  assert.equal(s.get().items.length, MAX_ITEMS);
  const r = s.loadSaved('two', 'front'); // A is in, B is not; only room for what's already there
  assert.equal(s.get().items.length, MAX_ITEMS);
  assert.equal(r.skipped + r.added + r.already, 2);
});

test('renameSaved and deleteSaved', () => {
  const s = createStore(fakeStorage());
  s.playLast(A);
  s.saveAs('one');
  s.saveAs('two');
  assert.deepEqual(s.renameSaved('one', 'TWO'), { ok: false, reason: 'exists' });
  assert.deepEqual(s.renameSaved('one', ''), { ok: false, reason: 'noname' });
  assert.deepEqual(s.renameSaved('zzz', 'x'), { ok: false, reason: 'missing' });
  assert.deepEqual(s.renameSaved('one', 'Uno'), { ok: true });
  assert.deepEqual(s.renameSaved('uno', 'UNO'), { ok: true }); // changing just the capitals is fine
  assert.deepEqual(s.listSaved().map((q) => q.name).sort(), ['UNO', 'two']);
  assert.equal(s.deleteSaved('Two'), true);
  assert.equal(s.deleteSaved('two'), false);
  assert.deepEqual(s.listSaved().map((q) => q.name), ['UNO']);
});

test('saved queues ignore junk in storage', () => {
  const storage = fakeStorage();
  storage.setItem(SAVED_KEY, JSON.stringify([null, { name: '' , items: [A] }, { name: 'ok', items: [A, { id: 'bad' }, A] }, { name: 'empty', items: [] }]));
  const list = createStore(storage).listSaved();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'ok');
  assert.equal(list[0].items.length, 1);
  storage.setItem(SAVED_KEY, '{oops');
  assert.deepEqual(createStore(storage).listSaved(), []);
});

// History helpers: build a store whose Played list (oldest → newest) is A B C D.
const withHistory = () => {
  const s = createStore(fakeStorage());
  [A, B, C, D].forEach(s.playLast);
  s.advance('xxxxxxxxxxx');
  [A, B, C, D].forEach((v) => s.advance(v.id));
  return s;
};
const shown = (s) => s.get().played.slice().reverse().map((v) => v.id[0]).join(''); // on-screen: newest first

test('Played tab: move up/down works in on-screen order (newest at top)', () => {
  const s = withHistory();
  assert.equal(shown(s), 'DCBA');
  s.movePlayed([B.id], -1);                 // up on screen
  assert.equal(shown(s), 'DBCA');
  s.movePlayed([D.id, C.id], 1);            // each picked one moves down one step
  assert.equal(shown(s), 'BDAC');
  s.movePlayed([C.id], 1);                  // already at the bottom
  assert.equal(shown(s), 'BDAC');
});

test('Played tab: move to top/bottom keeps the picked order', () => {
  const s = withHistory();
  s.movePlayedToEdge([A.id, C.id], 'top');
  assert.equal(shown(s), 'CADB');
  s.movePlayedToEdge([C.id], 'bottom');
  assert.equal(shown(s), 'ADBC');
});

test('Played tab: remove one or many; the rest of the queue is untouched', () => {
  const s = withHistory();
  s.playLast(vid('E'));
  s.removePlayed(B.id);
  assert.equal(shown(s), 'DCA');
  s.removePlayed([A.id, D.id]);
  assert.equal(shown(s), 'C');
  assert.equal(ids(s.get()), 'E');
});

test('Play from here still works after history was reordered', () => {
  const s = withHistory();
  s.movePlayedToEdge([A.id], 'top');        // on screen: A D C B → stored B C D A
  const r = s.replayFrom(C.id);             // C and everything newer than it: C, D, A
  assert.equal(r.ok, true);
  assert.equal(s.get().current.id, C.id);
  assert.equal(ids(s.get()), 'DA');
  assert.equal(shown(s), 'B');
});

test('Play from here works when the queue ends up exactly full', () => {
  const s = createStore(fakeStorage());
  s.playLast(A);
  s.advance('xxxxxxxxxxx');
  s.advance(A.id);                                    // A in history, queue empty
  for (let i = 0; i < MAX_ITEMS; i++) s.playLast({ id: String(i).padStart(11, '0') });
  const r = s.replayFrom(A.id);                       // A plays now, MAX_ITEMS still up next: fits exactly
  assert.equal(r.ok, true);
  assert.equal(s.get().current.id, A.id);
  assert.equal(s.get().items.length, MAX_ITEMS);
});

test('history over the limit (e.g. edited by hand) is trimmed on read, newest kept', () => {
  const storage = fakeStorage();
  const old = Array.from({ length: HISTORY_SIZE + 5 }, (_, i) => ({ id: String(i).padStart(11, '0'), title: `v${i}`, idle: false, at: i }));
  storage.setItem(KEY, JSON.stringify({ current: null, items: [], played: old }));
  const { played } = createStore(storage).get();
  assert.equal(played.length, HISTORY_SIZE);
  assert.equal(played[0].id, String(5).padStart(11, '0'));
  assert.equal(played.at(-1).id, String(HISTORY_SIZE + 4).padStart(11, '0'));
});

test('saved queues: changes from another tab are seen right away; returned lists are copies', () => {
  const storage = fakeStorage();
  const s = createStore(storage);
  s.playLast(A);
  s.saveAs('one');
  assert.deepEqual(s.listSaved().map((q) => q.name), ['one']);
  // another tab writes directly to storage
  storage.setItem(SAVED_KEY, JSON.stringify([{ name: 'other tab', items: [B], at: 5 }]));
  assert.deepEqual(s.listSaved().map((q) => q.name), ['other tab']);
  // changing a returned list must not change what the store sees next
  s.listSaved().length = 0;
  assert.equal(s.listSaved().length, 1);
});
