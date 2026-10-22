#!/usr/bin/env -S npx tsx
/**
 * The bot service: one Telegram bot that anybody can use.
 *
 *   npx tsx scripts/bot.ts                 # long-poll until stopped (the normal way to run it)
 *   npx tsx scripts/bot.ts --once          # drain whatever is waiting, then exit (cron mode)
 *   npx tsx scripts/bot.ts --dry-run       # print replies instead of sending them
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
import { botToken, getMe, getUpdates, setMyCommands } from '../src/telegram-api.ts';
import { BOT_COMMANDS, handleCallback, handleMessage, type HandlerContext } from '../src/bot-handlers.ts';
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

/** Process one batch of updates. Returns how many were handled. */
async function drain(store: Store, timeout: number): Promise<number> {
  const ctx: HandlerContext = { store, log, dryRun };
  const offset = Number((await store.getState(OFFSET_KEY)) ?? 0);
  const updates = await getUpdates(offset, timeout);

  for (const update of updates) {
    const msg = update.message ?? update.edited_message;
    const cb = update.callback_query;
    if (msg || cb) {
      const started = Date.now();
      const where = msg ? msg.chat.id : (cb?.message?.chat.id ?? cb?.from?.id);
      try {
        if (msg) await handleMessage(ctx, msg);
        else if (cb) await handleCallback(ctx, cb);
        log.info(`handled update ${update.update_id} from chat ${where} in ${Date.now() - started}ms`);
      } catch (err) {
        // one user's bad message or button tap must never take the bot down
        log.error(
          `update ${update.update_id} from chat ${where} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
        );
      }
    }
    // advance past the update even if it threw, or we would retry it forever
    if (!dryRun) await store.setState(OFFSET_KEY, String(update.update_id + 1));
  }
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
    const n = await drain(store, args.num('timeout') ?? 0);
    process.stdout.write(`${n} update(s) processed\n`);
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
      // network blips, Telegram hiccups: wait and carry on
      log.error(`poll failed: ${err instanceof Error ? err.message : String(err)}`);
      await sleep(5000);
    }
  }
});

process.exit(0);
