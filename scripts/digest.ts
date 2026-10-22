#!/usr/bin/env -S npx tsx
/**
 * Scheduled digests, for every subscribed user.
 *
 *   npx tsx scripts/digest.ts --week                 # Monday 09:00 — "this week in <your city>"
 *   npx tsx scripts/digest.ts --weekend --top 5      # Thursday 18:00 — weekend picks
 *   npx tsx scripts/digest.ts --week --dry-run       # print, send nothing, record nothing
 *   npx tsx scripts/digest.ts --weekend --chat 123   # only that user (useful for testing)
 *
 * Each city is scraped once and the result is ranked separately for every user
 * in it, so a hundred subscribers in Kharkiv cost one crawl.
 *
 * Flags
 *   --week | --weekend   which window (default: --week)
 *   --top N              items per user (default: digest.week_top / weekend_top)
 *   --all                include things that person has already been sent
 *   --chat ID[,ID]       restrict to these chat ids
 *   --dry-run            print instead of sending
 */
import { loadConfig } from '../src/config.ts';
import * as copy from '../src/copy.ts';
import { makeLogger } from '../src/log.ts';
import { parseArgs } from '../src/cli.ts';
import { thisWeekRange, weekendRange } from '../src/request.ts';
import { withStore } from '../src/db.ts';
import { fanout } from '../src/fanout.ts';
import { canSend } from '../src/deliver.ts';
import { today } from '../src/util.ts';

const args = parseArgs();
const log = makeLogger('digest');
const cfg = loadConfig();
const base = today(cfg.timezone);

const weekend = args.has('weekend');
const window = weekend ? weekendRange(base) : thisWeekRange(base);
const top = args.num('top') ?? (weekend ? cfg.digest.weekend_top : cfg.digest.week_top);

if (!canSend(log, args.has('dry-run') || args.has('queries'))) process.exit(1);

await withStore(async (store) => {
  const result = await fanout({
    store,
    log,
    optIn: weekend ? 'weekend_digest' : 'weekly_digest',
    window,
    // the header already names the city, so the title does not repeat it
    title: () => (weekend ? copy.TITLE_WEEKEND : copy.TITLE_WEEK),
    top,
    maxPerDay: weekend ? 0 : cfg.digest.max_items_per_day,
    newOnly: !args.has('all'),
    dryRun: args.has('dry-run'),
    maxPages: args.num('pages'),
    onlyChats: args.list('chat'),
    footer: copy.DIGEST_FOOTER,
  });

  process.stdout.write(
    `${weekend ? 'weekend' : 'weekly'} digest: ${result.items} item(s) to ${result.recipients}/${result.users} user(s) ` +
      `across ${result.cities} city/cities (${result.scrapes} scrape(s), ${result.cacheHits} cached)\n`,
  );
  if (result.failedSources.length) {
    process.stderr.write(`⚠️  sources that failed: ${result.failedSources.join(', ')}\n`);
  }
});

process.exit(0);
