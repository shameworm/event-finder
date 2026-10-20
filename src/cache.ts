/**
 * One scrape per city per window, shared by every user in it.
 *
 * Without this, a hundred people in Kharkiv asking "what's on this weekend"
 * would mean a hundred crawls of Concert.ua. Cached entries hold *unranked*
 * items — ranking and filtering are per user and happen afterwards.
 */
import type { Item, Kind, Query } from './types.ts';
import { PreferencesSchema } from './types.ts';
import { loadConfig } from './config.ts';
import { sha1 } from './util.ts';
import { runPipeline, ALL_SOURCE_NAMES } from './pipeline.ts';
import type { Store } from './db.ts';
import type { Logger } from './log.ts';

/** Neutral preferences, so nothing is dropped before the cache is written. */
const NEUTRAL = PreferencesSchema.parse({});

export interface CityWindow {
  city: string;
  from: string;
  to: string;
  kinds: Kind[];
}

export function cacheKey(w: CityWindow, sources: string[]): string {
  return sha1('v1', w.city, w.from, w.to, w.kinds.join(','), [...sources].sort().join(','));
}

export interface CollectOptions extends CityWindow {
  store: Store;
  log: Logger;
  sources?: string[];
  maxPages?: number;
  /** Seconds a cached scrape stays usable. */
  ttlSeconds?: number;
  /** Ignore the cache and scrape again. */
  force?: boolean;
}

export interface CollectResult {
  items: Item[];
  cached: boolean;
  failedSources: string[];
}

/**
 * Items for one city and window, from the cache when it is warm.
 * The returned items are deduplicated but unranked and unfiltered.
 */
export async function collectCity(opts: CollectOptions): Promise<CollectResult> {
  const cfg = loadConfig();
  const sources = opts.sources?.length ? opts.sources : ALL_SOURCE_NAMES;
  const key = cacheKey(opts, sources);
  const ttl = opts.ttlSeconds ?? cfg.cache.ttl_seconds;

  if (!opts.force && ttl > 0) {
    const hit = await opts.store.getCache(key);
    if (hit) {
      opts.log.info(`cache hit for ${opts.city} ${opts.from}..${opts.to} (${hit.length} items)`);
      return { items: hit, cached: true, failedSources: [] };
    }
  }

  const query: Query = {
    cities: [opts.city],
    from: opts.from,
    to: opts.to,
    like: [],
    dislike: [],
    rangeLabel: `${opts.from}..${opts.to}`,
    kinds: opts.kinds,
  };

  const result = await runPipeline({
    query,
    prefs: NEUTRAL,
    log: opts.log,
    only: sources,
    maxPages: opts.maxPages,
    keepDisliked: true,
    keepExpensive: true,
  });

  // only cache a run where something worked, so one bad night does not pin an
  // empty result in place for the whole TTL
  if (ttl > 0 && (result.all.length > 0 || result.failedSources.length === 0)) {
    await opts.store.putCache(key, result.all, ttl);
  }
  return { items: result.all, cached: false, failedSources: result.failedSources };
}
