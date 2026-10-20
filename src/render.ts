import type { Item, Query } from './types.ts';
import { EMOJI } from './categories.ts';
import { cityLabel, loadConfig } from './config.ts';
import { priceText } from './normalize.ts';
import { dayLabel, localTime, truncate } from './util.ts';
import { groupByDay } from './rank.ts';
import { escapeHtml } from './telegram-api.ts';

export type Format = 'html' | 'text';

const STATUS_BADGE: Record<string, string> = {
  soldout: ' — 🚫 SOLD OUT',
  cancelled: ' — ❌ CANCELLED',
  postponed: ' — ⏳ POSTPONED',
  limited: ' — ⚠️ few tickets left',
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
    ? `${opts.withDay ? dayLabel(item.startsAt.slice(0, 10), cfg.locale) + ' ' : ''}${timeKnown ? localTime(item.startsAt, tz) : 'time TBA'}`
    : 'date TBA';

  const facts = (item.kind === 'place'
    ? [item.address, item.venue]
    : [when, item.venue, priceText(item)])
    .filter((x): x is string => Boolean(x && x.trim()))
    .map((x) => plain(x, format))
    .join(' · ');

  const lines = [
    `${num}${emoji} ${bold(item.title, format)}${STATUS_BADGE[item.status] ?? ''}${opts.changeNote ? ` — 🔁 ${opts.changeNote}` : ''}`,
    facts,
  ];
  if (item.description) lines.push(plain(truncate(item.description, 140), format));
  lines.push(link(item.kind === 'place' ? 'details →' : 'tickets →', item.url, format));
  if (opts.explain && item.reasons?.length) {
    lines.push(plain(`· ${item.reasons.slice(0, 4).join(', ')} (score ${item.score})`, format));
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
  /** Number items continuously so the user can reply "🔔 3". */
  numbered?: boolean;
  changeNotes?: Map<string, string>;
}

/**
 * Full digest: header, day sections, numbered items, footer.
 *
 * Also returns `ordered` — the items in the order they were numbered, which is
 * day-grouped and therefore NOT the score order they came in as. Callers store
 * that list so a "🔔 3" reply resolves to the event the user actually saw as 3.
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
    const empty = opts.footer ?? 'Nothing matched this time. Try a wider date range or another city.';
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
    blocks.push(plain(opts.footer ?? 'Tell me what you think and I will tune the suggestions.', format));
    return { text: blocks.join('\n\n'), ordered };
  }

  for (const group of groupByDay(opts.items, cfg.timezone)) {
    const dayHead = group.day === 'tbd' ? 'Date to be announced' : dayLabel(group.day, cfg.locale);
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
      [`${format === 'text' ? '' : '— '}${bold(dayHead, format)}`, ...rendered, more > 0 ? plain(`…and ${more} more`, format) : '']
        .filter(Boolean)
        .join('\n\n'),
    );
  }
  blocks.push(plain(opts.footer ?? 'Reply 🔔 (or "🔔 3") to get a reminder 1 day and 3 hours before it starts.', format));
  return { text: blocks.join('\n\n'), ordered };
}

/** Digest text only. */
export function renderDigest(opts: DigestOptions): string {
  return buildDigest(opts).text;
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
