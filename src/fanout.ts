/**
 * Scheduled jobs for every user at once.
 *
 * The shape of all of them is the same: work out which cities the opted-in
 * users care about, scrape each city **once** (through the cache), then rank
 * and filter per person and send them their own version. One crawl, N digests.
 */
import type { Item, Query } from './types.ts';
import { DIGEST_PAGE_TTL_SECONDS, jobOf, lastPageKey, pageKey, type OptIn, type Store } from './db.ts';
import type { Logger } from './log.ts';
import { loadConfig } from './config.ts';
import { collectCity, type CollectOptions } from './cache.ts';
import { rank } from './rank.ts';
import { deliver } from './deliver.ts';
import { WALK_HINT } from './render.ts';
import { allUsers, citiesFor, type BotUser } from './users.ts';
import { recordTick, type SourceObservation } from './health.ts';
import { digestDueNow, wantsOnlyMine, type DigestKind } from './schedule.ts';
import { localTime, localWeekday, sleep, today } from './util.ts';

export interface FanoutJob {
  store: Store;
  log: Logger;
  /** Which opt-in flag gates this job. */
  optIn: OptIn;
  /** The window to look at, as local dates. */
  window: { from: string; to: string; label: string };
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
  /** Restrict sources, e.g. ['websearch'] on its own. */
  sources?: string[];
  maxPages?: number;
  dryRun?: boolean;
  /** Passed through to the collectors; the test suite serves fixtures with it. */
  fetchText?: CollectOptions['fetchText'];
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
   * Leave it unset for the jobs that are not a digest (follow alerts) — they
   * keep their fixed cron time and go to everyone opted in.
   * Nothing is lost by that: only what actually went out is recorded as sent,
   * so the next tick picks the same items up.
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
  /** Wanted "only when there is something of mine" and there was not. */
  notTheirs: number;
  /**
   * Sources that went quiet once too often and that the owner was told about
   * on this tick. See src/health.ts — these are the ones that returned nothing
   * while others found events in the same cities, which is the only way an
   * ok-but-empty scraper ever makes a noise.
   */
  deadSources: string[];
  /** Sources that started returning items again on this tick. */
  recoveredSources: string[];
}

export async function fanout(job: FanoutJob): Promise<FanoutResult> {
  const cfg = loadConfig();
  const base = today(cfg.timezone);
  const clock = new Date();
  const now = job.now ?? { hour: Number(localTime(clock, cfg.timezone).slice(0, 2)), weekday: localWeekday(clock, cfg.timezone) };
  const empty = (): FanoutResult => ({
    users: 0, recipients: 0, items: 0, cities: 0, scrapes: 0, cacheHits: 0,
    failedSources: [], failedUsers: 0, notNow: 0, notTheirs: 0,
    deadSources: [], recoveredSources: [],
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
  const due: BotUser[] = [];
  for (const user of users) {
    if (job.digest) {
      if (digestDueNow(user.schedule, job.digest, now)) due.push(user);
      else notNow++;
    } else due.push(user);
  }
  users = due;
  if (users.length === 0) {
    job.log.info(
      `${job.optIn}: nobody at ${String(now.hour).padStart(2, '0')}:00 ` +
        `(${total} opted in; ${notNow} another hour)`,
    );
    return { ...empty(), users: 0, notNow };
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
    users: users.length,
    cities: wanted.size,
  };
  const sentTo = new Set<string>();
  /**
   * This tick's picture, per city and source, for the dead-source detector.
   * Only real scrapes land here — a cache hit asked nobody anything.
   */
  const observed: SourceObservation[] = [];

  for (const [city, cityUsers] of wanted) {
    const collected = await collectCity({
      store: job.store,
      log: job.log.child(city),
      city,
      from: job.window.from,
      to: job.window.to,
      sources: job.sources,
      maxPages: job.maxPages,
      fetchText: job.fetchText,
    });
    if (collected.cached) result.cacheHits++;
    else result.scrapes++;
    for (const f of collected.failedSources) if (!result.failedSources.includes(f)) result.failedSources.push(f);
    for (const s of collected.perSource ?? []) observed.push({ ...s, city });

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

  // the detector only ever reads runs that already happened, so this costs no
  // extra requests to anybody's site
  const health = await recordTick(job.store, observed, { log: job.log, dryRun: job.dryRun });
  result.deadSources = health.dead;
  result.recoveredSources = health.recovered;

  await job.store.prune();
  job.log.info(
    `${job.optIn}: ${result.items} item(s) to ${result.recipients}/${result.users} user(s); ` +
      `${result.scrapes} scrape(s), ${result.cacheHits} cache hit(s)` +
      `${result.failedUsers ? `; ${result.failedUsers} user(s) failed` : ''}` +
      `${result.failedSources.length ? `; failed: ${result.failedSources.join(', ')}` : ''}` +
      `${result.deadSources.length ? `; looks dead: ${result.deadSources.join(', ')}` : ''}` +
      `${result.recoveredSources.length ? `; back: ${result.recoveredSources.join(', ')}` : ''}`,
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
    };

    const ranked = rank(collected, { query, prefs: user.prefs, tz: cfg.timezone });
    // One city, one person, one ranking: the cleanest place there is to record
    // how often this city has nothing of somebody's on. Counted before the
    // 'mine' check below, which is itself a consequence of the same number.
    await job.store.recordRank(ranked.toppedUp, city);
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

    // A digest is one card with a cursor, the same as an answer somebody asked
    // for. Fifteen events as fifteen messages is fifteen notifications in a
    // chat nobody scrolls back through — the problem the cursor already solved
    // for search, and the reason the per-day cap stops applying here: the tail
    // is not a flood any more, it is a stash.
    //
    // Not every scheduled job wants this. A follow alert is one event, which
    // is not something you page through, so it keeps sending as it always did.
    const title = job.title(user, city);
    const paged = Boolean(job.digest);
    const card = paged ? items.slice(0, cfg.bot.cards_at_once) : items;
    const rest = paged ? items.slice(cfg.bot.cards_at_once) : [];
    // one read, so the card knows whether its 🔖 is already on — a digest can
    // land on something they bookmarked out of a search last week
    const saved = paged ? new Set((await job.store.listSaved(user.chatId)).map((i) => i.id)) : new Set<string>();

    const outcome = await deliver({
      title,
      query,
      items: card,
      log: job.log,
      store: job.store,
      chatId: user.chatId,
      dryRun: job.dryRun,
      changeNotes,
      ...(paged
        ? {
            maxPerDay: 0,
            more: rest.length,
            // the header counts the week, not the card in front of it
            found: items.length,
            cardState: (item: Item) => ({ saved: saved.has(item.id), nextCount: rest.length }),
            // and it has to admit that the rest is behind the card, not missing
            footer: [rest.length > 0 ? WALK_HINT : '', job.footer].filter(Boolean).join('\n\n') || undefined,
          }
        : { maxPerDay: job.maxPerDay, footer: job.footer }),
      // so a ❤️ on this card, whenever it lands, is counted against this job
      job: jobOf(job.optIn),
    });

    // Park the tail next to the header it hangs under, in the shape
    // `stepCard` already walks, and point this chat's cursor at it. Nothing
    // here is a second pagination: it is the same stash a search writes, with
    // a day's life instead of an hour's because nobody asked for a digest at
    // the moment it arrived.
    if (paged && rest.length > 0 && outcome.headerMessageId !== undefined && !outcome.chatGone) {
      await job.store.putPage(pageKey(user.chatId, outcome.headerMessageId), {
        header: outcome.headerText,
        title,
        query,
        rest,
        size: cfg.bot.max_results,
        ttlSeconds: DIGEST_PAGE_TTL_SECONDS,
      });
      await job.store.setState(lastPageKey(user.chatId), String(outcome.headerMessageId));
    }
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
