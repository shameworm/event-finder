#!/usr/bin/env -S npx tsx
/**
 * Follow-list watch, for every subscribed user: has anyone they follow
 * announced a show in one of their cities? Runs every 6 hours and alerts
 * immediately — once per event per person, and again only if the date,
 * price or availability changes.
 *
 *   npx tsx scripts/follows.ts
 *   npx tsx scripts/follows.ts --dry-run --days 120
 *   npx tsx scripts/follows.ts --chat 123456789
 *
 * Flags
 *   --days N      how far ahead to look (default 120 — tours go on sale months out)
 *   --all         re-alert even for events already sent to that person
 *   --chat ID     restrict to these chat ids
 *   --dry-run     print instead of sending
 */
import { loadConfig } from '../src/config.ts';
import { REMINDER_HINT } from '../src/render.ts';
import { makeLogger } from '../src/log.ts';
import { parseArgs } from '../src/cli.ts';
import { withStore } from '../src/db.ts';
import { fanout } from '../src/fanout.ts';
import { canSend } from '../src/deliver.ts';
import { matchesFollow } from '../src/rank.ts';
import { addDays, today } from '../src/util.ts';

const args = parseArgs();
const log = makeLogger('follows');
const cfg = loadConfig();
const base = today(cfg.timezone);
const days = args.num('days') ?? 120;

if (!canSend(log, args.has('dry-run') || args.has('queries'))) process.exit(1);

await withStore(async (store) => {
  const result = await fanout({
    store,
    log,
    optIn: 'follow_alerts',
    window: { from: base, to: addDays(base, days), label: `найближчі ${days} дн.` },
    // a follow alert covers the user's own city and everything they watch
    includeWatch: true,
    maxPages: args.num('pages'),
    dryRun: args.has('dry-run'),
    onlyChats: args.list('chat'),
    // the per-person delivery log is the memory here: told once, told again
    // only when something about the show changed
    newOnly: !args.has('all'),
    footer: REMINDER_HINT,
    title: () => '⭐️ Грає хтось, за ким ти стежиш',
    // keep only the shows by people this user follows
    select: (user, ranked) => ranked.filter((item) => user.prefs.follow.some((f) => matchesFollow(item, f))),
  });

  process.stdout.write(
    result.items === 0
      ? 'nothing new from anyone on the follow lists\n'
      : `${result.items} alert(s) to ${result.recipients} user(s)${args.has('dry-run') ? ' (dry run)' : ''}\n`,
  );
  if (result.failedSources.length) process.stderr.write(`⚠️  sources that failed: ${result.failedSources.join(', ')}\n`);
});

process.exit(0);
