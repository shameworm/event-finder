/**
 * Runs every configured source for a query, then normalizes → dedupes → ranks.
 *
 * The collectors live in scripts/<source>.ts (one file per source, runnable on
 * its own); this module just orchestrates them. A source that throws is logged
 * and skipped — a dead site must never take the digest down.
 */
import type { Item, Preferences, Query, SourceResult } from './types.ts';
import { loadConfig } from './config.ts';
import { dedupe } from './dedupe.ts';
import { rank, type Ranked } from './rank.ts';
import { wantedKind } from './filter.ts';
import { safeCollect, type Collector, type SourceContext } from './source.ts';
import type { Logger } from './log.ts';

import { collect as collectConcertUa, SOURCE as CONCERTUA } from '../scripts/concertua.ts';
import { collect as collectKarabas, SOURCE as KARABAS } from '../scripts/karabas.ts';
import { collect as collectKontramarka, SOURCE as KONTRAMARKA } from '../scripts/kontramarka.ts';
import { collect as collectTelegram, SOURCE as TELEGRAM } from '../scripts/telegram.ts';
import { collect as collectWebsearch, SOURCE as WEBSEARCH } from '../scripts/websearch.ts';

export const SOURCES: Record<string, Collector> = {
  [CONCERTUA]: collectConcertUa,
  [KARABAS]: collectKarabas,
  [KONTRAMARKA]: collectKontramarka,
  [TELEGRAM]: collectTelegram,
  [WEBSEARCH]: collectWebsearch,
};

export const ALL_SOURCE_NAMES = Object.keys(SOURCES);

export interface PipelineOptions {
  query: Query;
  prefs: Preferences;
  log: Logger;
  /** Subset of source names; defaults to all of them. */
  only?: string[];
  skip?: string[];
  maxPages?: number;
  /** Passed to every collector; the test suite uses it to serve fixtures. */
  fetchText?: SourceContext['fetchText'];
  keepDisliked?: boolean;
  keepExpensive?: boolean;
  keepOffTaste?: boolean;
}

export interface PipelineResult extends Ranked {
  /** Everything collected, after dedupe but before ranking. */
  all: Item[];
  results: SourceResult[];
  failedSources: string[];
}

export async function runPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const cfg = loadConfig();
  const names = (opts.only?.length ? opts.only : ALL_SOURCE_NAMES).filter((n) => !opts.skip?.includes(n));

  const jobs: Promise<SourceResult>[] = [];
  for (const city of opts.query.cities) {
    for (const name of names) {
      const collector = SOURCES[name];
      if (!collector) {
        opts.log.warn(`unknown source "${name}" — known: ${ALL_SOURCE_NAMES.join(', ')}`);
        continue;
      }
      const ctx: SourceContext = {
        query: opts.query,
        city,
        log: opts.log.child(name),
        maxPages: opts.maxPages ?? cfg.http.max_pages,
        fetchText: opts.fetchText,
      };
      jobs.push(safeCollect(name, collector, ctx));
    }
  }

  const settled = await Promise.allSettled(jobs);
  const results: SourceResult[] = settled.map((s) =>
    s.status === 'fulfilled' ? s.value : { source: 'unknown', ok: false, error: String(s.reason), items: [] },
  );

  const collected = results.flatMap((r) => r.items).filter((i) => wantedKind(i, opts.query));
  const all = dedupe(collected, cfg.timezone);
  const ranked = rank(all, {
    query: opts.query,
    prefs: opts.prefs,
    keepDisliked: opts.keepDisliked,
    keepExpensive: opts.keepExpensive,
    keepOffTaste: opts.keepOffTaste,
    tz: cfg.timezone,
  });

  const failedSources = [...new Set(results.filter((r) => !r.ok).map((r) => r.source))];
  opts.log.info(
    `pipeline: ${collected.length} raw → ${all.length} unique → ${ranked.items.length} kept` +
      `${ranked.dropped.length ? `, ${ranked.dropped.length} filtered out` : ''}` +
      `${failedSources.length ? `; failed: ${failedSources.join(', ')}` : ''}`,
  );

  return { ...ranked, all, results, failedSources };
}
