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
import { politeFetch } from '../src/http.ts';
import { fromSchemaEvent } from '../src/normalize.ts';
import { inWindow } from '../src/filter.ts';
import { categoryFromSlug } from '../src/categories.ts';
import { runSourceCli, type SourceContext } from '../src/source.ts';

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
  let fetched = 0;

  for (const category of categories) {
    for (let page = 1; page <= maxPages; page++) {
      const url = `${BASE}/${sourceCfg.slug}/${category}${page > 1 ? `?page=${page}` : ''}`;
      const html = await politeFetch(url, { log: ctx.log });
      fetched++;
      const raw = eventsFromJsonLd(html);
      ctx.log.info(`${SOURCE}: ${category} page ${page}: ${raw.length} events`);
      if (raw.length === 0) break;

      for (const obj of raw) {
        const item = fromSchemaEvent(obj, {
          city: ctx.city,
          source: SOURCE,
          fallbackCategory: categoryFromSlug(category) ?? undefined,
        });
        if (item && inWindow(item, ctx.query)) items.push(item);
      }
    }
  }

  return { source: SOURCE, ok: true, items, fetched };
}

if (import.meta.url === `file://${process.argv[1]}`) await runSourceCli(SOURCE, collect);
