/**
 * The conversation: everything the bot does when someone sends it a message,
 * or puts a ❤️ on one.
 *
 * Used by `scripts/bot.ts`, both as a long-polling service and in --once
 * cron mode, so the behaviour is identical either way.
 *
 * Everything the bot says lives in src/copy.ts — it speaks Ukrainian only.
 */
import type { Item, Kind } from './types.ts';
import type { Store } from './db.ts';
import type { Logger } from './log.ts';
import type { TgMessage, TgReactionUpdate } from './schemas.ts';
import { cityLabel, loadConfig, resolveCity } from './config.ts';
import { escapeHtml, sendMessage } from './telegram-api.ts';
import { applyPrefsCommand, describePrefs, favouritesFromList } from './prefs-engine.ts';
import { canonicalTag } from './categories.ts';
import { parseRequest, thisWeekRange, weekendRange } from './request.ts';
import { collectCity } from './cache.ts';
import { rank } from './rank.ts';
import { deliver } from './deliver.ts';
import { getUser, isOwner, registerUser, saveUserPrefs, type BotUser } from './users.ts';
import { addDays, normText, today } from './util.ts';
import * as copy from './copy.ts';

export interface HandlerContext {
  store: Store;
  log: Logger;
  dryRun?: boolean;
}

/* ------------------------------------------------------------- utilities --- */

function cityKeyboard(): { text: string }[][] {
  const cities = Object.keys(loadConfig().cities);
  const rows: { text: string }[][] = [];
  for (let i = 0; i < cities.length; i += 2) {
    rows.push(cities.slice(i, i + 2).map((c) => ({ text: cityLabel(c) })));
  }
  return rows;
}

function tasteKeyboard(): { text: string }[][] {
  return [...copy.TASTE_BUTTONS.map((row) => row.map((text) => ({ text }))), [{ text: copy.TASTE_SKIP_BUTTON }]];
}

/** Anchored to the end, not followed by \b: JavaScript's \b never fires after a Cyrillic letter. */
const SKIP = /^\s*(?:пропустити|пропуск|пропусти|далі|потім|не знаю|skip)\s*[.!]?\s*$/iu;

/**
 * Every heart Telegram offers, including the uncoloured ❤ and the variation
 * selector it usually arrives with. Only hearts count: 👍 or 🔥 is applause,
 * not "remind me".
 */
const HEARTS = new Set([
  '❤', '🧡', '💛', '💚', '💙', '💜', '🤎', '🖤', '🤍', '🩷', '🩵', '🩶',
  '💖', '💗', '💓', '💞', '💕', '💘', '💝', '❣', '♥',
]);

export function isHeart(emoji: string | undefined): boolean {
  if (!emoji) return false;
  return HEARTS.has(emoji.replace(/️/gu, ''));
}

/** "❤️", "🔔", "нагадай 3" — the typed fallback for people who do not react. */
export function parseBell(text: string): { bell: boolean; index?: number } {
  const bell =
    /🔔|🛎|⏰|❤|🧡|💛|💚|💙|💜|🤍|🖤|💖|💗|💓|💞|💕|💘|💝|♥/u.test(text) ||
    // the Cyrillic alternatives get a Unicode lookahead; \b would never match after "й"
    /^\s*(?:bell\b|remind me\b|нагадай|нагадати)(?![\p{L}\p{N}])/iu.test(text);
  if (!bell) return { bell: false };
  const m = text.match(/(\d{1,2})/);
  return { bell: true, index: m ? Number(m[1]) : undefined };
}

/** Is this chat allowed to use the bot at all? */
export function isAllowed(chatId: string): boolean {
  const cfg = loadConfig();
  if (cfg.bot.public) return true;
  return cfg.bot.allowlist.includes(chatId) || isOwner(chatId);
}

/* --------------------------------------------------------------- answers --- */

interface Reply {
  (body: string, opts?: { keyboard?: { text: string }[][]; removeKeyboard?: boolean }): Promise<void>;
}

function makeReply(ctx: HandlerContext, chatId: string, replyTo?: number): Reply {
  return async (body, opts = {}) => {
    await sendMessage(body, {
      chatId,
      dryRun: ctx.dryRun,
      log: ctx.log,
      replyTo,
      keyboard: opts.keyboard,
      removeKeyboard: opts.removeKeyboard,
    });
  };
}

/**
 * Run a search for one user and send them the result.
 * Goes through the shared city cache, so several users asking the same thing
 * cost one scrape.
 */
export async function answerSearch(
  ctx: HandlerContext,
  user: BotUser,
  text: string,
  opts: { from?: string; to?: string; label?: string; kinds?: Kind[]; top?: number; reply: Reply } = { reply: async () => {} },
): Promise<number> {
  const cfg = loadConfig();
  const base = today(cfg.timezone);
  const kinds: Kind[] = opts.kinds ?? ['event'];

  const query = parseRequest(text, {
    prefs: user.prefs,
    base,
    from: opts.from,
    to: opts.to,
    kinds: opts.kinds,
  });
  if (opts.label) query.rangeLabel = opts.label;

  const limit = await ctx.store.hitRateLimit(user.chatId, cfg.bot.searches_per_hour);
  if (!limit.allowed) {
    await opts.reply(copy.rateLimited(limit.used));
    return 0;
  }

  await opts.reply(copy.LOOKING);

  const collected: Item[] = [];
  const failed: string[] = [];
  for (const city of query.cities) {
    const res = await collectCity({
      store: ctx.store,
      log: ctx.log.child(city),
      city,
      from: query.from,
      to: query.to,
      kinds,
      maxPages: cfg.bot.interactive_pages,
    });
    collected.push(...res.items);
    for (const f of res.failedSources) if (!failed.includes(f)) failed.push(f);
  }

  const ranked = rank(collected, { query, prefs: user.prefs, tz: cfg.timezone });
  const items = ranked.items.slice(0, opts.top ?? cfg.bot.max_results);

  const outcome = await deliver({
    title: kinds.includes('place') ? copy.TITLE_PLACES : copy.titleSearch(),
    query,
    items,
    log: ctx.log,
    store: ctx.store,
    chatId: user.chatId,
    dryRun: ctx.dryRun,
    maxPerDay: 0,
    // an on-demand answer is allowed to repeat things: they asked for it
    record: !ctx.dryRun,
    footer: items.length === 0 ? copy.NOTHING_FOUND_SEARCH : undefined,
  });
  if (failed.length && !outcome.chatGone) {
    await opts.reply(copy.sourcesFailed(failed.join(', ')));
  }
  return items.length;
}

/* ------------------------------------------------------------- the router --- */

export async function handleMessage(ctx: HandlerContext, msg: TgMessage): Promise<void> {
  const cfg = loadConfig();
  const chatId = String(msg.chat.id);
  const text = (msg.text ?? '').trim();
  if (!text) return;

  const reply = makeReply(ctx, chatId, msg.message_id);

  if (!isAllowed(chatId)) {
    ctx.log.warn(`rejected chat ${chatId} (not on the allowlist)`);
    await reply(copy.PRIVATE_BOT);
    return;
  }

  const base = today(cfg.timezone);
  const command = text.startsWith('/') ? (text.split(/[\s@]/)[0] ?? '').toLowerCase() : '';

  /* --- /start and onboarding ------------------------------------------- */
  if (command === '/start') {
    const { user, created } = await registerUser(ctx.store, {
      chatId,
      username: msg.from?.username ?? null,
      firstName: msg.from?.username ?? null,
    });
    if (created || user.row.stage === 'city') {
      await ctx.store.setUserStage(chatId, 'city');
      await reply(copy.WELCOME, { keyboard: cityKeyboard() });
    } else {
      await reply(`${copy.welcomeBack(escapeHtml(cityLabel(user.city)))}\n\n${copy.COMMANDS}`, { removeKeyboard: true });
    }
    return;
  }

  const existing = await getUser(ctx.store, chatId, ctx.log);
  if (!existing) {
    // anyone who starts mid-conversation gets onboarded too
    await registerUser(ctx.store, { chatId, username: msg.from?.username ?? null });
    await ctx.store.setUserStage(chatId, 'city');
    await reply(copy.WELCOME_SHORT, { keyboard: cityKeyboard() });
    return;
  }
  await ctx.store.touchUser(chatId);
  let user = existing;

  if (user.row.stage === 'city') {
    const city = resolveCity(text);
    if (!city) {
      await reply(copy.cityUnknown(escapeHtml(text)), { keyboard: cityKeyboard() });
      return;
    }
    user = await saveUserPrefs(ctx.store, user, { ...user.prefs, home_city: city });
    await ctx.store.setUserStage(chatId, 'taste');
    await reply(`${copy.citySet(escapeHtml(cityLabel(city)))}\n\n${copy.TASTE_ASK}`, { keyboard: tasteKeyboard() });
    return;
  }

  if (user.row.stage === 'taste') {
    if (SKIP.test(text)) {
      await ctx.store.setUserStage(chatId, null);
      await reply(`${copy.TASTE_SKIPPED}\n\n${copy.COMMANDS}`, { removeKeyboard: true });
      return;
    }
    // "не люблю класику" is a full command and still goes through the parser;
    // a bare list ("стендап, джаз") only makes sense because we just asked
    const sentence = applyPrefsCommand(text, user.prefs);
    const edit = sentence.understood ? sentence : favouritesFromList(text, user.prefs);
    if (!edit.understood) {
      await reply(copy.TASTE_UNCLEAR, { keyboard: tasteKeyboard() });
      return;
    }
    // they answered the question, so onboarding is over either way — even when
    // what they said was already true and there was nothing to store
    if (edit.changes.length > 0) user = await saveUserPrefs(ctx.store, user, edit.prefs);
    await ctx.store.setUserStage(chatId, null);
    ctx.log.info(`chat ${chatId} onboarded: ${edit.changes.join('; ') || 'no change'}`);
    const head =
      edit.changes.length > 0
        ? copy.tasteNoted(edit.changes.map(escapeHtml))
        : copy.nothingToChange(escapeHtml(edit.note ?? copy.prefsNote.alreadySet));
    await reply(`${head}\n\n${copy.COMMANDS}`, { removeKeyboard: true });
    return;
  }

  /* --- commands --------------------------------------------------------- */
  switch (command) {
    case '/help':
      return reply(copy.COMMANDS);

    case '/week': {
      const r = thisWeekRange(base);
      await answerSearch(ctx, user, '', { from: r.from, to: r.to, label: r.label, reply, top: cfg.digest.week_top });
      return;
    }
    case '/weekend': {
      const r = weekendRange(base);
      await answerSearch(ctx, user, '', { from: r.from, to: r.to, label: r.label, reply });
      return;
    }
    case '/today':
      await answerSearch(ctx, user, '', { from: base, to: base, label: copy.RANGE.today, reply });
      return;
    case '/tomorrow':
      await answerSearch(ctx, user, '', { from: addDays(base, 1), to: addDays(base, 1), label: copy.RANGE.tomorrow, reply });
      return;
    case '/places':
      await answerSearch(ctx, user, '', {
        from: base,
        to: addDays(base, 30),
        label: copy.RANGE.openNow,
        kinds: ['place'],
        top: cfg.digest.places_top,
        reply,
      });
      return;

    case '/city': {
      const rest = text.slice(command.length).trim();
      if (!rest) {
        await reply(copy.welcomeBack(escapeHtml(cityLabel(user.city))), { keyboard: cityKeyboard() });
        await ctx.store.setUserStage(chatId, 'city');
        return;
      }
      const city = resolveCity(rest);
      if (!city) return reply(copy.cityUnknownShort(escapeHtml(rest)));
      await saveUserPrefs(ctx.store, user, { ...user.prefs, home_city: city });
      return reply(copy.citySet(escapeHtml(cityLabel(city))));
    }

    case '/prefs':
      return reply(`${copy.PREFS_HEAD}\n<code>${escapeHtml(describePrefs(user.prefs))}</code>`);

    case '/settings': {
      const r = user.row;
      const flag = (n: number) => (n ? '✅' : '❌');
      return reply(
        `${copy.SETTINGS_HEAD}\n` +
          copy.SETTINGS_BODY({
            week: flag(r.weekly_digest),
            weekend: flag(r.weekend_digest),
            follows: flag(r.follow_alerts),
            places: flag(r.place_tips),
          }),
      );
    }

    case '/mute':
    case '/unmute': {
      const on = command === '/unmute';
      const which = text.slice(command.length).trim().toLowerCase();
      const map: Record<string, 'weekly_digest' | 'weekend_digest' | 'follow_alerts' | 'place_tips'> = {
        week: 'weekly_digest',
        weekly: 'weekly_digest',
        weekend: 'weekend_digest',
        follows: 'follow_alerts',
        follow: 'follow_alerts',
        places: 'place_tips',
      };
      const key = map[which];
      if (!key) return reply(copy.MUTE_WHICH);
      await ctx.store.setOptIn(chatId, key, on);
      return reply(copy.muteDone(escapeHtml(which), on));
    }

    case '/stop':
      await ctx.store.setBlocked(chatId, true);
      return reply(copy.STOPPED);

    case '/reminders': {
      const rows = await ctx.store.listReminders(chatId);
      if (rows.length === 0) return reply(copy.NO_REMINDERS);
      return reply(
        `${copy.REMINDERS_HEAD}\n` +
          rows
            .map((r) => `· ${escapeHtml(r.title)} — ${escapeHtml(r.starts_at.slice(0, 16).replace('T', ' '))}`)
            .join('\n'),
      );
    }

    case '/follow':
    case '/unfollow': {
      const who = text.slice(command.length).trim();
      if (!who) return reply(copy.followWho(command));
      const edit = applyPrefsCommand(`${command === '/follow' ? 'follow' : 'unfollow'} ${who}`, user.prefs);
      if (edit.changes.length === 0) return reply(copy.nothingToChange(escapeHtml(edit.note ?? copy.prefsNote.alreadySet)));
      await saveUserPrefs(ctx.store, user, edit.prefs);
      return reply(copy.noted(edit.changes.map(escapeHtml)));
    }

    case '/stats': {
      if (!isOwner(chatId)) return reply(copy.OWNER_ONLY);
      const s = await ctx.store.stats();
      return reply(
        `${copy.STATS_HEAD}\n<code>` +
          Object.entries(s)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\n') +
          `</code>`,
      );
    }
  }

  if (command) return reply(`${copy.unknownCommand(escapeHtml(command))}\n\n${copy.COMMANDS}`);

  /* --- a typed reminder request ---------------------------------------- */
  const { bell, index } = parseBell(text);
  if (bell) return reply(await handleBell(ctx, msg, chatId, index));

  /* --- a preference change, or a search -------------------------------- */
  const edit = applyPrefsCommand(text, user.prefs);
  if (edit.understood && edit.changes.length > 0) {
    await saveUserPrefs(ctx.store, user, edit.prefs);
    ctx.log.info(`chat ${chatId}: ${edit.changes.join('; ')}`);
    return reply(copy.noted(edit.changes.map(escapeHtml)));
  }
  if (edit.understood) return reply(copy.nothingToChange(escapeHtml(edit.note ?? copy.prefsNote.alreadySet)));

  await answerSearch(ctx, user, text, { reply });
}

/* --------------------------------------------------------------- the heart --- */

/**
 * Someone put a ❤️ on one of our messages, or took one off.
 *
 * Every event goes out as its own message (src/deliver.ts), so the message id
 * names exactly one event and there is nothing to disambiguate. A heart sets
 * the reminder and teaches the taste model; removing it cancels the reminder
 * but keeps what was learned — they were interested, plans just changed.
 *
 * Reactions on anything we do not recognise are met with silence: Telegram
 * sends an update for every reaction in the chat, and a bot that answers all
 * of them is a bot people mute.
 */
export async function handleReaction(ctx: HandlerContext, update: TgReactionUpdate): Promise<void> {
  const chatId = String(update.chat.id);
  if (!isAllowed(chatId)) return;

  const had = update.old_reaction.some((r) => isHeart(r.emoji));
  const has = update.new_reaction.some((r) => isHeart(r.emoji));
  if (had === has) return;

  const user = await getUser(ctx.store, chatId, ctx.log);
  if (!user) return;

  const items = await ctx.store.itemsForMessage(chatId, update.message_id);
  if (items.length === 0) return;

  const reply = makeReply(ctx, chatId, update.message_id);
  // a digest header, or an old-style message that covered a whole list
  if (items.length > 1) return reply(copy.HEART_ON_EVENT);
  const item = items[0]!;

  if (!has) {
    await ctx.store.cancelReminder(chatId, item.id);
    ctx.log.info(`chat ${chatId} un-hearted "${item.title}"`);
    return reply(copy.reminderCleared(escapeHtml(item.title)));
  }

  if (!item.startsAt) return reply(copy.reminderNoDate(escapeHtml(item.title)));

  const outcome = await ctx.store.addReminder(chatId, item);
  if (outcome === 'no-date') return reply(copy.reminderNoDate(escapeHtml(item.title)));

  const learned = await learnFromHeart(ctx, user, item);
  ctx.log.info(`chat ${chatId} hearted "${item.title}" (reminder ${outcome}${learned ? `, learned ${learned}` : ''})`);
  const said = outcome === 'exists' ? copy.reminderAlready(escapeHtml(item.title)) : copy.reminderSet(escapeHtml(item.title));
  return reply(learned ? `${said}\n${copy.tasteLearned(escapeHtml(learned))}` : said);
}

/**
 * A heart is a free sample of someone's taste, so take it: the event's category
 * joins their favourites (an interesting place joins their interests).
 * Returns the tag that was learned, or null when there was nothing new.
 */
async function learnFromHeart(ctx: HandlerContext, user: BotUser, item: Item): Promise<string | null> {
  const tag = canonicalTag(item.category);
  if (!tag) return null;
  const has = (list: string[]) => list.some((v) => normText(v) === normText(tag));
  if (has(user.prefs.disliked_categories)) return null;

  if (item.kind === 'place') {
    if (has(user.prefs.interests)) return null;
    await saveUserPrefs(ctx.store, user, { ...user.prefs, interests: [...user.prefs.interests, tag] });
  } else {
    if (has(user.prefs.favourite_categories)) return null;
    await saveUserPrefs(ctx.store, user, {
      ...user.prefs,
      favourite_categories: [...user.prefs.favourite_categories, tag],
    });
  }
  return tag;
}

async function handleBell(ctx: HandlerContext, msg: TgMessage, chatId: string, index?: number): Promise<string> {
  const replyTo = msg.reply_to_message?.message_id;
  const items = replyTo ? await ctx.store.itemsForMessage(chatId, replyTo) : await ctx.store.lastItemsFor(chatId);

  if (items.length === 0) return replyTo ? copy.HEART_FORGOTTEN : copy.HEART_NOTHING_YET;

  const chosen = items.length === 1 ? items[0] : index ? items[index - 1] : undefined;
  if (!chosen) {
    const list = items.slice(0, 20).map((it, i) => `${i + 1}. ${it.title}`).join('\n');
    return copy.whichOne(items.length, escapeHtml(list));
  }
  if (!chosen.startsAt) return copy.reminderNoDate(escapeHtml(chosen.title));

  const outcome = await ctx.store.addReminder(chatId, chosen);
  if (outcome === 'no-date') return copy.reminderNoDate(escapeHtml(chosen.title));

  const user = await getUser(ctx.store, chatId, ctx.log);
  const learned = user ? await learnFromHeart(ctx, user, chosen) : null;
  const said = outcome === 'exists' ? copy.reminderAlready(escapeHtml(chosen.title)) : copy.reminderSet(escapeHtml(chosen.title));
  return learned ? `${said}\n${copy.tasteLearned(escapeHtml(learned))}` : said;
}
