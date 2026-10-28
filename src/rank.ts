import type { Item, Preferences, Query } from './types.ts';
import { PLACE_CATEGORIES, categoryKeyOf, containsTerm, expandTag } from './categories.ts';
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
 * A tag that *names* a category ("standup", "concert") matches on the item's
 * category, or on its title — never on its description, because long blurbs
 * mention every genre under the sun ("романтична комедія" in a drama would
 * otherwise read as stand-up).
 *
 * A genre or free-text tag ("indie", "classical", "шансон", "vinyl") has no
 * category to lean on, so it matches anywhere, description included. It must
 * not borrow one either: "інді" belongs to the concert keyword list, and
 * treating it as `concert` made a single indie interest match every gig in
 * town — and then told the user the reason was "indie".
 */
export function matchesTag(item: Item, tag: string): boolean {
  const cat = categoryKeyOf(tag);
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
  /** Keep items that match nothing this person likes (the shared cache does). */
  keepOffTaste?: boolean;
  /** Let off-taste items back in until at least this many remain. */
  tasteFloor?: number;
  tz?: string;
}

export interface Ranked {
  items: Item[];
  dropped: { item: Item; why: string }[];
  /**
   * How many off-taste items had to be let back in to fill the list. Non-zero
   * means "there was not enough of your thing on" — worth telling the person,
   * or they will think the filter is broken.
   */
  toppedUp: number;
}

/** A favourite is worth this, plus one more per ❤️ it has collected. */
const FAVOURITE = 3;
const INTEREST = 1.5;
/** Hearts stop adding weight here, so one obsession cannot drown everything. */
const HEART_CAP = 5;

/**
 * Score every item against preferences + this request, then sort.
 *
 * Disliked and over-budget items are dropped by default, and so is anything
 * that matches nothing this person likes — a taste model that only nudges the
 * order is invisible, because a free event on two ticket sites outscores a
 * category someone chose by hand. What survives the filter is reported in
 * `items`, the rest in `dropped`.
 *
 * The filter needs something to filter *by*, so it is off for anyone with an
 * empty profile, and off for the shared city cache (`keepOffTaste`), which is
 * written once for everybody and ranked per person afterwards.
 */
export function rank(items: Item[], opts: RankOptions): Ranked {
  const cfg = loadConfig();
  const tz = opts.tz ?? cfg.timezone;
  const { query, prefs } = opts;
  const dislikes = [...new Set([...query.dislike, ...prefs.disliked_categories])];
  const maxPrice = query.maxPrice ?? prefs.max_ticket_price ?? undefined;
  const hearts = (tag: string) => Math.min(prefs.taste?.[tag] ?? 0, HEART_CAP);

  /**
   * What counts as "their thing" for this search. An explicit request wins
   * over the stored profile: someone who asks for stand-up wants stand-up, not
   * everything they have ever liked.
   *
   * Tags for the wrong kind of thing are left out, or /places would filter a
   * concert-lover's café suggestions down to nothing and then pad them all
   * back with an apology. Free-text tags ("speciality coffee") fit both.
   */
  const placesOnly = query.kinds.includes('place') && !query.kinds.includes('event');
  const forThisKind = (tag: string) => {
    const cat = categoryKeyOf(tag);
    return !cat || PLACE_CATEGORIES.includes(cat) === placesOnly;
  };
  const asked = (
    query.like.length > 0 ? query.like : [...prefs.favourite_categories, ...(prefs.genres ?? [])]
  ).filter(forThisKind);
  const filtering = !opts.keepOffTaste && asked.length > 0;

  const kept: { item: Item; onTaste: boolean }[] = [];
  const dropped: { item: Item; why: string }[] = [];

  for (const item of items) {
    const reasons: string[] = [];
    let score = 0;

    // request-level likes count double: that is what the user asked for right now
    for (const tag of query.like) if (matchesTag(item, tag)) { score += 6; reasons.push(`asked for "${tag}"`); }
    for (const tag of prefs.favourite_categories) {
      if (!matchesTag(item, tag)) continue;
      // every ❤️ on this category is another vote for it
      score += FAVOURITE + hearts(tag);
      reasons.push(hearts(tag) ? `favourite "${tag}" (❤️ ${prefs.taste?.[tag]})` : `favourite "${tag}"`);
    }
    for (const tag of prefs.genres ?? []) {
      if (!matchesTag(item, tag)) continue;
      score += INTEREST + hearts(tag) / 2;
      reasons.push(`genre "${tag}"`);
    }

    // an explicit 👎 on an act is checked first and short-circuits everything
    // below: a followed act beats every filter, so a name that is on both
    // lists would otherwise come back through the follow bonus
    const blocked = (prefs.blocked_acts ?? []).find((b) => matchesFollow(item, b));
    if (blocked) {
      if (!opts.keepDisliked) { dropped.push({ item, why: `blocked act: ${blocked}` }); continue; }
      score -= 30;
      reasons.push(`blocked act "${blocked}"`);
    }

    const follows = blocked ? [] : (prefs.follow ?? []).filter((f) => matchesFollow(item, f));
    if (follows.length) { score += 10; reasons.push(`you follow ${follows.join(', ')}`); }

    const onTaste = !blocked && (follows.length > 0 || asked.some((tag) => matchesTag(item, tag)));

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
      // a day that does not parse would make the whole score NaN, and a NaN
      // score sorts to the front — one bad date would lead every digest
      if (!Number.isNaN(offset)) score += Math.max(0, 1 - offset / (span + 1));
    }

    kept.push({ item: { ...item, score: Math.round(score * 100) / 100, reasons }, onTaste });
  }

  const byScore = (a: Item, b: Item) =>
    (b.score ?? 0) - (a.score ?? 0) || (a.startsAt ?? '').localeCompare(b.startsAt ?? '');
  const ordered = kept.sort((a, b) => byScore(a.item, b.item));
  if (!filtering) return { items: ordered.map((k) => k.item), dropped, toppedUp: 0 };

  const floor = opts.tasteFloor ?? cfg.bot.taste_floor;
  const mine = ordered.filter((k) => k.onTaste).map((k) => k.item);
  const rest = ordered.filter((k) => !k.onTaste).map((k) => k.item);
  // nothing of theirs is on: a short list of the next best beats an empty one
  const fill = mine.length >= floor ? [] : rest.slice(0, floor - mine.length);
  for (const item of rest.slice(fill.length)) dropped.push({ item, why: 'not in their taste' });
  return { items: [...mine, ...fill].sort(byScore), dropped, toppedUp: fill.length };
}

/** Group ranked items by local day, days ascending, best item first inside a day. */
export function groupByDay(items: Item[], tz = loadConfig().timezone): { day: string; items: Item[] }[] {
  const map = new Map<string, Item[]>();
  for (const it of items) {
    // an unparseable date is "unknown", not its own empty-string day
    const day = (it.startsAt ? localDate(it.startsAt, tz) : '') || 'tbd';
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
