import type { Item, Query } from './types.ts';
import { EMOJI, classify } from './categories.ts';
import { cityLabel, loadConfig } from './config.ts';
import { priceText } from './normalize.ts';
import { dayLabel, localDate, localTime, truncate } from './util.ts';
import { groupByDay } from './rank.ts';
import { CAPTION_LIMIT, escapeHtml, type InlineButton } from './telegram-api.ts';

export { CAPTION_LIMIT };

export type Format = 'html' | 'text';

/** Ukrainian needs three forms: 1 подія, 2 події, 5 подій. */
function plural(n: number, [one, few, many]: [string, string, string]): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

export const countEvents = (n: number): string => `${n} ${plural(n, ['подія', 'події', 'подій'])}`;
export const countPlaces = (n: number): string => `${n} ${plural(n, ['місце', 'місця', 'місць'])}`;

export const countReminders = (n: number): string => `${n} ${plural(n, ['нагадування', 'нагадування', 'нагадувань'])}`;

export const REMINDER_HINT = 'Тисни ⏰ під подією або ❤️ на ній — нагадаю за день і за 3 години до початку.';
export const NO_REMINDERS = 'Нагадувань поки немає. Тисни ⏰ під подією або ❤️ на ній — і я поставлю.';
export const CANCEL_HINT = 'Тисни ⏰ під подією ще раз або знімеш ❤️ — скасую нагадування.';
export const PLACES_HINT = 'Скажи, як тобі — і я підлаштую підказки.';
export const NOTHING_FOUND = 'Цього разу нічого не знайшлося. Спробуй ширший період або інше місто.';

const STATUS_BADGE: Record<string, string> = {
  soldout: ' — 🚫 КВИТКІВ НЕМАЄ',
  cancelled: ' — ❌ СКАСОВАНО',
  postponed: ' — ⏳ ПЕРЕНЕСЕНО',
  limited: ' — ⚠️ лишилось мало квитків',
};

/**
 * `changeNote` arrives as the freshness checker's own reason — an English key
 * from src/fresh.ts, not something a person should read.
 */
const CHANGE_NOTE: Record<string, string> = {
  'new date': 'нова дата',
  'sold out': 'квитки скінчилися',
  'few tickets left': 'мало квитків',
  cancelled: 'скасовано',
  'price changed': 'змінилася ціна',
};

function link(label: string, url: string, format: Format): string {
  if (format === 'text') return `${label} ${url}`;
  return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

function bold(s: string, format: Format): string {
  return format === 'text' ? s : `<b>${escapeHtml(s)}</b>`;
}

function plain(s: string, format: Format): string {
  return format === 'text' ? s : escapeHtml(s);
}

export interface RenderItemOptions {
  format?: Format;
  tz?: string;
  index?: number;
  /** Show why it was ranked where it was. */
  explain?: boolean;
  /** Show the day as well as the time (for ungrouped lists). */
  withDay?: boolean;
  /** Reason this item is being (re)sent, e.g. "new date". */
  changeNote?: string;
  /**
   * Caption mode: drop the description and the ranking line. A photo's caption
   * gets 1024 characters where a message gets 4096, and the poster above it is
   * already doing the work a blurb would.
   */
  compact?: boolean;
}

/** One event/place line: emoji, title, venue, time, price, description, link. */
export function renderItem(item: Item, opts: RenderItemOptions = {}): string {
  const cfg = loadConfig();
  const format = opts.format ?? 'html';
  const tz = opts.tz ?? cfg.timezone;
  const emoji = EMOJI[item.category] ?? '✨';
  const num = opts.index !== undefined ? `${opts.index}. ` : '';

  // Telegram posts often give a date but no time; 00:00 means "unknown", not midnight
  const timeKnown = item.startsAt ? !(item.confidence === 'low' && localTime(item.startsAt, tz) === '00:00') : false;
  const when = item.startsAt
    ? `${opts.withDay ? dayLabel(item.startsAt.slice(0, 10), cfg.locale) + ' ' : ''}${timeKnown ? localTime(item.startsAt, tz) : 'час уточнюється'}`
    : 'дата уточнюється';

  const facts = (item.kind === 'place'
    ? [item.address, item.venue]
    : [when, item.venue, priceText(item)])
    .filter((x): x is string => Boolean(x && x.trim()))
    .map((x) => plain(x, format))
    .join(' · ');

  const note = opts.changeNote ? CHANGE_NOTE[opts.changeNote] ?? opts.changeNote : undefined;
  const lines = [
    `${num}${emoji} ${bold(item.title, format)}${STATUS_BADGE[item.status] ?? ''}${note ? ` — 🔁 ${note}` : ''}`,
    facts,
  ];
  if (item.description && !opts.compact) lines.push(plain(truncate(item.description, 140), format));
  // "квитки" is a promise; a free event or one with no price has none to make
  const buyable = item.kind === 'event' && !item.free && (item.priceMin !== undefined || item.priceMax !== undefined);
  lines.push(link(buyable ? 'квитки →' : 'детальніше →', item.url, format));
  if (opts.explain && !opts.compact && item.reasons?.length) {
    lines.push(plain(`· ${item.reasons.slice(0, 4).join(', ')} (бали ${item.score})`, format));
  }
  return lines.filter(Boolean).join('\n');
}

/**
 * The same card, as a caption that fits under its poster — or null when it
 * cannot be made to fit, in which case the card goes out as a plain message.
 *
 * It tries the full card first, since most of them already fit; then compact,
 * without the description; and only then shortens the item's own fields. The
 * last part matters: HTML escaping can multiply a hostile title sixfold
 * ("&" -> "&amp;"), and clamping *rendered* HTML would cut a tag in half and
 * make Telegram reject the whole message.
 */
export function renderCaption(item: Item, opts: RenderItemOptions = {}): string | null {
  for (const compact of [false, true]) {
    const text = renderItem(item, { ...opts, compact });
    if (text.length <= CAPTION_LIMIT) return text;
  }
  for (const len of [120, 60, 30, 12]) {
    const text = renderItem(
      {
        ...item,
        title: truncate(item.title, len),
        venue: item.venue ? truncate(item.venue, len) : undefined,
        address: item.address ? truncate(item.address, len) : undefined,
        description: undefined,
      },
      { ...opts, compact: true },
    );
    if (text.length <= CAPTION_LIMIT) return text;
  }
  // an absurdly long url is the only way to get here, and it is worth more
  // than the poster: let the caller send a message instead
  return null;
}

/** What `renderReminders` needs of a reminder row, and nothing more. */
export interface ReminderLine {
  title: string;
  starts_at: string;
  venue?: string | null;
  url?: string | null;
}

/**
 * The reminder list: day-grouped like a digest, because that is the shape
 * people already read in this chat.
 *
 * Reminders are stored without a category — the table predates one and there
 * are no migrations — so the emoji is classified from the title. A wrong guess
 * costs one wrong pictogram, and ✨ covers whatever does not classify.
 *
 * Anything that has already started is left out: the reminder has done its job,
 * and `listReminders` keeps rows until they are cancelled.
 */
export function renderReminders(
  rows: ReminderLine[],
  opts: { format?: Format; tz?: string; now?: Date } = {},
): string {
  const cfg = loadConfig();
  const format = opts.format ?? 'html';
  const tz = opts.tz ?? cfg.timezone;
  const cutoff = (opts.now ?? new Date()).getTime();

  const upcoming = rows
    .filter((r) => Date.parse(r.starts_at) >= cutoff)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  if (upcoming.length === 0) return plain(NO_REMINDERS, format);

  const byDay = new Map<string, ReminderLine[]>();
  for (const r of upcoming) {
    const day = localDate(r.starts_at, tz);
    byDay.set(day, [...(byDay.get(day) ?? []), r]);
  }

  const blocks = [`${bold('⏰ Твої нагадування', format)}\n${plain(countReminders(upcoming.length), format)}`];
  for (const [day, list] of byDay) {
    const lines = list.map((r) => {
      const emoji = EMOJI[classify(r.title) ?? 'other'];
      const facts = [localTime(r.starts_at, tz), r.venue].filter((x): x is string => Boolean(x?.trim()));
      return [
        `${emoji} ${bold(r.title, format)}`,
        plain(facts.join(' · '), format),
        r.url ? link('детальніше →', r.url, format) : '',
      ]
        .filter(Boolean)
        .join('\n');
    });
    blocks.push([`${format === 'text' ? '' : '— '}${bold(dayLabel(day, cfg.locale), format)}`, ...lines].join('\n\n'));
  }
  blocks.push(plain(CANCEL_HINT, format));
  return blocks.join('\n\n');
}

export interface DigestOptions {
  title: string;
  query: Query;
  items: Item[];
  format?: Format;
  /** Cap per day; 0 = no cap. */
  maxPerDay?: number;
  explain?: boolean;
  footer?: string;
  /** Number items continuously (console output only; Telegram gets one message each). */
  numbered?: boolean;
  changeNotes?: Map<string, string>;
}

/**
 * Full digest as one block of text: header, day sections, numbered items, footer.
 *
 * This is the console shape, for `scripts/search.ts` and the agent hand-off in
 * `src/source.ts`. Telegram does not use it — see `buildMessages`.
 *
 * Also returns `ordered` — the items in the order they were numbered, which is
 * day-grouped and therefore NOT the score order they came in as.
 */
export function buildDigest(opts: DigestOptions): { text: string; ordered: Item[] } {
  const cfg = loadConfig();
  const format = opts.format ?? 'html';
  const maxPerDay = opts.maxPerDay ?? cfg.digest.max_items_per_day;
  const cities = opts.query.cities.map((c) => cityLabel(c)).join(', ');

  // places are not pinned to a day, so they get a flat list and no date range
  const placesOnly = opts.items.length > 0 && opts.items.every((i) => i.kind === 'place');
  const head = placesOnly
    ? `${bold(opts.title, format)}\n${plain(cities, format)}`
    : `${bold(opts.title, format)}\n${plain(`${cities} · ${rangeText(opts.query)}`, format)}`;
  if (opts.items.length === 0) {
    const empty = opts.footer ?? NOTHING_FOUND;
    return { text: `${head}\n\n${plain(empty, format)}`, ordered: [] };
  }

  const blocks: string[] = [head];
  const ordered: Item[] = [];
  let n = 1;

  if (placesOnly) {
    ordered.push(...opts.items);
    blocks.push(
      opts.items
        .map((it) => renderItem(it, { format, index: opts.numbered === false ? undefined : n++, explain: opts.explain }))
        .join('\n\n'),
    );
    blocks.push(plain(opts.footer ?? PLACES_HINT, format));
    return { text: blocks.join('\n\n'), ordered };
  }

  for (const group of groupByDay(opts.items, cfg.timezone)) {
    const dayHead = group.day === 'tbd' ? 'Дата уточнюється' : dayLabel(group.day, cfg.locale);
    const shown = maxPerDay > 0 ? group.items.slice(0, maxPerDay) : group.items;
    ordered.push(...shown);
    const rendered = shown.map((it) =>
      renderItem(it, {
        format,
        index: opts.numbered === false ? undefined : n++,
        explain: opts.explain,
        changeNote: opts.changeNotes?.get(it.id),
      }),
    );
    const more = group.items.length - shown.length;
    blocks.push(
      [`${format === 'text' ? '' : '— '}${bold(dayHead, format)}`, ...rendered, more > 0 ? plain(`…і ще ${more}`, format) : '']
        .filter(Boolean)
        .join('\n\n'),
    );
  }
  blocks.push(plain(opts.footer ?? REMINDER_HINT, format));
  return { text: blocks.join('\n\n'), ordered };
}

/** Digest text only. */
export function renderDigest(opts: DigestOptions): string {
  return buildDigest(opts).text;
}

export interface OutgoingMessage {
  text: string;
  /** What this message is about: exactly one item for an event, none for the header. */
  items: Item[];
  /** The buttons under an event card; the header has none. */
  inlineKeyboard?: InlineButton[][];
}

/**
 * The buttons under one event card.
 *
 * `callback_data` is `ev:<verb>:<item id>` — three bytes of prefix plus a
 * 40-character sha1, which leaves room inside Telegram's 64-byte limit. The
 * item is still resolved from the messages table (chat + message id), the same
 * path a ❤️ takes; the id in the data is what tells a tap which card it came
 * from when the message carried more than one.
 *
 * ⏰ is a toggle and says which way it is pointing, like a heart you can see.
 */
export function eventKeyboard(item: Item, opts: { reminded?: boolean } = {}): InlineButton[][] {
  const ev = (verb: string) => `ev:${verb}:${item.id}`;
  return [
    [
      { text: opts.reminded ? '⏰ Не нагадувати' : '⏰ Нагадати', callback_data: ev('r') },
      { text: '👎 Не моє', callback_data: ev('no') },
    ],
    [
      { text: '📅 В календар', callback_data: ev('cal') },
      { text: '↗️ Поділитись', callback_data: ev('share') },
    ],
  ];
}

/**
 * The Telegram shape: a short header, then **one message per event**.
 *
 * One message per event is what makes the heart work. Every event message is
 * stored against its single item (see src/deliver.ts), so a ❤️ reaction on it
 * resolves to exactly one event with nothing to disambiguate — no numbering,
 * no "which one did you mean".
 *
 * The header carries the city, the window and the count; the events keep their
 * own day, since there are no day headings to group them under any more.
 */
export function buildMessages(opts: DigestOptions): OutgoingMessage[] {
  const cfg = loadConfig();
  const format = opts.format ?? 'html';
  const maxPerDay = opts.maxPerDay ?? cfg.digest.max_items_per_day;
  const placesOnly = opts.items.length > 0 && opts.items.every((i) => i.kind === 'place');

  // same order and same per-day cap as the digest, then flattened
  const kept: Item[] = [];
  if (placesOnly) {
    kept.push(...opts.items);
  } else {
    for (const group of groupByDay(opts.items, cfg.timezone)) {
      kept.push(...(maxPerDay > 0 ? group.items.slice(0, maxPerDay) : group.items));
    }
  }

  const facts = [
    opts.query.cities.map((c) => cityLabel(c)).join(', '),
    // dates only: the title already names the window, and "(цього тижня)"
    // under a "Цього тижня" heading is just noise
    placesOnly ? '' : rangeDates(opts.query),
    kept.length ? (placesOnly ? countPlaces(kept.length) : countEvents(kept.length)) : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const tail = kept.length === 0 ? opts.footer ?? NOTHING_FOUND : opts.footer ?? (placesOnly ? PLACES_HINT : REMINDER_HINT);
  const header = `${bold(opts.title, format)}\n${plain(facts, format)}\n\n${plain(tail, format)}`;

  return [
    { text: header, items: [] },
    ...kept.map((item) => ({
      text: renderItem(item, {
        format,
        withDay: !placesOnly,
        explain: opts.explain,
        changeNote: opts.changeNotes?.get(item.id),
      }),
      items: [item],
      // places have no start time to remind about and no ticket to share
      ...(item.kind === 'event' ? { inlineKeyboard: eventKeyboard(item) } : {}),
    })),
  ];
}

/** "пт, 23 жовт. – нд, 25 жовт.", or one day when the window is one day. */
export function rangeDates(q: Query): string {
  const cfg = loadConfig();
  if (q.from === q.to) return dayLabel(q.from, cfg.locale);
  return `${dayLabel(q.from, cfg.locale)} – ${dayLabel(q.to, cfg.locale)}`;
}

export function rangeText(q: Query): string {
  const cfg = loadConfig();
  if (q.from === q.to) return `${dayLabel(q.from, cfg.locale)} (${q.rangeLabel})`;
  return `${dayLabel(q.from, cfg.locale)} – ${dayLabel(q.to, cfg.locale)} (${q.rangeLabel})`;
}

/** Compact one-line summary used in logs and in the agent's console output. */
export function summarize(items: Item[]): string {
  const bySource = new Map<string, number>();
  for (const i of items) for (const s of i.sources) bySource.set(s, (bySource.get(s) ?? 0) + 1);
  const parts = [...bySource.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s}:${n}`);
  return `${items.length} items (${parts.join(', ') || 'none'})`;
}
