#!/usr/bin/env node
/**
 * enrich.mjs: adds YouTube details to a queue backup, so you can sort and split it.
 *
 * Think of it like a librarian: you hand over a list of book titles (your backup),
 * the librarian looks each one up in the catalog (the YouTube Data API) and writes
 * the shelf, genre and page count next to it. Answers are kept in a notebook
 * (data/cache.json), so asking again tomorrow costs nothing.
 *
 * Usage (from the repo folder):
 *   node tools/enrich.mjs ~/Downloads/youtube-queue-backup-2026-11-25.json
 *   node tools/enrich.mjs <backup.json> --refresh     look everything up again
 *
 * Needs: Node 20+, and a .env file in the repo folder with one line:
 *   YT_API_KEY=your-key
 * The key is sent only to www.googleapis.com, in a header (never in the URL),
 * and is never printed or written to any file. .env and data/ are git-ignored.
 *
 * Writes:
 *   data/enriched.json  your backup + details for every video (for the organizer)
 *   data/cache.json     what YouTube answered, reused next time
 *
 * Cost: 1 quota unit per 50 videos, plus 1 for category names.
 * The free daily allowance is 10,000 units. If it runs out, progress is saved;
 * run again the next day and it continues where it stopped.
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const API = 'https://www.googleapis.com/youtube/v3';
export const BATCH = 50;
export const ENRICHED_FORMAT = 'youtube-shadow-queue-enriched';
const BACKUP_FORMAT = 'youtube-shadow-queue-backup';
const CACHE_VERSION = 1;
const ID_RE = /^[\w-]{11}$/;
const DESCRIPTION_CHARS = 1000; // enough to tell what a video is about, keeps files small
const RETRIES = 3;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ---------- small pure helpers ---------- */

/** Reads KEY=value lines. Ignores blank lines and # comments; strips quotes and "export ". */
export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

/** "PT1H2M3S" → 3723 seconds. Returns null if it isn't an ISO 8601 duration. */
export function parseDuration(iso) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(iso ?? ''));
  if (!m || iso === 'P' || iso === 'PT') return null;
  const [d, h, min, s] = m.slice(1).map((n) => Number(n ?? 0));
  return ((d * 24 + h) * 60 + min) * 60 + s;
}

/** "https://en.wikipedia.org/wiki/Video_game_culture" → "Video game culture" */
export function topicName(url) {
  const last = String(url).split('/').pop() ?? '';
  try { return decodeURIComponent(last).replace(/_/g, ' '); } catch { return last.replace(/_/g, ' '); }
}

/** Hides the key if it ever appears in a message from the server. */
export function redact(text, key) {
  return key ? String(text).split(key).join('***') : String(text);
}

/**
 * Every video in the backup, once, with the lists it's in.
 * @returns {Map<string, {title: string, lists: string[]}>}
 */
export function collectVideos(backup) {
  if (!backup || backup.format !== BACKUP_FORMAT) {
    throw new Error("That file isn't a queue backup. In the Queue panel, click Backup to make one.");
  }
  const videos = new Map();
  const add = (video, list) => {
    if (!video || !ID_RE.test(video.id)) return;
    const entry = videos.get(video.id) ?? { title: '', lists: [] };
    if (!entry.title && typeof video.title === 'string') entry.title = video.title;
    if (!entry.lists.includes(list)) entry.lists.push(list);
    videos.set(video.id, entry);
  };
  const q = backup.queue ?? {};
  add(q.current, 'Now playing');
  for (const v of q.items ?? []) add(v, 'Up next');
  for (const v of q.played ?? []) add(v, 'Played');
  for (const s of backup.saved ?? []) for (const v of s.items ?? []) add(v, `Saved: ${s.name}`);
  return videos;
}

/** Keeps only the fields the organizer uses. */
export function slim(item, categories) {
  const sn = item.snippet ?? {};
  return {
    id: item.id,
    title: sn.title ?? '',
    channelId: sn.channelId ?? null,
    channel: sn.channelTitle ?? null,
    publishedAt: sn.publishedAt ?? null,
    categoryId: sn.categoryId ?? null,
    category: categories[sn.categoryId] ?? null,
    tags: sn.tags ?? [],
    topics: (item.topicDetails?.topicCategories ?? []).map(topicName),
    seconds: parseDuration(item.contentDetails?.duration),
    language: sn.defaultAudioLanguage ?? sn.defaultLanguage ?? null,
    thumbnail: sn.thumbnails?.medium?.url ?? null,
    description: (sn.description ?? '').slice(0, DESCRIPTION_CHARS),
  };
}

/* ---------- talking to YouTube ---------- */

export class ApiError extends Error {
  constructor(status, reasons, message) {
    super(message);
    this.status = status;
    this.reasons = reasons;
  }
  get isQuota() { return this.reasons.some((r) => /quotaExceeded|dailyLimitExceeded|RATE_LIMIT_EXCEEDED/i.test(r)); }
}

/** Turns an API error into a sentence that says what to do. */
export function explain(err) {
  if (!(err instanceof ApiError)) return err.message;
  const all = `${err.reasons.join(' ')} ${err.message}`;
  if (err.isQuota) return "Today's YouTube API allowance is used up. Progress is saved; run this again tomorrow.";
  if (/keyInvalid|API_KEY_INVALID|API key not valid/i.test(all)) return 'YouTube says the API key is not valid. Check the YT_API_KEY line in .env.';
  if (/accessNotConfigured|SERVICE_DISABLED|has not been used|is disabled/i.test(all)) {
    return 'The YouTube Data API v3 is not turned on for this key. In Google Cloud Console, open APIs & Services → Library, find "YouTube Data API v3" and click Enable.';
  }
  if (/REFERRER_BLOCKED|IP_ADDRESS_BLOCKED|ipRefererBlocked|API_KEY_SERVICE_BLOCKED/i.test(all)) {
    return "The key's restrictions block this request. In Google Cloud Console → Credentials, allow this key to use the YouTube Data API v3 (and remove website-only restrictions).";
  }
  return `YouTube API error ${err.status}: ${err.message}`;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** One GET request. The key travels in the x-goog-api-key header, never in the URL. */
export async function apiGet({ fetchFn = fetch, key, sleep = wait }, endpoint, params) {
  const url = `${API}/${endpoint}?${new URLSearchParams(params)}`;
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetchFn(url, { headers: { 'x-goog-api-key': key, accept: 'application/json' } });
    } catch (e) {
      if (attempt >= RETRIES) throw new Error(`Couldn't reach YouTube (${redact(e.message, key)}). Check your internet connection.`);
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }
    if (res.ok) return res.json();
    const body = await res.json().catch(() => ({}));
    const e = body.error ?? {};
    const reasons = [
      ...(e.errors ?? []).map((x) => x.reason),
      ...(e.details ?? []).map((x) => x.reason),
      e.status,
    ].filter(Boolean);
    const err = new ApiError(res.status, reasons, redact(e.message ?? res.statusText ?? 'unknown error', key));
    const busy = res.status >= 500 || (res.status === 429 && !err.isQuota);
    if (!busy || attempt >= RETRIES) throw err;
    await sleep(1000 * 2 ** (attempt - 1));
  }
}

/**
 * Looks up every video not already in the cache.
 * Saves after each batch (via onBatch) so a stop never loses work.
 */
export async function enrich({ backup, cache, key, refresh = false, fetchFn, sleep, onBatch = async () => {}, log = () => {} }) {
  const api = { fetchFn, key, sleep };
  const videos = collectVideos(backup);
  cache.videos ??= {};
  const todo = [...videos.keys()].filter((id) => refresh || !cache.videos[id]);
  let units = 0;
  let fetched = 0;
  if (!todo.length) return { videos, units, fetched, stopped: null };

  try {
    if (refresh || !cache.categories) {
      const res = await apiGet(api, 'videoCategories', { part: 'snippet', regionCode: 'US', hl: 'en' });
      units++;
      cache.categories = Object.fromEntries((res.items ?? []).map((c) => [c.id, c.snippet?.title]));
    }
    for (let i = 0; i < todo.length; i += BATCH) {
      const ids = todo.slice(i, i + BATCH);
      const res = await apiGet(api, 'videos', { part: 'snippet,contentDetails,topicDetails', id: ids.join(',') });
      units++;
      const at = new Date().toISOString();
      const found = new Map((res.items ?? []).map((item) => [item.id, item]));
      for (const id of ids) {
        cache.videos[id] = found.has(id)
          ? { ...slim(found.get(id), cache.categories), fetchedAt: at }
          : { id, unavailable: true, fetchedAt: at }; // private, deleted or blocked
      }
      fetched += ids.length;
      await onBatch(cache);
      log(`Looked up ${fetched} of ${todo.length}`);
    }
    return { videos, units, fetched, stopped: null };
  } catch (err) {
    if (err instanceof ApiError && err.isQuota) return { videos, units, fetched, stopped: 'quota' };
    throw err;
  }
}

/** The file the organizer reads: your backup plus details for every video. */
export function buildEnriched({ backup, cache, videos, source, now = new Date() }) {
  const out = {};
  for (const [id, { title, lists }] of videos) {
    const known = cache.videos?.[id];
    if (!known) out[id] = { id, title, lists, pending: true };
    else if (known.unavailable) out[id] = { ...known, title, lists };
    else out[id] = { ...known, lists };
  }
  return { format: ENRICHED_FORMAT, version: 1, createdAt: now.toISOString(), source, backup, videos: out };
}

/** A short, readable summary for the terminal. */
export function summarize(enriched, top = 8) {
  const all = Object.values(enriched.videos);
  const ok = all.filter((v) => !v.unavailable && !v.pending);
  const count = (pick) => {
    const m = new Map();
    for (const v of ok) for (const k of [].concat(pick(v) ?? [])) m.set(k, (m.get(k) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(b[0])).slice(0, top);
  };
  const table = (title, rows) => (rows.length ? [`\n${title}`, ...rows.map(([k, n]) => `  ${String(n).padStart(5)}  ${k}`)] : []);
  const missing = all.filter((v) => v.unavailable).length;
  const pending = all.filter((v) => v.pending).length;
  return [
    `${all.length} videos: ${ok.length} with details` +
      (missing ? `, ${missing} unavailable (private or deleted)` : '') +
      (pending ? `, ${pending} not looked up yet` : ''),
    ...table('Top categories', count((v) => v.category ?? 'Unknown')),
    ...table('Top channels', count((v) => v.channel)),
    ...table('Top topics', count((v) => v.topics)),
  ].join('\n');
}

/* ---------- files ---------- */

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw e;
  }
}

/** Write to a temp file, then rename: a crash never leaves a half-written file. */
async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 1));
  await rename(tmp, file);
}

const HELP = `Adds YouTube details (channel, category, tags, topics, length) to a queue backup.

  node tools/enrich.mjs <backup.json>            look up new videos only
  node tools/enrich.mjs <backup.json> --refresh  look up everything again

Needs a .env file in the repo folder with:  YT_API_KEY=your-key
Writes data/enriched.json (for the organizer) and data/cache.json.`;

/** Command line. Options are injectable for tests. */
export async function main(argv, { root = ROOT, env = process.env, fetchFn = fetch, sleep, out = console.log } = {}) {
  const args = argv.filter((a) => !a.startsWith('--'));
  const refresh = argv.includes('--refresh');
  if (argv.includes('--help') || argv.includes('-h') || args.length !== 1) { out(HELP); return args.length === 1 ? 0 : 1; }

  let key = env.YT_API_KEY;
  if (!key) {
    try { key = parseEnv(await readFile(path.join(root, '.env'), 'utf8')).YT_API_KEY; } catch { /* reported below */ }
  }
  if (!key || /\s/.test(key)) {
    out(`No usable YT_API_KEY found. Put this line in ${path.join(root, '.env')}:\n  YT_API_KEY=your-key`);
    return 1;
  }

  let backup;
  try { backup = JSON.parse(await readFile(path.resolve(args[0]), 'utf8')); } catch (e) {
    out(e.code === 'ENOENT' ? `File not found: ${args[0]}` : `Couldn't read ${args[0]} as JSON.`);
    return 1;
  }

  const dataDir = path.join(root, 'data');
  const cacheFile = path.join(dataDir, 'cache.json');
  const cache = await readJson(cacheFile, { version: CACHE_VERSION, videos: {} });

  let result;
  try {
    result = await enrich({ backup, cache, key, refresh, fetchFn, sleep, onBatch: (c) => writeJson(cacheFile, c), log: out });
  } catch (err) {
    out(redact(explain(err), key));
    return 1;
  }

  const enriched = buildEnriched({ backup, cache, videos: result.videos, source: path.basename(args[0]) });
  const outFile = path.join(dataDir, 'enriched.json');
  await writeJson(outFile, enriched);
  out('\n' + summarize(enriched));
  out(`\nUsed ${result.units} of your 10,000 daily quota units. Saved ${path.relative(process.cwd(), outFile) || outFile}`);
  if (result.stopped === 'quota') { out(explain(new ApiError(403, ['quotaExceeded'], ''))); return 2; }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e.message); process.exitCode = 1; });
}
