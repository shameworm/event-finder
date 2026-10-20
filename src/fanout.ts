/**
 * Scheduled jobs for every user at once.
 *
 * The shape of all of them is the same: work out which cities the opted-in
 * users care about, scrape each city **once** (through the cache), then rank
 * and filter per person and send them their own version. One crawl, N digests.
 */
import type { Item, Kind, Query } from './types.ts';
import type { OptIn, Store } from './db.ts';
import type { Logger } from './log.ts';
import { loadConfig } from './config.ts';
import { collectCity } from './cache.ts';
import { rank } from './rank.ts';
import { deliver } from './deliver.ts';
import { allUsers, citiesFor, type BotUser } from './users.ts';
import { sleep, today } from './util.ts';

export interface FanoutJob {
  store: Store;
  log: Logger;
  /** Which opt-in flag gates this job. */
  optIn: OptIn;
  /** The window to look at, as local dates. */
  window: { from: string; to: string; label: string };
  kinds?: Kind[];
  /** Per-user title for the message. */
  title: (user: BotUser, city: string) => string;
  footer?: string;
  /** Keep at most this many items per user. */
  top?: number;
  maxPerDay?: number;
  /** Hide anything that person has already been sent. Default true. */
  newOnly?: boolean;
  /** Also cover each user's watch cities (used by follow alerts). */
  includeWatch?: boolean;
  /** Restrict sources, e.g. ['websearch'] for places. */
  sources?: string[];
  maxPages?: number;
  dryRun?: boolean;
  /** Say nothing rather than sending an empty digest. Default true. */
  skipEmpty?: boolean;
  /**
   * Last chance to change what a user gets: return the items to send.
   * Used by the follow-alert job to keep only matches.
   */
  select?: (user: BotUser, ranked: Item[]) => Item[];
  /** Send each item as its own message (follow alerts) instead of one digest. */
  oneMessagePerItem?: boolean;
  /** Only these chat ids (used by --chat for testing). */
  onlyChats?: string[];
}

export interface FanoutResult {
  users: number;
  recipients: number;
  items: number;
  cities: number;
  scrapes: number;
  cacheHits: number;
  failedSources: string[];
}

export async function fanout(job: FanoutJob): Promise<FanoutResult> {
  const cfg = loadConfig();
  const base = today(cfg.timezone);
  const kinds = job.kinds ?? ['event'];

  let users = await allUsers(job.store, job.optIn, job.log);
  if (job.onlyChats?.length) users = users.filter((u) => job.onlyChats!.includes(u.chatId));
  if (users.length === 0) {
    job.log.info(`no users opted in to ${job.optIn}`);
    return { users: 0, recipients: 0, items: 0, cities: 0, scrapes: 0, cacheHits: 0, failedSources: [] };
  }

  // which cities does this job need, and who wants each one
  const wanted = new Map<string, BotUser[]>();
  for (const user of users) {
    for (const city of citiesFor(user, base, job.includeWatch)) {
      const list = wanted.get(city);
      if (list) list.push(user);
      else wanted.set(city, [user]);
    }
  }
  job.log.info(`${job.optIn}: ${users.length} user(s) across ${wanted.size} city/cities`);

  const result: FanoutResult = {
    users: users.length,
    recipients: 0,
    items: 0,
    cities: wanted.size,
    scrapes: 0,
    cacheHits: 0,
    failedSources: [],
  };
  const sentTo = new Set<string>();

  for (const [city, cityUsers] of wanted) {
    const collected = await collectCity({
      store: job.store,
      log: job.log.child(city),
      city,
      from: job.window.from,
      to: job.window.to,
      kinds,
      sources: job.sources,
      maxPages: job.maxPages,
    });
    if (collected.cached) result.cacheHits++;
    else result.scrapes++;
    for (const f of collected.failedSources) if (!result.failedSources.includes(f)) result.failedSources.push(f);

    if (collected.items.length === 0) {
      job.log.info(`${city}: nothing collected`);
      continue;
    }

    for (const user of cityUsers) {
      const query: Query = {
        cities: [city],
        from: job.window.from,
        to: job.window.to,
        like: [],
        dislike: [],
        rangeLabel: job.window.label,
        kinds,
      };

      const ranked = rank(collected.items, { query, prefs: user.prefs, tz: cfg.timezone });
      let items = job.select ? job.select(user, ranked.items) : ranked.items;
      const changeNotes = new Map<string, string>();

      if (job.newOnly ?? true) {
        const { fresh } = await job.store.filterUnsent(user.chatId, items);
        items = fresh.map((f) => f.item);
        for (const f of fresh) if (f.reason !== 'new') changeNotes.set(f.item.id, f.reason);
      }
      if (job.top) items = items.slice(0, job.top);

      if (items.length === 0 && (job.skipEmpty ?? true)) continue;

      const batches = job.oneMessagePerItem ? items.map((i) => [i]) : [items];
      let delivered = false;
      for (const batch of batches) {
        const outcome = await deliver({
          title: job.title(user, city),
          query,
          items: batch,
          log: job.log,
          store: job.store,
          chatId: user.chatId,
          dryRun: job.dryRun,
          maxPerDay: job.maxPerDay,
          footer: job.footer,
          changeNotes,
        });
        if (outcome.chatGone) break;
        delivered = true;
        result.items += batch.length;
        if (cfg.bot.send_delay_ms) await sleep(cfg.bot.send_delay_ms);
      }
      if (delivered && !sentTo.has(user.chatId)) {
        sentTo.add(user.chatId);
        result.recipients++;
      }
    }
  }

  await job.store.pruneCache();
  job.log.info(
    `${job.optIn}: ${result.items} item(s) to ${result.recipients}/${result.users} user(s); ` +
      `${result.scrapes} scrape(s), ${result.cacheHits} cache hit(s)` +
      `${result.failedSources.length ? `; failed: ${result.failedSources.join(', ')}` : ''}`,
  );
  return result;
}
