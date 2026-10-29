#!/usr/bin/env -S npx tsx
/**
 * One-off cleanup: throw away the stored items that are places.
 *
 *   npx tsx scripts/unplace.ts            # show what would go
 *   npx tsx scripts/unplace.ts --yes      # actually delete it
 *
 * The bot used to find places as well as events, and `saved`, `deliveries` and
 * `messages` all store whole Items as JSON, re-parsed by zod on every read. A
 * café was stored with `category: 'cafe'`, which is no longer a category, so
 * those rows cannot be read back any more.
 *
 * Nothing breaks without this: every read already skips what it cannot parse,
 * counts it and logs it, so /saved shows four of five bookmarks rather than
 * erroring. This is the tidying up — `scrape_cache` heals itself in half an
 * hour, and a bookmark never does.
 *
 * `messages` rows are trimmed rather than dropped when only some of their
 * items are places: the row is a whole message, and a ❤️ on it still has to
 * resolve against the events that were sitting next to the café.
 *
 * Flags
 *   --yes   write the changes (otherwise it is a dry run)
 */
import { makeLogger } from '../src/log.ts';
import { parseArgs } from '../src/cli.ts';
import { withStore } from '../src/db.ts';

const args = parseArgs();
const log = makeLogger('unplace');
const write = args.has('yes');

await withStore(async (store) => {
  const report = await store.sweepUnreadable({ write });
  const total = report.saved + report.deliveries + report.messages + report.messagesTrimmed;

  if (total === 0) {
    process.stdout.write('nothing unreadable stored — nothing to clean up\n');
    return;
  }

  process.stdout.write(
    [
      `saved bookmarks:      ${report.saved}`,
      `already-sent rows:    ${report.deliveries}`,
      `messages, emptied:    ${report.messages}`,
      `messages, trimmed:    ${report.messagesTrimmed}`,
      '',
      write ? `${total} row(s) cleaned up\n` : `${total} row(s) would be cleaned up — rerun with --yes\n`,
    ].join('\n'),
  );
  log.info(`${write ? 'cleaned' : 'would clean'} ${total} unreadable row(s)`);
});

process.exit(process.exitCode ?? 0);
