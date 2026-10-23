#!/usr/bin/env -S npx tsx
/**
 * Scheduled digests, for every subscribed user.
 *
 *   npx tsx scripts/digest.ts --week                 # whoever asked for this hour and this day
 *   npx tsx scripts/digest.ts --weekend --top 5      # Thursday, at each person's own hour
 *   npx tsx scripts/digest.ts --week --dry-run       # print, send nothing, record nothing
 *   npx tsx scripts/digest.ts --weekend --chat 123   # only that user (useful for testing)
 *
 * **This runs every hour**, not once a week. The schedule lives on each user
 * (digest_hour / digest_days, see src/schedule.ts), so a run only
 * covers the people whose hour it currently is and does nothing the other 23
 * times. Each city is still scraped once per run and ranked separately for
 * every user in it, so a hundred Kharkiv subscribers sharing an hour cost one
 * crawl.
 *
 * Flags
 *   --week | --weekend   which window (default: --week)
 *   --top N              items per user (default: digest.week_top / weekend_top)
 *   --all                include things that person has already been sent
 *   --chat ID[,ID]       restrict to these chat ids
 *   --hour N             pretend it is N o'clock (rehearse someone else's slot)
 *   --day N              pretend it is weekday N, 0 = Sunday
 *   --now                ignore everyone's schedule and send to all of them
 *   --dry-run            print instead of sending
 */
import { loadConfig } from '../src/config.ts';
import { REMINDER_HINT } from '../src/render.ts';
import { makeLogger } from '../src/log.ts';
import { parseArgs } from '../src/cli.ts';
import { thisWeekRange, weekendRange } from '../src/request.ts';
import { withStore } from '../src/db.ts';
import { fanout } from '../src/fanout.ts';
import { canSend } from '../src/deliver.ts';
import { localTime, localWeekday, today } from '../src/util.ts';

const args = parseArgs();
const log = makeLogger('digest');
const cfg = loadConfig();
const base = today(cfg.timezone);

const weekend = args.has('weekend');
const window = weekend ? weekendRange(base) : thisWeekRange(base);
const top = args.num('top') ?? (weekend ? cfg.digest.weekend_top : cfg.digest.week_top);

if (!canSend(log, args.has('dry-run') || args.has('queries'))) process.exit(1);

/**
 * Whose hour is it? The real clock, unless --hour/--day override it so an
 * operator can rehearse a slot that is hours away. --now drops the hour filter
 * altogether, which is the old "send to everybody right now" behaviour and the
 * one escape hatch for a backfill.
 */
const clock = new Date();
const now = {
  hour: args.num('hour') ?? Number(localTime(clock, cfg.timezone).slice(0, 2)),
  weekday: args.num('day') ?? localWeekday(clock, cfg.timezone),
};

await withStore(async (store) => {
  const result = await fanout({
    store,
    log,
    optIn: weekend ? 'weekend_digest' : 'weekly_digest',
    digest: args.has('now') ? undefined : weekend ? 'weekend' : 'weekly',
    now,
    window,
    // the header already names the city, so the title does not repeat it
    title: () => (weekend ? '🎉 На вихідних' : '🗓 Цього тижня'),
    top,
    maxPerDay: weekend ? 0 : cfg.digest.max_items_per_day,
    newOnly: !args.has('all'),
    dryRun: args.has('dry-run'),
    maxPages: args.num('pages'),
    onlyChats: args.list('chat'),
    footer: `${REMINDER_HINT} /settings — щоб змінити, що тобі приходить.`,
  });

  process.stdout.write(
    `${weekend ? 'weekend' : 'weekly'} digest: ${result.items} item(s) to ${result.recipients}/${result.users} user(s) ` +
      `across ${result.cities} city/cities (${result.scrapes} scrape(s), ${result.cacheHits} cached)` +
      `${result.notNow ? `; ${result.notNow} not at this hour` : ''}` +
      `${result.notTheirs ? `; ${result.notTheirs} had nothing of their own on` : ''}\n`,
  );
  if (result.failedSources.length) {
    process.stderr.write(`⚠️  sources that failed: ${result.failedSources.join(', ')}\n`);
  }
});

process.exit(process.exitCode ?? 0);
