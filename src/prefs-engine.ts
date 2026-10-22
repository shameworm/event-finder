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
import { canonicalTag } from './categories.ts';
import { normText, today } from './util.ts';
import * as copy from './copy.ts';
import { nextWeekRange, parseDateRange, thisWeekRange } from './request.ts';

export interface PrefsEdit {
  changes: string[];
  prefs: Preferences;
  /** The text looked like a preference command. */
  understood: boolean;
  /** Set when understood but nothing changed, e.g. "already in favourites". */
  note?: string;
}

/**
 * Unicode word boundaries.
 *
 * JavaScript's `\b` is defined against ASCII `\w`, so `/\bне люблю/` can never
 * match — see the note in src/util.ts. Every pattern in this file is therefore
 * built as a string with these lookarounds and compiled with the `u` flag;
 * writing `\b` here would silently kill the Ukrainian phrasings, which is
 * exactly what used to happen.
 */
const B = String.raw`(?<![\p{L}\p{N}])`;
const E = String.raw`(?![\p{L}\p{N}])`;
const re = (body: string, flags = 'iu'): RegExp => new RegExp(body, flags);

const CITY = String.raw`([\p{L}'\- ]{3,30}?)`;

/** Trim filler words a human leaves on a tag: "classical music" -> "classical". */
function cleanTag(raw: string): string {
  let t = raw
    .replace(/[«»"'’.!?,;:]+/gu, ' ')
    .replace(re(`${B}(?:music|музику|музика|музыку|музыка|genre|жанр|events?|подій|події|шоу)${E}`, 'giu'), ' ')
    .replace(re(`${B}(?:please|будь ласка|pls)${E}`, 'giu'), ' ')
    .replace(/\s+/gu, ' ')
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
  const ok = (changes: string[], note?: string): PrefsEdit => ({ changes, prefs, understood: true, note });

  /* --- show ------------------------------------------------------------- */
  if (
    re(`^(?:show|list|які|what are)?\\s*(?:my )?(?:prefs|preferences|налаштування|уподобання|смаки)${E}`).test(t) &&
    !re(`${B}(?:add|remove|додай|прибери)${E}`).test(t)
  ) {
    return ok([], copy.prefsNote.nothing);
  }

  /* --- budget ----------------------------------------------------------- */
  if (re(`${B}(?:no|без)\\s*(?:price\\s*)?(?:limit|ліміт|обмежень|budget)${E}|${B}unlimited${E}`).test(t)) {
    const changed = prefs.max_ticket_price !== null;
    prefs.max_ticket_price = null;
    return ok(changed ? [copy.prefsChange.budgetNone] : [], changed ? undefined : copy.prefsNote.budgetUnlimited);
  }
  const budget = t.match(
    re(
      `${B}(?:max(?:imum)?|максимум|budget|limit|ліміт|лімі́т|бюджет|не більше|не дорожче|дешевше|cheaper than|under|до)${E}` +
        String.raw`[^\d]{0,15}(\d{2,5})`,
    ),
  );
  if (budget && /price|грн|uah|₴|budget|бюджет|ціна|цін|квит|ticket|max|максимум|limit|ліміт|до|under/iu.test(t)) {
    const value = Number(budget[1]);
    const changed = prefs.max_ticket_price !== value;
    prefs.max_ticket_price = value;
    return ok(
      changed ? [copy.prefsChange.budget(value, prefs.currency)] : [],
      changed ? undefined : copy.prefsNote.alreadySet,
    );
  }

  /* --- trip ------------------------------------------------------------- */
  if (
    re(
      `${B}(?:cancel|скасуй|скасувати)${E}.*${B}(?:trip|поїздк)|` +
        `${B}back home${E}|${B}повернувся додому${E}|${B}i'?m home${E}`,
    ).test(t)
  ) {
    const changed = prefs.trip !== null;
    prefs.trip = null;
    return ok(changed ? [copy.prefsChange.tripCleared] : [], changed ? undefined : copy.prefsNote.noTrip);
  }
  const trip = t.match(
    re(`${B}(?:i'?m|i am|я|ill be|i'?ll be|буду|їду|поїду|going)${E}\\s*(?:in|to|у|в|до)?\\s*${CITY}${E}`),
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
      return ok([copy.prefsChange.trip(cityLabel(city), range.from, range.to, range.label)]);
    }
  }

  /* --- cities ----------------------------------------------------------- */
  const home = t.match(
    re(`${B}(?:home city|home|домашнє місто|моє місто|місто)${E}\\s*(?:is|=|:|—)?\\s*${CITY}${E}`),
  );
  if (home) {
    const city = resolveCity(home[1] as string);
    if (city) {
      const changed = prefs.home_city !== city;
      prefs.home_city = city;
      return ok(
        changed ? [copy.prefsChange.homeCity(cityLabel(city))] : [],
        changed ? undefined : copy.prefsNote.alreadyHome,
      );
    }
  }
  const unwatch = t.match(
    re(`${B}(?:unwatch|stop watching|не слідкуй за містом|не слідкуй за|прибери місто)\\s*${CITY}${E}`),
  );
  if (unwatch) {
    const city = resolveCity(unwatch[1] as string);
    if (city) {
      const changed = drop(prefs.watch_cities, city);
      return ok(
        changed ? [copy.prefsChange.watchDrop(cityLabel(city))] : [],
        changed ? undefined : copy.prefsNote.notWatched,
      );
    }
  }
  const watch = t.match(
    re(`${B}(?:watch|also watch|слідкуй за містом|додай місто)\\s*${CITY}${E}`),
  );
  if (watch) {
    const city = resolveCity(watch[1] as string);
    if (city) {
      const changed = add(prefs.watch_cities, city);
      return ok(
        changed ? [copy.prefsChange.watchAdd(cityLabel(city))] : [],
        changed ? undefined : copy.prefsNote.alreadyWatched,
      );
    }
  }

  /* --- follow list ------------------------------------------------------ */
  const unfollow = t.match(re(`${B}(?:unfollow|stop following|не слідкуй за|розлюби)\\s+(.+)$`));
  if (unfollow) {
    const who = cleanTag(unfollow[1] as string);
    const changed = drop(prefs.follow, who);
    return ok(changed ? [copy.prefsChange.followDrop(who)] : [], changed ? undefined : copy.prefsNote.notFollowed(who));
  }
  const follow = t.match(re(`${B}(?:follow|слідкуй за|стеж за|підпишись на)\\s+(.+)$`));
  if (follow) {
    const who = cleanTag(follow[1] as string);
    const changed = add(prefs.follow, who);
    return ok(changed ? [copy.prefsChange.followAdd(who)] : [], changed ? undefined : copy.prefsNote.alreadyFollowed(who));
  }

  /* --- interests -------------------------------------------------------- */
  const interest = t.match(re(`${B}(?:add|додай)\\s+(.+?)\\s+(?:to|в|до)\\s+(?:interests?|інтересів|цікавого)${E}`));
  if (interest) {
    const tag = asTag(interest[1] as string);
    const changed = add(prefs.interests, tag);
    return ok(changed ? [copy.prefsChange.interestAdd(tag)] : [], changed ? undefined : copy.prefsNote.alreadyInterest);
  }

  /* --- dislikes --------------------------------------------------------- */
  const undislike = t.match(
    re(`${B}(?:remove|delete|прибери|видали|убери)\\s+(.+?)\\s+(?:from|з|із)\\s+(?:dislikes?|disliked|чорного списку|blacklist)${E}`),
  );
  if (undislike) {
    const tag = asTag(undislike[1] as string);
    const changed = drop(prefs.disliked_categories, tag);
    return ok(changed ? [copy.prefsChange.dislikeDrop(tag)] : [], changed ? undefined : copy.prefsNote.notDisliked);
  }
  const dislike =
    t.match(
      re(
        `${B}(?:i\\s+)?(?:don'?t like|do not like|dislike|hate|не люблю|не подобається|` +
          `не цікавить|ненавиджу|не хочу|терпіти не можу)\\s+(.+)$`,
      ),
    ) ??
    t.match(re(`^\\s*(?:no|без|ніякого|никакого|жодного)\\s+(.+)$`)) ??
    t.match(re(`${B}add\\s+(.+?)\\s+to\\s+(?:dislikes?|disliked)${E}`));
  if (dislike) {
    const tag = asTag(dislike[1] as string);
    if (tag) {
      const changed = add(prefs.disliked_categories, tag);
      const alsoDropped = drop(prefs.favourite_categories, tag);
      const changes = [
        ...(changed ? [copy.prefsChange.dislikeAdd(tag)] : []),
        ...(alsoDropped ? [copy.prefsChange.favDrop(tag)] : []),
      ];
      return ok(changes, changes.length ? undefined : copy.prefsNote.alreadyDisliked);
    }
  }

  /* --- favourites ------------------------------------------------------- */
  const unfav = t.match(
    re(`${B}(?:remove|delete|прибери|видали|убери)\\s+(.+?)\\s+(?:from|з|із)\\s+(?:favourites?|favorites?|улюблен[\\p{L}]*)${E}`),
  );
  if (unfav) {
    const tag = asTag(unfav[1] as string);
    const changed = drop(prefs.favourite_categories, tag);
    return ok(changed ? [copy.prefsChange.favDrop(tag)] : [], changed ? undefined : copy.prefsNote.notFavourite);
  }
  const fav =
    t.match(
      re(`${B}(?:add|додай|додати)\\s+(.+?)\\s+(?:to|в|до)\\s+(?:favourites?|favorites?|улюблен[\\p{L}]*|любимих)${E}`),
    ) ??
    t.match(re(`${B}(?:i\\s+)?(?:like|love|люблю|подобається|до душі|обожнюю|кайфую від)\\s+(.+)$`));
  if (fav) {
    const tag = asTag(fav[1] as string);
    if (tag) {
      const changed = add(prefs.favourite_categories, tag);
      const alsoDropped = drop(prefs.disliked_categories, tag);
      const changes = [
        ...(changed ? [copy.prefsChange.favAdd(tag)] : []),
        ...(alsoDropped ? [copy.prefsChange.dislikeDrop(tag)] : []),
      ];
      return ok(changes, changes.length ? undefined : copy.prefsNote.alreadyFavourite);
    }
  }

  return { changes: [], prefs: current, understood: false };
}

/**
 * The taste step of onboarding: a bare list of things someone likes.
 *
 * `applyPrefsCommand` needs a verb — "люблю джаз" — but when the bot has just
 * asked "що тобі подобається?", the question supplies the verb and the answer
 * is usually a list: "стендап, джаз, театр". So each part is taken as a
 * favourite, provided it is either a genre/category we recognise or short
 * enough to be a taste word rather than a sentence.
 *
 * The answer *replaces* the favourites rather than adding to them: we asked, so
 * what they said is the whole answer, not an addition to somebody else's.
 */
export function favouritesFromList(text: string, current: Preferences): PrefsEdit {
  const prefs = PreferencesSchema.parse(JSON.parse(JSON.stringify(current)));
  prefs.favourite_categories = [];
  const changes: string[] = [];

  for (const part of text.split(/[,;/\n·•]+|\s+(?:та|і|й|and)\s+/i)) {
    const cleaned = cleanTag(part);
    if (cleaned.length < 2) continue;
    const tag = canonicalTag(cleaned);
    // canonicalTag only rewrites what it knows; an unchanged long phrase is a
    // sentence, not a taste word, and guessing on it would poison the model
    const recognised = normText(tag) !== normText(cleaned);
    if (!recognised && cleaned.split(/\s+/).length > 2) continue;
    if (prefs.disliked_categories.some((d) => normText(d) === normText(tag))) continue;
    if (add(prefs.favourite_categories, tag)) changes.push(copy.prefsChange.favAdd(tag));
  }

  return { changes, prefs, understood: changes.length > 0 };
}

/** One-screen summary of the current preferences, for the bot and the CLI. */
export function describePrefs(prefs: Preferences): string {
  const l = copy.prefsLabel;
  const lines = [
    `${l.homeCity}: ${cityLabel(prefs.home_city)}`,
    `${l.watchCities}: ${prefs.watch_cities.map((c) => cityLabel(c)).join(', ') || '—'}`,
    `${l.favourites}: ${copy.tagList(prefs.favourite_categories)}`,
    `${l.dislikes}: ${copy.tagList(prefs.disliked_categories)}`,
    `${l.following}: ${prefs.follow.join(', ') || '—'}`,
    `${l.maxPrice}: ${prefs.max_ticket_price ? copy.money(prefs.max_ticket_price, prefs.currency) : l.noLimit}`,
    `${l.interests}: ${copy.tagList(prefs.interests ?? [])}`,
  ];
  if (prefs.trip) lines.push(`${l.trip}: ${cityLabel(prefs.trip.city)} ${prefs.trip.from} → ${prefs.trip.to}`);
  return lines.join('\n');
}
