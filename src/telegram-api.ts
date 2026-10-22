import { z } from 'zod';
import { loadConfig } from './config.ts';
import { sleep } from './util.ts';
import { loadEnv } from './paths.ts';
import type { Logger } from './log.ts';
import { TgMessageSchema, TgResponseSchema, TgUpdateSchema, type TgMessage, type TgUpdate } from './schemas.ts';
import { formatZodError } from './types.ts';

export type { TgCallbackQuery, TgMessage, TgReactionUpdate, TgUpdate } from './schemas.ts';

/**
 * Telegram Bot API over plain fetch — used for *sending* digests, alerts and
 * reminders, and for reading what comes back: button taps, ❤️ reactions on
 * event messages, and plain replies. Reading public channels is a different
 * job and uses GramJS (see scripts/telegram.ts).
 *
 * Taps and reactions only arrive because `getUpdates` asks for
 * `callback_query` and `message_reaction` explicitly; without them Telegram
 * silently drops both.
 */

export function botToken(): string | undefined {
  loadEnv();
  return process.env['TELEGRAM_BOT_TOKEN'];
}

export function defaultChatId(): string | undefined {
  loadEnv();
  return process.env['TELEGRAM_CHAT_ID'];
}

/** POST to the Bot API and validate the envelope and the result with zod. */
async function call<T extends z.ZodTypeAny>(
  method: string,
  body: Record<string, unknown>,
  result: T,
): Promise<z.infer<T>> {
  const token = botToken();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set (put it in ~/.hermes/.env)');
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const envelope = TgResponseSchema(result).safeParse(await res.json());
  if (!envelope.success) throw new Error(`Telegram ${method}: unexpected response — ${formatZodError(envelope.error, 3)}`);
  if (!envelope.data.ok) throw new TelegramError(method, res.status, envelope.data.description);
  if (envelope.data.result === undefined) throw new Error(`Telegram ${method}: empty result`);
  return envelope.data.result as z.infer<T>;
}

/** A Bot API error, classified enough to react to it. */
export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly description?: string,
  ) {
    super(`Telegram ${method} failed: ${description ?? status}`);
    this.name = 'TelegramError';
  }

  /** The user blocked the bot, deleted the chat, or never started it. */
  get chatGone(): boolean {
    const d = (this.description ?? '').toLowerCase();
    return (
      this.status === 403 ||
      d.includes('blocked by the user') ||
      d.includes('chat not found') ||
      d.includes('user is deactivated') ||
      d.includes('bot was kicked')
    );
  }

  /** Flood control: seconds to wait, if Telegram said. */
  get retryAfter(): number | null {
    const m = (this.description ?? '').match(/retry after (\d+)/i);
    return m ? Number(m[1]) : this.status === 429 ? 3 : null;
  }
}

/** A button under a message: either it calls back into the bot, or it opens a link. */
export type InlineButton = { text: string; callback_data: string } | { text: string; url: string };

export interface SendOptions {
  chatId?: string;
  dryRun?: boolean;
  log?: Logger;
  replyTo?: number;
  silent?: boolean;
  /** Reply keyboard rows, e.g. [[{ text: 'Kharkiv' }], [{ text: 'Kyiv' }]]. */
  keyboard?: { text: string }[][];
  removeKeyboard?: boolean;
  /** Inline button rows, attached to the last chunk of a long message. */
  inlineKeyboard?: InlineButton[][];
}

/**
 * Telegram accepts exactly one reply_markup. An inline keyboard belongs to the
 * last chunk of a split message, so the buttons end up under the final card.
 */
function replyMarkup(opts: SendOptions, last: boolean): Record<string, unknown> {
  if (opts.keyboard) return { reply_markup: { keyboard: opts.keyboard, resize_keyboard: true, one_time_keyboard: true } };
  if (opts.removeKeyboard) return { reply_markup: { remove_keyboard: true } };
  if (opts.inlineKeyboard && last) return { reply_markup: { inline_keyboard: opts.inlineKeyboard } };
  return {};
}

/** Dry-run rendering: buttons are part of the answer, so print them too. */
function printButtons(rows: InlineButton[][] | undefined): void {
  if (!rows?.length) return;
  for (const row of rows) {
    process.stdout.write(`[ ${row.map((b) => ('url' in b ? `${b.text} → ${b.url}` : `${b.text} (${b.callback_data})`)).join(' | ')} ]\n`);
  }
}

/**
 * Send one message. Long messages are split on blank lines so a digest never
 * trips Telegram's 4096-character limit. Returns the message ids that were sent
 * (empty on dry run).
 */
export async function sendMessage(text: string, opts: SendOptions = {}): Promise<number[]> {
  const cfg = loadConfig();
  const chatId = opts.chatId ?? defaultChatId();
  if (opts.dryRun || !chatId) {
    if (!chatId && !opts.dryRun) opts.log?.warn('TELEGRAM_CHAT_ID is not set — printing instead of sending');
    // name the destination: a dry run of a fan-out prints many users' messages
    // one after another, and they are separate private chats, not one thread
    if (chatId) process.stdout.write(`\n──────── to chat ${chatId} ────────\n`);
    process.stdout.write(text + '\n');
    printButtons(opts.inlineKeyboard);
    return [];
  }
  const ids: number[] = [];
  const chunks = splitForTelegram(text);
  for (const [i, chunk] of chunks.entries()) {
    const body = {
      chat_id: chatId,
      text: chunk,
      parse_mode: cfg.telegram.parse_mode,
      disable_web_page_preview: cfg.telegram.disable_preview,
      disable_notification: opts.silent ?? false,
      ...(opts.replyTo ? { reply_to_message_id: opts.replyTo } : {}),
      ...replyMarkup(opts, i === chunks.length - 1),
    };
    let msg;
    try {
      msg = await call('sendMessage', body, TgMessageSchema);
    } catch (err) {
      // one retry on flood control; everything else is the caller's problem
      if (err instanceof TelegramError && err.retryAfter && !err.chatGone) {
        opts.log?.warn(`flood control: waiting ${err.retryAfter}s before retrying chat ${chatId}`);
        await sleep((err.retryAfter + 1) * 1000);
        msg = await call('sendMessage', body, TgMessageSchema);
      } else {
        throw err;
      }
    }
    ids.push(msg.message_id);
    opts.log?.debug(`sent message ${msg.message_id} to ${chatId} (${chunk.length} chars)`);
  }
  return ids;
}

export function splitForTelegram(text: string, limit = 3800): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let buf = '';
  for (const block of text.split('\n\n')) {
    if ((buf + '\n\n' + block).length > limit && buf) {
      out.push(buf);
      buf = block;
    } else {
      buf = buf ? `${buf}\n\n${block}` : block;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * Rewrite a message that is already in the chat — how a settings panel changes
 * in place when somebody taps one of its buttons instead of piling up replies.
 */
export async function editMessageText(
  text: string,
  opts: { chatId: string; messageId: number; inlineKeyboard?: InlineButton[][]; dryRun?: boolean; log?: Logger },
): Promise<void> {
  if (opts.dryRun) {
    process.stdout.write(`\n──────── edit ${opts.messageId} in chat ${opts.chatId} ────────\n${text}\n`);
    printButtons(opts.inlineKeyboard);
    return;
  }
  const cfg = loadConfig();
  try {
    await call(
      'editMessageText',
      {
        chat_id: opts.chatId,
        message_id: opts.messageId,
        text,
        parse_mode: cfg.telegram.parse_mode,
        disable_web_page_preview: cfg.telegram.disable_preview,
        ...(opts.inlineKeyboard ? { reply_markup: { inline_keyboard: opts.inlineKeyboard } } : {}),
      },
      TgMessageSchema,
    );
  } catch (err) {
    // tapping a toggle twice in a row produces identical text; Telegram calls
    // that an error, we call it nothing happened
    if (err instanceof TelegramError && (err.description ?? '').includes('message is not modified')) return;
    throw err;
  }
}

/**
 * Take a message back — used for the "⏳ Шукаю…" placeholder once the answer it
 * was standing in for has arrived.
 *
 * Never throws: the message may already be gone, or older than the 48 hours
 * Telegram allows a bot to delete within, and neither is worth an error to
 * someone who just got their results.
 */
export async function deleteMessage(
  messageId: number,
  opts: { chatId: string; dryRun?: boolean; log?: Logger },
): Promise<void> {
  if (opts.dryRun) {
    process.stdout.write(`\n──────── delete ${opts.messageId} in chat ${opts.chatId} ────────\n`);
    return;
  }
  try {
    await call('deleteMessage', { chat_id: opts.chatId, message_id: messageId }, z.boolean());
  } catch (err) {
    opts.log?.debug(`deleteMessage failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Stop the spinner on a tapped button. Telegram expects this within seconds,
 * and a failure here must never sink the work the tap asked for.
 */
export async function answerCallbackQuery(
  id: string,
  opts: { text?: string; dryRun?: boolean; log?: Logger } = {},
): Promise<void> {
  if (opts.dryRun) return;
  try {
    await call('answerCallbackQuery', { callback_query_id: id, ...(opts.text ? { text: opts.text } : {}) }, z.boolean());
  } catch (err) {
    opts.log?.debug(`answerCallbackQuery failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Publish the command list, which is what makes Telegram autocomplete "/" and
 * fill the ☰ menu button. Idempotent, so the bot re-sends it on every start.
 */
export async function setMyCommands(commands: { command: string; description: string }[]): Promise<void> {
  await call('setMyCommands', { commands }, z.boolean());
}

/** What Telegram currently has on file, for `scripts/doctor.ts`. */
export async function getMyCommands(): Promise<{ command: string; description: string }[]> {
  return call('getMyCommands', {}, z.array(z.object({ command: z.string(), description: z.string() }).loose()));
}

/** Long-poll new updates; the caller stores the offset (see scripts/bot.ts). */
export async function getUpdates(offset: number, timeout = 0): Promise<TgUpdate[]> {
  return call(
    'getUpdates',
    { offset, timeout, allowed_updates: ['message', 'edited_message', 'callback_query', 'message_reaction'] },
    z.array(TgUpdateSchema),
  );
}

export async function getMe(): Promise<{ id: number; username?: string; first_name?: string }> {
  return call('getMe', {}, z.object({ id: z.number(), username: z.string().optional(), first_name: z.string().optional() }).loose());
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
