#!/usr/bin/env -S npx tsx
/**
 * Reminder tick: fires the 1-day and 3-hour reminders every user asked for
 * with a ❤️. Run it on a short schedule (every 15 minutes).
 *
 *   npx tsx scripts/reminders.ts                 # fire whatever is due
 *   npx tsx scripts/reminders.ts --dry-run       # show what would fire
 *   npx tsx scripts/reminders.ts --list          # everything pending, all users
 *   npx tsx scripts/reminders.ts --list --chat 123456789
 *   npx tsx scripts/reminders.ts --cancel <item-id> --chat 123456789
 *
 * Reminders are created by reacting ❤️ to an event message in Telegram
 * (scripts/bot.ts) — this script only delivers them.
 *
 * Quiet hours are honoured by exactly half of this. The "in ~3 hours" reminder
 * always fires: it is the whole point of the feature, and a reminder that waits
 * until morning for a show that started last night is worse than none. The
 * "tomorrow" one is not urgent, so it is held until the quiet window ends —
 * the row stays unfired and the next tick picks it up.
 */
import { loadConfig } from '../src/config.ts';
import { makeLogger } from '../src/log.ts';
import { parseArgs } from '../src/cli.ts';
import { withStore } from '../src/db.ts';
import { TelegramError, escapeHtml, sendMessage } from '../src/telegram-api.ts';
import { canSend } from '../src/deliver.ts';
import { reminderAllowedNow, scheduleOf } from '../src/schedule.ts';
import { dayLabel, localDate, localTime, sleep } from '../src/util.ts';

const args = parseArgs();
const log = makeLogger('reminders');
const cfg = loadConfig();
const dryRun = args.has('dry-run');

if (!dryRun && !args.has('list') && !canSend(log, false)) process.exit(1);

await withStore(async (store) => {
  const chat = args.get('chat');

  if (args.has('list')) {
    const rows = await store.listReminders(chat);
    if (rows.length === 0) process.stdout.write('no reminders pending\n');
    for (const r of rows) {
      process.stdout.write(
        `${r.starts_at}  chat ${r.chat_id}  ${r.title}  [1d:${r.fired_1d ? '✓' : '·'} 3h:${r.fired_3h ? '✓' : '·'}]  ${r.item_id}\n`,
      );
    }
    return;
  }

  const cancel = args.get('cancel');
  if (cancel) {
    if (!chat) {
      process.stderr.write('--cancel needs --chat <id> as well: reminders belong to a person\n');
      process.exitCode = 1;
      return;
    }
    await store.cancelReminder(chat, cancel);
    process.stdout.write(`cancelled reminder ${cancel} for chat ${chat}\n`);
    return;
  }

  const due = await store.dueReminders();
  log.info(`${due.length} reminder(s) due`);

  const hour = Number(localTime(new Date(), cfg.timezone).slice(0, 2));
  const schedules = new Map<string, ReturnType<typeof scheduleOf>>();
  const scheduleFor = async (chatId: string) => {
    const known = schedules.get(chatId);
    if (known) return known;
    const fresh = scheduleOf((await store.getUser(chatId)) ?? undefined);
    schedules.set(chatId, fresh);
    return fresh;
  };

  let fired = 0;
  let held = 0;
  for (const { row, which } of due) {
    // the 1-day reminder can wait for morning; the 3-hour one cannot
    if (!reminderAllowedNow(which, hour, await scheduleFor(row.chat_id))) {
      log.info(`chat ${row.chat_id}: holding the 1-day reminder for "${row.title}" until quiet hours end`);
      held++;
      continue;
    }
    const when = which === '1d' ? 'Завтра' : 'Вже за ~3 години';
    const day = dayLabel(localDate(row.starts_at, cfg.timezone), cfg.locale);
    const time = localTime(row.starts_at, cfg.timezone);
    const text =
      `❤️ <b>${escapeHtml(when)}</b>: ${escapeHtml(row.title)}\n` +
      `${escapeHtml(day)} ${escapeHtml(time)}${row.venue ? ` · ${escapeHtml(row.venue)}` : ''}\n` +
      (row.url ? `<a href="${escapeHtml(row.url)}">детальніше →</a>` : '');

    try {
      await sendMessage(text, { chatId: row.chat_id, dryRun, log });
      if (!dryRun) await store.markReminderFired(row.id, which);
      fired++;
      log.info(`${dryRun ? 'would fire' : 'fired'} ${which} reminder for chat ${row.chat_id}: "${row.title}"`);
    } catch (err) {
      if (err instanceof TelegramError && err.chatGone) {
        // they blocked the bot: stop sending, keep the row
        log.warn(`chat ${row.chat_id} unreachable — marking blocked`);
        await store.setBlocked(row.chat_id, true);
        if (!dryRun) await store.markReminderFired(row.id, which);
      } else {
        log.error(`reminder ${row.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (cfg.bot.send_delay_ms) await sleep(cfg.bot.send_delay_ms);
  }

  const heldNote = held ? ` (${held} held for quiet hours)` : '';
  process.stdout.write(
    fired === 0 ? `nothing due${heldNote}\n` : `${fired} reminder(s) ${dryRun ? 'would fire' : 'fired'}${heldNote}\n`,
  );
});

process.exit(process.exitCode ?? 0);
