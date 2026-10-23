#!/usr/bin/env -S npx tsx
/**
 * Follow-list watch, for every subscribed user: has anyone they follow
 * announced a show in one of their cities? Runs every 6 hours and alerts
 * immediately — once per event per person, and again only if the date,
 * price or availability changes.
 *
 *   npx tsx scripts/follows.ts --queries          # 1) who to search for, per city
 *   npx tsx scripts/websearch.ts --ingest results.json --city kharkiv
 *   npx tsx scripts/follows.ts                     # 2) alert from everything known
 *   npx tsx scripts/follows.ts --dry-run --days 120
 *   npx tsx scripts/follows.ts --chat 123456789
 *
 * Ticket sites only list what is already on sale in that city, so waiting for a
 * followed act to turn up in the city-wide scrape is not enough: tours are
 * announced by name. `--queries` prints the name searches for every subscriber,
 * grouped by city and deduplicated, so one round of web_search serves everyone;
 * the agent hands the results back through `scripts/websearch.ts --ingest` and
 * they reach the next alert pass through the shared inbox.
 *
 * Flags
 *   --days N      how far ahead to look (default 120 — tours go on sale months out)
 *   --all         re-alert even for events already sent to that person
 *   --chat ID     restrict to these chat ids
 *   --queries     print the web searches to run, then stop
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
import { allUsers, citiesFor } from '../src/users.ts';
import { followQuery } from './websearch.ts';
import { addDays, today } from '../src/util.ts';

const args = parseArgs();
const log = makeLogger('follows');
const cfg = loadConfig();
const base = today(cfg.timezone);
const days = args.num('days') ?? 120;

if (!canSend(log, args.has('dry-run') || args.has('queries'))) process.exit(1);

await withStore(async (store) => {
  if (args.has('queries')) {
    let users = await allUsers(store, 'follow_alerts', log);
    if (args.list('chat').length) users = users.filter((u) => args.list('chat').includes(u.chatId));
    // city -> every name watched by someone who would be told about that city
    const cities = new Map<string, string[]>();
    for (const user of users) {
      for (const city of citiesFor(user, base, true)) {
        cities.set(city, [...new Set([...(cities.get(city) ?? []), ...user.prefs.follow])]);
      }
    }
    const out = [...cities.entries()]
      .filter(([, follow]) => follow.length > 0)
      .map(([city, follow]) => ({
        city,
        kind: 'event' as const,
        queries: follow.map((name) => followQuery(name, city)),
      }));
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }

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

process.exit(process.exitCode ?? 0);
