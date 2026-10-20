import type { Item, Preferences, Query } from './types.ts';
import { categoryFromWord, containsTerm, expandTag } from './categories.ts';
import { localDate, normText, stemText } from './util.ts';
import { loadConfig } from './config.ts';

function haystack(i: Item): string {
  return stemText([i.title, i.description ?? '', (i.performers ?? []).join(' '), i.venue ?? ''].join(' '));
}

/** Title + performers only — the part of an item we trust for category matching. */
function headline(i: Item): string {
  return stemText([i.title, (i.performers ?? []).join(' ')].join(' '));
}

/**
 * Does this item match a taste tag?
 *
 * A tag that names a category ("standup", "concert", "indie") matches on the
 * item's category, or on its title — never on its description, because long
 * blurbs mention every genre under the sun ("романтична комедія" in a drama
 * would otherwise read as stand-up).
 *
 * A free-text tag ("classical", "шансон", "vinyl") has no category to lean on,
 * so it matches anywhere, description included.
 */
export function matchesTag(item: Item, tag: string): boolean {
  const cat = categoryFromWord(tag);
  const terms = [...new Set(expandTag(tag).map(stemText))].filter((t) => t.length >= 4);
  if (cat) {
    if (item.category === cat) return true;
    const head = headline(item);
    return terms.some((t) => containsTerm(head, t));
  }
  const hay = haystack(item);
  return terms.some((t) => containsTerm(hay, t));
}

export function matchesFollow(item: Item, name: string): boolean {
  const n = normText(name);
  if (n.length < 3) return false;
  const fields = [item.title, ...(item.performers ?? [])].map(normText);
  return fields.some((f) => f.includes(n));
}

export interface RankOptions {
  query: Query;
  prefs: Preferences;
  /** Keep disliked items instead of dropping them. */
  keepDisliked?: boolean;
  /** Keep items above max_ticket_price instead of dropping them. */
  keepExpensive?: boolean;
  tz?: string;
}

export interface Ranked {
  items: Item[];
  dropped: { item: Item; why: string }[];
}

/**
 * Score every item against preferences + this request, then sort.
 * Disliked and over-budget items are dropped by default (reported in `dropped`).
 */
export function rank(items: Item[], opts: RankOptions): Ranked {
  const tz = opts.tz ?? loadConfig().timezone;
  const { query, prefs } = opts;
  const likes = [...new Set([...query.like, ...prefs.favourite_categories, ...(prefs.interests ?? [])])];
  const dislikes = [...new Set([...query.dislike, ...prefs.disliked_categories])];
  const maxPrice = query.maxPrice ?? prefs.max_ticket_price ?? undefined;

  const kept: Item[] = [];
  const dropped: { item: Item; why: string }[] = [];

  for (const item of items) {
    const reasons: string[] = [];
    let score = 0;

    // request-level likes count double: that is what the user asked for right now
    for (const tag of query.like) if (matchesTag(item, tag)) { score += 6; reasons.push(`asked for "${tag}"`); }
    for (const tag of prefs.favourite_categories) if (matchesTag(item, tag)) { score += 3; reasons.push(`favourite "${tag}"`); }
    for (const tag of prefs.interests ?? []) if (matchesTag(item, tag)) { score += 1.5; reasons.push(`interest "${tag}"`); }

    const follows = (prefs.follow ?? []).filter((f) => matchesFollow(item, f));
    if (follows.length) { score += 10; reasons.push(`you follow ${follows.join(', ')}`); }

    const hitDislike = dislikes.find((tag) => matchesTag(item, tag));
    if (hitDislike && !follows.length) {
      if (!opts.keepDisliked) { dropped.push({ item, why: `disliked: ${hitDislike}` }); continue; }
      score -= 20;
      reasons.push(`disliked "${hitDislike}"`);
    }

    // a followed act beats every filter — that is the point of following them
    if (maxPrice !== undefined && item.priceMin !== undefined && item.priceMin > maxPrice && !follows.length) {
      if (!opts.keepExpensive) { dropped.push({ item, why: `over budget (${item.priceMin} > ${maxPrice})` }); continue; }
      score -= 6;
      reasons.push('over budget');
    }

    if (item.status === 'cancelled') { score -= 15; reasons.push('cancelled'); }
    if (item.status === 'soldout') { score -= 8; reasons.push('sold out'); }
    if (item.status === 'limited') { score += 1; reasons.push('few tickets left'); }
    if (item.free) { score += 2; reasons.push('free'); }
    if (item.sources.length > 1) { score += 0.5 * (item.sources.length - 1); reasons.push(`on ${item.sources.length} sources`); }
    if (item.description) score += 0.5;
    if (item.confidence === 'low') score -= 1;

    // slight preference for things happening sooner inside the window
    if (item.startsAt) {
      const day = localDate(item.startsAt, tz);
      const span = Math.max(1, (Date.parse(`${query.to}T00:00:00Z`) - Date.parse(`${query.from}T00:00:00Z`)) / 86400000);
      const offset = (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${query.from}T00:00:00Z`)) / 86400000;
      score += Math.max(0, 1 - offset / (span + 1));
    }

    kept.push({ ...item, score: Math.round(score * 100) / 100, reasons });
  }

  kept.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (a.startsAt ?? '').localeCompare(b.startsAt ?? ''));
  return { items: kept, dropped };
}

/** Group ranked items by local day, days ascending, best item first inside a day. */
export function groupByDay(items: Item[], tz = loadConfig().timezone): { day: string; items: Item[] }[] {
  const map = new Map<string, Item[]>();
  for (const it of items) {
    const day = it.startsAt ? localDate(it.startsAt, tz) : 'tbd';
    const list = map.get(day);
    if (list) list.push(it);
    else map.set(day, [it]);
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a === 'tbd' ? 1 : b === 'tbd' ? -1 : a.localeCompare(b)))
    .map(([day, list]) => ({
      day,
      items: list.sort((x, y) => (y.score ?? 0) - (x.score ?? 0) || (x.startsAt ?? '').localeCompare(y.startsAt ?? '')),
    }));
}
