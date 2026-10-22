#!/usr/bin/env -S npx tsx
/**
 * Main entry point: free text in, ranked digest out.
 *
 *   npx tsx scripts/search.ts "what's interesting in Kharkiv this weekend, I like stand-up and indie rock, no classical music"
 *   npx tsx scripts/search.ts --city lviv --from 2026-11-01 --to 2026-11-03 --top 10
 *   npx tsx scripts/search.ts "цими вихідними у Харкові" --send
 *   npx tsx scripts/search.ts --city kyiv --json | jq '.[0]'
 *
 * Flags
 *   --city / --cities    override the city (comma-separated for several)
 *   --from / --to        override the date window (YYYY-MM-DD)
 *   --like / --dislike   extra taste tags, comma-separated
 *   --max-price N        budget for this run
 *   --top N              keep only the N best items overall
 *   --kind place|event   search places instead of events (default: events)
 *   --only / --skip      restrict sources, e.g. --only concert.ua,karabas
 *   --pages N            pages per source/category
 *   --new-only           hide anything already sent to --chat (unless date/price/status changed)
 *   --chat ID            act as this Telegram user (defaults to TELEGRAM_CHAT_ID)
 *   --send               send to Telegram (otherwise prints)
 *   --json               raw JSON instead of a digest
 *   --explain            show the ranking reasons
 *   --include-disliked / --include-expensive   do not filter those out
 */
import type { Item, Kind } from '../src/types.ts';
import { loadConfig, loadPrefs } from '../src/config.ts';
import { makeLogger } from '../src/log.ts';
import { parseArgs } from '../src/cli.ts';
import { parseRequest } from '../src/request.ts';
import { runPipeline } from '../src/pipeline.ts';
import { withStore } from '../src/db.ts';
import { ownerChatId } from '../src/users.ts';
import { deliver } from '../src/deliver.ts';
import { renderDigest } from '../src/render.ts';

const args = parseArgs();
const log = makeLogger('search');
const cfg = loadConfig();
const prefs = loadPrefs((m) => log.warn(m));

const kinds: Kind[] | undefined = args.get('kind')
  ? (args.get('kind') === 'place' ? ['place'] : ['event'])
  : undefined;

const query = parseRequest(args.text(), {
  prefs,
  city: args.get('city') ?? args.get('cities'),
  from: args.get('from'),
  to: args.get('to'),
  like: args.list('like'),
  dislike: args.list('dislike'),
  maxPrice: args.num('max-price'),
  kinds,
});

log.info(
  `request: ${JSON.stringify({ text: query.text, cities: query.cities, from: query.from, to: query.to, like: query.like, dislike: query.dislike, maxPrice: query.maxPrice })}`,
);

const result = await runPipeline({
  query,
  prefs,
  log,
  only: args.list('only'),
  skip: args.list('skip'),
  maxPages: args.num('pages'),
  keepDisliked: args.has('include-disliked'),
  keepExpensive: args.has('include-expensive'),
});

const top = args.num('top');
let items: Item[] = top ? result.items.slice(0, top) : result.items;
const changeNotes = new Map<string, string>();

// the CLI acts on behalf of one chat: yours, unless --chat says otherwise
const chatId = args.get('chat') ?? ownerChatId();

await withStore(async (store) => {
  if (args.has('new-only') && chatId) {
    const { fresh, skipped } = await store.filterUnsent(chatId, items);
    log.info(`--new-only: ${fresh.length} new, ${skipped} already sent`);
    items = fresh.map((f) => f.item);
    for (const f of fresh) if (f.reason !== 'new') changeNotes.set(f.item.id, f.reason);
  }

  if (args.has('json')) {
    process.stdout.write(JSON.stringify(items, null, 2) + '\n');
    return;
  }

  // the header already names the cities; --send puts this in front of a real person
  const title = query.kinds.includes('place') ? '📍 Варто зайти' : '🗓 Що знайшлося';

  if (args.has('send')) {
    if (!chatId) {
      process.stderr.write('--send needs a chat: set TELEGRAM_CHAT_ID or pass --chat <id>\n');
      process.exitCode = 1;
      return;
    }
    await deliver({ title, query, items, log, store, chatId, changeNotes, explain: args.has('explain'), maxPerDay: args.num('per-day') });
  } else {
    process.stdout.write(
      renderDigest({
        title,
        query,
        items,
        format: 'text',
        maxPerDay: args.num('per-day') ?? 0,
        explain: args.has('explain'),
        changeNotes,
      }) + '\n',
    );
  }

  if (result.failedSources.length) {
    process.stderr.write(`\n⚠️  sources that failed: ${result.failedSources.join(', ')} (see the log)\n`);
  }
  if (result.dropped.length && args.has('explain')) {
    process.stderr.write(`\nfiltered out (${result.dropped.length}):\n`);
    for (const d of result.dropped.slice(0, 20)) process.stderr.write(`  · ${d.item.title} — ${d.why}\n`);
  }
});

process.exit(0);
