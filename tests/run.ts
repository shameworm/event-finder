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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
// type-only imports are erased, so they cannot run before the sandbox env is set
import type { Store as StoreType } from '../src/db.ts';
import type { Item } from '../src/types.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'events-finder-test-'));
// the suite used to leave a database and a preferences file in /tmp per run
process.on('exit', () => rmSync(sandbox, { recursive: true, force: true }));
process.env['EVENTS_FINDER_DATA'] = sandbox;
process.env['EVENTS_FINDER_DB'] = join(sandbox, 'test.db');
process.env['EVENTS_FINDER_CONFIG'] = new URL('../config.example.yaml', import.meta.url).pathname;
process.env['EVENTS_FINDER_PREFS'] = join(sandbox, 'preferences.yaml');
process.env['EVENTS_FINDER_QUIET'] = '1';
// empty, not deleted: paths.ts reads ~/.hermes/.env on import, and loadEnv
// only fills variables that are unset — an operator's real Postgres url would
// otherwise be pulled into the test run
process.env['DATABASE_URL'] = '';

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
const { normText, stemText, isoInZone, localDate, localTime, addDays, today, weekdayOf, titleKey, dayLabel } = await import('../src/util.ts');
const { classify, canonicalTag, expandTag } = await import('../src/categories.ts');
const { parseDateRange, parseRequest, weekendRange, thisWeekRange, nextWeekRange, splitNegations } = await import('../src/request.ts');
const { fromSchemaEvent, makeItem, priceText, parsePriceText, statusFrom, pickImage } = await import('../src/normalize.ts');
const { dedupe, fingerprint } = await import('../src/dedupe.ts');
const { rank, matchesFollow, matchesTag, groupByDay } = await import('../src/rank.ts');
const { buildDigest, buildMessages, eventKeyboard, renderReminders, renderItem, renderCaption, countEvents, countEventsAcc, eventsWaiting, CAPTION_LIMIT, REMINDER_HINT, WALK_HINT } = await import('../src/render.ts');
const { loadConfig, loadPrefs, resolveCity, cityLocalName, savePrefs } = await import('../src/config.ts');
const { applyPrefsCommand, applyThumbsDown, describePrefs } = await import('../src/prefs-engine.ts');
const { tagLabel } = await import('../src/categories.ts');
const { PreferencesSchema } = await import('../src/types.ts');
// the real Telegram schemas, so a handler fixture that drifts out of shape
// fails here instead of being waved through by a cast
const { TgMessageSchema, TgCallbackQuerySchema, TgReactionUpdateSchema } = await import('../src/schemas.ts');
const { parsePost, findDate, findTime, findVenue } = await import('../scripts/telegram.ts');
const { resultToItem, buildQueries } = await import('../scripts/websearch.ts');
const { collect: collectKontramarka, cardToSchema } = await import('../scripts/kontramarka.ts');
const { Store, DIGEST_PAGE_TTL_SECONDS, SEARCH_PAGE_TTL_SECONDS, pageKey, lastPageKey } = await import('../src/db.ts');
const { splitForTelegram, parseUpdates } = await import('../src/telegram-api.ts');
const { googleCalendarUrl } = await import('../src/calendar.ts');
const { registerUser, getUser, saveUserPrefs, allUsers, citiesFor, defaultPrefs, newUserPrefs } = await import('../src/users.ts');
const { cacheKey, collectCity } = await import('../src/cache.ts');
const { parseArgs } = await import('../src/cli.ts');
const { fanout } = await import('../src/fanout.ts');
const {
  DIGEST_DAYS, DIGEST_HOURS, WEEKEND_DAY, digestDueNow, scheduleOf, defaultSchedule,
  describeSchedule, wantsOnlyMine, daysLabel, toggleDay, daysMask, daysFromMask,
} = await import('../src/schedule.ts');
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
const { collect: collectConcertUa } = await import('../scripts/concertua.ts');
const {
  DEAD_AFTER_TICKS, SourceHealthSchema, evaluateTick, readHealth, readAllHealth, recordTick, describeHealth,
} = await import('../src/health.ts');

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

describe('dates people actually type', () => {
  it('reads a bare day and month as the next one coming, not eleven months ago', () => {
    // asked two days before new year, "15 січня" is three weeks away
    const soon = parseDateRange('що буде 15 січня', '2026-12-29');
    assert.equal(soon.from, '2027-01-15');
    // and in the same year when it has not passed yet
    assert.equal(parseDateRange('15 січня', '2026-01-02').from, '2026-01-15');
    const span = parseDateRange('28-30 грудня', '2026-12-29');
    assert.deepEqual([span.from, span.to], ['2026-12-28', '2026-12-30']);
  });

  it('keeps the whole Friday-to-Sunday for "next weekend", even asked on a Sunday', () => {
    // 2026-10-25 is a Sunday; the next weekend is 30 Oct – 1 Nov
    const w = parseDateRange('наступні вихідні', '2026-10-25');
    assert.deepEqual([w.from, w.to], ['2026-10-30', '2026-11-01'], 'asked on Sunday it used to hand back one day');
    assert.equal(weekdayOf(w.from), 5);
    // from a Wednesday it is still the weekend after this one
    const fromWed = parseDateRange('next weekend', '2026-10-21');
    assert.deepEqual([fromWed.from, fromWed.to], ['2026-10-30', '2026-11-01']);
  });

  it('reads both ends of an ISO range', () => {
    for (const text of ['2026-10-24..2026-10-26', '2026-10-24 - 2026-10-26', 'from 2026-10-24 to 2026-10-26']) {
      assert.deepEqual([parseDateRange(text, '2026-10-20').from, parseDateRange(text, '2026-10-20').to], ['2026-10-24', '2026-10-26'], text);
    }
    // the wrong way round is still a range
    assert.deepEqual(
      [parseDateRange('2026-10-26..2026-10-24', '2026-10-20').from, parseDateRange('2026-10-26..2026-10-24', '2026-10-20').to],
      ['2026-10-24', '2026-10-26'],
    );
    const one = parseDateRange('2026-10-24', '2026-10-20');
    assert.deepEqual([one.from, one.to], ['2026-10-24', '2026-10-24']);
  });

  it('does not read a clock time in a search as a price cap', () => {
    assert.equal(parseRequest('що буде до 20:00?', { prefs, base: '2026-10-20' }).maxPrice, undefined);
    assert.equal(parseRequest('стендап до 500 грн', { prefs, base: '2026-10-20' }).maxPrice, 500);
    assert.equal(parseRequest('концерт, бюджет 900', { prefs, base: '2026-10-20' }).maxPrice, 900);
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

  /**
   * Telegram posts say "щотижня" or "25 жовтня" all the time. Kept, such a
   * string used to reach dayLabel → Invalid Date → RangeError, taking the
   * whole city's digest down with it.
   */
  it('drops a startDate it cannot parse rather than keeping poison', () => {
    const item = makeItem({ city: 'kharkiv', title: 'Щотижня', url: 'https://x/w', source: 'telegram:@x', startsAt: 'щотижня' })!;
    assert.equal(item.startsAt, undefined, 'human text is not a date');
    assert.equal(fromSchemaEvent({ name: 'Шоу', url: 'https://x/s', startDate: '25 жовтня' }, { city: 'kharkiv', source: 'x' })!.startsAt, undefined);
    // a real date still passes untouched
    assert.equal(makeItem({ city: 'kharkiv', title: 'Gig', url: 'https://x/g', source: 's', startsAt: '2026-10-25T19:00:00+03:00' })!.startsAt, '2026-10-25T19:00:00+03:00');
  });

  it('takes the poster off a Concert.ua event, at full size', () => {
    const item = fromSchemaEvent(JSON.parse(fixture('concertua-soldout.json')), { city: 'kharkiv', source: 'concert.ua' });
    assert.ok(item);
    // the catalog's ":31-catalog-event_item-desktop" preset is a 270x200
    // thumbnail; the bare path is the 1920x1080 poster
    assert.equal(item.image, 'https://storage.concert.ua/JIX/20/gq/6ad7336a98acf/8ad2.jpg');
  });

  it('takes the poster out of a Karabas ImageObject', () => {
    const item = fromSchemaEvent(JSON.parse(fixture('karabas-event.json')), { city: 'kharkiv', source: 'karabas' });
    assert.ok(item);
    assert.equal(item.image, 'https://images.karabas.com/external/0188/events/019f/2845364609_ImageBig639251718260197275.jpeg');
  });

  it('leaves an event with no usable poster as a text card', () => {
    const base = JSON.parse(fixture('karabas-event.json'));
    for (const image of [undefined, '', '   ', 'data:image/png;base64,AAAA', 'javascript:alert(1)', 42, {}, [], { url: 7 }]) {
      const item = fromSchemaEvent({ ...base, image }, { city: 'kharkiv', source: 'karabas' });
      assert.ok(item, `image ${JSON.stringify(image)} should not reject the event`);
      assert.equal(item.image, undefined, `image ${JSON.stringify(image)} should not survive`);
    }
  });

  it('resolves a relative poster against the event page', () => {
    assert.equal(
      pickImage('/uploads/poster.jpg', 'https://kharkiv.kontramarka.ua/uk/show-1.html'),
      'https://kharkiv.kontramarka.ua/uploads/poster.jpg',
    );
    assert.equal(pickImage('//cdn.example.com/x.jpg', 'https://a.example/b'), 'https://cdn.example.com/x.jpg');
  });

  it('parses Kontramarka microdata cards', async () => {
    const html = fixture('kontramarka-card.html');
    const cheerio = await import('cheerio');
    const $ = cheerio.load(html);
    assert.equal($('.cat_item[itemtype*="schema.org/Event"]').length, 1);
    assert.equal($('[itemprop="name"]').first().text().trim(), 'Василь Байдак');
    assert.equal($('meta[itemprop="startDate"]').attr('content'), '2026-10-21T18:30:00+03:00');
    assert.equal(typeof collectKontramarka, 'function');

    const card = $('.cat_item[itemtype*="schema.org/Event"]').first()[0];
    assert.ok(card);
    const schema = cardToSchema($, card);
    assert.ok(schema);
    assert.equal(schema['image'], 'https://cdn.kontramarka.ua/uploads/resize/shows/logo/630x891_1787415980.webp');
    const item = fromSchemaEvent(schema, { city: 'kharkiv', source: 'kontramarka' });
    assert.ok(item);
    assert.equal(item.image, 'https://cdn.kontramarka.ua/uploads/resize/shows/logo/630x891_1787415980.webp');
  });

  it('falls back to the card thumbnail when Kontramarka drops the image meta', async () => {
    const cheerio = await import('cheerio');
    const $ = cheerio.load(fixture('kontramarka-card.html').replace(/<meta itemprop="image"[^>]*>/, ''));
    const card = $('.cat_item[itemtype*="schema.org/Event"]').first()[0];
    assert.ok(card);
    assert.equal(
      cardToSchema($, card)?.['image'],
      'https://cdn.kontramarka.ua/uploads/resize/shows/logo/630x891_thumb.webp',
    );
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

  it('takes the better poster when merging, not the first one seen', () => {
    const thumb = makeItem({ ...base, title: 'Тест', url: 'https://x/a', source: 'kontramarka', image: 'https://cdn/x.jpg:thumb-120' })!;
    const poster = makeItem({ ...base, title: 'Тест', url: 'https://x/b', source: 'karabas', image: 'https://img/poster.jpeg' })!;
    assert.equal(dedupe([thumb, poster])[0]!.image, 'https://img/poster.jpeg');
    assert.equal(dedupe([poster, thumb])[0]!.image, 'https://img/poster.jpeg');
  });

  it('keeps the only poster there is, even from the less trusted source', () => {
    // the richer item wins the facts; it must not drag the merge down to no picture
    const rich = makeItem({ ...base, title: 'Тест', url: 'https://x/a', source: 'concert.ua', venue: 'ТКЦ', description: 'bla', priceMin: 300 })!;
    const poor = makeItem({ ...base, title: 'Тест', url: 'https://x/b', source: 'telegram:@kh', image: 'https://img/poster.jpeg' })!;
    const merged = dedupe([rich, poor])[0]!;
    assert.equal(merged.image, 'https://img/poster.jpeg');
    assert.equal(merged.venue, 'ТКЦ');
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

  it('drops a blocked act even when the same name is in the follow list', () => {
    const p = PreferencesSchema.parse({
      home_city: 'kharkiv',
      favourite_categories: ['concert'],
      follow: ['Курган і Agregat'],
      blocked_acts: ['Курган і Agregat'],
    });
    const gig = makeItem({ ...common, title: 'Курган і Agregat', url: 'https://x/b1', source: 'concert.ua', category: 'concert', priceMin: 900 })!;
    const other = makeItem({ ...common, title: 'Хтось інший', url: 'https://x/b2', source: 'concert.ua', category: 'concert', priceMin: 300 })!;
    const ranked = rank([gig, other], { query: parseRequest('', { prefs: p, base: '2026-10-20' }), prefs: p, tasteFloor: 0 });
    assert.deepEqual(ranked.items.map((i) => i.title), ['Хтось інший']);
    assert.ok(ranked.dropped.some((d) => d.why.includes('blocked act')), JSON.stringify(ranked.dropped.map((d) => d.why)));
    // and the shared cache, which keeps dislikes, keeps it too — scored last
    const cached = rank([gig], { query: parseRequest('', { prefs: p, base: '2026-10-20' }), prefs: p, keepDisliked: true, keepOffTaste: true });
    assert.equal(cached.items.length, 1);
    assert.ok(!cached.items[0]!.reasons?.some((r) => r.includes('you follow')), JSON.stringify(cached.items[0]!.reasons));
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

  /**
   * A date that does not parse used to yield an empty day bucket (not 'tbd'),
   * and dayLabel('') threw RangeError in the digest header; the soonness
   * bonus went NaN, and V8 sorts NaN to the front — one junk date could lead
   * every digest and crash the rest.
   */
  it('a bad date scores a real number and groups under tbd', () => {
    const bad = { ...makeItem({ city: 'kharkiv', title: 'Незрозуміле', url: 'https://x/bd', source: 's', category: 'standup' })!, startsAt: 'щотижня' } as Item;
    const good = makeItem({ ...common, title: 'Відкритий мікрофон', url: 'https://x/good', source: 'karabas', category: 'standup', priceMin: 200 })!;
    const ranked = rank([bad, good], { query, prefs });
    assert.ok(ranked.items.every((i) => !Number.isNaN(i.score!)), 'no score may be NaN');
    assert.deepEqual(groupByDay(ranked.items, TZ).map((g) => g.day).includes('tbd'), true, 'an unparseable date is "unknown", not its own day');
    // and the digest header for that bucket renders instead of throwing
    const head = groupByDay(ranked.items, TZ).find((g) => g.day === 'tbd')!;
    assert.ok(buildDigest({ title: 'T', query, items: head.items, format: 'text' }).text.includes('уточнюється'));
  });

  it('dayLabel shrugs off an unparseable date', () => {
    assert.equal(dayLabel(''), '');
    assert.equal(dayLabel('щотижня'), '');
    assert.notEqual(dayLabel('2026-10-24'), '');
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
    assert.ok(renderReminders([]).includes('⏰') && renderReminders([]).includes('❤️'));
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

  it('drops the description rather than overrun a caption', () => {
    // renderItem already caps a title at 160 and a blurb at 140, so a normal
    // card fits 1024 easily; escaping is what pushes one over ("&" -> "&amp;")
    const long = makeItem({
      city: 'kharkiv',
      title: '&'.repeat(160),
      url: 'https://x/caption',
      source: 'karabas',
      startsAt: '2026-10-24T19:00:00+03:00',
      venue: 'Театрально-концертний центр',
      description: '&'.repeat(400),
      priceMin: 300,
      image: 'https://img/p.jpg',
    })!;
    const full = renderItem(long, { format: 'html' });
    const caption = renderCaption(long, { format: 'html' });
    assert.ok(full.length > CAPTION_LIMIT, `the full card was only ${full.length} chars`);
    assert.ok(caption, 'this card is renderable as a caption');
    assert.ok(caption.length <= CAPTION_LIMIT, `caption was ${caption.length} chars`);
    // the facts a caption exists for must survive; only the blurb goes
    assert.ok(caption.includes('19:00'), caption);
    assert.ok(caption.includes('300'), caption);
    assert.ok(caption.includes('Театрально-концертний центр'), caption);
    assert.ok(caption.includes('https://x/caption'), caption);
  });

  it('leaves a short card alone, description and all', () => {
    const short = makeItem({ city: 'kharkiv', title: 'Коротко', url: 'https://x/s', source: 'karabas', startsAt: '2026-10-24T19:00:00+03:00', description: 'Два слова.', image: 'https://img/p.jpg' })!;
    const caption = renderCaption(short, { format: 'html' });
    assert.equal(caption, renderItem(short, { format: 'html' }));
    assert.ok(caption!.includes('Два слова.'));
  });

  it('fits a caption even when escaping multiplies every character', () => {
    // "&" becomes "&amp;": a 160-character title can render as 960
    const hostile = makeItem({ city: 'kharkiv', title: '&'.repeat(160), url: 'https://x/h', source: 'karabas', startsAt: '2026-10-24T19:00:00+03:00', venue: '<'.repeat(120), image: 'https://img/p.jpg' })!;
    const caption = renderCaption(hostile, { format: 'html' });
    assert.ok(caption, 'should still fit after shrinking the fields');
    assert.ok(caption.length <= CAPTION_LIMIT, `caption was ${caption.length} chars`);
    assert.ok(!/<[a-z]*$/.test(caption), 'must never cut an HTML tag in half');
  });

  it('gives up on the caption rather than drop the link', () => {
    const silly = makeItem({ city: 'kharkiv', title: 'Тест', url: `https://x/${'z'.repeat(2000)}`, source: 'karabas', startsAt: '2026-10-24T19:00:00+03:00', image: 'https://img/p.jpg' })!;
    assert.equal(renderCaption(silly, { format: 'html' }), null);
    // and the digest then sends it as an ordinary message
    const msg = buildMessages({ title: 'T', query, items: [silly], format: 'html' })[1]!;
    assert.equal(msg.image, undefined);
    assert.ok(msg.text.includes('z'.repeat(2000)));
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

/* ---------------------------------------------------------- getUpdates --- */

describe('getUpdates parsing', () => {
  // a well-formed message update, as Telegram sends it
  const good = (id: number, text: string) => ({
    update_id: id,
    message: { message_id: id, date: 1, chat: { id: 42, type: 'private' }, text, from: { id: 42 } },
  });

  it('skips one malformed update without losing the rest of the batch', () => {
    const poison = { update_id: 6, message: { message_id: 'not-a-number', date: 1, chat: { id: 42 } } };
    const { updates, lastUpdateId } = parseUpdates([good(5, 'hi'), poison, good(7, 'again')]);
    assert.deepEqual(updates.map((u) => u.update_id), [5, 7]);
    // the offset must still advance past the poison, or the poll loop would
    // re-fetch the same bad batch forever and the bot would serve nobody
    assert.equal(lastUpdateId, 7);
  });

  it('reports the highest raw id even when every update is garbage', () => {
    // update_id 99 is a number (so it advances the offset) but its message is
    // the wrong shape, so nothing is dispatched
    const { updates, lastUpdateId } = parseUpdates([{ nonsense: true }, 'string', { update_id: 99, message: 5 }]);
    assert.equal(updates.length, 0);
    assert.equal(lastUpdateId, 99);
  });

  it('stays quiet on an empty batch', () => {
    const { updates, lastUpdateId } = parseUpdates([]);
    assert.equal(updates.length, 0);
    assert.equal(lastUpdateId, -1);
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

  it('sends an event with a poster as a photo, and one without as text', () => {
    const withPoster = makeItem({ city: 'kharkiv', title: 'З афішею', url: 'https://m/p', source: 'karabas', startsAt: '2026-10-23T19:00:00+03:00', image: 'https://img/poster.jpeg' })!;
    const msgs = buildMessages({ title: 'T', query, items: [withPoster, earlier], format: 'html' });
    const photo = msgs.find((m) => m.items[0]?.id === withPoster.id)!;
    assert.equal(photo.image, 'https://img/poster.jpeg');
    assert.ok(photo.caption && photo.caption.includes('З афішею'), photo.caption);
    assert.ok(photo.caption!.length <= CAPTION_LIMIT);
    const plainMsg = msgs.find((m) => m.items[0]?.id === earlier.id)!;
    assert.equal(plainMsg.image, undefined);
    assert.equal(plainMsg.caption, undefined);
  });

  it('keeps the full card as the message text, so a refused poster loses nothing', () => {
    const item = makeItem({ city: 'kharkiv', title: 'Опис', url: 'https://m/d', source: 'karabas', startsAt: '2026-10-23T19:00:00+03:00', image: 'https://img/p.jpg', description: 'Довгий опис події.' })!;
    const msg = buildMessages({ title: 'T', query, items: [item], format: 'html' })[1]!;
    assert.ok(msg.text.includes('Довгий опис'), msg.text);
    assert.ok(msg.image);
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

  it('gives every event card the same buttons, callback data and all', () => {
    const msgs = buildMessages({ title: 'T', query, items: [earlier], format: 'text' });
    assert.deepEqual(msgs[0]!.inlineKeyboard, undefined, 'the header is not an event');
    const rows = msgs[1]!.inlineKeyboard!;
    const labels = rows.flat().map((b) => b.text);
    assert.deepEqual(labels, ['ℹ️ Деталі', '🔖 Зберегти', '⏰ Нагадати', '👎 Не моє', '📅 В календар']);
    for (const b of rows.flat()) {
      // 📅 is a link, every other button calls back
      if ('url' in b) {
        assert.equal(b.text, '📅 В календар');
        assert.ok(b.url.startsWith('https://calendar.google.com/'), b.url);
        continue;
      }
      assert.ok(b.callback_data.startsWith('ev:'), JSON.stringify(b));
      assert.ok(Buffer.byteLength(b.callback_data) <= 64, b.callback_data);
    }
  });

  it('leaves 📅 off an event whose date is still unknown', () => {
    const undated = makeItem({ city: 'kharkiv', title: 'Колись', url: 'https://m/c', source: 's' })!;
    const labels = eventKeyboard(undated).flat().map((b) => b.text);
    assert.deepEqual(labels, ['ℹ️ Деталі', '🔖 Зберегти', '⏰ Нагадати', '👎 Не моє']);
    assert.equal(googleCalendarUrl(undated), undefined);
  });

  it('sends one message per place too', () => {
    const place = makeItem({ city: 'kharkiv', kind: 'place', title: 'Kofein Lab', url: 'https://m/e', source: 'websearch', category: 'cafe', address: 'вул. Сумська, 11' })!;
    const msgs = buildMessages({ title: 'Місця', query, items: [place], format: 'text' });
    assert.equal(msgs.length, 2);
    assert.ok(msgs[1]!.text.includes('вул. Сумська, 11'));
  });
});

/* --------------------------------------------------------------- calendar --- */

describe('calendar', () => {
  const item = makeItem({
    city: 'kharkiv',
    title: 'Джаз, вино; і трохи сліз',
    url: 'https://tickets.example/ua/jazz?id=7&utm=bot',
    source: 's',
    startsAt: '2026-10-23T19:30:00+03:00',
    venue: 'Пивна дума, 2 поверх',
    address: 'вул. Сумська, 11',
    description: 'Квартет грає стандарти.',
  })!;

  const params = (url: string) => new URL(url).searchParams;

  it('builds a TEMPLATE link with the title, the place and the ticket link', () => {
    const url = googleCalendarUrl(item)!;
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, 'https://calendar.google.com/calendar/render');
    assert.equal(params(url).get('action'), 'TEMPLATE');
    assert.equal(params(url).get('text'), 'Джаз, вино; і трохи сліз');
    assert.equal(params(url).get('location'), 'Пивна дума, 2 поверх, вул. Сумська, 11');
    assert.ok(params(url).get('details')!.includes('https://tickets.example/ua/jazz?id=7&utm=bot'));
    // Ukrainian titles and their punctuation go through the encoder, not raw
    assert.ok(!url.includes(' '), url);
    assert.ok(url.includes('%2C'), url);
  });

  it('puts the time in as UTC, so Kyiv evenings stay Kyiv evenings', () => {
    // 19:30 at +03:00 is 16:30 UTC
    assert.equal(params(googleCalendarUrl(item)!).get('dates'), '20261023T163000Z/20261023T183000Z');
  });

  it('defaults the end to two hours out and says the length is a guess', () => {
    const details = params(googleCalendarUrl(item)!).get('details')!;
    assert.ok(details.includes('Тривалість приблизна'), details);
  });

  it('keeps a real endsAt, and then claims nothing about the length', () => {
    const url = googleCalendarUrl({ ...item, endsAt: '2026-10-23T23:00:00+03:00' })!;
    assert.equal(params(url).get('dates'), '20261023T163000Z/20261023T200000Z');
    assert.ok(!params(url).get('details')!.includes('Тривалість приблизна'));
  });

  it('ignores an end that falls before the start', () => {
    const url = googleCalendarUrl({ ...item, endsAt: '2026-10-23T10:00:00+03:00' })!;
    assert.equal(params(url).get('dates'), '20261023T163000Z/20261023T183000Z');
  });

  it('has nothing to offer an event with no start time', () => {
    assert.equal(googleCalendarUrl({ ...item, startsAt: undefined }), undefined);
    assert.equal(googleCalendarUrl({ ...item, startsAt: 'колись у травні' }), undefined);
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

  it('does not read a start time as the day of the month', () => {
    // "о 9.05" is five past nine; it used to be read as the 9th of May
    assert.equal(findDate('Стендап у пʼятницю, початок о 9.05', base), findDate('Стендап у пʼятницю', base));
    const post = parsePost(
      { id: 9, channel: 'c', text: 'Великий концерт 25 жовтня, початок о 19.30, вхід 200 грн' },
      { city: 'kharkiv', base, tz: TZ },
    );
    assert.equal(post?.startsAt?.slice(0, 10), '2026-10-25', 'the date is the date, not the clock');
    assert.equal(findDate('Концерт 25.10 о 19.30', base), '2026-10-25');
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

  /**
   * "до" is an ordinary Ukrainian preposition, and \d{2,5} matches the first
   * digits of a time. "що буде до 20:00?" used to set the budget to 20,
   * answer "✅ Записав" and swallow the search entirely.
   */
  it('does not read a time or an ordinary "до" as a budget', () => {
    check('що буде до 20:00?', { understood: false });
    check('події до 3000 цього тижня', { understood: false });
    check('відкритий мікрофон до 20:00', { understood: false });
    // …but a price sentence still lands, whether the opener says "money" by
    // itself or leans on a price word to make "до" mean money
    assert.equal(applyPrefsCommand('до 500 грн', current).prefs.max_ticket_price, 500);
    assert.equal(applyPrefsCommand('хочу щось до 1000 гривень', current).prefs.max_ticket_price, 1000);
    assert.equal(applyPrefsCommand('не дорожче 700', current).prefs.max_ticket_price, 700);
    assert.equal(applyPrefsCommand('under 400 uah', current).prefs.max_ticket_price, 400);
    assert.equal(applyPrefsCommand('max 500', current).prefs.max_ticket_price, 500);
    assert.equal(applyPrefsCommand('limit 500', current).prefs.max_ticket_price, 500);
    assert.equal(applyPrefsCommand('ліміт 500', current).prefs.max_ticket_price, 500);
    assert.equal(applyPrefsCommand('максимум 500', current).prefs.max_ticket_price, 500);
    assert.equal(applyPrefsCommand('не більше 600', current).prefs.max_ticket_price, 600);
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

describe('the 👎 side of the taste model', () => {
  const liked = () => PreferencesSchema.parse({ home_city: 'kharkiv', favourite_categories: ['standup'], taste: { standup: 2 } });

  it('takes a point off the tally without touching the lists', () => {
    const down = applyThumbsDown(liked(), { tag: 'standup' });
    assert.equal(down.score, 1);
    assert.equal(down.demoted, false);
    assert.deepEqual(down.prefs.favourite_categories, ['standup']);
    assert.deepEqual(down.prefs.disliked_categories, []);
  });

  it('moves the category across once the tally reaches the threshold', () => {
    let down = applyThumbsDown(liked(), { tag: 'standup' });
    for (let i = 0; i < 4; i++) down = applyThumbsDown(down.prefs, { tag: 'standup' });
    assert.equal(down.score, -3);
    assert.equal(down.demoted, true);
    assert.deepEqual(down.prefs.favourite_categories, []);
    assert.deepEqual(down.prefs.disliked_categories, ['standup']);
    // and saying you like it again clears the debt, not just the list
    const back = applyPrefsCommand('люблю стендап', down.prefs);
    assert.deepEqual(back.prefs.disliked_categories, []);
    assert.equal(back.prefs.taste['standup'], 0);
  });

  it('silences the performer and takes the name off the follow list', () => {
    const following = PreferencesSchema.parse({ home_city: 'kharkiv', follow: ['Антон Тимошенко'] });
    const down = applyThumbsDown(following, { tag: 'standup', act: 'Антон Тимошенко' });
    assert.deepEqual(down.prefs.blocked_acts, ['Антон Тимошенко']);
    assert.deepEqual(down.prefs.follow, []);
    assert.equal(down.blocked, 'Антон Тимошенко');
    // ...and asking for them by name again undoes it
    const again = applyPrefsCommand('слідкуй за Антон Тимошенко', down.prefs);
    assert.deepEqual(again.prefs.blocked_acts, []);
    assert.deepEqual(again.prefs.follow, ['Антон Тимошенко']);
  });

  it('reads a profile saved before the stop list existed', () => {
    const old = { home_city: 'kharkiv', favourite_categories: ['standup'], follow: ['Хтось'], taste: { standup: 3 } };
    const parsed = PreferencesSchema.parse(old);
    assert.deepEqual(parsed.blocked_acts, []);
    // and a tally that has already gone negative survives the round-trip
    assert.equal(PreferencesSchema.parse({ home_city: 'kharkiv', taste: { standup: -2 } }).taste['standup'], -2);
  });

  it('shows what it stopped showing, not only what it likes', () => {
    const down = applyThumbsDown(liked(), { tag: 'standup', act: 'Антон Тимошенко' });
    assert.ok(describePrefs(down.prefs).includes('не показую: Антон Тимошенко'), describePrefs(down.prefs));
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

/**
 * A stubbed Bot API, for the tests whose point is what the *send* does — a
 * card's message id, a stash parked next to it — rather than what it says. A
 * dry run never calls Telegram at all, so it hands back no message ids and
 * nothing that keys off one can be checked under it.
 */
interface FakeCall {
  method: string;
  body: Record<string, unknown>;
}

/**
 * A stubbed Bot API: for the cases whose point is what the *send* does, which
 * a dry run never reaches — a poster Telegram rejects, a chat it says is gone.
 */
async function withFakeTelegram<T>(
  reply: (call: FakeCall) => { ok: boolean; description?: string; status?: number },
  body: (calls: FakeCall[]) => Promise<T>,
): Promise<T> {
  const calls: FakeCall[] = [];
  const realFetch = globalThis.fetch;
  const realToken = process.env['TELEGRAM_BOT_TOKEN'];
  process.env['TELEGRAM_BOT_TOKEN'] = 'test:token';
  let nextId = 500;
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    const method = String(url).split('/').pop()!;
    const call = { method, body: JSON.parse(init.body) as Record<string, unknown> };
    calls.push(call);
    const verdict = reply(call);
    return {
      json: async () =>
        verdict.ok
          ? { ok: true, result: { message_id: nextId++, date: 0, chat: { id: call.body['chat_id'] } } }
          : { ok: false, description: verdict.description ?? 'Bad Request' },
      status: verdict.ok ? 200 : verdict.status ?? 400,
    };
  }) as unknown as typeof globalThis.fetch;
  try {
    return await body(calls);
  } finally {
    globalThis.fetch = realFetch;
    if (realToken === undefined) delete process.env['TELEGRAM_BOT_TOKEN'];
    else process.env['TELEGRAM_BOT_TOKEN'] = realToken;
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

  /**
   * /stop says "більше нічого не надсилаю" — it used to hold for digests only,
   * because dueReminders never looked at users.blocked and kept pushing
   * ❤️ reminders to people who had unsubscribed.
   */
  it('gives a chat that said /stop no reminders, and brings them back on /start', async () => {
    await withTestStore(async (store) => {
      const soon = makeItem({ ...item, title: 'Blocked soon', url: 'https://x/blocked', startsAt: new Date(Date.now() + 20 * 3600_000).toISOString() })!;
      await store.ensureUser({ chatId: 'stopper', city: 'kharkiv', prefs: '{}' });
      await store.addReminder('stopper', soon);
      assert.ok((await store.dueReminders()).some((d: { row: { chat_id: string } }) => d.row.chat_id === 'stopper'));

      await store.setBlocked('stopper', true);
      assert.ok(!(await store.dueReminders()).some((d: { row: { chat_id: string } }) => d.row.chat_id === 'stopper'), 'a /stop must silence reminders too');
      assert.equal((await store.listReminders('stopper')).length, 0, 'and /reminders shows nothing to a stopped chat');
      // the rows are kept, not deleted — /start (ensureUser) unblocks…
      assert.equal((await store.listReminders()).filter((r: { chat_id: string }) => r.chat_id === 'stopper').length, 0);

      // …so a returning user gets their reminders back untouched
      await store.ensureUser({ chatId: 'stopper', city: 'kharkiv', prefs: '{}' });
      assert.ok((await store.dueReminders()).some((d: { row: { chat_id: string } }) => d.row.chat_id === 'stopper'), '/start brings them back');
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

  /**
   * `messages`, `deliveries` and `usage` only ever grew. The dangerous half of
   * housekeeping is deleting too much, so that is what this pins down.
   */
  it('prunes what has expired and leaves everything still in use', async () => {
    await withTestStore(async (store) => {
      await store.prune(); // from a known-clean starting point
      const before = await store.stats();

      await store.putCache('stale-entry', [item], -60);
      await store.putCache('warm-entry', [item], 600);
      await store.recordSent('prune-me', [item]);
      await store.recordMessage('prune-me', 11, [item]);
      await store.addReminder('prune-me', item);
      await store.hitRateLimit('prune-me', 20);
      assert.equal((await store.stats())['cached'], (before['cached'] ?? 0) + 2);

      await store.prune();

      const after = await store.stats();
      assert.equal(after['cached'], (before['cached'] ?? 0) + 1, 'the expired entry goes, the warm one stays');
      assert.equal(after['deliveries'], (before['deliveries'] ?? 0) + 1, 'a digest must not repeat itself after a prune');
      assert.equal(after['messages'], (before['messages'] ?? 0) + 1, 'a ❤️ still has to resolve to its event');
      assert.equal((await store.listReminders('prune-me')).length, 1);
      // and the rate limit still remembers this hour
      assert.equal((await store.hitRateLimit('prune-me', 20)).used, 2);
    });
  });

  it('only asks the database for the reminders that could be due', async () => {
    await withTestStore(async (store) => {
      const far = makeItem({ ...item, title: 'Far off', url: 'https://x/far', startsAt: new Date(Date.now() + 40 * 86_400_000).toISOString() })!;
      await store.addReminder('u-far', far);
      assert.equal((await store.listReminders('u-far')).length, 1, '/reminders still shows it');
      const due = await store.dueReminders();
      assert.ok(!due.some((d: { row: { chat_id: string } }) => d.row.chat_id === 'u-far'), 'a month out is not due');
    });
  });

  it('round-trips a poster, and still reads a cached scrape from before there were any', async () => {
    await withTestStore(async (store) => {
      const withPoster = makeItem({ ...item, id: undefined, url: 'https://x/poster', image: 'https://img/p.jpeg' })!;
      await store.putCache('k-img', [withPoster, item], 60);
      const back = await store.getCache('k-img');
      assert.equal(back?.length, 2);
      assert.equal(back![0]!.image, 'https://img/p.jpeg');
      // the second one was serialized with no `image` key at all, exactly like
      // every row written before this field existed — it must still parse
      assert.ok(!JSON.stringify(item).includes('image'));
      assert.equal(back![1]!.image, undefined);
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

  it('adds digest_days to a database created before it existed, and keeps the old choices working', async () => {
    // the shape a database had before the schedule was an hour plus days
    const dbFile = process.env['EVENTS_FINDER_DB']!;
    await withTestStore((store) => store.close());
    const { default: Database } = await import('better-sqlite3');
    const raw = new Database(dbFile);
    raw.exec(`
      DROP TABLE users;
      CREATE TABLE users (
        chat_id text PRIMARY KEY, username text, first_name text, city text NOT NULL,
        prefs text NOT NULL, stage text, weekly_digest integer NOT NULL DEFAULT 1,
        weekend_digest integer NOT NULL DEFAULT 1, follow_alerts integer NOT NULL DEFAULT 1,
        place_tips integer NOT NULL DEFAULT 1, digest_hour integer NOT NULL DEFAULT 9,
        digest_day integer NOT NULL DEFAULT 1, digest_freq text NOT NULL DEFAULT 'twice',
        blocked integer NOT NULL DEFAULT 0, last_seen_at text,
        created_at text NOT NULL, updated_at text NOT NULL);
      INSERT INTO users (chat_id, city, prefs, digest_hour, digest_day, digest_freq, created_at, updated_at)
        VALUES ('legacy', 'kharkiv', '{}', 7, 5, 'weekly', 'now', 'now');
    `);
    raw.close();

    const reopened = await Store.open();
    try {
      assert.equal(reopened.dialect, 'sqlite');
      // the column came back, and it reads as "untouched"…
      const row = await reopened.getUser('legacy');
      assert.ok(row, 'the row still parses');
      assert.equal(row.digest_days, null);
      // …so the legacy pair still decides what they get: Friday only
      const s = scheduleOf(row);
      assert.equal(s.hour, 7);
      assert.deepEqual(s.days, [5], 'weekly meant that one day and no Thursday');
      assert.ok(digestDueNow(s, 'weekly', { hour: 7, weekday: 5 }));
      assert.ok(!digestDueNow(s, 'weekend', { hour: 7, weekday: WEEKEND_DAY }));

      // the first tap through the panel retires the legacy columns for good
      await reopened.setSchedule('legacy', { days: [1, WEEKEND_DAY] });
      const after = await reopened.getUser('legacy');
      assert.equal(after?.digest_days, (1 << 1) | (1 << WEEKEND_DAY));
      assert.deepEqual(scheduleOf(after).days, [1, WEEKEND_DAY]);
    } finally {
      await reopened.close();
    }
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

/* ------------------------------------------------------------ city cache --- */

describe('the shared city scrape', () => {
  const log = makeLogger('test');
  const page = () => `<html><script type="application/ld+json">${fixture('karabas-event.json')}</script></html>`;

  it('gives a deeper digest and a quick chat search their own cache entries', () => {
    const window = { city: 'kharkiv', from: '2026-10-24', to: '2026-10-26', kinds: ['event' as const] };
    assert.notEqual(
      cacheKey(window, ALL_SOURCE_NAMES, 6),
      cacheKey(window, ALL_SOURCE_NAMES, 2),
      'a two-page search must not be served to a six-page digest',
    );
    assert.equal(cacheKey(window, ALL_SOURCE_NAMES, 6), cacheKey(window, [...ALL_SOURCE_NAMES].reverse(), 6));
  });

  it('scrapes once when two people ask for the same city at the same moment', async () => {
    await withTestStore(async (store) => {
      let fetches = 0;
      const fetchText = async (url: string) => {
        fetches++;
        return url.includes('page=') ? '<html></html>' : page();
      };
      const ask = () =>
        collectCity({
          store,
          log,
          city: 'kharkiv',
          from: '2026-12-08',
          to: '2026-12-09',
          kinds: ['event'],
          sources: ['karabas'],
          maxPages: 1,
          fetchText,
        });
      const [a, b] = await Promise.all([ask(), ask()]);
      assert.equal(fetches, 1, `both askers shared one crawl, not ${fetches}`);
      assert.deepEqual(a.items.map((i) => i.id), b.items.map((i) => i.id));
      assert.ok(a.items.length > 0);

      // and the next ask comes off the cache without touching the site at all
      const later = await ask();
      assert.equal(fetches, 1);
      assert.equal(later.cached, true);
    });
  });

  it('says what each source came back with, so one tick can be judged', async () => {
    await withTestStore(async (store) => {
      // only Karabas' pages carry anything; the other two answer 200 with
      // nothing in them, which is exactly the silent failure we are after
      const fetchText = async (url: string) => (url.includes('karabas') && !url.includes('page=') ? page() : '<html></html>');
      const res = await collectCity({
        store, log, city: 'kharkiv', from: '2026-12-08', to: '2026-12-09', kinds: ['event'],
        sources: ['karabas', 'kontramarka', 'telegram'], maxPages: 1, ttlSeconds: 0, fetchText,
      });
      const per = res.perSource ?? [];
      assert.equal(per.find((p) => p.source === 'karabas')?.items, 1);
      const kontramarka = per.find((p) => p.source === 'kontramarka');
      assert.equal(kontramarka?.items, 0);
      assert.equal(kontramarka?.skipped, false, 'Kharkiv has a kontramarka section, so it really was asked');
    });
  });

  it('marks a source with no section for the city as never asked', async () => {
    await withTestStore(async (store) => {
      // config.example.yaml configures no telegram_channels anywhere, so the
      // collector returns ok with nothing to show — not a broken parser
      const res = await collectCity({
        store, log, city: 'kharkiv', from: '2026-12-08', to: '2026-12-09', kinds: ['event'],
        sources: ['telegram'], maxPages: 1, ttlSeconds: 0, fetchText: async () => '<html></html>',
      });
      assert.equal(res.perSource?.find((p) => p.source === 'telegram')?.skipped, true);
    });
  });

  it('does not pretend a cache hit is evidence about a source', async () => {
    await withTestStore(async (store) => {
      const opts = {
        // its own window: the test above warms the cache for 12-08..12-09, and
        // the whole point of this case is to watch a cold key go warm
        store, log, city: 'kharkiv' as const, from: '2026-12-08', to: '2026-12-11', kinds: ['event' as const],
        sources: ['karabas'], maxPages: 1, fetchText: async (url: string) => (url.includes('page=') ? '<html></html>' : page()),
      };
      const scraped = await collectCity(opts);
      assert.equal(scraped.cached, false);
      assert.ok(scraped.perSource, 'a real scrape says what each source found');

      const hit = await collectCity(opts);
      assert.equal(hit.cached, true);
      assert.equal(hit.perSource, undefined, 'a cache hit says nothing about whether the site still works');
    });
  });
});

/* --------------------------------------------------------------- schedule --- */

describe('schedule', () => {
  it('reads the old cron out of a row that predates the schedule columns', () => {
    // every pre-schedule user must keep behaving as the hard-wired cron did:
    // Monday 09:00, plus the Thursday weekend picks
    const legacy = scheduleOf({ chat_id: '1', city: 'kharkiv' } as never);
    assert.deepEqual(legacy, defaultSchedule());
    assert.equal(legacy.hour, 9);
    assert.deepEqual(legacy.days, [1, WEEKEND_DAY], 'Monday and Thursday');
    assert.equal(legacy.frequency, 'twice');
    assert.ok(digestDueNow(legacy, 'weekly', { hour: 9, weekday: 1 }));
    assert.ok(digestDueNow(legacy, 'weekend', { hour: 9, weekday: WEEKEND_DAY }));
  });

  it('reads the legacy weekly-only row as the one day it meant', () => {
    const s = scheduleOf({ digest_day: 5, digest_freq: 'weekly' } as never);
    assert.deepEqual(s.days, [5], 'Friday and nothing else — Thursday was never part of it');
    assert.ok(digestDueNow(s, 'weekly', { hour: 9, weekday: 5 }));
    assert.ok(!digestDueNow(s, 'weekend', { hour: 9, weekday: WEEKEND_DAY }), 'they asked for once a week');
  });

  it('falls back to the default for a value outside the clock', () => {
    assert.equal(scheduleOf({ digest_hour: 24 } as never).hour, 9);
    assert.equal(scheduleOf({ digest_hour: -1 } as never).hour, 9);
    assert.deepEqual(scheduleOf({ digest_day: 7 } as never).days, defaultSchedule().days);
    assert.equal(scheduleOf({ digest_freq: 'hourly' } as never).frequency, 'twice');
    assert.equal(scheduleOf(undefined).hour, 9);
  });

  it('round-trips a weekday set through its stored bitmask', () => {
    for (const days of [[1], [1, WEEKEND_DAY], [0, 6], [0, 1, 2, 3, 4, 5, 6], [3]]) {
      assert.deepEqual(daysFromMask(daysMask(days)), [...days].sort((a, b) => (a || 7) - (b || 7)), days.join(','));
    }
    // 0 would read as "no days" and silently resurrect the legacy columns, so
    // it is written as the Sunday bit instead — one day is the floor
    assert.equal(daysMask([0]), 1);
    assert.equal(daysMask([]), 0, 'an empty set is the sentinel for "untouched"');
  });

  it('flips one day on and off, and refuses to empty the week', () => {
    assert.deepEqual(toggleDay([1], 4), [1, WEEKEND_DAY], 'adding Thursday is how the weekend picks are asked for');
    assert.deepEqual(toggleDay([1, 4], 4), [1]);
    assert.deepEqual(toggleDay([3], 0), [3, 0], 'Sunday sorts last');
    assert.equal(toggleDay([1], 1), null, 'the last day cannot be taken off');
  });

  it('matches a digest to one hour of one of their days and nothing else', () => {
    const s = { ...defaultSchedule(), hour: 21, days: [5] };
    assert.ok(digestDueNow(s, 'weekly', { hour: 21, weekday: 5 }));
    assert.ok(!digestDueNow(s, 'weekly', { hour: 20, weekday: 5 }), 'an hour early is not their hour');
    assert.ok(!digestDueNow(s, 'weekly', { hour: 22, weekday: 5 }), 'an hour late is not their hour');
    assert.ok(!digestDueNow(s, 'weekly', { hour: 21, weekday: 4 }), 'right hour, wrong day');
  });

  it('gives every ticked day its own digest', () => {
    const s = { ...defaultSchedule(), hour: 7, days: [1, 3, 5] };
    for (const weekday of [1, 3, 5]) assert.ok(digestDueNow(s, 'weekly', { hour: 7, weekday }), `day ${weekday}`);
    for (const weekday of [0, 2, 4, 6]) assert.ok(!digestDueNow(s, 'weekly', { hour: 7, weekday }), `day ${weekday}`);
    assert.ok(!digestDueNow(s, 'weekly', { hour: 8, weekday: 1 }), 'not their hour');
  });

  it('holds the day boundaries: 00:00 and 23:00 are hours like any other', () => {
    const midnight = { ...defaultSchedule(), hour: 0, days: [0] };
    assert.ok(digestDueNow(midnight, 'weekly', { hour: 0, weekday: 0 }), 'Sunday 00:00 is a real slot');
    assert.ok(!digestDueNow(midnight, 'weekly', { hour: 23, weekday: 6 }), 'the hour before does not roll over');
    const lateSaturday = { ...defaultSchedule(), hour: 23, days: [6] };
    assert.ok(digestDueNow(lateSaturday, 'weekly', { hour: 23, weekday: 6 }));
    assert.ok(!digestDueNow(lateSaturday, 'weekly', { hour: 0, weekday: 0 }), 'and does not spill into Sunday');
  });

  it('keeps the weekend digest on Thursday whatever other days are ticked', () => {
    const s = { ...defaultSchedule(), hour: 18, days: [WEEKEND_DAY, 6] };
    assert.ok(digestDueNow(s, 'weekend', { hour: 18, weekday: WEEKEND_DAY }), 'Thursday carries the weekend picks');
    assert.ok(!digestDueNow(s, 'weekend', { hour: 18, weekday: 6 }), 'their Saturday does not move the weekend picks');
    assert.ok(digestDueNow(s, 'weekly', { hour: 18, weekday: 6 }), 'and Saturday still gets its own digest');
  });

  it('never sends both digests on the same day', () => {
    // ticking Thursday asks for the weekend one, not a second weekly digest
    const s = { ...defaultSchedule(), days: [WEEKEND_DAY] };
    assert.ok(digestDueNow(s, 'weekend', { hour: 9, weekday: WEEKEND_DAY }));
    assert.ok(!digestDueNow(s, 'weekly', { hour: 9, weekday: WEEKEND_DAY }), 'Thursday is taken, not doubled');
  });

  it('leaves the timing alone for "only when there is something of mine"', () => {
    const s = { ...defaultSchedule(), frequency: 'mine' as const };
    assert.ok(wantsOnlyMine(s));
    assert.ok(digestDueNow(s, 'weekly', { hour: 9, weekday: 1 }), 'it is a content rule, not a clock rule');
    assert.ok(digestDueNow(s, 'weekend', { hour: 9, weekday: WEEKEND_DAY }));
    assert.ok(!wantsOnlyMine(defaultSchedule()));
  });

  it('offers every weekday exactly once, in Пн…Нд order', () => {
    assert.deepEqual(DIGEST_DAYS.map((d) => d.day), [1, 2, 3, 4, 5, 6, 0]);
    assert.equal(new Set(DIGEST_DAYS.map((d) => d.day)).size, 7);
    assert.ok(DIGEST_DAYS.every((d) => d.short && d.label));
  });

  it('only offers hours that are actually on the menu, and 9 among them', () => {
    assert.ok(DIGEST_HOURS.includes(9), 'the default must be pickable, or it cannot be restored');
    assert.ok(DIGEST_HOURS.every((h) => Number.isInteger(h) && h >= 0 && h <= 23));
    assert.ok(DIGEST_HOURS.length <= 8, 'more slots means more scrapes per day — see the README');
  });

  it('describes a schedule in Ukrainian', () => {
    const line = describeSchedule({ ...defaultSchedule(), hour: 18, days: [5] });
    assert.ok(line.includes('пʼятниця') && line.includes('18:00'), line);
    assert.equal(describeSchedule(defaultSchedule()), 'понеділок і четвер, 09:00');
    assert.equal(describeSchedule({ ...defaultSchedule(), days: [0, 1, 2, 3, 4, 5, 6] }), 'щодня, 09:00');
  });

  it('names a day set the way a person would', () => {
    assert.equal(daysLabel([1]), 'понеділок');
    assert.equal(daysLabel([1, WEEKEND_DAY]), 'понеділок і четвер');
    assert.equal(daysLabel([1, 2, 3]), 'понеділок, вівторок і середа');
    assert.equal(daysLabel([6, 0]), 'субота і неділя', 'Sunday reads last, not first');
    assert.equal(daysLabel([]), 'ніколи');
  });
});

/* ----------------------------------------------------------------- fanout --- */

describe('fanout', () => {
  const window = { from: '2026-10-23', to: '2026-10-25', label: 'this weekend' };
  /** Midday Thursday: the weekend-digest day, at an hour people are out. */
  const noon = { hour: 12, weekday: WEEKEND_DAY };
  const standup = makeItem({ city: 'kharkiv', title: 'Антон Тимошенко. Стендап', url: 'https://x/su', source: 'concert.ua', category: 'standup', startsAt: '2026-10-24T19:00:00+03:00', priceMin: 400, status: 'scheduled' })!;
  const classical = makeItem({ city: 'kharkiv', title: 'Класична музика при свічках', url: 'https://x/cl', source: 'karabas', category: 'concert', startsAt: '2026-10-24T18:00:00+03:00', priceMin: 500, status: 'scheduled' })!;

  /** Pre-seed the cache so the fan-out runs without touching the network. */
  async function seed(store: StoreType, items = [standup, classical]) {
    // the depth is part of the key: a digest scrapes deeper than a chat search
    const key = cacheKey({ city: 'kharkiv', from: window.from, to: window.to, kinds: ['event'] }, ALL_SOURCE_NAMES, loadConfig().http.max_pages);
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
        now: noon,
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

  /**
   * One failing send used to take the whole job down with it: everybody after
   * that person in the list got nothing until the next schedule.
   */
  it('carries on with the other users when one send fails', async () => {
    await withTestStore(async (store) => {
      await seed(store);
      for (const chatId of ['2301', '2302', '2303']) await registerUser(store, { chatId, city: 'kharkiv' });
      const reached: string[] = [];
      const result = await fanout({
        store,
        log,
        optIn: 'weekend_digest',
        window,
        // the fixed clock its siblings use: without it the real date decides
        // whether anyone is due, and this test is about the failure, not the hour
        now: noon,
        onlyChats: ['2301', '2302', '2303'],
        dryRun: true,
        title: () => 'Weekend',
        select: (user, ranked) => {
          if (user.chatId === '2302') throw new Error('Telegram said no');
          reached.push(user.chatId);
          return ranked;
        },
      });
      assert.deepEqual(reached, ['2301', '2303'], 'the person after the failure still got their digest');
      assert.equal(result.failedUsers, 1);
      assert.equal(result.recipients, 2);
    });
  });

  it('skips people who muted the job', async () => {
    await withTestStore(async (store) => {
      await seed(store);
      await registerUser(store, { chatId: '2100', city: 'kharkiv' });
      await store.setOptIn('2100', 'weekend_digest', false);
      const result = await fanout({ store, log, optIn: 'weekend_digest', window, now: noon, onlyChats: ['2100'], dryRun: true, title: () => 'W' });
      assert.equal(result.users, 0);
    });
  });

  it('does not repeat an item it already sent that person', async () => {
    await withTestStore(async (store) => {
      await seed(store, [standup]);
      await registerUser(store, { chatId: '2200', city: 'kharkiv' });
      await store.recordSent('2200', [standup]);
      const result = await fanout({ store, log, optIn: 'weekly_digest', window, now: noon, onlyChats: ['2200'], dryRun: true, title: () => 'W' });
      assert.equal(result.items, 0, 'already delivered');
    });
  });

  it('covers only the people whose hour and day it is', async () => {
    await withTestStore(async (store) => {
      await seed(store);
      for (const chatId of ['2300', '2301', '2302']) await registerUser(store, { chatId, city: 'kharkiv' });
      await store.setSchedule('2300', { hour: 9, days: [1] });
      await store.setSchedule('2301', { hour: 18, days: [1] });
      await store.setSchedule('2302', { hour: 9, days: [4] });
      const chats = ['2300', '2301', '2302'];

      const nine = new Set<string>();
      const mondayNine = await fanout({
        store, log, optIn: 'weekly_digest', digest: 'weekly', window, dryRun: true, title: () => 'W',
        onlyChats: chats, now: { hour: 9, weekday: 1 },
        select: (user, ranked) => (nine.add(user.chatId), ranked),
      });
      assert.deepEqual([...nine], ['2300'], 'only the 09:00 Monday person');
      assert.equal(mondayNine.notNow, 2);

      const six = new Set<string>();
      await fanout({
        store, log, optIn: 'weekly_digest', digest: 'weekly', window, dryRun: true, title: () => 'W',
        onlyChats: chats, now: { hour: 18, weekday: 1 },
        select: (user, ranked) => (six.add(user.chatId), ranked),
      });
      assert.deepEqual([...six], ['2301'], 'the same job, three hours later, is a different mailing list');

      const quiet = await fanout({
        store, log, optIn: 'weekly_digest', digest: 'weekly', window, dryRun: true, title: () => 'W',
        onlyChats: chats, now: { hour: 3, weekday: 1 },
      });
      assert.equal(quiet.users, 0, 'an hour nobody picked costs nothing');
      assert.equal(quiet.scrapes + quiet.cacheHits, 0, 'and does not even touch the cache');
    });
  });

  it('gives a pre-schedule user the Monday 09:00 digest they always got', async () => {
    await withTestStore(async (store) => {
      await seed(store);
      // a row written before the schedule columns existed: no digest_hour at all
      await registerUser(store, { chatId: '2400', city: 'kharkiv' });
      await store.setSchedule('2400', {});
      const user = (await getUser(store, '2400'))!;
      assert.deepEqual(user.schedule, defaultSchedule());

      const monday = await fanout({
        store, log, optIn: 'weekly_digest', digest: 'weekly', window, dryRun: true,
        title: () => 'W', onlyChats: ['2400'], now: { hour: 9, weekday: 1 },
      });
      assert.equal(monday.recipients, 1);
      const thursday = await fanout({
        store, log, optIn: 'weekend_digest', digest: 'weekend', window, dryRun: true, newOnly: false,
        title: () => 'W', onlyChats: ['2400'], now: { hour: 9, weekday: WEEKEND_DAY },
      });
      assert.equal(thursday.recipients, 1);
    });
  });

  it('stays quiet for "only when there is something of mine" when the list was padded', async () => {
    await withTestStore(async (store) => {
      // only classical is on, and this person likes stand-up: rank() can fill
      // the list, but only by letting things they never asked for back in
      await seed(store, [classical]);
      await registerUser(store, { chatId: '2500', city: 'kharkiv' });
      const user = (await getUser(store, '2500'))!;
      await saveUserPrefs(store, user, { ...user.prefs, favourite_categories: ['standup'] });
      await store.setSchedule('2500', { frequency: 'mine' });

      const padded = await fanout({
        store, log, optIn: 'weekly_digest', digest: 'weekly', window, dryRun: true,
        title: () => 'W', onlyChats: ['2500'], now: { hour: 9, weekday: 1 },
      });
      assert.equal(padded.notTheirs, 1, 'nothing of theirs was on');
      assert.equal(padded.recipients, 0, 'so they hear nothing');

      // the same person, once there is enough of their own thing on to fill
      // the list without padding it (bot.taste_floor items)
      const standups = Array.from({ length: loadConfig().bot.taste_floor }, (_, i) =>
        makeItem({ city: 'kharkiv', title: `Стендап №${i + 1}`, url: `https://x/su${i}`, source: 'concert.ua', category: 'standup', startsAt: '2026-10-24T19:00:00+03:00', priceMin: 300, status: 'scheduled' })!,
      );
      await seed(store, [...standups, classical]);
      const theirs = await fanout({
        store, log, optIn: 'weekly_digest', digest: 'weekly', window, dryRun: true,
        title: () => 'W', onlyChats: ['2500'], now: { hour: 9, weekday: 1 },
      });
      assert.equal(theirs.notTheirs, 0);
      assert.equal(theirs.recipients, 1);
    });
  });

  it('still writes to an "only mine" user who has never said what theirs is', async () => {
    await withTestStore(async (store) => {
      await seed(store, [classical]);
      // an empty taste model gives rank() nothing to filter by, so it never
      // pads anything and toppedUp stays 0. Staying silent here would mean a
      // brand new user who tapped "тільки коли є моє" hears nothing, ever,
      // with no way to tell why.
      await registerUser(store, { chatId: '2502', city: 'kharkiv' });
      await store.setSchedule('2502', { frequency: 'mine' });
      const result = await fanout({
        store, log, optIn: 'weekly_digest', digest: 'weekly', window, dryRun: true,
        title: () => 'W', onlyChats: ['2502'], now: { hour: 9, weekday: 1 },
      });
      assert.equal(result.recipients, 1);
      assert.equal(result.notTheirs, 0);
    });
  });

  it('sends the same padded digest to everyone who did not ask for "only mine"', async () => {
    await withTestStore(async (store) => {
      await seed(store, [classical]);
      await registerUser(store, { chatId: '2501', city: 'kharkiv' });
      const user = (await getUser(store, '2501'))!;
      await saveUserPrefs(store, user, { ...user.prefs, favourite_categories: ['standup'] });

      const result = await fanout({
        store, log, optIn: 'weekly_digest', digest: 'weekly', window, dryRun: true,
        title: () => 'W', onlyChats: ['2501'], now: { hour: 9, weekday: 1 },
      });
      assert.equal(result.recipients, 1, 'a short padded list still beats silence by default');
      assert.equal(result.notTheirs, 0);
    });
  });

  it('sends a non-digest job at any hour — there is nothing left to hold it back', async () => {
    await withTestStore(async (store) => {
      await seed(store);
      await registerUser(store, { chatId: '2600', city: 'kharkiv' });
      // follow alerts and place tips keep their fixed cron time, and they go
      // out on it: the cron, not the user row, decides when
      const night = await fanout({
        store, log, optIn: 'weekly_digest', window, dryRun: true,
        title: () => 'A', onlyChats: ['2600'], now: { hour: 3, weekday: 1 },
      });
      assert.equal(night.recipients, 1);
    });
  });
});

/* ------------------------------------------------- a digest you walk through --- */

/**
 * A scheduled digest is one card with a cursor, exactly like an on-demand
 * answer: fifteen events used to be fifteen notifications in a chat nobody
 * scrolls back through.
 *
 * These go through the stubbed Bot API rather than a dry run, because the whole
 * point is the message id the header landed on and the stash parked against
 * it — a dry run hands back neither.
 */
describe('a digest is one card you walk through', () => {
  const window = { from: '2026-10-19', to: '2026-10-25', label: 'this week' };
  /** Monday 09:00 — the default weekly slot. */
  const mondayNine = { hour: 9, weekday: 1 };
  /** The header is the first message the fake API hands an id to, then the card. */
  const HEADER_ID = 500;
  const CARD_ID = 501;

  /**
   * Distinct titles, not "Подія 1..10": an item's id is a hash of its title's
   * *words* and its day, and digits are not words — ten numbered events in one
   * week would share one id and nothing about "already sent" could be checked.
   */
  const TITLES = [
    'Стендап-концерт', 'Джазовий вечір', 'Театральна премʼєра', 'Лекція про космос', 'Вечірка на даху',
    'Виставка кераміки', 'Кінопоказ просто неба', 'Воркшоп з гончарства', 'Фестиваль вуличної їжі', 'Оперна вистава',
  ];

  const gigs = (n: number) =>
    TITLES.slice(0, n).map(
      (title, i) =>
        makeItem({
          city: 'kharkiv',
          title,
          url: `https://fan/${i + 1}`,
          source: 'concert.ua',
          category: 'standup',
          startsAt: `2026-10-20T${String(10 + i).padStart(2, '0')}:00:00+03:00`,
        })!,
    );

  /** Pre-seed the city cache and a user whose digest hour is now. */
  async function ready(store: StoreType, chatId: string, items: Item[]): Promise<void> {
    const key = cacheKey({ city: 'kharkiv', from: window.from, to: window.to, kinds: ['event'] }, ALL_SOURCE_NAMES, loadConfig().http.max_pages);
    await store.putCache(key, items, 600);
    await registerUser(store, { chatId, city: 'kharkiv' });
    await store.setSchedule(chatId, { hour: 9, days: [1] });
  }

  /** Run the weekly digest for one user against a stubbed Bot API. */
  async function sendDigest(store: StoreType, chatId: string): Promise<FakeCall[]> {
    return withFakeTelegram(
      () => ({ ok: true }),
      async (calls) => {
        await fanout({
          store,
          log,
          optIn: 'weekly_digest',
          digest: 'weekly',
          window,
          now: mondayNine,
          onlyChats: [chatId],
          title: () => '🗓 Цього тижня',
          footer: `${REMINDER_HINT} /settings — щоб змінити, що тобі приходить.`,
        });
        return calls;
      },
    );
  }

  /** The stash the digest left behind, found the way "Далі →" finds it. */
  async function stashOf(store: StoreType, chatId: string) {
    const pointer = await store.getState(lastPageKey(chatId));
    return pointer ? store.getPage(pageKey(chatId, Number(pointer))) : null;
  }

  /** The one event the card that went out is showing. */
  async function cardEvent(store: StoreType, chatId: string): Promise<Item> {
    const items = await store.itemsForMessage(chatId, CARD_ID);
    assert.equal(items.length, 1, 'a card carries exactly one event, or a ❤️ on it is ambiguous');
    return items[0]!;
  }

  /**
   * Tap a button under the card sitting on `messageId`, for real rather than as
   * a dry run — `stepCard` only records what it walked into when it is
   * actually sending.
   */
  async function tapCardAt(store: StoreType, chatId: string, verb: string, itemId: string, messageId: number): Promise<FakeCall[]> {
    return withFakeTelegram(
      () => ({ ok: true }),
      async (calls) => {
        await handleCallback({ store, log }, {
          id: 'cb',
          data: `ev:${verb}:${itemId}`,
          message: { message_id: messageId, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' }, text: 'card' },
          from: { id: Number(chatId) },
        } as never);
        return calls;
      },
    );
  }

  it('sends a header and one card, not one message per event', async () => {
    await withTestStore(async (store) => {
      await ready(store, '2801', gigs(10));
      const calls = await sendDigest(store, '2801');
      assert.deepEqual(calls.map((c) => c.method), ['sendMessage', 'sendMessage'], JSON.stringify(calls.map((c) => c.method)));
      const card = await cardEvent(store, '2801');
      assert.ok(String(calls[1]!.body['text']).includes(card.title), String(calls[1]!.body['text']));
    });
  });

  it('counts the whole week in the header, not the card in front of it', async () => {
    await withTestStore(async (store) => {
      await ready(store, '2802', gigs(10));
      const header = String((await sendDigest(store, '2802'))[0]!.body['text']);
      assert.ok(header.includes('10 подій'), header);
      assert.ok(header.includes(WALK_HINT), 'the header has to say the rest is behind the card, not missing');
      assert.ok(header.includes(REMINDER_HINT), 'and keep what the job itself wanted to say');
    });
  });

  it('offers the batch button for the nine it is holding back', async () => {
    await withTestStore(async (store) => {
      await ready(store, '2812', gigs(10));
      const markup = JSON.stringify((await sendDigest(store, '2812'))[0]!.body['reply_markup']);
      assert.ok(markup.includes('Показати списком (ще 9)'), markup);
    });
  });

  it('parks the tail in the same stash a search uses, pointed at by the header', async () => {
    await withTestStore(async (store) => {
      await ready(store, '2803', gigs(10));
      const calls = await sendDigest(store, '2803');
      assert.equal(Number(await store.getState(lastPageKey('2803'))), HEADER_ID, 'the pointer names the header message');
      const page = (await stashOf(store, '2803'))!;
      assert.equal(page.rest.length, 9, 'nine events waiting');
      assert.deepEqual(page.seen, [], 'nothing walked past yet');
      assert.equal(page.header, String(calls[0]!.body['text']), 'the stash carries the header it redraws');
      assert.equal(page.size, loadConfig().bot.max_results, '"показати списком" hands out a page of max_results');
      const card = await cardEvent(store, '2803');
      assert.ok(!page.rest.some((i) => i.id === card.id), 'the card is not also in the stash');
    });
  });

  it('walks a digest with "Далі →" the same way it walks a search', async () => {
    await withTestStore(async (store) => {
      await ready(store, '2804', gigs(4));
      await sendDigest(store, '2804');
      const card = await cardEvent(store, '2804');
      const next = (await stashOf(store, '2804'))!.rest[0]!;

      const calls = await tapCardAt(store, '2804', 'n', card.id, CARD_ID);
      const swap = calls.find((c) => c.body['message_id'] === CARD_ID);
      assert.equal(swap?.method, 'editMessageText', 'the card is redrawn in place, not re-sent');
      assert.ok(String(swap!.body['text']).includes(next.title), String(swap!.body['text']));
      assert.ok(!calls.some((c) => c.method === 'sendMessage'), 'walking a digest adds no message to the chat');

      const after = (await stashOf(store, '2804'))!;
      assert.equal(after.rest.length, 2, 'the cursor moved forward one');
      assert.deepEqual(after.seen.map((i) => i.id), [card.id], 'the card it left is what "← Назад" steps into');
      assert.equal((await cardEvent(store, '2804')).id, next.id, 'and the message now resolves to the event it shows');
    });
  });

  it('steps back into a digest it already walked past', async () => {
    await withTestStore(async (store) => {
      await ready(store, '2815', gigs(4));
      await sendDigest(store, '2815');
      const first = await cardEvent(store, '2815');
      await tapCardAt(store, '2815', 'n', first.id, CARD_ID);

      const second = await cardEvent(store, '2815');
      const calls = await tapCardAt(store, '2815', 'p', second.id, CARD_ID);
      const swap = calls.find((c) => c.body['message_id'] === CARD_ID);
      assert.ok(String(swap!.body['text']).includes(first.title), String(swap!.body['text']));

      const page = (await stashOf(store, '2815'))!;
      assert.deepEqual(page.seen, [], 'back at the start, with nothing behind it');
      assert.deepEqual(page.rest.map((i) => i.id)[0], second.id, 'and the one it stepped off is next again');
    });
  });

  /** 📋 on the header is the batch half of the pair, for whoever wants a list. */
  it('hands out a digest as a list when the header button is tapped', async () => {
    await withTestStore(async (store) => {
      await ready(store, '2816', gigs(10));
      await sendDigest(store, '2816');
      const out = await captureOutput(() =>
        handleCallback({ store, log, dryRun: true }, {
          id: 'cb',
          data: 'more',
          message: { message_id: HEADER_ID, date: Math.floor(Date.now() / 1000), chat: { id: '2816', type: 'private' }, text: 'header' },
          from: { id: 2816 },
        } as never),
      );
      assert.equal(out.split('──────── to chat 2816').length - 1, 9, 'the whole tail, one message each');
      assert.equal((await stashOf(store, '2816'))!.rest.length, 0, 'and nothing left waiting');
    });
  });

  it('records the card it sent and nothing that is still in the stash', async () => {
    await withTestStore(async (store) => {
      await ready(store, '2805', gigs(10));
      await sendDigest(store, '2805');
      const card = await cardEvent(store, '2805');
      assert.equal((await store.decideSend('2805', card)).send, false, 'the card that went out is recorded');
      for (const item of (await stashOf(store, '2805'))!.rest) {
        assert.equal(
          (await store.decideSend('2805', item)).reason,
          'new',
          `${item.title} is still in the stash, so it has not been seen — next week may offer it again`,
        );
      }
    });
  });

  it('records an event in the stash once the cursor reaches it', async () => {
    await withTestStore(async (store) => {
      await ready(store, '2806', gigs(3));
      await sendDigest(store, '2806');
      const card = await cardEvent(store, '2806');
      const next = (await stashOf(store, '2806'))!.rest[0]!;
      assert.equal((await store.decideSend('2806', next)).reason, 'new', 'not reached yet');
      await tapCardAt(store, '2806', 'n', card.id, CARD_ID);
      assert.equal((await store.decideSend('2806', next)).send, false, 'walked into, so it counts as sent');
    });
  });

  /**
   * A digest arrives at 09:00 and gets read at 13:00. A one-hour stash would
   * answer the reader's own digest with "той список уже застарів", so the
   * fan-out asks for a day — and that life has to survive the rewrite the
   * cursor does on every step.
   */
  it('gives a digest stash a day rather than a search stash hour', async () => {
    await withTestStore(async (store) => {
      await ready(store, '2807', gigs(5));
      await sendDigest(store, '2807');
      const page = (await stashOf(store, '2807'))!;
      assert.equal(page.ttlSeconds, DIGEST_PAGE_TTL_SECONDS);
      assert.ok(page.ttlSeconds >= 24 * 3600, `${page.ttlSeconds}s is not long enough to read after lunch`);
    });
  });

  it('keeps that day when the cursor steps', async () => {
    await withTestStore(async (store) => {
      await ready(store, '2809', gigs(4));
      await sendDigest(store, '2809');
      await tapCardAt(store, '2809', 'n', (await cardEvent(store, '2809')).id, CARD_ID);
      assert.equal((await stashOf(store, '2809'))!.ttlSeconds, DIGEST_PAGE_TTL_SECONDS, 'a step must not shorten it to an hour');
    });
  });

  it('leaves a search stash at its hour', async () => {
    await withTestStore(async (store) => {
      const query = parseRequest('', { prefs, base: '2026-10-19', from: window.from, to: window.to });
      await store.putPage(pageKey('2808', 7), { header: 'H', title: 'T', query, rest: gigs(2), size: 10 });
      assert.equal((await store.getPage(pageKey('2808', 7)))?.ttlSeconds, SEARCH_PAGE_TTL_SECONDS);
      assert.equal(SEARCH_PAGE_TTL_SECONDS, 3600, 'an answer you asked for a minute ago is still fresh for an hour');
    });
  });

  /** The stash's own ttl is what the row expires on, not just a number in it. */
  it('expires a stash on the life it was written with', async () => {
    await withTestStore(async (store) => {
      const query = parseRequest('', { prefs, base: '2026-10-19', from: window.from, to: window.to });
      await store.putPage(pageKey('2811', 7), { header: 'H', title: 'T', query, rest: gigs(2), size: 10, ttlSeconds: 1 });
      await new Promise((r) => setTimeout(r, 1100));
      assert.equal(await store.getPage(pageKey('2811', 7)), null, 'a one-second stash is stale a second later');
    });
  });

  it('pages the weekend digest too, not just the weekly one', async () => {
    await withTestStore(async (store) => {
      const weekend = { from: '2026-10-23', to: '2026-10-25', label: 'this weekend' };
      const items = gigs(6).map((i) => ({ ...i, startsAt: i.startsAt!.replace('2026-10-20', '2026-10-24') }));
      const key = cacheKey({ city: 'kharkiv', from: weekend.from, to: weekend.to, kinds: ['event'] }, ALL_SOURCE_NAMES, loadConfig().http.max_pages);
      await store.putCache(key, items, 600);
      await registerUser(store, { chatId: '2813', city: 'kharkiv' });
      await store.setSchedule('2813', { hour: 9, days: [WEEKEND_DAY] });
      const calls = await withFakeTelegram(
        () => ({ ok: true }),
        async (calls) => {
          await fanout({
            store, log, optIn: 'weekend_digest', digest: 'weekend', window: weekend,
            now: { hour: 9, weekday: WEEKEND_DAY }, onlyChats: ['2813'], top: 5, title: () => '🎉 На вихідних',
          });
          return calls;
        },
      );
      assert.deepEqual(calls.map((c) => c.method), ['sendMessage', 'sendMessage']);
      assert.equal((await stashOf(store, '2813'))!.rest.length, 4, 'top 5, one on the card, four behind it');
    });
  });

  /**
   * The jobs that are not a digest keep sending as they always did. A follow
   * alert is one event and a place tip is three; neither is a list you page
   * through, and a cursor on them would only add a tap.
   */
  it('leaves follow alerts as plain messages, with no stash behind them', async () => {
    await withTestStore(async (store) => {
      await ready(store, '2814', gigs(3));
      const calls = await withFakeTelegram(
        () => ({ ok: true }),
        async (calls) => {
          await fanout({
            store, log, optIn: 'follow_alerts', window, now: { hour: 12, weekday: 1 },
            onlyChats: ['2814'], title: () => '🔔 Стежу за', footer: REMINDER_HINT,
          });
          return calls;
        },
      );
      assert.deepEqual(calls.map((c) => c.method), ['sendMessage', 'sendMessage', 'sendMessage', 'sendMessage'], 'header plus one message per alert');
      assert.equal(await store.getState(lastPageKey('2814')), null, 'nothing to walk, so no cursor');
      assert.ok(!String(calls[0]!.body['text']).includes(WALK_HINT), 'and no promise of a "Далі →" that is not there');
    });
  });

  it('sends nothing and parks nothing when the week is empty', async () => {
    await withTestStore(async (store) => {
      await ready(store, '2810', gigs(1));
      // the one event there is has already been sent, so there is nothing new
      const key = cacheKey({ city: 'kharkiv', from: window.from, to: window.to, kinds: ['event'] }, ALL_SOURCE_NAMES, loadConfig().http.max_pages);
      await store.recordSent('2810', (await store.getCache(key))!);
      assert.deepEqual(await sendDigest(store, '2810'), [], 'an empty digest is silence, not a header');
      assert.equal(await store.getState(lastPageKey('2810')), null, 'and no stash pointer either');
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

interface FakeCall {
  method: string;
  body: Record<string, unknown>;
}

/** Capture what the bot would say to one message. */
async function say(store: StoreType, chatId: string, text: string, extra: Record<string, unknown> = {}): Promise<string> {
  return captureOutput(() =>
    handleMessage(
      { store, log, dryRun: true },
      TgMessageSchema.parse({
        message_id: Math.floor(Math.random() * 100000),
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: 'private' },
        text,
        ...extra,
      }),
    ),
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
    const key = cacheKey({ city: 'kharkiv', from: base, to: base, kinds: ['event'] }, ALL_SOURCE_NAMES, loadConfig().bot.interactive_pages);
    await store.putCache(key, items, 600);
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
      assert.ok(out.includes('додав ще 1'), out.slice(-400));
      // the padded event came back into the answer, and waits behind the card
      // that went out — one at a time is the shape of an answer now
      assert.ok(out.includes('Відкритий мікрофон'), out.slice(0, 400));
      assert.ok(out.includes('Далі → (1)'), out.slice(0, 800));
    });
  });

  it('declines the count the way Ukrainian does, in every sentence it appears in', () => {
    // the subject form, the object form and the verb that has to agree
    assert.deepEqual([1, 2, 5, 11, 21].map(countEvents), ['1 подія', '2 події', '5 подій', '11 подій', '21 подія']);
    assert.deepEqual([1, 2, 5].map(countEventsAcc), ['1 подію', '2 події', '5 подій']);
    assert.deepEqual([1, 2, 5].map(eventsWaiting), ['1 подія чекає', '2 події чекають', '5 подій чекають']);
  });

  it('never puts the city label straight after a preposition', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3043', city: 'kharkiv' });
      const hello = await say(store, '3043', '/start');
      // "у Харків" is the nominative where the locative belongs; the welcome
      // names the city as a subject instead, which is right for every city
      assert.ok(!/[ву]\s+Харків\b/.test(hello), hello.slice(0, 400));
      assert.ok(hello.includes('Твоє місто — <b>Харків</b>'), hello.slice(0, 400));
    });
  });

  it('sends one card for a fresh answer, and keeps the rest behind "Далі →"', async () => {
    await withTestStore(async (store) => {
      await seedToday(store, [1, 2, 3, 4, 5, 6].map((n) => onToday(`Відкритий мікрофон ${n}`, 'standup', { priceMin: 200 })));
      await withTaste(store, '3042', ['standup']);
      const out = await say(store, '3042', '/today');

      // the header, the "шукаю" placeholder and exactly one event card
      const cards = out.split('──────── to chat 3042').length - 1;
      assert.equal(cards, 3, `one card, not six: ${out.slice(0, 600)}`);
      assert.ok(out.includes('6 подій'), 'the header counts the answer, not the batch');
      assert.ok(out.includes('Далі → (5)'), 'the button says how much is waiting');
      assert.ok(out.includes('Показую по одній'), out.slice(-500));
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
      await handleCallback(
        { store, log, dryRun: true },
        TgCallbackQuerySchema.parse({
          id: 'cb',
          data,
          message: { message_id: 42, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' } },
          from: { id: Number(chatId) },
        }),
      );
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

  it('opens a "коли писати" screen with an hour and the days of the week', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3020', city: 'kharkiv' });
      const panel = await say(store, '3020', '/settings');
      assert.ok(panel.includes('(set:when)'), 'the panel needs a way in');
      assert.ok(panel.includes('понеділок') && panel.includes('09:00'), panel.slice(0, 600));

      const when = await tap(store, '3020', 'set:when');
      assert.ok(when.includes('Коли писати'), when.slice(0, 300));
      for (const hour of DIGEST_HOURS) assert.ok(when.includes(`(when:hour:${hour})`), `hour ${hour}`);
      for (const d of DIGEST_DAYS) assert.ok(when.includes(`(when:day:${d.day})`), `${d.short} is pickable`);
      // the screen is an hour and a set of days, and nothing else
      assert.ok(!when.includes('when:freq'), 'no frequency — ticking days is the frequency');
      assert.ok(when.includes('понеділок') && when.includes('четвер'), 'and it says what is ticked now');
    });
  });

  it('picks an hour and ticks days by button', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3021', city: 'kharkiv' });
      const redraw = await tap(store, '3021', 'when:hour:18');
      assert.equal((await store.getUser('3021'))?.digest_hour, 18);
      assert.ok(redraw.includes('edit 42'), 'the screen is rewritten, not reposted');
      assert.ok(redraw.includes('✅ 18:00'), redraw.slice(0, 600));

      // Saturday arrives on top of the default Monday and Thursday
      await tap(store, '3021', 'when:day:6');
      const sat = (await store.getUser('3021'))!;
      assert.equal(sat.digest_days, (1 << 1) | (1 << 4) | (1 << 6), 'one bit per weekday');
      assert.deepEqual((await getUser(store, '3021'))!.schedule.days, [1, 4, 6]);

      // and tapping it again takes it back off
      await tap(store, '3021', 'when:day:6');
      assert.equal((await store.getUser('3021'))?.digest_days, (1 << 1) | (1 << 4));

      // a legacy column nobody has written since still reads as it always did
      assert.deepEqual((await getUser(store, '3021'))!.schedule, {
        hour: 18, days: [1, 4], frequency: 'twice',
      });
    });
  });

  it('refuses to take the last day off', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3022', city: 'kharkiv' });
      await store.setSchedule('3022', { days: [5] });
      const said = await tap(store, '3022', 'when:day:5');
      assert.deepEqual((await getUser(store, '3022'))!.schedule.days, [5], 'Friday stays');
      assert.ok(said.includes('Залиш хоч один день'), said.slice(-400));
    });
  });

  it('ignores an hour that is not on the menu', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3030', city: 'kharkiv' });
      await tap(store, '3030', 'when:hour:4');
      assert.equal((await store.getUser('3030'))?.digest_hour, 9, 'a hand-crafted callback changes nothing');
      await tap(store, '3030', 'when:day:9');
      assert.deepEqual((await getUser(store, '3030'))!.schedule.days, [1, 4], 'and neither does a bogus weekday');
      await tap(store, '3030', 'when:freq:mine');
      assert.equal((await store.getUser('3030'))?.digest_freq, 'twice', 'the frequency button is gone');
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
    { from = [], to = ['❤️'], chatType = 'private' }: { from?: string[]; to?: string[]; chatType?: string } = {},
  ): Promise<string> {
    return captureOutput(() =>
      handleReaction(
        { store, log, dryRun: true },
        TgReactionUpdateSchema.parse({
          chat: { id: chatId, type: chatType },
          message_id: messageId,
          user: { id: Number(chatId) },
          old_reaction: from.map((emoji) => ({ type: 'emoji', emoji })),
          new_reaction: to.map((emoji) => ({ type: 'emoji', emoji })),
        }),
      ),
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

  /**
   * A group chat is one row in `users`: one member's ❤️ would rewrite the taste
   * of everyone else in it, which is not what "a taste model per person" means.
   */
  it('sets a reminder but learns nothing from a heart in a group chat', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3290', city: 'kharkiv' });
      const before = (await getUser(store, '3290'))!.prefs;
      await store.recordMessage('3290', 779, [gig()]);
      const said = await react(store, '3290', 779, { chatType: 'supergroup' });

      assert.match(said, /нагада/i, 'the heart is still a bookmark for the group');
      assert.equal((await store.listReminders('3290')).length, 1);
      const after = (await getUser(store, '3290'))!.prefs;
      assert.deepEqual(after.taste, before.taste, 'the shared profile is left alone');
      assert.deepEqual(after.favourite_categories, before.favourite_categories);
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

/* ------------------------------------------------------- the card buttons --- */

describe('card buttons', () => {
  /** A tap on a button under the event card we recorded as message 42. */
  async function tapCard(store: StoreType, chatId: string, verb: string, itemId: string, photo = false): Promise<string> {
    return captureOutput(() =>
      handleCallback({ store, log, dryRun: true }, {
        id: 'cb',
        data: `ev:${verb}:${itemId}`,
        message: {
          message_id: 42,
          date: Math.floor(Date.now() / 1000),
          chat: { id: chatId, type: 'private' },
          // a poster card reaches Telegram as a photo: no `text` at all
          ...(photo ? { photo: [{ file_id: 'f', file_unique_id: 'u', width: 1, height: 1 }] } : {}),
        },
        from: { id: Number(chatId) },
      } as never),
    );
  }

  const gig = () =>
    makeItem({ city: 'kharkiv', title: 'Вечір імпровізації', url: 'https://b/1', source: 's', category: 'standup', startsAt: '2026-11-01T19:00:00+02:00' })!;

  it('sets the reminder when ⏰ is tapped, and redraws the card', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3401', city: 'kharkiv' });
      const item = gig();
      await store.recordMessage('3401', 42, [item]);
      const out = await tapCard(store, '3401', 'r', item.id);
      const rows = await store.listReminders('3401');
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.title, 'Вечір імпровізації');
      assert.ok(out.includes('edit 42'), 'the card is rewritten in place');
      assert.ok(out.includes('⏰ Не нагадувати'), out.slice(-600));
    });
  });

  it('redraws a poster card as a caption edit, not a doomed text edit', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3411', city: 'kharkiv' });
      // the bug behind this test: a photo message has no `text`, so
      // editMessageText on it is Bad Request "there is no text in the message
      // to edit" — the ⏰ appeared to do nothing at all
      const item = { ...gig(), image: 'https://img/p.jpg' };
      await store.recordMessage('3411', 42, [item]);
      const out = await tapCard(store, '3411', 'r', item.id, true);
      assert.equal((await store.listReminders('3411')).length, 1, 'the reminder was never the problem');
      assert.ok(out.includes('caption edit 42'), out.slice(-600));
      assert.ok(!out.includes('──── edit 42'), 'a photo must not be sent editMessageText');
      assert.ok(out.includes('⏰ Не нагадувати'), out.slice(-600));
    });
  });

  it('cancels the reminder when ⏰ is tapped again', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3402', city: 'kharkiv' });
      const item = gig();
      await store.recordMessage('3402', 42, [item]);
      await tapCard(store, '3402', 'r', item.id);
      const out = await tapCard(store, '3402', 'r', item.id);
      assert.equal((await store.listReminders('3402')).length, 0);
      assert.ok(out.includes('⏰ Нагадати'), out.slice(-600));
    });
  });

  it('shares one reminder row with the ❤️, never a second', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3403', city: 'kharkiv' });
      const item = gig();
      await store.recordMessage('3403', 42, [item]);
      await captureOutput(() =>
        handleReaction({ store, log, dryRun: true }, {
          chat: { id: '3403', type: 'private' },
          message_id: 42,
          user: { id: 3403 },
          old_reaction: [],
          new_reaction: [{ type: 'emoji', emoji: '❤️' }],
        } as never),
      );
      const hearted = await store.listReminders('3403');
      assert.equal(hearted.length, 1);

      // ⏰ is the same switch: it reads the heart's state and turns it off
      await tapCard(store, '3403', 'r', item.id);
      assert.equal((await store.listReminders('3403')).length, 0);

      // and back on — into the very same row, not a duplicate
      await tapCard(store, '3403', 'r', item.id);
      const again = await store.listReminders('3403');
      assert.equal(again.length, 1);
      assert.equal(again[0]!.id, hearted[0]!.id);
    });
  });

  it('ignores a verb no card carries any more, rather than breaking on it', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3404', city: 'kharkiv' });
      const item = gig();
      await store.recordMessage('3404', 42, [item]);
      // a message already on screen keeps the keyboard it was sent with, so
      // old cards still carry buttons this build never emits
      for (const verb of ['share']) await tapCard(store, '3404', verb, item.id);
      assert.equal((await store.listReminders('3404')).length, 0);
      assert.equal((await store.listSaved('3404')).length, 0);
    });
  });

  it('says what a 👎 taught it, and takes a point off the category', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3406', city: 'kharkiv' });
      const item = { ...gig(), performers: ['Антон Тимошенко'] };
      await store.recordMessage('3406', 42, [item]);
      const out = await tapCard(store, '3406', 'no', item.id);
      const after = (await getUser(store, '3406', log))!;
      assert.equal(after.prefs.taste['standup'], -1);
      assert.ok(!after.prefs.disliked_categories.includes('standup'), 'one 👎 is not a verdict');
      assert.ok(after.prefs.blocked_acts.includes('Антон Тимошенко'), JSON.stringify(after.prefs.blocked_acts));
      assert.ok(out.includes('важить менше'), out.slice(0, 300));
      assert.ok(out.includes('Антон Тимошенко'), out.slice(0, 300));
    });
  });

  it('moves the category into the dislikes once 👎 reaches the threshold', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3407', city: 'kharkiv' });
      const item = gig();
      await store.recordMessage('3407', 42, [item]);
      const start = (await getUser(store, '3407', log))!;
      await saveUserPrefs(store, start, { ...start.prefs, favourite_categories: ['standup'] });
      let out = '';
      for (let i = 0; i < 3; i++) out = await tapCard(store, '3407', 'no', item.id);
      const after = (await getUser(store, '3407', log))!;
      assert.equal(after.prefs.taste['standup'], -3);
      assert.ok(after.prefs.disliked_categories.includes('standup'), JSON.stringify(after.prefs));
      assert.ok(!after.prefs.favourite_categories.includes('standup'), 'and it leaves the favourites');
      assert.ok(out.includes('більше не показуватиму'), out.slice(0, 300));
    });
  });

  it('says it has forgotten a card it can no longer resolve', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3405', city: 'kharkiv' });
      const out = await tapCard(store, '3405', 'r', 'deadbeef');
      assert.ok(out.trim().length > 0, 'a tap always gets an answer');
      assert.equal((await store.listReminders('3405')).length, 0);
    });
  });
});

/* ------------------------------------------------------------- показати ще --- */

describe('показати ще', () => {
  const query = parseRequest('', { prefs, base: '2026-10-20', from: '2026-10-23', to: '2026-10-25' });

  /** Five ranked events nobody has seen yet, in the order rank() put them. */
  const tail = (n: number) =>
    [...Array(n)].map(
      (_, i) =>
        makeItem({
          city: 'kharkiv',
          title: `Подія ${i + 1}`,
          url: `https://m/${i + 1}`,
          source: 's',
          category: 'standup',
          startsAt: `2026-10-23T${10 + i}:00:00+03:00`,
        })!,
    );

  async function tapMore(store: StoreType, chatId: string, text?: string): Promise<string> {
    return captureOutput(() =>
      handleCallback({ store, log, dryRun: true }, {
        id: 'cb',
        data: 'more',
        message: { message_id: 42, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' }, ...(text ? { text } : {}) },
        from: { id: Number(chatId) },
      } as never),
    );
  }

  const seed = async (store: StoreType, chatId: string, n: number, size: number) => {
    await registerUser(store, { chatId, city: 'kharkiv' });
    await store.putPage(`more:${chatId}:42`, { header: '🗓 Харків', title: '🗓 Харків', query, rest: tail(n), size });
  };

  it('offers the button on the header only when something was left over', () => {
    const items = tail(2);
    const withRest = buildMessages({ title: 'T', query, items, format: 'text', more: 7 });
    assert.deepEqual(withRest[0]!.inlineKeyboard, [[{ text: '📋 Показати списком (ще 7)', callback_data: 'more' }]]);
    const whole = buildMessages({ title: 'T', query, items, format: 'text', more: 0 });
    assert.equal(whole[0]!.inlineKeyboard, undefined, 'nothing left over, no button');
  });

  it('hands out the next page, one message per event, and counts the header down', async () => {
    await withTestStore(async (store) => {
      await seed(store, '3501', 5, 2);

      const first = await tapMore(store, '3501');
      assert.ok(first.includes('Подія 1') && first.includes('Подія 2'), first.slice(0, 400));
      assert.ok(!first.includes('Подія 3'), 'one page at a time');
      assert.equal(first.split('──────── to chat 3501').length - 1, 2, 'each event is its own message');
      assert.ok(first.includes('edit 42') && first.includes('📋 Показати списком (ще 3)'), first.slice(0, 600));

      const second = await tapMore(store, '3501');
      assert.ok(second.includes('Подія 3') && second.includes('Подія 4'), second.slice(0, 400));
      assert.ok(!second.includes('Подія 1') && !second.includes('Подія 2'), 'nothing is shown twice');
      assert.ok(second.includes('📋 Показати списком (ще 1)'), second.slice(0, 600));
    });
  });

  it('takes the button away with the last page, and keeps only what ← Назад needs', async () => {
    await withTestStore(async (store) => {
      await seed(store, '3502', 3, 3);
      const out = await tapMore(store, '3502');
      assert.ok(out.includes('Подія 3'), out.slice(0, 400));
      assert.ok(out.includes('edit 42'), 'the header is redrawn');
      assert.ok(!out.includes('Показати списком'), 'the last page leaves no button behind');

      // nothing is left to hand out, but the walk back still has to work; the
      // stash expires on its own within the hour either way
      const page = await store.getPage('more:3502:42');
      assert.deepEqual(page?.rest, [], 'nothing left to show');
      assert.deepEqual(page?.seen.map((i) => i.title), ['Подія 1', 'Подія 2'], 'the walked-past ones stay for ← Назад');
    });
  });

  it('keeps the event buttons on a page that arrived late', async () => {
    await withTestStore(async (store) => {
      await seed(store, '3503', 1, 5);
      const out = await tapMore(store, '3503');
      const id = tail(1)[0]!.id;
      assert.ok(out.includes(`ev:r:${id}`), 'a late arrival carries its own ⏰, so a reminder still works');
    });
  });

  it('does not spend a search from the hourly budget', async () => {
    await withTestStore(async (store) => {
      await seed(store, '3504', 4, 2);
      const before = await store.hitRateLimit('3504', 100);
      await tapMore(store, '3504');
      await tapMore(store, '3504');
      const after = await store.hitRateLimit('3504', 100);
      assert.equal(after.used, before.used + 1, 'paging is not searching; only these two probes count');
    });
  });

  it('drops the button when the stash has expired', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3505', city: 'kharkiv' });
      const out = await tapMore(store, '3505', '🗓 Харків');
      assert.ok(out.includes('edit 42'), 'the stale button goes away');
      assert.ok(!out.includes('Показати ще'), out.slice(0, 400));
      assert.ok(out.includes('застарів'), out.slice(0, 400));
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

  /** A card with a poster, for the two tests that go through `withFakeTelegram`. */
  const withPoster = (n: number) =>
    makeItem({
      city: 'kharkiv',
      title: `Афіша ${n}`,
      url: `https://d/p${n}`,
      source: 'karabas',
      startsAt: `2026-10-2${2 + n}T19:00:00+03:00`,
      image: `https://img/poster-${n}.jpeg`,
    })!;

  it('sends a poster as a photo and still records the id a ❤️ resolves through', async () => {
    await withTestStore(async (store) => {
      const item = withPoster(1);
      const result = await withFakeTelegram(
        () => ({ ok: true }),
        async (calls) => {
          const sent = await deliver({ title: 'T', query, items: [item], log, store, chatId: '7701' });
          assert.deepEqual(calls.map((c) => c.method), ['sendMessage', 'sendPhoto']);
          const photo = calls[1]!.body;
          assert.equal(photo['photo'], 'https://img/poster-1.jpeg');
          assert.ok(String(photo['caption']).includes('Афіша 1'), String(photo['caption']));
          assert.equal(photo['parse_mode'], 'HTML');
          return sent;
        },
      );
      // the photo's own message id must be in `messages`, or the heart has
      // nothing to resolve and no reminder can be set from a poster card
      const photoId = result.messageIds[1]!;
      const remembered = await store.itemsForMessage('7701', photoId);
      assert.deepEqual(remembered.map((i) => i.id), [item.id]);
    });
  });

  it('falls back to text when Telegram will not take the poster, and finishes the digest', async () => {
    await withTestStore(async (store) => {
      const items = [withPoster(1), withPoster(2)];
      const result = await withFakeTelegram(
        (call) =>
          call.method === 'sendPhoto'
            ? { ok: false, description: 'Bad Request: failed to get HTTP URL content' }
            : { ok: true },
        async (calls) => {
          const sent = await deliver({ title: 'T', query, items, log, store, chatId: '7702' });
          // header, then each card tried as a photo and re-sent as text
          assert.deepEqual(calls.map((c) => c.method), [
            'sendMessage', 'sendPhoto', 'sendMessage', 'sendPhoto', 'sendMessage',
          ]);
          return sent;
        },
      );
      assert.equal(result.chatGone, false);
      // one id per message that actually landed: header + both events
      assert.equal(result.messageIds.length, 3);
      for (const [n, item] of items.entries()) {
        const remembered = await store.itemsForMessage('7702', result.messageIds[n + 1]!);
        assert.deepEqual(remembered.map((i) => i.id), [item.id], `event ${n + 1} was not recorded`);
      }
    });
  });

  /**
   * A per-day cap can keep an event out of the messages. It used to be
   * recorded as sent anyway, which was defensible when every event got its own
   * message and the cap only trimmed a long day. It is not defensible now:
   * an event nobody was shown has not been seen, and marking it sent is how it
   * never appears in any future digest.
   */
  it('does not record an event the per-day cap kept out of the messages', async () => {
    await withTestStore(async (store) => {
      // distinct words, not numbers: an item's id hashes its title's *words*
      // and its day, so ten numbered events on one day would share one id
      const items = [
        'Стендап-концерт', 'Джазовий вечір', 'Театральна премʼєра', 'Лекція про космос', 'Вечірка на даху',
        'Виставка кераміки', 'Кінопоказ просто неба', 'Воркшоп з гончарства', 'Фестиваль вуличної їжі', 'Оперна вистава',
      ].map(
        (title, i) =>
          makeItem({ city: 'kharkiv', title, url: `https://cap/${i + 1}`, source: 's', startsAt: `2026-10-23T${String(8 + i).padStart(2, '0')}:00:00+03:00` })!,
      );
      await withFakeTelegram(
        () => ({ ok: true }),
        async () => deliver({ title: 'T', query, items, log, store, chatId: '7704', maxPerDay: 8 }),
      );
      const recorded: string[] = [];
      for (const item of items) if (!(await store.decideSend('7704', item)).send) recorded.push(item.title);
      assert.equal(recorded.length, 8, `only the eight that went out, got: ${recorded.join(', ')}`);
      assert.deepEqual(recorded, items.slice(0, 8).map((i) => i.title), 'and they are the first eight of the day');
    });
  });

  it('treats a blocked chat as a blocked chat, not a bad poster', async () => {
    await withTestStore(async (store) => {
      const result = await withFakeTelegram(
        () => ({ ok: false, status: 403, description: 'Forbidden: bot was blocked by the user' }),
        async () => deliver({ title: 'T', query, items: [withPoster(1)], log, store, chatId: '7703' }),
      );
      assert.equal(result.chatGone, true);
    });
  });
});

/* --------------------------------------------------------------------- cli --- */

describe('flag parsing', () => {
  it('takes a value for every flag that has one', () => {
    // undeclared flags were parsed as switches and their value swept into the
    // free text: `bot.ts --timeout 60` waited 0s and searched for "60"
    const args = parseArgs(['--timeout', '60', '--ttl', '3', '--cancel', '7', 'стендап']);
    assert.equal(args.num('timeout'), 60);
    assert.equal(args.num('ttl'), 3);
    assert.equal(args.get('cancel'), '7');
    assert.equal(args.text(), 'стендап');
  });

  it('still treats a bare switch as a switch', () => {
    const args = parseArgs(['--dry-run', '--city', 'lviv', 'що', 'цікавого']);
    assert.equal(args.has('dry-run'), true);
    assert.equal(args.get('city'), 'lviv');
    assert.equal(args.text(), 'що цікавого');
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

  /**
   * savePrefs once wrote ten of the eleven preference fields and dropped
   * `taste`, so any CLI edit quietly erased the ❤️ tallies the bot had spent
   * weeks learning. The round trip is the whole point of this test.
   */
  it('round-trips preferences through the file, taste tallies included', () => {
    const original = readFileSync(process.env['EVENTS_FINDER_PREFS']!, 'utf8');
    try {
      const p = PreferencesSchema.parse({
        home_city: 'kharkiv',
        favourite_categories: ['standup'],
        follow: ['Latexfauna'],
        taste: { standup: 7, concert: 2 },
        notes: ['сядає біля вікна'],
      });
      savePrefs(p);
      assert.deepEqual(loadPrefs().taste, { standup: 7, concert: 2 }, 'the ❤️ tallies must survive a save');
      assert.deepEqual(loadPrefs().follow, ['Latexfauna']);
      // every field, not just the one that went missing: savePrefs lists its
      // keys by hand, so the twelfth preference would drop just as quietly
      assert.deepEqual(loadPrefs(), p, 'a save must not lose any preference field');
    } finally {
      writeFileSync(process.env['EVENTS_FINDER_PREFS']!, original);
    }
  });
});

/* ------------------------------------------------- the conversation, part 2 --- */

describe('welcome, saved events and the guided search', () => {
  /** Capture what a tap on an inline button produces. */
  async function press(
    store: StoreType,
    chatId: string,
    data: string,
    message: Record<string, unknown> = {},
  ): Promise<string> {
    return captureOutput(() =>
      handleCallback({ store, log, dryRun: true }, {
        id: 'cb',
        data,
        message: { message_id: 42, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' }, ...message },
        from: { id: Number(chatId) },
      } as never),
    );
  }

  const gig = (n = 1) =>
    makeItem({
      city: 'kharkiv',
      title: `Збережена подія ${n}`,
      url: `https://s/${n}`,
      source: 's',
      category: 'standup',
      startsAt: `2026-11-0${n}T19:00:00+02:00`,
      description: 'Камерний стендап у підвалі, двадцять хвилин на кожного.',
      venue: 'Підвал',
    })!;

  it('welcomes a returning user with the four quick actions', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3601', city: 'kharkiv' });
      const hello = await say(store, '3601', '/start');
      for (const data of ['go:weekend', 'go:near', 'go:saved', 'go:find', 'go:settings']) {
        assert.ok(hello.includes(`(${data})`), `${data} is missing from the welcome: ${hello.slice(0, 500)}`);
      }
      assert.ok(hello.includes('Знайдімо'), hello.slice(0, 300));
    });
  });

  it('suggests the closest command instead of just shrugging', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3602', city: 'kharkiv' });
      const typo = await say(store, '3602', '/savd');
      assert.ok(typo.includes('/saved'), typo.slice(0, 300));
      const nonsense = await say(store, '3602', '/qqqqqqq');
      assert.ok(nonsense.includes('Не знаю команди'), nonsense.slice(0, 200));
      assert.ok(!nonsense.includes('Можливо'), 'nothing is close, so nothing is suggested');
    });
  });

  it('saves an event from its card, lists it, and unsaves it on a second tap', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3603', city: 'kharkiv' });
      const item = gig();
      await store.recordMessage('3603', 42, [item]);

      const empty = await say(store, '3603', '/saved');
      assert.ok(empty.includes('Поки порожньо'), empty.slice(0, 300));

      const saved = await press(store, '3603', `ev:s:${item.id}`);
      assert.equal((await store.listSaved('3603')).length, 1);
      assert.ok(saved.includes('edit 42'), 'the card is redrawn, not reposted');
      assert.ok(saved.includes('🔖 Збережено'), saved.slice(0, 400));

      const list = await say(store, '3603', '/saved');
      assert.ok(list.includes('Збережена подія 1'), list.slice(0, 400));
      assert.equal(
        (await store.decideSend('3603', item)).send,
        true,
        'a bookmark must not count as a delivery, or the digest would stop showing it',
      );

      await press(store, '3603', `ev:s:${item.id}`);
      assert.equal((await store.listSaved('3603')).length, 0);
    });
  });

  it('edits a photo card as a caption, never as text', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3604', city: 'kharkiv' });
      const item = { ...gig(2), image: 'https://pics/poster.jpg' };
      await store.recordMessage('3604', 42, [item]);
      const out = await press(store, '3604', `ev:s:${item.id}`, { photo: [{ file_id: 'abc' }] });
      assert.ok(out.includes('caption edit 42'), out.slice(0, 300));
    });
  });

  it('opens the details of an event and comes back to the card', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3605', city: 'kharkiv' });
      const item = gig(3);
      await store.recordMessage('3605', 42, [item]);

      const details = await press(store, '3605', `ev:i:${item.id}`);
      assert.ok(details.includes('Підвал') && details.includes('підвалі'), details.slice(0, 500));
      assert.ok(details.includes('До картки'), 'there has to be a way back');
      assert.ok(details.includes('Квитки') || details.includes('https://s/3'), 'the source link is the point');

      const back = await press(store, '3605', `ev:b:${item.id}`);
      assert.ok(back.includes('Деталі'), back.slice(0, 400));
    });
  });

  it('says so honestly when there is nothing left to walk into', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3606', city: 'kharkiv' });
      const item = gig(4);
      await store.recordMessage('3606', 42, [item]);

      // no stash at all: that answer is gone, and saying "останній" would be
      // claiming to know something about a list we no longer have
      const gone = await press(store, '3606', `ev:n:${item.id}`);
      assert.ok(gone.includes('застарів'), gone.slice(0, 300));

      // a stash that is simply exhausted knows exactly where it stands
      const query = parseRequest('', { prefs, base: '2026-10-20', from: '2026-11-01', to: '2026-11-30' });
      await store.putPage('more:3606:7', { header: '🗓 Харків', title: '🗓 Харків', query, rest: [], seen: [gig(3)], size: 5 });
      await store.setState('lastpage:3606', '7');
      const last = await press(store, '3606', `ev:n:${item.id}`);
      assert.ok(last.includes('останній'), last.slice(0, 300));

      const first = await press(store, '3606', `ev:p:${gig(3).id}`);
      assert.ok(first.includes('Збережена подія 3'), 'back steps into what was walked past');
    });
  });

  it('hands out exactly one more event when "Далі →" has a stash behind it', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3607', city: 'kharkiv' });
      const shown = gig(5);
      const rest = [gig(6), gig(7)];
      await store.recordMessage('3607', 42, [shown]);
      const query = parseRequest('', { prefs, base: '2026-10-20', from: '2026-11-01', to: '2026-11-30' });
      await store.putPage('more:3607:7', { header: '🗓 Харків', title: '🗓 Харків', query, rest, size: 5 });
      await store.setState('lastpage:3607', '7');

      const out = await press(store, '3607', `ev:n:${shown.id}`);
      assert.ok(out.includes('Збережена подія 6'), out.slice(0, 400));
      assert.ok(!out.includes('Збережена подія 7'), 'one at a time — that is what "Далі" means');
    });
  });

  /** Park an answer's tail where the cursor will look for it. */
  const parkPage = async (
    store: StoreType,
    chatId: string,
    page: { rest: Item[]; seen?: Item[] },
  ): Promise<void> => {
    const query = parseRequest('', { prefs, base: '2026-10-20', from: '2026-11-01', to: '2026-11-30' });
    await store.putPage(`more:${chatId}:7`, {
      header: '🗓 Харків', title: '🗓 Харків', query, rest: page.rest, seen: page.seen ?? [], size: 10,
    });
    await store.setState(`lastpage:${chatId}`, '7');
  };

  it('replaces the card in place instead of sending another one', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3610', city: 'kharkiv' });
      const shown = gig(1);
      const next = gig(2);
      await store.recordMessage('3610', 42, [shown]);
      await parkPage(store, '3610', { rest: [next] });

      const out = await press(store, '3610', `ev:n:${shown.id}`);
      assert.ok(out.includes('edit 42'), `the card is rewritten: ${out.slice(0, 400)}`);
      assert.ok(!out.includes('──────── to chat 3610'), 'nothing new is sent into the chat');
      assert.ok(out.includes('Збережена подія 2'), out.slice(0, 400));
      // what the message resolves to has to follow what it shows
      assert.equal((await store.itemsForMessage('3610', 42))[0]?.id, next.id);
      assert.ok(out.includes('← Назад (1)'), 'the way back appears as soon as there is one');
    });
  });

  it('swaps the poster when both cards have one, and never edits across the media line', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3611', city: 'kharkiv' });
      const withPoster = { ...gig(1), image: 'https://pics/a.jpg' };
      const alsoPoster = { ...gig(2), image: 'https://pics/b.jpg' };
      const noPoster = gig(3);
      await store.recordMessage('3611', 42, [withPoster]);
      await parkPage(store, '3611', { rest: [alsoPoster, noPoster] });

      const swap = await press(store, '3611', `ev:n:${withPoster.id}`, { photo: [{ file_id: 'x' }] });
      assert.ok(swap.includes('edit media 42') && swap.includes('https://pics/b.jpg'), swap.slice(0, 400));

      // photo card → event without a poster: Telegram cannot turn a photo
      // message into a text one, so the card is re-sent and taken back
      const cross = await press(store, '3611', `ev:n:${alsoPoster.id}`, { photo: [{ file_id: 'x' }] });
      assert.ok(cross.includes('Збережена подія 3'), cross.slice(0, 400));
      assert.ok(cross.includes('delete 42'), 'the old card goes, so one card is left');
      assert.ok(!cross.includes('edit media 42'), cross.slice(0, 400));
    });
  });

  it('steps back into what was already walked past', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3612', city: 'kharkiv' });
      const current = gig(2);
      const previous = gig(1);
      await store.recordMessage('3612', 42, [current]);
      await parkPage(store, '3612', { rest: [gig(3)], seen: [previous] });

      const back = await press(store, '3612', `ev:p:${current.id}`);
      assert.ok(back.includes('Збережена подія 1'), back.slice(0, 400));
      assert.ok(back.includes('Далі → (2)'), 'the one we stepped off goes back on the pile');
      assert.ok(!back.includes('← Назад'), 'there is nothing behind the first one');
      assert.equal((await store.itemsForMessage('3612', 42))[0]?.id, previous.id);
    });
  });

  it('walks the guided search from categories to a period, and can be cancelled', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3608', city: 'kharkiv' });
      const opened = await say(store, '3608', '/find');
      assert.ok(opened.includes('Що шукаємо'), opened.slice(0, 300));
      assert.ok(opened.includes('(find:cat:standup)'), opened.slice(0, 600));

      const picked = await press(store, '3608', 'find:cat:standup');
      assert.ok(picked.includes('✅ 🎤 стендап'), picked.slice(0, 600));
      assert.deepEqual(JSON.parse((await store.getState('find:3608')) ?? '{}').cats, ['standup']);

      const when = await press(store, '3608', 'find:when');
      assert.ok(when.includes('Коли?') && when.includes('(find:run:weekend)'), when.slice(0, 500));

      const cancelled = await press(store, '3608', 'find:cancel');
      assert.ok(cancelled.includes('скасував'), cancelled.slice(0, 300));
      assert.equal(await store.getState('find:3608'), '');
    });
  });
});

/* ----------------------------------------------- 🔖 and the taste model --- */

describe('the bookmark as a taste signal', () => {
  /** Tap 🔖 under a card; a group chat is a different chat type, nothing more. */
  async function bookmark(store: StoreType, chatId: string, itemId: string, chatType = 'private'): Promise<string> {
    return captureOutput(() =>
      handleCallback({ store, log, dryRun: true }, {
        id: 'cb',
        data: `ev:s:${itemId}`,
        message: { message_id: 42, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: chatType } },
        from: { id: Number(chatId) },
      } as never),
    );
  }

  /** Put a ❤️ on the same message the card went out as. */
  async function heart(store: StoreType, chatId: string): Promise<string> {
    return captureOutput(() =>
      handleReaction(
        { store, log, dryRun: true },
        TgReactionUpdateSchema.parse({
          chat: { id: chatId, type: 'private' },
          message_id: 42,
          user: { id: Number(chatId) },
          old_reaction: [],
          new_reaction: [{ type: 'emoji', emoji: '❤️' }],
        }),
      ),
    );
  }

  const gig = () =>
    makeItem({
      city: 'kharkiv',
      title: 'Стендап у підвалі',
      url: 'https://b/s1',
      source: 's',
      category: 'standup',
      startsAt: '2026-11-01T19:00:00+02:00',
    })!;

  it('raises the category in the taste model and says what it learned', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3701', city: 'kharkiv' });
      const item = gig();
      await store.recordMessage('3701', 42, [item]);

      const out = await bookmark(store, '3701', item.id);
      const user = await getUser(store, '3701');
      assert.equal(user?.prefs.taste['standup'], 1, 'the strongest "I want this" signal has to reach the ranker');
      assert.deepEqual(user?.prefs.favourite_categories, ['standup']);
      assert.ok(out.includes('Запамʼятав'), out.slice(-500));
      assert.ok(out.includes('стендап'), out.slice(-500));
      assert.equal((await store.listSaved('3701')).length, 1, 'and it is still a bookmark');
      assert.equal((await store.listReminders('3701')).length, 0, 'a bookmark is not a reminder');
    });
  });

  it('leaves the taste model alone when the 🔖 comes off', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3702', city: 'kharkiv' });
      const item = gig();
      await store.recordMessage('3702', 42, [item]);

      await bookmark(store, '3702', item.id);
      await bookmark(store, '3702', item.id);
      assert.equal((await store.listSaved('3702')).length, 0, 'the bookmark is gone');
      const user = await getUser(store, '3702');
      assert.equal(user?.prefs.taste['standup'], 1, 'un-bookmarking means "not relevant", not "I dislike this"');
      assert.deepEqual(user?.prefs.favourite_categories, ['standup']);
      assert.deepEqual(user?.prefs.disliked_categories, []);
    });
  });

  it('scores the category once when a ❤️ and a 🔖 land on the same event', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3703', city: 'kharkiv' });
      const item = gig();
      await store.recordMessage('3703', 42, [item]);

      await heart(store, '3703');
      await bookmark(store, '3703', item.id);

      assert.equal((await getUser(store, '3703'))?.prefs.taste['standup'], 1, 'one event, one point');
      assert.equal((await store.listReminders('3703')).length, 1, 'the ❤️ still set the reminder');
      assert.equal((await store.listSaved('3703')).length, 1);
    });
  });

  it('scores it once in the other order too', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '3704', city: 'kharkiv' });
      const item = gig();
      await store.recordMessage('3704', 42, [item]);

      await bookmark(store, '3704', item.id);
      await heart(store, '3704');

      assert.equal((await getUser(store, '3704'))?.prefs.taste['standup'], 1, 'one event, one point');
      assert.equal((await store.listReminders('3704')).length, 1, 'the ❤️ still set the reminder');
    });
  });

  it('bookmarks in a group chat and learns nothing from it', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '-3705', city: 'kharkiv' });
      const item = gig();
      await store.recordMessage('-3705', 42, [item]);

      const out = await bookmark(store, '-3705', item.id, 'supergroup');
      assert.equal((await store.listSaved('-3705')).length, 1, 'a group can still keep a bookmark');
      const user = await getUser(store, '-3705');
      assert.deepEqual(user?.prefs.taste, {}, 'one member must not rewrite the taste of the whole group');
      assert.deepEqual(user?.prefs.favourite_categories, []);
      assert.ok(!out.includes('Запамʼятав'), out.slice(-500));
    });
  });

  it('lifts a tally that 👎 pushed below zero', async () => {
    await withTestStore(async (store) => {
      const { user } = await registerUser(store, { chatId: '3706', city: 'kharkiv' });
      await saveUserPrefs(store, user, { ...user.prefs, taste: { standup: -2 } });
      const item = gig();
      await store.recordMessage('3706', 42, [item]);

      await bookmark(store, '3706', item.id);
      assert.equal((await getUser(store, '3706'))?.prefs.taste['standup'], -1, 'a tally below zero still counts up');
    });
  });
});

/* --------------------------------------------------- a source gone quietly dead --- */

describe('dead source detection', () => {
  /** What one source came back with for one city in one fan-out tick. */
  const saw = (source: string, city: string, items: number) => ({ source, city, items, ok: true });
  /** Midday on the weekend-digest day: a busy hour, not a night nothing is on. */
  const noonThursday = { hour: 12, weekday: WEEKEND_DAY };

  /** recordTick with the owner's inbox replaced by an array we can read. */
  async function tick(
    store: StoreType,
    obs: { source: string; city: string; items: number; ok: boolean; skipped?: boolean }[],
  ): Promise<{ dead: string[]; recovered: string[]; sent: string[] }> {
    const sent: string[] = [];
    const report = await recordTick(store, obs, {
      log,
      notify: async (text: string) => {
        sent.push(text);
      },
    });
    return { ...report, sent };
  }

  it('reads a counter that was never written as a fresh one', async () => {
    await withTestStore(async (store) => {
      const fresh = await readHealth(store, 'never-seen');
      assert.equal(fresh.emptyTicks, 0);
      assert.equal(fresh.alerted, false);
      assert.equal(fresh.lastItemsAt, undefined);
    });
  });

  it('counts a tick where one source came back empty and another did not', async () => {
    await withTestStore(async (store) => {
      await tick(store, [saw('d1-quiet', 'kharkiv', 0), saw('d1-busy', 'kharkiv', 7)]);
      assert.equal((await readHealth(store, 'd1-quiet')).emptyTicks, 1);
      const busy = await readHealth(store, 'd1-busy');
      assert.equal(busy.emptyTicks, 0);
      assert.equal(busy.lastItemsCount, 7);
      assert.ok(busy.lastItemsAt, 'a source that returned items records when');
    });
  });

  it('calls a night when nothing was on anywhere a quiet night, not a dead source', () => {
    const quiet = evaluateTick([saw('a', 'dnipro', 0), saw('b', 'dnipro', 0)]);
    assert.equal(quiet.get('a')?.verdict, 'quiet', 'nobody found anything — that is Dnipro on a Tuesday');
    const broken = evaluateTick([saw('a', 'dnipro', 0), saw('b', 'dnipro', 3)]);
    assert.equal(broken.get('a')?.verdict, 'empty', 'b found events in the same city, so a is the odd one out');
    assert.equal(broken.get('b')?.verdict, 'items');
  });

  it('resets the count the moment the source returns anything', async () => {
    await withTestStore(async (store) => {
      await tick(store, [saw('d2', 'kharkiv', 0), saw('d2-mate', 'kharkiv', 4)]);
      await tick(store, [saw('d2', 'kharkiv', 0), saw('d2-mate', 'kharkiv', 4)]);
      assert.equal((await readHealth(store, 'd2')).emptyTicks, 2);
      await tick(store, [saw('d2', 'kharkiv', 1), saw('d2-mate', 'kharkiv', 4)]);
      assert.equal((await readHealth(store, 'd2')).emptyTicks, 0, 'one item is enough to clear it');
    });
  });

  it('does not call a source dead for one quiet city when it filled another', () => {
    const verdicts = evaluateTick([
      saw('a', 'kharkiv', 0),
      saw('a', 'kyiv', 5),
      saw('b', 'kharkiv', 3),
      saw('b', 'kyiv', 3),
    ]);
    assert.equal(verdicts.get('a')?.verdict, 'items', 'zero in Kharkiv is not dead when Kyiv worked');
  });

  it('leaves out a source that was never asked about the city', () => {
    // a city with no `karabas` section in config.yaml: the collector returns
    // ok with nothing, and that must not look like a broken parser
    const verdicts = evaluateTick([
      { source: 'a', city: 'uzhhorod', items: 0, ok: true, skipped: true },
      saw('b', 'uzhhorod', 6),
    ]);
    assert.equal(verdicts.has('a'), false, 'a source with no config for the city was not asked');
  });

  it('leaves a source that threw alone — a loud failure is already reported', async () => {
    await withTestStore(async (store) => {
      await tick(store, [{ source: 'd3', city: 'kharkiv', items: 0, ok: false }, saw('d3-mate', 'kharkiv', 2)]);
      assert.equal((await readHealth(store, 'd3')).emptyTicks, 0, 'failedSources already covers this one');
    });
  });

  it('messages the owner once on the third tick, and not again on the fourth', async () => {
    await withTestStore(async (store) => {
      assert.equal(DEAD_AFTER_TICKS, 3);
      const sent: string[] = [];
      for (let i = 0; i < DEAD_AFTER_TICKS - 1; i++) {
        const r = await tick(store, [saw('d4', 'kharkiv', 0), saw('d4-mate', 'kharkiv', 9)]);
        sent.push(...r.sent);
      }
      assert.deepEqual(sent, [], 'two empty ticks are not yet an outage');

      const third = await tick(store, [saw('d4', 'kharkiv', 0), saw('d4-mate', 'kharkiv', 9)]);
      assert.deepEqual(third.dead, ['d4']);
      assert.equal(third.sent.length, 1, third.sent.join('\n'));
      assert.ok(third.sent[0]?.includes('d4'), third.sent[0]);
      assert.ok(/3 consecutive/.test(third.sent[0] ?? ''), third.sent[0]);
      assert.ok(third.sent[0]?.includes('kharkiv'), 'it names where the other sources did find things');

      const fourth = await tick(store, [saw('d4', 'kharkiv', 0), saw('d4-mate', 'kharkiv', 9)]);
      assert.deepEqual(fourth.sent, [], 'once per outage, not once an hour');
      assert.deepEqual(fourth.dead, []);
      assert.equal((await readHealth(store, 'd4')).emptyTicks, 4, 'the counter keeps climbing all the same');
    });
  });

  it('says so when a dead source starts returning items again', async () => {
    await withTestStore(async (store) => {
      for (let i = 0; i < DEAD_AFTER_TICKS; i++) {
        await tick(store, [saw('d5', 'kharkiv', 0), saw('d5-mate', 'kharkiv', 9)]);
      }
      assert.equal((await readHealth(store, 'd5')).alerted, true);

      const back = await tick(store, [saw('d5', 'kharkiv', 11), saw('d5-mate', 'kharkiv', 9)]);
      assert.deepEqual(back.recovered, ['d5']);
      assert.equal(back.sent.length, 1, back.sent.join('\n'));
      assert.ok(/again/i.test(back.sent[0] ?? ''), back.sent[0]);
      assert.ok(back.sent[0]?.includes('11'), 'it says how many came back');
      assert.equal((await readHealth(store, 'd5')).alerted, false, 'the outage is over');

      const after = await tick(store, [saw('d5', 'kharkiv', 11), saw('d5-mate', 'kharkiv', 9)]);
      assert.deepEqual(after.sent, [], 'one recovery message, not one per tick');
    });
  });

  it('never sends a recovery message for a source nobody was warned about', async () => {
    await withTestStore(async (store) => {
      const first = await tick(store, [saw('d6', 'kharkiv', 3), saw('d6-mate', 'kharkiv', 1)]);
      assert.deepEqual(first.sent, [], 'a healthy source is not news');
    });
  });

  it('keeps the count across a process restart', async () => {
    await withTestStore(async (store) => {
      await tick(store, [saw('d7', 'kharkiv', 0), saw('d7-mate', 'kharkiv', 5)]);
      await tick(store, [saw('d7', 'kharkiv', 0), saw('d7-mate', 'kharkiv', 5)]);
    });
    // a fresh Store over the same file, as the next cron tick would open it
    await withTestStore(async (store) => {
      assert.equal((await readHealth(store, 'd7')).emptyTicks, 2, 'the counter is in the state table, not in memory');
      const third = await tick(store, [saw('d7', 'kharkiv', 0), saw('d7-mate', 'kharkiv', 5)]);
      assert.deepEqual(third.dead, ['d7'], 'the third tick after a restart still closes the case');
    });
  });

  it('tells the operator websearch needs an ingest, not a repair', async () => {
    await withTestStore(async (store) => {
      let sent: string[] = [];
      for (let i = 0; i < DEAD_AFTER_TICKS; i++) {
        sent = (await tick(store, [saw('websearch', 'kharkiv', 0), saw('karabas', 'kharkiv', 8)])).sent;
      }
      const msg = sent[0] ?? '';
      assert.ok(msg.includes('websearch'), msg);
      assert.ok(/ingest/i.test(msg), `websearch is a hand-off, so the fix is an ingest: ${msg}`);
      assert.ok(!/broken|markup/i.test(msg), `nothing is broken — it is just stale: ${msg}`);
    });
  });

  it('blames the GramJS session when telegram goes quiet', async () => {
    await withTestStore(async (store) => {
      let sent: string[] = [];
      for (let i = 0; i < DEAD_AFTER_TICKS; i++) {
        sent = (await tick(store, [saw('telegram', 'kharkiv', 0), saw('concert.ua', 'kharkiv', 8)])).sent;
      }
      const msg = sent[0] ?? '';
      assert.ok(/session/i.test(msg), `an expired session is a different fix: ${msg}`);
      assert.ok(/tg-login/.test(msg), `point at the script that fixes it: ${msg}`);
    });
  });

  it('shows a line per source, including one that has never returned anything', async () => {
    await withTestStore(async (store) => {
      await tick(store, [saw('d8', 'kharkiv', 12), saw('d8-dead', 'kharkiv', 0)]);
      const rows = await readAllHealth(store, ['d8', 'd8-dead', 'd8-unseen']);
      const lines = describeHealth(rows);
      assert.equal(lines.length, 3);
      assert.ok(lines[0]?.includes('d8') && lines[0]?.includes('12'), lines.join('\n'));
      assert.ok(/never/.test(lines[1] ?? ''), `a source that has never delivered says so: ${lines[1]}`);
      assert.ok(/1 empty tick/.test(lines[1] ?? ''), lines[1]);
      assert.ok(/never/.test(lines[2] ?? ''), `a source with no row at all still gets a line: ${lines[2]}`);
    });
  });

  it('counts real fan-out ticks and tells the owner on the third', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '4100', city: 'kharkiv' });
      // only Karabas serves anything, so the other sources are the odd ones out
      const fetchText = async (url: string) =>
        url.includes('karabas') && !url.includes('page=')
          ? `<html><script type="application/ld+json">${fixture('karabas-event.json')}</script></html>`
          : '<html></html>';
      // a fresh window each tick: the scrape cache is keyed on it, and a cache
      // hit would tell us nothing about the sources
      const windows = [
        { from: '2026-12-07', to: '2026-12-09', label: 'a' },
        { from: '2026-12-08', to: '2026-12-10', label: 'b' },
        { from: '2026-12-06', to: '2026-12-09', label: 'c' },
      ];
      // an earlier case in this block already moved telegram's counter and the
      // suite shares one database file, so watch the delta, not the value
      const telegramBefore = (await readHealth(store, 'telegram')).emptyTicks;
      const ticks = [];
      for (const window of windows) {
        ticks.push(
          await fanout({
            store, log, optIn: 'weekend_digest', window, now: noonThursday, onlyChats: ['4100'],
            dryRun: true, maxPages: 1, fetchText, title: () => 'W',
          }),
        );
      }

      assert.equal((await readHealth(store, 'karabas')).emptyTicks, 0, 'Karabas kept delivering');
      assert.ok((await readHealth(store, 'karabas')).lastItemsAt, 'and when it last did is written down');
      assert.equal((await readHealth(store, 'concert.ua')).emptyTicks, 3);
      assert.equal(
        (await readHealth(store, 'telegram')).emptyTicks,
        telegramBefore,
        'no channels configured for any city — telegram was never asked, so it is not counted',
      );

      assert.deepEqual(ticks[0]?.deadSources, [], 'one empty tick is not an outage');
      assert.ok(ticks[2]?.deadSources.includes('concert.ua'), JSON.stringify(ticks[2]?.deadSources));
      assert.ok(ticks[2]?.deadSources.includes('kontramarka'), JSON.stringify(ticks[2]?.deadSources));
      assert.ok(!ticks[2]?.deadSources.includes('karabas'), 'the one that works is not reported');
      assert.ok(!ticks[2]?.deadSources.includes('telegram'), 'a source with no config is not reported');
    });
  });

  it('stores the counter as something that still parses next release', async () => {
    const parsed = SourceHealthSchema.parse({ source: 'x' });
    assert.equal(parsed.emptyTicks, 0);
    assert.equal(parsed.lastItemsCount, 0);
    assert.equal(parsed.alerted, false);
  });
});

/* ----------------------------------------------- the fixtures still parse --- */

/**
 * These pin our *parsers*, not the live sites: the fixtures are pages captured
 * once and committed. Break a selector or a normalizer and these fail; change
 * the markup on concert.ua and they stay green, which is exactly the hole the
 * dead-source detector above is there to cover.
 */
describe('fixture contracts', () => {
  const wide = parseRequest('', { prefs, base: '2026-10-20', from: '2026-01-01', to: '2027-12-31' });
  const once = (body: string) => {
    const served = new Set<string>();
    return async (url: string) => {
      if (served.has(url)) return '<html></html>';
      served.add(url);
      return body;
    };
  };

  it('pulls a title, a date and a price out of the Concert.ua page', async () => {
    const page = `<html><head><script type="application/ld+json">${fixture('concertua-soldout.json')}</script></head></html>`;
    const res = await collectConcertUa({ query: wide, city: 'kharkiv', log, maxPages: 1, fetchText: once(page) });
    assert.equal(res.ok, true);
    const item = res.items[0];
    assert.ok(item, 'the Concert.ua JSON-LD no longer yields an item');
    assert.equal(item.title, 'Batya 2 Solo Stand-Up');
    assert.equal(item.startsAt, '2026-10-24T19:00:00+03:00');
    assert.equal(item.priceMin, 450);
    assert.equal(priceText(item), 'від 450 ₴');
  });

  it('pulls a title, a date and a price range out of the Karabas page', async () => {
    const page = `<html><head><script type="application/ld+json">${fixture('karabas-event.json')}</script></head></html>`;
    const res = await collectKarabas({ query: wide, city: 'kharkiv', log, maxPages: 1, fetchText: once(page) });
    assert.equal(res.ok, true);
    const item = res.items[0];
    assert.ok(item, 'the Karabas JSON-LD no longer yields an item');
    assert.equal(item.title, 'IVAN LIULENOV');
    assert.equal(item.startsAt, '2026-12-08T21:00:00+02:00');
    assert.equal(item.priceMin, 790);
    assert.equal(item.priceMax, 1590);
    assert.equal(priceText(item), '790–1590 ₴');
  });

  it('pulls a title, a date and a price range out of the Kontramarka card', async () => {
    const res = await collectKontramarka({
      query: wide,
      city: 'kharkiv',
      log,
      maxPages: 1,
      fetchText: once(fixture('kontramarka-card.html')),
    });
    assert.equal(res.ok, true);
    const item = res.items[0];
    assert.ok(item, 'the Kontramarka microdata no longer yields an item');
    assert.equal(item.title, 'Василь Байдак');
    assert.equal(item.startsAt, '2026-10-21T18:30:00+03:00');
    assert.equal(item.priceMin, 390);
    assert.equal(item.priceMax, 890);
    assert.equal(priceText(item), '390–890 ₴');
  });
});

/* ------------------------------------------------------- /stats, for the owner --- */

describe('/stats', () => {
  it('shows when each source last returned items, and how many', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '4200', city: 'kharkiv' });
      await recordTick(
        store,
        [
          { source: 'concert.ua', city: 'kharkiv', items: 18, ok: true },
          { source: 'kontramarka', city: 'kharkiv', items: 0, ok: true },
        ],
        { log, notify: async () => {} },
      );

      const owner = process.env['TELEGRAM_CHAT_ID'];
      process.env['TELEGRAM_CHAT_ID'] = '4200';
      try {
        const out = await say(store, '4200', '/stats');
        assert.ok(out.includes('users:'), out.slice(0, 400));
        assert.ok(/concert\.ua: 18 item\(s\)/.test(out), `no concert.ua line in:\n${out}`);
        assert.ok(/kontramarka: 0 item\(s\), last never/.test(out), `no kontramarka line in:\n${out}`);
        // the exact count depends on what earlier cases did to the shared file;
        // that it is shown at all is what /stats owes the operator
        assert.ok(/empty tick\(s\)/.test(out), `the empty runs are not shown in:\n${out}`);
        for (const source of ALL_SOURCE_NAMES) assert.ok(out.includes(source), `${source} is missing from /stats`);
      } finally {
        if (owner === undefined) delete process.env['TELEGRAM_CHAT_ID'];
        else process.env['TELEGRAM_CHAT_ID'] = owner;
      }
    });
  });

  it('is still only for the owner', async () => {
    await withTestStore(async (store) => {
      await registerUser(store, { chatId: '4201', city: 'kharkiv' });
      const owner = process.env['TELEGRAM_CHAT_ID'];
      process.env['TELEGRAM_CHAT_ID'] = '4200';
      try {
        const out = await say(store, '4201', '/stats');
        assert.ok(out.includes('для власника'), out.slice(0, 300));
        assert.ok(!out.includes('users:'), 'a stranger does not get the numbers');
      } finally {
        if (owner === undefined) delete process.env['TELEGRAM_CHAT_ID'];
        else process.env['TELEGRAM_CHAT_ID'] = owner;
      }
    });
  });
});

/* ----------------------------------------------------------- the operator --- */

describe('the operator', () => {
  /**
   * isOwner() reads TELEGRAM_CHAT_ID, so every case here pins it — including
   * the ones about *not* being the owner, which would otherwise depend on
   * whatever is in the machine's ~/.hermes/.env.
   */
  async function withOwner<T>(chatId: string, body: () => Promise<T>): Promise<T> {
    const real = process.env['TELEGRAM_CHAT_ID'];
    process.env['TELEGRAM_CHAT_ID'] = chatId;
    try {
      return await body();
    } finally {
      if (real === undefined) delete process.env['TELEGRAM_CHAT_ID'];
      else process.env['TELEGRAM_CHAT_ID'] = real;
    }
  }

  /**
   * Every case in this file shares one database, so "every user" means every
   * user the whole suite has ever registered. This narrows the audience to the
   * chats one case is about, and puts the rest back afterwards.
   */
  async function withAudience<T>(store: StoreType, chatIds: string[], body: () => Promise<T>): Promise<T> {
    const others = (await store.listUsers()).map((u) => u.chat_id).filter((id) => !chatIds.includes(id));
    for (const id of others) await store.setBlocked(id, true);
    try {
      return await body();
    } finally {
      for (const id of others) await store.setBlocked(id, false);
    }
  }

  /**
   * The counters are global too, and `bump` takes a negative — which is all a
   * reset needs to be for a case that wants to read an absolute number.
   */
  async function zeroCounters(store: StoreType): Promise<void> {
    for (const [key, n] of Object.entries(await store.counters())) await store.bump(key, -n);
  }

  /** A registered user who has already been offered the one-time setup nudge. */
  async function member(store: StoreType, chatId: string, city = 'kharkiv'): Promise<void> {
    await registerUser(store, { chatId, city });
    await store.setState(`setup_offered:${chatId}`, 'done');
  }

  async function press(store: StoreType, chatId: string, data: string): Promise<string> {
    return captureOutput(() =>
      handleCallback({ store, log, dryRun: true }, {
        id: 'cb',
        data,
        message: { message_id: 42, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' } },
        from: { id: Number(chatId) },
      } as never),
    );
  }

  it('answers /broadcast and /stats the same way to anyone who is not the owner', async () => {
    await withTestStore(async (store) => {
      await withOwner('4001', async () => {
        await member(store, '4002');
        const stats = await say(store, '4002', '/stats');
        const bc = await say(store, '4002', '/broadcast привіт усім');
        assert.ok(stats.includes('для власника бота'), stats.slice(0, 300));
        // word for word the same answer: a different one would tell a stranger
        // which of the two commands exists
        assert.equal(bc.trim(), stats.trim());
        assert.equal(await store.getState('broadcast:4002'), null, 'a stranger cannot even leave a draft');
      });
    });
  });

  it('previews a broadcast and sends nothing until the confirm button is tapped', async () => {
    await withTestStore(async (store) => {
      await withOwner('4101', async () => {
        for (const chatId of ['4101', '4102']) await member(store, chatId);
        await member(store, '4103', 'lviv');
        await withAudience(store, ['4101', '4102', '4103'], async () => {
          const preview = await say(store, '4101', '/broadcast Я тепер умію /find');
          assert.ok(preview.includes('Я тепер умію /find'), 'the preview is the announcement itself');
          assert.ok(preview.includes('Broadcast preview'), preview.slice(0, 400));
          assert.ok(preview.includes('(bc:send)') && preview.includes('(bc:cancel)'), preview.slice(-400));
          assert.ok(!preview.includes('to chat 4102'), 'nothing reaches a user from the preview');
          assert.equal(await store.getState('broadcast:4101'), 'Я тепер умію /find');

          const sent = await press(store, '4101', 'bc:send');
          for (const chatId of ['4101', '4102', '4103']) {
            assert.ok(sent.includes(`to chat ${chatId}`), `${chatId} was skipped\n${sent}`);
          }
          assert.ok(sent.includes('delivered:  3'), sent.slice(-500));
          assert.ok(sent.includes('fell off:   0'), sent.slice(-500));
          assert.equal(await store.getState('broadcast:4101'), '', 'the draft is spent, so a second tap cannot repeat it');

          const again = await press(store, '4101', 'bc:send');
          assert.ok(again.includes('that draft is gone'), again.slice(0, 400));
          assert.ok(!again.includes('to chat 4102'), 'and it really does not send again');
        });
      });
    });
  });

  it('throws a broadcast away when it is cancelled', async () => {
    await withTestStore(async (store) => {
      await withOwner('4111', async () => {
        await member(store, '4111');
        await member(store, '4112');
        await withAudience(store, ['4111', '4112'], async () => {
          await say(store, '4111', '/broadcast щось не те');
          const out = await press(store, '4111', 'bc:cancel');
          assert.ok(out.includes('Broadcast cancelled'), out.slice(0, 400));
          assert.ok(!out.includes('to chat 4112'), out.slice(0, 400));
          assert.equal(await store.getState('broadcast:4111'), '');
        });
      });
    });
  });

  /**
   * The one thing a send to every user has to get right. A chat that has
   * blocked the bot must come out of the audience, or every broadcast and
   * every digest from here on spends a slot on it.
   */
  it('marks a chat that has blocked the bot, and reports how many fell off', async () => {
    await withTestStore(async (store) => {
      await withOwner('4201', async () => {
        for (const chatId of ['4201', '4202', '4203']) await member(store, chatId);
        await withAudience(store, ['4201', '4202', '4203'], async () => {
          await store.setState('broadcast:4201', 'Привіт!');
          const report = await withFakeTelegram(
            (call) =>
              call.body['chat_id'] === '4203'
                ? { ok: false, status: 403, description: 'Forbidden: bot was blocked by the user' }
                : { ok: true },
            async (calls) => {
              await handleCallback({ store, log }, {
                id: 'cb',
                data: 'bc:send',
                message: { message_id: 42, date: 0, chat: { id: '4201', type: 'private' } },
                from: { id: 4201 },
              } as never);
              return String(calls.at(-1)?.body['text'] ?? '');
            },
          );

          assert.equal((await store.getUser('4203'))?.blocked, 1, 'the blocked chat is marked blocked');
          assert.equal((await store.getUser('4202'))?.blocked, 0);
          assert.ok(report.includes('delivered:  2'), report);
          assert.ok(report.includes('fell off:   1'), report);
          assert.ok(report.includes('4203'), 'the report names who fell off');
          assert.ok(!(await store.listUsers()).some((u) => u.chat_id === '4203'), 'and it is out of the audience');
        });
      });
    });
  });

  it('stores feedback, passes it to the owner, and thanks the person', async () => {
    await withTestStore(async (store) => {
      await withOwner('4401', async () => {
        await member(store, '4402');
        const out = await say(store, '4402', '/feedback «Далі →» показує ту саму подію двічі', {
          from: { id: 4402, username: 'olena' },
        });
        assert.ok(out.includes('Дякую'), out.slice(-400));
        assert.ok(out.includes('to chat 4401'), 'the owner hears about it too');
        assert.ok(out.includes('olena'), 'and knows who said it');

        const mine = (await store.listFeedback(500)).filter((r) => r.chat_id === '4402');
        assert.equal(mine.length, 1);
        assert.equal(mine[0]!.username, 'olena');
        assert.equal(mine[0]!.text, '«Далі →» показує ту саму подію двічі');
      });
    });
  });

  it('reads the stored feedback back to the owner on a bare /feedback', async () => {
    await withTestStore(async (store) => {
      await withOwner('4431', async () => {
        await member(store, '4431');
        await member(store, '4432');
        await say(store, '4432', '/feedback у Полтаві нічого не знаходить', { from: { id: 4432, username: 'ihor' } });
        const inbox = await say(store, '4431', '/feedback');
        assert.ok(inbox.includes('Feedback'), inbox.slice(0, 300));
        assert.ok(inbox.includes('у Полтаві нічого не знаходить'), inbox);
        assert.ok(inbox.includes('@ihor'), inbox);
        assert.ok(!inbox.includes('одним повідомленням'), 'the owner gets the inbox, not the usage hint');
      });
    });
  });

  it('asks for the message when /feedback arrives on its own', async () => {
    await withTestStore(async (store) => {
      await member(store, '4411');
      const out = await say(store, '4411', '/feedback');
      assert.ok(out.includes('одним повідомленням'), out.slice(0, 400));
      assert.equal((await store.listFeedback(500)).filter((r) => r.chat_id === '4411').length, 0);
    });
  });

  it('rate-limits feedback in its own hourly bucket, without costing a search', async () => {
    await withTestStore(async (store) => {
      await member(store, '4421');
      const limit = loadConfig().bot.feedback_per_hour;
      for (let i = 0; i < limit; i++) await say(store, '4421', `/feedback думка ${i}`);
      const over = await say(store, '4421', '/feedback ще одна думка');

      assert.ok(over.includes('більше поки не приймаю'), over.slice(0, 400));
      const mine = (await store.listFeedback(500)).filter((r) => r.chat_id === '4421');
      assert.equal(mine.length, limit, 'the one over the line is not stored');
      // the search budget is a different bucket, so writing in never spends one
      assert.equal((await store.hitRateLimit('4421', 100)).used, 1);
    });
  });

  /* ----------------------------------------------------------- the metrics --- */

  /**
   * Distinct *words*, not distinct numbers: an item's id is a hash of its
   * title signature and its day, and a digit is not part of that signature —
   * "Подія 4" and "Подія 5" would be one event in `deliveries`.
   */
  const gig = (title: string, hour = 19) =>
    makeItem({
      city: 'kharkiv',
      title,
      url: `https://m/${encodeURIComponent(title)}`,
      source: 's',
      category: 'standup',
      startsAt: `2026-10-23T${hour}:00:00+03:00`,
    })!;
  const someQuery = parseRequest('', { prefs, base: '2026-10-20', from: '2026-10-23', to: '2026-10-25' });

  it('counts an answer as walked once, however many times it is stepped', async () => {
    await withTestStore(async (store) => {
      await member(store, '4501');
      const items = ['Відкритий мікрофон', 'Імпровізація у підвалі', 'Монологи на даху'].map((t, i) => gig(t, 17 + i));
      await zeroCounters(store);
      await store.recordStash();
      await store.recordStash(); // a second answer nobody ever touched
      await store.putPage(
        'more:4501:40',
        { header: '🗓 Харків', title: '🗓 Харків', query: someQuery, rest: items.slice(1), size: 10, ttlSeconds: 3600 },
      );
      await store.setState('lastpage:4501', '40');
      await store.recordMessage('4501', 42, [items[0]!]);

      await press(store, '4501', `ev:n:${items[0]!.id}`);
      await press(store, '4501', `ev:n:${items[1]!.id}`);

      const m = await store.metrics();
      assert.equal(m.paging.answers, 2, 'both answers had a tail');
      assert.equal(m.paging.paged, 1, 'only one of them was ever walked');
      assert.equal(m.paging.steps, 2);
      assert.equal(m.paging.depth, 2, 'averaged over the answers that were walked, not over all of them');
      assert.equal(m.paging.share, 50);
      assert.equal(m.paging.batches, 0);
      assert.equal((await store.getPage('more:4501:40'))?.paged, true);
    });
  });

  it('counts the header’s list button apart from the card cursor', async () => {
    await withTestStore(async (store) => {
      await member(store, '4511');
      await zeroCounters(store);
      await store.putPage(
        'more:4511:42',
        { header: '🗓 Харків', title: '🗓 Харків', query: someQuery, rest: [gig('Жарти наживо'), gig('Квартет на пероні', 20)], size: 1, ttlSeconds: 3600 },
      );
      await press(store, '4511', 'more');
      const m = await store.metrics();
      assert.equal(m.paging.batches, 1);
      assert.equal(m.paging.steps, 0, 'asking for a list is not walking the cursor');
      assert.equal(m.paging.paged, 0);
    });
  });

  it('counts ❤️, 👎 and 🔖 against the job that sent the card', async () => {
    await withTestStore(async (store) => {
      await member(store, '4601');
      const weekly = gig('Стендап-концерт у середу');
      const mine = gig('Виставка плакатів', 16);
      await zeroCounters(store);
      // one card from the weekly digest, one from an answer they asked for
      await store.recordSent('4601', [weekly], 'weekly');
      await store.recordMessage('4601', 42, [weekly], 'weekly');
      await store.recordSent('4601', [mine], 'search');
      await store.recordMessage('4601', 43, [mine], 'search');

      await press(store, '4601', `ev:s:${weekly.id}`);
      await press(store, '4601', `ev:no:${weekly.id}`);
      await captureOutput(() =>
        handleReaction({ store, log, dryRun: true }, TgReactionUpdateSchema.parse({
          chat: { id: '4601', type: 'private' },
          message_id: 42,
          date: 0,
          old_reaction: [],
          new_reaction: [{ type: 'emoji', emoji: '❤️' }],
        })),
      );

      const m = await store.metrics();
      const job = (name: string) => m.jobs.find((j) => j.job === name);
      assert.deepEqual(job('weekly'), { job: 'weekly', sent: 1, heart: 1, down: 1, save: 1, remind: 0 });
      assert.deepEqual(job('search'), { job: 'search', sent: 1, heart: 0, down: 0, save: 0, remind: 0 });
      assert.deepEqual(job('places'), { job: 'places', sent: 0, heart: 0, down: 0, save: 0, remind: 0 });
      // three gestures, one event: coverage counts events, not taps
      assert.deepEqual(m.coverage, { sent: 2, gestured: 1, share: 50 });
    });
  });

  it('counts how often rank() had to pad a list, overall and per city', async () => {
    await withTestStore(async (store) => {
      const window = { from: '2026-10-23', to: '2026-10-25', label: 'weekend' };
      const classical = makeItem({
        city: 'kharkiv', title: 'Класика при свічках', url: 'https://x/cl2', source: 'karabas',
        category: 'concert', startsAt: '2026-10-24T18:00:00+03:00', status: 'scheduled',
      })!;
      await store.putCache(
        cacheKey({ city: 'kharkiv', from: window.from, to: window.to, kinds: ['event'] }, ALL_SOURCE_NAMES, loadConfig().http.max_pages),
        [classical],
        600,
      );
      await member(store, '4701');
      const user = (await getUser(store, '4701'))!;
      // they like stand-up; the only thing on is a classical concert, so the
      // ranker has to let it back in rather than send an empty digest
      await saveUserPrefs(store, user, { ...user.prefs, favourite_categories: ['standup'], disliked_categories: [] });
      await zeroCounters(store);

      await fanout({
        store, log, optIn: 'weekly_digest', window, dryRun: true,
        title: () => 'W', onlyChats: ['4701'], now: { hour: 12, weekday: 1 },
      });

      const m = await store.metrics();
      assert.equal(m.padding.calls, 1);
      assert.equal(m.padding.padded, 1);
      assert.equal(m.padding.topups, 1);
      assert.equal(m.padding.share, 100);
      assert.deepEqual(m.padding.cities, [{ city: 'kharkiv', calls: 1, padded: 1 }]);
    });
  });

  /**
   * The constraint behind all of this: a tap must cost an increment, not a row.
   * Ten taps on one card leave the table exactly as wide as the first tap did.
   */
  it('keeps the metrics as counters rather than a row per tap', async () => {
    await withTestStore(async (store) => {
      await member(store, '4801');
      const item = gig('Лекція про панельки');
      await store.recordSent('4801', [item], 'weekly');
      await store.recordMessage('4801', 42, [item], 'weekly');

      await press(store, '4801', `ev:s:${item.id}`);
      const afterOne = Object.keys(await store.counters()).length;
      for (let i = 0; i < 10; i++) await press(store, '4801', `ev:s:${item.id}`);

      assert.equal(Object.keys(await store.counters()).length, afterOne, 'ten more taps, not one more row');
      assert.equal((await store.metrics()).coverage.gestured >= 1, true, 'and the event is still counted once');
    });
  });

  it('reports every metric to the owner, in English, under /stats', async () => {
    await withTestStore(async (store) => {
      await withOwner('4901', async () => {
        await member(store, '4901');
        await zeroCounters(store);
        await store.recordStash();
        await store.recordStep(true);
        await store.recordRank(3, 'kharkiv');
        const out = await say(store, '4901', '/stats');
        for (const heading of [
          'Bot stats',
          'Do people page?',
          'Reactions per job',
          'Sent events that got any gesture',
          'How often rank() pads the list',
        ]) {
          assert.ok(out.includes(heading), `${heading} is missing from /stats:\n${out}`);
        }
        assert.ok(out.includes('feedback:'), 'the row counts cover the new table too');
        assert.ok(out.includes('walked at least once:   1 (100%)'), out);
        assert.ok(out.includes('1/1 answers (100%), 3 event(s) added'), out);
        assert.ok(out.includes('kharkiv     1/1'), out);
      });
    });
  });
});

await run();
