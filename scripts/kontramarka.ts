#!/usr/bin/env -S npx tsx
/**
 * Source: Kontramarka
 *
 *   npx tsx scripts/kontramarka.ts --city kharkiv --from 2026-10-24 --to 2026-10-26
 *   npx tsx scripts/kontramarka.ts --city odesa --json
 *
 * Kontramarka uses one subdomain per city (kharkiv.kontramarka.ua) and marks up
 * its event cards with schema.org *microdata* rather than JSON-LD, so we read
 * the itemprop attributes with cheerio and hand the result to the same
 * normalizer the JSON-LD sources use.
 * URL shape: https://<city>.kontramarka.ua/uk/<category>?page=N
 */
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { Item, SourceResult } from '../src/types.ts';
import { loadConfig } from '../src/config.ts';
import { fromSchemaEvent } from '../src/normalize.ts';
import { inWindow } from '../src/filter.ts';
import { categoryFromSlug } from '../src/categories.ts';
import { fetcherFor, pager, runSourceCli, type SourceContext } from '../src/source.ts';

export const SOURCE = 'kontramarka';

const DEFAULT_CATEGORIES = ['concert', 'standUp', 'theatre', 'exhibition', 'festival', 'clubs', 'museum'];

/** Resolve a card's href against the page it was found on; null if unusable. */
function absolute(href: string, pageUrl: string): string | null {
  try {
    return new URL(href, pageUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Read one `.cat_item` card's microdata into a plain schema.org-shaped object.
 *
 * `pageUrl` is what the card's href is resolved against: Kontramarka links its
 * cards with site-relative paths, and a bare "/uk/event/123" in a Telegram
 * message is a dead link.
 */
function cardToSchema($: cheerio.CheerioAPI, el: AnyNode, pageUrl: string): Record<string, unknown> | null {
  const card = $(el);
  const name = card.find('[itemprop="name"]').first().text().trim();
  const href = card.find('a[itemprop="url"]').first().attr('href') ?? card.find('a.block-info__title').first().attr('href');
  if (!name || !href) return null;
  const url = absolute(href, pageUrl);
  if (!url) return null;

  const meta = (prop: string): string | undefined => {
    const direct = card.find(`meta[itemprop="${prop}"]`).first().attr('content');
    return direct?.trim() || undefined;
  };

  const loc = card.find('[itemprop="location"]').first();
  const offers = card.find('[itemprop="offers"]').first();
  const offerVal = (prop: string): string | undefined => {
    const el2 = offers.find(`[itemprop="${prop}"]`).first();
    const v = el2.attr('content') ?? el2.text();
    return v?.trim() || undefined;
  };

  return {
    '@type': 'Event',
    name,
    url,
    startDate: meta('startDate'),
    endDate: meta('endDate'),
    description: card.find('.block-info__descr').first().text().trim() || undefined,
    location: {
      '@type': 'Place',
      name: loc.find('meta[itemprop="name"]').first().attr('content') ?? (loc.find('.block-info__loca').first().text().trim() || undefined),
      address: { '@type': 'PostalAddress', streetAddress: loc.find('meta[itemprop="address"]').first().attr('content') },
    },
    offers: {
      '@type': 'AggregateOffer',
      lowPrice: offerVal('lowPrice') ?? offerVal('price'),
      highPrice: offerVal('highPrice'),
      priceCurrency: offers.find('[itemprop="priceCurrency"]').first().attr('content') ?? 'UAH',
      availability: offers.find('[itemprop="availability"]').first().attr('content'),
    },
  };
}

export async function collect(ctx: SourceContext): Promise<SourceResult> {
  const cfg = loadConfig();
  const sourceCfg = cfg.cities[ctx.city]?.kontramarka;
  if (!sourceCfg) {
    ctx.log.warn(`${SOURCE}: no kontramarka section for city "${ctx.city}" in config.yaml — skipping`);
    return { source: SOURCE, ok: true, items: [] };
  }

  const categories = sourceCfg.categories?.length ? sourceCfg.categories : DEFAULT_CATEGORIES;
  const maxPages = ctx.maxPages ?? cfg.http.max_pages;
  // Kyiv lives on the bare domain; every other city has its own subdomain.
  const sub = (sourceCfg.subdomain ?? '').trim();
  const host = sub && sub !== 'www' ? `https://${sub}.kontramarka.ua/uk` : 'https://kontramarka.ua/uk';
  const items: Item[] = [];
  const fetchText = fetcherFor(ctx);
  const pages = pager(ctx.log);

  for (const category of categories) {
    await pages.walk(`${SOURCE}: ${category}`, maxPages, async (page) => {
      const url = `${host}/${category}${page > 1 ? `?page=${page}` : ''}`;
      const $ = cheerio.load(await fetchText(url, { log: ctx.log }));
      const cards = $('.cat_item[itemtype*="schema.org/Event"], [itemtype$="/Event"].cat_item').toArray();
      ctx.log.info(`${SOURCE}: ${category} page ${page}: ${cards.length} events`);

      for (const el of cards) {
        const obj = cardToSchema($, el, url);
        if (!obj) continue;
        const item = fromSchemaEvent(obj, {
          city: ctx.city,
          source: SOURCE,
          fallbackCategory: categoryFromSlug(category) ?? undefined,
        });
        if (item && inWindow(item, ctx.query)) items.push(item);
      }
      return cards.length;
    });
  }

  return pages.result(SOURCE, items);
}

if (import.meta.url === `file://${process.argv[1]}`) await runSourceCli(SOURCE, collect);
