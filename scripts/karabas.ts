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
 *
 * Its JSON-LD states a start time the Kyiv offset *ahead* of the time its own
 * card shows: a 19:00 concert is marked up as 21:00, a 12:00 children's play as
 * 14:00 — they take the local wall clock, call it UTC and render it back in
 * local time. Sampled across the Kharkiv catalogue on 2026-10-29 it was 14 for
 * 14. Taken at face value the digest tells people to arrive two hours after the
 * show started, and the same gig on Kontramarka reads as a different event,
 * because the deduper compares local times. So the card's own time wins and the
 * markup is the fallback; see `cardTimes` below.
 */
import * as cheerio from 'cheerio';
import type { Item, SourceResult } from '../src/types.ts';
import { loadConfig } from '../src/config.ts';
import { eventsFromJsonLd } from '../src/jsonld.ts';
import { fromSchemaEvent } from '../src/normalize.ts';
import { inWindow } from '../src/filter.ts';
import { categoryFromSlug } from '../src/categories.ts';
import { isoInZone, localDate, localTime } from '../src/util.ts';
import { fetcherFor, pager, runSourceCli, type SourceContext } from '../src/source.ts';

export const SOURCE = 'karabas';

/** One url, comparable: no query, no fragment, no trailing slash. */
const urlKey = (url: string): string => url.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();

/**
 * The date and time each card *displays*, by event url — the time a human
 * reading karabas.com sees, which is the one that is actually true.
 */
export function cardTimes(html: string): Map<string, { date: string; time: string }> {
  const $ = cheerio.load(html);
  const out = new Map<string, { date: string; time: string }>();
  $('.event-item a.main-url').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const shown = $(el)
      .find('.data-time span')
      .map((__, span) => $(span).text().trim())
      .get();
    const date = shown.find((v) => /^\d{2}\/\d{2}\/\d{4}$/.test(v));
    const time = shown.find((v) => /^\d{1,2}:\d{2}$/.test(v));
    if (!date || !time) return;
    const [d, m, y] = date.split('/');
    out.set(urlKey(href), { date: `${y}-${m}-${d}`, time });
  });
  return out;
}

/**
 * The event, with its start (and end, by the same shift) replaced by the time
 * its card shows. Returns the object unchanged when there is no card for it or
 * the two already agree — so the day Karabas fixes its markup, this stops
 * doing anything rather than starting to do harm.
 */
export function withShownTime(
  obj: Record<string, unknown>,
  shown: Map<string, { date: string; time: string }>,
  tz: string,
): Record<string, unknown> {
  const url = [obj['url'], obj['@id']].find((v): v is string => typeof v === 'string');
  const card = url ? shown.get(urlKey(url)) : undefined;
  const published = typeof obj['startDate'] === 'string' ? obj['startDate'] : undefined;
  if (!card || !published) return obj;

  const start = isoInZone(card.date, card.time, tz);
  const delta = Date.parse(start) - Date.parse(published);
  if (!Number.isFinite(delta) || delta === 0) return obj;

  const publishedEnd = typeof obj['endDate'] === 'string' ? obj['endDate'] : undefined;
  const endMs = publishedEnd ? Date.parse(publishedEnd) + delta : NaN;
  if (!Number.isFinite(endMs)) return { ...obj, startDate: start };
  const end = new Date(endMs).toISOString();
  return { ...obj, startDate: start, endDate: isoInZone(localDate(end, tz), localTime(end, tz), tz) };
}

export async function collect(ctx: SourceContext): Promise<SourceResult> {
  const cfg = loadConfig();
  const sourceCfg = cfg.cities[ctx.city]?.karabas;
  if (!sourceCfg?.subdomain) {
    ctx.log.warn(`${SOURCE}: no karabas.subdomain for city "${ctx.city}" in config.yaml — skipping`);
    return { source: SOURCE, ok: true, items: [], skipped: true };
  }

  const paths = sourceCfg.paths?.length ? sourceCfg.paths : ['/'];
  const maxPages = ctx.maxPages ?? cfg.http.max_pages;
  const host = `https://${sourceCfg.subdomain}.karabas.com`;
  const items: Item[] = [];
  const fetchText = fetcherFor(ctx);
  const pages = pager(ctx.log);

  for (const path of paths) {
    const clean = `/${path.replace(/^\/|\/$/g, '')}/`.replace('//', '/');
    const slug = clean.replace(/\//g, '');
    await pages.walk(`${SOURCE}: ${clean}`, maxPages, async (page) => {
      const url = `${host}${clean === '//' ? '/' : clean}${page > 1 ? `?page=${page}` : ''}`;
      const html = await fetchText(url, { log: ctx.log });
      const raw = eventsFromJsonLd(html);
      const shown = cardTimes(html);
      let corrected = 0;
      ctx.log.info(`${SOURCE}: ${clean} page ${page}: ${raw.length} events`);

      for (const published of raw) {
        const obj = withShownTime(published, shown, cfg.timezone);
        if (obj !== published) corrected++;
        const item = fromSchemaEvent(obj, {
          city: ctx.city,
          source: SOURCE,
          fallbackCategory: (slug && categoryFromSlug(slug)) || undefined,
        });
        if (item && inWindow(item, ctx.query)) items.push(item);
      }
      // the count, not just the fix: when this reaches 0 their markup is right
      // again and this correction can go
      if (corrected) {
        ctx.log.warn(
          `${SOURCE}: corrected ${corrected} start time(s) on ${clean} page ${page} to the time the card shows ` +
            `(their JSON-LD states it the ${cfg.timezone} offset ahead)`,
        );
      }
      return raw.length;
    });
  }

  return pages.result(SOURCE, items);
}

if (import.meta.url === `file://${process.argv[1]}`) await runSourceCli(SOURCE, collect);
