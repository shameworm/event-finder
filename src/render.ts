import type { Item, Query } from './types.ts';
import { EMOJI, classify } from './categories.ts';
import { cityLabel, loadConfig } from './config.ts';
import { priceText } from './normalize.ts';
import { dayLabel, localDate, localTime, truncate } from './util.ts';
import { groupByDay } from './rank.ts';
import { googleCalendarUrl } from './calendar.ts';
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

/**
 * The accusative, for "відфільтрував ще 1 подію". Ukrainian declines the noun
 * after a number as well as pluralising it, so a sentence that puts the count
 * anywhere but the subject needs its own form — "ще 1 події" is simply wrong.
 */
export const countEventsAcc = (n: number): string => `${n} ${plural(n, ['подію', 'події', 'подій'])}`;

/** "1 подія чекає", "2 події чекають" — the verb agrees with the count too. */
export const eventsWaiting = (n: number): string =>
  `${countEvents(n)} ${plural(n, ['чекає', 'чекають', 'чекають'])}`;
export const countReminders = (n: number): string => `${n} ${plural(n, ['нагадування', 'нагадування', 'нагадувань'])}`;

export const REMINDER_HINT = 'Тисни ⏰ під подією або ❤️ на ній — нагадаю за день і за 3 години до початку.';
export const NO_REMINDERS = 'Нагадувань поки немає. Тисни ⏰ під подією або ❤️ на ній — і я поставлю.';
export const CANCEL_HINT = 'Тисни ⏰ під подією ще раз або знімеш ❤️ — скасую нагадування.';
export const NOTHING_FOUND = 'Цього разу нічого не знайшлося. Спробуй ширший період або інше місто.';

/**
 * The one thing a header has to admit when it is not a list: that the rest is
 * behind the card rather than missing.
 *
 * No count in it on purpose. A header is written once and then only has its
 * button redrawn, so a number here would still say 36 when four are left — the
 * buttons under the card carry the counts, and those are read fresh on every
 * step. Shared by the on-demand answer and the scheduled digest, because they
 * are the same card and the same walk.
 */
export const WALK_HINT =
  'Показую по одній, щоб не завалити тебе повідомленнями — гортай «Далі →» і «← Назад» під карткою.';

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

/** One event line: emoji, title, venue, time, price, description, link. */
export function renderItem(item: Item, opts: RenderItemOptions = {}): string {
  const cfg = loadConfig();
  const format = opts.format ?? 'html';
  const tz = opts.tz ?? cfg.timezone;
  const emoji = EMOJI[item.category] ?? '✨';
  const num = opts.index !== undefined ? `${opts.index}. ` : '';

  // Telegram posts often give a date but no time; 00:00 means "unknown", not midnight
  const timeKnown = item.startsAt ? !(item.confidence === 'low' && localTime(item.startsAt, tz) === '00:00') : false;
  const day = opts.withDay && item.startsAt ? dayLabel(item.startsAt.slice(0, 10), cfg.locale) : '';
  const when = item.startsAt
    ? [day, timeKnown ? localTime(item.startsAt, tz) : 'час уточнюється'].filter(Boolean).join(' ')
    : 'дата уточнюється';

  const facts = [when, item.venue, priceText(item)]
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
  const buyable = !item.free && (item.priceMin !== undefined || item.priceMax !== undefined);
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
  /** How many ranked events did not fit; puts a "показати ще" button on the header. */
  more?: number;
  /**
   * The state of one card's buttons (saved? reminded?), asked per item so the
   * renderer never has to touch the database itself.
   */
  cardState?: (item: Item) => CardState;
  /** Buttons for the header when nothing matched — the empty state's way out. */
  emptyKeyboard?: InlineButton[][];
  /**
   * How many events the answer actually found, when only some of them are
   * being sent. The header counts the whole answer, not this batch of it —
   * "37 подій" is the useful number when one card is on its way.
   */
  found?: number;
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

  const head = `${bold(opts.title, format)}\n${plain(`${cities} · ${rangeText(opts.query)}`, format)}`;
  if (opts.items.length === 0) {
    const empty = opts.footer ?? NOTHING_FOUND;
    return { text: `${head}\n\n${plain(empty, format)}`, ordered: [] };
  }

  const blocks: string[] = [head];
  const ordered: Item[] = [];
  let n = 1;

  for (const group of groupByDay(opts.items, cfg.timezone)) {
    const label = group.day === 'tbd' ? '' : dayLabel(group.day, cfg.locale);
    const dayHead = label || 'Дата уточнюється';
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
  /**
   * Poster to send this card as a photo, with `caption` under it. Both are set
   * together, or neither is; `text` is always the full message-sized card, so a
   * poster Telegram refuses costs nothing but the picture.
   */
  image?: string;
  caption?: string;
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
 *
 * 📅 is the one button that never calls back: it is a link straight to Google's
 * pre-filled form (see src/calendar.ts). It is also the one button that can be
 * missing — "дата уточнюється" is nothing a calendar can hold, so an event
 * without a start time gets no 📅 instead of a 📅 that apologises.
 */
export function eventKeyboard(item: Item, opts: CardState = {}): InlineButton[][] {
  const ev = (verb: string) => `ev:${verb}:${item.id}`;
  const google = googleCalendarUrl(item);
  // the cursor row: only the halves that lead somewhere. A button that answers
  // "нічого немає" is worse than no button, and the counts are the point of
  // walking one at a time — they say how much is there without sending it.
  const nav: InlineButton[] = [
    ...(opts.prevCount ? [{ text: `← Назад (${opts.prevCount})`, callback_data: ev('p') }] : []),
    ...(opts.nextCount ? [{ text: `Далі → (${opts.nextCount})`, callback_data: ev('n') }] : []),
  ];
  return [
    [
      { text: 'ℹ️ Деталі', callback_data: ev('i') },
      { text: opts.saved ? '🔖 Збережено' : '🔖 Зберегти', callback_data: ev('s') },
    ],
    ...(nav.length ? [nav] : []),
    [
      { text: opts.reminded ? '⏰ Не нагадувати' : '⏰ Нагадати', callback_data: ev('r') },
      { text: '👎 Не моє', callback_data: ev('no') },
    ],
    ...(google ? [[{ text: '📅 В календар', url: google }]] : []),
  ];
}

/** What the buttons under a card have to know about it right now. */
export interface CardState {
  reminded?: boolean;
  saved?: boolean;
  /** How many events are still waiting behind this one; 0 or absent hides "Далі →". */
  nextCount?: number;
  /** How many have already been walked past; 0 or absent hides "← Назад". */
  prevCount?: number;
}

/**
 * The details screen: the same event, with everything the source actually gave
 * us and nothing it did not. Missing fields are left out rather than filled in
 * with a plausible guess — a venue we invented would send somebody to the
 * wrong address.
 */
export function renderDetails(item: Item, opts: { format?: Format; tz?: string } = {}): string {
  const cfg = loadConfig();
  const format = opts.format ?? 'html';
  const tz = opts.tz ?? cfg.timezone;
  const emoji = EMOJI[item.category] ?? '✨';

  const timeKnown = item.startsAt ? !(item.confidence === 'low' && localTime(item.startsAt, tz) === '00:00') : false;
  const lines: string[] = [
    `${emoji} ${bold(item.title, format)}${STATUS_BADGE[item.status] ?? ''}`,
  ];

  if (item.startsAt) {
    const day = dayLabel(item.startsAt.slice(0, 10), cfg.locale);
    lines.push(plain(`📅 ${day}${timeKnown ? ` · ${localTime(item.startsAt, tz)}` : ' · час уточнюється'}`, format));
  }
  const place = [item.venue, item.address].filter((x): x is string => Boolean(x?.trim())).join(', ');
  if (place) lines.push(plain(`📍 ${place}`, format));
  lines.push(plain(`🏙 ${cityLabel(item.city)}`, format));
  const price = priceText(item);
  if (price) lines.push(plain(`💸 ${price}`, format));
  if (item.performers?.length) lines.push(plain(`🎤 ${item.performers.slice(0, 5).join(', ')}`, format));
  if (item.description) lines.push('', plain(truncate(item.description, 700), format));
  lines.push('', plain(`Джерело: ${item.sources.join(', ') || item.source}`, format));
  lines.push(link('сторінка події →', item.url, format));
  if (item.confidence === 'low') {
    lines.push(plain('⚠️ Це з телеграм-каналу чи пошуку — дату й час варто перевірити за посиланням.', format));
  }
  return lines.join('\n');
}

/**
 * The details screen as a caption, for a card that went out as a photo.
 *
 * Same trick as `renderCaption`: shorten the description — the one field that
 * can be arbitrarily long — rather than clamp rendered HTML, which would cut a
 * tag in half and have Telegram reject the edit.
 */
export function renderDetailsCaption(item: Item, opts: { format?: Format; tz?: string } = {}): string {
  const full = renderDetails(item, opts);
  if (full.length <= CAPTION_LIMIT) return full;
  for (const len of [400, 200, 80]) {
    const text = renderDetails({ ...item, description: truncate(item.description ?? '', len) || undefined }, opts);
    if (text.length <= CAPTION_LIMIT) return text;
  }
  return renderDetails({ ...item, description: undefined, performers: undefined }, opts);
}

/** The buttons under the details screen: act on it, or go back to the card. */
export function detailsKeyboard(item: Item, opts: CardState = {}): InlineButton[][] {
  const ev = (verb: string) => `ev:${verb}:${item.id}`;
  const google = googleCalendarUrl(item);
  return [
    [
      { text: opts.saved ? '🔖 Збережено' : '🔖 Зберегти', callback_data: ev('s') },
      { text: opts.reminded ? '⏰ Не нагадувати' : '⏰ Нагадати', callback_data: ev('r') },
    ],
    [
      { text: '🎟 Квитки', url: item.url },
      ...(google ? [{ text: '📅 В календар', url: google }] : []),
    ],
    [{ text: '⬅️ До картки', callback_data: ev('b') }],
  ];
}

/**
 * The header's own button: a whole page of the rest, for anyone who would
 * rather scroll a list than walk it.
 *
 * This is the batch half of the pair. The one-at-a-time half is "Далі →"
 * under the card, and the difference is deliberate: a fresh answer sends a
 * single card, and this button is the explicit way to ask for more than that.
 *
 * `callback_data` is the bare `more` — which message to continue comes from
 * the callback itself (chat + the header's message id), so nothing has to be
 * squeezed into Telegram's 64 bytes and an old button can never point at
 * somebody else's page.
 */
export function moreButton(rest: number): InlineButton[][] {
  return [[{ text: `📋 Показати списком (ще ${rest})`, callback_data: 'more' }]];
}

/**
 * The Telegram shape: a short header, then **one message per event it is given**
 * — which, for both an answer and a digest, is one card with the rest in the
 * stash behind it.
 *
 * One message per event is what makes the heart work. Every event message is
 * stored against its single item (see src/deliver.ts), so a ❤️ reaction on it
 * resolves to exactly one event with nothing to disambiguate — no numbering,
 * no "which one did you mean".
 *
 * The header carries the city, the window and the count — the count of the
 * whole answer, not of the card, which is what `found` is for. The events keep
 * their own day, since there are no day headings to group them under any more.
 */
export function buildMessages(opts: DigestOptions): OutgoingMessage[] {
  const cfg = loadConfig();
  const format = opts.format ?? 'html';
  const maxPerDay = opts.maxPerDay ?? cfg.digest.max_items_per_day;

  // same order and same per-day cap as the digest, then flattened
  const kept: Item[] = [];
  for (const group of groupByDay(opts.items, cfg.timezone)) {
    kept.push(...(maxPerDay > 0 ? group.items.slice(0, maxPerDay) : group.items));
  }

  // the header counts the answer, not the batch: one card may be on its way
  // while thirty-six wait behind it
  const found = Math.max(opts.found ?? 0, kept.length);
  const facts = [
    opts.query.cities.map((c) => cityLabel(c)).join(', '),
    // dates only: the title already names the window, and "(цього тижня)"
    // under a "Цього тижня" heading is just noise
    rangeDates(opts.query),
    found ? countEvents(found) : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const tail = kept.length === 0 ? opts.footer ?? NOTHING_FOUND : opts.footer ?? REMINDER_HINT;
  const header = `${bold(opts.title, format)}\n${plain(facts, format)}\n\n${plain(tail, format)}`;

  const headerKeyboard =
    kept.length === 0 ? opts.emptyKeyboard : opts.more && opts.more > 0 ? moreButton(opts.more) : undefined;

  return [
    { text: header, items: [], ...(headerKeyboard?.length ? { inlineKeyboard: headerKeyboard } : {}) },
    ...kept.map((item) => {
      const itemOpts: RenderItemOptions = {
        format,
        withDay: true,
        explain: opts.explain,
        changeNote: opts.changeNotes?.get(item.id),
      };
      const caption = item.image ? renderCaption(item, itemOpts) : null;
      return {
        text: renderItem(item, itemOpts),
        items: [item],
        inlineKeyboard: eventKeyboard(item, opts.cardState?.(item)),
        ...(item.image && caption ? { image: item.image, caption } : {}),
      };
    }),
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
