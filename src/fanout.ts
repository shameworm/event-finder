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
import { digestDueNow, inQuietHours, wantsOnlyMine, type DigestKind } from './schedule.ts';
import { localTime, localWeekday, sleep, today } from './util.ts';

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
  /** Only these chat ids (used by --chat for testing). */
  onlyChats?: string[];
  /**
   * Which digest this is. Set it and the job becomes hour-aware: only people
   * whose own `digest_hour` (and, for the weekly one, `digest_day`) is *now*
   * are covered, and 'mine' people only hear from us when their ranked list
   * did not have to be padded.
   *
   * Leave it unset for the jobs that are not a digest (follow alerts, place
   * tips) — they keep their fixed cron time and are only held back by the
   * recipient's quiet hours. Nothing is lost when they are: only what actually
   * went out is recorded as sent, so the next tick picks the same items up.
   */
  digest?: DigestKind;
  /**
   * The local hour/weekday to treat as "now". Defaults to the real clock in
   * `config.timezone`; `scripts/digest.ts --hour/--day` and the tests set it.
   */
  now?: { hour: number; weekday: number };
}

export interface FanoutResult {
  users: number;
  recipients: number;
  items: number;
  cities: number;
  scrapes: number;
  cacheHits: number;
  failedSources: string[];
  /** Users whose own send failed; the rest of the job carried on. */
  failedUsers: number;
  /** Opted in, but not at this hour / not on this day. */
  notNow: number;
  /** Held back by quiet hours (non-digest jobs only). */
  quiet: number;
  /** Wanted "only when there is something of mine" and there was not. */
  notTheirs: number;
}

export async function fanout(job: FanoutJob): Promise<FanoutResult> {
  const cfg = loadConfig();
  const base = today(cfg.timezone);
  const kinds = job.kinds ?? ['event'];
  const clock = new Date();
  const now = job.now ?? { hour: Number(localTime(clock, cfg.timezone).slice(0, 2)), weekday: localWeekday(clock, cfg.timezone) };
  const empty = (): FanoutResult => ({
    users: 0, recipients: 0, items: 0, cities: 0, scrapes: 0, cacheHits: 0,
    failedSources: [], failedUsers: 0, notNow: 0, quiet: 0, notTheirs: 0,
  });

  let users = await allUsers(job.store, job.optIn, job.log);
  if (job.onlyChats?.length) users = users.filter((u) => job.onlyChats!.includes(u.chatId));
  if (users.length === 0) {
    job.log.info(`no users opted in to ${job.optIn}`);
    return empty();
  }

  // The cron now ticks every hour; this is where "every hour" becomes
  // "the handful of people who asked for this hour".
  const total = users.length;
  let notNow = 0;
  let quiet = 0;
  const due: BotUser[] = [];
  for (const user of users) {
    if (job.digest) {
      if (digestDueNow(user.schedule, job.digest, now)) due.push(user);
      else notNow++;
    } else if (inQuietHours(now.hour, user.schedule)) quiet++;
    else due.push(user);
  }
  users = due;
  if (users.length === 0) {
    job.log.info(
      `${job.optIn}: nobody at ${String(now.hour).padStart(2, '0')}:00 ` +
        `(${total} opted in; ${notNow} another hour, ${quiet} in quiet hours)`,
    );
    return { ...empty(), users: 0, notNow, quiet };
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
    ...empty(),
    notNow,
    quiet,
    users: users.length,
    cities: wanted.size,
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
      // one person's failure — a second flood-control hit, a network blip —
      // used to abort the whole job, so everybody after them in the list got
      // nothing at all until the next schedule
      try {
        await sendToOne(user, city, collected.items);
      } catch (err) {
        result.failedUsers++;
        job.log.error(
          `${job.optIn} for chat ${user.chatId} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
        );
      }
    }
  }

  await job.store.prune();
  job.log.info(
    `${job.optIn}: ${result.items} item(s) to ${result.recipients}/${result.users} user(s); ` +
      `${result.scrapes} scrape(s), ${result.cacheHits} cache hit(s)` +
      `${result.failedUsers ? `; ${result.failedUsers} user(s) failed` : ''}` +
      `${result.failedSources.length ? `; failed: ${result.failedSources.join(', ')}` : ''}`,
  );
  return result;

  /** Rank one city's list for one person and send them their own version. */
  async function sendToOne(user: BotUser, city: string, collected: Item[]): Promise<void> {
    const query: Query = {
      cities: [city],
      from: job.window.from,
      to: job.window.to,
      like: [],
      dislike: [],
      rangeLabel: job.window.label,
      kinds,
    };

    const ranked = rank(collected, { query, prefs: user.prefs, tz: cfg.timezone });
    // "only when there is something really mine": a non-zero toppedUp means
    // rank() had to let off-taste items back in to fill the list, i.e. there
    // was not enough of their thing on. Saying nothing is the whole point.
    if (job.digest && wantsOnlyMine(user.schedule) && ranked.toppedUp > 0) {
      job.log.info(`${user.chatId}: nothing of theirs on (topped up ${ranked.toppedUp}) — staying quiet`);
      result.notTheirs++;
      return;
    }
    let items = job.select ? job.select(user, ranked.items) : ranked.items;
    const changeNotes = new Map<string, string>();

    if (job.newOnly ?? true) {
      const { fresh } = await job.store.filterUnsent(user.chatId, items);
      items = fresh.map((f) => f.item);
      for (const f of fresh) if (f.reason !== 'new') changeNotes.set(f.item.id, f.reason);
    }
    if (job.top) items = items.slice(0, job.top);

    if (items.length === 0 && (job.skipEmpty ?? true)) return;

    // deliver() already splits a digest into one message per event, so the
    // job does not need to decide that
    const outcome = await deliver({
      title: job.title(user, city),
      query,
      items,
      log: job.log,
      store: job.store,
      chatId: user.chatId,
      dryRun: job.dryRun,
      maxPerDay: job.maxPerDay,
      footer: job.footer,
      changeNotes,
    });
    const delivered = !outcome.chatGone;
    if (delivered) {
      result.items += items.length;
      if (cfg.bot.send_delay_ms) await sleep(cfg.bot.send_delay_ms);
    }
    if (delivered && !sentTo.has(user.chatId)) {
      sentTo.add(user.chatId);
      result.recipients++;
    }
  }
}
