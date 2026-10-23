import type { Item, Status } from './types.ts';
import { jaccard, localDate, localTime, tokens } from './util.ts';
import { loadConfig } from './config.ts';

const STATUS_RANK: Record<Status, number> = {
  cancelled: 5, soldout: 4, postponed: 3, limited: 2, scheduled: 1, unknown: 0,
};

/** Trust order when two sources disagree about the canonical link. */
const SOURCE_RANK = (source: string): number => {
  if (source.startsWith('concert.ua')) return 4;
  if (source.startsWith('karabas')) return 3;
  if (source.startsWith('kontramarka')) return 2;
  if (source.startsWith('telegram')) return 1;
  return 0;
};

/**
 * How good a poster is, without downloading it. Nobody publishes dimensions we
 * can trust, so this goes on two things we can see: a URL that still carries a
 * thumbnail preset is worth less than a bare one, and otherwise the more
 * trusted source wins — Concert.ua and Karabas serve full-size posters where a
 * Telegram post serves whatever was pasted into it.
 *
 * Negative means "no image", so an item with a poster always beats one without.
 */
function imageScore(i: Item): number {
  if (!i.image) return -1;
  const thumbnail = /:[\w.-]+$|\/thumbs?\//i.test(i.image);
  return SOURCE_RANK(i.source) + (thumbnail ? -10 : 0);
}

function completeness(i: Item): number {
  let n = 0;
  for (const v of [i.venue, i.address, i.startsAt, i.description, i.priceMin, i.performers]) if (v !== undefined) n++;
  if (i.confidence === 'high') n += 2;
  return n;
}

function merge(a: Item, b: Item): Item {
  const [keep, other] = completeness(a) + SOURCE_RANK(a.source) >= completeness(b) + SOURCE_RANK(b.source) ? [a, b] : [b, a];
  const priceMin = [a.priceMin, b.priceMin].filter((p): p is number => p !== undefined);
  const priceMax = [a.priceMax, b.priceMax].filter((p): p is number => p !== undefined);
  const status = STATUS_RANK[a.status] >= STATUS_RANK[b.status] ? a.status : b.status;
  return {
    ...other,
    ...keep,
    venue: keep.venue ?? other.venue,
    address: keep.address ?? other.address,
    startsAt: keep.startsAt ?? other.startsAt,
    endsAt: keep.endsAt ?? other.endsAt,
    description: keep.description ?? other.description,
    // not `keep.image ?? other.image`: the item with the better facts is not
    // necessarily the one with the better poster
    image: (imageScore(a) >= imageScore(b) ? a : b).image,
    performers: keep.performers ?? other.performers,
    priceMin: priceMin.length ? Math.min(...priceMin) : undefined,
    priceMax: priceMax.length ? Math.max(...priceMax) : undefined,
    currency: keep.currency ?? other.currency,
    free: a.free || b.free ? true : undefined,
    status,
    confidence: a.confidence === 'high' || b.confidence === 'high' ? 'high' : 'low',
    sources: [...new Set([...a.sources, ...b.sources])],
  };
}

/**
 * Collapse the same event seen on several sources.
 *  pass 1 — exact id (kind + title signature + city + local day)
 *  pass 2 — same city/day, fuzzy title overlap (handles "Jerry Heil" vs "Jerry Heil. Jerelo")
 */
export function dedupe(items: Item[], tz = loadConfig().timezone): Item[] {
  const byId = new Map<string, Item>();
  for (const it of items) {
    const existing = byId.get(it.id);
    byId.set(it.id, existing ? merge(existing, it) : it);
  }

  const buckets = new Map<string, Item[]>();
  for (const it of byId.values()) {
    const day = it.startsAt ? localDate(it.startsAt, tz) : 'noday';
    const key = `${it.kind}|${it.city}|${day}`;
    const list = buckets.get(key);
    if (list) list.push(it);
    else buckets.set(key, [it]);
  }

  const out: Item[] = [];
  for (const list of buckets.values()) {
    const merged: Item[] = [];
    for (const it of list) {
      const t = tokens(it.title);
      let hit = -1;
      for (let i = 0; i < merged.length; i++) {
        const cand = merged[i] as Item;
        const sim = jaccard(t, tokens(cand.title));
        const sameSlot =
          it.startsAt && cand.startsAt &&
          localTime(it.startsAt, tz) === localTime(cand.startsAt, tz) &&
          !!it.venue && !!cand.venue &&
          jaccard(tokens(it.venue), tokens(cand.venue)) > 0.5;
        if (sim >= 0.6 || (sameSlot && sim >= 0.34)) {
          hit = i;
          break;
        }
      }
      if (hit >= 0) merged[hit] = merge(merged[hit] as Item, it);
      else merged.push(it);
    }
    out.push(...merged);
  }
  return out;
}

/** Fingerprint of the facts worth re-notifying about: date, status, price. */
export function fingerprint(i: Item): string {
  return [i.startsAt ?? '', i.status, i.priceMin ?? '', i.priceMax ?? ''].join('|');
}
