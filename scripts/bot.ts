#!/usr/bin/env -S npx tsx
/**
 * The bot service: one Telegram bot that anybody can use.
 *
 * It handles both messages and ❤️ reactions — a reaction on an event message
 * is what sets a reminder, so `getUpdates` asks Telegram for `message_reaction`
 * as well (see src/telegram-api.ts).
 *
 *   npx tsx scripts/bot.ts                 # long-poll until stopped (the normal way to run it)
 *   npx tsx scripts/bot.ts --once          # drain whatever is waiting, then exit (cron mode)
 *   npx tsx scripts/bot.ts --dry-run       # print replies instead of sending them
 *
 * --dry-run only stops the sending. Preferences, onboarding stages, opt-ins and
 * reminders are still written, so run it against a throwaway database if you do
 * not want it touching real users.
 *
 * Each user gets their own city, taste model, digest settings and reminders —
 * all keyed by their Telegram chat id. Searches go through the shared per-city
 * cache, so many people asking the same question cost one scrape.
 *
 * Run it under a supervisor (systemd, pm2, `launchd`) so it restarts on crash.
 * Only one copy may poll at a time: Telegram hands each update to a single
 * getUpdates caller, so a second instance will steal messages.
 */
import { loadConfig } from '../src/config.ts';
import { makeLogger } from '../src/log.ts';
import { parseArgs } from '../src/cli.ts';
import { withStore, type Store } from '../src/db.ts';
import { TelegramError, answerCallbackQuery, botToken, getMe, getUpdates, setMyCommands } from '../src/telegram-api.ts';
import { BOT_COMMANDS, handleCallback, handleMessage, handleReaction, type HandlerContext } from '../src/bot-handlers.ts';
import { sleep } from '../src/util.ts';

const args = parseArgs();
const log = makeLogger('bot');
const cfg = loadConfig();
const dryRun = args.has('dry-run');
const OFFSET_KEY = 'telegram:updates_offset';

if (!botToken()) {
  log.error('TELEGRAM_BOT_TOKEN is not set — create a bot with @BotFather and put the token in ~/.hermes/.env');
  process.exit(1);
}

/**
 * Where the poll is up to while --dry-run is on. A dry run must not write to
 * the database, but it must still move forward: without this, every poll
 * re-fetched and re-printed the same updates for ever.
 */
let dryOffset: number | null = null;

/** Telegram 409: a second poller stole the stream. Spinning on it is pointless. */
function conflicted(err: unknown): boolean {
  if (!(err instanceof TelegramError) || err.status !== 409) return false;
  log.error('another instance of this bot is already polling this token — stop that one, then start this again');
  process.stderr.write('Telegram says another getUpdates poller is running for this token. Stopping.\n');
  process.exitCode = 1;
  return true;
}

/** Process one batch of updates. Returns how many were handled. */
async function drain(store: Store, timeout: number): Promise<number> {
  const ctx: HandlerContext = { store, log, dryRun };
  const stored = Number((await store.getState(OFFSET_KEY)) ?? 0);
  const offset = dryRun ? (dryOffset ?? stored) : stored;
  const advanceTo = async (next: number): Promise<void> => {
    if (dryRun) dryOffset = next;
    else await store.setState(OFFSET_KEY, String(next));
  };
  const { updates, lastUpdateId } = await getUpdates(offset, timeout, log);

  // Telegram spins the button until the tap is acknowledged, and the updates
  // below are handled strictly one at a time — a tap sitting behind a
  // 60-second search used to spin for the whole search. Ack the batch first.
  for (const update of updates) {
    if (update.callback_query) await answerCallbackQuery(update.callback_query.id, { dryRun, log });
  }

  for (const update of updates) {
    const msg = update.message ?? update.edited_message;
    const cb = update.callback_query;
    const reaction = update.message_reaction;
    if (msg || cb || reaction) {
      const started = Date.now();
      const where = msg ? msg.chat.id : (cb?.message?.chat.id ?? cb?.from?.id ?? reaction?.chat.id);
      try {
        // a ❤️ on an event message is how people set reminders, so reactions
        // are first-class updates here, not a side channel
        if (msg) await handleMessage(ctx, msg);
        else if (cb) await handleCallback(ctx, cb);
        else if (reaction) await handleReaction(ctx, reaction);
        log.info(`handled update ${update.update_id} from chat ${where} in ${Date.now() - started}ms`);
      } catch (err) {
        // one user's bad message or button tap must never take the bot down
        log.error(
          `update ${update.update_id} from chat ${where} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
        );
      }
    }
    // advance past the update even if it threw, or we would retry it forever
    await advanceTo(update.update_id + 1);
  }
  // malformed updates are skipped above but still occupy ids; advance past
  // them too, or a poison batch at the tail would be re-fetched forever
  if (lastUpdateId >= offset) await advanceTo(lastUpdateId + 1);
  return updates.length;
}

await withStore(async (store) => {
  const me = await getMe();
  log.info(
    `@${me.username ?? me.id} up; ${cfg.bot.public ? 'public' : `allowlist of ${cfg.bot.allowlist.length}`}, ` +
      `${cfg.bot.searches_per_hour} searches/user/hour, cache ${cfg.cache.ttl_seconds}s`,
  );
  const counts = await store.countUsers();
  log.info(`${counts.active} active user(s) of ${counts.total} registered`);

  // what Telegram autocompletes after "/" and shows behind the ☰ menu button;
  // cosmetic, so a failure here is logged and the bot carries on serving people
  if (!dryRun) {
    try {
      await setMyCommands(BOT_COMMANDS);
      log.info(`published ${BOT_COMMANDS.length} commands to the Telegram menu`);
    } catch (err) {
      log.warn(`could not publish the command menu: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (args.has('once')) {
    try {
      const n = await drain(store, args.num('timeout') ?? 0);
      process.stdout.write(`${n} update(s) processed\n`);
    } catch (err) {
      if (!conflicted(err)) throw err;
    }
    return;
  }

  process.stdout.write(`@${me.username ?? me.id} is listening. Ctrl-C to stop.\n`);
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (stopping) process.exit(130);
      stopping = true;
      log.info(`${signal} received — finishing the current batch`);
      process.stdout.write('\nstopping…\n');
    });
  }

  while (!stopping) {
    try {
      await drain(store, 25);
    } catch (err) {
      // two pollers cannot share one token, and no amount of waiting fixes it
      if (conflicted(err)) return;
      // network blips, Telegram hiccups: wait and carry on
      log.error(`poll failed: ${err instanceof Error ? err.message : String(err)}`);
      await sleep(5000);
    }
  }
});

process.exit(process.exitCode ?? 0);
