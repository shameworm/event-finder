#!/usr/bin/env -S npx tsx
/**
 * One-off cleanup: take the operator's taste back off everybody else.
 *
 *   npx tsx scripts/disinherit.ts            # show what would change
 *   npx tsx scripts/disinherit.ts --yes      # actually write it
 *   npx tsx scripts/disinherit.ts --chat 123456789 --yes
 *
 * Until the /start walkthrough existed, a new user was handed a copy of
 * `preferences.yaml` — the operator's own favourites, dislikes and interests.
 * Those entries then quietly ranked every search that person ever ran, and
 * showed up in their /prefs as things they had supposedly chosen.
 *
 * This removes, per user, only the entries that are *identical to the seed
 * file*: anything they added themselves survives, and so does anything the
 * seed never had. A tag someone genuinely chose that happens to match the
 * seed is indistinguishable from an inherited one and will be dropped — they
 * can add it back in one tap from /setup, which is the cheaper mistake.
 *
 * The ❤️ tally (`taste`) is left alone: it is only ever written by a real
 * reaction, so it was never inherited.
 *
 * Flags
 *   --yes       write the changes (otherwise it is a dry run)
 *   --chat ID   restrict to these chat ids
 */
import { loadPrefs } from '../src/config.ts';
import { makeLogger } from '../src/log.ts';
import { parseArgs } from '../src/cli.ts';
import { withStore } from '../src/db.ts';
import { allUsers, saveUserPrefs } from '../src/users.ts';
import { normText } from '../src/util.ts';

const args = parseArgs();
const log = makeLogger('disinherit');
const write = args.has('yes');
const onlyChats = args.list('chat');

const seed = loadPrefs((m) => log.warn(m));
/** The three lists that used to be copied wholesale. */
const SEEDED = ['favourite_categories', 'disliked_categories', 'interests'] as const;

await withStore(async (store) => {
  let users = await allUsers(store, undefined, log);
  if (onlyChats.length) users = users.filter((u) => onlyChats.includes(u.chatId));

  let touched = 0;
  for (const user of users) {
    const removed: string[] = [];
    const next = { ...user.prefs };

    for (const list of SEEDED) {
      const inherited = seed[list].map(normText);
      const kept = user.prefs[list].filter((tag) => !inherited.includes(normText(tag)));
      if (kept.length === user.prefs[list].length) continue;
      for (const tag of user.prefs[list]) if (!kept.includes(tag)) removed.push(`${list}: ${tag}`);
      next[list] = kept;
    }

    if (removed.length === 0) continue;
    touched++;
    process.stdout.write(`chat ${user.chatId}${user.row.username ? ` (@${user.row.username})` : ''}\n`);
    for (const r of removed) process.stdout.write(`  − ${r}\n`);
    if (write) await saveUserPrefs(store, user, next);
  }

  process.stdout.write(
    touched === 0
      ? `nothing inherited by any of ${users.length} user(s)\n`
      : `${touched} of ${users.length} user(s) ${write ? 'cleaned' : 'would be cleaned — rerun with --yes'}\n`,
  );
});

process.exit(process.exitCode ?? 0);
