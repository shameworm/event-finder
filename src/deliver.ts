/**
 * "Render it, send it, remember it" for one person.
 *
 * Everything recorded here is per chat id: what they were shown, and which
 * items each message was about, so their "🔔" replies resolve correctly.
 */
import type { Item, Query } from './types.ts';
import type { Logger } from './log.ts';
import type { Store } from './db.ts';
import { buildDigest, summarize, type Format } from './render.ts';
import { TelegramError, botToken, sendMessage } from './telegram-api.ts';

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

export async function deliver(opts: DeliverOptions): Promise<DeliverResult> {
  const { text, ordered } = buildDigest({
    title: opts.title,
    query: opts.query,
    items: opts.items,
    format: opts.format ?? (opts.dryRun ? 'text' : 'html'),
    maxPerDay: opts.maxPerDay,
    explain: opts.explain,
    footer: opts.footer,
    changeNotes: opts.changeNotes,
  });

  let messageIds: number[] = [];
  try {
    messageIds = await sendMessage(text, {
      chatId: opts.chatId,
      dryRun: opts.dryRun,
      log: opts.log,
      replyTo: opts.replyTo,
    });
  } catch (err) {
    if (err instanceof TelegramError && err.chatGone) {
      opts.log.warn(`chat ${opts.chatId} is unreachable (${err.description ?? 'blocked'})`);
      if (opts.store && opts.chatId) await opts.store.setBlocked(opts.chatId, true);
      return { messageIds: [], text, chatGone: true };
    }
    throw err;
  }

  const shouldRecord = opts.record ?? !opts.dryRun;
  if (opts.store && opts.chatId && shouldRecord && opts.items.length > 0) {
    await opts.store.recordSent(opts.chatId, opts.items);
    // map each message to the items it covered, in the order they were
    // numbered, so a "🔔 3" reply resolves to the third line shown
    for (const id of messageIds) await opts.store.recordMessage(opts.chatId, id, ordered);
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
