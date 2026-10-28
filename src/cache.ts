/**
 * One scrape per city per window, shared by every user in it.
 *
 * Without this, a hundred people in Kharkiv asking "what's on this weekend"
 * would mean a hundred crawls of Concert.ua. Cached entries hold *unranked*
 * items — ranking and filtering are per user and happen afterwards.
 */
import type { Item, Query, SourceResult } from './types.ts';
import { PreferencesSchema } from './types.ts';
import { loadConfig } from './config.ts';
import { sha1 } from './util.ts';
import { runPipeline, ALL_SOURCE_NAMES, type PipelineOptions } from './pipeline.ts';
import type { Store } from './db.ts';
import type { Logger } from './log.ts';

/** Neutral preferences, so nothing is dropped before the cache is written. */
const NEUTRAL = PreferencesSchema.parse({});

export interface CityWindow {
  city: string;
  from: string;
  to: string;
}

/**
 * `depth` (pages per source) is part of the key on purpose: an interactive
 * two-page search and a six-page digest are *different* scrapes, and sharing
 * one entry let a quick question thin out that city's digest for the whole TTL.
 */
export function cacheKey(w: CityWindow, sources: string[], depth: number): string {
  return sha1('v2', w.city, w.from, w.to, [...sources].sort().join(','), String(depth));
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
  /** Passed through to the collectors; the test suite serves fixtures with it. */
  fetchText?: PipelineOptions['fetchText'];
}

export interface CollectResult {
  items: Item[];
  cached: boolean;
  failedSources: string[];
  /**
   * What each source came back with, for src/health.ts.
   *
   * Absent on a cache hit on purpose: a hit means nobody asked the sites
   * anything, so it is no evidence either way about whether they still work.
   */
  perSource?: { source: string; items: number; ok: boolean; skipped: boolean }[];
}

/**
 * One pipeline run as rows for src/health.ts: every source, plus the per-site
 * rows a collector that reads many sites reported (`parts`, scripts/venues.ts),
 * so a venue that stopped answering is visible as itself rather than as a
 * fraction of one "venues" line.
 */
export function healthRows(results: SourceResult[]): NonNullable<CollectResult['perSource']> {
  return results.flatMap((r) => [
    { source: r.source, items: r.items.length, ok: r.ok, skipped: r.skipped ?? false },
    ...(r.parts ?? []).map((p) => ({ source: p.source, items: p.items, ok: p.ok, skipped: false })),
  ]);
}

/**
 * Scrapes running right now, by cache key. Two users asking the same thing a
 * second apart used to start two identical crawls, because neither had written
 * the cache entry yet; the second one now waits for the first.
 */
const inFlight = new Map<string, Promise<CollectResult>>();

/**
 * Items for one city and window, from the cache when it is warm.
 * The returned items are deduplicated but unranked and unfiltered.
 */
export async function collectCity(opts: CollectOptions): Promise<CollectResult> {
  const cfg = loadConfig();
  const sources = opts.sources?.length ? opts.sources : ALL_SOURCE_NAMES;
  const depth = opts.maxPages ?? cfg.http.max_pages;
  const key = cacheKey(opts, sources, depth);
  const ttl = opts.ttlSeconds ?? cfg.cache.ttl_seconds;

  if (!opts.force && ttl > 0) {
    const hit = await opts.store.getCache(key);
    if (hit) {
      opts.log.info(`cache hit for ${opts.city} ${opts.from}..${opts.to} (${hit.length} items)`);
      return { items: hit, cached: true, failedSources: [] };
    }
  }

  const running = inFlight.get(key);
  if (running) {
    opts.log.info(`joining the scrape already running for ${opts.city} ${opts.from}..${opts.to}`);
    return running;
  }
  const scrape = scrapeCity(opts, sources, depth, key, ttl).finally(() => inFlight.delete(key));
  inFlight.set(key, scrape);
  return scrape;
}

async function scrapeCity(
  opts: CollectOptions,
  sources: string[],
  depth: number,
  key: string,
  ttl: number,
): Promise<CollectResult> {
  const query: Query = {
    cities: [opts.city],
    from: opts.from,
    to: opts.to,
    like: [],
    dislike: [],
    rangeLabel: `${opts.from}..${opts.to}`,
  };

  const result = await runPipeline({
    query,
    prefs: NEUTRAL,
    log: opts.log,
    only: sources,
    // the same depth the key was built from
    maxPages: depth,
    fetchText: opts.fetchText,
    keepDisliked: true,
    keepExpensive: true,
    // one scrape serves everyone in the city; whose taste it fits is decided
    // per person afterwards, so nothing may be filtered out on the way in
    keepOffTaste: true,
  });

  // only cache a run where something worked, so one bad night does not pin an
  // empty result in place for the whole TTL
  if (ttl > 0 && (result.all.length > 0 || result.failedSources.length === 0)) {
    await opts.store.putCache(key, result.all, ttl);
  }
  return {
    items: result.all,
    cached: false,
    failedSources: result.failedSources,
    // pipeline results are one per source for one city, and their items are
    // pre-ranking: what the parser actually pulled off the page
    perSource: healthRows(result.results),
  };
}
