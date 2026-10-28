#!/usr/bin/env -S npx tsx
/**
 * Source: any site that publishes schema.org Event markup
 *
 *   npx tsx scripts/venues.ts --probe https://teatr.example.ua/afisha
 *   npx tsx scripts/venues.ts --city kharkiv --from 2026-12-08 --to 2026-12-09
 *   npx tsx scripts/venues.ts --city kharkiv --json
 *
 * Theatres, clubs, festivals and promoters on any modern CMS publish the same
 * JSON-LD Event objects the ticket sites do, so none of them needs a scraper of
 * its own. A venue is a url in config.yaml (`cities.<city>.venues`) and nothing
 * else; `--probe` reads one page and prints what it found, which is how you
 * check a url *before* adding it.
 *
 * It fetches exactly the urls it was given, once each: no link following, no
 * ?page=N guessing. That is what keeps a config file full of venues from
 * turning into a crawler, and it is why there is no pager in here. Several
 * venues on one hostname are already serialised by politeFetch's per-host
 * queue at http.delay_ms, so there is no throttle of our own either.
 *
 * Items are filed under `venue:<hostname>`, the way Telegram posts are filed
 * under `telegram:@channel`: the key names the site, not this collector, or
 * twenty venues would reach /stats and the health counters as one row that
 * means nothing.
 */
import type { Item, SourceResult } from '../src/types.ts';
import type { Config, VenuePage } from '../src/schemas.ts';
import { loadConfig } from '../src/config.ts';
import { eventsFromJsonLd } from '../src/jsonld.ts';
import { fromSchemaEvent, priceText } from '../src/normalize.ts';
import { inWindow } from '../src/filter.ts';
import { fetcherFor, runSourceCli, type SourceContext } from '../src/source.ts';
import { politeFetch } from '../src/http.ts';
import { parseArgs } from '../src/cli.ts';
import { makeLogger } from '../src/log.ts';

export const SOURCE = 'venues';

/** Prefix of a per-site item source key: `venue:teatr.example.ua`. */
export const VENUE_PREFIX = 'venue:';

/** The source key for a venue page: its hostname, so two urls on one site share it. */
export function venueSourceKey(url: string): string {
  try {
    return `${VENUE_PREFIX}${new URL(url).hostname.replace(/^www\./, '')}`;
  } catch {
    // the config schema rejects a url this would trip over; a key is still
    // better than a throw if one ever gets through
    return `${VENUE_PREFIX}${url}`;
  }
}

export function isVenueSource(source: string): boolean {
  return source.startsWith(VENUE_PREFIX);
}

/** Every venue key in config.yaml — one row per site for /stats and the doctor. */
export function venueSourceKeys(cfg = loadConfig()): string[] {
  return [...new Set(Object.values(cfg.cities).flatMap((c) => c.venues.map((v) => venueSourceKey(v.url))))];
}

/** The page behind a venue key, for the "go and look" line of a health report. */
export function venueUrlFor(sourceKey: string, cfg = loadConfig()): string | undefined {
  return Object.values(cfg.cities)
    .flatMap((c) => c.venues)
    .find((v) => venueSourceKey(v.url) === sourceKey)?.url;
}

/** What a venue is called in logs: its label if it has one, else its hostname. */
function labelOf(venue: VenuePage): string {
  return venue.label ?? venueSourceKey(venue.url).slice(VENUE_PREFIX.length);
}

export async function collect(ctx: SourceContext, cfg: Config = loadConfig()): Promise<SourceResult> {
  const venues = cfg.cities[ctx.city]?.venues ?? [];
  if (venues.length === 0) {
    ctx.log.info(`${SOURCE}: no venues configured for "${ctx.city}" (config.yaml → cities.${ctx.city}.venues)`);
    return { source: SOURCE, ok: true, items: [], skipped: true };
  }

  const fetchText = fetcherFor(ctx);
  const items: Item[] = [];
  /**
   * One row per hostname, in config order. `ok` means the site answered at
   * least one of its pages: a site whose row is dropped is a site with no
   * health at all, which is the opposite of what the counters are for.
   */
  const parts = new Map<string, { source: string; items: number; ok: boolean }>();
  let failed = 0;
  let firstError: string | undefined;

  for (const venue of venues) {
    const key = venueSourceKey(venue.url);
    const label = labelOf(venue);
    const part = parts.get(key) ?? { source: key, items: 0, ok: false };
    parts.set(key, part);

    try {
      const raw = eventsFromJsonLd(await fetchText(venue.url, { log: ctx.log }));
      let unreadable = 0;
      let kept = 0;
      for (const obj of raw) {
        const item = fromSchemaEvent(obj, {
          city: ctx.city,
          source: key,
          fallbackCategory: venue.category,
          // a venue's own markup about its own show, not somebody's prose about it
          confidence: 'high',
          onReject: () => unreadable++,
        });
        // a venue page lists the whole season; the digest asked for a weekend
        if (!item || !inWindow(item, ctx.query)) continue;
        items.push(item);
        kept++;
      }
      part.items += kept;
      part.ok = true;

      if (raw.length === 0) {
        ctx.log.warn(
          `${SOURCE}: ${label} published no schema.org Events — see for yourself: npx tsx scripts/venues.ts --probe ${venue.url}`,
        );
      } else {
        // the objects we could not read are part of the line: staying quiet
        // about them is how a venue whose markup moved goes on looking healthy
        ctx.log.info(
          `${SOURCE}: ${label}: ${raw.length} Event object(s), ${kept} in window${unreadable ? `, ${unreadable} unreadable` : ''}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed++;
      firstError ??= msg;
      ctx.log.error(`${SOURCE}: ${label} failed: ${msg} — the other venues are unaffected`);
    }
  }

  const result: SourceResult = { source: SOURCE, ok: true, items, fetched: venues.length - failed, parts: [...parts.values()] };
  // one venue down is a hole in the list; every venue down is a broken source
  if (items.length === 0 && failed === venues.length) {
    return { ...result, ok: false, error: firstError ?? 'every venue failed' };
  }
  return result;
}

/* ----------------------------------------------------------------- probing --- */

/**
 * What one page publishes, as lines to print. It takes the html rather than
 * fetching it, so the thirty-second check before adding a venue runs the same
 * code a digest does.
 */
export function probeLines(url: string, html: string, city = loadConfig().default_city): string[] {
  const raw = eventsFromJsonLd(html);
  if (raw.length === 0) {
    return [
      url,
      '',
      'This page publishes no schema.org Event markup, so there is nothing here to read.',
      'Added to config.yaml it would cost one request per run and return nothing.',
      '',
      'Worth trying: the page that lists the shows is often not the landing page',
      '(/afisha, /events, /program, /repertoire), and some sites publish the markup',
      "on each event's own page rather than on the listing.",
    ];
  }

  let unreadable = 0;
  const items = raw
    .map((obj) =>
      fromSchemaEvent(obj, { city, source: venueSourceKey(url), confidence: 'high', onReject: () => unreadable++ }),
    )
    .filter((i): i is Item => i !== null);

  const lines = [
    url,
    '',
    `${raw.length} schema.org Event object(s), ${items.length} usable${unreadable ? `, ${unreadable} unreadable` : ''}:`,
    '',
  ];
  for (const item of items) {
    lines.push(`  ${item.title}`);
    lines.push(`    ${item.startsAt ?? 'no date in the markup'} · ${priceText(item)}${item.venue ? ` · ${item.venue}` : ''}`);
    lines.push(`    ${item.url}`);
  }
  if (items.length > 0) {
    lines.push('', `Looks usable. Add it under cities.${city} in config.yaml:`, '', '    venues:', `      - url: "${url}"`);
    lines.push('        label: "…"          # optional, shown in logs and /stats');
    lines.push('        category: theatre   # optional, used when the markup says nothing');
  }
  return lines;
}

/* --------------------------------------------------------------------- cli --- */

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs();
  if (args.has('probe')) {
    const url = args.get('probe');
    if (!url) {
      process.stdout.write('Usage: npx tsx scripts/venues.ts --probe <url of a page that lists events>\n');
      process.exitCode = 1;
    } else {
      const log = makeLogger(SOURCE);
      try {
        const html = await politeFetch(url, { log });
        process.stdout.write(`${probeLines(url, html).join('\n')}\n`);
        // nothing to add is a non-zero exit, so this is usable in a shell check
        if (eventsFromJsonLd(html).length === 0) process.exitCode = 1;
      } catch (err) {
        process.stdout.write(`${url}\n\nCould not read it: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
      }
    }
  } else {
    await runSourceCli(SOURCE, collect);
  }
}
