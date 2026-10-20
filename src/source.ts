import type { Item, Query, SourceResult } from './types.ts';
import { parseArgs } from './cli.ts';
import { loadConfig, loadPrefs } from './config.ts';
import { makeLogger, type Logger } from './log.ts';
import { parseRequest } from './request.ts';
import { renderDigest, summarize } from './render.ts';
import { dedupe } from './dedupe.ts';

export interface SourceContext {
  query: Query;
  /** The city being collected right now (sources are per-city). */
  city: string;
  log: Logger;
  maxPages?: number;
}

export type Collector = (ctx: SourceContext) => Promise<SourceResult>;

export function emptyResult(source: string, error?: unknown): SourceResult {
  return {
    source,
    ok: error === undefined,
    error: error === undefined ? undefined : error instanceof Error ? error.message : String(error),
    items: [],
  };
}

/** Wrap a collector so a thrown error becomes a failed-but-harmless SourceResult. */
export async function safeCollect(source: string, collect: Collector, ctx: SourceContext): Promise<SourceResult> {
  try {
    const res = await collect(ctx);
    ctx.log.info(`${source} (${ctx.city}): ${res.items.length} in window${res.fetched ? `, ${res.fetched} pages fetched` : ''}`);
    return res;
  } catch (err) {
    const res = emptyResult(source, err);
    ctx.log.error(`${source} (${ctx.city}) failed: ${res.error}`);
    return res;
  }
}

/**
 * Standard CLI for a single source script, so every source can be run and
 * eyeballed on its own:
 *   npx tsx scripts/concertua.ts --city kharkiv --from 2026-10-24 --to 2026-10-26
 */
export async function runSourceCli(source: string, collect: Collector): Promise<void> {
  const args = parseArgs();
  const cfg = loadConfig();
  const prefs = loadPrefs();
  const log = makeLogger(source);
  const query = parseRequest(args.text(), {
    prefs,
    city: args.get('city') ?? args.get('cities'),
    from: args.get('from'),
    to: args.get('to'),
    like: args.list('like'),
    dislike: args.list('dislike'),
    maxPrice: args.num('max-price'),
    base: args.get('base'),
  });

  const all: Item[] = [];
  let failed = 0;
  for (const city of query.cities) {
    const res = await safeCollect(source, collect, { query, city, log, maxPages: args.num('pages') ?? cfg.http.max_pages });
    if (!res.ok) failed++;
    all.push(...res.items);
  }

  const items = dedupe(all);
  if (args.has('json')) {
    process.stdout.write(JSON.stringify(items, null, 2) + '\n');
  } else {
    process.stdout.write(
      renderDigest({
        title: `${source} — ${query.cities.join(', ')}`,
        query,
        items,
        format: 'text',
        maxPerDay: 0,
        numbered: false,
      }) + '\n',
    );
  }
  log.info(`${source}: ${summarize(items)}`);
  if (failed === query.cities.length && query.cities.length > 0) process.exitCode = 1;
}
