#!/usr/bin/env -S npx tsx
/**
 * Source: Telegram event / stand-up channels, read with GramJS.
 *
 *   npx tsx scripts/tg-login.ts                       # once, to create a session
 *   npx tsx scripts/telegram.ts --city kharkiv
 *   npx tsx scripts/telegram.ts --channel @some_afisha --days 14 --dump
 *
 * Channels are configured per city in config.yaml (`telegram_channels`).
 * Needs TELEGRAM_API_ID / TELEGRAM_API_HASH (my.telegram.org) and a session
 * string in TELEGRAM_SESSION, which scripts/tg-login.ts writes for you.
 *
 * Channel posts are free-form prose, so everything here is best-effort and the
 * items are marked confidence: 'low' — the agent is expected to tidy titles
 * before anything is shown to a human.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { Item, SourceResult } from '../src/types.ts';
import { loadConfig } from '../src/config.ts';
import { TG_SESSION_FILE, loadEnv } from '../src/paths.ts';
import { makeItem, parsePriceText } from '../src/normalize.ts';
import { classify } from '../src/categories.ts';
import { inWindow } from '../src/filter.ts';
import { addDays, hasWord, isoInZone, monthFromWord, normText, pad2, stripEmoji, today, truncate, weekdayOf } from '../src/util.ts';
import { runSourceCli, type SourceContext } from '../src/source.ts';
import { TgChannelPostSchema, type TgChannelPost } from '../src/schemas.ts';
import { parseArgs } from '../src/cli.ts';
import { makeLogger } from '../src/log.ts';

export const SOURCE = 'telegram';

/* --------------------------------------------------------------- parsing --- */

/** Stem fragments are fine here: posts write weekdays in every case form. */
const WEEKDAY_STEMS: [RegExp, number][] = [
  [/понеділ|понедельн/u, 1], [/вівтор|вторн/u, 2], [/серед|сред/u, 3], [/четвер|четверг/u, 4],
  [/ятниц/u, 5], [/субот|суббот/u, 6], [/неділ|воскресен/u, 0],
];

/** Find the event date in a post, as YYYY-MM-DD, or null. */
export function findDate(text: string, base: string): string | null {
  const t = normText(text);
  if (hasWord(t, 'післязавтра', 'послезавтра')) return addDays(base, 2);
  if (hasWord(t, 'сьогодні', 'сегодня', 'today', 'tonight')) return base;
  if (hasWord(t, 'завтра', 'tomorrow')) return addDays(base, 1);

  // 25.10 / 25.10.2026 / 25/10
  const dotted = text.match(/\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b/);
  if (dotted) {
    const day = Number(dotted[1]);
    const mon = Number(dotted[2]);
    if (day >= 1 && day <= 31 && mon >= 1 && mon <= 12) {
      const year = dotted[3]
        ? Number(dotted[3].length === 2 ? `20${dotted[3]}` : dotted[3])
        : inferYear(base, mon, day);
      return `${year}-${pad2(mon)}-${pad2(day)}`;
    }
  }

  // 25 жовтня / 3 november
  const worded = t.match(/\b(\d{1,2})\s+([a-zЀ-ӿ]{3,})/);
  if (worded) {
    const mon = monthFromWord(worded[2] as string);
    const day = Number(worded[1]);
    if (mon && day >= 1 && day <= 31) return `${inferYear(base, mon, day)}-${pad2(mon)}-${pad2(day)}`;
  }

  for (const [re, wd] of WEEKDAY_STEMS) {
    if (re.test(t)) {
      const delta = (wd - weekdayOf(base) + 7) % 7;
      return addDays(base, delta === 0 ? 7 : delta);
    }
  }
  return null;
}

/** Posts rarely give a year; assume the next occurrence. */
function inferYear(base: string, month: number, day: number): number {
  const year = Number(base.slice(0, 4));
  const candidate = `${year}-${pad2(month)}-${pad2(day)}`;
  return candidate >= base.slice(0, 10) ? year : year + 1;
}

export function findTime(text: string): string | null {
  const m = text.match(/\b([01]?\d|2[0-3])[:.](\d{2})\b/);
  if (!m) return null;
  return `${pad2(Number(m[1]))}:${m[2]}`;
}

export function findVenue(text: string): string | undefined {
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/📍|🏠|адрес|вул\.|ул\.|пр\.|площа|street|локація/i.test(line)) {
      const clean = stripEmoji(line).replace(/^(адреса|адрес|локація|місце)\s*[:\-–]\s*/i, '').trim();
      if (clean.length > 2) return truncate(clean, 80);
    }
  }
  return undefined;
}

function findTitle(text: string): string | null {
  const lines = text.split('\n').map((l) => stripEmoji(l).replace(/#[^\s#]+/g, '').trim());
  for (const line of lines) {
    const clean = line.replace(/^[-–—*•\s]+/, '').trim();
    if (clean.length >= 4 && !/^https?:/i.test(clean)) {
      const sentence = clean.split(/(?<=[.!?])\s/)[0] ?? clean;
      return truncate(sentence.length >= 4 ? sentence : clean, 120);
    }
  }
  return null;
}

/**
 * Turn one channel post into an Item. Returns null when there is no date to
 * hang it on, which is most reposts and announcements.
 */
export function parsePost(post: TgChannelPost, opts: { city: string; base: string; tz: string }): Item | null {
  const text = post.text?.trim();
  if (!text || text.length < 20) return null;

  const date = findDate(text, opts.base);
  if (!date) return null;
  const time = findTime(text);
  const title = findTitle(text);
  if (!title) return null;

  const price = parsePriceText(text);
  const link = text.match(/https?:\/\/\S+/)?.[0];
  const channel = post.channel.replace(/^@/, '');

  return makeItem({
    title,
    url: link ?? `https://t.me/${channel}/${post.id}`,
    city: opts.city,
    source: `${SOURCE}:@${channel}`,
    startsAt: isoInZone(date, time ?? '00:00', opts.tz),
    venue: findVenue(text),
    description: truncate(text.replace(/\s+/g, ' '), 300),
    category: classify(text) ?? undefined,
    priceMin: price.priceMin,
    priceMax: price.priceMax,
    free: price.free,
    status: /скасован|відмінен|отменен|cancel/i.test(text) ? 'cancelled' : 'unknown',
    confidence: 'low',
  });
}

/* ---------------------------------------------------------------- gramjs --- */

function sessionString(): string {
  loadEnv();
  const fromEnv = process.env['TELEGRAM_SESSION']?.trim();
  if (fromEnv) return fromEnv;
  if (existsSync(TG_SESSION_FILE)) return readFileSync(TG_SESSION_FILE, 'utf8').trim();
  return '';
}

export interface TgCredentials {
  apiId: number;
  apiHash: string;
  session: string;
}

export function credentials(): TgCredentials | { missing: string[] } {
  loadEnv();
  const missing: string[] = [];
  const apiId = Number(process.env['TELEGRAM_API_ID'] ?? 0);
  const apiHash = process.env['TELEGRAM_API_HASH'] ?? '';
  const session = sessionString();
  if (!apiId) missing.push('TELEGRAM_API_ID');
  if (!apiHash) missing.push('TELEGRAM_API_HASH');
  if (!session) missing.push('TELEGRAM_SESSION (run: npx tsx scripts/tg-login.ts)');
  return missing.length ? { missing } : { apiId, apiHash, session };
}

/** Connect a read-only GramJS client. The caller must disconnect it. */
export async function connect(creds: TgCredentials) {
  const { TelegramClient } = await import('telegram');
  const { StringSession } = await import('telegram/sessions/index.js');
  const { LogLevel } = await import('telegram/extensions/Logger.js');
  const client = new TelegramClient(new StringSession(creds.session), creds.apiId, creds.apiHash, {
    connectionRetries: 2,
    deviceModel: 'Hermes events-finder',
    appVersion: '1.0.0',
  });
  client.setLogLevel(LogLevel.ERROR);
  await client.connect();
  return client;
}

/** Read recent posts from one channel. */
export async function readChannel(
  client: Awaited<ReturnType<typeof connect>>,
  channel: string,
  sinceMs: number,
  limit = 100,
): Promise<TgChannelPost[]> {
  const posts: TgChannelPost[] = [];
  const messages = await client.getMessages(channel, { limit });
  for (const msg of messages) {
    const dateMs = (msg.date ?? 0) * 1000;
    if (dateMs && dateMs < sinceMs) continue;
    const parsed = TgChannelPostSchema.safeParse({
      id: msg.id,
      channel,
      date: msg.date,
      text: msg.message ?? '',
    });
    if (parsed.success) posts.push(parsed.data);
  }
  return posts;
}

export async function collect(ctx: SourceContext): Promise<SourceResult> {
  const cfg = loadConfig();
  const args = parseArgs();
  const override = args.get('channel');
  const channels = override
    ? override.split(',').map((c) => c.trim()).filter(Boolean)
    : (cfg.cities[ctx.city]?.telegram_channels ?? []);

  if (channels.length === 0) {
    ctx.log.info(`${SOURCE}: no channels configured for "${ctx.city}" (config.yaml → cities.${ctx.city}.telegram_channels)`);
    return { source: SOURCE, ok: true, items: [] };
  }

  const creds = credentials();
  if ('missing' in creds) {
    ctx.log.warn(`${SOURCE}: skipping — missing ${creds.missing.join(', ')}`);
    return { source: SOURCE, ok: true, items: [] };
  }

  const daysBack = args.num('days') ?? 21;
  const sinceMs = Date.now() - daysBack * 86_400_000;
  const base = today(cfg.timezone);
  const items: Item[] = [];
  let fetched = 0;

  const client = await connect(creds);
  try {
    for (const channel of channels) {
      try {
        const posts = await readChannel(client, channel, sinceMs, args.num('limit') ?? 100);
        fetched++;
        let kept = 0;
        for (const post of posts) {
          const item = parsePost(post, { city: ctx.city, base, tz: cfg.timezone });
          if (item && inWindow(item, ctx.query)) {
            items.push(item);
            kept++;
          }
          if (args.has('dump') && post.text) {
            process.stdout.write(`\n--- @${channel}/${post.id} ---\n${post.text.slice(0, 500)}\n`);
          }
        }
        ctx.log.info(`${SOURCE}: ${channel}: ${posts.length} posts, ${kept} in window`);
      } catch (err) {
        // one dead/renamed channel must not kill the rest
        ctx.log.error(`${SOURCE}: ${channel} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    await client.disconnect();
    await client.destroy().catch(() => {});
  }

  return { source: SOURCE, ok: true, items, fetched };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // keep gramjs from holding the process open after a successful run
  await runSourceCli(SOURCE, collect);
  makeLogger(SOURCE).debug('done');
  process.exit(process.exitCode ?? 0);
}
