/**
 * Natural-language editing of preferences.yaml, shared by scripts/prefs.ts and
 * the Telegram bot (scripts/bot.ts).
 *
 * Deliberately a short list of explicit intents rather than one clever regex:
 * each rule states what it matches, pulls out its own payload, and stops.
 * `understood` means "this was a preference command"; `changes` means
 * "something actually changed" — a command can be understood and change
 * nothing ("add stand-up to favourites" when it is already there).
 */
import type { Preferences } from './types.ts';
import { PreferencesSchema } from './types.ts';
import { cityLabel, loadConfig, resolveCity } from './config.ts';
import { canonicalTag, tagLabel } from './categories.ts';
import { WORD_END, WORD_START, normText, parseBudget, today } from './util.ts';
import { nextWeekRange, parseDateRange, thisWeekRange } from './request.ts';

export interface PrefsEdit {
  changes: string[];
  prefs: Preferences;
  /** The text looked like a preference command. */
  understood: boolean;
  /** Set when understood but nothing changed, e.g. "already in favourites". */
  note?: string;
}

// `\b` is ASCII-only, so `/\bдодай/` never matches: "д" is not a `\w` character
// and the boundary it needs is never there. Every rule with a Ukrainian
// alternative is built from these instead, with the `u` flag.
const B = WORD_START;
const E = WORD_END;

const CITY = String.raw`([\p{L}' -]{3,30}?)`;

/** Trim filler words a human leaves on a tag: "classical music" -> "classical". */
function cleanTag(raw: string): string {
  let t = raw
    .replace(/[«»"'’.!?,;:]+/g, ' ')
    .replace(new RegExp(String.raw`${B}(music|музик\p{L}*|музык\p{L}*|genre|жанр|events?|поді\p{L}*|шоу)${E}`, 'giu'), ' ')
    .replace(new RegExp(String.raw`${B}(please|будь ласка|pls)${E}`, 'giu'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > 60) t = t.slice(0, 60).trim();
  return t;
}

/** A tag is stored as a genre key, else a category key, else free text. */
function asTag(raw: string): string {
  return canonicalTag(cleanTag(raw));
}

function add(list: string[], value: string): boolean {
  const n = normText(value);
  if (!n || list.some((v) => normText(v) === n)) return false;
  list.push(value);
  return true;
}

function drop(list: string[], value: string): boolean {
  const n = normText(value);
  if (!n) return false;
  const kept = list.filter((v) => normText(v) !== n);
  const changed = kept.length !== list.length;
  list.length = 0;
  list.push(...kept);
  return changed;
}

export function applyPrefsCommand(text: string, current: Preferences): PrefsEdit {
  const cfg = loadConfig();
  const prefs = PreferencesSchema.parse(JSON.parse(JSON.stringify(current)));
  const base = today(cfg.timezone);
  const t = text.trim();
  const low = normText(t);
  const ok = (changes: string[], note?: string): PrefsEdit => ({ changes, prefs, understood: true, note });

  /* --- show ------------------------------------------------------------- */
  if (
    new RegExp(String.raw`^(show|list|які|what are)?\s*(my )?(prefs|preferences|налаштування|уподобання|смаки)${E}`, 'iu').test(t) &&
    !/add|remove|додай|прибери/i.test(t)
  ) {
    return ok([], 'нічого міняти');
  }

  /* --- budget ----------------------------------------------------------- */
  if (new RegExp(String.raw`${B}(no|без)\s*(price\s*)?(limit|ліміт|обмежень|budget)${E}|unlimited`, 'iu').test(t)) {
    const changed = prefs.max_ticket_price !== null;
    prefs.max_ticket_price = null;
    return ok(changed ? ['максимальна ціна квитка → без обмежень'] : [], changed ? undefined : 'і так без обмежень');
  }
  // shared with the search parser: "що буде до 20:00?" is a question about an
  // evening, not a 20 ₴ budget (see parseBudget)
  const value = parseBudget(t);
  if (value !== undefined) {
    const changed = prefs.max_ticket_price !== value;
    prefs.max_ticket_price = value;
    return ok(changed ? [`максимальна ціна квитка → ${value} ${money(prefs.currency)}`] : [], changed ? undefined : 'уже так і стоїть');
  }

  /* --- trip ------------------------------------------------------------- */
  if (
    new RegExp(String.raw`${B}(cancel|скасуй|скасувати)${E}.*${B}(trip|поїздк)|back home|повернувся додому|i'?m home`, 'iu').test(t)
  ) {
    const changed = prefs.trip !== null;
    prefs.trip = null;
    return ok(changed ? ['поїздку скасовано'] : [], changed ? undefined : 'поїздки й не було');
  }
  const trip = t.match(
    new RegExp(String.raw`${B}(?:i'?m|i am|я|ill be|i'?ll be|буду|їду|поїду|going)${E}\s*(?:in|to|у|в|до)?\s*${CITY}${E}`, 'iu'),
  );
  if (trip) {
    const city = resolveCity(trip[1] as string);
    if (city) {
      const range = /next week|наступного тижня|наступний тиждень/i.test(t)
        ? nextWeekRange(base)
        : /this week|цього тижня/i.test(t)
          ? thisWeekRange(base)
          : parseDateRange(t, base);
      prefs.trip = { city, from: range.from, to: range.to };
      return ok([`поїздка → ${cityLabel(city)} ${range.from} → ${range.to} (${range.label})`]);
    }
  }

  /* --- cities ----------------------------------------------------------- */
  const home = t.match(
    new RegExp(String.raw`${B}(?:home city|home|домашнє місто|моє місто)${E}\s*(?:is|=|:|—)?\s*${CITY}${E}`, 'iu'),
  );
  if (home) {
    const city = resolveCity(home[1] as string);
    if (city) {
      const changed = prefs.home_city !== city;
      prefs.home_city = city;
      return ok(changed ? [`домашнє місто → ${cityLabel(city)}`] : [], changed ? undefined : 'це вже твоє домашнє місто');
    }
  }
  // "додай до міст Київ", "додай Київ до міст", "add Kyiv to cities" — the watch
  // list named as a list. People reach for every word order, and the one that
  // was missing fell through to a search for Kyiv instead.
  const CITY_LIST = String.raw`(?:міст\p{L}*|cit(?:y|ies)(?:\s+list)?)`;
  const unwatch =
    t.match(
      new RegExp(String.raw`${B}(?:unwatch|stop watching|не слідкуй за містом|не слідкуй за|прибери місто)\s*${CITY}${E}`, 'iu'),
    ) ??
    t.match(
      new RegExp(String.raw`${B}(?:remove|delete|прибери|видали|убери)\s+(?:(?:from|з|із)\s+)?${CITY_LIST}\s+${CITY}${E}`, 'iu'),
    ) ??
    t.match(
      new RegExp(String.raw`${B}(?:remove|delete|прибери|видали|убери)\s+${CITY}\s+(?:from|з|із)\s+${CITY_LIST}${E}`, 'iu'),
    );
  if (unwatch) {
    const city = resolveCity(unwatch[1] as string);
    if (city) {
      const changed = drop(prefs.watch_cities, city);
      return ok(changed ? [`міста на оці − ${cityLabel(city)}`] : [], changed ? undefined : 'за ним і не стежив');
    }
  }
  const watch =
    t.match(new RegExp(String.raw`${B}(?:watch|also watch|слідкуй за містом|слідкуй за|додай місто)\s*${CITY}${E}`, 'iu')) ??
    t.match(new RegExp(String.raw`${B}(?:add|додай|додати)\s+(?:(?:to|до|в)\s+)?${CITY_LIST}\s+${CITY}${E}`, 'iu')) ??
    t.match(new RegExp(String.raw`${B}(?:add|додай|додати)\s+${CITY}\s+(?:to|до|в)\s+${CITY_LIST}${E}`, 'iu'));
  if (watch) {
    const city = resolveCity(watch[1] as string);
    if (city) {
      const changed = add(prefs.watch_cities, city);
      return ok(changed ? [`міста на оці + ${cityLabel(city)}`] : [], changed ? undefined : 'уже стежу за ним');
    }
  }

  /* --- follow list ------------------------------------------------------ */
  const unfollow = t.match(new RegExp(String.raw`${B}(?:unfollow|stop following|не слідкуй за|не стеж за|розлюби)\s+(.+)$`, 'iu'));
  if (unfollow) {
    const who = cleanTag(unfollow[1] as string);
    const changed = drop(prefs.follow, who);
    return ok(changed ? [`більше не стежу за «${who}»`] : [], changed ? undefined : `за «${who}» я і не стежив`);
  }
  const follow = t.match(new RegExp(String.raw`${B}(?:follow|слідкуй за|стеж за|підпишись на)\s+(.+)$`, 'iu'));
  if (follow) {
    const who = cleanTag(follow[1] as string);
    const changed = add(prefs.follow, who);
    return ok(changed ? [`стежу за «${who}»`] : [], changed ? undefined : `за «${who}» уже стежу`);
  }

  /* --- interests -------------------------------------------------------- */
  const interest = t.match(
    new RegExp(String.raw`${B}(?:add|додай|додати)\s+(.+?)\s+(?:to|в|до)\s+(?:interests?|інтерес\p{L}*|цікавого)${E}`, 'iu'),
  );
  if (interest) {
    const tag = asTag(interest[1] as string);
    const changed = add(prefs.interests, tag);
    return ok(changed ? [`інтереси + ${tagLabel(tag)}`] : [], changed ? undefined : 'це вже в інтересах');
  }

  /* --- dislikes --------------------------------------------------------- */
  const undislike = t.match(
    new RegExp(
      String.raw`${B}(?:remove|delete|прибери|видали|убери)\s+(.+?)\s+(?:from|з|із)\s+(?:dislikes?|disliked|небажаного|чорного списку|blacklist)${E}`,
      'iu',
    ),
  );
  if (undislike) {
    const tag = asTag(undislike[1] as string);
    const changed = drop(prefs.disliked_categories, tag);
    return ok(changed ? [`небажане − ${tagLabel(tag)}`] : [], changed ? undefined : 'цього й не було в небажаному');
  }
  const dislike =
    t.match(
      new RegExp(String.raw`${B}(?:i\s+)?(?:don'?t like|do not like|dislike|hate|не люблю|не цікавить|ненавиджу|не хочу)\s+(.+)$`, 'iu'),
    ) ??
    t.match(/^\s*(?:no|без|ніякого|никакого)\s+(.+)$/iu) ??
    t.match(new RegExp(String.raw`${B}(?:add|додай)\s+(.+?)\s+(?:to|до)\s+(?:dislikes?|disliked|небажаного)${E}`, 'iu'));
  if (dislike) {
    const tag = asTag(dislike[1] as string);
    if (tag) {
      const changed = add(prefs.disliked_categories, tag);
      const alsoDropped = drop(prefs.favourite_categories, tag);
      const changes = [...(changed ? [`небажане + ${tagLabel(tag)}`] : []), ...(alsoDropped ? [`улюблене − ${tagLabel(tag)}`] : [])];
      return ok(changes, changes.length ? undefined : 'це вже в небажаному');
    }
  }

  /* --- favourites ------------------------------------------------------- */
  const unfav = t.match(
    new RegExp(String.raw`${B}(?:remove|delete|прибери|видали|убери)\s+(.+?)\s+(?:from|з|із)\s+(?:favourites?|favorites?|улюблен\p{L}*)${E}`, 'iu'),
  );
  if (unfav) {
    const tag = asTag(unfav[1] as string);
    const changed = drop(prefs.favourite_categories, tag);
    return ok(changed ? [`улюблене − ${tagLabel(tag)}`] : [], changed ? undefined : 'цього й не було в улюбленому');
  }
  const fav =
    t.match(
      new RegExp(String.raw`${B}(?:add|додай|додати)\s+(.+?)\s+(?:to|в|до)\s+(?:favourites?|favorites?|улюблен\p{L}*|любим\p{L}*)${E}`, 'iu'),
    ) ?? t.match(new RegExp(String.raw`${B}(?:i\s+)?(?:like|love|люблю|подобається|обожнюю)\s+(.+)$`, 'iu'));
  if (fav) {
    const tag = asTag(fav[1] as string);
    if (tag) {
      const changed = add(prefs.favourite_categories, tag);
      const alsoDropped = drop(prefs.disliked_categories, tag);
      const changes = [...(changed ? [`улюблене + ${tagLabel(tag)}`] : []), ...(alsoDropped ? [`небажане − ${tagLabel(tag)}`] : [])];
      return ok(changes, changes.length ? undefined : 'це вже в улюбленому');
    }
  }

  return { changes: [], prefs: current, understood: false };
}

/** The hryvnia has a sign; everything else is shown as its code. */
const money = (currency: string): string => (currency === 'UAH' ? '₴' : currency);

/** One-screen summary of the current preferences, for the bot and the CLI. */
export function describePrefs(prefs: Preferences): string {
  const lines = [
    `домашнє місто: ${cityLabel(prefs.home_city)}`,
    `міста на оці: ${prefs.watch_cities.map((c) => cityLabel(c)).join(', ') || '—'}`,
    `улюблене: ${prefs.favourite_categories.map(tagLabel).join(', ') || '—'}`,
    `небажане: ${prefs.disliked_categories.map(tagLabel).join(', ') || '—'}`,
    `стежу за: ${prefs.follow.join(', ') || '—'}`,
    `максимум за квиток: ${prefs.max_ticket_price ? `${prefs.max_ticket_price} ${money(prefs.currency)}` : 'без обмежень'}`,
    `інтереси: ${(prefs.interests ?? []).map(tagLabel).join(', ') || '—'}`,
  ];
  if (prefs.trip) lines.push(`поїздка: ${cityLabel(prefs.trip.city)} ${prefs.trip.from} → ${prefs.trip.to}`);
  return lines.join('\n');
}

/**
 * A bare list of tastes, as typed at the walkthrough's "Що тобі заходить?".
 *
 * applyPrefsCommand needs a verb — "люблю джаз" — but a person who was just
 * asked what they like answers with a bare list: "стендап, джаз, театр". The
 * question supplied the verb, so each part is taken as a favourite provided it
 * is either a genre we recognise or short enough to be a taste word rather
 * than a sentence.
 *
 * The edit it returns *replaces* the favourites rather than adding to them: we
 * asked, so what they said is the whole answer, not an addition to somebody
 * else's. The likes screen then merges that over whatever is already ticked,
 * because there the taps are answers too.
 */
export function favouritesFromList(text: string, current: Preferences): PrefsEdit {
  const prefs = PreferencesSchema.parse(JSON.parse(JSON.stringify(current)));
  prefs.favourite_categories = [];
  const changes: string[] = [];

  for (const part of text.split(/[,;/\n·•]+|\s+(?:та|і|й|and)\s+/iu)) {
    const cleaned = cleanTag(part);
    if (cleaned.length < 2) continue;
    const tag = canonicalTag(cleaned);
    // canonicalTag only rewrites what it knows; an unchanged long phrase is a
    // sentence, not a taste word, and guessing on it would poison the model
    const recognised = normText(tag) !== normText(cleaned);
    if (!recognised && cleaned.split(/\s+/).length > 2) continue;
    if (prefs.disliked_categories.some((d) => normText(d) === normText(tag))) continue;
    if (add(prefs.favourite_categories, tag)) changes.push(`улюблене + ${tagLabel(tag)}`);
  }

  return { changes, prefs, understood: changes.length > 0 };
}
