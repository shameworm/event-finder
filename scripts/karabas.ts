#!/usr/bin/env -S npx tsx
/**
 * Source: Karabas
 *
 *   npx tsx scripts/karabas.ts --city kharkiv --from 2026-10-24 --to 2026-10-26
 *   npx tsx scripts/karabas.ts --city kyiv --json
 *
 * Karabas uses one subdomain per city (kharkiv.karabas.com) and publishes
 * schema.org Event JSON-LD, including venue address, price range and
 * availability. The city root paginates with ?page=N and already covers every
 * category, so extra category paths in config.yaml are optional.
 */
import type { Item, SourceResult } from '../src/types.ts';
import { loadConfig } from '../src/config.ts';
import { eventsFromJsonLd } from '../src/jsonld.ts';
import { politeFetch } from '../src/http.ts';
import { fromSchemaEvent } from '../src/normalize.ts';
import { inWindow } from '../src/filter.ts';
import { categoryFromSlug } from '../src/categories.ts';
import { runSourceCli, type SourceContext } from '../src/source.ts';

export const SOURCE = 'karabas';

export async function collect(ctx: SourceContext): Promise<SourceResult> {
  const cfg = loadConfig();
  const sourceCfg = cfg.cities[ctx.city]?.karabas;
  if (!sourceCfg?.subdomain) {
    ctx.log.warn(`${SOURCE}: no karabas.subdomain for city "${ctx.city}" in config.yaml — skipping`);
    return { source: SOURCE, ok: true, items: [] };
  }

  const paths = sourceCfg.paths?.length ? sourceCfg.paths : ['/'];
  const maxPages = ctx.maxPages ?? cfg.http.max_pages;
  const host = `https://${sourceCfg.subdomain}.karabas.com`;
  const items: Item[] = [];
  let fetched = 0;

  for (const path of paths) {
    const clean = `/${path.replace(/^\/|\/$/g, '')}/`.replace('//', '/');
    for (let page = 1; page <= maxPages; page++) {
      const url = `${host}${clean === '//' ? '/' : clean}${page > 1 ? `?page=${page}` : ''}`;
      const html = await politeFetch(url, { log: ctx.log });
      fetched++;
      const raw = eventsFromJsonLd(html);
      ctx.log.info(`${SOURCE}: ${clean} page ${page}: ${raw.length} events`);
      if (raw.length === 0) break;

      const slug = clean.replace(/\//g, '');
      for (const obj of raw) {
        const item = fromSchemaEvent(obj, {
          city: ctx.city,
          source: SOURCE,
          fallbackCategory: (slug && categoryFromSlug(slug)) || undefined,
        });
        if (item && inWindow(item, ctx.query)) items.push(item);
      }
    }
  }

  return { source: SOURCE, ok: true, items, fetched };
}

if (import.meta.url === `file://${process.argv[1]}`) await runSourceCli(SOURCE, collect);
