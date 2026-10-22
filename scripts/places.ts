#!/usr/bin/env -S npx tsx
/**
 * Weekly place suggestions for every subscribed user: 2–3 new cafés, bars with
 * live music, galleries or otherwise unusual spots that fit their interests.
 *
 *   npx tsx scripts/places.ts --queries            # 1) what to search for, per city
 *   npx tsx scripts/websearch.ts --ingest results.json --kind place --city kharkiv
 *   npx tsx scripts/places.ts                      # 2) suggest from what was ingested
 *   npx tsx scripts/places.ts --dry-run --top 3
 *
 * Places come from web search, because they are exactly what ticket sites do
 * not list. The agent runs the queries with its own web_search tool and hands
 * the results back through scripts/websearch.ts --ingest.
 *
 * `--queries` prints one entry per city that has subscribed users, so a single
 * round of searching serves everybody.
 */
import { loadConfig } from '../src/config.ts';
import * as copy from '../src/copy.ts';
import { makeLogger } from '../src/log.ts';
import { parseArgs } from '../src/cli.ts';
import { withStore } from '../src/db.ts';
import { fanout } from '../src/fanout.ts';
import { canSend } from '../src/deliver.ts';
import { allUsers, citiesFor } from '../src/users.ts';
import { buildQueries } from './websearch.ts';
import { addDays, today } from '../src/util.ts';

const args = parseArgs();
const log = makeLogger('places');
const cfg = loadConfig();
const base = today(cfg.timezone);
const window = { from: base, to: addDays(base, 30), label: copy.RANGE.openNow };

if (!canSend(log, args.has('dry-run') || args.has('queries'))) process.exit(1);

await withStore(async (store) => {
  if (args.has('queries')) {
    const users = await allUsers(store, 'place_tips', log);
    const cities = new Map<string, string[]>(); // city -> interests of its users
    for (const u of users) {
      for (const city of citiesFor(u, base)) {
        cities.set(city, [...new Set([...(cities.get(city) ?? []), ...u.prefs.interests])]);
      }
    }
    if (cities.size === 0 && args.get('city')) cities.set(args.get('city') as string, []);

    const out = [...cities.entries()].map(([city, interests]) => ({
      city,
      kind: 'place' as const,
      queries: buildQueries(city, 'place', { from: window.from, to: window.to, like: [], interests }),
    }));
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }

  const result = await fanout({
    store,
    log,
    optIn: 'place_tips',
    window,
    kinds: ['place'],
    sources: ['websearch'],
    top: args.num('top') ?? cfg.digest.places_top,
    newOnly: !args.has('all'),
    dryRun: args.has('dry-run'),
    onlyChats: args.list('chat'),
    title: () => copy.TITLE_PLACES,
    footer: copy.PLACES_FOOTER,
  });

  if (result.items === 0) {
    process.stdout.write(
      'No new places to suggest. Fill the inbox first:\n' +
        '  1. npx tsx scripts/places.ts --queries\n' +
        '  2. run those queries with web_search\n' +
        '  3. npx tsx scripts/websearch.ts --ingest results.json --kind place --city <city>\n',
    );
  } else {
    process.stdout.write(`${result.items} place(s) to ${result.recipients}/${result.users} user(s)\n`);
  }
});

process.exit(0);
