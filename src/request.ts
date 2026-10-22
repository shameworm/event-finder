import type { Kind, Preferences, Query } from './types.ts';
import { EVENT_CATEGORIES, KEYWORDS, PLACE_CATEGORIES, TAG_SYNONYMS } from './categories.ts';
import { loadConfig, resolveCity } from './config.ts';
import { addDays, hasWord, monthFromWord, normText, pad2, today, weekdayOf } from './util.ts';

/* ------------------------------------------------------------- date ranges --- */

export interface DateRange { from: string; to: string; label: string }

/** Friday–Sunday of the current (or upcoming) weekend. */
export function weekendRange(base: string): DateRange {
  const wd = weekdayOf(base); // 0=Sun
  let from: string;
  if (wd === 5 || wd === 6) from = base;           // Fri, Sat -> from today
  else if (wd === 0) return { from: base, to: base, label: 'ці вихідні (неділя)' };
  else from = addDays(base, 5 - wd);               // Mon..Thu -> coming Friday
  const to = addDays(from, weekdayOf(from) === 5 ? 2 : weekdayOf(from) === 6 ? 1 : 0);
  return { from, to, label: 'ці вихідні' };
}

/** Today through Sunday of the current ISO week. */
export function thisWeekRange(base: string): DateRange {
  const wd = weekdayOf(base);
  const to = addDays(base, wd === 0 ? 0 : 7 - wd);
  return { from: base, to, label: 'цей тиждень' };
}

export function nextWeekRange(base: string): DateRange {
  const wd = weekdayOf(base);
  const from = addDays(base, wd === 0 ? 1 : 8 - wd); // next Monday
  return { from, to: addDays(from, 6), label: 'наступний тиждень' };
}

function monthEnd(base: string): string {
  const [y, m] = base.split('-').map(Number);
  const last = new Date(Date.UTC(y ?? 1970, m ?? 1, 0)).getUTCDate();
  return `${y}-${pad2(m ?? 1)}-${pad2(last)}`;
}

/** Weekday words in English, Ukrainian and Russian -> 0=Sunday … 6=Saturday. */
const WEEKDAY_WORDS: [string[], number][] = [
  [['monday', 'понеділок', 'понеділка', 'понедельник', 'пн'], 1],
  [['tuesday', 'вівторок', 'вівторка', 'вторник', 'вт'], 2],
  [['wednesday', 'середу', 'середа', 'среду', 'среда', 'ср'], 3],
  [['thursday', 'четвер', 'четверга', 'четверг', 'чт'], 4],
  [['friday', 'пятницю', 'пятниця', 'пятницу', 'пятница', 'пт'], 5],
  [['saturday', 'суботу', 'субота', 'субботу', 'суббота', 'сб'], 6],
  [['sunday', 'неділю', 'неділя', 'воскресенье', 'нд'], 0],
];

/**
 * Understand the date part of a free-text request.
 * Falls back to "today + 7 days", which is what a bare
 * "what's interesting in Kharkiv" should mean.
 */
export function parseDateRange(text: string, base = today(loadConfig().timezone)): DateRange {
  const t = normText(text);
  // normText drops punctuation, so date patterns are matched on the raw text
  const raw = text.toLowerCase();

  if (hasWord(t, 'today', 'tonight', 'сьогодні', 'сегодня')) return { from: base, to: base, label: 'сьогодні' };
  if (hasWord(t, 'tomorrow', 'завтра')) return { from: addDays(base, 1), to: addDays(base, 1), label: 'завтра' };
  if (hasWord(t, 'післязавтра', 'послезавтра')) return { from: addDays(base, 2), to: addDays(base, 2), label: 'післязавтра' };
  if (/(next weekend|наступні вихідні|наступних вихідних|на наступних вихідних)/.test(t)) {
    const w = weekendRange(addDays(base, 7));
    return { ...w, label: 'наступні вихідні' };
  }
  if (/(weekend|вихідн|выходн)/.test(t)) return weekendRange(base);
  if (/(next week|наступного тижня|на наступному тижні|наступний тиждень|на следующей неделе)/.test(t)) return nextWeekRange(base);
  if (/(this week|цього тижня|на цьому тижні|цей тиждень|на этой неделе)/.test(t)) return thisWeekRange(base);
  if (/(this month|цього місяця|у цьому місяці|в этом месяце)/.test(t)) {
    return { from: base, to: monthEnd(base), label: 'цей місяць' };
  }

  const nDays = t.match(/(?:next|наступні|найближчі|ближайшие|за)\s+(\d{1,2})\s*(?:days|дні|днів|дня|дней)/);
  if (nDays) {
    const n = Number(nDays[1]);
    return { from: base, to: addDays(base, Math.max(1, n) - 1), label: `найближчі ${n} дн.` };
  }

  // 25-27 жовтня / 25–27 october
  const spanWord = raw.match(/(\d{1,2})\s*[–—\-]\s*(\d{1,2})\s+([a-zЀ-ӿ]{3,})/u);
  if (spanWord) {
    const mon = monthFromWord(spanWord[3] as string);
    if (mon) {
      const y = Number(base.slice(0, 4));
      const from = `${y}-${pad2(mon)}-${pad2(Number(spanWord[1]))}`;
      const to = `${y}-${pad2(mon)}-${pad2(Number(spanWord[2]))}`;
      return { from, to, label: `${spanWord[1]}–${spanWord[2]} ${spanWord[3]}` };
    }
  }

  // 25 жовтня / 3 november
  const dayWord = raw.match(/(?<!\d)(\d{1,2})\s+([a-zЀ-ӿ]{3,})/u);
  if (dayWord) {
    const mon = monthFromWord(dayWord[2] as string);
    if (mon) {
      const y = Number(base.slice(0, 4));
      const d = `${y}-${pad2(mon)}-${pad2(Number(dayWord[1]))}`;
      return { from: d, to: d, label: `${dayWord[1]} ${dayWord[2]}` };
    }
  }

  // 25.10 / 25.10.2026 / 2026-10-25, optional range with a dash
  const iso = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  const dotted = text.match(/(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?:\s*[-–]\s*(\d{1,2})[./](\d{1,2}))?/);
  if (iso) {
    const d = `${iso[1]}-${iso[2]}-${iso[3]}`;
    return { from: d, to: d, label: d };
  }
  if (dotted) {
    const y = dotted[3] ? (dotted[3].length === 2 ? `20${dotted[3]}` : dotted[3]) : base.slice(0, 4);
    const from = `${y}-${pad2(Number(dotted[2]))}-${pad2(Number(dotted[1]))}`;
    const to = dotted[4] && dotted[5] ? `${y}-${pad2(Number(dotted[5]))}-${pad2(Number(dotted[4]))}` : from;
    return { from, to, label: from === to ? from : `${from}..${to}` };
  }

  for (const [words, wd] of WEEKDAY_WORDS) {
    if (hasWord(t, ...words)) {
      const cur = weekdayOf(base);
      const delta = (wd - cur + 7) % 7;
      const d = addDays(base, delta === 0 ? 7 : delta);
      return { from: d, to: d, label: `${['наступної неділі', 'наступного понеділка', 'наступного вівторка', 'наступної середи', 'наступного четверга', 'наступної пʼятниці', 'наступної суботи'][wd]}` };
    }
  }

  return { from: base, to: addDays(base, 7), label: 'найближчі 7 днів' };
}

/* -------------------------------------------------------------- taste tags --- */

interface VocabEntry { term: string; canonical: string }

function buildVocab(): VocabEntry[] {
  const v: VocabEntry[] = [];
  for (const cat of [...EVENT_CATEGORIES, ...PLACE_CATEGORIES]) {
    v.push({ term: normText(cat), canonical: cat });
    for (const kw of KEYWORDS[cat]) v.push({ term: normText(kw), canonical: cat });
  }
  for (const [key, syns] of Object.entries(TAG_SYNONYMS)) {
    v.push({ term: normText(key), canonical: key });
    for (const s of syns) v.push({ term: normText(s), canonical: key });
  }
  return v.filter((e) => e.term.length >= 3).sort((a, b) => b.term.length - a.term.length);
}

const VOCAB = buildVocab();

function tagsIn(text: string): string[] {
  const hay = ` ${normText(text)} `;
  const found = new Set<string>();
  for (const { term, canonical } of VOCAB) {
    if (hay.includes(` ${term} `) || (term.length >= 5 && hay.includes(` ${term}`))) found.add(canonical);
  }
  return [...found];
}

const NEGATION = /(?:^|[,;.!]|\s)(?:no|not|without|except|but not|без|окрім|крім|кроме|не хочу|не люблю|не треба|не надо|ніякого|никакого|hate)\s+([^,;.!]{2,60})/gi;

/** Pull disliked phrases out of the text, and return the text with them removed. */
export function splitNegations(text: string): { negated: string[]; rest: string } {
  const negated: string[] = [];
  let rest = text;
  for (const m of text.matchAll(NEGATION)) {
    if (m[1]) negated.push(m[1]);
    rest = rest.replace(m[0], ' ');
  }
  return { negated, rest };
}

/* ------------------------------------------------------------ full request --- */

export interface ParseOptions {
  prefs?: Preferences;
  base?: string;
  /** Explicit overrides (CLI flags win over the free text). */
  city?: string;
  from?: string;
  to?: string;
  like?: string[];
  dislike?: string[];
  maxPrice?: number;
  kinds?: Kind[];
}

/**
 * Turn "what's interesting in Kharkiv this weekend, I like stand-up and indie
 * rock, no classical music" into a Query.
 */
export function parseRequest(text: string, opts: ParseOptions = {}): Query {
  const cfg = loadConfig();
  const base = opts.base ?? today(cfg.timezone);
  const prefs = opts.prefs;

  // --- city
  const cities: string[] = [];
  if (opts.city) {
    for (const c of opts.city.split(',')) {
      const key = resolveCity(c.trim(), cfg);
      if (key) cities.push(key);
    }
  }
  if (cities.length === 0 && text) {
    const words = normText(text).split(' ');
    for (let i = 0; i < words.length; i++) {
      for (const n of [2, 1]) {
        const phrase = words.slice(i, i + n).join(' ');
        if (phrase.length < 3) continue;
        const key = resolveCity(phrase, cfg);
        if (key && !cities.includes(key)) cities.push(key);
      }
    }
  }
  if (cities.length === 0) {
    const trip = prefs?.trip;
    const tripActive = trip && trip.from <= base && base <= trip.to;
    const fallback = tripActive ? trip.city : prefs?.home_city ?? cfg.default_city;
    const key = resolveCity(fallback, cfg) ?? cfg.default_city;
    cities.push(key);
  }

  // --- dates
  const range = opts.from || opts.to
    ? { from: opts.from ?? base, to: opts.to ?? opts.from ?? base, label: 'заданий період' }
    : parseDateRange(text, base);

  // --- taste
  const { negated, rest } = splitNegations(text);
  const dislike = new Set<string>(opts.dislike ?? []);
  for (const phrase of negated) for (const tag of tagsIn(phrase)) dislike.add(tag);
  const like = new Set<string>(opts.like ?? []);
  for (const tag of tagsIn(rest)) if (!dislike.has(tag)) like.add(tag);
  // "other" and date words are not tastes
  like.delete('other');
  dislike.delete('other');

  // --- budget
  let maxPrice = opts.maxPrice;
  if (maxPrice === undefined) {
    const m = normText(text).match(/(?:до|under|max|не більше|не дорожче|cheaper than)\s*(\d{2,5})/);
    if (m) maxPrice = Number(m[1]);
  }

  // --- kinds
  let kinds: Kind[] = opts.kinds ?? ['event'];
  if (!opts.kinds) {
    const wantsPlaces = /\b(place|places|cafe|café|bar|gallery|spot|місц|кафе|бар|галере|локац|заклад)/i.test(normText(text));
    const onlyPlaces = /\b(only places|тільки місця|лише місця)/i.test(normText(text));
    if (onlyPlaces) kinds = ['place'];
    else if (wantsPlaces) kinds = ['event', 'place'];
  }

  return {
    cities,
    from: range.from,
    to: range.to,
    rangeLabel: range.label,
    like: [...like],
    dislike: [...dislike],
    maxPrice,
    text: text || undefined,
    kinds,
  };
}
