import { z } from 'zod';
import { loadConfig } from './config.ts';
import { sleep } from './util.ts';
import { loadEnv } from './paths.ts';
import type { Logger } from './log.ts';
import { TgMessageSchema, TgResponseSchema, TgUpdateSchema, type TgMessage, type TgUpdate } from './schemas.ts';
import { formatZodError } from './types.ts';

export type { TgMessage, TgReactionUpdate, TgUpdate } from './schemas.ts';

/**
 * Telegram Bot API over plain fetch — used for *sending* digests, alerts and
 * reminders, and for reading what comes back: ❤️ reactions on event messages,
 * and plain replies. Reading public channels is a different job and uses
 * GramJS (see scripts/telegram.ts).
 *
 * Reactions only arrive because `getUpdates` asks for `message_reaction`
 * explicitly; without it Telegram silently drops them.
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

export interface SendOptions {
  chatId?: string;
  dryRun?: boolean;
  log?: Logger;
  replyTo?: number;
  silent?: boolean;
  /** Reply keyboard rows, e.g. [[{ text: 'Kharkiv' }], [{ text: 'Kyiv' }]]. */
  keyboard?: { text: string }[][];
  removeKeyboard?: boolean;
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
    return [];
  }
  const ids: number[] = [];
  for (const chunk of splitForTelegram(text)) {
    const body = {
      chat_id: chatId,
      text: chunk,
      parse_mode: cfg.telegram.parse_mode,
      disable_web_page_preview: cfg.telegram.disable_preview,
      disable_notification: opts.silent ?? false,
      ...(opts.replyTo ? { reply_to_message_id: opts.replyTo } : {}),
      ...(opts.keyboard ? { reply_markup: { keyboard: opts.keyboard, resize_keyboard: true, one_time_keyboard: true } } : {}),
      ...(opts.removeKeyboard ? { reply_markup: { remove_keyboard: true } } : {}),
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

/** Long-poll new updates; the caller stores the offset (see scripts/bot.ts). */
export async function getUpdates(offset: number, timeout = 0): Promise<TgUpdate[]> {
  return call(
    'getUpdates',
    { offset, timeout, allowed_updates: ['message', 'edited_message', 'message_reaction'] },
    z.array(TgUpdateSchema),
  );
}

export async function getMe(): Promise<{ id: number; username?: string; first_name?: string }> {
  return call('getMe', {}, z.object({ id: z.number(), username: z.string().optional(), first_name: z.string().optional() }).loose());
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
