/**
 * "Render it, send it, remember it" for one person.
 *
 * A digest goes out as a short header followed by **one message per event**,
 * and each of those messages is recorded against the single event it showed.
 * That is what lets a ❤️ reaction resolve to one event with no ambiguity —
 * and it is why `buildMessages`, not `buildDigest`, is used here.
 */
import type { Item, Query } from './types.ts';
import type { Logger } from './log.ts';
import type { Store } from './db.ts';
import { buildMessages, summarize, type Format, type OutgoingMessage } from './render.ts';
import { TelegramError, botToken, sendMessage, sendPhoto } from './telegram-api.ts';
import { loadConfig } from './config.ts';
import { sleep } from './util.ts';

export interface DeliverOptions {
  title: string;
  query: Query;
  items: Item[];
  log: Logger;
  /** Who it goes to. Required unless dryRun. */
  chatId?: string;
  store?: Store;
  /** Print instead of sending. */
  dryRun?: boolean;
  maxPerDay?: number;
  explain?: boolean;
  footer?: string;
  format?: Format;
  changeNotes?: Map<string, string>;
  replyTo?: number;
  /** Record the items as sent, so they are not repeated. Default: true when sending. */
  record?: boolean;
}

export interface DeliverResult {
  messageIds: number[];
  text: string;
  /** True when Telegram said this chat is gone (blocked, deleted, never started). */
  chatGone: boolean;
}

/**
 * Send one card: as a photo with a caption when it has a poster, as text when
 * it does not — and as text when Telegram will not take the poster.
 *
 * That last case is the whole reason this is a function. A URL Telegram cannot
 * fetch, or a file it rejects, fails the *entire* sendPhoto call, so without a
 * retry as text one dead poster would silently drop an event out of somebody's
 * digest — and, because the message id is what a ❤️ resolves through, take the
 * reminder for it with them.
 */
async function sendCard(
  message: OutgoingMessage,
  opts: DeliverOptions,
  replyTo: number | undefined,
): Promise<number[]> {
  const common = { chatId: opts.chatId, dryRun: opts.dryRun, log: opts.log, replyTo };
  if (message.image && message.caption) {
    try {
      return await sendPhoto(message.image, { ...common, caption: message.caption });
    } catch (err) {
      // a gone chat is about the person, not the picture — let it through
      if (err instanceof TelegramError && !err.chatGone) {
        opts.log.warn(
          `poster rejected for "${message.items[0]?.title ?? '?'}" (${err.description ?? err.message}) — sending as text: ${message.image}`,
        );
      } else {
        throw err;
      }
    }
  }
  return sendMessage(message.text, common);
}

export async function deliver(opts: DeliverOptions): Promise<DeliverResult> {
  const cfg = loadConfig();
  const messages = buildMessages({
    title: opts.title,
    query: opts.query,
    items: opts.items,
    format: opts.format ?? (opts.dryRun ? 'text' : 'html'),
    maxPerDay: opts.maxPerDay,
    explain: opts.explain,
    footer: opts.footer,
    changeNotes: opts.changeNotes,
  });
  const text = messages.map((m) => m.text).join('\n\n');
  const shouldRecord = opts.record ?? !opts.dryRun;
  const messageIds: number[] = [];

  for (const [i, message] of messages.entries()) {
    // Telegram tolerates a burst but throttles a sustained one; a short pause
    // between a digest's messages keeps a ten-event week under its limit
    if (i > 0 && !opts.dryRun && cfg.bot.message_delay_ms) await sleep(cfg.bot.message_delay_ms);

    let ids: number[];
    try {
      // only the header answers the request; the events stand on their own
      ids = await sendCard(message, opts, i === 0 ? opts.replyTo : undefined);
    } catch (err) {
      if (err instanceof TelegramError && err.chatGone) {
        opts.log.warn(`chat ${opts.chatId} is unreachable (${err.description ?? 'blocked'})`);
        if (opts.store && opts.chatId) await opts.store.setBlocked(opts.chatId, true);
        return { messageIds, text, chatGone: true };
      }
      throw err;
    }
    messageIds.push(...ids);

    // one event per message, so a ❤️ on this message means exactly this event
    if (opts.store && opts.chatId && shouldRecord && message.items.length > 0) {
      for (const id of ids) await opts.store.recordMessage(opts.chatId, id, message.items);
    }
  }

  if (opts.store && opts.chatId && shouldRecord && opts.items.length > 0) {
    await opts.store.recordSent(opts.chatId, opts.items);
  }

  opts.log.info(`${opts.dryRun ? 'dry-run' : `sent to ${opts.chatId}`}: ${opts.title} — ${summarize(opts.items)}`);
  return { messageIds, text, chatGone: false };
}

/**
 * A scheduled job that is about to send needs a bot token; without one it would
 * crash on the first user. Call this before doing any work and exit cleanly.
 */
export function canSend(log: Logger, dryRun: boolean | undefined): boolean {
  if (dryRun || botToken()) return true;
  log.error(
    'TELEGRAM_BOT_TOKEN is not set, so there is nobody to send to — ' +
      'put it in ~/.hermes/.env (see .env.example), or pass --dry-run to print instead',
  );
  return false;
}
