#!/usr/bin/env -S npx tsx
/**
 * Offline test suite — no network, no Telegram, no real database.
 *
 *   npm test        (or: npx tsx tests/run.ts)
 *
 * It uses a temporary SQLite file and the committed config/preferences
 * examples, so it is safe to run at any time.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
// type-only imports are erased, so they cannot run before the sandbox env is set
import type { Store as StoreType } from '../src/db.ts';
import type { Item } from '../src/types.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'events-finder-test-'));
process.env['EVENTS_FINDER_DATA'] = sandbox;
process.env['EVENTS_FINDER_DB'] = join(sandbox, 'test.db');
process.env['EVENTS_FINDER_CONFIG'] = new URL('../config.example.yaml', import.meta.url).pathname;
process.env['EVENTS_FINDER_PREFS'] = join(sandbox, 'preferences.yaml');
process.env['EVENTS_FINDER_QUIET'] = '1';
delete process.env['DATABASE_URL'];

// a known preferences file, so ranking tests do not depend on the user's own
writeFileSync(
  process.env['EVENTS_FINDER_PREFS'],
  [
    'home_city: kharkiv',
    'watch_cities: [kyiv]',
    'favourite_categories: [standup, concert]',
    'disliked_categories: [classical]',
    'follow: ["Курган і Agregat"]',
    'max_ticket_price: 1200',
    'currency: UAH',
    'trip: null',
    'interests: [indie]',
    'notes: []',
  ].join('\n'),
);

// everything else is imported after the sandbox env vars are set above
const { describe, it, run } = await import('./harness.ts');
const { normText, stemText, isoInZone, localDate, localTime, addDays, weekdayOf, titleKey } = await import('../src/util.ts');
const { classify, canonicalTag, expandTag } = await import('../src/categories.ts');
const { parseDateRange, parseRequest, weekendRange, thisWeekRange, nextWeekRange, splitNegations } = await import('../src/request.ts');
const { fromSchemaEvent, makeItem, priceText, parsePriceText, statusFrom } = await import('../src/normalize.ts');
const { dedupe, fingerprint } = await import('../src/dedupe.ts');
const { rank, matchesFollow, matchesTag, groupByDay } = await import('../src/rank.ts');
const { buildDigest } = await import('../src/render.ts');
const { loadConfig, loadPrefs, resolveCity, cityLocalName } = await import('../src/config.ts');
const { applyPrefsCommand } = await import('../src/prefs-engine.ts');
const { parsePost, findDate, findTime, findVenue } = await import('../scripts/telegram.ts');
const { resultToItem, buildQueries } = await import('../scripts/websearch.ts');
const { collect: collectKontramarka } = await import('../scripts/kontramarka.ts');
const { Store } = await import('../src/db.ts');
const { splitForTelegram } = await import('../src/telegram-api.ts');
const { registerUser, getUser, saveUserPrefs, allUsers, citiesFor, defaultPrefs, newUserPrefs } = await import('../src/users.ts');
const { cacheKey } = await import('../src/cache.ts');
const { fanout } = await import('../src/fanout.ts');
const { handleMessage, handleCallback, parseBell, isAllowed, BOT_COMMANDS } = await import('../src/bot-handlers.ts');
const { makeLogger } = await import('../src/log.ts');
const { ALL_SOURCE_NAMES } = await import('../src/pipeline.ts');

const TZ = 'Europe/Kyiv';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const prefs = loadPrefs();

/* ------------------------------------------------------------------ util --- */

describe('util', () => {
  it('keeps Ukrainian ї/й intact while stripping Latin diacritics', () => {
    assert.equal(normText('Імпровізації з Café Ñandú'), 'імпровізації з cafe nandu');
  });

  it('stems Ukrainian inflections to a common form', () => {
    assert.equal(stemText('імпровізації'), stemText('імпровізація'));
    assert.equal(stemText('виставках'), stemText('виставка'));
    assert.notEqual(stemText('виставка'), stemText('вистава'), 'exhibition must not collapse into a play');
  });

  it('builds ISO timestamps with the right Kyiv offset on both sides of DST', () => {
    assert.equal(isoInZone('2026-07-15', '19:00', TZ), '2026-07-15T19:00:00+03:00');
    assert.equal(isoInZone('2026-11-15', '19:00', TZ), '2026-11-15T19:00:00+02:00');
  });

  it('reads local dates and times in the configured zone', () => {
    assert.equal(localDate('2026-10-24T22:00:00+03:00', TZ), '2026-10-24');
    assert.equal(localTime('2026-10-24T22:00:00+03:00', TZ), '22:00');
    // 23:30 UTC is already the next day in Kyiv
    assert.equal(localDate('2026-10-24T23:30:00Z', TZ), '2026-10-25');
  });

  it('gives the same title signature regardless of word order and noise', () => {
    assert.equal(titleKey('Антитіла. Вдома 2.0'), titleKey('Вдома 2.0 — АНТИТІЛА (концерт)'));
  });
});

/* ------------------------------------------------------------ categories --- */

describe('categories', () => {
  const cases: [string, string][] = [
    ['Харків Вечір Імпровізації Паші Пінчука', 'standup'],
    ['Тартюф (вистава)', 'theatre'],
    ['Нова виставка фотографій', 'exhibition'],
    ['лекція про архітектуру', 'lecture'],
    ['майстер-клас з гончарства', 'workshop'],
    ['фестиваль вуличної їжі', 'festival'],
    ['вечірка з діджеєм', 'party'],
    ['нова кав’ярня зі спешелті кавою', 'cafe'],
  ];
  for (const [text, expected] of cases) {
    it(`classifies "${text}" as ${expected}`, () => assert.equal(classify(text), expected));
  }

  it('stores a genre as itself, not as its parent category', () => {
    assert.equal(canonicalTag('jazz'), 'jazz');
    assert.equal(canonicalTag('stand-up'), 'standup');
  });

  it('expands a tag across languages', () => {
    const expanded = expandTag('classical');
    assert.ok(expanded.includes('класична'), 'classical should reach Ukrainian spellings');
  });
});

/* --------------------------------------------------------------- requests --- */

describe('request parsing', () => {
  const base = '2026-10-20'; // a Tuesday

  it('understands the weekend as Friday to Sunday', () => {
    const r = weekendRange(base);
    assert.equal(r.from, '2026-10-23');
    assert.equal(r.to, '2026-10-25');
    assert.equal(weekdayOf(r.from), 5);
  });

  it('understands this week and next week', () => {
    assert.deepEqual([thisWeekRange(base).from, thisWeekRange(base).to], ['2026-10-20', '2026-10-25']);
    assert.deepEqual([nextWeekRange(base).from, nextWeekRange(base).to], ['2026-10-26', '2026-11-01']);
  });

  it('reads today, tomorrow, explicit dates and spans', () => {
    assert.equal(parseDateRange('tonight', base).from, base);
    assert.equal(parseDateRange('завтра', base).from, addDays(base, 1));
    assert.deepEqual(
      [parseDateRange('25 жовтня', base).from, parseDateRange('25 жовтня', base).to],
      ['2026-10-25', '2026-10-25'],
    );
    assert.deepEqual(
      [parseDateRange('23-25 жовтня', base).from, parseDateRange('23-25 жовтня', base).to],
      ['2026-10-23', '2026-10-25'],
    );
    assert.equal(parseDateRange('next 3 days', base).to, addDays(base, 2));
  });

  it('defaults to the next 7 days when no date is mentioned', () => {
    const r = parseDateRange("what's interesting in Kharkiv", base);
    assert.deepEqual([r.from, r.to], [base, addDays(base, 7)]);
  });

  it('parses the headline example end to end', () => {
    const q = parseRequest(
      "what's interesting in Kharkiv this weekend, I like stand-up and indie rock, no classical music",
      { prefs, base },
    );
    assert.deepEqual(q.cities, ['kharkiv']);
    assert.deepEqual([q.from, q.to], ['2026-10-23', '2026-10-25']);
    assert.ok(q.like.includes('standup'), `like should contain standup, got ${q.like.join(',')}`);
    assert.ok(q.like.includes('indie'), `like should contain indie, got ${q.like.join(',')}`);
    assert.ok(q.dislike.includes('classical'), `dislike should contain classical, got ${q.dislike.join(',')}`);
    assert.ok(!q.like.includes('classical'), 'a disliked tag must not also be liked');
  });

  it('separates negated phrases from the rest', () => {
    const { negated, rest } = splitNegations('концерти, але без класики');
    assert.equal(negated.length, 1);
    assert.ok(!rest.includes('класики'));
  });

  it('resolves city names in any spelling or case', () => {
    assert.equal(resolveCity('Харкові'), 'kharkiv');
    assert.equal(resolveCity('kharkov'), 'kharkiv');
    assert.equal(resolveCity('Львів'), 'lviv');
    assert.equal(resolveCity('Atlantis'), null);
  });

  it('falls back to the home city, and to a trip city while the trip is on', () => {
    assert.deepEqual(parseRequest('щось цікаве', { prefs, base }).cities, ['kharkiv']);
    const travelling = { ...prefs, trip: { city: 'lviv', from: base, to: addDays(base, 7) } };
    assert.deepEqual(parseRequest('щось цікаве', { prefs: travelling, base }).cities, ['lviv']);
  });

  it('reads a budget out of the text', () => {
    assert.equal(parseRequest('концерт до 500 грн', { prefs, base }).maxPrice, 500);
  });

  it('uses the Ukrainian city name for web search queries', () => {
    assert.equal(cityLocalName('kharkiv'), 'Харків');
    const queries = buildQueries('kharkiv', 'event', { from: base, to: base, like: ['standup'], interests: [] });
    assert.ok(queries.every((q) => !q.includes('Kharkiv')), 'Ukrainian queries should not use the English name');
  });

  it('looks for a followed act by name, before anything generic', () => {
    const queries = buildQueries('kharkiv', 'event', {
      from: base,
      to: base,
      like: ['standup'],
      interests: [],
      follow: ['Антон Тимошенко'],
    });
    assert.ok(queries[0]?.startsWith('Антон Тимошенко'), queries.join(' | '));
    assert.ok(queries.some((q) => q.includes('афіша')), 'the generic searches still get their turn');
  });
});

/* -------------------------------------------------------------- normalize --- */

describe('normalization', () => {
  it('turns a Karabas JSON-LD event into an Item with a price range', () => {
    const item = fromSchemaEvent(JSON.parse(fixture('karabas-event.json')), { city: 'kharkiv', source: 'karabas' });
    assert.ok(item);
    assert.equal(item.title, 'IVAN LIULENOV');
    assert.equal(item.category, 'concert');
    assert.equal(item.venue, 'Театрально-концертний центр');
    assert.equal(item.address, 'вул. Сумська, 25');
    assert.equal(item.startsAt, '2026-12-08T21:00:00+02:00');
    assert.equal(item.priceMin, 790);
    assert.equal(item.priceMax, 1590);
    assert.equal(item.status, 'scheduled');
    assert.equal(priceText(item), '790–1590 ₴');
  });

  it('marks a sold-out Concert.ua event and reads its category from the type', () => {
    const item = fromSchemaEvent(JSON.parse(fixture('concertua-soldout.json')), { city: 'kharkiv', source: 'concert.ua' });
    assert.ok(item);
    assert.equal(item.status, 'soldout');
    assert.equal(item.category, 'standup');
    assert.equal(priceText(item), 'від 450 ₴');
  });

  it('rejects junk instead of throwing', () => {
    const reasons: string[] = [];
    assert.equal(fromSchemaEvent({ foo: 'bar' }, { city: 'kharkiv', source: 'x', onReject: (r) => reasons.push(r) }), null);
    assert.equal(fromSchemaEvent(null, { city: 'kharkiv', source: 'x' }), null);
    assert.ok(reasons.length > 0, 'onReject should explain why');
  });

  it('maps schema.org statuses', () => {
    assert.equal(statusFrom('https://schema.org/LimitedAvailability'), 'limited');
    assert.equal(statusFrom(undefined, 'https://schema.org/EventCancelled'), 'cancelled');
    assert.equal(statusFrom(undefined, undefined), 'unknown');
  });

  it('never advertises a placeholder price as free', () => {
    const placeholder = makeItem({ city: 'kyiv', title: 'Музей', url: 'https://x/m', source: 'kontramarka', priceMin: 0.01, priceMax: 390 })!;
    assert.equal(priceText(placeholder), 'до 390 ₴');
    const reallyFree = makeItem({ city: 'kyiv', title: 'Лекція', url: 'https://x/l', source: 'websearch', priceMin: 0 })!;
    assert.equal(priceText(reallyFree), 'безкоштовно');
  });

  it('reads prices out of free text', () => {
    assert.deepEqual(parsePriceText('вхід вільний'), { free: true, priceMin: 0 });
    assert.deepEqual(parsePriceText('квитки 300-500 грн'), { priceMin: 300, priceMax: 500 });
    assert.deepEqual(parsePriceText('від 250 грн'), { priceMin: 250 });
  });

  it('parses Kontramarka microdata cards', async () => {
    const html = fixture('kontramarka-card.html');
    const cheerio = await import('cheerio');
    const $ = cheerio.load(html);
    assert.equal($('.cat_item[itemtype*="schema.org/Event"]').length, 1);
    assert.equal($('[itemprop="name"]').first().text().trim(), 'Василь Байдак');
    assert.equal($('meta[itemprop="startDate"]').attr('content'), '2026-10-21T18:30:00+03:00');
    assert.equal(typeof collectKontramarka, 'function');
  });
});

/* ----------------------------------------------------------------- dedupe --- */

describe('dedupe', () => {
  const base = { city: 'kharkiv', startsAt: '2026-10-24T19:00:00+03:00', status: 'scheduled' as const };

  it('merges the same show from three sources and keeps the widest price range', () => {
    const a = makeItem({ ...base, title: 'Антитіла. Вдома 2.0', url: 'https://concert.ua/a', source: 'concert.ua', priceMin: 1450, priceMax: 2750, venue: 'ТКЦ' })!;
    const b = makeItem({ ...base, title: 'АНТИТІЛА — Вдома 2.0 (концерт)', url: 'https://kharkiv.karabas.com/b', source: 'karabas', priceMin: 1200, priceMax: 2000, venue: 'Театрально-концертний центр' })!;
    const c = makeItem({ ...base, title: 'Антитіла Вдома 2.0', url: 'https://kharkiv.kontramarka.ua/c', source: 'kontramarka', priceMin: 1500 })!;
    const merged = dedupe([a, b, c]);
    assert.equal(merged.length, 1, `expected one item, got ${merged.length}`);
    assert.equal(merged[0]!.priceMin, 1200);
    assert.equal(merged[0]!.priceMax, 2750);
    assert.deepEqual([...merged[0]!.sources].sort(), ['concert.ua', 'karabas', 'kontramarka']);
  });

  it('keeps genuinely different events apart', () => {
    const a = makeItem({ ...base, title: 'Антитіла', url: 'https://x/a', source: 'karabas' })!;
    const b = makeItem({ ...base, title: 'Жадан і Собаки', url: 'https://x/b', source: 'karabas' })!;
    assert.equal(dedupe([a, b]).length, 2);
  });

  it('lets the worse status win when sources disagree', () => {
    const a = makeItem({ ...base, title: 'Тест', url: 'https://x/a', source: 'karabas', status: 'scheduled' })!;
    const b = makeItem({ ...base, title: 'Тест', url: 'https://x/b', source: 'kontramarka', status: 'soldout' })!;
    assert.equal(dedupe([a, b])[0]!.status, 'soldout');
  });

  it('fingerprints the facts worth re-notifying about', () => {
    const a = makeItem({ ...base, title: 'Тест', url: 'https://x/a', source: 'karabas', priceMin: 300 })!;
    assert.equal(fingerprint(a), fingerprint({ ...a, description: 'changed blurb' }));
    assert.notEqual(fingerprint(a), fingerprint({ ...a, priceMin: 400 }));
    assert.notEqual(fingerprint(a), fingerprint({ ...a, status: 'soldout' }));
  });
});

/* ------------------------------------------------------------------- rank --- */

describe('ranking', () => {
  const query = parseRequest('this weekend, I like stand-up, no classical', { prefs, base: '2026-10-20' });
  const common = { city: 'kharkiv', startsAt: '2026-10-24T19:00:00+03:00', status: 'scheduled' as const };

  it('puts a followed act first', () => {
    const followed = makeItem({ ...common, title: 'Курган і Agregat', url: 'https://x/1', source: 'concert.ua', category: 'concert', priceMin: 900 })!;
    const other = makeItem({ ...common, title: 'Хтось інший', url: 'https://x/2', source: 'concert.ua', category: 'standup', priceMin: 300 })!;
    const ranked = rank([other, followed], { query, prefs });
    assert.equal(ranked.items[0]!.title, 'Курган і Agregat');
    assert.ok(ranked.items[0]!.reasons?.some((r) => r.includes('follow')));
  });

  it('drops disliked and over-budget items, and says why', () => {
    const classical = makeItem({ ...common, title: 'Класична музика при свічках', url: 'https://x/3', source: 'karabas', category: 'concert', priceMin: 400 })!;
    const expensive = makeItem({ ...common, title: 'Дорогий концерт', url: 'https://x/4', source: 'karabas', category: 'concert', priceMin: 5000 })!;
    const ranked = rank([classical, expensive], { query, prefs });
    assert.equal(ranked.items.length, 0);
    assert.equal(ranked.dropped.length, 2);
    assert.ok(ranked.dropped.some((d) => d.why.includes('disliked')));
    assert.ok(ranked.dropped.some((d) => d.why.includes('over budget')));
  });

  it('never drops a followed act for price or genre', () => {
    const item = makeItem({ ...common, title: 'Курган і Agregat грають класику', url: 'https://x/5', source: 'karabas', category: 'concert', priceMin: 9000 })!;
    assert.equal(rank([item], { query, prefs }).items.length, 1);
  });

  it('matches a category tag on the category or title, not on a long blurb', () => {
    const play = makeItem({ city: 'kharkiv', title: 'Love (Театр для людей)', url: 'https://x/6', source: 'karabas', category: 'theatre', description: 'романтична комедія про двох людей' })!;
    assert.equal(matchesTag(play, 'standup'), false);
    const gig = makeItem({ city: 'kharkiv', title: 'Відкритий мікрофон', url: 'https://x/7', source: 'karabas', category: 'other' })!;
    assert.equal(matchesTag(gig, 'standup'), true);
  });

  it('matches follow names inside titles', () => {
    const item = makeItem({ city: 'kharkiv', title: 'Антон Тимошенко. Новий стендап', url: 'https://x/8', source: 'karabas' })!;
    assert.equal(matchesFollow(item, 'Антон Тимошенко'), true);
    assert.equal(matchesFollow(item, 'Хтось Інший'), false);
  });

  it('groups by day, earliest day first', () => {
    const d1 = makeItem({ city: 'kharkiv', title: 'A', url: 'https://x/9', source: 's', startsAt: '2026-10-25T19:00:00+03:00' })!;
    const d2 = makeItem({ city: 'kharkiv', title: 'B', url: 'https://x/10', source: 's', startsAt: '2026-10-23T19:00:00+03:00' })!;
    assert.deepEqual(groupByDay([d1, d2]).map((g) => g.day), ['2026-10-23', '2026-10-25']);
  });
});

/* ----------------------------------------------------------------- render --- */

describe('render', () => {
  const query = parseRequest('', { prefs, base: '2026-10-20', from: '2026-10-23', to: '2026-10-25' });

  it('numbers items in the order they are shown, which is what a "🔔 3" reply means', () => {
    const items = [
      makeItem({ city: 'kharkiv', title: 'Later but better', url: 'https://x/a', source: 's', startsAt: '2026-10-25T19:00:00+03:00', score: 99 })!,
      makeItem({ city: 'kharkiv', title: 'Earlier', url: 'https://x/b', source: 's', startsAt: '2026-10-23T19:00:00+03:00', score: 1 })!,
    ];
    const { text, ordered } = buildDigest({ title: 'T', query, items, format: 'text' });
    assert.deepEqual(ordered.map((i) => i.title), ['Earlier', 'Later but better']);
    assert.ok(text.indexOf('1. ') < text.indexOf('2. '));
    assert.ok(text.indexOf('Earlier') < text.indexOf('Later but better'));
  });

  it('badges sold-out and cancelled events', () => {
    const items = [makeItem({ city: 'kharkiv', title: 'Gone', url: 'https://x/c', source: 's', startsAt: '2026-10-24T19:00:00+03:00', status: 'soldout' })!];
    assert.ok(buildDigest({ title: 'T', query, items, format: 'text' }).text.includes('КВИТКІВ НЕМАЄ'));
  });

  it('escapes HTML coming from a site', () => {
    const items = [makeItem({ city: 'kharkiv', title: 'Rock & <b>Roll</b>', url: 'https://x/d?a=1&b=2', source: 's', startsAt: '2026-10-24T19:00:00+03:00' })!];
    const html = buildDigest({ title: 'T', query, items, format: 'html' }).text;
    assert.ok(html.includes('Rock &amp; &lt;b&gt;Roll&lt;/b&gt;'));
    assert.ok(html.includes('href="https://x/d?a=1&amp;b=2"'));
  });

  it('shows places as a flat list with no time', () => {
    const place = makeItem({ city: 'kharkiv', kind: 'place', title: 'Kofein Lab', url: 'https://x/e', source: 'websearch', category: 'cafe', address: 'вул. Сумська, 11' })!;
    const text = buildDigest({ title: 'Places', query, items: [place], format: 'text' }).text;
    assert.ok(text.includes('вул. Сумська, 11'));
    assert.ok(!text.includes('date TBA'));
  });

  it('splits long messages on blank lines', () => {
    const chunks = splitForTelegram(Array.from({ length: 200 }, (_, i) => `block ${i}`).join('\n\n'), 500);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((c) => c.length <= 500));
  });
});

/* --------------------------------------------------------------- telegram --- */

describe('telegram posts', () => {
  const base = '2026-10-20';

  it('finds dates, times, venues and prices in a real-looking post', () => {
    const text = [
      '🎤 СТЕНДАП КОНЦЕРТ',
      'Антон Тимошенко з новою програмою',
      '25 жовтня, 19:00',
      '📍 вул. Сумська, 25, ХНАТОБ',
      'Квитки 400 грн',
    ].join('\n');
    assert.equal(findDate(text, base), '2026-10-25');
    assert.equal(findTime(text), '19:00');
    assert.ok(findVenue(text)?.includes('Сумська'));

    const item = parsePost({ id: 42, channel: 'kharkiv_standup', text }, { city: 'kharkiv', base, tz: TZ });
    assert.ok(item);
    assert.equal(item.category, 'standup');
    assert.equal(item.startsAt, '2026-10-25T19:00:00+02:00');
    assert.equal(item.priceMin, 400);
    assert.equal(item.confidence, 'low');
    assert.equal(item.source, 'telegram:@kharkiv_standup');
    assert.equal(item.url, 'https://t.me/kharkiv_standup/42');
  });

  it('understands сьогодні and завтра', () => {
    assert.equal(findDate('сьогодні о 20:00 вечірка', base), base);
    assert.equal(findDate('завтра відкриття виставки', base), addDays(base, 1));
  });

  it('assumes next year for a date that has already passed', () => {
    assert.equal(findDate('5 січня великий концерт', base), '2027-01-05');
  });

  it('skips posts with no date', () => {
    assert.equal(parsePost({ id: 1, channel: 'c', text: 'Просто привіт усім нашим підписникам, читайте нас' }, { city: 'kharkiv', base, tz: TZ }), null);
  });

  it('marks a cancelled post as cancelled', () => {
    const item = parsePost({ id: 2, channel: 'c', text: 'Концерт 25 жовтня скасовано, повернення квитків' }, { city: 'kharkiv', base, tz: TZ });
    assert.equal(item?.status, 'cancelled');
  });
});

/* -------------------------------------------------------------- websearch --- */

describe('web search ingest', () => {
  it('turns a search result into a place', () => {
    const item = resultToItem(
      { title: 'Kofein Lab — нова кав’ярня', url: 'https://example.com/k', snippet: 'Спешелті кава, вініл. вул. Сумська, 11' },
      { city: 'kharkiv', kind: 'place', base: '2026-10-20', tz: TZ },
    );
    assert.ok(item);
    assert.equal(item.kind, 'place');
    assert.equal(item.category, 'cafe');
    assert.equal(item.confidence, 'low');
  });

  it('refuses an event with no date', () => {
    const item = resultToItem({ title: 'Якась подія', url: 'https://example.com/e' }, { city: 'kharkiv', kind: 'event', base: '2026-10-20', tz: TZ });
    assert.equal(item, null);
  });
});

/* ------------------------------------------------------------ preferences --- */

describe('preference commands', () => {
  const current = loadPrefs();
  const check = (text: string, expect: Partial<{ understood: boolean; changed: boolean; contains: string }>) => {
    const edit = applyPrefsCommand(text, current);
    if (expect.understood !== undefined) assert.equal(edit.understood, expect.understood, `"${text}" understood?`);
    if (expect.changed !== undefined) assert.equal(edit.changes.length > 0, expect.changed, `"${text}" changed? got ${JSON.stringify(edit.changes)}`);
    if (expect.contains) assert.ok(edit.changes.join(' ').includes(expect.contains), `"${text}" → ${JSON.stringify(edit.changes)}`);
    return edit;
  };

  it('adds and removes favourites', () => {
    check('add jazz to favourites', { understood: true, changed: true, contains: 'улюблене + джаз' });
    check('remove concert from favourites', { understood: true, changed: true, contains: 'улюблене − концерти' });
    check('add stand-up to favourites', { understood: true, changed: false });
  });

  it('records dislikes and drops them from favourites', () => {
    const edit = check("I don't like opera", { understood: true, changed: true, contains: 'небажане + опера' });
    assert.ok(!edit.prefs.favourite_categories.includes('opera'));
  });

  it('follows and unfollows people', () => {
    check('follow Latexfauna', { understood: true, changed: true, contains: 'стежу за «Latexfauna»' });
    check('unfollow Курган і Agregat', { understood: true, changed: true, contains: 'більше не стежу' });
  });

  it('sets a budget and clears it', () => {
    assert.equal(applyPrefsCommand('max price 800', current).prefs.max_ticket_price, 800);
    assert.equal(applyPrefsCommand('no limit', current).prefs.max_ticket_price, null);
  });

  it('sets a trip from "I\'m in Lviv next week"', () => {
    const edit = applyPrefsCommand("I'm in Lviv next week", current);
    assert.equal(edit.prefs.trip?.city, 'lviv');
    assert.ok(edit.prefs.trip!.from > '2026-01-01');
  });

  it('changes home and watch cities', () => {
    assert.equal(applyPrefsCommand('home city is Kyiv', current).prefs.home_city, 'kyiv');
    assert.ok(applyPrefsCommand('watch Odesa', current).prefs.watch_cities.includes('odesa'));
  });

  /**
   * Every Ukrainian phrase here was dead for as long as the rules used `\b`,
   * which is ASCII-only and therefore never finds a boundary before "д".
   * The bot advertises these exact phrasings in /help, so they are checked.
   */
  it('understands the Ukrainian phrasings the bot suggests', () => {
    check('додай джаз до улюблених', { understood: true, changed: true, contains: 'улюблене + джаз' });
    check('не люблю балет', { understood: true, changed: true, contains: 'небажане + балет' });
    // "класичну" is the inflected form of a tag already in the fixture's dislikes
    check('не люблю класичну музику', { understood: true, changed: false });
    check('слідкуй за Latexfauna', { understood: true, changed: true, contains: 'стежу за «Latexfauna»' });
    check('максимум 800 грн', { understood: true, changed: true, contains: '800' });
    check('прибери стендап з улюблених', { understood: true, changed: true, contains: 'улюблене − стендап' });
    check('додай фолк до інтересів', { understood: true, changed: true, contains: 'інтереси + фолк' });
  });

  it('reads Ukrainian cities and trips', () => {
    assert.equal(applyPrefsCommand('моє місто Одеса', current).prefs.home_city, 'odesa');
    assert.ok(applyPrefsCommand('слідкуй за Львовом', current).prefs.watch_cities.includes('lviv'));
    assert.equal(applyPrefsCommand('я у Львові наступного тижня', current).prefs.trip?.city, 'lviv');
  });

  it('folds an inflected tag onto the same key as its dictionary form', () => {
    assert.equal(canonicalTag('класичну'), 'classical');
    assert.equal(canonicalTag('класична'), 'classical');
  });

  it('switches to places when the request is Ukrainian', () => {
    const base = '2026-10-21';
    assert.deepEqual(parseRequest('тільки місця у Львові', { prefs, base }).kinds, ['place']);
    assert.ok(parseRequest('нові кафе в Харкові', { prefs, base }).kinds.includes('place'));
    assert.deepEqual(parseRequest('концерти на вихідних', { prefs, base }).kinds, ['event']);
  });

  it('ignores things that are not preference changes', () => {
    check("what's on tonight in Kharkiv?", { understood: false, changed: false });
    check('що цікавого у Харкові на вихідних', { understood: false, changed: false });
  });
});

/* ------------------------------------------------------------------ store --- */

const log = makeLogger('test');

/** Open a store, use it, always close it. */
async function withTestStore<T>(fn: (store: StoreType) => Promise<T>): Promise<T> {
  const store = await Store.open();
  try {
    return await fn(store);
  } finally {
    await store.close();
  }
}

describe('store', () => {
  const item = makeItem({ city: 'kharkiv', title: 'Store test gig', url: 'https://x/store', source: 'concert.ua', startsAt: '2026-11-01T19:00:00+02:00', priceMin: 300, status: 'scheduled' })!;

  it('tracks what was sent separately for each person', async () => {
    await withTestStore(async (store) => {
      assert.equal((await store.decideSend('aaa', item)).reason, 'new');
      await store.recordSent('aaa', [item]);
      assert.equal((await store.decideSend('aaa', item)).send, false);
      // a different user has not seen it yet
      assert.equal((await store.decideSend('bbb', item)).reason, 'new');
    });
  });

  it('re-sends only when the date, status or price changed', async () => {
    await withTestStore(async (store) => {
      await store.recordSent('ccc', [item]);
      assert.equal((await store.decideSend('ccc', { ...item, startsAt: '2026-11-02T19:00:00+02:00' })).reason, 'new date');
      assert.equal((await store.decideSend('ccc', { ...item, status: 'soldout' })).reason, 'sold out');
      assert.equal((await store.decideSend('ccc', { ...item, status: 'limited' })).reason, 'few tickets left');
      assert.equal((await store.decideSend('ccc', { ...item, priceMin: 500 })).reason, 'price changed');
    });
  });

  it('remembers which items a message was about, per chat', async () => {
    await withTestStore(async (store) => {
      await store.recordMessage('42', 7, [item]);
      assert.deepEqual((await store.itemsForMessage('42', 7)).map((i: Item) => i.title), ['Store test gig']);
      assert.deepEqual(await store.itemsForMessage('43', 7), [], 'another chat must not see it');
      assert.deepEqual((await store.lastItemsFor('42')).map((i: Item) => i.title), ['Store test gig']);
    });
  });

  it('keeps reminders per person and fires each mark once', async () => {
    await withTestStore(async (store) => {
      const soon = makeItem({ ...item, title: 'Soon', url: 'https://x/soon', startsAt: new Date(Date.now() + 20 * 3600_000).toISOString() })!;
      assert.equal(await store.addReminder('u1', soon), 'added');
      assert.equal(await store.addReminder('u1', soon), 'exists');
      // the same event, a different person: a separate reminder
      assert.equal(await store.addReminder('u2', soon), 'added');
      assert.equal((await store.listReminders('u1')).length, 1);
      assert.equal((await store.listReminders()).length, 2);

      const due = await store.dueReminders();
      assert.equal(due.length, 2);
      assert.ok(due.every((d: { which: string }) => d.which === '1d'));
      for (const d of due) await store.markReminderFired(d.row.id, '1d');
      assert.equal((await store.dueReminders()).length, 0);

      const veryS = makeItem({ ...item, title: 'Very soon', url: 'https://x/vs', startsAt: new Date(Date.now() + 2 * 3600_000).toISOString() })!;
      await store.addReminder('u1', veryS);
      assert.equal((await store.dueReminders())[0]!.which, '3h');

      const past = makeItem({ ...item, title: 'Over', url: 'https://x/over', startsAt: new Date(Date.now() - 5 * 3600_000).toISOString() })!;
      await store.addReminder('u1', past);
      assert.ok(!(await store.dueReminders()).some((d: { row: { title: string } }) => d.row.title === 'Over'), 'past events must not fire');

      await store.cancelReminder('u1', veryS.id);
      assert.ok(!(await store.listReminders('u1')).some((r: { item_id: string }) => r.item_id === veryS.id));
    });
  });

  it('rate limits per person per hour', async () => {
    await withTestStore(async (store) => {
      for (let i = 1; i <= 3; i++) {
        const hit = await store.hitRateLimit('rl', 3);
        assert.equal(hit.allowed, true, `request ${i} should be allowed`);
      }
      const over = await store.hitRateLimit('rl', 3);
      assert.equal(over.allowed, false);
      assert.equal(over.used, 4);
      // a different person has their own budget
      assert.equal((await store.hitRateLimit('rl2', 3)).allowed, true);
    });
  });

  it('caches a scrape and lets it expire', async () => {
    await withTestStore(async (store) => {
      await store.putCache('k1', [item], 60);
      assert.equal((await store.getCache('k1'))?.length, 1);
      assert.equal(await store.getCache('nope'), null);
      await store.putCache('k2', [item], 0);
      assert.equal(await store.getCache('k2'), null, 'a zero TTL entry is already stale');
      await store.pruneCache();
    });
  });

  it('keeps small state like the Telegram update offset', async () => {
    await withTestStore(async (store) => {
      await store.setState('offset', '17');
      assert.equal(await store.getState('offset'), '17');
      await store.setState('offset', '18');
      assert.equal(await store.getState('offset'), '18');
      assert.equal(await store.getState('nope'), null);
    });
  });
});

/* ------------------------------------------------------------------ users --- */

describe('users', () => {
  it('registers a new user in the city onboarding stage', async () => {
    await withTestStore(async (store) => {
      const { user, created } = await registerUser(store, { chatId: '1001', username: 'someone' });
      assert.equal(created, true);
      assert.equal(user.row.stage, 'city');
      const again = await registerUser(store, { chatId: '1001' });
      assert.equal(again.created, false);
    });
  });

  it('does not hand the operator\'s follow list to new users', () => {
    const defaults = defaultPrefs('lviv');
    assert.deepEqual(defaults.follow, []);
    assert.deepEqual(defaults.watch_cities, []);
    assert.equal(defaults.home_city, 'lviv');
    // defaultPrefs is the operator's own profile, so their taste is still there
    assert.ok(defaults.favourite_categories.includes('standup'));
  });

  it('gives a brand new user an empty taste model, not the operator\'s', async () => {
    const blank = newUserPrefs('lviv');
    assert.equal(blank.home_city, 'lviv');
    assert.deepEqual(blank.favourite_categories, []);
    assert.deepEqual(blank.disliked_categories, []);
    assert.deepEqual(blank.interests, []);
    assert.deepEqual(blank.follow, []);
    assert.equal(blank.max_ticket_price, null);
    // ...and that is what registration stores
    await withTestStore(async (store) => {
      const { user } = await registerUser(store, { chatId: '1009' });
      assert.deepEqual(user.prefs.favourite_categories, []);
      assert.equal(user.prefs.max_ticket_price, null);
    });
  });

  it('keeps the users row and the stored prefs agreeing about the city', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '1002', city: 'kharkiv' });
      const user = (await getUser(store, '1002'))!;
      const moved = await saveUserPrefs(store, user, { ...user.prefs, home_city: 'odesa' });
      assert.equal(moved.city, 'odesa');
      const reloaded = (await getUser(store, '1002'))!;
      assert.equal(reloaded.city, 'odesa');
      assert.equal(reloaded.prefs.home_city, 'odesa');
    });
  });

  it('lists only onboarded, unblocked, opted-in users', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '1101', city: 'kharkiv' });   // onboarded
      await registerUser(store, { chatId: '1102' });                     // still choosing a city
      await registerUser(store, { chatId: '1103', city: 'kharkiv' });
      await store.setBlocked('1103', true);

      const active = (await allUsers(store)).map((u) => u.chatId);
      assert.ok(active.includes('1101'));
      assert.ok(!active.includes('1102'), 'mid-onboarding users are skipped');
      assert.ok(!active.includes('1103'), 'blocked users are skipped');

      await store.setOptIn('1101', 'weekend_digest', false);
      const weekend = (await allUsers(store, 'weekend_digest')).map((u) => u.chatId);
      assert.ok(!weekend.includes('1101'));
      assert.ok((await allUsers(store, 'weekly_digest')).some((u) => u.chatId === '1101'));
    });
  });

  it('uses the trip city while a trip is on, and watch cities on request', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '1200', city: 'kharkiv' });
      const user = (await getUser(store, '1200'))!;
      const travelling = await saveUserPrefs(store, user, {
        ...user.prefs,
        watch_cities: ['kyiv'],
        trip: { city: 'lviv', from: '2026-10-19', to: '2026-10-25' },
      });
      assert.deepEqual(citiesFor(travelling, '2026-10-20'), ['lviv']);
      assert.deepEqual(citiesFor(travelling, '2026-11-20'), ['kharkiv']);
      assert.deepEqual(citiesFor(travelling, '2026-11-20', true), ['kharkiv', 'kyiv']);
    });
  });
});

/* ----------------------------------------------------------------- fanout --- */

describe('fanout', () => {
  const window = { from: '2026-10-23', to: '2026-10-25', label: 'this weekend' };
  const standup = makeItem({ city: 'kharkiv', title: 'Антон Тимошенко. Стендап', url: 'https://x/su', source: 'concert.ua', category: 'standup', startsAt: '2026-10-24T19:00:00+03:00', priceMin: 400, status: 'scheduled' })!;
  const classical = makeItem({ city: 'kharkiv', title: 'Класична музика при свічках', url: 'https://x/cl', source: 'karabas', category: 'concert', startsAt: '2026-10-24T18:00:00+03:00', priceMin: 500, status: 'scheduled' })!;

  /** Pre-seed the cache so the fan-out runs without touching the network. */
  async function seed(store: StoreType, items = [standup, classical]) {
    const key = cacheKey({ city: 'kharkiv', from: window.from, to: window.to, kinds: ['event'] }, ALL_SOURCE_NAMES);
    await store.putCache(key, items, 600);
  }

  it('scrapes a city once and tailors the result to each user', async () => {
    await withTestStore(async (store) => {
      await seed(store);
      // two users in the same city with opposite taste
      await registerUser(store, { chatId: '2001', city: 'kharkiv' });
      await registerUser(store, { chatId: '2002', city: 'kharkiv' });
      const a = (await getUser(store, '2001'))!;
      const b = (await getUser(store, '2002'))!;
      await saveUserPrefs(store, a, { ...a.prefs, favourite_categories: ['standup'], disliked_categories: ['classical'] });
      await saveUserPrefs(store, b, { ...b.prefs, favourite_categories: ['classical'], disliked_categories: ['standup'] });

      const sent = new Map<string, Item[]>();
      const result = await fanout({
        store,
        log,
        optIn: 'weekend_digest',
        window,
        onlyChats: ['2001', '2002'],
        dryRun: true,
        title: () => 'Weekend',
        select: (user, ranked) => {
          sent.set(user.chatId, ranked);
          return ranked;
        },
      });

      assert.equal(result.cacheHits, 1, 'the city came from the cache');
      assert.equal(result.scrapes, 0, 'no scraping in this test');
      assert.equal(result.recipients, 2);
      assert.equal(sent.get('2001')?.[0]?.category, 'standup');
      assert.ok(!sent.get('2001')?.some((i) => i.title.includes('Класична')), 'A dislikes classical');
      assert.ok(!sent.get('2002')?.some((i) => i.category === 'standup'), 'B dislikes stand-up');
    });
  });

  it('skips people who muted the job', async () => {
    await withTestStore(async (store) => {
      await seed(store);
      await registerUser(store, { chatId: '2100', city: 'kharkiv' });
      await store.setOptIn('2100', 'weekend_digest', false);
      const result = await fanout({ store, log, optIn: 'weekend_digest', window, onlyChats: ['2100'], dryRun: true, title: () => 'W' });
      assert.equal(result.users, 0);
    });
  });

  it('does not repeat an item it already sent that person', async () => {
    await withTestStore(async (store) => {
      await seed(store, [standup]);
      await registerUser(store, { chatId: '2200', city: 'kharkiv' });
      await store.recordSent('2200', [standup]);
      const result = await fanout({ store, log, optIn: 'weekly_digest', window, onlyChats: ['2200'], dryRun: true, title: () => 'W' });
      assert.equal(result.items, 0, 'already delivered');
    });
  });
});

/* ----------------------------------------------------------- bot handlers --- */

describe('bot handlers', () => {
  /** Capture what the bot would say (dry-run sends print to stdout). */
  async function say(store: StoreType, chatId: string, text: string, extra: Record<string, unknown> = {}): Promise<string> {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout as { write: unknown }).write = (chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      await handleMessage({ store, log, dryRun: true }, {
        message_id: Math.floor(Math.random() * 100000),
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: 'private' },
        text,
        ...extra,
      } as never);
    } finally {
      (process.stdout as { write: unknown }).write = original;
    }
    return chunks.join('');
  }

  it('onboards a new user by asking for a city, then remembers it', async () => {
    await withTestStore(async (store) => {
      const hello = await say(store, '3001', '/start');
      assert.ok(hello.includes('У якому ти місті'), hello.slice(0, 200));
      assert.equal((await store.getUser('3001'))?.stage, 'city');

      const picked = await say(store, '3001', 'Львів');
      assert.ok(picked.includes('Львів'), picked.slice(0, 200));
      const row = await store.getUser('3001');
      assert.equal(row?.stage, null);
      assert.equal(row?.city, 'lviv');
    });
  });

  it('asks again when the city is not configured', async () => {
    await withTestStore(async (store) => {
      await say(store, '3002', '/start');
      const reply = await say(store, '3002', 'Atlantis');
      assert.ok(reply.includes('поки не знаю'), reply.slice(0, 200));
      assert.equal((await store.getUser('3002'))?.stage, 'city');
    });
  });

  it('learns taste from a plain sentence', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3003', city: 'kharkiv' });
      const reply = await say(store, '3003', 'add jazz to favourites');
      assert.ok(reply.includes('улюблене + джаз'), reply.slice(0, 200));
      const user = await getUser(store, '3003');
      assert.ok(user?.prefs.favourite_categories.includes('jazz'));
    });
  });

  it('mutes and unmutes a digest', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3004', city: 'kharkiv' });
      await say(store, '3004', '/mute weekend');
      assert.equal((await store.getUser('3004'))?.weekend_digest, 0);
      await say(store, '3004', '/unmute weekend');
      assert.equal((await store.getUser('3004'))?.weekend_digest, 1);
    });
  });

  it('unsubscribes on /stop and comes back on /start', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3005', city: 'kharkiv' });
      await say(store, '3005', '/stop');
      assert.equal((await store.getUser('3005'))?.blocked, 1);
      await say(store, '3005', '/start');
      assert.equal((await store.getUser('3005'))?.blocked, 0);
    });
  });

  it('explains itself for /help and unknown commands', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3006', city: 'kharkiv' });
      assert.ok((await say(store, '3006', '/help')).includes('/weekend'));
      assert.ok((await say(store, '3006', '/nonsense')).includes('Не знаю команди'));
    });
  });

  it('resolves a 🔔 reply to the right item of a digest', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3007', city: 'kharkiv' });
      const a = makeItem({ city: 'kharkiv', title: 'First', url: 'https://x/1', source: 's', startsAt: '2026-11-01T19:00:00+02:00' })!;
      const b = makeItem({ city: 'kharkiv', title: 'Second', url: 'https://x/2', source: 's', startsAt: '2026-11-02T19:00:00+02:00' })!;
      await store.recordMessage('3007', 555, [a, b]);

      const ambiguous = await say(store, '3007', '🔔', { reply_to_message: { message_id: 555 } });
      assert.ok(ambiguous.includes('Яка саме'), ambiguous.slice(0, 200));

      const chosen = await say(store, '3007', '🔔 2', { reply_to_message: { message_id: 555 } });
      assert.ok(chosen.includes('Second'), chosen.slice(0, 200));
    });
  });

  /** Capture what a tap on an inline button produces. */
  async function tap(store: StoreType, chatId: string, data: string): Promise<string> {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout as { write: unknown }).write = (chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      await handleCallback({ store, log, dryRun: true }, {
        id: 'cb',
        data,
        message: { message_id: 42, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' } },
        from: { id: Number(chatId) },
      } as never);
    } finally {
      (process.stdout as { write: unknown }).write = original;
    }
    return chunks.join('');
  }

  it('offers /settings as a panel of buttons', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3010', city: 'kharkiv' });
      const panel = await say(store, '3010', '/settings');
      assert.ok(panel.includes('Налаштування'), panel.slice(0, 300));
      assert.ok(panel.includes('(set:weekend_digest)'), 'every digest needs its own button');
      assert.ok(panel.includes('(set:city)') && panel.includes('(set:prefs)'), panel.slice(0, 600));
    });
  });

  it('toggles a digest from the panel and redraws it in place', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3011', city: 'kharkiv' });
      const off = await tap(store, '3011', 'set:weekend_digest');
      assert.equal((await store.getUser('3011'))?.weekend_digest, 0);
      assert.ok(off.includes('edit 42'), 'the panel is rewritten, not reposted');
      assert.ok(off.includes('❌ 🎉 Вихідні'), off.slice(0, 400));

      await tap(store, '3011', 'set:weekend_digest');
      assert.equal((await store.getUser('3011'))?.weekend_digest, 1);
    });
  });

  it('changes the city from the panel', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3012', city: 'kharkiv' });
      const picker = await tap(store, '3012', 'set:city');
      assert.ok(picker.includes('(city:lviv)'), picker.slice(0, 400));
      await tap(store, '3012', 'city:lviv');
      assert.equal((await store.getUser('3012'))?.city, 'lviv');
    });
  });

  it('asks before unsubscribing from a button', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3013', city: 'kharkiv' });
      const confirm = await tap(store, '3013', 'set:stop');
      assert.ok(confirm.includes('Відписатися?'), confirm.slice(0, 300));
      assert.equal((await store.getUser('3013'))?.blocked, 0, 'one tap must not unsubscribe anyone');
      await tap(store, '3013', 'set:stop!');
      assert.equal((await store.getUser('3013'))?.blocked, 1);
    });
  });

  it('publishes a command menu that the router actually answers', async () => {
    const source = readFileSync(new URL('../src/bot-handlers.ts', import.meta.url), 'utf8');
    assert.ok(BOT_COMMANDS.length > 0);
    for (const { command, description } of BOT_COMMANDS) {
      assert.ok(source.includes(`case '/${command}'`), `/${command} is in the menu but the router ignores it`);
      assert.ok(/^[a-z0-9_]{1,32}$/.test(command), `"${command}" is not a valid Telegram command name`);
      assert.ok(description.length <= 256, `the description of /${command} is too long for Telegram`);
    }
  });

  it('answers "покажи налаштування" with the panel instead of a search', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3014', city: 'kharkiv' });
      const reply = await say(store, '3014', 'покажи налаштування');
      assert.ok(reply.includes('Налаштування'), reply.slice(0, 300));
      assert.ok(!reply.includes('Шукаю'), 'it must not kick off a scrape');
    });
  });

  it('reads the bell with and without an index', () => {
    assert.deepEqual(parseBell('🔔'), { bell: true, index: undefined });
    assert.deepEqual(parseBell('🔔 3'), { bell: true, index: 3 });
    assert.equal(parseBell('нагадай').bell, true);
    assert.equal(parseBell('нагадай 2').index, 2);
    assert.equal(parseBell('what is on').bell, false);
  });

  it('is open to everyone unless an allowlist is configured', () => {
    assert.equal(isAllowed('999'), true);
  });
});

/* ------------------------------------------------------------------ config --- */

describe('config', () => {
  it('validates config.example.yaml and exposes every city', () => {
    const cfg = loadConfig();
    assert.ok(Object.keys(cfg.cities).length >= 5);
    assert.equal(cfg.timezone, 'Europe/Kyiv');
    assert.equal(cfg.cities['kharkiv']!.concertua!.slug, 'kharkiv');
    assert.equal(cfg.cities['kyiv']!.kontramarka!.subdomain, '', 'Kyiv is on the bare kontramarka domain');
  });

  it('rejects a broken config with a readable message', async () => {
    const { ConfigSchema } = await import('../src/schemas.ts');
    const result = ConfigSchema.safeParse({ http: { retries: 'lots' } });
    assert.equal(result.success, false);
  });
});

await run();
