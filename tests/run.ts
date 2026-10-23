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
const { normText, stemText, isoInZone, localDate, localTime, addDays, today, weekdayOf, titleKey } = await import('../src/util.ts');
const { classify, canonicalTag, expandTag } = await import('../src/categories.ts');
const { parseDateRange, parseRequest, weekendRange, thisWeekRange, nextWeekRange, splitNegations } = await import('../src/request.ts');
const { fromSchemaEvent, makeItem, priceText, parsePriceText, statusFrom } = await import('../src/normalize.ts');
const { dedupe, fingerprint } = await import('../src/dedupe.ts');
const { rank, matchesFollow, matchesTag, groupByDay } = await import('../src/rank.ts');
const { buildDigest, buildMessages, renderReminders } = await import('../src/render.ts');
const { loadConfig, loadPrefs, resolveCity, cityLocalName } = await import('../src/config.ts');
const { applyPrefsCommand, describePrefs } = await import('../src/prefs-engine.ts');
const { tagLabel } = await import('../src/categories.ts');
const { PreferencesSchema } = await import('../src/types.ts');
const { parsePost, findDate, findTime, findVenue } = await import('../scripts/telegram.ts');
const { resultToItem, buildQueries } = await import('../scripts/websearch.ts');
const { collect: collectKontramarka } = await import('../scripts/kontramarka.ts');
const { Store } = await import('../src/db.ts');
const { splitForTelegram } = await import('../src/telegram-api.ts');
const { registerUser, getUser, saveUserPrefs, allUsers, citiesFor, defaultPrefs, newUserPrefs } = await import('../src/users.ts');
const { cacheKey } = await import('../src/cache.ts');
const { fanout } = await import('../src/fanout.ts');
const { handleMessage, handleCallback, handleReaction, parseBell, isHeart, isAllowed, BOT_COMMANDS } = await import(
  '../src/bot-handlers.ts'
);
const { deliver } = await import('../src/deliver.ts');
const { makeLogger } = await import('../src/log.ts');
const { ALL_SOURCE_NAMES, runPipeline } = await import('../src/pipeline.ts');
const { politeFetch, HttpError } = await import('../src/http.ts');
const { pager, safeCollect } = await import('../src/source.ts');
const { eventsFromJsonLd } = await import('../src/jsonld.ts');
const { collect: collectKarabas } = await import('../scripts/karabas.ts');

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

  it('canonicalises an inflected Ukrainian taste word', () => {
    assert.equal(canonicalTag('виставки'), 'exhibition');
    assert.equal(canonicalTag('класичну'), 'classical');
    assert.equal(canonicalTag('театри'), 'theatre');
    assert.equal(canonicalTag('вечірки'), 'party');
    // free text that names nothing we know is left exactly as written
    assert.equal(canonicalTag('сучасне мистецтво'), 'сучасне мистецтво');
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

  it('keeps only what the person likes, and says how much it hid', () => {
    const mine = makeItem({ ...common, title: 'Відкритий мікрофон', url: 'https://x/t1', source: 'karabas', category: 'standup', priceMin: 200 })!;
    const free = makeItem({ ...common, title: 'Безкоштовна лекція про котиків', url: 'https://x/t2', source: 'karabas', category: 'lecture', free: true, description: 'Приходьте', sources: ['karabas', 'concert.ua'] })!;
    const theatre = makeItem({ ...common, title: 'Вистава', url: 'https://x/t3', source: 'karabas', category: 'theatre', priceMin: 300 })!;
    // a free event on two sources used to outscore a category chosen by hand
    const ranked = rank([free, theatre, mine], { query, prefs, tasteFloor: 0 });
    assert.deepEqual(ranked.items.map((i) => i.title), ['Відкритий мікрофон']);
    assert.equal(ranked.toppedUp, 0);
    assert.equal(ranked.dropped.filter((d) => d.why === 'not in their taste').length, 2);
  });

  it('pads a thin list rather than sending an almost empty one, and owns up to it', () => {
    const theatre = makeItem({ ...common, title: 'Вистава', url: 'https://x/p1', source: 'karabas', category: 'theatre', priceMin: 300 })!;
    const kids = makeItem({ ...common, title: 'Дітям', url: 'https://x/p2', source: 'karabas', category: 'kids', priceMin: 100 })!;
    const ranked = rank([theatre, kids], { query, prefs, tasteFloor: 2 });
    assert.equal(ranked.items.length, 2, 'nothing of theirs was on, so the next best came back');
    assert.equal(ranked.toppedUp, 2);
  });

  it('leaves everything in when there is no taste to filter by', () => {
    const blank = PreferencesSchema.parse({ home_city: 'kharkiv' });
    const plain = parseRequest('', { prefs: blank, base: '2026-10-20' });
    const theatre = makeItem({ ...common, title: 'Вистава', url: 'https://x/n1', source: 'karabas', category: 'theatre', priceMin: 300 })!;
    const ranked = rank([theatre], { query: plain, prefs: blank, tasteFloor: 0 });
    assert.equal(ranked.items.length, 1);
    // ...and the shared city cache is never filtered, whoever it is ranked for
    assert.equal(rank([theatre], { query, prefs, keepOffTaste: true, tasteFloor: 0 }).items.length, 1);
  });

  it('does not filter café suggestions by a taste for concerts', () => {
    const p = PreferencesSchema.parse({ home_city: 'kharkiv', favourite_categories: ['concert'] });
    const cafe = makeItem({ city: 'kharkiv', kind: 'place', title: 'Нова кавʼярня', url: 'https://x/pl', source: 'websearch', category: 'cafe' })!;
    const places = parseRequest('', { prefs: p, base: '2026-10-20', kinds: ['place'] });
    const ranked = rank([cafe], { query: places, prefs: p, tasteFloor: 0 });
    assert.equal(ranked.items.length, 1, 'a concert favourite says nothing about cafés');
    assert.equal(ranked.toppedUp, 0, 'and there is nothing to apologise for');
  });

  it('counts every ❤️ on a category, so a repeated like outranks a one-off', () => {
    const once = PreferencesSchema.parse({ home_city: 'kharkiv', favourite_categories: ['standup'], taste: { standup: 1 } });
    const often = PreferencesSchema.parse({ home_city: 'kharkiv', favourite_categories: ['standup'], taste: { standup: 6 } });
    const item = makeItem({ ...common, title: 'Відкритий мікрофон', url: 'https://x/h1', source: 'karabas', category: 'standup', priceMin: 200 })!;
    const score = (p: typeof once) => rank([item], { query: parseRequest('', { prefs: p, base: '2026-10-20' }), prefs: p }).items[0]!.score!;
    assert.ok(score(often) > score(once) + 3, `${score(often)} vs ${score(once)}`);
  });

  it('does not let a genre stand in for its whole category', () => {
    const indie = PreferencesSchema.parse({ home_city: 'kharkiv', favourite_categories: ['concert'], interests: ['indie'] });
    const symphony = makeItem({ ...common, title: 'Симфонія №5', url: 'https://x/g1', source: 'karabas', category: 'concert', priceMin: 300, description: 'класична музика' })!;
    const party = makeItem({ ...common, title: 'Інді-вечірка', url: 'https://x/g2', source: 'karabas', category: 'concert', priceMin: 200 })!;
    const ranked = rank([symphony, party], { query: parseRequest('', { prefs: indie, base: '2026-10-20' }), prefs: indie });
    const why = (title: string) => ranked.items.find((i) => i.title === title)?.reasons ?? [];
    assert.ok(why('Інді-вечірка').some((r) => r.includes('indie')), JSON.stringify(why('Інді-вечірка')));
    assert.ok(!why('Симфонія №5').some((r) => r.includes('indie')), 'a symphony is not indie');
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

  it('renders the reminder list by day, with an emoji and a time', () => {
    const now = new Date('2026-10-22T12:00:00+03:00');
    const text = renderReminders(
      [
        { title: 'Вистава «Тартюф»', starts_at: '2026-10-22T21:00:00+03:00', venue: 'Театр Квітки', url: 'https://x/1' },
        { title: 'Вечір імпровізації', starts_at: '2026-10-25T19:30:00+02:00', venue: null, url: null },
        { title: 'Виставка, що вже минула', starts_at: '2026-10-01T19:30:00+03:00', venue: null, url: 'https://x/2' },
      ],
      { now },
    );
    assert.ok(text.includes('🎭 <b>Вистава «Тартюф»</b>'), text);
    assert.ok(text.includes('21:00 · Театр Квітки'), text);
    assert.ok(text.includes('чт, 22 жовт.') && text.includes('нд, 25 жовт.'), 'grouped by day');
    assert.ok(text.includes('2 нагадування'), 'the past one is not counted');
    assert.ok(!text.includes('вже минула'), 'a reminder for something already started is done');
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(text), 'no raw ISO dates');
    assert.ok(text.includes('❤️'), 'it says how to cancel');
  });

  it('says what to do when there are no reminders', () => {
    assert.ok(renderReminders([]).includes('Тапни ❤️'));
  });

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

  it('badges sold-out events in Ukrainian', () => {
    const items = [makeItem({ city: 'kharkiv', title: 'Gone', url: 'https://x/c', source: 's', startsAt: '2026-10-24T19:00:00+03:00', status: 'soldout' })!];
    assert.ok(buildDigest({ title: 'T', query, items, format: 'text' }).text.includes('КВИТКІВ НЕМАЄ'));
  });

  it('labels the ticket link in Ukrainian when there are tickets', () => {
    const items = [makeItem({ city: 'kharkiv', title: 'Gig', url: 'https://x/c2', source: 's', startsAt: '2026-10-24T19:00:00+03:00', priceMin: 300 })!];
    assert.ok(buildDigest({ title: 'T', query, items, format: 'text' }).text.includes('квитки →'));
  });

  it('says the date is unknown in Ukrainian', () => {
    const items = [makeItem({ city: 'kharkiv', title: 'Someday', url: 'https://x/c3', source: 's' })!];
    assert.ok(buildDigest({ title: 'T', query, items, format: 'text' }).text.includes('дата уточнюється'));
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

/* ----------------------------------------------------- the network layer --- */

describe('politeFetch', () => {
  /** Swap the global fetch for a canned responder; returns the urls it saw. */
  async function withFetch(
    handler: (url: string, hit: number) => { status?: number; body?: string; headers?: Record<string, string> },
    body: (urls: string[], at: number[]) => Promise<void>,
  ): Promise<void> {
    const real = globalThis.fetch;
    const urls: string[] = [];
    const at: number[] = [];
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      urls.push(url);
      at.push(Date.now());
      const res = handler(url, urls.filter((u) => u === url).length);
      const status = res.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: '',
        headers: new Headers(res.headers ?? {}),
        text: async () => res.body ?? '',
      } as Response;
    }) as typeof fetch;
    try {
      await body(urls, at);
    } finally {
      globalThis.fetch = real;
    }
  }

  const fast = { delayMs: 1, retries: 2, timeoutMs: 2000 };

  it('does not retry a 404: page seven of six says the same thing every time', async () => {
    await withFetch(
      () => ({ status: 404 }),
      async (urls) => {
        await assert.rejects(() => politeFetch('https://no-retry.test/page7', fast), (err: unknown) => {
          assert.ok(err instanceof HttpError && err.status === 404 && !err.retryable);
          return true;
        });
        assert.equal(urls.length, 1, 'a permanent answer is asked for once');
      },
    );
  });

  it('retries a 502 to the end of its budget', async () => {
    await withFetch(
      () => ({ status: 502 }),
      async (urls) => {
        await assert.rejects(() => politeFetch('https://flaky.test/x', fast));
        assert.equal(urls.length, 3, 'the first attempt plus two retries');
      },
    );
  });

  it('comes back for the second attempt when the first one was a hiccup', async () => {
    await withFetch(
      (_url, hit) => (hit === 1 ? { status: 503 } : { body: '<html>ok</html>' }),
      async (urls) => {
        assert.equal(await politeFetch('https://second-time.test/x', fast), '<html>ok</html>');
        assert.equal(urls.length, 2);
      },
    );
  });

  it('waits as long as Retry-After asks on a 429', async () => {
    await withFetch(
      (_url, hit) => (hit === 1 ? { status: 429, headers: { 'retry-after': '0.3' } } : { body: 'ok' }),
      async (_urls, at) => {
        await politeFetch('https://flood.test/x', { ...fast, delayMs: 1 });
        // our own backoff for attempt 1 would have been 2ms; the server asked
        // for 300, and ignoring that is how a bot gets banned
        assert.ok((at[1] ?? 0) - (at[0] ?? 0) >= 250, `waited ${(at[1] ?? 0) - (at[0] ?? 0)}ms`);
      },
    );
  });

  it('spaces concurrent requests to one host instead of firing them at once', async () => {
    await withFetch(
      () => ({ body: 'ok' }),
      async (_urls, at) => {
        // runPipeline asks for every city × source at once: a plain
        // read-the-clock-then-set-it check let all three through together
        await Promise.all([1, 2, 3].map((n) => politeFetch(`https://polite.test/${n}`, { delayMs: 120, retries: 0 })));
        const gaps = at.slice(1).map((t, i) => t - (at[i] as number));
        for (const gap of gaps) assert.ok(gap >= 110, `requests were ${gap}ms apart`);
      },
    );
  });
});

describe('page walking', () => {
  const log = makeLogger('test');
  const anywhere = parseRequest('', { prefs, base: '2026-10-20', from: '2026-01-01', to: '2027-12-31' });
  const anItem = () => makeItem({ city: 'kharkiv', title: 'Щось', url: 'https://x/p', source: 's' })!;

  it('keeps the events from the pages before a failure', async () => {
    const pages = pager(log);
    const seen: number[] = [];
    await pages.walk('listing', 6, async (page) => {
      if (page === 4) throw new HttpError(500, 'https://x/4');
      seen.push(page);
      return 10;
    });
    assert.deepEqual(seen, [1, 2, 3], 'three good pages are not thrown away for a bad fourth');
    const result = pages.result('some-source', [anItem()]);
    assert.equal(result.ok, true, 'a partial scrape is still a scrape');
    assert.equal(result.fetched, 3);
  });

  it('stops at the first empty page', async () => {
    const pages = pager(log);
    let calls = 0;
    await pages.walk('listing', 6, async (page) => {
      calls++;
      return page >= 2 ? 0 : 5;
    });
    assert.equal(calls, 2);
  });

  it('calls a source that collected nothing at all a failure', async () => {
    const pages = pager(log);
    await pages.walk('listing', 6, async () => {
      throw new HttpError(403, 'https://x/1');
    });
    const result = pages.result('some-source', []);
    assert.equal(result.ok, false, 'so the answer can admit the list may be short');
    assert.match(result.error ?? '', /403/);
  });

  it('turns a collector that throws into a harmless empty result', async () => {
    const result = await safeCollect(
      'exploding',
      async () => {
        throw new Error('site is down');
      },
      { query: anywhere, city: 'kharkiv', log },
    );
    assert.equal(result.ok, false);
    assert.equal(result.items.length, 0);
    assert.match(result.error ?? '', /site is down/);
  });
});

describe('scrapers, offline', () => {
  const log = makeLogger('test');
  /** Serve a page once per url, then nothing — one page per listing. */
  const serve = (body: string) => {
    const served = new Set<string>();
    return async (url: string) => {
      if (served.has(url)) return '<html></html>';
      served.add(url);
      return body;
    };
  };
  const wide = parseRequest('', { prefs, base: '2026-10-20', from: '2026-01-01', to: '2027-12-31' });

  it('reads Kontramarka cards into items', async () => {
    const res = await collectKontramarka({
      query: wide,
      city: 'kharkiv',
      log,
      maxPages: 1,
      fetchText: serve(fixture('kontramarka-card.html')),
    });
    assert.equal(res.ok, true);
    const item = res.items.find((i) => i.title.includes('Байдак'));
    assert.ok(item, `no Байдак in ${JSON.stringify(res.items.map((i) => i.title))}`);
    assert.equal(item.startsAt, '2026-10-21T18:30:00+03:00');
    assert.equal(item.venue, 'ХНАТОБ LOFT STAGE');
    assert.equal(item.city, 'kharkiv');
  });

  it('makes a card link absolute, so the button in Telegram is not dead', async () => {
    const relative = `<!doctype html><html><body>
      <div class="cat_item" itemscope itemtype="http://schema.org/Event">
        <a itemprop="url" class="block-info__title" href="/uk/relative-123.html"><span itemprop="name">Відносне</span></a>
        <meta itemprop="startDate" content="2026-10-21T18:30:00+03:00">
      </div></body></html>`;
    const res = await collectKontramarka({ query: wide, city: 'kharkiv', log, maxPages: 1, fetchText: serve(relative) });
    const item = res.items.find((i) => i.title === 'Відносне');
    assert.ok(item, 'the card was not read at all');
    assert.equal(item.url, 'https://kharkiv.kontramarka.ua/uk/relative-123.html');
  });

  it('reads Karabas JSON-LD into items', async () => {
    const page = `<html><head><script type="application/ld+json">${fixture('karabas-event.json')}</script></head><body></body></html>`;
    assert.equal(eventsFromJsonLd(page).length, 1, 'the fixture is one Event');
    const res = await collectKarabas({ query: wide, city: 'kharkiv', log, maxPages: 1, fetchText: serve(page) });
    assert.equal(res.ok, true);
    assert.equal(res.items.length, 1);
    assert.equal(res.items[0]?.title, 'IVAN LIULENOV');
    assert.equal(res.items[0]?.source, 'karabas');
  });

  it('runs the whole pipeline over stubbed pages, deduping across sources', async () => {
    const karabasPage = `<html><script type="application/ld+json">${fixture('karabas-event.json')}</script></html>`;
    const result = await runPipeline({
      query: wide,
      prefs,
      log,
      only: ['karabas', 'kontramarka'],
      maxPages: 1,
      keepOffTaste: true,
      keepExpensive: true,
      keepDisliked: true,
      fetchText: serve(karabasPage) as never,
    });
    assert.equal(result.failedSources.length, 0, JSON.stringify(result.results.map((r) => [r.source, r.error])));
    assert.ok(result.all.some((i) => i.title === 'IVAN LIULENOV'));
  });
});

/* -------------------------------------------------- one message per event --- */

describe('messages', () => {
  const query = parseRequest('', { prefs, base: '2026-10-20', from: '2026-10-23', to: '2026-10-25' });
  const earlier = makeItem({ city: 'kharkiv', title: 'Earlier', url: 'https://m/a', source: 's', startsAt: '2026-10-23T19:00:00+03:00', score: 1 })!;
  const later = makeItem({ city: 'kharkiv', title: 'Later but better', url: 'https://m/b', source: 's', startsAt: '2026-10-25T19:00:00+03:00', score: 99 })!;

  it('is a header plus one message per event, each carrying exactly that event', () => {
    const msgs = buildMessages({ title: 'T', query, items: [later, earlier], format: 'text' });
    assert.equal(msgs.length, 3);
    assert.deepEqual(msgs[0]!.items, []);
    assert.deepEqual(msgs.slice(1).map((m) => m.items.map((i) => i.title)), [['Earlier'], ['Later but better']]);
  });

  it('puts the day in every event message, since there are no day headings left', () => {
    const msgs = buildMessages({ title: 'T', query, items: [earlier], format: 'text' });
    assert.ok(msgs[1]!.text.includes('23 жовт.'), msgs[1]!.text);
  });

  it('never numbers an event, because its own message identifies it', () => {
    const msgs = buildMessages({ title: 'T', query, items: [later, earlier], format: 'text' });
    for (const m of msgs.slice(1)) assert.ok(!/^\d+\.\s/m.test(m.text), m.text);
  });

  it('counts the events in the header, with Ukrainian plurals', () => {
    const one = buildMessages({ title: 'T', query, items: [earlier], format: 'text' });
    assert.ok(one[0]!.text.includes('1 подія'), one[0]!.text);
    const two = buildMessages({ title: 'T', query, items: [earlier, later], format: 'text' });
    assert.ok(two[0]!.text.includes('2 події'), two[0]!.text);
  });

  it('does not repeat the window name the title already carries', () => {
    const msgs = buildMessages({ title: '🗓 Цього тижня', query, items: [earlier], format: 'text' });
    assert.ok(!msgs[0]!.text.includes('('), msgs[0]!.text);
    assert.ok(msgs[0]!.text.includes('23 жовт.'), msgs[0]!.text);
  });

  it('calls the link "детальніше" when there is nothing to buy', () => {
    const free = makeItem({ city: 'kharkiv', title: 'Вхід вільний', url: 'https://m/f', source: 's', startsAt: '2026-10-23T19:00:00+03:00', free: true })!;
    const msgs = buildMessages({ title: 'T', query, items: [free], format: 'text' });
    assert.ok(msgs[1]!.text.includes('детальніше →'), msgs[1]!.text);
    assert.ok(!msgs[1]!.text.includes('квитки →'), msgs[1]!.text);
  });

  it('says in Ukrainian why an event is being shown again', () => {
    const changeNotes = new Map([[earlier.id, 'sold out']]);
    const msgs = buildMessages({ title: 'T', query, items: [earlier], format: 'text', changeNotes });
    assert.ok(msgs[1]!.text.includes('🔁 квитки скінчилися'), msgs[1]!.text);
  });

  it('is a single message, carrying nothing, when nothing matched', () => {
    const msgs = buildMessages({ title: 'T', query, items: [], format: 'text' });
    assert.equal(msgs.length, 1);
    assert.deepEqual(msgs[0]!.items, []);
  });

  it('tells people in the header how to set a reminder', () => {
    const msgs = buildMessages({ title: 'T', query, items: [earlier], format: 'text' });
    assert.ok(msgs[0]!.text.includes('❤️'), msgs[0]!.text);
  });

  it('caps each day but still sends the kept events separately', () => {
    const sameDay = [1, 2, 3].map(
      (n) => makeItem({ city: 'kharkiv', title: `Gig ${n}`, url: `https://m/d${n}`, source: 's', startsAt: '2026-10-23T19:00:00+03:00' })!,
    );
    const msgs = buildMessages({ title: 'T', query, items: sameDay, format: 'text', maxPerDay: 2 });
    assert.equal(msgs.length, 3);
  });

  it('sends one message per place too', () => {
    const place = makeItem({ city: 'kharkiv', kind: 'place', title: 'Kofein Lab', url: 'https://m/e', source: 'websearch', category: 'cafe', address: 'вул. Сумська, 11' })!;
    const msgs = buildMessages({ title: 'Місця', query, items: [place], format: 'text' });
    assert.equal(msgs.length, 2);
    assert.ok(msgs[1]!.text.includes('вул. Сумська, 11'));
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

describe('taste words, as people read them', () => {
  it('shows a storage key under its Ukrainian name', () => {
    assert.equal(tagLabel('standup'), 'стендап');
    assert.equal(tagLabel('jazz'), 'джаз');
    assert.equal(tagLabel('exhibition'), 'виставки');
    // free-text tags have no translation and pass through untouched
    assert.equal(tagLabel('сучасне мистецтво'), 'сучасне мистецтво');
  });

  it('describes preferences in Ukrainian, with a hryvnia sign', () => {
    const described = describePrefs(
      PreferencesSchema.parse({ home_city: 'kharkiv', favourite_categories: ['standup', 'jazz'], max_ticket_price: 700 }),
    );
    assert.ok(described.includes('улюблене: стендап, джаз'), described);
    assert.ok(described.includes('максимум за квиток: 700 ₴'), described);
  });
});

describe('date range labels', () => {
  const base = '2026-10-20';

  it('names every window in Ukrainian, because the label is shown to people', () => {
    assert.equal(thisWeekRange(base).label, 'цей тиждень');
    assert.equal(weekendRange(base).label, 'ці вихідні');
    assert.equal(nextWeekRange(base).label, 'наступний тиждень');
    assert.equal(parseDateRange('сьогодні', base).label, 'сьогодні');
    assert.equal(parseDateRange('завтра', base).label, 'завтра');
    assert.equal(parseDateRange('цього місяця', base).label, 'цей місяць');
  });

  it('counts days in Ukrainian for "next N days"', () => {
    assert.equal(parseDateRange('next 3 days', base).label, 'найближчі 3 дн.');
    assert.equal(parseDateRange('next 7 days', base).label, 'найближчі 7 дн.');
  });
});

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

  // JavaScript's \b is ASCII-only, so every Cyrillic phrasing below used to be
  // dead code: the words were in the patterns but could never match.
  it('understands the same commands written in Ukrainian', () => {
    check('люблю джаз', { understood: true, changed: true, contains: 'улюблене + джаз' });
    check('не люблю шансон', { understood: true, changed: true, contains: 'небажане + шансон' });
    check('слідкуй за Latexfauna', { understood: true, changed: true, contains: 'стежу за «Latexfauna»' });
    check('мені подобається театр', { understood: true, changed: true, contains: 'улюблене + театр' });
  });

  it('reads a Ukrainian budget', () => {
    assert.equal(applyPrefsCommand('максимум 800 грн', current).prefs.max_ticket_price, 800);
    assert.equal(applyPrefsCommand('не дорожче 500 грн', current).prefs.max_ticket_price, 500);
  });

  it('reads a Ukrainian trip and a Ukrainian home city', () => {
    const trip = applyPrefsCommand('наступного тижня буду у Львові', current);
    assert.equal(trip.prefs.trip?.city, 'lviv');
    assert.equal(applyPrefsCommand('моє місто Київ', current).prefs.home_city, 'kyiv');
  });

  it('adds and removes a Ukrainian watch city', () => {
    const added = applyPrefsCommand('слідкуй за містом Одеса', current);
    assert.ok(added.prefs.watch_cities.includes('odesa'), JSON.stringify(added.changes));
  });

  it('takes a watch city in whatever word order it is asked for', () => {
    // "Додай до міст Київ" used to fall through and search Kyiv instead
    for (const text of ['Додай до міст Одеса', 'додай до міста Одеса', 'додай Одеса до міст', 'add Odesa to cities']) {
      const edit = applyPrefsCommand(text, current);
      assert.ok(edit.understood, `"${text}" was not understood`);
      assert.ok(edit.prefs.watch_cities.includes('odesa'), `"${text}" → ${JSON.stringify(edit.changes)}`);
    }
    for (const text of ['прибери з міст Київ', 'прибери Київ з міст']) {
      const edit = applyPrefsCommand(text, current);
      assert.ok(edit.understood, `"${text}" was not understood`);
      assert.ok(!edit.prefs.watch_cities.includes('kyiv'), `"${text}" → ${JSON.stringify(edit.changes)}`);
    }
    // and none of that may swallow the other lists
    assert.ok(applyPrefsCommand('додай джаз до улюблених', current).prefs.favourite_categories.includes('jazz'));
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
    assert.ok(defaults.disliked_categories.includes('classical'));
    assert.equal(defaults.max_ticket_price, 1200);
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

/** Everything the bot writes to stdout while `body` runs (dry-run prints instead of sending). */
async function captureOutput(body: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await body();
  } finally {
    (process.stdout as { write: unknown }).write = original;
  }
  return chunks.join('');
}

/** Capture what the bot would say to one message. */
async function say(store: StoreType, chatId: string, text: string, extra: Record<string, unknown> = {}): Promise<string> {
  return captureOutput(() =>
    handleMessage({ store, log, dryRun: true }, {
      message_id: Math.floor(Math.random() * 100000),
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private' },
      text,
      ...extra,
    } as never),
  );
}

describe('bot handlers', () => {
  it('onboards a new user by asking for a city, then moves on to their taste', async () => {
    await withTestStore(async (store) => {
      const hello = await say(store, '3001', '/start');
      assert.ok(hello.includes('У якому ти місті'), hello.slice(0, 200));
      assert.equal((await store.getUser('3001'))?.stage, 'city');

      const picked = await say(store, '3001', 'Львів');
      assert.ok(picked.includes('Львів'), picked.slice(0, 200));
      assert.ok(picked.includes('Що тобі заходить'), 'the city answer leads straight into the taste step');
      const row = await store.getUser('3001');
      assert.equal(row?.stage, 'likes', 'the city answer leads into the first taste screen');
      assert.equal(row?.city, 'lviv');
    });
  });

  it('builds a profile out of taps and finishes the walkthrough', async () => {
    await withTestStore(async (store) => {
      await say(store, '3020', '/start');
      await say(store, '3020', 'Харків');

      await tap(store, '3020', 'onb:like:standup');
      const likes = await tap(store, '3020', 'onb:like:exhibition');
      assert.ok(likes.includes('✅ 🎤 стендап'), 'a chosen category is ticked');
      assert.ok(likes.includes('▫️ 🎭 театр'), 'an unchosen one is not');

      await tap(store, '3020', 'onb:next');
      assert.equal((await store.getUser('3020'))?.stage, 'dislikes');
      await tap(store, '3020', 'onb:dis:classical');

      await tap(store, '3020', 'onb:next');
      const budget = await tap(store, '3020', 'onb:budget:1000');
      // a budget tap advances on its own — there is nothing else to say
      assert.equal((await store.getUser('3020'))?.stage, 'follow');
      assert.ok(budget.includes('За ким стежити'), budget.slice(0, 200));

      await say(store, '3020', 'Антон Тимошенко, Latexfauna');
      const done = await tap(store, '3020', 'onb:next');
      assert.ok(done.includes('Готово'), done.slice(0, 200));

      const row = await store.getUser('3020');
      assert.equal(row?.stage, null);
      const user = (await getUser(store, '3020'))!;
      assert.deepEqual(user.prefs.favourite_categories, ['standup', 'exhibition']);
      assert.deepEqual(user.prefs.disliked_categories, ['classical']);
      assert.equal(user.prefs.max_ticket_price, 1000);
      assert.deepEqual(user.prefs.follow, ['Антон Тимошенко', 'Latexfauna']);
    });
  });

  it('keeps liking and disliking the same thing mutually exclusive', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3021', city: 'kharkiv' });
      await tap(store, '3021', 'onb:like:theatre');
      await tap(store, '3021', 'onb:dis:theatre');
      const user = (await getUser(store, '3021'))!;
      assert.deepEqual(user.prefs.favourite_categories, []);
      assert.deepEqual(user.prefs.disliked_categories, ['theatre']);
    });
  });

  it('sends digests to someone who walked away mid-walkthrough, but not before a city', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3022', city: 'kharkiv' });
      await store.setUserStage('3022', 'budget');
      await registerUser(store, { chatId: '3023' });
      const listed = (await store.listUsers()).map((u) => u.chat_id);
      assert.ok(listed.includes('3022'), 'someone who stopped at the budget step still gets digests');
      assert.ok(!listed.includes('3023'), 'someone who never picked a city does not');
    });
  });

  it('adds a typed name to the follow list instead of searching for it', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3024', city: 'kharkiv' });
      await store.setUserStage('3024', 'follow');
      const reply = await say(store, '3024', 'Жадан і Собаки');
      assert.ok(reply.includes('Стежу за'), reply.slice(0, 200));
      assert.ok(!reply.includes('Шукаю'), 'a name is not a search');
      assert.deepEqual((await getUser(store, '3024'))!.prefs.follow, ['Жадан і Собаки']);
    });
  });

  it('reads a sentence at the follow step as a sentence, not as a name', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3028', city: 'kharkiv' });
      await store.setUserStage('3028', 'follow');
      await say(store, '3028', 'не люблю класику');
      const user = (await getUser(store, '3028'))!;
      assert.deepEqual(user.prefs.follow, [], 'a dislike is not somebody to watch for');
      assert.deepEqual(user.prefs.disliked_categories, ['classical']);
    });
  });

  it('offers the walkthrough to an older user exactly once', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3025', city: 'kharkiv' });
      const first = await say(store, '3025', '/reminders');
      assert.ok(first.includes('налаштувати кнопками'), first.slice(0, 300));
      assert.ok(first.includes('(onb:start)'), 'the offer needs a button');
      const second = await say(store, '3025', '/reminders');
      assert.ok(!second.includes('налаштувати кнопками'), 'and it never comes back');
    });
  });

  it('never nudges someone who just walked through it', async () => {
    await withTestStore(async (store) => {
      await say(store, '3026', '/start');
      await say(store, '3026', 'Харків');
      await tap(store, '3026', 'onb:skip');
      await tap(store, '3026', 'onb:skip');
      await tap(store, '3026', 'onb:skip');
      await tap(store, '3026', 'onb:skip');
      assert.equal((await store.getUser('3026'))?.stage, null);
      const next = await say(store, '3026', '/reminders');
      assert.ok(!next.includes('налаштувати кнопками'), next.slice(0, 300));
    });
  });

  /** An answer comes out of the shared cache, so these run without a network. */
  async function seedToday(store: StoreType, items: Item[]): Promise<void> {
    const base = today(loadConfig().timezone);
    await store.putCache(cacheKey({ city: 'kharkiv', from: base, to: base, kinds: ['event'] }, ALL_SOURCE_NAMES), items, 600);
  }
  const onToday = (title: string, category: Item['category'], extra: Record<string, unknown> = {}) =>
    makeItem({
      city: 'kharkiv', title, url: `https://s/${encodeURIComponent(title)}`, source: 'karabas', category,
      startsAt: `${today(loadConfig().timezone)}T23:00:00+03:00`, status: 'scheduled', ...extra,
    })!;

  /** Someone with taste, already past the walkthrough and the one-time nudge. */
  async function withTaste(store: StoreType, chatId: string, favourites: string[]): Promise<void> {
    await registerUser(store, { chatId, city: 'kharkiv' });
    const user = (await getUser(store, chatId))!;
    await saveUserPrefs(store, user, { ...user.prefs, favourite_categories: favourites });
    await store.setState(`setup_offered:${chatId}`, 'done');
  }

  it('answers with what the person likes, and says what it hid', async () => {
    await withTestStore(async (store) => {
      await seedToday(store, [
        ...[1, 2, 3, 4, 5].map((n) => onToday(`Відкритий мікрофон ${n}`, 'standup', { priceMin: 200 })),
        onToday('Безкоштовна лекція про котиків', 'lecture', { free: true, sources: ['karabas', 'concert.ua'] }),
      ]);
      await withTaste(store, '3040', ['standup']);
      const out = await say(store, '3040', '/today');
      assert.ok(out.includes('Відкритий мікрофон 1'), out.slice(0, 400));
      assert.ok(!out.includes('котиків'), 'a free lecture is not stand-up, however cheap');
      assert.ok(out.includes('відфільтрував'), out.slice(-400));
    });
  });

  it('pads a thin answer rather than looking broken, and admits it', async () => {
    await withTestStore(async (store) => {
      await seedToday(store, [
        onToday('Відкритий мікрофон', 'standup', { priceMin: 200 }),
        onToday('Вистава', 'theatre', { priceMin: 300 }),
      ]);
      await withTaste(store, '3041', ['standup']);
      const out = await say(store, '3041', '/today');
      assert.ok(out.includes('Вистава'), 'the next best came back');
      assert.ok(out.includes('додав ще 1'), out.slice(-400));
    });
  });

  it('reopens the same taste screens from /settings, without touching the stage', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3027', city: 'kharkiv' });
      const menu = await tap(store, '3027', 'set:prefs');
      assert.ok(menu.includes('Мої смаки'), menu.slice(0, 300));
      assert.ok(menu.includes('(onb:step:budget)'), menu.slice(0, 400));
      const screen = await tap(store, '3027', 'onb:step:likes');
      assert.ok(screen.includes('(onb:taste)'), 'in /settings a step goes back, not forward');
      assert.ok(!screen.includes('(onb:next)'), 'and never advances a walkthrough that is not open');
      assert.equal((await store.getUser('3027'))?.stage, null);
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

  it('reads a typed reminder request, hearts and Ukrainian included', () => {
    assert.deepEqual(parseBell('❤️'), { bell: true, index: undefined });
    assert.deepEqual(parseBell('🔔'), { bell: true, index: undefined });
    assert.deepEqual(parseBell('🔔 3'), { bell: true, index: 3 });
    assert.equal(parseBell('нагадай').bell, true);
    assert.equal(parseBell('нагадай 2').index, 2);
    assert.equal(parseBell('що там цікавого').bell, false);
    assert.equal(parseBell('what is on').bell, false);
  });

  it('is open to everyone unless an allowlist is configured', () => {
    assert.equal(isAllowed('999'), true);
  });
});

/* ------------------------------------------------------------------ onboarding --- */

describe('onboarding', () => {
  it('asks what the person likes once their city is known', async () => {
    await withTestStore(async (store) => {
      await say(store, '3101', '/start');
      const picked = await say(store, '3101', 'Львів');
      assert.ok(picked.includes('Що тобі заходить'), picked.slice(0, 300));
      assert.equal((await store.getUser('3101'))?.stage, 'likes');
    });
  });

  it('turns a comma-separated list typed at the likes screen into favourites', async () => {
    await withTestStore(async (store) => {
      await say(store, '3102', '/start');
      await say(store, '3102', 'Львів');
      const noted = await say(store, '3102', 'стендап, джаз, театр');
      const user = await getUser(store, '3102');
      assert.deepEqual(user?.prefs.favourite_categories, ['standup', 'jazz', 'theatre']);
      // typing is one way to answer the screen, not a way to leave it
      assert.equal((await store.getUser('3102'))?.stage, 'likes');
      assert.ok(noted.includes('Записав'), noted.slice(0, 300));
    });
  });

  it('still understands a full sentence mid-walkthrough', async () => {
    await withTestStore(async (store) => {
      await say(store, '3103', '/start');
      await say(store, '3103', 'Львів');
      assert.equal((await store.getUser('3103'))?.stage, 'likes');
      await say(store, '3103', 'не люблю класичну музику');
      const user = await getUser(store, '3103');
      assert.ok(user?.prefs.disliked_categories.includes('classical'));
      assert.deepEqual(user?.prefs.favourite_categories, [], 'a dislike is not a favourite');
    });
  });

  it('lets someone skip a step by typing instead of tapping', async () => {
    await withTestStore(async (store) => {
      await say(store, '3104', '/start');
      await say(store, '3104', 'Львів');
      await say(store, '3104', 'Пропустити');
      assert.equal((await store.getUser('3104'))?.stage, 'dislikes');
      const user = await getUser(store, '3104');
      assert.deepEqual(user?.prefs.favourite_categories, []);
    });
  });

  it('does not treat an answer to a step as a search', async () => {
    await withTestStore(async (store) => {
      await say(store, '3105', '/start');
      await say(store, '3105', 'Львів');
      const answer = await say(store, '3105', 'стендап');
      assert.ok(!answer.includes('Шукаю'), answer.slice(0, 300));
      const user = await getUser(store, '3105');
      assert.deepEqual(user?.prefs.favourite_categories, ['standup']);
    });
  });

  it('picks up where someone left off, even from the old one-question step', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3106', city: 'lviv' });
      await store.setUserStage('3106', 'taste');
      const back = await say(store, '3106', '/start');
      assert.ok(back.includes('Що тобі заходить'), back.slice(0, 300));
      assert.equal((await store.getUser('3106'))?.stage, 'likes');
    });
  });
});

/* ----------------------------------------------------------------- the heart --- */

describe('the heart', () => {
  /** Capture what the bot would say when someone changes a reaction. */
  async function react(
    store: StoreType,
    chatId: string,
    messageId: number,
    { from = [], to = ['❤️'] }: { from?: string[]; to?: string[] } = {},
  ): Promise<string> {
    return captureOutput(() =>
      handleReaction({ store, log, dryRun: true }, {
        chat: { id: chatId, type: 'private' },
        message_id: messageId,
        user: { id: Number(chatId) },
        old_reaction: from.map((emoji) => ({ type: 'emoji', emoji })),
        new_reaction: to.map((emoji) => ({ type: 'emoji', emoji })),
      } as never),
    );
  }

  const gig = () =>
    makeItem({ city: 'kharkiv', title: 'Вечір імпровізації', url: 'https://h/1', source: 's', category: 'standup', startsAt: '2026-11-01T19:00:00+02:00' })!;

  it('knows a heart from any other reaction', () => {
    for (const e of ['❤️', '❤', '🧡', '💙', '💖', '🩷']) assert.equal(isHeart(e), true, e);
    for (const e of ['👍', '🔥', '😂', '👎']) assert.equal(isHeart(e), false, e);
  });

  it('sets a reminder for the one event that message was about', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3201', city: 'kharkiv' });
      await store.recordMessage('3201', 777, [gig()]);
      const reply = await react(store, '3201', 777);
      assert.ok(reply.includes('Вечір імпровізації'), reply.slice(0, 300));
      const rows = await store.listReminders('3201');
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.title, 'Вечір імпровізації');
    });
  });

  it('learns the taste behind the heart', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3202', city: 'kharkiv' });
      await store.recordMessage('3202', 778, [gig()]);
      await react(store, '3202', 778);
      const user = await getUser(store, '3202');
      assert.ok(user?.prefs.favourite_categories.includes('standup'), JSON.stringify(user?.prefs.favourite_categories));
    });
  });

  it('counts every heart on the same category, not just the first', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3210', city: 'kharkiv' });
      for (const [id, title] of [[801, 'Вечір імпровізації'], [802, 'Відкритий мікрофон'], [803, 'Стендап концерт']] as const) {
        const item = makeItem({ city: 'kharkiv', title, url: `https://h/${id}`, source: 's', category: 'standup', startsAt: '2026-11-01T19:00:00+02:00' })!;
        await store.recordMessage('3210', id, [item]);
        await react(store, '3210', id);
      }
      const user = await getUser(store, '3210');
      assert.equal(user?.prefs.taste['standup'], 3, JSON.stringify(user?.prefs.taste));
      assert.deepEqual(user?.prefs.favourite_categories, ['standup'], 'and the list itself does not repeat');
    });
  });

  it('follows whoever is on stage, when the ticket site said who', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3211', city: 'kharkiv' });
      const named = makeItem({
        city: 'kharkiv', title: 'Вечір імпровізації', url: 'https://h/810', source: 's',
        category: 'standup', startsAt: '2026-11-01T19:00:00+02:00', performers: ['Паша Пінчук'],
      })!;
      await store.recordMessage('3211', 810, [named]);
      const reply = await react(store, '3211', 810);
      assert.ok(reply.includes('Паша Пінчук'), reply.slice(0, 400));
      const user = await getUser(store, '3211');
      assert.deepEqual(user?.prefs.follow, ['Паша Пінчук']);
      // the tally survived the same save
      assert.equal(user?.prefs.taste['standup'], 1);
    });
  });

  it('does not invent a performer out of a show title', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3212', city: 'kharkiv' });
      await store.recordMessage('3212', 811, [gig()]);
      await react(store, '3212', 811);
      assert.deepEqual((await getUser(store, '3212'))?.prefs.follow, []);
    });
  });

  it('takes the reminder away again when the heart is removed', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3203', city: 'kharkiv' });
      await store.recordMessage('3203', 779, [gig()]);
      await react(store, '3203', 779);
      assert.equal((await store.listReminders('3203')).length, 1);

      const reply = await react(store, '3203', 779, { from: ['❤️'], to: [] });
      assert.equal((await store.listReminders('3203')).length, 0);
      assert.ok(reply.includes('Прибрав нагадування'), reply.slice(0, 300));
    });
  });

  it('keeps the learned taste when the heart is removed', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3204', city: 'kharkiv' });
      await store.recordMessage('3204', 780, [gig()]);
      await react(store, '3204', 780);
      await react(store, '3204', 780, { from: ['❤️'], to: [] });
      const user = await getUser(store, '3204');
      assert.ok(user?.prefs.favourite_categories.includes('standup'));
    });
  });

  it('ignores a reaction that is not a heart', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3205', city: 'kharkiv' });
      await store.recordMessage('3205', 781, [gig()]);
      const reply = await react(store, '3205', 781, { to: ['👍'] });
      assert.equal(await store.listReminders('3205').then((r) => r.length), 0);
      assert.equal(reply.trim(), '');
    });
  });

  it('says nothing at all about a message it no longer remembers', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3206', city: 'kharkiv' });
      const reply = await react(store, '3206', 9999);
      assert.equal(reply.trim(), '');
    });
  });

  it('asks for the event itself when the message covered several', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3207', city: 'kharkiv' });
      const other = makeItem({ city: 'kharkiv', title: 'Інше', url: 'https://h/2', source: 's', startsAt: '2026-11-02T19:00:00+02:00' })!;
      await store.recordMessage('3207', 782, [gig(), other]);
      const reply = await react(store, '3207', 782);
      assert.ok(reply.includes('на самій події'), reply.slice(0, 300));
      assert.equal((await store.listReminders('3207')).length, 0);
    });
  });

  it('will not promise a reminder for an event with no start time', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3208', city: 'kharkiv' });
      const someday = makeItem({ city: 'kharkiv', title: 'Колись', url: 'https://h/3', source: 's' })!;
      await store.recordMessage('3208', 783, [someday]);
      const reply = await react(store, '3208', 783);
      assert.ok(reply.includes('немає часу початку'), reply.slice(0, 300));
      assert.equal((await store.listReminders('3208')).length, 0);
    });
  });
});

/* -------------------------------------------------------------------- deliver --- */

describe('deliver', () => {
  const query = parseRequest('', { prefs, base: '2026-10-20', from: '2026-10-23', to: '2026-10-25' });

  it('sends the header and every event as its own Telegram message', async () => {
    await withTestStore(async (store) => {
      const items = [1, 2, 3].map(
        (n) => makeItem({ city: 'kharkiv', title: `Подія ${n}`, url: `https://d/${n}`, source: 's', startsAt: `2026-10-2${2 + n}T19:00:00+03:00` })!,
      );
      const printed = await captureOutput(() =>
        deliver({ title: 'T', query, items, log, store, chatId: '3301', dryRun: true }),
      );
      assert.equal(printed.split('──────── to chat 3301').length - 1, 4, printed);
    });
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
