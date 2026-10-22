/**
 * The conversation: everything the bot does when someone sends it a message.
 *
 * Used by `scripts/bot.ts`, both as a long-polling service and in --once
 * cron mode, so the behaviour is identical either way.
 */
import type { Item, Kind } from './types.ts';
import type { OptIn, Store } from './db.ts';
import type { Logger } from './log.ts';
import type { TgCallbackQuery, TgMessage } from './schemas.ts';
import { cityLabel, loadConfig, resolveCity } from './config.ts';
import { answerCallbackQuery, editMessageText, escapeHtml, sendMessage, type InlineButton } from './telegram-api.ts';
import { applyPrefsCommand, describePrefs } from './prefs-engine.ts';
import { parseRequest, thisWeekRange, weekendRange } from './request.ts';
import { collectCity } from './cache.ts';
import { rank } from './rank.ts';
import { deliver } from './deliver.ts';
import { getUser, isOwner, registerUser, saveUserPrefs, type BotUser } from './users.ts';
import { addDays, today } from './util.ts';

export interface HandlerContext {
  store: Store;
  log: Logger;
  dryRun?: boolean;
}

/**
 * The published command list: what Telegram autocompletes as you type "/" and
 * what sits behind the ☰ menu button. `scripts/bot.ts` uploads it on start-up.
 *
 * Commands that only make sense with an argument (/mute, /follow) or that
 * belong to the operator (/stats) stay out of the menu — they still work.
 */
export const BOT_COMMANDS: { command: string; description: string }[] = [
  { command: 'week', description: '🗓 Everything on this week' },
  { command: 'weekend', description: '🎉 Friday to Sunday' },
  { command: 'today', description: '📅 On today' },
  { command: 'tomorrow', description: '📅 On tomorrow' },
  { command: 'places', description: '📍 New cafés, bars and galleries' },
  { command: 'settings', description: '⚙️ Digests, city and taste' },
  { command: 'city', description: '🏙 Change your city' },
  { command: 'prefs', description: '🎛 What I think you like' },
  { command: 'reminders', description: '⏰ Your 🔔 list' },
  { command: 'help', description: '❔ What I can do' },
  { command: 'stop', description: '🔕 Unsubscribe' },
];

/**
 * The four scheduled jobs a person can switch on and off, in one place: the
 * /settings text, its buttons and the /mute command all read from this list.
 */
const OPT_INS: { key: OptIn; emoji: string; label: string; hint: string; names: string[] }[] = [
  { key: 'weekly_digest', emoji: '🗓', label: 'Weekly digest', hint: 'Monday — what is on this week', names: ['week', 'weekly'] },
  { key: 'weekend_digest', emoji: '🎉', label: 'Weekend picks', hint: 'Thursday — Friday to Sunday', names: ['weekend'] },
  { key: 'follow_alerts', emoji: '⭐️', label: 'Follow alerts', hint: 'new shows by people you follow', names: ['follows', 'follow'] },
  { key: 'place_tips', emoji: '📍', label: 'Place tips', hint: 'weekly cafés, bars and galleries', names: ['places', 'place'] },
];

const COMMANDS = `<b>What I can do</b>

/week — everything on this week
/weekend — Friday to Sunday
/today · /tomorrow — right now
/places — new cafés, bars, galleries worth a visit
/settings — digests, city and taste, with buttons
/city — change your city
/prefs — what I think you like
/reminders — your 🔔 list
/stop — unsubscribe

Or just tell me what you want:
· <i>stand-up this weekend</i>
· <i>щось цікаве у Львові на вихідних</i>
· <i>exhibitions next week, nothing classical</i>

To teach me your taste:
· <i>add stand-up to favourites</i>
· <i>I don't like classical music</i>
· <i>follow Latexfauna</i>
· <i>max price 800</i>
· <i>I'm in Lviv next week</i>

Reply 🔔 to any event (or "🔔 3" for the third in a list) and I will remind you
one day and three hours before it starts.`;

/* ------------------------------------------------------------- utilities --- */

function rows<T>(items: T[], perRow: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += perRow) out.push(items.slice(i, i + perRow));
  return out;
}

function cityKeyboard(): { text: string }[][] {
  return rows(Object.keys(loadConfig().cities).map((c) => ({ text: cityLabel(c) })), 2);
}

/** The same city list as inline buttons, with a tick on the one in use. */
function cityButtons(current: string): InlineButton[][] {
  const cities = Object.keys(loadConfig().cities);
  return [
    ...rows(
      cities.map((c) => ({ text: `${c === current ? '✅ ' : ''}${cityLabel(c)}`, callback_data: `city:${c}` })),
      2,
    ),
    [{ text: '⬅️ Back', callback_data: 'set:back' }],
  ];
}

/** Shown under the welcome, so a new user has something to tap straight away. */
function quickActions(): InlineButton[][] {
  return [
    [
      { text: '🗓 This week', callback_data: 'go:week' },
      { text: '🎉 Weekend', callback_data: 'go:weekend' },
    ],
    [
      { text: '📍 Places', callback_data: 'go:places' },
      { text: '⚙️ Settings', callback_data: 'go:settings' },
    ],
  ];
}

/**
 * The settings screen: current state as text, every switch as a button.
 * Rendered the same way whether it is a fresh /settings or a redraw after a tap.
 */
function settingsPanel(user: BotUser): { text: string; inlineKeyboard: InlineButton[][] } {
  const on = (key: OptIn) => Boolean(user.row[key]);
  const text =
    `<b>⚙️ Settings</b>\n\n` +
    `🏙 City — <b>${escapeHtml(cityLabel(user.city))}</b>\n\n` +
    `<b>Digests</b>\n` +
    OPT_INS.map((o) => `${on(o.key) ? '✅' : '❌'} ${o.emoji} ${o.label} — <i>${o.hint}</i>`).join('\n') +
    `\n\nTap a button to change it.`;
  return {
    text,
    inlineKeyboard: [
      ...rows(
        OPT_INS.map((o) => ({ text: `${on(o.key) ? '✅' : '❌'} ${o.label}`, callback_data: `set:${o.key}` })),
        2,
      ),
      [
        { text: '🏙 Change city', callback_data: 'set:city' },
        { text: '🎛 My taste', callback_data: 'set:prefs' },
      ],
      [{ text: '🔕 Unsubscribe', callback_data: 'set:stop' }],
    ],
  };
}

/** "🔔", "🔔3", "🔔 3", "remind me 2" */
export function parseBell(text: string): { bell: boolean; index?: number } {
  const bell = /🔔|🛎|⏰/u.test(text) || /^\s*(bell|remind me|нагадай)\b/i.test(text);
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
  (
    body: string,
    opts?: { keyboard?: { text: string }[][]; removeKeyboard?: boolean; inlineKeyboard?: InlineButton[][] },
  ): Promise<void>;
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
      inlineKeyboard: opts.inlineKeyboard,
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
    await opts.reply(
      `You have used ${limit.used} searches this hour, which is my limit per person — ` +
        `the ticket sites have to be treated politely. Your scheduled digests still arrive; try again shortly.`,
    );
    return 0;
  }

  await opts.reply('⏳ Looking…');

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

  const title =
    kinds.includes('place')
      ? `📍 Places in ${query.cities.map((c) => cityLabel(c)).join(', ')}`
      : `🗓 ${query.cities.map((c) => cityLabel(c)).join(', ')}`;

  const outcome = await deliver({
    title,
    query,
    items,
    log: ctx.log,
    store: ctx.store,
    chatId: user.chatId,
    dryRun: ctx.dryRun,
    maxPerDay: 0,
    // an on-demand answer is allowed to repeat things: they asked for it
    record: !ctx.dryRun,
    footer:
      items.length === 0
        ? 'Nothing matched. Try a wider window ("next week"), another city, or /prefs to check what I am filtering out.'
        : undefined,
  });
  if (failed.length && !outcome.chatGone) {
    await opts.reply(`(heads up: ${failed.join(', ')} did not respond, so this list may be incomplete)`);
  }
  return items.length;
}

/** The canned searches, reachable both as a command and as a quick-action button. */
export type Preset = 'week' | 'weekend' | 'today' | 'tomorrow' | 'places';

async function runPreset(ctx: HandlerContext, user: BotUser, preset: Preset, reply: Reply): Promise<void> {
  const cfg = loadConfig();
  const base = today(cfg.timezone);
  switch (preset) {
    case 'week': {
      const r = thisWeekRange(base);
      await answerSearch(ctx, user, '', { from: r.from, to: r.to, label: r.label, reply, top: cfg.digest.week_top });
      return;
    }
    case 'weekend': {
      const r = weekendRange(base);
      await answerSearch(ctx, user, '', { from: r.from, to: r.to, label: r.label, reply });
      return;
    }
    case 'today':
      await answerSearch(ctx, user, '', { from: base, to: base, label: 'today', reply });
      return;
    case 'tomorrow':
      await answerSearch(ctx, user, '', { from: addDays(base, 1), to: addDays(base, 1), label: 'tomorrow', reply });
      return;
    case 'places':
      await answerSearch(ctx, user, '', {
        from: base,
        to: addDays(base, 30),
        label: 'open now',
        kinds: ['place'],
        top: cfg.digest.places_top,
        reply,
      });
  }
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
    await reply('This bot is private at the moment. Ask its owner to add you.');
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
      await reply(
        `👋 I find concerts, stand-up, theatre, exhibitions, lectures, parties and festivals in Ukrainian cities — and new places worth a visit.\n\nWhich city are you in?`,
        { keyboard: cityKeyboard() },
      );
    } else {
      await reply(`Welcome back. Your city is ${escapeHtml(cityLabel(user.city))}.\n\n${COMMANDS}`, {
        inlineKeyboard: quickActions(),
      });
    }
    return;
  }

  const existing = await getUser(ctx.store, chatId, ctx.log);
  if (!existing) {
    // anyone who starts mid-conversation gets onboarded too
    await registerUser(ctx.store, { chatId, username: msg.from?.username ?? null });
    await ctx.store.setUserStage(chatId, 'city');
    await reply('👋 First things first — which city are you in?', { keyboard: cityKeyboard() });
    return;
  }
  await ctx.store.touchUser(chatId);
  let user = existing;

  if (user.row.stage === 'city') {
    const city = resolveCity(text);
    if (!city) {
      await reply(`I do not know "${escapeHtml(text)}" yet. Pick one of these, or ask the owner to add your city.`, {
        keyboard: cityKeyboard(),
      });
      return;
    }
    user = await saveUserPrefs(ctx.store, user, { ...user.prefs, home_city: city });
    await ctx.store.setUserStage(chatId, null);
    await reply(
      `✅ ${escapeHtml(cityLabel(city))} it is.\n\nTell me what you are into — "stand-up and indie rock, no classical" — or just try /weekend.\n\n${COMMANDS}`,
      { removeKeyboard: true },
    );
    await reply('Pick something to start with:', { inlineKeyboard: quickActions() });
    return;
  }

  /* --- commands --------------------------------------------------------- */
  switch (command) {
    case '/help':
    case '/menu':
      return reply(COMMANDS, { inlineKeyboard: quickActions() });

    case '/week':
    case '/weekend':
    case '/today':
    case '/tomorrow':
    case '/places':
      await runPreset(ctx, user, command.slice(1) as Preset, reply);
      return;

    case '/city': {
      const rest = text.slice(command.length).trim();
      if (!rest) {
        await reply(`You are in ${escapeHtml(cityLabel(user.city))}. Pick another:`, { keyboard: cityKeyboard() });
        await ctx.store.setUserStage(chatId, 'city');
        return;
      }
      const city = resolveCity(rest);
      if (!city) return reply(`I do not know "${escapeHtml(rest)}". Try /city with no name to see the list.`);
      await saveUserPrefs(ctx.store, user, { ...user.prefs, home_city: city });
      return reply(`✅ City set to ${escapeHtml(cityLabel(city))}.`);
    }

    case '/prefs':
      return reply(`<b>What I think you like</b>\n<code>${escapeHtml(describePrefs(user.prefs))}</code>`);

    case '/settings': {
      const panel = settingsPanel(user);
      return reply(panel.text, { inlineKeyboard: panel.inlineKeyboard });
    }

    case '/mute':
    case '/unmute': {
      const on = command === '/unmute';
      const which = text.slice(command.length).trim().toLowerCase();
      const key = OPT_INS.find((o) => o.names.includes(which))?.key;
      if (!key) return reply('Which one? week, weekend, follows or places. See /settings.');
      await ctx.store.setOptIn(chatId, key, on);
      return reply(`${on ? '🔔' : '🔕'} ${escapeHtml(which)} digests ${on ? 'on' : 'off'}.`);
    }

    case '/stop':
      await ctx.store.setBlocked(chatId, true);
      return reply('🔕 Unsubscribed — no more digests. Send /start whenever you want them back.');

    case '/reminders': {
      const rows = await ctx.store.listReminders(chatId);
      if (rows.length === 0) return reply('No reminders yet. Reply 🔔 to an event and I will set one.');
      return reply(
        `<b>Your reminders</b>\n` +
          rows
            .map((r) => `· ${escapeHtml(r.title)} — ${escapeHtml(r.starts_at.slice(0, 16).replace('T', ' '))}`)
            .join('\n'),
      );
    }

    case '/follow':
    case '/unfollow': {
      const who = text.slice(command.length).trim();
      if (!who) return reply(`Who? e.g. <code>${command} Latexfauna</code>`);
      const edit = applyPrefsCommand(`${command === '/follow' ? 'follow' : 'unfollow'} ${who}`, user.prefs);
      if (edit.changes.length === 0) return reply(`Nothing to change — ${escapeHtml(edit.note ?? 'already set')}.`);
      await saveUserPrefs(ctx.store, user, edit.prefs);
      return reply(`✅ ${escapeHtml(edit.changes.join('; '))}`);
    }

    case '/stats': {
      if (!isOwner(chatId)) return reply('That one is for the bot owner.');
      const s = await ctx.store.stats();
      return reply(
        `<b>Bot stats</b>\n<code>` +
          Object.entries(s)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\n') +
          `</code>`,
      );
    }
  }

  if (command) return reply(`I do not know ${escapeHtml(command)}.\n\n${COMMANDS}`);

  /* --- 🔔 reminder ------------------------------------------------------ */
  const { bell, index } = parseBell(text);
  if (bell) return reply(await handleBell(ctx, msg, chatId, index));

  /* --- a preference change, or a search -------------------------------- */
  const edit = applyPrefsCommand(text, user.prefs);
  if (edit.understood && edit.changes.length > 0) {
    await saveUserPrefs(ctx.store, user, edit.prefs);
    ctx.log.info(`chat ${chatId}: ${edit.changes.join('; ')}`);
    return reply(`✅ Noted:\n${edit.changes.map((c) => `· ${escapeHtml(c)}`).join('\n')}`);
  }
  if (edit.understood) return reply(`Nothing to change — ${escapeHtml(edit.note ?? 'already set')}.`);

  await answerSearch(ctx, user, text, { reply });
}

/* ----------------------------------------------------------- the buttons --- */

/**
 * A tap on an inline button. The callback_data is a short `kind:arg` pair:
 *
 *   go:week …     a quick action — answers with a new message
 *   set:<optin>   toggle one digest, then redraw the panel in place
 *   set:city · set:prefs · set:back · set:stop · set:stop!
 *   city:<key>    pick a city from the panel
 *
 * Everything that changes a setting rewrites the panel it was tapped from, so
 * the chat keeps one settings screen rather than a stack of confirmations.
 */
export async function handleCallback(ctx: HandlerContext, cq: TgCallbackQuery): Promise<void> {
  const chatId = cq.message ? String(cq.message.chat.id) : cq.from ? String(cq.from.id) : '';
  const messageId = cq.message?.message_id;
  const data = cq.data ?? '';
  // Telegram shows a spinner on the button until this lands, so ack first
  await answerCallbackQuery(cq.id, { dryRun: ctx.dryRun, log: ctx.log });
  if (!chatId || !data) return;

  const reply = makeReply(ctx, chatId);
  if (!isAllowed(chatId)) return reply('This bot is private at the moment. Ask its owner to add you.');

  const user = await getUser(ctx.store, chatId, ctx.log);
  if (!user) return reply('Send /start and I will set you up.');
  await ctx.store.touchUser(chatId);

  const sep = data.indexOf(':');
  const kind = sep < 0 ? data : data.slice(0, sep);
  const arg = sep < 0 ? '' : data.slice(sep + 1);

  /** Redraw the settings screen with whatever is in the database now. */
  const draw = async (screen: { text: string; inlineKeyboard: InlineButton[][] }, inPlace = true) => {
    if (inPlace && messageId) {
      await editMessageText(screen.text, {
        chatId,
        messageId,
        inlineKeyboard: screen.inlineKeyboard,
        dryRun: ctx.dryRun,
        log: ctx.log,
      });
    } else {
      await reply(screen.text, { inlineKeyboard: screen.inlineKeyboard });
    }
  };
  const drawPanel = async (inPlace = true) =>
    draw(settingsPanel((await getUser(ctx.store, chatId, ctx.log)) ?? user), inPlace);

  if (kind === 'go') {
    if (arg === 'settings') return drawPanel(false);
    if (arg === 'help') return reply(COMMANDS, { inlineKeyboard: quickActions() });
    const presets: Preset[] = ['week', 'weekend', 'today', 'tomorrow', 'places'];
    if (presets.includes(arg as Preset)) return runPreset(ctx, user, arg as Preset, reply);
    return;
  }

  if (kind === 'city') {
    if (!loadConfig().cities[arg]) return drawPanel();
    await saveUserPrefs(ctx.store, user, { ...user.prefs, home_city: arg });
    // tapping a city finishes onboarding too, if that is where they were
    if (user.row.stage === 'city') await ctx.store.setUserStage(chatId, null);
    return drawPanel();
  }

  if (kind !== 'set') return;

  const optIn = OPT_INS.find((o) => o.key === arg);
  if (optIn) {
    await ctx.store.setOptIn(chatId, optIn.key, !user.row[optIn.key]);
    return drawPanel();
  }

  switch (arg) {
    case 'city':
      return draw({
        text: `<b>🏙 Change city</b>\n\nYou are in <b>${escapeHtml(cityLabel(user.city))}</b>. Pick another:`,
        inlineKeyboard: cityButtons(user.city),
      });

    case 'prefs':
      return draw({
        text: `<b>🎛 What I think you like</b>\n<code>${escapeHtml(describePrefs(user.prefs))}</code>\n\nTell me in words to change it — "add jazz to favourites", "max price 800".`,
        inlineKeyboard: [[{ text: '⬅️ Back', callback_data: 'set:back' }]],
      });

    case 'stop':
      return draw({
        text: `<b>🔕 Unsubscribe?</b>\n\nNo more digests, alerts or reminders. Your city and taste are kept, so /start brings everything back.`,
        inlineKeyboard: [
          [
            { text: '✅ Yes, unsubscribe', callback_data: 'set:stop!' },
            { text: '⬅️ Keep them', callback_data: 'set:back' },
          ],
        ],
      });

    case 'stop!':
      await ctx.store.setBlocked(chatId, true);
      return draw({
        text: '🔕 Unsubscribed — no more digests. Send /start whenever you want them back.',
        inlineKeyboard: [],
      });

    case 'back':
      return drawPanel();
  }
}

async function handleBell(ctx: HandlerContext, msg: TgMessage, chatId: string, index?: number): Promise<string> {
  const replyTo = msg.reply_to_message?.message_id;
  const items = replyTo ? await ctx.store.itemsForMessage(chatId, replyTo) : await ctx.store.lastItemsFor(chatId);

  if (items.length === 0) {
    return replyTo
      ? 'I no longer remember which event that message was about — ask for a fresh list and reply to that.'
      : 'Reply 🔔 to an event message, or ask me for something first.';
  }
  const chosen = items.length === 1 ? items[0] : index ? items[index - 1] : undefined;
  if (!chosen) {
    const list = items.slice(0, 20).map((it, i) => `${i + 1}. ${it.title}`).join('\n');
    return `That list had ${items.length} events. Which one? Reply "🔔 N".\n\n${escapeHtml(list)}`;
  }
  if (!chosen.startsAt) return `"${escapeHtml(chosen.title)}" has no start time yet, so I cannot schedule a reminder.`;

  const outcome = ctx.dryRun ? 'added' : await ctx.store.addReminder(chatId, chosen);
  if (outcome === 'no-date') return `"${escapeHtml(chosen.title)}" has no start time yet.`;
  return `⏰ Reminder ${outcome === 'exists' ? 'already set' : 'set'} for <b>${escapeHtml(chosen.title)}</b> — I will ping you 1 day and 3 hours before.`;
}
