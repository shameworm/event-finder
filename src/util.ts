import { createHash } from 'node:crypto';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function sha1(...parts: (string | undefined)[]): string {
  return createHash('sha1').update(parts.map((p) => p ?? '').join('\u0000')).digest('hex').slice(0, 16);
}

/* ------------------------------------------------------------------ text --- */

const NOISE = new Set([
  'концерт', 'концерти', 'сольний', 'сольник', 'виступ', 'шоу', 'show', 'tour', 'тур', 'live',
  'standup', 'stand', 'up', 'стендап', 'стенд', 'ап', 'вечір', 'презентація', 'official',
  'the', 'a', 'and', 'та', 'і', 'в', 'у', 'на', 'з', 'до', 'від', 'нова', 'нове', 'new',
  'програма', 'program', 'квитки', 'tickets', 'прем', 'єра', 'премьера', 'premiere',
]);

/**
 * Lowercase, strip punctuation and Latin diacritics, keep Latin+Cyrillic+digits.
 *
 * Only non-Cyrillic runs get decomposed: NFKD would otherwise split Ukrainian
 * "ї" and "й" into a base letter plus a combining mark, and stripping the mark
 * silently turns "імпровізації" into "імпровізаціі".
 */
export function normText(s: string): string {
  return s
    .normalize('NFC')
    .replace(/[^\u0400-\u04ff]+/gu, (run) => run.normalize('NFKD').replace(/[\u0300-\u036f]/gu, ''))
    .toLowerCase()
    .replace(/[`'’"«»“”(){}\[\]]/g, ' ')
    .replace(/[^0-9a-zЀ-ӿ]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Significant tokens of a title, for dedupe + fuzzy matching. */
export function tokens(title: string): string[] {
  return normText(title)
    .split(' ')
    .filter((t) => t.length > 2 && !NOISE.has(t));
}

/** Short, order-independent signature of a title. */
export function titleKey(title: string): string {
  const t = tokens(title);
  if (t.length === 0) return normText(title).slice(0, 40);
  return [...new Set(t)].sort().slice(0, 4).join('-');
}

export function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Does `haystack` mention `needle` (both normalized, word-boundary-ish)? */
export function mentions(haystack: string, needle: string): boolean {
  const h = ` ${normText(haystack)} `;
  const n = normText(needle);
  if (!n) return false;
  return h.includes(` ${n} `) || h.includes(` ${n}`) || h.includes(`${n} `) || normText(haystack).includes(n);
}

export function truncate(s: string, n: number): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length <= n ? clean : clean.slice(0, n - 1).replace(/[\s,.;:-]+$/, '') + '…';
}

/* ------------------------------------------------------------------ dates --- */

export const DAY_MS = 86_400_000;

function parts(d: Date, tz: string): Record<string, string> {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) out[p.type] = p.value;
  return out;
}

/** YYYY-MM-DD of an instant in a given timezone. */
export function localDate(when: Date | string, tz: string): string {
  const d = typeof when === 'string' ? new Date(when) : when;
  if (Number.isNaN(d.getTime())) return '';
  const p = parts(d, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** HH:MM of an instant in a given timezone. */
export function localTime(when: Date | string, tz: string): string {
  const d = typeof when === 'string' ? new Date(when) : when;
  if (Number.isNaN(d.getTime())) return '';
  const p = parts(d, tz);
  return `${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** 0=Sunday … 6=Saturday, in a given timezone. */
export function localWeekday(when: Date | string, tz: string): number {
  const d = typeof when === 'string' ? new Date(when) : when;
  const i = WEEKDAYS.indexOf(parts(d, tz)['weekday'] ?? '');
  return i < 0 ? 0 : i;
}

export function today(tz: string): string {
  return localDate(new Date(), tz);
}

/** Add days to a YYYY-MM-DD string (timezone-free arithmetic on the calendar date). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/** Weekday of a YYYY-MM-DD calendar date. 0=Sunday. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

const UK_MONTHS = [
  'січ', 'лют', 'бер', 'квіт', 'трав', 'черв', 'лип', 'серп', 'вер', 'жовт', 'лист', 'груд',
];
const UK_MONTHS_RU = [
  'янв', 'февр', 'март', 'апр', 'ма', 'июн', 'июл', 'авг', 'сент', 'октяб', 'нояб', 'декаб',
];
const EN_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Month number (1-12) from a Ukrainian/Russian/English month word, or 0. */
export function monthFromWord(word: string): number {
  const w = normText(word);
  for (const [list, _] of [[UK_MONTHS, 'uk'], [UK_MONTHS_RU, 'ru'], [EN_MONTHS, 'en']] as const) {
    for (let i = 0; i < list.length; i++) {
      const stem = normText(list[i] as string);
      if (stem && w.startsWith(stem)) return i + 1;
    }
  }
  return 0;
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Human day label: "Fri 24 Oct". */
export function dayLabel(date: string, locale = 'en-GB'): string {
  const d = new Date(`${date}T12:00:00Z`);
  return new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(d);
}

/** Offset of a timezone from UTC, in minutes, at a given instant. */
export function tzOffsetMinutes(at: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(at)) p[part.type] = part.value;
  const asUtc = Date.UTC(
    Number(p['year']), Number(p['month']) - 1, Number(p['day']),
    Number(p['hour']) === 24 ? 0 : Number(p['hour']), Number(p['minute']), Number(p['second']),
  );
  return Math.round((asUtc - at.getTime()) / 60000);
}

/**
 * Build an ISO 8601 string with the correct offset for a wall-clock date/time
 * in a timezone — e.g. ('2026-10-25', '19:00', 'Europe/Kyiv') -> 2026-10-25T19:00:00+03:00.
 */
export function isoInZone(date: string, time: string, tz: string): string {
  const [hh = '00', mm = '00'] = time.split(':');
  const naive = Date.parse(`${date}T${pad2(Number(hh))}:${pad2(Number(mm))}:00Z`);
  if (Number.isNaN(naive)) return '';
  // first guess the offset at the naive instant, then correct once
  let offset = tzOffsetMinutes(new Date(naive), tz);
  offset = tzOffsetMinutes(new Date(naive - offset * 60000), tz);
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${date}T${pad2(Number(hh))}:${pad2(Number(mm))}:00${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** Strip emoji and decorative symbols from a line of text. */
export function stripEmoji(s: string): string {
  return s
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{20E3}\u{2B00}-\u{2BFF}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Crude suffix stripper for Ukrainian/Russian inflection, so "імпровізації"
 * matches the keyword "імпровізація" and "виставках" matches "виставка".
 * Both sides of a comparison must be stemmed; see stemText.
 */
export function stem(word: string): string {
  if (word.length < 6) return word;
  return word.replace(/(ами|ями|ових|ового|ому|ого|ему|ыми|ими|ів|ей|ом|ою|ею|ям|ах|ях|ці|ия|ія|ии|ії|и|і|а|я|у|ю|е|ї|й|ы)$/u, '');
}

/** normText + per-word stemming. */
export function stemText(s: string): string {
  return normText(s).split(' ').map(stem).join(' ');
}

/**
 * Word-boundary matching that works in any script.
 *
 * JavaScript's `\b` is defined against ASCII \w, so /\bзавтра\b/ never matches
 * anything — a trap worth keeping out of every caller. These helpers use
 * Unicode lookarounds instead.
 */
export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The two halves of a Unicode word boundary, for building patterns by hand. */
export const WORD_START = String.raw`(?<![\p{L}\p{N}])`;
export const WORD_END = String.raw`(?![\p{L}\p{N}])`;

export function wordRe(word: string, flags = 'iu'): RegExp {
  return new RegExp(`${WORD_START}${escapeRe(word)}${WORD_END}`, flags);
}

/** True when any of `words` appears in `text` as a whole word. */
export function hasWord(text: string, ...words: string[]): boolean {
  return words.some((w) => w.length > 0 && wordRe(w).test(text));
}
