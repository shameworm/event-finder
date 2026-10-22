import type { Item, Query } from './types.ts';
import { EMOJI } from './categories.ts';
import { cityLabel, loadConfig } from './config.ts';
import { priceText } from './normalize.ts';
import { dayLabel, localTime, truncate } from './util.ts';
import { groupByDay } from './rank.ts';
import { escapeHtml } from './telegram-api.ts';
import * as copy from './copy.ts';

export type Format = 'html' | 'text';

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
    ? `${opts.withDay ? dayLabel(item.startsAt.slice(0, 10), cfg.locale) + ' ' : ''}${timeKnown ? localTime(item.startsAt, tz) : copy.TIME_UNKNOWN}`
    : copy.DATE_UNKNOWN;

  const facts = (item.kind === 'place'
    ? [item.address, item.venue]
    : [when, item.venue, priceText(item)])
    .filter((x): x is string => Boolean(x && x.trim()))
    .map((x) => plain(x, format))
    .join(' · ');

  const note = opts.changeNote ? copy.CHANGE_NOTE[opts.changeNote] ?? opts.changeNote : undefined;
  const lines = [
    `${num}${emoji} ${bold(item.title, format)}${copy.STATUS_BADGE[item.status] ?? ''}${note ? ` — 🔁 ${note}` : ''}`,
    facts,
  ];
  if (item.description) lines.push(plain(truncate(item.description, 140), format));
  // "квитки" is a promise; a free event or one with no price has none to make
  const buyable = item.kind === 'event' && !item.free && (item.priceMin !== undefined || item.priceMax !== undefined);
  lines.push(link(buyable ? copy.TICKETS_LINK : copy.DETAILS_LINK, item.url, format));
  if (opts.explain && item.reasons?.length) {
    lines.push(plain(`· ${item.reasons.slice(0, 4).join(', ')} (${item.score})`, format));
  }
  return lines.filter(Boolean).join('\n');
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
    return { text: `${head}\n\n${plain(opts.footer ?? copy.NOTHING_FOUND, format)}`, ordered: [] };
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
    blocks.push(plain(opts.footer ?? copy.PLACES_HINT, format));
    return { text: blocks.join('\n\n'), ordered };
  }

  for (const group of groupByDay(opts.items, cfg.timezone)) {
    const dayHead = group.day === 'tbd' ? copy.DAY_UNKNOWN : dayLabel(group.day, cfg.locale);
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
      [
        `${format === 'text' ? '' : '— '}${bold(dayHead, format)}`,
        ...rendered,
        more > 0 ? plain(copy.andMore(more), format) : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
  }
  blocks.push(plain(opts.footer ?? copy.REMINDER_HINT, format));
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
    kept.length ? (placesOnly ? copy.countPlaces(kept.length) : copy.countEvents(kept.length)) : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const tail = kept.length === 0
    ? opts.footer ?? copy.NOTHING_FOUND
    : opts.footer ?? (placesOnly ? copy.PLACES_HINT : copy.REMINDER_HINT);
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
