#!/usr/bin/env -S npx tsx
/**
 * Read and edit a user's taste model in plain language.
 *
 *   npx tsx scripts/prefs.ts                                 # show yours
 *   npx tsx scripts/prefs.ts --chat 123456789                # show someone else's
 *   npx tsx scripts/prefs.ts "add stand-up to favourites"
 *   npx tsx scripts/prefs.ts "I don't like classical music"
 *   npx tsx scripts/prefs.ts "follow Latexfauna"
 *   npx tsx scripts/prefs.ts "max price 800"
 *   npx tsx scripts/prefs.ts "I'm in Lviv next week"
 *   npx tsx scripts/prefs.ts "add jazz to favourites" --dry-run
 *   npx tsx scripts/prefs.ts --list                          # every registered user
 *
 * In the bot, each person's preferences live in the database, keyed by their
 * Telegram chat id — this CLI is the same engine the bot uses, aimed at one
 * chat (yours by default, from TELEGRAM_CHAT_ID).
 *
 *   --defaults   edit preferences.yaml instead: the operator's own profile,
 *                used by the CLI. Bot users do not inherit it — they build
 *                their own through the /start walkthrough.
 */
import { cityLabel, loadPrefs, prefsFile, savePrefs } from '../src/config.ts';
import { makeLogger } from '../src/log.ts';
import { parseArgs } from '../src/cli.ts';
import { withStore } from '../src/db.ts';
import { describeSchedule, scheduleOf } from '../src/schedule.ts';
import { applyPrefsCommand, describePrefs } from '../src/prefs-engine.ts';
import { getUser, ownerChatId, registerUser, saveUserPrefs } from '../src/users.ts';

const args = parseArgs();
const log = makeLogger('prefs');
const text = args.text();

const HINTS =
  `Try things like:\n` +
  `  add stand-up to favourites\n  remove theatre from favourites\n  I don't like classical music\n` +
  `  follow Latexfauna\n  unfollow Latexfauna\n  max price 800\n  watch Odesa\n  I'm in Lviv next week\n`;

/* --- editing the operator's own profile (preferences.yaml) -------------- */
if (args.has('defaults')) {
  const current = loadPrefs((m) => log.warn(m));
  if (!text) {
    process.stdout.write(`CLI defaults (${prefsFile()}):\n\n${describePrefs(current)}\n`);
    process.exit(0);
  }
  const edit = applyPrefsCommand(text, current);
  if (!edit.understood) {
    process.stdout.write(`I did not recognise that as a preference change.\n\n${HINTS}`);
    process.exit(1);
  }
  if (edit.changes.length === 0) {
    process.stdout.write(`no change — ${edit.note ?? 'already set'}\n`);
    process.exit(0);
  }
  if (args.has('dry-run')) {
    process.stdout.write(`would change the defaults:\n${edit.changes.map((c) => `  · ${c}`).join('\n')}\n`);
  } else {
    savePrefs(edit.prefs);
    process.stdout.write(`updated ${prefsFile()}:\n${edit.changes.map((c) => `  · ${c}`).join('\n')}\n`);
  }
  process.exit(0);
}

/* --- editing one user's preferences ------------------------------------- */
await withStore(async (store) => {
  if (args.has('list')) {
    const rows = await store.listUsers();
    if (rows.length === 0) {
      process.stdout.write('no users registered yet — someone has to /start the bot first\n');
      return;
    }
    for (const r of rows) {
      process.stdout.write(
        `${r.chat_id.padEnd(14)} ${cityLabel(r.city).padEnd(16)} ` +
          `${r.username ? '@' + r.username : '—'}  ` +
          `[week:${r.weekly_digest} weekend:${r.weekend_digest} follows:${r.follow_alerts} places:${r.place_tips}] ` +
          `${describeSchedule(scheduleOf(r))}\n`,
      );
    }
    return;
  }

  const chatId = args.get('chat') ?? ownerChatId();
  if (!chatId) {
    process.stderr.write(
      'No chat id: set TELEGRAM_CHAT_ID in ~/.hermes/.env, or pass --chat <id>.\n' +
        'To edit the CLI defaults in preferences.yaml instead: --defaults\n',
    );
    process.exitCode = 1;
    return;
  }

  let user = await getUser(store, chatId, log);
  if (!user) {
    if (args.has('dry-run')) {
      process.stdout.write(`chat ${chatId} is not registered yet; it would be created from the defaults\n`);
      return;
    }
    user = (await registerUser(store, { chatId })).user;
    await store.setUserStage(chatId, null); // CLI-created users skip onboarding
    log.info(`created user ${chatId} from the defaults`);
  }

  if (!text || args.has('show')) {
    process.stdout.write(`chat ${chatId} — ${cityLabel(user.city)}\n\n${describePrefs(user.prefs)}\n`);
    return;
  }

  const edit = applyPrefsCommand(text, user.prefs);
  if (!edit.understood) {
    process.stdout.write(`I did not recognise that as a preference change.\n\n${HINTS}\nCurrent:\n${describePrefs(user.prefs)}\n`);
    process.exitCode = 1;
    return;
  }
  if (edit.changes.length === 0) {
    process.stdout.write(`no change — ${edit.note ?? 'already set'}\n\n${describePrefs(user.prefs)}\n`);
    return;
  }
  if (args.has('dry-run')) {
    process.stdout.write(`would change:\n${edit.changes.map((c) => `  · ${c}`).join('\n')}\n`);
    return;
  }

  const updated = await saveUserPrefs(store, user, edit.prefs);
  log.info(`chat ${chatId}: ${edit.changes.join('; ')}`);
  process.stdout.write(`updated chat ${chatId}:\n${edit.changes.map((c) => `  · ${c}`).join('\n')}\n\n${describePrefs(updated.prefs)}\n`);
});

process.exit(0);
