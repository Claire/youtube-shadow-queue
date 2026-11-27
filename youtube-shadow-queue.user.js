// ==UserScript==
// @name         YouTube Shadow Queue
// @namespace    local.youtube-shadow-queue
// @version      1.3.0
// @description  Adds "Play next" / "Play last" to YouTube's ⋮ menu. Own queue, saved queues, history. Kept in Violentmonkey/Tampermonkey storage.
// @license      MIT
// @homepageURL  https://github.com/Claire/youtube-shadow-queue
// @supportURL   https://github.com/Claire/youtube-shadow-queue/issues
// @author       Claire
// @match        https://www.youtube.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        unsafeWindow
// @sandbox      JavaScript
// @noframes
// ==/UserScript==

/*
 * HOW IT WORKS (the simple version)
 * ---------------------------------
 * Picture a stack of sticky notes next to the TV.
 *   "Play next" sticks a note on TOP.  "Play last" sticks one at the BOTTOM.
 * The note you're watching sits in a "Now playing" slot. It only gets thrown
 * away when that video FINISHES — then the next note moves into the slot.
 * Everything is kept in Violentmonkey's own storage (see the script's "Values"
 * tab), so it survives quitting the browser AND clearing YouTube's cookies.
 *
 * Why the header asks for what it does:
 *   @grant GM_*        storage that belongs to the script, not to youtube.com,
 *                      plus a change listener so open tabs stay in sync.
 *   @grant unsafeWindow reach YouTube's own page settings (ytcfg) for "Export to a
 *                      YouTube playlist", whichever userscript manager runs us.
 *   @sandbox JavaScript (Tampermonkey) run where YouTube's own code can be reached,
 *                      so we can call its player (getVideoData / loadVideoById).
 *                      Violentmonkey's default injection mode already does this.
 *   @noframes          only the main page needs the queue; this keeps the script out
 *                      of any frames inside a YouTube page (one queue per tab).
 *
 * Auto-play switch (panel header, or Option+P): turn it Off to watch whatever you
 * like — the queue waits and won't jump in when a video ends. Turn it On to resume.
 *
 * Saved tab: "Save current queue" under a name. Load it later with
 * Replace, Add to front, or Add to end. Rename or delete saved queues there too.
 * "Export" turns a saved queue into a real playlist on your YouTube account
 * (Private by default), adding the videos one at a time with progress, pause and resume.
 *
 * Already queued? Hovering a video shows an "In queue · #3" badge, its ⋮ menu
 * offers "Remove from queue" instead, and it is never added twice.
 *
 * Three ways to add a video:
 *   1. Click ⋮ on any video → "Play next" or "Play last".
 *   2. Hover over a video and press Option+N (next) or Option+L (last).
 *      This backup way keeps working even if YouTube redesigns its menu.
 *   3. The "Add to queue" button that appears on a thumbnail when you hover
 *      now adds to the END of this queue. Option-click it for YouTube's own queue.
 *
 * Resize the panel by dragging its top edge, right edge, or top-right corner.
 * The size is remembered. Double-click a grab point to go back to the normal size.
 *
 * Queue panel (bottom-left): tick checkboxes (Shift-click selects a range), then
 * move them to top / up / down / to bottom, or remove them. Open tabs stay in sync.
 *
 * Fell asleep? Finished videos go to the "Played" tab (with the time they ended).
 * The Played tab has the same tick-boxes and toolbar as Up next (move, remove).
 * Ones that played while nobody touched the mouse or keyboard get a 💤.
 * One click on "Back to where I dozed off" (in the panel's 💤 banner or the
 * "Still watching?" prompt) rewinds to the first of those and plays from there.
 * After a few untouched videos in a row, the queue pauses and asks "Still watching?".
 */

(() => {
  'use strict';

  /* ======================= SETTINGS — safe to edit ======================= */
  const MAX_ITEMS = 500;  // Most videos the queue can hold. Need more? Raise it (2000 is still fast and small).
  const TEXT_SIZE = 16;   // Panel text size in px. Want bigger? Raise it (e.g. 18) — all panel text scales with it.
  const HISTORY_SIZE = 100;        // How many finished videos the "Played" tab remembers.
  const STILL_WATCHING_AFTER = 2;  // Ask "Still watching?" after this many videos in a row with no mouse/keyboard use. 0 = never ask.
  const SMOOTH_NEXT = true;        // Switch videos in place like YouTube does (keeps Picture-in-Picture open).
                                   // false = always reload the page for the next video.
  /* ======================================================================== */

  // Storage key names must never change: renaming one would orphan everyone's saved data.
  const KEY = 'shadowQueue.v2';       // the queue: { current, items, played, paused }
  const SAVED_KEY = 'shadowQueue.saved';        // saved queues: [{ name, items, at }]
  const SIZE_KEY = 'shadowQueue.size';          // panel size the user dragged to
  const DOZE_SEEN_KEY = 'shadowQueue.dozeSeen'; // remembers a dismissed 💤 banner
  const NAME_MAX = 60;                          // longest saved-queue name
  const PLAYLIST_ID_RE = /^[\w-]{10,64}$/;      // YouTube playlist ids ("PL…"): letters, digits, _ and -
  const PRIVACY = ['PRIVATE', 'UNLISTED', 'PUBLIC'];
  const EXPORT_STATUSES = ['running', 'paused', 'done', 'error'];
  const EXPORT_DELAY_MS = 1500;                 // pause between adding videos (YouTube limits fast adds)
  const BACKUP_FORMAT = 'youtube-shadow-queue-backup'; // marks our backup files
  const BACKUP_VERSION = 1;                     // full backups: queue + history + saved queues
  // Saved-queues-only files (e.g. from the organizer) have no "queue" and say version 2,
  // so older copies of this script refuse them instead of offering "Replace all".
  const SAVED_ONLY_VERSION = 2;
  const ID_RE = /^[\w-]{11}$/;        // every YouTube video ID is 11 chars of [A-Za-z0-9_-]
  const LINK_SEL = 'a[href*="/watch?v="], a[href^="/shorts/"]';

  /* ======================================================================
   * 1. PURE LOGIC (no DOM) — this part is unit-tested
   * ==================================================================== */

  /** Turn a YouTube link into a validated 11-char video ID, or null. */
  function idFromHref(href) {
    try {
      const u = new URL(href, 'https://www.youtube.com');
      const id = u.pathname.startsWith('/shorts/') ? u.pathname.split('/')[2] : u.searchParams.get('v');
      return ID_RE.test(id || '') ? id : null;
    } catch {
      return null;
    }
  }

  /** Normalize a {id, title} pair so nothing weird ever gets stored. */
  const clean = (v) => ({ id: v.id, title: String(v.title || v.id).trim().slice(0, 200) });

  /**
   * True when a title is clearly not a real title: just the video id, or a
   * thumbnail badge like "New", "LIVE", "4K", "Shorts", a duration "12:34", or only those words.
   */
  const BADGE_WORD_RE = /^(new|live|premiere|upcoming|shorts?|4k|8k|hd|cc|now|playing|\d{1,2}(:\d{2}){1,2})$/i;
  function looksBadTitle(title, id) {
    const t = String(title || '').trim();
    if (!t || t === id || t.length < 3) return true;
    return t.split(/\s+/).every((w) => BADGE_WORD_RE.test(w)); // e.g. "New 12:34" is all badges
  }

  /**
   * Move the selected ids one step toward the start (delta < 0) or end (delta > 0)
   * of a list. Selected items move together as a block and never jump over each other.
   * Returns a new list.
   */
  function moveBlock(list, ids, delta) {
    const sel = new Set([].concat(ids));
    const l = list.slice();
    const swap = (i, j) => { [l[i], l[j]] = [l[j], l[i]]; };
    if (delta < 0) {
      for (let i = 1; i < l.length; i++) if (sel.has(l[i].id) && !sel.has(l[i - 1].id)) swap(i, i - 1);
    } else {
      for (let i = l.length - 2; i >= 0; i--) if (sel.has(l[i].id) && !sel.has(l[i + 1].id)) swap(i, i + 1);
    }
    return l;
  }

  /** Move the selected ids to the 'top' (start) or 'bottom' (end), keeping their order. Returns a new list. */
  function moveEdge(list, ids, edge) {
    const sel = new Set([].concat(ids));
    const picked = list.filter((v) => sel.has(v.id));
    const rest = list.filter((v) => !sel.has(v.id));
    return edge === 'top' ? [...picked, ...rest] : [...rest, ...picked];
  }

  /** 0 = now playing, 1..n = spot in "up next", -1 = not queued. */
  function positionIn(state, id) {
    if (state.current?.id === id) return 0;
    const i = state.items.findIndex((v) => v.id === id);
    return i < 0 ? -1 : i + 1;
  }

  /** Oldest video of the trailing run of idle (💤) videos in history, or null. */
  function sleepStartIn(state) {
    const p = state.played;
    let i = p.length;
    while (i > 0 && p[i - 1].idle) i--;
    const count = p.length - i;
    return count ? { video: p[i], count } : null;
  }

  /**
   * Choose the real title from a card's links to one video.
   * 1. A link's title attribute (YouTube puts the full title there).
   * 2. Otherwise the longest link text that isn't a badge ("New", "12:34").
   * @param {{title?: string, textContent?: string}[]} links  the card's links to this video
   * @param {string} id  the video's id (a title that's just the id doesn't count)
   * @returns {string} the best title found, or the id if there's nothing better
   */
  function pickTitle(links, id) {
    const fromAttr = links.map((a) => (a.title || '').trim()).find((t) => !looksBadTitle(t, id));
    if (fromAttr) return fromAttr;
    const texts = links.map((a) => (a.textContent || '').replace(/\s+/g, ' ').trim())
      .filter((t) => !looksBadTitle(t, id))
      .sort((x, y) => y.length - x.length);
    return texts[0] || id;
  }

  /**
   * The queue: { current: video|null, items: video[], played: video[], paused: boolean }.
   *   current = the video being played from the queue (kept until it ends)
   *   items   = what's up next, in order
   *   played  = finished videos, oldest → newest, each with { idle, at }
   *   paused  = auto-play switched off: the queue waits instead of playing on
   * Every call reads fresh from storage, so several tabs never overwrite
   * each other with stale copies.
   * @param {{getItem, setItem, removeItem}|null} storage  Violentmonkey storage (or localStorage)
   */
  function createStore(storage) {
    // Everything read from storage is treated as untrusted: it may have been edited by
    // hand in Violentmonkey's Values tab, or written by an older/newer copy in another tab.
    const valid = (v) => !!v && typeof v === 'object' && ID_RE.test(v.id);
    const parse = (key) => { try { return JSON.parse(storage.getItem(key)); } catch { return null; } };
    // Why de-duplicate on every read: two tabs adding the same video at the same moment
    // could both write it. Keeping the first copy quietly heals that.
    const unique = (list) => { const seen = new Set(); return list.filter((v) => !seen.has(v.id) && seen.add(v.id)); };
    const without = (list, ids) => { const drop = new Set([].concat(ids)); return list.filter((v) => !drop.has(v.id)); };

    const cleanPlayed = (v) => ({ ...clean(v), idle: v.idle === true, at: Number.isFinite(v.at) ? v.at : 0 });

    /** Turn any stored or imported queue object into a clean, valid one. */
    const cleanState = (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {}; // nothing saved yet (or unreadable)
      const current = valid(raw.current) ? clean(raw.current) : null;
      const items = unique((Array.isArray(raw.items) ? raw.items : []).filter(valid).map(clean))
        .filter((v) => !current || v.id !== current.id);
      const played = unique((Array.isArray(raw.played) ? raw.played : []).filter(valid).map(cleanPlayed))
        .slice(-HISTORY_SIZE);
      return { current, items, played, paused: raw.paused === true };
    };
    const read = () => cleanState(parse(KEY));

    const write = (s) => {
      const state = {
        current: s.current, items: s.items.slice(0, MAX_ITEMS),
        played: s.played.slice(-HISTORY_SIZE), paused: !!s.paused,
      };
      try { storage.setItem(KEY, JSON.stringify(state)); } catch { /* storage full/blocked: keep working in-session */ }
      return state;
    };

    const update = (fn) => { const s = read(); fn(s); return write(s); };

    /**
     * Export-to-YouTube progress kept on a saved queue, so an export can resume after
     * a page reload. Untrusted like everything in storage: anything odd → no progress.
     */
    const cleanExport = (e) => {
      if (!e || typeof e !== 'object') return null;
      const n = (x) => (Number.isInteger(x) && x >= 0 ? x : 0);
      return {
        playlistId: typeof e.playlistId === 'string' && PLAYLIST_ID_RE.test(e.playlistId) ? e.playlistId : null,
        next: n(e.next),
        added: n(e.added),
        skipped: Array.isArray(e.skipped) ? e.skipped.filter((id) => ID_RE.test(id)) : [],
        status: EXPORT_STATUSES.includes(e.status) ? e.status : 'paused',
        error: typeof e.error === 'string' ? e.error.slice(0, 300) : '',
        title: typeof e.title === 'string' ? e.title.slice(0, 150) : '',
        privacy: PRIVACY.includes(e.privacy) ? e.privacy : 'PRIVATE',
      };
    };

    // Saved queues live under their own key, so the live queue stays small and fast.
    const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
    const findSaved = (all, n) => all.findIndex((q) => q.name.toLowerCase() === n.toLowerCase());
    const parseSaved = (text) => {
      let raw;
      try { raw = JSON.parse(text); } catch { return []; } // unreadable → treat as none
      if (!Array.isArray(raw)) return []; // nothing saved yet (null) or not a list
      return raw
        .filter((q) => q && typeof q === 'object' && cleanName(q.name))
        .map((q) => ({
          name: cleanName(q.name),
          // +1 because a saved queue holds "now playing" plus a full "up next"
          items: unique((Array.isArray(q.items) ? q.items : []).filter(valid).map(clean)).slice(0, MAX_ITEMS + 1),
          at: Number.isFinite(q.at) ? q.at : 0,
          exp: cleanExport(q.exp),
        }))
        .filter((q) => q.items.length);
    };
    // Why cache: every panel refresh shows the Saved tab's count, and saved queues
    // can add up to a lot of text. We only re-parse when the stored text changed
    // (comparing two strings is far cheaper than parsing JSON).
    let savedCache = { text: undefined, list: [] };
    const readSaved = () => {
      let text = null;
      try { text = storage.getItem(SAVED_KEY); } catch { /* storage blocked */ }
      if (text !== savedCache.text) savedCache = { text, list: parseSaved(text) };
      return savedCache.list.slice(); // a copy: callers add/remove entries without touching the cache
    };
    const writeSaved = (all) => {
      try { storage.setItem(SAVED_KEY, JSON.stringify(all)); } catch { /* storage blocked */ }
    };

    /** "Name (imported)", or "(imported 2)", "(imported 3)"… — whichever isn't taken yet. */
    const freeName = (all, name) => {
      for (let n = 1; ; n++) {
        const suffix = n === 1 ? ' (imported)' : ` (imported ${n})`;
        const candidate = cleanName(name.slice(0, NAME_MAX - suffix.length) + suffix);
        if (findSaved(all, candidate) < 0) return candidate;
      }
    };

    const inspect = (data) => {
      if (!data || typeof data !== 'object' || data.format !== BACKUP_FORMAT) return { ok: false, reason: 'not-a-backup' };
      if (!(Number.isInteger(data.version) && data.version >= 1)) return { ok: false, reason: 'not-a-backup' };
      if (data.version > SAVED_ONLY_VERSION) return { ok: false, reason: 'newer' };
      const savedOnly = data.queue == null; // nothing to replace your queue with: only adding is allowed
      const queue = cleanState(savedOnly ? null : data.queue);
      const saved = parseSaved(JSON.stringify(Array.isArray(data.saved) ? data.saved : []));
      const exportedAt = typeof data.exportedAt === 'string' && !Number.isNaN(Date.parse(data.exportedAt)) ? data.exportedAt : null;
      return {
        ok: true, queue, saved, exportedAt, savedOnly,
        counts: { upNext: queue.items.length + (queue.current ? 1 : 0), played: queue.played.length, saved: saved.length },
      };
    };
    const canAdd = (s, id) => positionIn(s, id) < 0 && s.items.length < MAX_ITEMS;
    /** Add to the end of history (newest). A re-watched video moves to the end instead of repeating. */
    const pushPlayed = (s, v, idle) => {
      s.played = [...without(s.played, v.id), { ...clean(v), idle: !!idle, at: Date.now() }];
    };

    return {
      get: read,

      /** Put first in "up next". Already queued, playing, or queue full → nothing changes. */
      playNext: (v) => (valid(v) ? update((s) => {
        if (canAdd(s, v.id)) s.items = [clean(v), ...s.items];
      }) : read()),

      /** Put last in "up next". Already queued, playing, or queue full → nothing changes. */
      playLast: (v) => (valid(v) ? update((s) => {
        if (canAdd(s, v.id)) s.items = [...s.items, clean(v)];
      }) : read()),

      /** True when "up next" holds MAX_ITEMS videos. */
      isFull: () => read().items.length >= MAX_ITEMS,

      /** Where is this video? 0 = now playing, 1..n = spot in "up next", -1 = not queued. */
      position: (id) => positionIn(read(), id),

      /** Remove one id or an array of ids from "up next". */
      remove: (ids) => update((s) => { s.items = without(s.items, ids); }),

      /** Drop the "now playing" video without playing anything. */
      removeCurrent: () => update((s) => { s.current = null; }),

      /** Fix a video's title everywhere it appears (now playing, up next, history). */
      rename: (id, title) => update((s) => {
        const t = String(title || '').trim().slice(0, 200);
        if (!t) return;
        const fix = (v) => (v && v.id === id ? { ...v, title: t } : v);
        s.current = fix(s.current);
        s.items = s.items.map(fix);
        s.played = s.played.map(fix);
      }),

      /**
       * Move the selected ids one step up (delta < 0) or down (delta > 0).
       * Selected items move together as a block and never jump over each other.
       */
      move: (ids, delta) => update((s) => { s.items = moveBlock(s.items, ids, delta); }),

      /** Move the selected ids to the 'top' or 'bottom', keeping their order. */
      moveToEdge: (ids, edge) => update((s) => { s.items = moveEdge(s.items, ids, edge); }),

      /*
       * History edits. The Played tab shows the NEWEST video at the top, so these
       * work in that on-screen order: "up" = toward the top of the Played tab.
       * (Stored oldest → newest, so we flip, move, and flip back.)
       */
      removePlayed: (ids) => update((s) => { s.played = without(s.played, ids); }),
      movePlayed: (ids, delta) => update((s) => {
        s.played = moveBlock(s.played.slice().reverse(), ids, delta).reverse();
      }),
      movePlayedToEdge: (ids, edge) => update((s) => {
        s.played = moveEdge(s.played.slice().reverse(), ids, edge).reverse();
      }),

      /**
       * "Play now" from the list: that item becomes current. Returns it, or null.
       * The video it replaces goes into history, so it can always be found again.
       */
      start: (id) => {
        let started = null;
        update((s) => {
          const v = s.items.find((x) => x.id === id);
          if (!v) return;
          if (s.current) pushPlayed(s, s.current, false);
          s.items = without(s.items, id);
          s.current = started = v;
        });
        return started;
      },

      /**
       * A video just ended. Returns the video to play next, or null.
       * - If it was a queue video, it moves to history ("played"), tagged
       *   idle = true when nobody touched the mouse/keyboard while it played.
       * - If "now playing" was something else (you wandered off to another
       *   video), we go back and resume it.
       * - Otherwise the first "up next" item becomes "now playing".
       */
      advance: (endedId, { idle = false } = {}) => {
        let next = null;
        update((s) => {
          const ended = s.current?.id === endedId ? s.current : s.items.find((v) => v.id === endedId);
          if (ended) pushPlayed(s, ended, idle);
          s.items = without(s.items, endedId);
          if (s.current && s.current.id !== endedId) { next = s.current; return; }
          s.current = s.items.shift() || null;
          next = s.current;
        });
        return next;
      },

      /**
       * "Play from here": this history video and every one played after it go back
       * to the front of the line, in their original order, ahead of the unfinished
       * "now playing" video and the rest of "up next". The first one becomes current.
       * Returns { ok: true, video } or { ok: false, reason: 'missing' | 'full' }.
       */
      replayFrom: (id) => {
        let result = { ok: false, reason: 'missing' };
        update((s) => {
          const i = s.played.findIndex((v) => v.id === id);
          if (i < 0) return;
          const line = unique([...s.played.slice(i).map(clean), ...(s.current ? [s.current] : []), ...s.items]);
          if (line.length - 1 > MAX_ITEMS) { result = { ok: false, reason: 'full' }; return; }
          s.played = s.played.slice(0, i);
          s.current = line.shift();
          s.items = line;
          result = { ok: true, video: s.current };
        });
        return result;
      },

      /**
       * Where you probably fell asleep: the oldest video in the unbroken run of
       * 💤 videos at the end of history. Returns { video, count } or null.
       */
      sleepStart: () => sleepStartIn(read()),

      /** Clears "now playing" and "up next". History is kept (it has its own clear). */
      clear: () => update((s) => { s.current = null; s.items = []; }),

      clearHistory: () => update((s) => { s.played = []; }),

      /* ---------- Backup & restore ---------- */

      /** Everything worth keeping, as one plain object for a backup file. */
      exportBackup: () => ({
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        queue: read(),
        saved: readSaved(),
      }),

      /**
       * Check a parsed backup file before using it. Everything in it is cleaned the
       * same way as stored data, so a hand-edited or damaged file can't break anything.
       * Returns { ok, queue, saved, exportedAt, counts } or { ok: false, reason }.
       */
      inspectBackup: (data) => inspect(data),

      /**
       * Bring a backup in.
       *   'replace' → queue, history and saved queues become the backup's
       *               (your auto-play setting is kept)
       *   'merge'   → add what's missing: new videos go to the end of "up next"
       *               (never past MAX_ITEMS), history is combined by date, and a saved
       *               queue whose name exists with different videos comes in as "Name (imported)"
       * Returns a summary of what happened, or { ok: false, reason }.
       */
      importBackup: (data, mode) => {
        const b = inspect(data);
        if (!b.ok) return b;
        if (mode === 'replace' && b.savedOnly) return { ok: false, reason: 'saved-only' };
        if (mode === 'replace') {
          write({ ...b.queue, paused: read().paused });
          writeSaved(b.saved);
          return { ok: true, mode, ...b.counts };
        }
        const result = { ok: true, mode, savedOnly: b.savedOnly, added: 0, already: 0, skipped: 0, playedAdded: 0, savedAdded: 0, savedRenamed: 0 };
        update((s) => {
          const incoming = [...(b.queue.current ? [b.queue.current] : []), ...b.queue.items];
          const fresh = incoming.filter((v) => positionIn(s, v.id) < 0);
          const take = fresh.slice(0, Math.max(0, MAX_ITEMS - s.items.length));
          s.items = [...s.items, ...take];
          Object.assign(result, { added: take.length, already: incoming.length - fresh.length, skipped: fresh.length - take.length });
          // History: one entry per video (the most recent ending wins), oldest → newest.
          const byId = new Map(s.played.map((v) => [v.id, v]));
          for (const v of b.queue.played) {
            const mine = byId.get(v.id);
            if (!mine) result.playedAdded++;
            if (!mine || v.at > mine.at) byId.set(v.id, v);
          }
          s.played = [...byId.values()].sort((x, y) => x.at - y.at).slice(-HISTORY_SIZE);
        });
        const all = readSaved();
        const sameVideos = (x, y) => x.items.length === y.items.length && x.items.every((v, i) => v.id === y.items[i].id);
        for (const q of b.saved) {
          const i = findSaved(all, q.name);
          if (i < 0) { all.push(q); result.savedAdded++; continue; }
          if (sameVideos(all[i], q)) continue; // identical copy: nothing to do
          all.push({ ...q, name: freeName(all, q.name), exp: null });
          result.savedRenamed++;
        }
        writeSaved(all);
        return result;
      },

      /** Auto-play switch. paused = true → the queue waits when a video ends. */
      setPaused: (paused) => update((s) => { s.paused = !!paused; }),

      /* ---------- Saved queues ---------- */

      /** All saved queues, newest first: [{ name, items, at }]. */
      listSaved: () => readSaved().slice().sort((a, b) => b.at - a.at),

      /**
       * Save "now playing" + "up next" under a name.
       * Same name (any capitals) already saved → refused unless overwrite is true.
       * Returns { ok, count } or { ok: false, reason: 'noname' | 'empty' | 'exists' }.
       */
      saveAs: (name, { overwrite = false } = {}) => {
        const n = cleanName(name);
        if (!n) return { ok: false, reason: 'noname' };
        const { current, items } = read();
        const list = [...(current ? [current] : []), ...items];
        if (!list.length) return { ok: false, reason: 'empty' };
        const all = readSaved();
        const i = findSaved(all, n);
        if (i >= 0 && !overwrite) return { ok: false, reason: 'exists' };
        const entry = { name: n, items: list, at: Date.now(), exp: null }; // new contents → any old export no longer matches
        if (i >= 0) all[i] = entry; else all.push(entry);
        writeSaved(all);
        return { ok: true, count: list.length };
      },

      /**
       * Load a saved queue.
       *   'replace' → it becomes the whole queue (now playing is cleared)
       *   'front'   → put in front of "up next" (ones already queued move up)
       *   'end'     → add after "up next" (ones already queued stay where they are)
       * Never goes past MAX_ITEMS. Returns { ok, added, already, skipped } or
       * { ok: false, reason: 'missing' }.
       */
      loadSaved: (name, mode) => {
        const all = readSaved();
        const entry = all[findSaved(all, cleanName(name))];
        if (!entry) return { ok: false, reason: 'missing' };
        let result = { ok: true, added: 0, already: 0, skipped: 0 };
        update((s) => {
          const incoming = unique(entry.items);
          if (mode === 'replace') {
            s.current = null;
            s.items = incoming.slice(0, MAX_ITEMS);
            result = { ok: true, added: s.items.length, already: 0, skipped: incoming.length - s.items.length };
            return;
          }
          if (mode === 'front') {
            const fresh = incoming.filter((v) => v.id !== s.current?.id);
            const rest = without(s.items, fresh.map((v) => v.id));
            const room = Math.max(0, MAX_ITEMS - rest.length);
            const take = fresh.slice(0, room);
            const moved = take.filter((v) => s.items.some((x) => x.id === v.id)).length;
            s.items = [...take, ...rest];
            result = { ok: true, added: take.length - moved, already: incoming.length - fresh.length + moved, skipped: fresh.length - take.length };
            return;
          }
          const fresh = incoming.filter((v) => positionIn(s, v.id) < 0);
          const room = Math.max(0, MAX_ITEMS - s.items.length);
          const take = fresh.slice(0, room);
          s.items = [...s.items, ...take];
          result = { ok: true, added: take.length, already: incoming.length - fresh.length, skipped: fresh.length - take.length };
        });
        return result;
      },

      /** Returns { ok } or { ok: false, reason: 'noname' | 'missing' | 'exists' }. */
      renameSaved: (oldName, newName) => {
        const n = cleanName(newName);
        if (!n) return { ok: false, reason: 'noname' };
        const all = readSaved();
        const i = findSaved(all, cleanName(oldName));
        if (i < 0) return { ok: false, reason: 'missing' };
        const j = findSaved(all, n);
        if (j >= 0 && j !== i) return { ok: false, reason: 'exists' };
        all[i] = { ...all[i], name: n };
        writeSaved(all);
        return { ok: true };
      },

      /** Store (or clear, with null) a saved queue's export progress. */
      setExport: (name, exp) => {
        const all = readSaved();
        const i = findSaved(all, cleanName(name));
        if (i < 0) return false;
        all[i] = { ...all[i], exp: exp ? cleanExport(exp) : null };
        writeSaved(all);
        return true;
      },

      deleteSaved: (name) => {
        const all = readSaved();
        const i = findSaved(all, cleanName(name));
        if (i >= 0) { all.splice(i, 1); writeSaved(all); }
        return i >= 0;
      },
    };
  }

  /* ----------------------------------------------------------------------
   * Export a saved queue to a real YouTube playlist.
   *
   * YouTube has no simple official way for a userscript to create playlists, so
   * we send the same requests youtube.com itself sends when you click
   * Save → New playlist, using your own signed-in session. This approach (create
   * once, add one at a time, back off, skip unavailable videos) follows the
   * open-source "channel-to-playlist" extension by Hubert Gavin (MIT):
   * https://github.com/hubert2gavin/channel-to-playlist
   *
   * This part is pure: the network call (`api`) and waiting (`sleep`) are passed
   * in, so it can be tested without YouTube.
   * -------------------------------------------------------------------- */

  /** Sort a YouTube API reply into: ok | retry (busy/limited) | video (skip it) | auth | hard. */
  function classifyApi(r) {
    const j = r.json || {};
    if (r.status >= 200 && r.status < 300 && j.status === 'STATUS_SUCCEEDED') return 'ok';
    if (r.status === 0 || r.status === 429 || r.status >= 500) return 'retry';
    const text = apiErrorText(r).toLowerCase();
    if (/quota|rate|too many|try again later/.test(text)) return 'retry';
    if (r.status === 401 || r.status === 403 || /sign in|unauthenticated|login/.test(text)) return 'auth';
    if (r.status === 400 || r.status === 404 || j.status === 'STATUS_FAILED' || /unavailable|not found|invalid/.test(text)) return 'video';
    return 'hard';
  }

  function apiErrorText(r) {
    if (r.error) return String(r.error);
    const j = r.json || {};
    return String((j.error && (j.error.message || j.error.status)) || `HTTP ${r.status}`).slice(0, 200);
  }

  const playlistIdFrom = (j) => {
    const id = j && (j.playlistId || (j.playlist && j.playlist.playlistId));
    return typeof id === 'string' && PLAYLIST_ID_RE.test(id) ? id : null;
  };

  /**
   * Create the playlist (once) and add the videos one at a time, from progress.next.
   * Progress is reported after every step, so a reload can resume where it stopped.
   *
   * @param {object} o
   * @param {string[]} o.videoIds     the saved queue, in order
   * @param {string} o.title
   * @param {'PRIVATE'|'UNLISTED'|'PUBLIC'} o.privacy
   * @param {object} [o.progress]     { playlistId, next, added, skipped } from an earlier run
   * @param {(path: string, body: object) => Promise<{status: number, json?: object, error?: string}>} o.api
   * @param {(ms: number) => Promise<void>} o.sleep
   * @param {(p: object) => void} [o.onProgress]
   * @param {() => boolean} [o.shouldStop]   true → pause after the current step
   * @param {() => number} [o.random]
   * @returns {Promise<object>} progress plus status: 'done' | 'paused' | 'error' (with error text)
   */
  async function runExport(o) {
    const random = o.random || Math.random;
    const shouldStop = o.shouldStop || (() => false);
    const p = { playlistId: null, next: 0, added: 0, skipped: [], ...(o.progress || {}) };
    const report = (status, error = '') => {
      const out = { ...p, skipped: p.skipped.slice(), status, error, title: o.title, privacy: o.privacy };
      o.onProgress?.(out);
      return out;
    };

    // Busy or rate-limited → wait and try again, a little longer each time (with jitter
    // so retries don't line up). Gives up after 5 tries; the user can Resume later.
    const withRetry = async (call) => {
      for (let attempt = 0; ; attempt++) {
        const r = await call();
        const kind = classifyApi(r);
        if (kind !== 'retry' || attempt >= 4) return { r, kind };
        if (shouldStop()) return { r, kind: 'stopped' };
        await o.sleep(Math.min(60000, 2000 * 2 ** attempt) * (1 + random() * 0.3));
      }
    };
    const stopMessage = (kind, r) => (kind === 'auth'
      ? 'YouTube says you are not signed in. Sign in, reload the page, then Resume.'
      : kind === 'retry'
        ? 'YouTube is limiting requests right now. Try Resume later (it may be a daily limit).'
        : `YouTube refused the request: ${apiErrorText(r)}`);

    if (!o.videoIds.length) return report('error', 'This saved queue is empty.');

    if (!p.playlistId) {
      const body = { title: o.title, privacyStatus: o.privacy, videoIds: [] };
      let { r, kind } = await withRetry(() => o.api('/youtubei/v1/playlist/create', body));
      if (kind === 'stopped') return report('paused');
      p.playlistId = playlistIdFrom(r.json);
      if (!p.playlistId && kind !== 'auth') {
        // Some accounts only accept a new playlist with a first video in it.
        ({ r, kind } = await withRetry(() => o.api('/youtubei/v1/playlist/create', { ...body, videoIds: [o.videoIds[0]] })));
        p.playlistId = playlistIdFrom(r.json);
        if (p.playlistId) { p.next = 1; p.added = 1; }
      }
      if (!p.playlistId) return report('error', stopMessage(kind === 'ok' ? 'hard' : kind, r));
      report('running');
    }

    while (p.next < o.videoIds.length) {
      if (shouldStop()) return report('paused');
      const videoId = o.videoIds[p.next];
      const { r, kind } = await withRetry(() => o.api('/youtubei/v1/browse/edit_playlist', {
        playlistId: p.playlistId,
        actions: [{ action: 'ACTION_ADD_VIDEO', addedVideoId: videoId }],
      }));
      if (kind === 'stopped') return report('paused');
      if (kind === 'ok') p.added++;
      else if (kind === 'video') p.skipped.push(videoId); // deleted, private, or region-blocked
      else return report('error', stopMessage(kind, r));
      p.next++;
      report('running');
      if (p.next < o.videoIds.length) await o.sleep(EXPORT_DELAY_MS * (0.8 + random() * 0.6));
    }
    return report('done');
  }

  /**
   * The Authorization value youtube.com sends with its own API requests: a SHA-1 of
   * a timestamp, your SAPISID login cookie and the site address. The cookie itself
   * is never sent anywhere; only this hash goes to youtube.com, as YouTube does.
   * Two forms exist; newer accounts prefix your sync id and end with "_u".
   */
  async function sapisidHash(sapisid, origin, ts, userId, subtle = globalThis.crypto.subtle) {
    const text = userId ? [userId, ts, sapisid, origin].join(' ') : `${ts} ${sapisid} ${origin}`;
    const digest = await subtle.digest('SHA-1', new TextEncoder().encode(text));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return userId ? `${ts}_${hex}_u` : `${ts}_${hex}`;
  }

  /** Build the Authorization header from cookies (null if not signed in). */
  async function youtubeAuthHeader(cookies, origin, ts, userId) {
    const main = cookies.SAPISID || cookies['__Secure-3PAPISID'];
    if (!main) return null;
    const parts = [`SAPISIDHASH ${await sapisidHash(main, origin, ts, userId)}`];
    if (cookies['__Secure-1PAPISID']) parts.push(`SAPISID1PHASH ${await sapisidHash(cookies['__Secure-1PAPISID'], origin, ts, userId)}`);
    if (cookies['__Secure-3PAPISID']) parts.push(`SAPISID3PHASH ${await sapisidHash(cookies['__Secure-3PAPISID'], origin, ts, userId)}`);
    return parts.join(' ');
  }

  /**
   * A spreadsheet-friendly list (CSV) of everything in a backup: one row per video.
   * Opens in Numbers, Excel or Google Sheets.
   */
  function backupToCsv(backup) {
    // Why the apostrophe: a cell starting with = + - or @ would run as a formula in
    // spreadsheet apps. A leading ' makes it plain text (a video title can't run code).
    const cell = (value) => {
      let t = String(value ?? '');
      if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
      return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const url = (id) => `https://www.youtube.com/watch?v=${id}`;
    const rows = [['list', 'position', 'title', 'url', 'ended', 'no_activity']];
    const q = backup.queue;
    if (q.current) rows.push(['Now playing', 0, q.current.title, url(q.current.id), '', '']);
    q.items.forEach((v, i) => rows.push(['Up next', i + 1, v.title, url(v.id), '', '']));
    q.played.slice().reverse().forEach((v, i) => rows.push([
      'Played', i + 1, v.title, url(v.id), v.at ? new Date(v.at).toISOString() : '', v.idle ? 'yes' : 'no',
    ]));
    for (const sq of backup.saved) sq.items.forEach((v, i) => rows.push([`Saved: ${sq.name}`, i + 1, v.title, url(v.id), '', '']));
    // \ufeff (byte-order mark) tells Excel the file is UTF-8, so emoji and accents show correctly.
    return `\ufeff${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
  }

  // In Node (tests) we only export the pure logic. In the browser we start the UI.
  if (typeof window === 'undefined') {
    module.exports = {
      createStore, moveBlock, moveEdge, idFromHref, positionIn, sleepStartIn, looksBadTitle, pickTitle,
      runExport, classifyApi, sapisidHash, youtubeAuthHeader, backupToCsv, BACKUP_FORMAT,
      KEY, SAVED_KEY, SIZE_KEY, DOZE_SEEN_KEY, MAX_ITEMS, HISTORY_SIZE, NAME_MAX, EXPORT_DELAY_MS,
    };
    return;
  }

  /* ======================================================================
   * 2. BROWSER PART
   * ==================================================================== */

  /* ---------- Storage ----------
   * Prefer the userscript manager's own storage (Violentmonkey / Tampermonkey):
   * no 5 MB cap, and clearing YouTube's cookies doesn't erase it.
   * Falls back to YouTube's localStorage if those functions aren't available. */
  const local = (() => { try { return window.localStorage; } catch { return null; } })();
  const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
  const gmStorage = hasGM ? {
    getItem: (k) => { const v = GM_getValue(k, null); return v == null ? null : String(v); },
    setItem: (k, v) => GM_setValue(k, String(v)),
    removeItem: (k) => (typeof GM_deleteValue === 'function' ? GM_deleteValue(k) : GM_setValue(k, null)),
  } : null;
  const storage = gmStorage || local;
  const store = createStore(storage);

  /* ---------- YouTube API requests (used only by "Export to a YouTube playlist") ----------
   * The same kind of request youtube.com sends when you click Save → New playlist.
   * It goes only to youtube.com, with your own session, and only when you start an export. */
  const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const YT_ORIGIN = 'https://www.youtube.com';

  /** YouTube's own page settings (client version, session index…), or undefined. */
  function ytcfgGet(key) {
    try {
      const c = pageWin.ytcfg;
      return c && (typeof c.get === 'function' ? c.get(key) : c.data_ && c.data_[key]);
    } catch { return undefined; }
  }

  function readCookies() {
    const out = {};
    for (const part of String(document.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
  }

  /** Why an export can't start right now, or '' if it can. */
  function exportBlocker() {
    if (!ytcfgGet('INNERTUBE_CONTEXT')) return 'YouTube page data not found. Reload the page, then try again.';
    const c = readCookies();
    if (!c.SAPISID && !c['__Secure-3PAPISID']) return 'Sign in to YouTube first, then try again.';
    return '';
  }

  // Which of the two login-hash forms this account accepts; learned on the first success.
  let authMode = null;

  async function youtubeCall(path, body, mode) {
    const context = ytcfgGet('INNERTUBE_CONTEXT');
    const syncId = ytcfgGet('DATASYNC_ID');
    const userId = mode === 'u' && syncId ? String(syncId).split('||')[0] : null;
    const auth = await youtubeAuthHeader(readCookies(), YT_ORIGIN, Math.floor(Date.now() / 1000), userId);
    if (!context || !auth) return { status: 401, error: 'Not signed in' };
    const headers = {
      'Content-Type': 'application/json',
      Authorization: auth,
      'X-Origin': YT_ORIGIN,
      'X-Goog-AuthUser': String(ytcfgGet('SESSION_INDEX') ?? '0'),
      'X-Youtube-Client-Name': String(ytcfgGet('INNERTUBE_CONTEXT_CLIENT_NAME') ?? '1'),
      'X-Youtube-Client-Version': String(ytcfgGet('INNERTUBE_CLIENT_VERSION') || context.client?.clientVersion || ''),
    };
    const visitor = context.client?.visitorData || ytcfgGet('VISITOR_DATA');
    if (visitor) headers['X-Goog-Visitor-Id'] = visitor;
    const pageId = ytcfgGet('DELEGATED_SESSION_ID'); // set when using a brand account / channel
    if (pageId) headers['X-Goog-PageId'] = pageId;
    try {
      const res = await fetch(`${path}?prettyPrint=false`, {
        method: 'POST', credentials: 'include', headers, body: JSON.stringify({ context, ...body }),
      });
      let json = null;
      try { json = await res.json(); } catch { /* not JSON */ }
      return { status: res.status, json };
    } catch (e) {
      return { status: 0, error: String(e?.message || e) }; // offline etc. → retried
    }
  }

  /** Try the newer login-hash form first (if this account has a sync id), then the older one. */
  async function youtubeApi(path, body) {
    const modes = authMode ? [authMode] : ytcfgGet('DATASYNC_ID') ? ['u', 'legacy'] : ['legacy'];
    let last;
    for (const mode of modes) {
      last = await youtubeCall(path, body, mode);
      if (last.status !== 401 && last.status !== 403) { authMode = mode; return last; }
    }
    return last;
  }

  /* ---------- Tiny DOM helpers ----------
   * We never use innerHTML: YouTube enforces Trusted Types, and textContent
   * also makes injected titles harmless (no XSS). */
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const ICONS = { // Material icon paths (24×24)
    queue: 'M3 10h11v2H3zm0-4h11v2H3zm0 8h7v2H3zm13-1v8l6-4z',
    play: 'M8 5v14l11-7z',
    close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    up: 'M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z',
    down: 'M20 12l-1.41-1.41L13 16.17V4h-2v12.17l-5.58-5.59L4 12l8 8 8-8z',
    top: 'M8 11h3v10h2V11h3l-4-4-4 4zM4 3v2h16V3H4z',
    bottom: 'M16 13h-3V3h-2v10H8l4 4 4-4zM4 19v2h16v-2H4z',
    replay: 'M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z',
    check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
    edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
    playlistAdd: 'M14 10H2v2h12v-2zm0-4H2v2h12V6zm4 8v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zM2 16h8v-2H2v2z',
    open: 'M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z',
    save: 'M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7l-4-4zm-5 16a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm3-10H5V5h10v4z',
    trash: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
    download: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
    upload: 'M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z',
    table: 'M10 10.02h5V21h-5zM17 21h3c1.1 0 2-.9 2-2v-9h-5v11zm3-18H5c-1.1 0-2 .9-2 2v3h19V5c0-1.1-.9-2-2-2zM3 19c0 1.1.9 2 2 2h3V10H3v9z',
  };
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const icon = (name) => {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', ICONS[name]);
    svg.append(path);
    return svg;
  };

  const iconBtn = (name, label, onClick, extraCls = '') => {
    const b = el('button', `sq-icon-btn ${extraCls}`.trim());
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.append(icon(name));
    b.addEventListener('click', onClick);
    return b;
  };

  const thumb = (id) => {
    const img = el('img', 'sq-thumb');
    // YouTube's own thumbnail server. "mqdefault" is the 320×180 size: sharp enough
    // for a small list, much lighter than the full-size image. The id was validated,
    // so it can't smuggle anything into the URL.
    img.src = `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('error', () => { img.style.visibility = 'hidden'; }, { once: true }); // no broken-image icon
    return img;
  };

  /* ---------- Player helpers ---------- */
  const currentVideoId = () => idFromHref(location.href);

  /**
   * Play a video.
   *
   * YouTube is a "single-page app": its own links swap the video IN PLACE and keep
   * the same <video> player. Picture-in-Picture is attached to that player, so it
   * stays open. A full page load destroys the player and closes PiP — and a script
   * isn't allowed to reopen PiP without a click.
   *
   * So we ask YouTube to switch in place (its internal "yt-navigate" event, the
   * same one its links use). That updates the PAGE (title, description…), but
   * sometimes — e.g. while in Picture-in-Picture — the PLAYER stays on the old
   * video. So we check the player itself: if the page moved but the player
   * didn't, we tell the player directly to load the video (loadVideoById).
   * Last safety net: if the player still isn't on it after NAV_FALLBACK_MS,
   * we fall back to a normal page load.
   *
   * The safety net stands down if a newer play() starts, or if the page moves
   * somewhere other than this video (you clicked something else) — it must never
   * drag you back to a queue video you've moved on from.
   */
  const NUDGE_MS = 1500;        // page switched but player didn't after this long → load it in the player
  const NAV_FALLBACK_MS = 8000; // still not playing after this long → normal page load
  const hardPlay = (id) => location.assign(`/watch?v=${id}`);

  function softPlay(id) {
    const app = document.querySelector('ytd-app');
    if (!app) return false;
    const url = `/watch?v=${id}`;
    try {
      app.dispatchEvent(new CustomEvent('yt-navigate', {
        bubbles: true,
        composed: true,
        detail: {
          endpoint: {
            commandMetadata: { webCommandMetadata: { url, webPageType: 'WEB_PAGE_TYPE_WATCH' } },
            watchEndpoint: { videoId: id },
          },
        },
      }));
      return true;
    } catch {
      return false;
    }
  }

  /** Tell YouTube's player to load a video into the SAME <video> element. */
  function loadInPlayer(id) {
    const p = document.querySelector('#movie_player');
    if (typeof p?.loadVideoById !== 'function') return false;
    try { p.loadVideoById(id); return true; } catch { return false; }
  }

  let playToken = 0; // bumps on every play(); older safety nets see it and stop

  function play(id) {
    const token = ++playToken;
    if (!SMOOTH_NEXT || !softPlay(id)) { hardPlay(id); return; }
    const since = Date.now();
    const startHref = location.href;
    let pageMovedAt = 0;
    let nudged = false;
    const check = () => {
      if (token !== playToken) return; // a newer play() took over
      if (playerState().id === id) return; // the player itself is on it: done, PiP stays
      if (location.href !== startHref && currentVideoId() !== id) return; // you went elsewhere: leave you be
      const now = Date.now();
      if (!pageMovedAt && currentVideoId() === id) pageMovedAt = now;
      // Page switched but the player didn't → load it straight into the player.
      if (!nudged && pageMovedAt && now - pageMovedAt >= NUDGE_MS) nudged = loadInPlayer(id);
      if (now - since >= NAV_FALLBACK_MS) { hardPlay(id); return; } // last resort: a normal page load
      setTimeout(check, 250);
    };
    setTimeout(check, 250);
  }

  /** What the main player (also used by the miniplayer) is showing right now. */
  function playerState() {
    const player = document.querySelector('#movie_player');
    const video = player?.querySelector('video');
    let id = null;
    try { id = player?.getVideoData?.()?.video_id || null; } catch { /* API not ready */ }
    return { id, playing: !!video && !video.paused && !video.ended };
  }

  /**
   * Find the video a clicked/hovered element belongs to.
   * Walk up the page, box by box, while the box still links to exactly ONE video.
   * The last such box is that video's card (we use it to place the hover badge).
   * A box with links to 2+ different videos is a whole grid → stop there.
   */
  function videoFromNode(node) {
    let found = null;
    // 15 levels is plenty to climb from any part of a card to the card itself, and
    // keeps this cheap: it runs on hover, many times a second.
    for (let n = node, depth = 0; n && depth < 15; n = n.parentElement, depth++) {
      if (!n.querySelectorAll) continue;
      const links = (n.matches(LINK_SEL) ? [n] : [...n.querySelectorAll(LINK_SEL)])
        .filter((a) => !a.closest('.sq-theme')); // ignore our own panel's links
      if (!links.length) continue;
      const ids = new Set(links.map((a) => idFromHref(a.getAttribute('href'))).filter(Boolean));
      if (ids.size !== 1) break;
      const [id] = ids;
      found = { id, title: pickTitle(links, id), box: n };
    }
    return found;
  }

  /* ---------- Official titles ----------
   * YouTube's public oEmbed endpoint returns a video's real title. It lives on
   * youtube.com itself, so this is a same-site request: no keys, no third parties. */
  async function fetchTitle(id) {
    try {
      const url = `/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`;
      // No cookies needed for a public title — so none are sent.
      const res = await fetch(url, { credentials: 'omit' });
      if (!res.ok) return null;
      const { title } = await res.json();
      return typeof title === 'string' && title.trim() ? title.trim() : null;
    } catch {
      return null; // offline or blocked: keep the title we scraped
    }
  }

  async function confirmTitle(v) {
    const real = await fetchTitle(v.id);
    if (real && real !== v.title) { store.rename(v.id, real); render(); }
  }

  /** On load, fix stored titles that are clearly wrong (e.g. "New"), one at a time. */
  async function repairTitles() {
    const { current, items, played } = store.get();
    const bad = [current, ...items, ...played].filter((v) => v && looksBadTitle(v.title, v.id));
    // One at a time, at most 50 per page load: polite to YouTube, and it can't flood
    // the network if a lot of titles somehow went bad at once.
    for (const v of bad.slice(0, 50)) await confirmTitle(v);
  }

  /* ---------- Toast ---------- */
  let toastTimer;
  function toast(msg) {
    ui.toast.textContent = msg;
    ui.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 2000);
  }

  function add(v, where) {
    if (!v) return toast('Could not tell which video that is');
    const pos = store.position(v.id);
    if (pos === 0) return toast(`Already playing from your queue: ${v.title}`);
    if (pos > 0) return toast(`Already in queue at #${pos}: ${v.title}`);
    if (store.isFull()) return toast(`Queue is full (${MAX_ITEMS}). Remove some to add more.`);
    where === 'next' ? store.playNext(v) : store.playLast(v);
    render();
    confirmTitle(v); // swap in the official title in the background
    toast(`${where === 'next' ? 'Plays next' : 'Added to end'}: ${v.title}`);
  }

  /* ---------- Way 1: items in the ⋮ menu ---------- */
  // These selectors cover YouTube's older and newer menu styles. If YouTube
  // changes its menu, this list is the ONE place to update. (Way 2 still works.)
  const MENU_SELECTORS = [
    'ytd-menu-popup-renderer tp-yt-paper-listbox',
    'ytd-menu-popup-renderer #items',
    'yt-list-view-model',
    '[role="menu"]',
    '[role="listbox"]',
  ];

  function findOpenMenu() {
    const root = document.querySelector('ytd-popup-container') || document.body;
    for (const sel of MENU_SELECTORS) {
      for (const m of root.querySelectorAll(sel)) {
        if (m.getClientRects().length) return m; // visible = currently open
      }
    }
    return null;
  }

  // Events that YouTube's menu listens to. Our items swallow them so YouTube
  // never thinks one of ITS menu entries was picked. (A click that reached YouTube's
  // menu could, for example, stop the video playing in the miniplayer.)
  const SWALLOW = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'click', 'keydown', 'tap'];

  function menuItem(iconName, label, onPick, info = false) {
    const item = el('div', info ? 'sq-item is-info' : 'sq-item');
    item.setAttribute('role', 'menuitem');
    if (info) item.setAttribute('aria-disabled', 'true');
    item.tabIndex = info ? -1 : 0;
    item.append(icon(iconName), el('span', null, label));
    const pick = () => {
      const dropdown = item.closest('tp-yt-iron-dropdown'); // find it before we remove our items
      onPick();
      document.querySelectorAll('.sq-item').forEach((n) => n.remove());
      dropdown?.close?.(); // close YouTube's menu the gentle way (no fake key presses)
    };
    for (const type of SWALLOW) {
      item.addEventListener(type, (e) => {
        e.stopPropagation();
        if (info) return; // status line only: does nothing when clicked
        if (type === 'click' || (type === 'keydown' && e.key === 'Enter')) { e.preventDefault(); pick(); }
      });
    }
    return item;
  }

  /**
   * YouTube builds the ⋮ menu a moment AFTER the click, so we watch for it on the next
   * few animation frames (up to 1 s) and add our items once it appears.
   */
  function injectWhenMenuOpens(v) {
    const started = performance.now();
    const tick = () => {
      const menu = findOpenMenu();
      if (menu) menu.prepend(...menuItemsFor(v));
      else if (performance.now() - started < 1000) {
        requestAnimationFrame(tick); // menu not open yet, check next frame (max 1s)
      }
    };
    requestAnimationFrame(tick);
  }

  /** Not queued → "Play next / Play last". Already queued → where it is + "Remove". */
  function menuItemsFor(v) {
    const pos = store.position(v.id);
    if (pos < 0) {
      return [
        menuItem('up', 'Play next', () => add(v, 'next')),
        menuItem('bottom', 'Play last', () => add(v, 'last')),
      ];
    }
    return [
      menuItem('check', pos === 0 ? 'Playing from your queue' : `Already in queue · #${pos}`, null, true),
      menuItem('close', 'Remove from queue', () => {
        const now = store.position(v.id); // re-check: another tab may have changed it
        if (now === 0) store.removeCurrent();
        else if (now > 0) store.remove(v.id);
        render();
        toast(`Removed from queue: ${v.title}`);
      }),
    ];
  }

  // Capture phase (the `true` at the end): we see the click before YouTube's own code
  // can stop it, so we always know which video's ⋮ was pressed.
  document.addEventListener('click', (e) => {
    if (e.target.closest?.('.sq-item, .sq-panel')) return;
    document.querySelectorAll('.sq-item').forEach((n) => n.remove()); // never leave stale items behind
    const button = e.target.closest?.('button, [role="button"]');
    if (!button || button.closest('a')) return; // only ⋮-style buttons, not thumbnail links
    const v = videoFromNode(button);
    if (v) injectWhenMenuOpens(v);
  }, true);

  /* ---------- Way 2: hover + Option+N / Option+L ---------- */
  let hovered = null;
  let hoverFrame = 0;
  document.addEventListener('mouseover', (e) => {
    hovered = e.target;
    if (!hoverFrame) hoverFrame = requestAnimationFrame(updatePill); // at most once per frame
  }, { capture: true, passive: true });
  // The badge is placed once; scrolling would leave it behind, so hide it.
  window.addEventListener('scroll', () => { if (ui.pill) ui.pill.hidden = true; }, { capture: true, passive: true });

  /** Show "In queue · #N" on the hovered video's card if it's queued. */
  function updatePill() {
    hoverFrame = 0;
    const t = hovered;
    const v = t?.closest && !t.closest('.sq-panel, .sq-pill') ? videoFromNode(t) : null;
    const pos = v ? (queuedPos.get(v.id) ?? -1) : -1;
    if (pos < 0) { ui.pill.hidden = true; return; }
    const r = v.box.getBoundingClientRect();
    ui.pill.replaceChildren(icon(pos === 0 ? 'play' : 'check'),
      el('span', null, pos === 0 ? 'Playing from queue' : `In queue · #${pos}`));
    ui.pill.style.left = `${Math.max(4, r.left + 8)}px`;
    ui.pill.style.top = `${Math.max(4, r.top + 8)}px`;
    ui.pill.hidden = false;
  }

  document.addEventListener('keydown', (e) => {
    if (!e.altKey || e.metaKey || e.ctrlKey) return;
    // e.code (the physical key), not e.key: on a Mac, Option changes the character
    // (Option+N types "˜", Option+P types "π"), so e.key would never say "n" or "p".
    if (e.code !== 'KeyN' && e.code !== 'KeyL' && e.code !== 'KeyP') return;
    const t = e.target;
    if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return; // don't hijack typing
    e.preventDefault();
    if (e.code === 'KeyP') { setAutoplay(store.get().paused); return; } // Option+P flips auto-play
    add(hovered && videoFromNode(hovered), e.code === 'KeyN' ? 'next' : 'last');
  }, true);

  /* ---------- Way 3: the thumbnail's own "Add to queue" hover button ---------- */
  // We catch the click on the window, in the capture phase — the very first stop
  // for any click — so YouTube never sees it, and add to OUR queue instead.
  // Hold Option while clicking to let YouTube's own queue have it.
  const NATIVE_QUEUE_BTN = '.ytThumbnailHoverOverlayToggleActionsViewModelButton button, ytd-thumbnail-overlay-toggle-button-renderer';
  const QUEUE_LABEL_RE = /^add to queue$/i; // English YouTube. Other language? Add its label here.

  function nativeQueueButton(target) {
    const b = target?.closest?.(NATIVE_QUEUE_BTN);
    if (!b) return null;
    const label = b.getAttribute('aria-label') || b.querySelector('[aria-label]')?.getAttribute('aria-label') || '';
    return QUEUE_LABEL_RE.test(label.trim()) ? b : null; // only "Add to queue", never e.g. "Watch later"
  }

  // Why swallow pointerdown/mousedown too, not just click: in case YouTube acts on the
  // press rather than the click, blocking every step means its own queue can't sneak in.
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
    window.addEventListener(type, (e) => {
      if (e.altKey) return; // Option-click → YouTube's own queue
      const b = nativeQueueButton(e.target);
      if (!b) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (type === 'click') add(videoFromNode(b), 'last');
    }, true);
  }

  /* ---------- Activity tracking (for the 💤 tag and "Still watching?") ----------
   * "Idle" = no mouse, trackpad or keyboard use from the moment a video started
   * until it ended. The little bit we need to remember between videos lives in
   * sessionStorage (this tab only), so it also survives a fallback page reload. */
  const GRACE_MS = 10000; // a click up to 10 s before a video starts (e.g. "Play now") still counts
  // sessionStorage, not the script's storage: "asleep" is about THIS tab. Another tab
  // playing quietly shouldn't count toward this tab's "Still watching?" streak.
  const session = (() => { try { return window.sessionStorage; } catch { return null; } })();
  const sGet = (k) => { try { return Number(session.getItem(k)) || 0; } catch { return 0; } };
  const sSet = (k, v) => { try { session.setItem(k, String(v)); } catch { /* blocked: fine */ } };

  let lastInputAt = sGet('sq.lastInput');
  let videoStart = { id: null, at: Date.now() };
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove']) {
    window.addEventListener(type, () => { lastInputAt = Date.now(); }, { capture: true, passive: true });
  }
  // Saved only when the page is going away (a fallback reload) — writing on every
  // mouse move would be wasteful.
  window.addEventListener('pagehide', () => sSet('sq.lastInput', lastInputAt));

  // Only videos inside YouTube's main player count — not any other <video> on the page
  // (e.g. short hover previews), which must never advance the queue.
  const isMainVideo = (t) => t instanceof HTMLVideoElement && !!t.closest('#movie_player');
  document.addEventListener('playing', (e) => {
    if (!isMainVideo(e.target)) return;
    const id = playerState().id || currentVideoId();
    if (id && id !== videoStart.id) videoStart = { id, at: Date.now() };
  }, true);

  // Idle = no input since the video started (minus a grace period). If we never saw it
  // start (the page loaded mid-video), we measure from when the page opened instead.
  const wasIdle = (id) => lastInputAt < (videoStart.id === id ? videoStart.at : performance.timeOrigin) - GRACE_MS;

  /* ---------- Auto-advance when the main video ends ---------- */
  // Media events don't bubble, so we listen in the capture phase.
  document.addEventListener('ended', (e) => {
    if (!isMainVideo(e.target)) return;
    // Ads play in the same player; YouTube marks it "ad-showing" while one runs.
    // An ad ending is not the video ending.
    if (e.target.closest('#movie_player').classList.contains('ad-showing')) return;
    if (store.get().paused) return; // auto-play is off: leave the queue alone
    const endedId = playerState().id || currentVideoId(); // works in the miniplayer too
    if (!endedId) return;
    const idle = wasIdle(endedId);
    const streak = idle ? sGet('sq.idleStreak') + 1 : 0;
    const next = store.advance(endedId, { idle });
    render();
    if (!next) { sSet('sq.idleStreak', 0); return; }
    if (STILL_WATCHING_AFTER > 0 && streak >= STILL_WATCHING_AFTER) {
      sSet('sq.idleStreak', 0);
      showPrompt(next); // stop here; the next video waits in "Now playing"
      return;
    }
    sSet('sq.idleStreak', streak);
    play(next.id);
  }, true);

  // Keep the "Now playing / Paused" label honest.
  for (const type of ['play', 'pause', 'ended']) {
    document.addEventListener(type, (e) => { if (isMainVideo(e.target)) renderStatus(); }, true);
  }
  document.addEventListener('yt-navigate-finish', () => renderStatus());

  /* ======================================================================
   * 3. QUEUE PANEL
   * ==================================================================== */

  const selected = new Set(); // ids ticked in the list (not saved; resets on reload)
  let anchorId = null;        // last ticked id, for Shift-click ranges
  let nowId = null;           // id shown in the "Now playing" card
  let queuedPos = new Map();  // id → position, refreshed on every render (fast hover lookups)
  let view = 'up';            // which tab is showing: 'up' (Up next), 'played', or 'saved'
  let renaming = null;        // saved queue whose name is being edited
  let renameDraft = '';       // what's typed so far — survives panel refreshes while typing
  let renameFresh = false;    // true right after "Rename" is clicked: select the whole name once
  let exportForm = null;      // saved queue whose "Export to YouTube" form is open
  let exportDraft = { title: '', privacy: 'PRIVATE' }; // the form's values, kept across redraws
  let exporting = null;       // { name, stop } while an export runs (one at a time)
  let deleteArmed = null;     // saved queue waiting for the second "delete" tap
  let replaceArmed = null;    // saved queue waiting for the second "replace" tap
  let overwriteArmed = null;  // name waiting for the second "save" tap (replaces the old one)
  let armTimer;
  let promptVideo = null;     // video waiting behind the "Still watching?" prompt
  const ui = {};

  function buildPanel() {
    ui.root = el('div', 'sq-theme sq-panel');

    // Floating button
    ui.fab = el('button', 'sq-fab');
    ui.fab.type = 'button';
    ui.fab.setAttribute('aria-expanded', 'false');
    ui.fabCount = el('span', 'sq-badge');
    ui.fabOff = el('span', 'sq-fab-off', 'Off');
    ui.fab.append(icon('queue'), el('span', null, 'Queue'), ui.fabOff, ui.fabCount);
    ui.fab.addEventListener('click', () => togglePanel());

    // Card
    ui.card = el('section', 'sq-card');
    ui.card.hidden = true;
    ui.card.setAttribute('aria-label', 'Play queue');
    ui.card.addEventListener('keydown', (e) => { if (e.key === 'Escape') togglePanel(false); });

    const head = el('header', 'sq-head');
    const heading = el('div');
    ui.sub = el('div', 'sq-sub');
    heading.append(el('div', 'sq-h1', 'Queue'), ui.sub);

    // Auto-play switch: On = play the next queued video when one ends. Off = wait.
    ui.auto = el('button', 'sq-switch');
    ui.auto.type = 'button';
    ui.auto.setAttribute('role', 'switch');
    ui.auto.title = 'Auto-play the queue (Option+P)';
    ui.autoText = el('span', 'sq-switch-text');
    ui.auto.append(el('span', 'sq-switch-label', 'Auto-play'), el('span', 'sq-switch-track'), ui.autoText);
    ui.auto.addEventListener('click', () => setAutoplay(store.get().paused));

    const headRight = el('div', 'sq-head-right');
    headRight.append(ui.auto, iconBtn('close', 'Close', () => togglePanel(false)));
    head.append(heading, headRight);

    // 💤 banner: shown when the last videos in history played untouched
    ui.doze = el('div', 'sq-doze');
    ui.dozeMsg = el('div', 'sq-doze-msg');
    ui.dozeBtn = el('button', 'sq-rewind-btn');
    ui.dozeBtn.type = 'button';
    ui.dozeBtn.addEventListener('click', rewindToDoze);
    const dozeX = iconBtn('close', 'Dismiss', () => {
      const s = store.sleepStart();
      // Remember WHICH doze was dismissed (its first video's end time), not just "dismissed":
      // the banner then stays hidden for this doze but comes back for the next one.
      try { storage.setItem(DOZE_SEEN_KEY, String(s?.video.at ?? 0)); } catch { /* fine */ }
      render();
    });
    const dozeTop = el('div', 'sq-doze-top');
    dozeTop.append(ui.dozeMsg, dozeX);
    ui.doze.append(dozeTop, ui.dozeBtn);

    ui.now = el('div', 'sq-now');

    // Tabs: Up next | Played | Saved
    ui.tabs = el('div', 'sq-tabs');
    ui.tabs.setAttribute('role', 'tablist');
    const tab = (name) => {
      const b = el('button', 'sq-tab');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.addEventListener('click', () => { view = name; selected.clear(); disarmClear(); render(); });
      return b;
    };
    ui.tabUp = tab('up');
    ui.tabPlayed = tab('played');
    ui.tabSaved = tab('saved');
    ui.tabs.append(ui.tabUp, ui.tabPlayed, ui.tabSaved);

    // Bulk toolbar
    ui.all = el('input', 'sq-check');
    ui.all.type = 'checkbox';
    ui.all.setAttribute('aria-label', 'Select all');
    ui.all.addEventListener('change', () => {
      if (ui.all.checked) viewList().forEach((v) => selected.add(v.id));
      else selected.clear();
      render();
    });
    ui.selLabel = el('span');
    const selectAll = el('label', 'sq-selectall');
    selectAll.append(ui.all, ui.selLabel);

    // One toolbar serves both lists. Each tab names its own store operations here,
    // so the buttons don't need to know which tab is showing. (Saved has no toolbar.)
    const LIST_OPS = {
      up: { move: store.move, moveToEdge: store.moveToEdge, remove: store.remove },
      played: { move: store.movePlayed, moveToEdge: store.movePlayedToEdge, remove: store.removePlayed },
    };
    const ops = () => LIST_OPS[view];
    ui.bulk = [
      iconBtn('top', 'Move selected to top', () => bulk((ids) => ops().moveToEdge(ids, 'top'))),
      iconBtn('up', 'Move selected up', () => bulk((ids) => ops().move(ids, -1))),
      iconBtn('down', 'Move selected down', () => bulk((ids) => ops().move(ids, 1))),
      iconBtn('bottom', 'Move selected to bottom', () => bulk((ids) => ops().moveToEdge(ids, 'bottom'))),
      iconBtn('trash', 'Remove selected', () => bulk((ids) => { ops().remove(ids); selected.clear(); }), 'sq-danger'),
    ];
    const bulkBox = el('div', 'sq-bulk');
    bulkBox.append(...ui.bulk);
    ui.tools = el('div', 'sq-tools');
    ui.tools.append(selectAll, bulkBox);

    // Saved tab: "name + Save" bar above the list of saved queues
    ui.saveName = el('input', 'sq-input');
    ui.saveName.type = 'text';
    ui.saveName.maxLength = NAME_MAX;
    ui.saveName.placeholder = 'Name, e.g. Cabin videos';
    ui.saveName.setAttribute('aria-label', 'Name for the saved queue');
    ui.saveName.addEventListener('keydown', (e) => {
      e.stopPropagation(); // typing here must not trigger YouTube's own shortcuts
      if (e.key === 'Enter') { e.preventDefault(); onSaveQueue(); }
    });
    ui.saveName.addEventListener('input', () => { if (overwriteArmed) { overwriteArmed = null; render(); } });
    ui.saveBtn = el('button', 'sq-save-btn');
    ui.saveBtn.type = 'button';
    ui.saveBtn.addEventListener('click', onSaveQueue);
    ui.savebar = el('div', 'sq-savebar');
    ui.savebar.append(ui.saveName, ui.saveBtn);

    ui.list = el('ol', 'sq-list');
    ui.empty = el('div', 'sq-empty');

    ui.clear = el('button', 'sq-text-btn sq-clear', 'Clear all');
    ui.clear.type = 'button';
    ui.clear.addEventListener('click', onClear);
    // Backup & restore: files on your computer, nothing leaves the browser.
    ui.fileInput = el('input');
    ui.fileInput.type = 'file';
    ui.fileInput.accept = 'application/json,.json';
    ui.fileInput.hidden = true;
    ui.fileInput.addEventListener('change', onImportFile);
    const backupTools = el('div', 'sq-foot-tools');
    // Words as well as icons: the download arrow looks a lot like "move to bottom".
    const labeled = (name, label, title, onClick) => {
      const b = el('button', 'sq-text-btn sq-labeled');
      b.type = 'button';
      b.title = title;
      b.setAttribute('aria-label', title);
      b.append(icon(name), el('span', null, label));
      b.addEventListener('click', onClick);
      return b;
    };
    backupTools.append(
      labeled('download', 'Backup', 'Download a backup (.json): queue, history and saved queues', downloadBackup),
      labeled('table', 'CSV', 'Download a list for spreadsheets (.csv)', downloadCsv),
      labeled('upload', 'Import', 'Import a backup (.json)', () => { ui.fileInput.value = ''; ui.fileInput.click(); }),
      ui.fileInput,
    );
    const foot = el('footer', 'sq-foot');
    foot.append(backupTools, ui.clear);

    ui.folder = el('div', 'sq-folder'); // the folder body the selected tab joins onto
    ui.folder.append(ui.tools, ui.savebar, ui.list, ui.empty);
    ui.card.append(head, ui.doze, ui.now, ui.tabs, ui.folder, foot, ...buildGrips());
    ui.root.append(ui.card, ui.fab);

    ui.pill = el('div', 'sq-theme sq-pill');
    ui.pill.hidden = true;
    ui.pill.setAttribute('aria-hidden', 'true');

    ui.toast = el('div', 'sq-theme sq-toast');
    ui.toast.hidden = true;
    ui.toast.setAttribute('role', 'status');

    // "Still watching?" prompt
    // Import dialog: what's in the file, then Merge / Replace / Cancel
    ui.importBox = el('div', 'sq-theme sq-prompt sq-import');
    ui.importBox.hidden = true;
    ui.importBox.setAttribute('role', 'dialog');
    ui.importBox.setAttribute('aria-label', 'Import a backup');
    ui.importBox.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideImport(); });
    ui.importInfo = el('p', 'sq-prompt-p');
    ui.importCounts = el('div', 'sq-import-counts');
    ui.importMerge = el('button', 'sq-big-btn is-primary', 'Merge');
    ui.importMerge.type = 'button';
    ui.importMerge.title = 'Add what you don\'t have yet; keep everything you have';
    ui.importMerge.addEventListener('click', () => doImport('merge'));
    ui.importReplace = el('button', 'sq-big-btn');
    ui.importReplace.type = 'button';
    ui.importReplace.title = 'Your queue, history and saved queues become the backup\'s';
    ui.importReplace.addEventListener('click', () => doImport('replace'));
    const importCancel = el('button', 'sq-big-btn', 'Cancel');
    importCancel.type = 'button';
    importCancel.addEventListener('click', hideImport);
    const importBtns = el('div', 'sq-prompt-btns');
    importBtns.append(importCancel, ui.importReplace, ui.importMerge);
    ui.importHelp = el('p', 'sq-prompt-p');
    ui.importBox.append(
      el('div', 'sq-prompt-h', 'Import a backup'),
      ui.importInfo,
      ui.importCounts,
      ui.importHelp,
      importBtns,
    );

    ui.prompt = el('div', 'sq-theme sq-prompt');
    ui.prompt.hidden = true;
    ui.prompt.setAttribute('role', 'dialog');
    ui.prompt.setAttribute('aria-label', 'Still watching?');
    ui.promptBack = el('button', 'sq-rewind-btn');
    ui.promptBack.type = 'button';
    ui.promptBack.addEventListener('click', rewindToDoze);
    const go = el('button', 'sq-big-btn', 'Keep going');
    go.type = 'button';
    go.addEventListener('click', () => { const v = promptVideo; hidePrompt(); if (v) play(v.id); });
    const stop = el('button', 'sq-big-btn', 'Stop for now');
    stop.type = 'button';
    stop.addEventListener('click', hidePrompt);
    const btns = el('div', 'sq-prompt-btns');
    btns.append(stop, go);
    ui.prompt.append(
      el('div', 'sq-prompt-h', 'Still watching?'),
      el('p', 'sq-prompt-p', `Paused after ${STILL_WATCHING_AFTER} videos in a row with no mouse or keyboard use.`),
      ui.promptBack,
      btns,
    );
  }

  /** Big "Back to where I dozed off" button content: label + the video's title. */
  function rewindContent(start) {
    const text = el('span', 'sq-rewind-text');
    text.append(el('b', null, 'Back to where I dozed off'), el('span', 'sq-rewind-title', start.video.title));
    return [icon('replay'), text];
  }

  /* ---------- Backup & restore ---------- */

  /** Save text as a file in the browser's Downloads (no permission needed). */
  function saveFile(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = el('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000); // give the download time to start
  }

  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  function downloadBackup() {
    const b = store.exportBackup();
    saveFile(`youtube-queue-backup-${today()}.json`, JSON.stringify(b, null, 2), 'application/json');
    toast(`Backup downloaded: ${plural(b.queue.items.length + (b.queue.current ? 1 : 0))} up next, ${b.saved.length} saved queues`);
  }

  function downloadCsv() {
    saveFile(`youtube-queue-${today()}.csv`, backupToCsv(store.exportBackup()), 'text/csv');
    toast('List downloaded (.csv): opens in Numbers, Excel or Google Sheets');
  }

  const MAX_IMPORT_BYTES = 20 * 1024 * 1024; // far above any real backup; stops a wrong huge file freezing the page
  let pendingImport = null; // the parsed backup waiting for Merge / Replace

  async function onImportFile() {
    const file = ui.fileInput.files?.[0];
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) { toast('That file is too big to be a queue backup.'); return; }
    let data;
    try { data = JSON.parse(await file.text()); } catch { toast("That file isn't a queue backup (not readable)."); return; }
    const check = store.inspectBackup(data);
    if (!check.ok) {
      toast(check.reason === 'newer'
        ? 'That backup is from a newer version of the script. Update the script, then import it.'
        : "That file isn't a queue backup from this script.");
      return;
    }
    pendingImport = data;
    showImport(file.name, check);
  }

  function showImport(fileName, check) {
    const c = check.counts;
    const when = check.exportedAt
      ? new Date(check.exportedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
      : 'unknown date';
    ui.importInfo.textContent = `${fileName} · ${when}`;
    const queues = `${c.saved} saved ${c.saved === 1 ? 'queue' : 'queues'}`;
    if (check.savedOnly) {
      const names = check.saved.slice(0, 4).map((q) => q.name).join(', ');
      ui.importCounts.textContent = `${queues}: ${names}${check.saved.length > 4 ? ', …' : ''}`;
      ui.importHelp.textContent = 'These are added to your Saved tab. Your queue and history stay as they are.';
      ui.importMerge.textContent = 'Add saved queues';
    } else {
      ui.importCounts.textContent = `${plural(c.upNext)} up next · ${c.played} played · ${queues}`;
      ui.importHelp.textContent = 'Merge adds what you don\'t have yet. Replace all makes everything match the backup.';
      ui.importMerge.textContent = 'Merge';
    }
    ui.importReplace.hidden = check.savedOnly;
    ui.importReplace.textContent = 'Replace all';
    ui.importReplace.classList.remove('is-armed');
    ui.importBox.hidden = false;
    ui.importMerge.focus();
  }

  function hideImport() {
    pendingImport = null;
    ui.importBox.hidden = true;
  }

  function doImport(mode) {
    // Replace wipes what you have, so it takes two clicks.
    if (mode === 'replace' && !ui.importReplace.classList.contains('is-armed')) {
      ui.importReplace.classList.add('is-armed');
      ui.importReplace.textContent = 'Click again to replace';
      return;
    }
    const r = store.importBackup(pendingImport, mode);
    hideImport();
    selected.clear();
    render();
    if (!r.ok) { toast("That backup couldn't be read."); return; }
    if (mode === 'replace') {
      toast(`Restored: ${plural(r.upNext)} up next, ${r.played} played, ${r.saved} saved queues`);
      return;
    }
    if (r.savedOnly) {
      view = 'saved'; // show what just arrived
      render();
      const n = r.savedAdded + r.savedRenamed;
      toast(!n ? 'Those saved queues are already in your Saved tab.'
        : `Added ${n} saved ${n === 1 ? 'queue' : 'queues'}${r.savedRenamed ? ` · ${r.savedRenamed} saved as "(imported)"` : ''}`);
      return;
    }
    const parts = [`Added ${plural(r.added)}`];
    if (r.already) parts.push(`${r.already} already queued`);
    if (r.skipped) parts.push(`${r.skipped} didn't fit (queue full)`);
    if (r.playedAdded) parts.push(`${r.playedAdded} to history`);
    if (r.savedAdded) parts.push(`${r.savedAdded} saved queues`);
    if (r.savedRenamed) parts.push(`${r.savedRenamed} saved as "(imported)"`);
    toast(parts.join(' · '));
  }

  function showPrompt(v) {
    promptVideo = v;
    const start = store.sleepStart();
    ui.promptBack.hidden = !start;
    if (start) ui.promptBack.replaceChildren(...rewindContent(start));
    ui.prompt.hidden = false;
    (start ? ui.promptBack : ui.prompt.querySelector('.sq-big-btn:last-child')).focus();
  }
  function hidePrompt() {
    promptVideo = null;
    ui.prompt.hidden = true;
  }

  /* ---------- Resizing ----------
   * The panel is pinned to the bottom-left, so it grows up and to the right.
   * Grab points: top edge (height), right edge (width), top-right corner (both).
   * The corner can also be focused with Tab and resized with the arrow keys. */
  const MIN_W = 340;
  const MIN_H = 320;
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  function clampSize({ w, h }) {
    const maxW = Math.max(MIN_W, window.innerWidth - 32);
    const maxH = Math.max(MIN_H, window.innerHeight - 100); // leave room for the Queue button below
    return { w: Math.round(clamp(w, MIN_W, maxW)), h: Math.round(clamp(h, MIN_H, maxH)) };
  }

  function applySize(size) {
    const c = ui.card.style;
    if (!size) { c.width = c.height = c.maxHeight = ''; return; }
    const { w, h } = clampSize(size);
    c.width = `${w}px`;
    c.height = `${h}px`;
    c.maxHeight = 'none';
  }

  function savedSize() {
    try {
      const v = JSON.parse(storage.getItem(SIZE_KEY));
      return v && Number.isFinite(v.w) && Number.isFinite(v.h) ? v : null;
    } catch { return null; }
  }

  function saveSize(size) {
    try { size ? storage.setItem(SIZE_KEY, JSON.stringify(size)) : storage.removeItem(SIZE_KEY); } catch { /* fine */ }
  }

  function currentSize() {
    const r = ui.card.getBoundingClientRect();
    return { w: r.width, h: r.height };
  }

  function resetSize() {
    saveSize(null);
    applySize(null);
    toast('Panel size reset');
  }

  function buildGrips() {
    return ['n', 'e', 'ne'].map((dir) => {
      const g = el('div', `sq-grip sq-grip-${dir}`);
      g.title = 'Drag to resize · double-click to reset';
      g.addEventListener('dblclick', resetSize);
      g.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        g.setPointerCapture?.(e.pointerId);
        const start = { x: e.clientX, y: e.clientY, ...currentSize() };
        let last = null;
        const move = (ev) => {
          last = clampSize({
            w: dir.includes('e') ? start.w + (ev.clientX - start.x) : start.w,
            h: dir.includes('n') ? start.h - (ev.clientY - start.y) : start.h,
          });
          applySize(last);
        };
        const end = () => {
          g.removeEventListener('pointermove', move);
          g.removeEventListener('pointerup', end);
          g.removeEventListener('pointercancel', end);
          document.documentElement.classList.remove('sq-resizing');
          if (last) saveSize(last);
        };
        document.documentElement.classList.add('sq-resizing');
        g.addEventListener('pointermove', move);
        g.addEventListener('pointerup', end);
        g.addEventListener('pointercancel', end);
      });
      if (dir === 'ne') {
        g.tabIndex = 0;
        g.setAttribute('role', 'button');
        g.setAttribute('aria-label', 'Resize panel. Arrow keys change the size; Enter resets it.');
        g.addEventListener('keydown', (e) => {
          const step = e.shiftKey ? 60 : 20;
          const d = { ArrowRight: [step, 0], ArrowLeft: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
          if (e.key === 'Enter') { e.preventDefault(); resetSize(); return; }
          if (!d) return;
          e.preventDefault();
          const cur = currentSize();
          const next = clampSize({ w: cur.w + d[0], h: cur.h + d[1] });
          applySize(next);
          saveSize(next);
        });
      }
      return g;
    });
  }

  // Keep a saved size inside the window when the window gets smaller.
  window.addEventListener('resize', () => { const s = savedSize(); if (s) applySize(s); });

  function togglePanel(open = ui.card.hidden) {
    ui.card.hidden = !open;
    ui.fab.setAttribute('aria-expanded', String(open));
    if (open) render();
  }

  function bulk(fn) {
    const ids = [...selected];
    if (!ids.length) return;
    fn(ids);
    render();
  }

  // "Clear all" needs two taps within 3 seconds, so one slip can't wipe the queue.
  let clearTimer;
  const clearLabel = () => (view === 'played' ? 'Clear history' : 'Clear all');
  const EMPTY_TEXT = {
    up: 'Nothing up next. Use ⋮ → Play next / Play last, or hover a video and press Option+N / Option+L.',
    played: 'Nothing played yet. Finished queue videos show up here.',
    saved: 'No saved queues yet. Type a name above and click Save to keep a copy of your queue.',
  };
  function disarmClear() {
    clearTimeout(clearTimer);
    ui.clear.classList.remove('is-armed');
    ui.clear.textContent = clearLabel();
  }
  function onClear() {
    if (!ui.clear.classList.contains('is-armed')) {
      clearTimeout(clearTimer);
      ui.clear.classList.add('is-armed');
      ui.clear.textContent = 'Tap again to clear';
      clearTimer = setTimeout(disarmClear, 3000);
      return;
    }
    disarmClear();
    view === 'played' ? store.clearHistory() : store.clear();
    selected.clear();
    render();
  }

  /** Turn auto-play on (true) or off (false). */
  function setAutoplay(on) {
    store.setPaused(!on);
    if (!on) hidePrompt();
    render();
    toast(on ? 'Auto-play On: the queue plays when a video ends' : 'Auto-play Off: watch anything, the queue will wait');
  }

  /* ---------- Saved queues ---------- */
  function armTwoTap(set) {
    clearTimeout(armTimer);
    set();
    armTimer = setTimeout(() => { deleteArmed = replaceArmed = overwriteArmed = null; render(); }, 3500);
    render();
  }

  function onSaveQueue() {
    const name = ui.saveName.value.replace(/\s+/g, ' ').trim();
    const overwrite = !!overwriteArmed && overwriteArmed.toLowerCase() === name.toLowerCase();
    if (exporting && exporting.name.toLowerCase() === name.toLowerCase()) {
      toast(`"${exporting.name}" is being exported. Pause the export first.`);
      return;
    }
    const r = store.saveAs(name, { overwrite });
    if (!r.ok) {
      if (r.reason === 'noname') { toast('Type a name first'); ui.saveName.focus(); return; }
      if (r.reason === 'empty') { toast('The queue is empty: nothing to save'); return; }
      armTwoTap(() => { overwriteArmed = name; });
      toast(`"${name}" already exists. Click Save again to replace it.`);
      return;
    }
    overwriteArmed = null;
    ui.saveName.value = '';
    render();
    toast(`Saved "${name}" (${r.count} ${r.count === 1 ? 'video' : 'videos'})`);
  }

  const plural = (n) => `${n} ${n === 1 ? 'video' : 'videos'}`;

  function loadSaved(q, mode) {
    const { current, items } = store.get();
    if (mode === 'replace' && (current || items.length) && replaceArmed !== q.name) {
      armTwoTap(() => { replaceArmed = q.name; deleteArmed = null; });
      toast('This replaces your current queue. Click Replace again to confirm.');
      return;
    }
    replaceArmed = null;
    const r = store.loadSaved(q.name, mode);
    if (!r.ok) { toast('That saved queue is gone'); render(); return; }
    const extra = [r.already && `${r.already} already queued`, r.skipped && `${r.skipped} didn't fit (queue full)`]
      .filter(Boolean).join(' · ');
    const what = mode === 'replace' ? `Queue replaced with "${q.name}" (${plural(r.added)})`
      : `Added ${plural(r.added)} from "${q.name}" to the ${mode === 'front' ? 'front' : 'end'}`;
    view = 'up';
    render();
    toast(extra ? `${what} · ${extra}` : what);
  }

  function commitRename(q, input) {
    if (renaming !== q.name) return;
    const r = store.renameSaved(q.name, input.value);
    if (!r.ok && r.reason === 'exists') { toast(`There's already a saved queue called "${input.value.trim()}"`); input.focus(); return; }
    renaming = null;
    render();
  }

  /* ---------- Export a saved queue to a YouTube playlist ---------- */
  const PRIVACY_LABEL = { PRIVATE: 'Private', UNLISTED: 'Unlisted', PUBLIC: 'Public' };
  const playlistUrl = (id) => `https://www.youtube.com/playlist?list=${id}`; // id was validated
  const minutes = (videos) => Math.max(1, Math.round((videos * EXPORT_DELAY_MS) / 60000));

  function openExportForm(q) {
    if (exporting && exporting.name !== q.name) { toast('One export at a time: wait for it to finish, or pause it.'); return; }
    exportForm = q.name;
    exportDraft = { title: q.name, privacy: 'PRIVATE' };
    deleteArmed = replaceArmed = null;
    render();
  }

  /**
   * Start an export. fresh = true (the form): always a NEW playlist.
   * fresh = false (Resume / Try again): continue the playlist in q.exp if there is one.
   */
  async function startExport(q, { title, privacy, fresh }) {
    if (exporting) { toast('One export at a time: wait for it to finish, or pause it.'); return; }
    const blocker = exportBlocker();
    if (blocker) { toast(blocker); return; }
    const resume = !fresh && q.exp && q.exp.status !== 'done' && q.exp.playlistId ? q.exp : null;
    const job = { name: q.name, stop: false };
    exporting = job;
    exportForm = null;
    store.setExport(q.name, { ...(resume || { playlistId: null, next: 0, added: 0, skipped: [] }), status: 'running', error: '', title, privacy });
    render();
    const result = await runExport({
      videoIds: q.items.map((v) => v.id),
      title,
      privacy,
      progress: resume,
      api: youtubeApi,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      onProgress: (p) => { store.setExport(job.name, p); render(); },
      shouldStop: () => job.stop,
    });
    exporting = null;
    render();
    if (result.status === 'done') {
      const extra = result.skipped.length ? ` · ${result.skipped.length} unavailable skipped` : '';
      toast(`Playlist ready: "${title}" (${plural(result.added)})${extra}`);
    } else if (result.status === 'paused') toast('Export paused. Resume any time.');
    else toast(result.error);
  }

  /** The export area under a saved queue: form, progress, or result. */
  function exportArea(q) {
    const box = el('div', 'sq-export');
    const total = q.items.length;
    const active = exporting?.name === q.name;

    if (exportForm === q.name && !active) {
      const title = el('input', 'sq-input');
      title.type = 'text';
      title.maxLength = 150;
      title.value = exportDraft.title;
      title.setAttribute('aria-label', 'Playlist title');
      title.addEventListener('input', () => { exportDraft.title = title.value; });
      title.addEventListener('keydown', (e) => e.stopPropagation()); // typing must not trigger YouTube shortcuts

      const privacy = el('select', 'sq-select');
      privacy.setAttribute('aria-label', 'Playlist privacy');
      for (const v of PRIVACY) {
        const opt = el('option', null, PRIVACY_LABEL[v]);
        opt.value = v;
        opt.selected = v === exportDraft.privacy;
        privacy.append(opt);
      }
      privacy.addEventListener('change', () => { exportDraft.privacy = privacy.value; });

      const go = el('button', 'sq-save-btn');
      go.type = 'button';
      go.append(icon('playlistAdd'), el('span', null, 'Create playlist'));
      go.addEventListener('click', () => {
        const t = exportDraft.title.replace(/\s+/g, ' ').trim();
        if (!t) { toast('Give the playlist a title first'); title.focus(); return; }
        startExport(q, { title: t, privacy: exportDraft.privacy, fresh: true });
      });
      const cancel = el('button', 'sq-load-btn', 'Cancel');
      cancel.type = 'button';
      cancel.addEventListener('click', () => { exportForm = null; render(); });

      const row1 = el('div', 'sq-export-row');
      row1.append(title, privacy);
      const row2 = el('div', 'sq-export-row');
      row2.append(cancel, go);
      box.append(
        el('div', 'sq-export-h', 'Export to a YouTube playlist'),
        row1,
        el('div', 'sq-meta', `Adds ${plural(total)} to a new playlist on your signed-in YouTube account, one at a time (about ${minutes(total)} min).`),
        row2,
      );
      return box;
    }

    const e = q.exp;
    if (!e) return null;
    const done = e.added + e.skipped.length;
    const shown = active ? 'running' : e.status === 'running' ? 'paused' : e.status; // a reload stops a run
    const bar = el('div', 'sq-progress');
    const fill = el('div', 'sq-progress-fill');
    fill.style.width = `${Math.round((100 * Math.min(done, total)) / Math.max(1, total))}%`;
    bar.append(fill);

    const skipped = e.skipped.length ? ` · ${e.skipped.length} unavailable skipped` : '';
    const text = {
      running: `Adding ${Math.min(done + 1, total)} of ${total}…${skipped}`,
      paused: `Paused at ${done} of ${total}${skipped}`,
      error: e.error || 'The export stopped.',
      done: `✓ Exported ${e.added} of ${total} to "${e.title}" (${PRIVACY_LABEL[e.privacy]})${skipped}`,
    }[shown];
    box.classList.add(`is-${shown}`);

    const actions = el('div', 'sq-export-row');
    const button = (label, onClick, cls = 'sq-load-btn') => {
      const b = el('button', cls, label);
      b.type = 'button';
      b.addEventListener('click', onClick);
      return b;
    };
    if (shown === 'running') actions.append(button('Pause', () => { exporting.stop = true; toast('Pausing after this video…'); }));
    if (shown === 'paused' || shown === 'error') {
      actions.append(button(e.playlistId ? 'Resume' : 'Try again', () => startExport(q, { title: e.title || q.name, privacy: e.privacy, fresh: false })));
    }
    if (e.playlistId) {
      const a = el('a', 'sq-load-btn sq-open');
      a.href = playlistUrl(e.playlistId);
      a.target = '_blank';
      a.rel = 'noopener';
      a.append(icon('open'), el('span', null, 'Open playlist'));
      actions.append(a);
    }
    if (!active) {
      // Forget = hide this progress. The playlist (if any) stays on YouTube.
      actions.append(iconBtn('close', e.playlistId ? 'Hide (the playlist stays on YouTube)' : 'Hide', () => {
        store.setExport(q.name, null);
        render();
      }));
    }
    box.append(el('div', 'sq-export-text', text), ...(shown === 'done' ? [] : [bar]), actions);
    return box;
  }

  function savedRow(q) {
    const li = el('li', 'sq-row sq-saved');
    const body = el('div', 'sq-row-body');
    if (renaming === q.name) {
      const input = el('input', 'sq-input');
      input.type = 'text';
      input.maxLength = NAME_MAX;
      // Why the draft: the panel redraws whenever the queue changes (e.g. a video
      // ends while you're typing). That rebuilds this box, so we refill it with
      // what you'd typed instead of the old name.
      input.value = renameDraft;
      input.setAttribute('aria-label', 'New name');
      input.addEventListener('input', () => { renameDraft = input.value; });
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); commitRename(q, input); }
        if (e.key === 'Escape') { e.preventDefault(); renaming = null; render(); }
      });
      // A redraw removes this box; only a real blur (you clicked away) should save.
      input.addEventListener('blur', () => { if (input.isConnected) commitRename(q, input); });
      body.append(input);
      requestAnimationFrame(() => {
        input.focus();
        // Select the whole name only when the box first opens (easy to type over).
        // After a redraw, put the cursor at the end so your next key doesn't erase it.
        if (renameFresh) { input.select(); renameFresh = false; }
        else input.setSelectionRange(input.value.length, input.value.length);
      });
    } else {
      const day = q.at ? new Date(q.at).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
      body.append(el('div', 'sq-saved-name', q.name), el('div', 'sq-meta', `${plural(q.items.length)}${day ? ` · saved ${day}` : ''}`));
    }

    const busy = exporting?.name === q.name;
    const del = iconBtn('trash', deleteArmed === q.name ? 'Click again to delete' : 'Delete', () => {
      if (busy) { toast('Pause the export before deleting this queue.'); return; }
      if (deleteArmed !== q.name) {
        armTwoTap(() => { deleteArmed = q.name; replaceArmed = null; });
        toast(`Click the trash again to delete "${q.name}"`);
        return;
      }
      deleteArmed = null;
      store.deleteSaved(q.name);
      render();
      toast(`Deleted "${q.name}"`);
    }, deleteArmed === q.name ? 'sq-danger is-armed' : 'sq-danger');
    const ren = iconBtn('edit', 'Rename', () => {
      if (busy) { toast('Pause the export before renaming this queue.'); return; }
      renaming = q.name;
      renameDraft = q.name;
      renameFresh = true;
      deleteArmed = replaceArmed = null;
      render();
    });

    const loads = el('div', 'sq-load');
    const loadBtn = (label, mode, armed) => {
      const b = el('button', `sq-load-btn${armed ? ' is-armed' : ''}`, armed ? 'Click again' : label);
      b.type = 'button';
      b.addEventListener('click', () => loadSaved(q, mode));
      return b;
    };
    loads.append(
      loadBtn('Replace', 'replace', replaceArmed === q.name),
      loadBtn('+ Front', 'front'),
      loadBtn('+ End', 'end'),
    );
    const exp = iconBtn('playlistAdd', 'Export to a YouTube playlist', () => openExportForm(q));
    const area = exportArea(q);
    li.append(body, exp, ren, del, loads, ...(area ? [area] : []));
    return li;
  }

  function playNow(id) {
    const v = store.start(id);
    if (!v) return;
    render(); // videos switch in place (no page reload), so refresh the panel ourselves
    play(v.id);
  }

  function replayFrom(id) {
    const r = store.replayFrom(id);
    if (!r.ok) {
      return toast(r.reason === 'full' ? `Queue is full (${MAX_ITEMS}). Remove some first.` : 'That video is no longer in history');
    }
    view = 'up';
    hidePrompt();
    render();
    play(r.video.id);
  }

  /**
   * A video title that acts like a button (plays / resumes) but stays a real link.
   * Why a real link: Cmd-click, Ctrl-click and middle-click still open the video
   * in a new tab, and right-click → "Copy link" works.
   */
  function titleLink(v, onActivate) {
    const a = el('a', 'sq-title', v.title);
    a.href = `/watch?v=${v.id}`;
    a.title = v.title; // full title on hover, since long ones get cut off
    a.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // let the browser open a new tab
      e.preventDefault();
      onActivate();
    });
    return a;
  }

  /** "Back to where I dozed off": replay from the first video of the latest 💤 run. */
  function rewindToDoze() {
    const start = store.sleepStart();
    if (start) replayFrom(start.video.id);
  }

  /** "1:42 AM" today, "Tue 1:42 AM" otherwise. */
  function when(at) {
    if (!at) return '';
    const d = new Date(at);
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString()
      ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  }

  /** The list the current tab shows, in on-screen order. */
  function viewList(state = store.get()) {
    if (view === 'played') return state.played.slice().reverse(); // newest first
    if (view === 'up') return state.items;
    return [];
  }

  /** Tick-box for row i of list (Shift-click ticks the whole range from the last one). */
  function rowCheckbox(v, i, list) {
    const cb = el('input', 'sq-check');
    cb.type = 'checkbox';
    cb.checked = selected.has(v.id);
    cb.setAttribute('aria-label', `Select ${v.title}`);
    cb.addEventListener('click', (e) => {
      const on = cb.checked;
      const a = e.shiftKey && anchorId ? list.findIndex((x) => x.id === anchorId) : -1;
      const [lo, hi] = a < 0 ? [i, i] : [Math.min(a, i), Math.max(a, i)];
      for (let k = lo; k <= hi; k++) on ? selected.add(list[k].id) : selected.delete(list[k].id);
      anchorId = v.id;
      render();
    });
    return cb;
  }

  function playedRow(v, i, list) {
    const cls = ['sq-row', 'sq-played', v.idle && 'is-idle', selected.has(v.id) && 'is-selected'].filter(Boolean).join(' ');
    const li = el('li', cls);

    const title = titleLink(v, () => replayFrom(v.id));
    const meta = el('div', 'sq-meta', `${v.idle ? '💤 No activity · ' : ''}Ended ${when(v.at)}`);

    const again = el('button', 'sq-from-btn');
    again.type = 'button';
    again.title = 'Put this and everything after it back in line, and play it';
    again.append(icon('replay'), el('span', null, 'Play from here'));
    again.addEventListener('click', () => replayFrom(v.id));

    // "Play from here" sits under the title, so long titles keep their room
    const body = el('div', 'sq-row-body');
    body.append(title, meta, again);

    const remove = iconBtn('close', 'Remove from history', () => {
      store.removePlayed(v.id);
      selected.delete(v.id);
      render();
    });
    const actions = el('div', 'sq-actions');
    actions.append(remove);

    li.append(rowCheckbox(v, i, list), thumb(v.id), body, actions);
    return li;
  }

  function resume(id) {
    const video = document.querySelector('#movie_player video');
    if (currentVideoId() === id && video) video.play(); // already on its page: just unpause
    else play(id);
  }

  function renderNow(current) {
    nowId = current?.id || null;
    ui.now.hidden = !current;
    if (!current) { ui.now.replaceChildren(); return; }

    const eq = el('span', 'sq-eq');
    eq.append(el('i'), el('i'), el('i'));
    ui.nowState = el('span');
    const label = el('div', 'sq-now-label');
    label.append(eq, ui.nowState);

    const title = titleLink(current, () => resume(current.id));

    const body = el('div', 'sq-now-body');
    body.append(label, title);
    ui.now.replaceChildren(
      thumb(current.id),
      body,
      iconBtn('play', 'Resume', () => resume(current.id)),
      iconBtn('close', 'Remove from queue', () => { store.removeCurrent(); render(); }),
    );
    renderStatus();
  }

  function renderDoze(state) {
    const start = sleepStartIn(state);
    let seen = 0;
    try { seen = Number(storage.getItem(DOZE_SEEN_KEY)) || 0; } catch { /* fine */ }
    ui.doze.hidden = !start || start.video.at === seen;
    if (ui.doze.hidden) return;
    const n = start.count;
    ui.dozeMsg.textContent = `💤 Dozed off? ${n === 1 ? '1 video' : `${n} videos`} played with no activity.`;
    ui.dozeBtn.replaceChildren(...rewindContent(start));
  }

  /** Cheap update of just the "Now playing / Paused / Up now" label. */
  function renderStatus() {
    if (!nowId || !ui.nowState) return;
    const st = playerState();
    const here = st.id === nowId;
    ui.now.classList.toggle('is-playing', here && st.playing);
    ui.nowState.textContent = here ? (st.playing ? 'Now playing' : 'Paused')
      : (store.get().paused ? 'Up now · auto-play off' : 'Up now');
  }

  function row(v, i, items) {
    const isSel = selected.has(v.id);
    const li = el('li', isSel ? 'sq-row is-selected' : 'sq-row');

    const cb = rowCheckbox(v, i, items);

    const title = titleLink(v, () => playNow(v.id));

    const actions = el('div', 'sq-actions');
    actions.append(
      iconBtn('play', 'Play now', () => playNow(v.id)),
      iconBtn('close', 'Remove', () => { store.remove(v.id); selected.delete(v.id); render(); }),
    );

    li.append(cb, el('span', 'sq-num', String(i + 1)), thumb(v.id), title, actions);
    return li;
  }

  function render() {
    const state = store.get();
    const { current, items, played, paused } = state;
    const saved = store.listSaved();
    queuedPos = new Map([...(current ? [[current.id, 0]] : []), ...items.map((v, i) => [v.id, i + 1])]);
    if (!ui.pill.hidden) updatePill();
    // The Queue button is always visible, so it's always kept up to date.
    const total = items.length + (current ? 1 : 0);
    ui.root.hidden = total === 0 && played.length === 0 && saved.length === 0; // keep history/saved reachable
    ui.fabCount.textContent = String(total);
    ui.fab.classList.toggle('is-off', paused);
    ui.fabOff.hidden = !paused;
    ui.fab.title = paused ? 'Queue (auto-play off)' : 'Queue';

    // Why stop here when the panel is closed: the queue changes often while nobody is
    // looking (a video ends, a title gets fixed, another tab edits the queue), and
    // rebuilding up to 500 hidden rows each time is wasted work. Opening the panel
    // calls render() again, so it's always fresh when you see it.
    if (ui.card.hidden) return;

    const list = viewList(state);
    const present = new Set(list.map((v) => v.id));
    for (const id of selected) if (!present.has(id)) selected.delete(id);

    ui.sub.textContent = paused ? `${items.length} up next · waiting` : `${items.length} up next`;
    ui.auto.setAttribute('aria-checked', String(!paused));
    ui.autoText.textContent = paused ? 'Off' : 'On';

    renderNow(current);
    renderDoze(state);

    ui.tabUp.textContent = `Up next · ${items.length}`;
    ui.tabPlayed.textContent = `Played · ${played.length}`;
    ui.tabSaved.textContent = `Saved · ${saved.length}`;
    ui.tabUp.setAttribute('aria-selected', String(view === 'up'));
    ui.tabPlayed.setAttribute('aria-selected', String(view === 'played'));
    ui.tabSaved.setAttribute('aria-selected', String(view === 'saved'));
    if (!ui.clear.classList.contains('is-armed')) ui.clear.textContent = clearLabel();
    ui.empty.textContent = EMPTY_TEXT[view];
    ui.savebar.hidden = view !== 'saved';
    ui.clear.hidden = view === 'saved' || (view === 'played' ? !played.length : !total);

    if (view === 'saved') {
      ui.saveBtn.replaceChildren(icon('save'), el('span', null, overwriteArmed ? 'Replace it' : 'Save'));
      ui.saveBtn.classList.toggle('is-armed', !!overwriteArmed);
      ui.saveBtn.title = total ? 'Save the current queue under this name' : 'The queue is empty';
      ui.list.replaceChildren(...saved.map(savedRow));
      ui.empty.hidden = saved.length > 0;
      ui.tools.hidden = true;
      return;
    }
    ui.list.replaceChildren(...list.map((v, i) => (view === 'played' ? playedRow : row)(v, i, list)));
    ui.empty.hidden = list.length > 0;
    ui.tools.hidden = list.length === 0;

    const n = selected.size;
    ui.all.checked = n > 0 && n === list.length;
    ui.all.indeterminate = n > 0 && n < list.length;
    ui.selLabel.textContent = n ? `${n} selected` : 'Select all';
    ui.bulk.forEach((b) => { b.disabled = n === 0; });
  }

  /* ---------- Styles: soft "neumorphic" look, follows YouTube light/dark ---------- */
  const CSS = `
    .sq-theme {
      --sq-bg: #e7ebf3; --sq-hi: #ffffff; --sq-lo: #c3c9d6;
      --sq-text: #1d2230; --sq-muted: #687086;
      --sq-a1: #7b5cff; --sq-a2: #ff5c8a;
      --sq-front: #ffffff; --sq-back: #d3d8e3; /* folder tabs: selected (front) / other (behind) */
      --sq-grad: linear-gradient(135deg, var(--sq-a1), var(--sq-a2));
      --sq-raised: 6px 6px 14px var(--sq-lo), -6px -6px 14px var(--sq-hi);
      --sq-raised-sm: 3px 3px 7px var(--sq-lo), -3px -3px 7px var(--sq-hi);
      --sq-inset: inset 3px 3px 6px var(--sq-lo), inset -3px -3px 6px var(--sq-hi);
      color: var(--sq-text);
      font-family: Roboto, Arial, sans-serif; font-size: ${TEXT_SIZE}px; line-height: 1.4;
    }
    html[dark] .sq-theme {
      --sq-bg: #252932; --sq-hi: #30353f; --sq-lo: #1a1d24;
      --sq-text: #e9ebf2; --sq-muted: #9ba2b4;
      --sq-front: #323743; --sq-back: #1c1f26;
    }
    .sq-theme, .sq-theme * { box-sizing: border-box; }
    .sq-theme[hidden], .sq-theme [hidden] { display: none !important; }

    /* A high z-index keeps the panel, toast and prompt above YouTube's page, including
       the miniplayer. The exact number isn't magic: if YouTube ever covers the panel,
       raise these values. */
    .sq-panel { position: fixed; left: 16px; bottom: 16px; z-index: 2100;
                display: flex; flex-direction: column; align-items: flex-start; gap: 14px; }

    .sq-fab { display: inline-flex; align-items: center; gap: 8px; height: 44px; padding: 0 8px 0 16px;
              border: 0; border-radius: 22px; cursor: pointer; color: #fff; background: var(--sq-grad);
              box-shadow: 0 8px 20px rgba(123, 92, 255, .35);
              font-family: inherit; font-size: 1em; font-weight: 600; transition: transform .1s, filter .15s; }
    .sq-fab:hover { filter: brightness(1.08); }
    .sq-fab:active { transform: scale(.97); }
    .sq-fab svg { width: 20px; height: 20px; fill: currentColor; }
    .sq-fab.is-off { background: #6b7280; box-shadow: 0 8px 20px rgba(0, 0, 0, .25); }
    .sq-fab-off { padding: 2px 8px; border-radius: 8px; background: rgba(255, 255, 255, .22);
                  font-size: .8125em; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; }
    .sq-badge { min-width: 26px; height: 26px; padding: 0 8px; border-radius: 13px; display: grid; place-items: center;
                background: rgba(255, 255, 255, .25); font-size: .875em; font-weight: 700; }

    .sq-card { width: min(460px, calc(100vw - 32px)); max-height: min(72vh, 680px);
               display: flex; flex-direction: column; padding: 18px; border-radius: 26px;
               background: var(--sq-bg); box-shadow: var(--sq-raised), 0 24px 60px rgba(0, 0, 0, .28); }

    .sq-card { position: relative; }
    .sq-grip { position: absolute; z-index: 1; touch-action: none; }
    .sq-grip-n { top: -5px; left: 28px; right: 28px; height: 12px; cursor: ns-resize; }
    .sq-grip-e { right: -5px; top: 28px; bottom: 28px; width: 12px; cursor: ew-resize; }
    .sq-grip-ne { top: 0; right: 0; width: 30px; height: 30px; cursor: nesw-resize; border-radius: 0 26px 0 0; }
    /* visible corner mark: two short diagonal lines */
    .sq-grip-ne::after { content: ""; position: absolute; top: 12px; right: 12px; width: 13px; height: 13px; opacity: .6;
      background: linear-gradient(45deg, transparent 42%, var(--sq-muted) 42% 52%, transparent 52% 66%,
                                         var(--sq-muted) 66% 76%, transparent 76%); }
    .sq-grip-ne:hover::after, .sq-grip-ne:focus-visible::after { opacity: 1;
      background: linear-gradient(45deg, transparent 42%, var(--sq-a1) 42% 52%, transparent 52% 66%,
                                         var(--sq-a1) 66% 76%, transparent 76%); }
    /* edges show a short colored bar on hover so you know you can grab them */
    .sq-grip-n:hover { background: linear-gradient(var(--sq-a1), var(--sq-a1)) center / 48px 4px no-repeat; }
    .sq-grip-e:hover { background: linear-gradient(var(--sq-a1), var(--sq-a1)) center / 4px 48px no-repeat; }
    html.sq-resizing, html.sq-resizing * { user-select: none !important; }

    .sq-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 14px; }
    .sq-head-right { display: flex; align-items: center; gap: 10px; }

    /* Auto-play switch: words + a sliding knob, so it never relies on color alone */
    .sq-switch { display: inline-flex; align-items: center; gap: 8px; padding: 6px 10px; border: 0; border-radius: 999px;
                 cursor: pointer; background: var(--sq-bg); box-shadow: var(--sq-raised-sm); color: var(--sq-text);
                 font-family: inherit; font-size: .875em; font-weight: 700; }
    .sq-switch-track { position: relative; width: 44px; height: 24px; border-radius: 12px; flex: none;
                       background: var(--sq-bg); box-shadow: var(--sq-inset); transition: background .2s; }
    .sq-switch-track::after { content: ""; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%;
                              background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, .35); transition: transform .2s; }
    .sq-switch[aria-checked="true"] .sq-switch-track { background: var(--sq-grad); box-shadow: none; }
    .sq-switch[aria-checked="true"] .sq-switch-track::after { transform: translateX(20px); }
    .sq-switch-text { min-width: 2em; text-align: left; }
    .sq-switch[aria-checked="true"] .sq-switch-text { color: var(--sq-a1); }
    .sq-switch[aria-checked="false"] .sq-switch-text { color: var(--sq-muted); }
    .sq-h1 { font-size: 1.5em; font-weight: 800; background: var(--sq-grad);
             -webkit-background-clip: text; background-clip: text; color: transparent; }
    .sq-sub { font-size: .875em; color: var(--sq-muted); }

    .sq-icon-btn { width: 36px; height: 36px; flex: none; display: grid; place-items: center; padding: 0;
                   border: 0; border-radius: 50%; cursor: pointer; color: var(--sq-text);
                   background: var(--sq-bg); box-shadow: var(--sq-raised-sm);
                   transition: box-shadow .15s, color .15s, transform .1s; }
    .sq-icon-btn svg { width: 20px; height: 20px; fill: currentColor; }
    .sq-icon-btn:hover:not(:disabled) { color: var(--sq-a1); }
    .sq-icon-btn:active:not(:disabled) { box-shadow: var(--sq-inset); transform: scale(.95); }
    .sq-icon-btn:disabled { opacity: .35; cursor: default; box-shadow: none; }
    .sq-danger:hover:not(:disabled) { color: var(--sq-a2); }

    .sq-theme :focus-visible { outline: 2px solid var(--sq-a1); outline-offset: 2px; }

    .sq-now { position: relative; display: grid; grid-template-columns: auto 1fr auto auto; align-items: center;
              gap: 10px; padding: 12px 12px 12px 16px; margin-bottom: 16px; border-radius: 18px;
              background: var(--sq-bg); box-shadow: var(--sq-inset); }
    .sq-now::before { content: ""; position: absolute; left: 0; top: 14px; bottom: 14px; width: 4px;
                      border-radius: 0 4px 4px 0; background: var(--sq-grad); }
    .sq-now .sq-thumb { width: 96px; height: 54px; }
    .sq-now-body { min-width: 0; }
    .sq-now-label { display: flex; align-items: center; gap: 6px; margin-bottom: 2px;
                    font-size: .75em; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; color: var(--sq-a1); }
    .sq-eq { display: inline-flex; align-items: flex-end; gap: 2px; height: 12px; }
    .sq-eq i { width: 3px; height: 4px; border-radius: 2px; background: var(--sq-grad); }
    .sq-now.is-playing .sq-eq i { animation: sq-eq .9s ease-in-out infinite; }
    .sq-now.is-playing .sq-eq i:nth-child(2) { animation-delay: -.3s; }
    .sq-now.is-playing .sq-eq i:nth-child(3) { animation-delay: -.6s; }
    @keyframes sq-eq { 0%, 100% { height: 4px; } 50% { height: 12px; } }

    .sq-tools { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 6px 12px; }
    .sq-selectall { display: flex; align-items: center; gap: 8px; cursor: pointer;
                    font-size: .875em; font-weight: 600; color: var(--sq-muted); }
    .sq-bulk { display: flex; gap: 8px; }

    .sq-check { appearance: none; -webkit-appearance: none; width: 22px; height: 22px; margin: 0; flex: none;
                display: grid; place-items: center; border-radius: 6px; cursor: pointer;
                background: var(--sq-bg); box-shadow: var(--sq-inset); transition: background .15s; }
    .sq-check:checked, .sq-check:indeterminate { background: var(--sq-grad); box-shadow: none; }
    .sq-check:checked::after { content: ""; width: 5px; height: 10px; border: solid #fff; border-width: 0 2px 2px 0;
                               transform: translateY(-1px) rotate(45deg); }
    .sq-check:indeterminate::after { content: ""; width: 10px; height: 2px; border-radius: 1px; background: #fff; }

    .sq-list { list-style: none; margin: 0; padding: 6px; flex: 1; min-height: 0; overflow-y: auto;
               display: flex; flex-direction: column; gap: 10px; }
    .sq-row { display: grid; grid-template-columns: auto auto auto 1fr auto; align-items: center; gap: 10px;
              padding: 8px 10px; border-radius: 16px; background: var(--sq-bg); box-shadow: var(--sq-raised-sm);
              transition: box-shadow .15s; }
    .sq-row.is-selected { box-shadow: var(--sq-inset); }
    .sq-num { min-width: 20px; text-align: right; font-size: .875em; font-weight: 600; color: var(--sq-muted);
              font-variant-numeric: tabular-nums; }
    .sq-thumb { display: block; width: 64px; height: 36px; border-radius: 8px; object-fit: cover; background: var(--sq-lo); }
    .sq-title { min-width: 0; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
                color: var(--sq-text); text-decoration: none; font-size: 1em; font-weight: 500; }
    .sq-title:hover { color: var(--sq-a1); }
    .sq-actions { display: flex; gap: 6px; }
    .sq-actions .sq-icon-btn { width: 32px; height: 32px; }
    .sq-actions .sq-icon-btn svg { width: 18px; height: 18px; }

    /* Folder tabs: the selected tab is brighter, taller, joined to the list, with a color strip on top. */
    .sq-tabs { display: flex; gap: 6px; align-items: flex-end; padding: 0; }
    .sq-tab { position: relative; flex: 1; padding: 9px 10px; border: 0; border-radius: 12px 12px 0 0; cursor: pointer;
              background: var(--sq-back); color: var(--sq-muted); font-family: inherit; font-size: .9375em; font-weight: 600; }
    .sq-tab:hover:not([aria-selected="true"]) { color: var(--sq-text); }
    .sq-tab[aria-selected="true"] { padding: 13px 10px; background: var(--sq-front); color: var(--sq-text);
                                    font-weight: 800; cursor: default; }
    .sq-tab[aria-selected="true"]::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 5px;
                                            border-radius: 12px 12px 0 0; background: var(--sq-grad); }

    .sq-folder { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 12px 6px 6px;
                 border-radius: 0 0 16px 16px; background: var(--sq-front);
                 /* inside the folder, use flat soft shadows instead of the neumorphic ones */
                 --sq-bg: var(--sq-front);
                 --sq-raised-sm: 0 1px 4px rgba(0, 0, 0, .16);
                 --sq-inset: inset 0 1px 3px rgba(0, 0, 0, .22); }
    .sq-tabs[hidden] + .sq-folder { border-radius: 16px; }
    .sq-folder .sq-row.is-selected { background: rgba(123, 92, 255, .10); box-shadow: inset 0 0 0 2px rgba(123, 92, 255, .5); }

    .sq-played { grid-template-columns: auto auto 1fr auto; align-items: start; }
    .sq-played > .sq-check, .sq-played > .sq-actions { align-self: center; }
    .sq-played .sq-from-btn { margin-top: 8px; }

    .sq-savebar { display: flex; gap: 8px; padding: 0 6px 12px; }
    .sq-input { flex: 1; min-width: 0; width: 100%; padding: 10px 12px; border: 0; border-radius: 12px; outline: none;
                background: var(--sq-bg); box-shadow: var(--sq-inset); color: var(--sq-text);
                font-family: inherit; font-size: 1em; }
    .sq-input:focus { box-shadow: inset 0 0 0 2px var(--sq-a1); }
    .sq-save-btn { display: inline-flex; align-items: center; gap: 6px; padding: 10px 16px; border: 0; border-radius: 12px;
                   cursor: pointer; white-space: nowrap; color: #fff; background: var(--sq-grad);
                   box-shadow: 0 6px 14px rgba(123, 92, 255, .35); font-family: inherit; font-size: .9375em; font-weight: 700; }
    .sq-save-btn svg { width: 18px; height: 18px; fill: currentColor; }
    .sq-save-btn.is-armed { background: var(--sq-a2); }
    .sq-saved { grid-template-columns: 1fr auto auto auto; row-gap: 10px; }
    .sq-export { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 10px; padding: 12px; border-radius: 14px;
                 background: var(--sq-bg); box-shadow: var(--sq-inset); }
    .sq-export-h { font-weight: 800; }
    .sq-export-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .sq-export-row .sq-input { flex: 1 1 180px; }
    .sq-export-row .sq-save-btn { margin-left: auto; }
    .sq-export-text { font-weight: 600; }
    .sq-export.is-error .sq-export-text { color: var(--sq-a2); }
    .sq-export.is-done .sq-export-text { color: var(--sq-a1); }
    .sq-select { padding: 10px 12px; border: 0; border-radius: 12px; cursor: pointer; background: var(--sq-bg);
                 box-shadow: var(--sq-raised-sm); color: var(--sq-text); font-family: inherit; font-size: .9375em; font-weight: 700; }
    .sq-progress { height: 10px; border-radius: 5px; overflow: hidden; background: var(--sq-lo); }
    .sq-progress-fill { height: 100%; border-radius: 5px; background: var(--sq-grad); transition: width .3s; }
    .sq-export.is-paused .sq-progress-fill { background: var(--sq-muted); }
    .sq-open { display: inline-flex; align-items: center; gap: 6px; text-decoration: none; }
    .sq-open svg { width: 16px; height: 16px; fill: currentColor; }
    .sq-saved-name { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sq-load { grid-column: 1 / -1; display: flex; gap: 8px; }
    .sq-load-btn { flex: 1 1 auto; padding: 8px 10px; border: 0; border-radius: 12px; cursor: pointer; white-space: nowrap;
                   background: var(--sq-bg); box-shadow: var(--sq-raised-sm); color: var(--sq-text);
                   font-family: inherit; font-size: .875em; font-weight: 700; }
    .sq-load-btn:hover { color: var(--sq-a1); }
    .sq-load-btn:active { box-shadow: var(--sq-inset); }
    .sq-load-btn.is-armed, .sq-icon-btn.is-armed { color: #fff; background: var(--sq-a2); box-shadow: none; }
    .sq-played.is-idle:not(.is-selected) { opacity: .8; }
    .sq-row-body { min-width: 0; }
    .sq-meta { margin-top: 2px; font-size: .8125em; color: var(--sq-muted); }
    .sq-played.is-idle .sq-meta { color: var(--sq-a2); font-weight: 600; }
    .sq-from-btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px; border: 0; border-radius: 12px;
                   cursor: pointer; white-space: nowrap; background: var(--sq-bg); box-shadow: var(--sq-raised-sm);
                   color: var(--sq-text); font-family: inherit; font-size: .8125em; font-weight: 700; }
    .sq-from-btn svg { width: 18px; height: 18px; fill: var(--sq-a1); }
    .sq-from-btn:hover { color: var(--sq-a1); }
    .sq-from-btn:active { box-shadow: var(--sq-inset); }

    .sq-doze { margin-bottom: 14px; padding: 12px; border-radius: 18px; background: var(--sq-bg); box-shadow: var(--sq-inset); }
    .sq-doze-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
    .sq-doze-msg { font-size: .9375em; font-weight: 600; }
    .sq-rewind-btn { display: flex; align-items: center; gap: 12px; width: 100%; padding: 12px 16px; border: 0; border-radius: 14px;
                     cursor: pointer; text-align: left; color: #fff; background: var(--sq-grad);
                     box-shadow: 0 8px 20px rgba(123, 92, 255, .35); font-family: inherit; font-size: 1em; }
    .sq-rewind-btn svg { width: 26px; height: 26px; flex: none; fill: currentColor; }
    .sq-rewind-btn:hover { filter: brightness(1.08); }
    .sq-rewind-btn:active { transform: scale(.98); }
    .sq-rewind-text { display: flex; flex-direction: column; min-width: 0; }
    .sq-rewind-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .9; font-size: .875em; }
    .sq-prompt .sq-rewind-btn { margin-bottom: 14px; }

    .sq-prompt { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 2102;
                 width: min(440px, calc(100vw - 32px)); padding: 28px; border-radius: 26px; font-size: calc(${TEXT_SIZE}px * 1.1);
                 background: var(--sq-bg); box-shadow: var(--sq-raised), 0 30px 80px rgba(0, 0, 0, .45); }
    .sq-prompt-h { font-size: 1.6em; font-weight: 800; background: var(--sq-grad);
                   -webkit-background-clip: text; background-clip: text; color: transparent; }
    .sq-prompt-p { margin: 8px 0 18px; color: var(--sq-muted); }
    .sq-prompt-btns { display: flex; gap: 12px; justify-content: flex-end; }
    .sq-big-btn { padding: 12px 20px; border: 0; border-radius: 14px; cursor: pointer; font-family: inherit; font-size: 1em;
                  font-weight: 700; background: var(--sq-bg); color: var(--sq-text); box-shadow: var(--sq-raised-sm); }
    .sq-big-btn.is-primary { background: var(--sq-grad); color: #fff; box-shadow: 0 8px 20px rgba(123, 92, 255, .35); }
    .sq-big-btn:active { transform: scale(.97); }

    .sq-empty { padding: 24px 12px; text-align: center; font-size: .875em; color: var(--sq-muted); }
    .sq-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-top: 12px; }
    .sq-foot-tools { display: flex; gap: 6px; flex-wrap: wrap; }
    .sq-text-btn.sq-labeled { display: inline-flex; align-items: center; gap: 4px; padding: 8px 10px; color: var(--sq-text); }
    .sq-labeled svg { width: 18px; height: 18px; fill: currentColor; }
    .sq-text-btn.sq-labeled:hover { color: var(--sq-a1); }
    .sq-import-counts { margin: 0 0 6px; padding: 12px 14px; border-radius: 14px; box-shadow: var(--sq-inset); font-weight: 700; }
    .sq-import .sq-prompt-btns { flex-wrap: wrap; }
    .sq-big-btn.is-armed { color: #fff; background: var(--sq-a2); box-shadow: none; }
    .sq-text-btn { padding: 8px 14px; border: 0; border-radius: 12px; cursor: pointer;
                   background: var(--sq-bg); box-shadow: var(--sq-raised-sm); color: var(--sq-muted);
                   font-family: inherit; font-size: .875em; font-weight: 700; }
    .sq-text-btn:hover { color: var(--sq-a2); }
    .sq-text-btn.is-armed { color: #fff; background: var(--sq-grad); box-shadow: none; }

    .sq-toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 2101;
                max-width: min(80vw, 480px); padding: 12px 18px; border-radius: 16px;
                background: var(--sq-bg); box-shadow: var(--sq-raised), 0 12px 30px rgba(0, 0, 0, .2);
                border-left: 4px solid var(--sq-a1); font-weight: 600;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    .sq-pill { position: fixed; z-index: 2100; pointer-events: none; display: inline-flex; align-items: center; gap: 6px;
               padding: 6px 12px 6px 8px; border-radius: 999px; background: var(--sq-grad); color: #fff;
               font-size: .875em; font-weight: 700; box-shadow: 0 6px 16px rgba(123, 92, 255, .45); }
    .sq-pill svg { width: 16px; height: 16px; fill: currentColor; }

    /* ⋮ menu items (these live inside YouTube's own menu) */
    .sq-item { display: flex; align-items: center; gap: 16px; height: 40px; padding: 0 16px; cursor: pointer;
               font: 16px Roboto, Arial, sans-serif; color: var(--yt-spec-text-primary, #0f0f0f); }
    .sq-item svg { width: 22px; height: 22px; fill: #7b5cff; }
    .sq-item:hover, .sq-item:focus { background: rgba(128, 128, 128, .2); outline: none; }
    .sq-item.is-info { cursor: default; color: var(--yt-spec-text-secondary, #606060); }
    .sq-item.is-info:hover { background: transparent; }

    @media (prefers-reduced-motion: reduce) {
      .sq-theme *, .sq-theme { animation: none !important; transition: none !important; }
    }
  `;

  /* ---------- Start ---------- */
  buildPanel();
  applySize(savedSize());
  document.head.append(el('style', null, CSS));
  document.body.append(ui.root, ui.pill, ui.toast, ui.prompt, ui.importBox);
  render();

  repairTitles();

  // Keep every open YouTube tab in sync when the queue changes in another tab.
  if (gmStorage && typeof GM_addValueChangeListener === 'function') {
    for (const k of [KEY, SAVED_KEY]) {
      GM_addValueChangeListener(k, (name, oldValue, newValue, remote) => { if (remote) render(); });
    }
  } else {
    window.addEventListener('storage', (e) => { if (e.key === KEY || e.key === SAVED_KEY) render(); });
  }
})();
