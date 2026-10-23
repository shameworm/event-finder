#!/usr/bin/env -S npx tsx
/**
 * Source: Concert.ua
 *
 *   npx tsx scripts/concertua.ts --city kharkiv --from 2026-10-24 --to 2026-10-26
 *   npx tsx scripts/concertua.ts "what's on in Lviv this weekend" --json
 *
 * Concert.ua publishes full schema.org Event objects as JSON-LD on its catalog
 * pages, so we read those instead of guessing at CSS classes.
 * URL shape: https://concert.ua/en/catalog/<city-slug>/<category>?page=N
 */
import type { Item, SourceResult } from '../src/types.ts';
import { loadConfig } from '../src/config.ts';
import { eventsFromJsonLd } from '../src/jsonld.ts';
import { fromSchemaEvent } from '../src/normalize.ts';
import { inWindow } from '../src/filter.ts';
import { categoryFromSlug } from '../src/categories.ts';
import { fetcherFor, pager, runSourceCli, type SourceContext } from '../src/source.ts';

export const SOURCE = 'concert.ua';
const BASE = 'https://concert.ua/en/catalog';

export async function collect(ctx: SourceContext): Promise<SourceResult> {
  const cfg = loadConfig();
  const city = cfg.cities[ctx.city];
  const sourceCfg = city?.concertua;
  if (!sourceCfg?.slug) {
    ctx.log.warn(`${SOURCE}: no concertua.slug for city "${ctx.city}" in config.yaml — skipping`);
    return { source: SOURCE, ok: true, items: [] };
  }

  const categories = sourceCfg.categories?.length ? sourceCfg.categories : ['all-categories'];
  const maxPages = ctx.maxPages ?? cfg.http.max_pages;
  const items: Item[] = [];
  const fetchText = fetcherFor(ctx);
  const pages = pager(ctx.log);

  for (const category of categories) {
    await pages.walk(`${SOURCE}: ${category}`, maxPages, async (page) => {
      const url = `${BASE}/${sourceCfg.slug}/${category}${page > 1 ? `?page=${page}` : ''}`;
      const raw = eventsFromJsonLd(await fetchText(url, { log: ctx.log }));
      ctx.log.info(`${SOURCE}: ${category} page ${page}: ${raw.length} events`);

      for (const obj of raw) {
        const item = fromSchemaEvent(obj, {
          city: ctx.city,
          source: SOURCE,
          fallbackCategory: categoryFromSlug(category) ?? undefined,
        });
        if (item && inWindow(item, ctx.query)) items.push(item);
      }
      return raw.length;
    });
  }

  return pages.result(SOURCE, items);
}

if (import.meta.url === `file://${process.argv[1]}`) await runSourceCli(SOURCE, collect);
