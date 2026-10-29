#!/usr/bin/env -S npx tsx
/**
 * Source: the web, via the agent's own web_search tool.
 *
 * Hermes has no HTTP search API of its own, so this source works as a two-step
 * hand-off, which also keeps it free of extra API keys:
 *
 *   1) ask for the queries           npx tsx scripts/websearch.ts --queries --city kharkiv
 *   2) run them with web_search      (the agent does this)
 *   3) hand the results back         npx tsx scripts/websearch.ts --ingest results.json
 *      (or pipe them:  cat results.json | npx tsx scripts/websearch.ts --ingest -)
 *   4) read what was ingested        npx tsx scripts/websearch.ts --city kharkiv
 *
 * Ingested results are cached in ~/.hermes/data/events-finder/websearch-inbox.json
 * and picked up automatically by scripts/search.ts, the digests and the
 * follow-alert pass (see scripts/follows.ts, which runs the same cycle).
 * Entries older than --ttl days (default 7) are ignored.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import type { Item, SourceResult } from '../src/types.ts';
import { ItemSchema, formatZodError } from '../src/types.ts';
import { WebIngestSchema, type WebResult } from '../src/schemas.ts';
import { cityLocalName, loadConfig, loadPrefs, resolveCity } from '../src/config.ts';
import { WEBSEARCH_INBOX, ensureDirs } from '../src/paths.ts';
import { makeItem, parsePriceText } from '../src/normalize.ts';
import { classify } from '../src/categories.ts';
import { inWindow } from '../src/filter.ts';
import { isoInZone, today } from '../src/util.ts';
import { parseArgs } from '../src/cli.ts';
import { makeLogger } from '../src/log.ts';
import { parseRequest } from '../src/request.ts';
import { runSourceCli, type SourceContext } from '../src/source.ts';
import { findDate, findTime } from './telegram.ts';

export const SOURCE = 'websearch';

/* ----------------------------------------------------------------- inbox --- */

const InboxEntrySchema = z.object({ ingestedAt: z.string(), item: ItemSchema });
const InboxSchema = z.object({
  updatedAt: z.string(),
  entries: z.array(InboxEntrySchema).default([]),
});
type Inbox = z.infer<typeof InboxSchema>;

function readInbox(log = makeLogger(SOURCE)): Inbox {
  if (!existsSync(WEBSEARCH_INBOX)) return { updatedAt: new Date().toISOString(), entries: [] };
  try {
    const parsed = InboxSchema.safeParse(JSON.parse(readFileSync(WEBSEARCH_INBOX, 'utf8')));
    if (parsed.success) return parsed.data;
    log.warn(`inbox is invalid (${formatZodError(parsed.error, 2)}) — starting a fresh one`);
  } catch (err) {
    log.warn(`inbox is unreadable (${err instanceof Error ? err.message : String(err)}) — starting a fresh one`);
  }
  return { updatedAt: new Date().toISOString(), entries: [] };
}

function writeInbox(inbox: Inbox): void {
  ensureDirs();
  writeFileSync(WEBSEARCH_INBOX, JSON.stringify({ ...inbox, updatedAt: new Date().toISOString() }, null, 2));
}

/* --------------------------------------------------------------- queries --- */

/**
 * The search that finds a tour announcement by name.
 *
 * No year in it on purpose: a follow window runs months ahead and can cross
 * into the next one, and anything out of range is dropped on ingest anyway.
 */
export function followQuery(name: string, city: string): string {
  return `${name} ${cityLocalName(city)} концерт тур квитки`;
}

/**
 * The web_search queries worth running for this request.
 *
 * Followed acts come first and keep their slots: a tour announcement is the one
 * thing a person actually wants chased, and it rarely turns up in a generic
 * "афіша" search — it is announced by name, months ahead.
 */
export function buildQueries(
  city: string,
  opts: { from: string; to: string; like: string[]; genres: string[]; follow?: string[] },
): string[] {
  // Ukrainian listings are in Ukrainian, so search in Ukrainian
  const name = cityLocalName(city);
  const year = opts.from.slice(0, 4);
  const uk = (date: string) =>
    new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
  const when = opts.from === opts.to ? uk(opts.from) : `${uk(opts.from)} - ${uk(opts.to)}`;

  const followed = (opts.follow ?? []).slice(0, 4).map((who) => followQuery(who, city));
  const tastes = [...new Set([...opts.like, ...opts.genres])].slice(0, 4);
  const base = [
    `афіша ${name} ${when} події`,
    `${name} куди піти ${when}`,
    `${name} лекція презентація анонс ${year}`,
    `${name} виставка відкриття ${year}`,
  ];
  return [...new Set([...followed, ...base, ...tastes.map((t) => `${t} ${name} ${year} події`)])].slice(
    0,
    8 + followed.length,
  );
}

/* --------------------------------------------------------------- ingest --- */

/** One web result -> Item, using the post parsers for dates and prices. */
export function resultToItem(result: WebResult, opts: { city: string; base: string; tz: string }): Item | null {
  const text = [result.title, result.snippet, result.description, result.date].filter(Boolean).join('\n');

  let startsAt = result.startsAt;
  if (!startsAt) {
    const date = findDate(result.date ?? text, opts.base);
    if (date) startsAt = isoInZone(date, findTime(result.date ?? text) ?? '00:00', opts.tz);
  }
  if (!startsAt) return null; // an event with no date is not actionable

  const price = parsePriceText(result.price ?? text);
  return makeItem({
    title: result.title,
    url: result.url,
    city: result.city ? resolveCity(result.city) ?? opts.city : opts.city,
    source: SOURCE,
    category: result.category ?? classify(text) ?? undefined,
    venue: result.venue,
    address: result.address,
    image: result.image,
    startsAt,
    description: result.snippet ?? result.description,
    priceMin: price.priceMin,
    priceMax: price.priceMax,
    free: price.free,
    status: result.status ?? 'unknown',
    confidence: 'low',
  });
}

function ingest(raw: string, fallback: { city: string }, log = makeLogger(SOURCE)): number {
  const cfg = loadConfig();
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`--ingest expects JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = WebIngestSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`ingest payload is invalid — ${formatZodError(parsed.error)}`);
  }
  const payload = parsed.data;
  const results = Array.isArray(payload) ? payload : payload.results;
  const city = (!Array.isArray(payload) && payload.city ? resolveCity(payload.city) : null) ?? fallback.city;

  const inbox = readInbox(log);
  const base = today(cfg.timezone);
  const now = new Date().toISOString();
  let added = 0;
  for (const result of results) {
    const item = resultToItem(result, { city, base, tz: cfg.timezone });
    if (!item) {
      log.debug(`skipped "${result.title}" — no usable date`);
      continue;
    }
    const existing = inbox.entries.findIndex((e) => e.item.id === item.id);
    if (existing >= 0) inbox.entries[existing] = { ingestedAt: now, item };
    else inbox.entries.push({ ingestedAt: now, item });
    added++;
  }
  writeInbox(inbox);
  log.info(`ingested ${added}/${results.length} results for ${city}`);
  return added;
}

/* --------------------------------------------------------------- collect --- */

export async function collect(ctx: SourceContext): Promise<SourceResult> {
  const args = parseArgs();
  const ttlDays = args.num('ttl') ?? 7;
  const cutoff = Date.now() - ttlDays * 86_400_000;
  const inbox = readInbox(ctx.log);

  const items = inbox.entries
    .filter((e) => Date.parse(e.ingestedAt) >= cutoff)
    .map((e) => e.item)
    .filter((item) => item.city === ctx.city && inWindow(item, ctx.query));

  if (inbox.entries.length === 0) {
    ctx.log.info(`${SOURCE}: inbox empty — run with --queries, search them, then --ingest`);
  }
  return { source: SOURCE, ok: true, items };
}

/* ------------------------------------------------------------------- cli --- */

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs();
  const cfg = loadConfig();
  const log = makeLogger(SOURCE);
  const prefs = loadPrefs((m) => log.warn(m));

  if (args.has('queries')) {
    const query = parseRequest(args.text(), {
      prefs,
      city: args.get('city'),
      from: args.get('from'),
      to: args.get('to'),
    });
    const out = query.cities.map((city) => ({
      city,
      queries: buildQueries(city, {
        from: query.from,
        to: query.to,
        like: query.like,
        genres: prefs.genres,
        follow: prefs.follow,
      }),
    }));
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else if (args.has('ingest')) {
    const file = args.get('ingest');
    const raw = !file || file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
    const city = resolveCity(args.get('city') ?? prefs.home_city) ?? cfg.default_city;
    const added = ingest(raw, { city }, log);
    process.stdout.write(`ingested ${added} result(s) into ${WEBSEARCH_INBOX}\n`);
  } else if (args.has('clear')) {
    writeInbox({ updatedAt: new Date().toISOString(), entries: [] });
    process.stdout.write(`cleared ${WEBSEARCH_INBOX}\n`);
  } else {
    await runSourceCli(SOURCE, collect);
  }
}
