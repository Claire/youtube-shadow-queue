// Tests for tools/enrich.mjs. No network: a fake YouTube answers instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseEnv, parseDuration, topicName, redact, collectVideos, slim, explain, ApiError,
  apiGet, enrich, buildEnriched, summarize, main, API, ENRICHED_FORMAT,
} from '../tools/enrich.mjs';

const KEY = 'AIzaTEST-not-a-real-key-000000000000000';
const id = (n) => `vid${String(n).padStart(8, '0')}`; // 11 characters
const backupOf = (queue, saved = []) => ({ format: 'youtube-shadow-queue-backup', version: 1, queue, saved });
const noSleep = async () => {};

/** A fake YouTube. `gone` ids are left out of answers, like deleted videos. */
function fakeYouTube({ gone = [], fail = () => null } = {}) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, key: init.headers['x-goog-api-key'] });
    const u = new URL(url);
    const failure = fail(u, calls.length);
    if (failure) return failure;
    if (u.pathname.endsWith('/videoCategories')) {
      return Response.json({ items: [{ id: '10', snippet: { title: 'Music' } }, { id: '27', snippet: { title: 'Education' } }] });
    }
    const ids = u.searchParams.get('id').split(',');
    return Response.json({
      items: ids.filter((x) => !gone.includes(x)).map((x, i) => ({
        id: x,
        snippet: {
          title: `Title ${x}`, channelId: 'UC1', channelTitle: i % 2 ? 'Odd Channel' : 'Even Channel',
          categoryId: i % 2 ? '10' : '27', tags: ['a', 'b'], description: 'd'.repeat(5000),
          thumbnails: { medium: { url: `https://i.ytimg.com/vi/${x}/mqdefault.jpg` } },
        },
        contentDetails: { duration: 'PT4M5S' },
        topicDetails: { topicCategories: ['https://en.wikipedia.org/wiki/Pop_music'] },
      })),
    });
  };
  return { fetchFn, calls };
}
const apiError = (status, reason, message = 'nope') =>
  Response.json({ error: { code: status, message, errors: [{ reason }] } }, { status });

test('parseEnv reads KEY=value lines', () => {
  const env = parseEnv('# comment\r\n\r\nYT_API_KEY = "abc"\nexport OTHER=\'x y\'\nBROKEN LINE\nEMPTY=\n');
  assert.deepEqual(env, { YT_API_KEY: 'abc', OTHER: 'x y', EMPTY: '' });
});

test('parseDuration turns ISO 8601 into seconds', () => {
  assert.equal(parseDuration('PT15M33S'), 933);
  assert.equal(parseDuration('PT1H2M3S'), 3723);
  assert.equal(parseDuration('P1DT1S'), 86401);
  assert.equal(parseDuration('P0D'), 0);
  for (const bad of ['', 'P', 'PT', '15:33', null, undefined]) assert.equal(parseDuration(bad), null, String(bad));
});

test('topicName makes Wikipedia links readable', () => {
  assert.equal(topicName('https://en.wikipedia.org/wiki/Video_game_culture'), 'Video game culture');
  assert.equal(topicName('https://en.wikipedia.org/wiki/Pok%C3%A9mon'), 'Pokémon');
  assert.equal(topicName('https://en.wikipedia.org/wiki/100%_bad'), '100% bad');
});

test('collectVideos lists each video once, with every list it is in', () => {
  const v = collectVideos(backupOf(
    { current: { id: id(1), title: 'One' }, items: [{ id: id(2), title: 'Two' }, { id: 'bad', title: 'x' }], played: [{ id: id(1), title: '' }, { id: id(1), title: 'again' }] },
    [{ name: 'Mix', items: [{ id: id(2) }, { id: id(3), title: 'Three' }] }],
  ));
  assert.deepEqual([...v.keys()], [id(1), id(2), id(3)]);
  assert.deepEqual(v.get(id(1)), { title: 'One', lists: ['Now playing', 'Played'] });
  assert.deepEqual(v.get(id(2)).lists, ['Up next', 'Saved: Mix']);
  assert.throws(() => collectVideos({ some: 'thing' }), /isn't a queue backup/);
});

test('slim keeps the useful fields and shortens descriptions', () => {
  const s = slim({
    id: id(1),
    snippet: { title: 'T', channelTitle: 'C', categoryId: '27', description: 'x'.repeat(3000), defaultAudioLanguage: 'en' },
    contentDetails: { duration: 'PT1M' },
  }, { 27: 'Education' });
  assert.equal(s.category, 'Education');
  assert.equal(s.seconds, 60);
  assert.equal(s.description.length, 1000);
  assert.deepEqual(s.tags, []);
  assert.deepEqual(s.topics, []);
  assert.equal(s.language, 'en');
});

test('the key goes in a header, never in the URL', async () => {
  const yt = fakeYouTube();
  await apiGet({ fetchFn: yt.fetchFn, key: KEY }, 'videos', { part: 'snippet', id: id(1) });
  assert.equal(yt.calls[0].key, KEY);
  assert.ok(yt.calls[0].url.startsWith(`${API}/videos?`));
  assert.ok(!yt.calls[0].url.includes(KEY));
  assert.ok(!yt.calls[0].url.includes('key='));
});

test('busy server: retries, then succeeds', async () => {
  const yt = fakeYouTube({ fail: (u, n) => (n < 3 ? new Response('busy', { status: 503 }) : null) });
  const res = await apiGet({ fetchFn: yt.fetchFn, key: KEY, sleep: noSleep }, 'videos', { id: id(1) });
  assert.equal(res.items.length, 1);
  assert.equal(yt.calls.length, 3);
});

test('errors become plain advice, and the key is never shown', async () => {
  const cases = [
    [apiError(400, 'keyInvalid', `API key not valid: ${KEY}`), /not valid\. Check the YT_API_KEY line/],
    [apiError(403, 'accessNotConfigured'), /click Enable/],
    [apiError(403, 'quotaExceeded'), /allowance is used up/],
    [apiError(403, 'forbidden', `odd ${KEY}`), /YouTube API error 403: odd \*\*\*/],
  ];
  for (const [response, advice] of cases) {
    const err = await apiGet({ fetchFn: async () => response, key: KEY, sleep: noSleep }, 'videos', {}).catch((e) => e);
    assert.ok(err instanceof ApiError);
    assert.match(explain(err), advice);
    assert.ok(!explain(err).includes(KEY));
  }
  const offline = await apiGet({ fetchFn: async () => { throw new Error(`down ${KEY}`); }, key: KEY, sleep: noSleep }, 'v', {}).catch((e) => e);
  assert.match(offline.message, /Couldn't reach YouTube \(down \*\*\*\)/);
  assert.equal(redact('a KEY b KEY', 'KEY'), 'a *** b ***');
});

test('enrich: 50 per request, marks deleted videos, then uses the cache', async () => {
  const items = Array.from({ length: 120 }, (_, i) => ({ id: id(i), title: `t${i}` }));
  const backup = backupOf({ current: null, items, played: [] });
  const yt = fakeYouTube({ gone: [id(7)] });
  const cache = {};
  let saves = 0;
  const r = await enrich({ backup, cache, key: KEY, fetchFn: yt.fetchFn, onBatch: async () => { saves++; } });
  assert.equal(r.units, 4, '1 for categories + 3 batches');
  assert.equal(saves, 3, 'saved after every batch');
  const batchSizes = yt.calls.slice(1).map((c) => new URL(c.url).searchParams.get('id').split(',').length);
  assert.deepEqual(batchSizes, [50, 50, 20]);
  assert.equal(cache.videos[id(0)].category, 'Education');
  assert.equal(cache.videos[id(1)].category, 'Music');
  assert.equal(cache.videos[id(0)].seconds, 245);
  assert.deepEqual(cache.videos[id(0)].topics, ['Pop music']);
  assert.equal(cache.videos[id(7)].unavailable, true);

  const again = await enrich({ backup, cache, key: KEY, fetchFn: yt.fetchFn });
  assert.equal(again.units, 0);
  assert.equal(yt.calls.length, 4, 'no new requests');

  const refreshed = await enrich({ backup, cache, key: KEY, fetchFn: yt.fetchFn, refresh: true });
  assert.equal(refreshed.units, 4);
});

test('enrich: running out of quota keeps what was done', async () => {
  const items = Array.from({ length: 70 }, (_, i) => ({ id: id(i), title: `t${i}` }));
  const backup = backupOf({ current: null, items, played: [] });
  const yt = fakeYouTube({ fail: (u, n) => (n === 3 ? apiError(403, 'quotaExceeded') : null) });
  const cache = {};
  const r = await enrich({ backup, cache, key: KEY, fetchFn: yt.fetchFn, sleep: noSleep });
  assert.equal(r.stopped, 'quota');
  assert.equal(r.fetched, 50);
  assert.equal(Object.keys(cache.videos).length, 50);
  const e = buildEnriched({ backup, cache, videos: r.videos, source: 'b.json' });
  assert.equal(e.videos[id(60)].pending, true);
  assert.equal(e.videos[id(60)].title, 't60');
  assert.match(summarize(e), /70 videos: 50 with details, 20 not looked up yet/);
});

test('buildEnriched: keeps the backup, lists and titles of deleted videos', () => {
  const backup = backupOf({ current: null, items: [{ id: id(1), title: 'Mine' }, { id: id(2), title: 'Gone one' }], played: [] });
  const cache = { videos: { [id(1)]: { id: id(1), title: 'From YouTube', channel: 'C', category: 'Music', topics: [] }, [id(2)]: { id: id(2), unavailable: true } } };
  const e = buildEnriched({ backup, cache, videos: collectVideos(backup), source: 'b.json', now: new Date(0) });
  assert.equal(e.format, ENRICHED_FORMAT);
  assert.equal(e.createdAt, '1970-01-01T00:00:00.000Z');
  assert.deepEqual(e.backup, backup);
  assert.equal(e.videos[id(1)].title, 'From YouTube');
  assert.deepEqual(e.videos[id(1)].lists, ['Up next']);
  assert.equal(e.videos[id(2)].title, 'Gone one');
  assert.match(summarize(e), /2 videos: 1 with details, 1 unavailable/);
  assert.match(summarize(e), /Top channels\n\s+1  C/);
});

test('main: end to end, writes files without the key anywhere', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'enrich-'));
  await writeFile(path.join(root, '.env'), `# my key\nYT_API_KEY=${KEY}\n`);
  const file = path.join(root, 'backup.json');
  await writeFile(file, JSON.stringify(backupOf({ current: { id: id(1), title: 'a' }, items: [{ id: id(2), title: 'b' }], played: [] })));
  const printed = [];
  const yt = fakeYouTube();
  const code = await main([file], { root, env: {}, fetchFn: yt.fetchFn, out: (s) => printed.push(s) });
  assert.equal(code, 0);
  assert.deepEqual((await readdir(path.join(root, 'data'))).sort(), ['cache.json', 'enriched.json'], 'no temp files left');
  const enriched = await readFile(path.join(root, 'data', 'enriched.json'), 'utf8');
  const cacheText = await readFile(path.join(root, 'data', 'cache.json'), 'utf8');
  assert.equal(JSON.parse(enriched).videos[id(2)].channel, 'Odd Channel');
  for (const text of [enriched, cacheText, printed.join('\n')]) assert.ok(!text.includes(KEY), 'key leaked');
  assert.match(printed.join('\n'), /Used 2 of your 10,000/);
});

test('main: clear messages for missing key, file or wrong file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'enrich-'));
  const say = [];
  const run = (args, env = {}) => main(args, { root, env, fetchFn: async () => { throw new Error('should not be called'); }, out: (s) => say.push(s) });
  assert.equal(await run([]), 1);
  assert.match(say.pop(), /node tools\/enrich\.mjs <backup\.json>/);
  assert.equal(await run(['x.json']), 1);
  assert.match(say.pop(), /No usable YT_API_KEY/);
  assert.equal(await run(['nope.json'], { YT_API_KEY: KEY }), 1);
  assert.match(say.pop(), /File not found/);
  const junk = path.join(root, 'junk.json');
  await writeFile(junk, '{"some":"thing"}');
  assert.equal(await run([junk], { YT_API_KEY: KEY }), 1);
  assert.match(say.pop(), /isn't a queue backup/);
});
