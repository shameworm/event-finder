/**
 * "Still ok, just empty" — the one failure mode nothing else notices.
 *
 * A scraper that stops matching its site does not throw. politeFetch gets its
 * 200, cheerio matches nothing, and the collector returns
 * `{ ok: true, items: [] }`. `failedSources` never sees it, the digests simply
 * get thinner, and the only way to find out is to remember to run the doctor.
 *
 * So we count instead. Every fan-out tick hands each source's per-city answer
 * to `recordTick`, which keeps one counter per source in the `state` table —
 * so it survives a restart — and tells the owner when a source has returned
 * nothing for `DEAD_AFTER_TICKS` ticks in a row *while other sources found
 * events in the same cities*. That last clause is the whole trick: without it,
 * a quiet Tuesday in Dnipro looks exactly like a broken parser.
 *
 * Nothing here fetches anything. It only ever reads runs that were going to
 * happen anyway, which is the point — probing a page to check its health is
 * one more request to a site we are trying to be polite to.
 *
 * The blind spot is deliberate: a tick where *every* source came back empty is
 * recorded as no evidence, so a break on our side of the line — a normalizer
 * or a date filter that rejects everything — stays invisible here. That half is
 * the fixture contract tests' job (tests/run.ts → "fixture contracts"), which
 * fail the moment a parser stops pulling a title, a date and a price out of a
 * committed page. One catches a site moving, the other catches us.
 */
import { z } from 'zod';
import type { Store } from './db.ts';
import type { Logger } from './log.ts';
import { ownerChatId } from './users.ts';
import { sendMessage } from './telegram-api.ts';
import { SOURCE as TELEGRAM } from '../scripts/telegram.ts';
import { SOURCE as WEBSEARCH } from '../scripts/websearch.ts';

/**
 * The two sources whose emptiness means something other than "the parser
 * broke", and so get their own wording. Re-exported so callers compare against
 * the same names rather than their own string literals.
 */
export { TELEGRAM as TELEGRAM_SOURCE, WEBSEARCH as WEBSEARCH_SOURCE };

/**
 * Ticks of silence before the owner hears about it.
 *
 * `cache.ttl_seconds` is 1800 and the cron ticks hourly, so a fan-out tick is
 * a real scrape and three of them is about three hours. Long enough to ride
 * out one odd afternoon, short enough that nobody loses a weekend digest to a
 * source that died on Friday morning.
 */
export const DEAD_AFTER_TICKS = 3;

/**
 * Where one source's counter lives in the key/value `state` table, so it can be
 * read by hand: `SELECT * FROM state WHERE key LIKE 'health:%'`.
 */
const keyFor = (source: string) => `health:${source}`;

export const SourceHealthSchema = z.object({
  source: z.string(),
  /** Consecutive ticks this source returned nothing while others returned something. */
  emptyTicks: z.number().int().nonnegative().default(0),
  /** When it last returned at least one item, ISO — absent if it never has. */
  lastItemsAt: z.string().optional(),
  /** How many it returned that time. */
  lastItemsCount: z.number().int().nonnegative().default(0),
  /** True between the "looks dead" message and the "it is back" one. */
  alerted: z.boolean().default(false),
  /** The last tick this source was actually asked anything, ISO. */
  lastAskedAt: z.string().optional(),
});
export type SourceHealth = z.infer<typeof SourceHealthSchema>;

/** What one source came back with for one city, in one fan-out tick. */
export interface SourceObservation {
  source: string;
  city: string;
  /** Items collected, before per-user ranking and filtering. */
  items: number;
  ok: boolean;
  /** Not configured for this city, so it was never really asked. */
  skipped?: boolean;
}

export type TickVerdict =
  /** Returned something somewhere. */
  | 'items'
  /** Returned nothing, where other sources did find events. */
  | 'empty'
  /** Returned nothing, and so did everyone else — no evidence either way. */
  | 'quiet';

export interface TickOutcome {
  verdict: TickVerdict;
  /** Items this source returned across every city in the tick. */
  items: number;
  /** The cities it was asked about. */
  cities: string[];
  /** For an 'empty' verdict: the cities where somebody else did find events. */
  liveCities: string[];
}

/**
 * One tick's picture, per source.
 *
 * Sources that threw are left out: a thrown error is already loud, it lands in
 * `failedSources` and the pipeline log. So are sources with no section for the
 * city in config.yaml — a collector that returns `{ ok: true, items: [] }`
 * because there is nothing to scrape was never asked a question.
 */
export function evaluateTick(observations: SourceObservation[]): Map<string, TickOutcome> {
  const asked = observations.filter((o) => o.ok && !o.skipped);
  const out = new Map<string, TickOutcome>();

  for (const o of asked) {
    const seen = out.get(o.source);
    if (seen) {
      seen.items += o.items;
      if (!seen.cities.includes(o.city)) seen.cities.push(o.city);
    } else {
      out.set(o.source, { verdict: 'quiet', items: o.items, cities: [o.city], liveCities: [] });
    }
  }

  for (const [source, outcome] of out) {
    if (outcome.items > 0) {
      outcome.verdict = 'items';
      continue;
    }
    outcome.liveCities = outcome.cities.filter((city) =>
      asked.some((o) => o.city === city && o.source !== source && o.items > 0),
    );
    outcome.verdict = outcome.liveCities.length > 0 ? 'empty' : 'quiet';
  }
  return out;
}

/* ---------------------------------------------------------------- storage --- */

const fresh = (source: string): SourceHealth => SourceHealthSchema.parse({ source });

export async function readHealth(store: Store, source: string): Promise<SourceHealth> {
  const raw = await store.getState(keyFor(source));
  if (!raw) return fresh(source);
  try {
    const parsed = SourceHealthSchema.safeParse(JSON.parse(raw));
    // a counter we cannot read is a counter starting over; it is bookkeeping,
    // and losing it costs at most three more quiet ticks
    if (parsed.success) return { ...parsed.data, source };
  } catch {
    /* not JSON — same answer */
  }
  return fresh(source);
}

/** One row per known source, whether or not it has ever been recorded. */
export async function readAllHealth(store: Store, known: string[]): Promise<SourceHealth[]> {
  return Promise.all(known.map((source) => readHealth(store, source)));
}

/* ----------------------------------------------------------------- saying --- */

/** The script that runs one source on its own, for the "go and look" line. */
const SCRIPT: Record<string, string> = {
  'concert.ua': 'concertua',
  karabas: 'karabas',
  kontramarka: 'kontramarka',
};

/**
 * What to actually do about a source that has gone quiet. Shared by the alert
 * and by `scripts/doctor.ts`, so the two never drift apart.
 */
export function nextStep(source: string, city = '<city>'): string {
  if (source === WEBSEARCH) {
    return 'npx tsx scripts/places.ts --queries, run the searches, then npx tsx scripts/websearch.ts --ingest';
  }
  if (source === TELEGRAM) return 'npx tsx scripts/tg-login.ts';
  const script = SCRIPT[source];
  return script ? `npx tsx scripts/${script}.ts --city ${city} --json` : 'npx tsx scripts/doctor.ts --network';
}

function deadMessage(source: string, outcome: TickOutcome, after: SourceHealth, deadAfter: number): string {
  const where = outcome.liveCities.join(', ');
  const last = after.lastItemsAt
    ? `Last returned items: ${after.lastItemsAt} (${after.lastItemsCount}).`
    : 'It has never returned an item.';

  // websearch is fed by a manual hand-off, not by a crawl: places.ts --queries
  // → somebody runs the searches → websearch.ts --ingest. Nothing is broken
  // when it is empty; the inbox is just stale, and "fix the parser" would send
  // the operator looking in the wrong place entirely.
  if (source === WEBSEARCH) {
    return [
      `ℹ️ websearch has had nothing for ${deadAfter} consecutive fan-out ticks (${where}).`,
      '',
      'websearch is not a scraper — it only hands back what was ingested by hand, so',
      'this means nobody has ingested search results lately.',
      '',
      `Top it up: ${nextStep(source)}`,
    ].join('\n');
  }

  // telegram reads channels through the operator's own GramJS session, and
  // readChannel swallows a per-channel failure so the source still reports ok.
  // An expired session is the usual cause and a different fix.
  if (source === TELEGRAM) {
    return [
      `⚠️ telegram has had nothing for ${deadAfter} consecutive fan-out ticks, while other`,
      `sources found events in the same cities (${where}).`,
      '',
      'Channel reading runs on your own GramJS session, and a failed channel read is',
      'swallowed per channel, so the source still reports ok. An expired session is the',
      'usual cause — a different problem from a parser that stopped matching.',
      '',
      last,
      '',
      `Sign in again: ${nextStep(source)}`,
      'Then check: npx tsx scripts/doctor.ts',
    ].join('\n');
  }

  return [
    `⚠️ Source looks dead: ${source}`,
    '',
    `Zero items on ${deadAfter} consecutive fan-out ticks, while other sources did find`,
    `events in the same cities (${where}). Nothing threw: the site answered and the`,
    'parser matched nothing, which usually means the markup moved.',
    '',
    last,
    '',
    `Go and look: ${nextStep(source, outcome.liveCities[0])}`,
  ].join('\n');
}

function recoveredMessage(source: string, outcome: TickOutcome): string {
  return `✅ ${source} is returning items again: ${outcome.items} across ${outcome.cities.join(', ')}.`;
}

/** Where an alert goes when the caller did not say: the operator's own chat. */
async function tellTheOwner(text: string, log?: Logger, dryRun?: boolean): Promise<void> {
  const chatId = ownerChatId();
  if (!chatId) {
    log?.warn(`TELEGRAM_CHAT_ID is not set — nobody was told:\n${text}`);
    return;
  }
  await sendMessage(text, { chatId, log, dryRun });
}

/* ------------------------------------------------------------- one tick in --- */

export interface RecordTickOptions {
  log?: Logger;
  /** Where an alert goes. Defaults to the owner's Telegram chat. */
  notify?: (text: string) => Promise<void>;
  deadAfter?: number;
  /** The clock, for the tests. */
  now?: Date;
  /** Print the alert instead of sending it. */
  dryRun?: boolean;
}

export interface TickReport {
  /** Sources the owner was told about this tick. */
  dead: string[];
  /** Sources that came back this tick. */
  recovered: string[];
  /** Exactly what went out, in order. */
  messages: string[];
}

/**
 * Fold one tick into the counters, and say something if a source crossed the
 * line — once per outage, and once again when it comes back.
 *
 * The message goes out *before* the flag that stops it repeating is written,
 * so a Telegram hiccup means the owner is told next tick instead of never.
 */
export async function recordTick(
  store: Store,
  observations: SourceObservation[],
  opts: RecordTickOptions = {},
): Promise<TickReport> {
  const deadAfter = opts.deadAfter ?? DEAD_AFTER_TICKS;
  const now = (opts.now ?? new Date()).toISOString();
  const notify = opts.notify ?? ((text: string) => tellTheOwner(text, opts.log, opts.dryRun));
  const report: TickReport = { dead: [], recovered: [], messages: [] };

  const tell = async (text: string): Promise<boolean> => {
    try {
      await notify(text);
      report.messages.push(text);
      return true;
    } catch (err) {
      opts.log?.error(`could not tell the owner about a source: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };

  for (const [source, outcome] of evaluateTick(observations)) {
    const before = await readHealth(store, source);
    const after: SourceHealth = { ...before, lastAskedAt: now };

    if (outcome.verdict === 'items') {
      after.emptyTicks = 0;
      after.lastItemsAt = now;
      after.lastItemsCount = outcome.items;
      if (before.alerted && (await tell(recoveredMessage(source, outcome)))) {
        after.alerted = false;
        report.recovered.push(source);
      }
    } else if (outcome.verdict === 'empty') {
      after.emptyTicks = before.emptyTicks + 1;
      if (after.emptyTicks >= deadAfter && !before.alerted) {
        if (await tell(deadMessage(source, outcome, after, deadAfter))) {
          after.alerted = true;
          report.dead.push(source);
        }
      }
    }
    // 'quiet' leaves the counter alone: a night when nothing was on anywhere
    // is no evidence about this source either way

    await store.setState(keyFor(source), JSON.stringify(after));
  }

  if (report.messages.length) {
    opts.log?.warn(
      `source health: ${report.dead.length ? `dead: ${report.dead.join(', ')}` : ''}` +
        `${report.dead.length && report.recovered.length ? '; ' : ''}` +
        `${report.recovered.length ? `back: ${report.recovered.join(', ')}` : ''}`,
    );
  }
  return report;
}

/* --------------------------------------------------------------- readable --- */

function agoLabel(iso: string, now: Date): string {
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms)) return 'an unknown time';
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** One line per source, for /stats and for the doctor. English: operator output. */
export function describeHealth(rows: SourceHealth[], now = new Date()): string[] {
  return rows.map((h) => {
    const when = h.lastItemsAt ? `${agoLabel(h.lastItemsAt, now)} ago` : 'never';
    const empty = h.emptyTicks > 0 ? ` — ${h.emptyTicks} empty tick(s)${h.alerted ? ', owner told' : ''}` : '';
    return `${h.source}: ${h.lastItemsCount} item(s), last ${when}${empty}`;
  });
}
