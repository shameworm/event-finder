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
import { WORD_END, addDays, today } from './util.ts';

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
  { command: 'week', description: '🗓 Усе на цьому тижні' },
  { command: 'weekend', description: '🎉 З пʼятниці по неділю' },
  { command: 'today', description: '📅 Що сьогодні' },
  { command: 'tomorrow', description: '📅 Що завтра' },
  { command: 'places', description: '📍 Нові кавʼярні, бари та галереї' },
  { command: 'settings', description: '⚙️ Розсилки, місто і смаки' },
  { command: 'city', description: '🏙 Змінити місто' },
  { command: 'prefs', description: '🎛 Що я думаю про твої смаки' },
  { command: 'reminders', description: '⏰ Твої нагадування' },
  { command: 'help', description: '❔ Що я вмію' },
  { command: 'stop', description: '🔕 Відписатися' },
];

/**
 * The four scheduled jobs a person can switch on and off, in one place: the
 * /settings text, its buttons and the /mute command all read from this list.
 */
const OPT_INS: { key: OptIn; emoji: string; label: string; hint: string; names: string[] }[] = [
  { key: 'weekly_digest', emoji: '🗓', label: 'Тиждень', hint: 'у понеділок — що буде цього тижня', names: ['week', 'weekly', 'тиждень'] },
  { key: 'weekend_digest', emoji: '🎉', label: 'Вихідні', hint: 'у четвер — пʼятниця–неділя', names: ['weekend', 'вихідні'] },
  { key: 'follow_alerts', emoji: '⭐️', label: 'Стежу за', hint: 'нові події тих, за ким ти стежиш', names: ['follows', 'follow', 'стежу'] },
  { key: 'place_tips', emoji: '📍', label: 'Місця', hint: 'щотижня кавʼярні, бари та галереї', names: ['places', 'place', 'місця'] },
];

const COMMANDS = `<b>Що я вмію</b>

/week — усе на цьому тижні
/weekend — з пʼятниці по неділю
/today · /tomorrow — просто зараз
/places — нові кавʼярні, бари й галереї, куди варто зайти
/settings — розсилки, місто і смаки, кнопками
/city — змінити місто
/prefs — що я думаю про твої смаки
/reminders — твої нагадування 🔔
/stop — відписатися

Або просто скажи, чого хочеться:
· <i>стендап на вихідних</i>
· <i>щось цікаве у Львові на вихідних</i>
· <i>виставки наступного тижня, тільки не класика</i>

Щоб я вивчив твої смаки:
· <i>додай стендап до улюблених</i>
· <i>не люблю класичну музику</i>
· <i>слідкуй за Latexfauna</i>
· <i>максимум 800 грн</i>
· <i>я у Львові наступного тижня</i>

Відповідай 🔔 на будь-яку подію (або «🔔 3» — на третю зі списку), і я нагадаю
за добу та за три години до початку.`;

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
    [{ text: '⬅️ Назад', callback_data: 'set:back' }],
  ];
}

/** Shown under the welcome, so a new user has something to tap straight away. */
function quickActions(): InlineButton[][] {
  return [
    [
      { text: '🗓 Цей тиждень', callback_data: 'go:week' },
      { text: '🎉 Вихідні', callback_data: 'go:weekend' },
    ],
    [
      { text: '📍 Місця', callback_data: 'go:places' },
      { text: '⚙️ Налаштування', callback_data: 'go:settings' },
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
    `<b>⚙️ Налаштування</b>\n\n` +
    `🏙 Місто — <b>${escapeHtml(cityLabel(user.city))}</b>\n\n` +
    `<b>Розсилки</b>\n` +
    OPT_INS.map((o) => `${on(o.key) ? '✅' : '❌'} ${o.emoji} ${o.label} — <i>${o.hint}</i>`).join('\n') +
    `\n\nТисни кнопку, щоб змінити.`;
  return {
    text,
    inlineKeyboard: [
      ...rows(
        OPT_INS.map((o) => ({ text: `${on(o.key) ? '✅' : '❌'} ${o.label}`, callback_data: `set:${o.key}` })),
        2,
      ),
      [
        { text: '🏙 Змінити місто', callback_data: 'set:city' },
        { text: '🎛 Мої смаки', callback_data: 'set:prefs' },
      ],
      [{ text: '🔕 Відписатися', callback_data: 'set:stop' }],
    ],
  };
}

/**
 * "покажи налаштування", "мої смаки", "show my settings" — asking to see the
 * panel, which must not turn into a twenty-second scrape for "налаштування".
 */
const SHOW_SETTINGS =
  /^\s*(?:покажи|показати|show|list|які|яке)?\s*(?:my |мої |моє )?(?:налаштування|settings|смаки|уподобання|prefs|preferences)\s*\??\s*$/iu;

/** "🔔", "🔔3", "🔔 3", "remind me 2" */
export function parseBell(text: string): { bell: boolean; index?: number } {
  const bell = /🔔|🛎|⏰/u.test(text) || new RegExp(`^\\s*(bell|remind me|нагадай)${WORD_END}`, 'iu').test(text);
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
      `Ти зробив(ла) ${limit.used} пошуків за цю годину — це мій ліміт на людину, ` +
        `бо квиткові сайти треба навантажувати чемно. Розсилки за розкладом приходитимуть як завжди; спробуй трохи пізніше.`,
    );
    return 0;
  }

  await opts.reply('⏳ Шукаю…');

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
      ? `📍 Місця — ${query.cities.map((c) => cityLabel(c)).join(', ')}`
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
        ? 'Нічого не знайшлося. Спробуй ширший період («наступного тижня»), інше місто, або глянь /prefs — можливо, я щось відфільтровую.'
        : undefined,
  });
  if (failed.length && !outcome.chatGone) {
    await opts.reply(`(до речі: ${failed.join(', ')} не відповіли, тож список може бути неповним)`);
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
      await answerSearch(ctx, user, '', { from: base, to: base, label: 'сьогодні', reply });
      return;
    case 'tomorrow':
      await answerSearch(ctx, user, '', { from: addDays(base, 1), to: addDays(base, 1), label: 'завтра', reply });
      return;
    case 'places':
      await answerSearch(ctx, user, '', {
        from: base,
        to: addDays(base, 30),
        label: 'зараз відкрито',
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
    await reply('Наразі цей бот приватний. Попроси власника додати тебе.');
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
        `👋 Я знаходжу концерти, стендап, театр, виставки, лекції, вечірки та фестивалі в українських містах — і нові місця, куди варто зайти.\n\nУ якому ти місті?`,
        { keyboard: cityKeyboard() },
      );
    } else {
      await reply(`З поверненням. Твоє місто — ${escapeHtml(cityLabel(user.city))}.\n\n${COMMANDS}`, {
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
    await reply('👋 Почнімо з головного — у якому ти місті?', { keyboard: cityKeyboard() });
    return;
  }
  await ctx.store.touchUser(chatId);
  let user = existing;

  if (user.row.stage === 'city') {
    const city = resolveCity(text);
    if (!city) {
      await reply(`Я поки не знаю «${escapeHtml(text)}». Обери зі списку або попроси власника додати твоє місто.`, {
        keyboard: cityKeyboard(),
      });
      return;
    }
    user = await saveUserPrefs(ctx.store, user, { ...user.prefs, home_city: city });
    await ctx.store.setUserStage(chatId, null);
    await reply(
      `✅ Нехай буде ${escapeHtml(cityLabel(city))}.\n\nРозкажи, що тобі заходить — «стендап та інді-рок, без класики» — або просто спробуй /weekend.\n\n${COMMANDS}`,
      { removeKeyboard: true },
    );
    await reply('Обери, з чого почати:', { inlineKeyboard: quickActions() });
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
        await reply(`Зараз у тебе ${escapeHtml(cityLabel(user.city))}. Обери інше:`, { keyboard: cityKeyboard() });
        await ctx.store.setUserStage(chatId, 'city');
        return;
      }
      const city = resolveCity(rest);
      if (!city) return reply(`Я не знаю «${escapeHtml(rest)}». Напиши /city без назви, щоб побачити список.`);
      await saveUserPrefs(ctx.store, user, { ...user.prefs, home_city: city });
      return reply(`✅ Місто — ${escapeHtml(cityLabel(city))}.`);
    }

    case '/prefs':
      return reply(`<b>🎛 Що я думаю про твої смаки</b>\n<code>${escapeHtml(describePrefs(user.prefs))}</code>`);

    case '/settings': {
      const panel = settingsPanel(user);
      return reply(panel.text, { inlineKeyboard: panel.inlineKeyboard });
    }

    case '/mute':
    case '/unmute': {
      const on = command === '/unmute';
      const which = text.slice(command.length).trim().toLowerCase();
      const key = OPT_INS.find((o) => o.names.includes(which))?.key;
      if (!key) return reply('Яку саме? week, weekend, follows або places. Простіше — кнопками в /settings.');
      await ctx.store.setOptIn(chatId, key, on);
      return reply(`${on ? '🔔' : '🔕'} Розсилка «${escapeHtml(which)}» ${on ? 'увімкнена' : 'вимкнена'}.`);
    }

    case '/stop':
      await ctx.store.setBlocked(chatId, true);
      return reply('🔕 Відписано — більше нічого не надсилаю. Напиши /start, коли захочеш повернутися.');

    case '/reminders': {
      const rows = await ctx.store.listReminders(chatId);
      if (rows.length === 0) return reply('Нагадувань поки немає. Відповідай 🔔 на подію — і я поставлю.');
      return reply(
        `<b>⏰ Твої нагадування</b>\n` +
          rows
            .map((r) => `· ${escapeHtml(r.title)} — ${escapeHtml(r.starts_at.slice(0, 16).replace('T', ' '))}`)
            .join('\n'),
      );
    }

    case '/follow':
    case '/unfollow': {
      const who = text.slice(command.length).trim();
      if (!who) return reply(`За ким? Наприклад: <code>${command} Latexfauna</code>`);
      const edit = applyPrefsCommand(`${command === '/follow' ? 'follow' : 'unfollow'} ${who}`, user.prefs);
      if (edit.changes.length === 0) return reply(`Нічого міняти — ${escapeHtml(edit.note ?? 'вже так і є')}.`);
      await saveUserPrefs(ctx.store, user, edit.prefs);
      return reply(`✅ ${escapeHtml(edit.changes.join('; '))}`);
    }

    case '/stats': {
      if (!isOwner(chatId)) return reply('Ця команда — для власника бота.');
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

  if (command) return reply(`Не знаю команди ${escapeHtml(command)}.\n\n${COMMANDS}`);

  /* --- 🔔 reminder ------------------------------------------------------ */
  const { bell, index } = parseBell(text);
  if (bell) return reply(await handleBell(ctx, msg, chatId, index));

  /* --- "покажи налаштування" is a panel, not a search ------------------- */
  if (SHOW_SETTINGS.test(text)) {
    const panel = settingsPanel(user);
    return reply(panel.text, { inlineKeyboard: panel.inlineKeyboard });
  }

  /* --- a preference change, or a search -------------------------------- */
  const edit = applyPrefsCommand(text, user.prefs);
  if (edit.understood && edit.changes.length > 0) {
    await saveUserPrefs(ctx.store, user, edit.prefs);
    ctx.log.info(`chat ${chatId}: ${edit.changes.join('; ')}`);
    return reply(`✅ Записав:\n${edit.changes.map((c) => `· ${escapeHtml(c)}`).join('\n')}`);
  }
  if (edit.understood) return reply(`Нічого міняти — ${escapeHtml(edit.note ?? 'вже так і є')}.`);

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
  if (!isAllowed(chatId)) return reply('Наразі цей бот приватний. Попроси власника додати тебе.');

  const user = await getUser(ctx.store, chatId, ctx.log);
  if (!user) return reply('Напиши /start — і я все налаштую.');
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
        text: `<b>🏙 Змінити місто</b>\n\nЗараз у тебе <b>${escapeHtml(cityLabel(user.city))}</b>. Обери інше:`,
        inlineKeyboard: cityButtons(user.city),
      });

    case 'prefs':
      return draw({
        text: `<b>🎛 Що я думаю про твої смаки</b>\n<code>${escapeHtml(describePrefs(user.prefs))}</code>\n\nЩоб змінити — просто напиши: «додай джаз до улюблених», «максимум 800 грн».`,
        inlineKeyboard: [[{ text: '⬅️ Назад', callback_data: 'set:back' }]],
      });

    case 'stop':
      return draw({
        text: `<b>🔕 Відписатися?</b>\n\nБільше жодних розсилок, сповіщень і нагадувань. Місто й смаки збережуться, тож /start поверне все назад.`,
        inlineKeyboard: [
          [
            { text: '✅ Так, відписатися', callback_data: 'set:stop!' },
            { text: '⬅️ Залишити', callback_data: 'set:back' },
          ],
        ],
      });

    case 'stop!':
      await ctx.store.setBlocked(chatId, true);
      return draw({
        text: '🔕 Відписано — більше нічого не надсилаю. Напиши /start, коли захочеш повернутися.',
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
      ? 'Я вже не памʼятаю, про яку подію було те повідомлення — попроси свіжий список і відповідай на нього.'
      : 'Відповідай 🔔 на повідомлення з подією, або спершу попроси щось знайти.';
  }
  const chosen = items.length === 1 ? items[0] : index ? items[index - 1] : undefined;
  if (!chosen) {
    const list = items.slice(0, 20).map((it, i) => `${i + 1}. ${it.title}`).join('\n');
    return `У тому списку було ${items.length} подій. Яка саме? Відповідай «🔔 N».\n\n${escapeHtml(list)}`;
  }
  if (!chosen.startsAt) return `У «${escapeHtml(chosen.title)}» ще немає часу початку, тож нагадування не поставлю.`;

  const outcome = ctx.dryRun ? 'added' : await ctx.store.addReminder(chatId, chosen);
  if (outcome === 'no-date') return `У «${escapeHtml(chosen.title)}» ще немає часу початку.`;
  return `⏰ Нагадування ${outcome === 'exists' ? 'вже стоїть' : 'поставив'} — <b>${escapeHtml(chosen.title)}</b>. Нагадаю за добу та за 3 години до початку.`;
}
