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
import { nextWeekRange, parseDateRange, thisWeekRange } from './request.ts';

export interface PrefsEdit {
  changes: string[];
  prefs: Preferences;
  /** The text looked like a preference command. */
  understood: boolean;
  /** Set when understood but nothing changed, e.g. "already in favourites". */
  note?: string;
}

const CITY = String.raw`([A-Za-zА-Яа-яЄєІіЇїҐґ'\- ]{3,30}?)`;

/** Trim filler words a human leaves on a tag: "classical music" -> "classical". */
function cleanTag(raw: string): string {
  let t = raw
    .replace(/[«»"'’.!?,;:]+/g, ' ')
    .replace(/\b(music|музику|музика|музыку|музыка|genre|жанр|events?|подій|події|шоу)\b/gi, ' ')
    .replace(/\b(please|будь ласка|pls)\b/gi, ' ')
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
  if (/^(show|list|які|what are)?\s*(my )?(prefs|preferences|налаштування|уподобання|смаки)\b/i.test(t) && !/add|remove/i.test(t)) {
    return ok([], 'nothing to change');
  }

  /* --- budget ----------------------------------------------------------- */
  if (/\b(no|без)\s*(price\s*)?(limit|ліміт|обмежень|budget)\b|unlimited/i.test(t)) {
    const changed = prefs.max_ticket_price !== null;
    prefs.max_ticket_price = null;
    return ok(changed ? ['max ticket price → no limit'] : [], changed ? undefined : 'already unlimited');
  }
  const budget = t.match(
    /\b(?:max(?:imum)?|budget|limit|ліміт|бюджет|не більше|не дорожче|cheaper than|under|до)\b[^\d]{0,15}(\d{2,5})/i,
  );
  if (budget && /price|грн|uah|₴|budget|бюджет|ціна|цін|квит|ticket|max|limit|ліміт|до|under/i.test(t)) {
    const value = Number(budget[1]);
    const changed = prefs.max_ticket_price !== value;
    prefs.max_ticket_price = value;
    return ok(changed ? [`max ticket price → ${value} ${prefs.currency}`] : [], changed ? undefined : 'already set');
  }

  /* --- trip ------------------------------------------------------------- */
  if (/\b(cancel|скасуй|скасувати)\b.*\b(trip|поїздк)|back home|повернувся додому|i'?m home/i.test(t)) {
    const changed = prefs.trip !== null;
    prefs.trip = null;
    return ok(changed ? ['trip → cleared'] : [], changed ? undefined : 'no trip was set');
  }
  const trip = t.match(new RegExp(String.raw`\b(?:i'?m|i am|я|ill be|i'?ll be|буду|їду|поїду|going)\b\s*(?:in|to|у|в|до)?\s*${CITY}\b`, 'i'));
  if (trip) {
    const city = resolveCity(trip[1] as string);
    if (city) {
      const range = /next week|наступного тижня|наступний тиждень/i.test(t)
        ? nextWeekRange(base)
        : /this week|цього тижня/i.test(t)
          ? thisWeekRange(base)
          : parseDateRange(t, base);
      prefs.trip = { city, from: range.from, to: range.to };
      return ok([`trip → ${cityLabel(city)} ${range.from} → ${range.to} (${range.label})`]);
    }
  }

  /* --- cities ----------------------------------------------------------- */
  const home = t.match(new RegExp(String.raw`\b(?:home city|home|домашнє місто|моє місто)\b\s*(?:is|=|:|—)?\s*${CITY}\b`, 'i'));
  if (home) {
    const city = resolveCity(home[1] as string);
    if (city) {
      const changed = prefs.home_city !== city;
      prefs.home_city = city;
      return ok(changed ? [`home city → ${cityLabel(city)}`] : [], changed ? undefined : 'already your home city');
    }
  }
  const unwatch = t.match(new RegExp(String.raw`\b(?:unwatch|stop watching|не слідкуй за|прибери місто)\s*${CITY}\b`, 'i'));
  if (unwatch) {
    const city = resolveCity(unwatch[1] as string);
    if (city) {
      const changed = drop(prefs.watch_cities, city);
      return ok(changed ? [`watch cities − ${cityLabel(city)}`] : [], changed ? undefined : 'was not watched');
    }
  }
  const watch = t.match(new RegExp(String.raw`\b(?:watch|also watch|слідкуй за|додай місто)\s*${CITY}\b`, 'i'));
  if (watch) {
    const city = resolveCity(watch[1] as string);
    if (city) {
      const changed = add(prefs.watch_cities, city);
      return ok(changed ? [`watch cities + ${cityLabel(city)}`] : [], changed ? undefined : 'already watched');
    }
  }

  /* --- follow list ------------------------------------------------------ */
  const unfollow = t.match(/\b(?:unfollow|stop following|не слідкуй за|розлюби)\s+(.+)$/i);
  if (unfollow) {
    const who = cleanTag(unfollow[1] as string);
    const changed = drop(prefs.follow, who);
    return ok(changed ? [`unfollowed "${who}"`] : [], changed ? undefined : `"${who}" was not on the follow list`);
  }
  const follow = t.match(/\b(?:follow|слідкуй за|стеж за|підпишись на)\s+(.+)$/i);
  if (follow) {
    const who = cleanTag(follow[1] as string);
    const changed = add(prefs.follow, who);
    return ok(changed ? [`following "${who}"`] : [], changed ? undefined : `already following "${who}"`);
  }

  /* --- interests -------------------------------------------------------- */
  const interest = t.match(/\b(?:add|додай)\s+(.+?)\s+(?:to|в|до)\s+(?:interests?|інтересів|цікавого)\b/i);
  if (interest) {
    const tag = asTag(interest[1] as string);
    const changed = add(prefs.interests, tag);
    return ok(changed ? [`interests + ${tag}`] : [], changed ? undefined : 'already an interest');
  }

  /* --- dislikes --------------------------------------------------------- */
  const undislike = t.match(/\b(?:remove|delete|прибери|видали|убери)\s+(.+?)\s+(?:from|з|із)\s+(?:dislikes?|disliked|чорного списку|blacklist)\b/i);
  if (undislike) {
    const tag = asTag(undislike[1] as string);
    const changed = drop(prefs.disliked_categories, tag);
    return ok(changed ? [`dislikes − ${tag}`] : [], changed ? undefined : 'was not disliked');
  }
  const dislike = t.match(/\b(?:i\s+)?(?:don'?t like|do not like|dislike|hate|не люблю|не цікавить|ненавиджу|не хочу)\s+(.+)$/i)
    ?? t.match(/^\s*(?:no|без|ніякого|никакого)\s+(.+)$/i)
    ?? t.match(/\b(?:add)\s+(.+?)\s+(?:to)\s+(?:dislikes?|disliked)\b/i);
  if (dislike) {
    const tag = asTag(dislike[1] as string);
    if (tag) {
      const changed = add(prefs.disliked_categories, tag);
      const alsoDropped = drop(prefs.favourite_categories, tag);
      const changes = [...(changed ? [`dislikes + ${tag}`] : []), ...(alsoDropped ? [`favourites − ${tag}`] : [])];
      return ok(changes, changes.length ? undefined : `already disliked`);
    }
  }

  /* --- favourites ------------------------------------------------------- */
  const unfav = t.match(/\b(?:remove|delete|прибери|видали|убери)\s+(.+?)\s+(?:from|з|із)\s+(?:favourites?|favorites?|улюблених|улюблен\w*)\b/i);
  if (unfav) {
    const tag = asTag(unfav[1] as string);
    const changed = drop(prefs.favourite_categories, tag);
    return ok(changed ? [`favourites − ${tag}`] : [], changed ? undefined : 'was not a favourite');
  }
  const fav =
    t.match(/\b(?:add|додай|додати)\s+(.+?)\s+(?:to|в|до)\s+(?:favourites?|favorites?|улюблен\w*|любимих)\b/i) ??
    t.match(/\b(?:i\s+)?(?:like|love|люблю|подобається|обожнюю)\s+(.+)$/i);
  if (fav) {
    const tag = asTag(fav[1] as string);
    if (tag) {
      const changed = add(prefs.favourite_categories, tag);
      const alsoDropped = drop(prefs.disliked_categories, tag);
      const changes = [...(changed ? [`favourites + ${tag}`] : []), ...(alsoDropped ? [`dislikes − ${tag}`] : [])];
      return ok(changes, changes.length ? undefined : 'already a favourite');
    }
  }

  return { changes: [], prefs: current, understood: false };
}

/** One-screen summary of the current preferences, for the bot and the CLI. */
export function describePrefs(prefs: Preferences): string {
  const lines = [
    `home city: ${cityLabel(prefs.home_city)}`,
    `watch cities: ${prefs.watch_cities.map((c) => cityLabel(c)).join(', ') || '—'}`,
    `favourites: ${prefs.favourite_categories.join(', ') || '—'}`,
    `dislikes: ${prefs.disliked_categories.join(', ') || '—'}`,
    `following: ${prefs.follow.join(', ') || '—'}`,
    `max ticket price: ${prefs.max_ticket_price ? `${prefs.max_ticket_price} ${prefs.currency}` : 'no limit'}`,
    `interests: ${(prefs.interests ?? []).join(', ') || '—'}`,
  ];
  if (prefs.trip) lines.push(`trip: ${cityLabel(prefs.trip.city)} ${prefs.trip.from} → ${prefs.trip.to}`);
  return lines.join('\n');
}
