/**
 * The conversation: everything the bot does when someone sends it a message,
 * taps one of its buttons, or puts a ❤️ on one of its event messages.
 *
 * Used by `scripts/bot.ts`, both as a long-polling service and in --once
 * cron mode, so the behaviour is identical either way.
 */
import type { Item, Kind } from './types.ts';
import type { OptIn, Store } from './db.ts';
import type { Logger } from './log.ts';
import type { TgCallbackQuery, TgMessage, TgReactionUpdate } from './schemas.ts';
import { cityLabel, loadConfig, resolveCity } from './config.ts';
import { answerCallbackQuery, deleteMessage, editMessageCaption, editMessageText, escapeHtml, sendMessage, type InlineButton } from './telegram-api.ts';
import { applyPrefsCommand, applyThumbsDown, describePrefs, favouritesFromList } from './prefs-engine.ts';
import { CATEGORY_LABEL, DISLIKE_SUGGESTIONS, EMOJI, EVENT_CATEGORIES, canonicalTag, tagLabel } from './categories.ts';
import { parseRequest, thisWeekRange, weekendRange } from './request.ts';
import { collectCity } from './cache.ts';
import { rank } from './rank.ts';
import { deliver } from './deliver.ts';
import { countEvents, eventKeyboard, moreButton, renderCaption, renderItem, renderReminders } from './render.ts';
import { getUser, isOwner, registerUser, saveUserPrefs, type BotUser } from './users.ts';
import { DIGEST_DAYS, DIGEST_HOURS, FREQUENCIES, describeSchedule, hourLabel, isFrequency } from './schedule.ts';
import { WORD_END, addDays, normText, today } from './util.ts';

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
  { command: 'settings', description: '⚙️ Розсилки, година, місто і смаки' },
  { command: 'setup', description: '🎛 Налаштувати смаки кнопками' },
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
  { key: 'weekly_digest', emoji: '🗓', label: 'Тиждень', hint: 'що буде цього тижня', names: ['week', 'weekly', 'тиждень'] },
  { key: 'weekend_digest', emoji: '🎉', label: 'Вихідні', hint: 'у четвер — пʼятниця–неділя', names: ['weekend', 'вихідні'] },
  { key: 'follow_alerts', emoji: '⭐️', label: 'Стежу за', hint: 'нові події тих, за ким ти стежиш', names: ['follows', 'follow', 'стежу'] },
  { key: 'place_tips', emoji: '📍', label: 'Місця', hint: 'щотижня кавʼярні, бари та галереї', names: ['places', 'place', 'місця'] },
];

const COMMANDS = `<b>Що я вмію</b>

/week — усе на цьому тижні
/weekend — з пʼятниці по неділю
/today · /tomorrow — просто зараз
/places — нові кавʼярні, бари й галереї, куди варто зайти
/settings — розсилки, коли писати, місто і смаки, кнопками
/setup — зібрати смаки заново, крок за кроком
/city — змінити місто
/prefs — що я думаю про твої смаки
/reminders — твої нагадування ⏰
/stop — відписатися

Або просто скажи, чого хочеться:
· <i>стендап на вихідних</i>
· <i>щось цікаве у Львові на вихідних</i>
· <i>виставки наступного тижня, тільки не класика</i>

Щоб я вивчив твої смаки:
· <i>додай стендап до улюблених</i>
· <i>не люблю класичну музику</i>
· <i>слідкуй за Latexfauna</i>
· <i>додай Київ до міст</i>
· <i>максимум 800 грн</i>
· <i>я у Львові наступного тижня</i>

Тапни ❤️ на події — і я нагадаю за добу та за три години до початку, а ще
запамʼятаю, що таке тобі заходить. Знімеш ❤️ — скасую нагадування.`;

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

/* ------------------------------------------------------- the walkthrough --- */

/**
 * The /start walkthrough: where a new person's taste comes from, now that they
 * no longer inherit the operator's (see `newUserPrefs`).
 *
 * The current step lives in `users.stage`. Every screen draws its ticks from
 * the *stored* preferences rather than from any in-memory wizard state — which
 * is what lets /settings reopen the very same screens later to change one
 * thing, and what makes an interrupted walkthrough pick up where it stopped.
 */
const STEPS = ['city', 'likes', 'dislikes', 'budget', 'follow'] as const;
type Step = (typeof STEPS)[number];
/** Every step but the city, which is a reply keyboard rather than a screen. */
type TasteStep = Exclude<Step, 'city'>;

const BUDGETS = [500, 1000, 2000];

function isStep(stage: string | null): stage is Step {
  return Boolean(stage && (STEPS as readonly string[]).includes(stage));
}

function isTasteStep(value: string): value is TasteStep {
  return isStep(value) && value !== 'city';
}

/**
 * The step someone is parked on, or null if they are not mid-walkthrough.
 *
 * `taste` was the one-question version of all this; anyone still sitting on it
 * when the screens arrived is simply at the first of them.
 */
function stepOf(stage: string | null): Step | null {
  if (stage === 'taste') return 'likes';
  return isStep(stage) ? stage : null;
}

function nextStep(step: Step): Step | undefined {
  return STEPS[STEPS.indexOf(step) + 1];
}

interface Screen {
  text: string;
  inlineKeyboard: InlineButton[][];
}

/**
 * Walkthrough or /settings? Read off the stage, so no button has to carry it:
 * someone with a step in `stage` is mid-walkthrough, anyone else is editing.
 */
function modeOf(user: BotUser): 'wizard' | 'settings' {
  return stepOf(user.row.stage) ? 'wizard' : 'settings';
}

/** The row under a step: onwards in the walkthrough, back in /settings. */
function footRow(step: TasteStep, mode: 'wizard' | 'settings'): InlineButton[] {
  if (mode === 'settings') return [{ text: '⬅️ Назад', callback_data: 'onb:taste' }];
  return [
    { text: nextStep(step) ? 'Далі →' : 'Готово ✅', callback_data: 'onb:next' },
    { text: 'Пропустити', callback_data: 'onb:skip' },
  ];
}

const tick = (on: boolean, label: string) => `${on ? '✅' : '▫️'} ${label}`;

/** Tags are stored as canonical keys, but cased however the person typed them. */
function hasTag(list: string[], tag: string): boolean {
  return list.some((v) => v.toLowerCase() === tag.toLowerCase());
}

/**
 * One taste screen — the same thing whether it is a step of the walkthrough or
 * a visit from /settings.
 */
function tasteScreen(user: BotUser, step: TasteStep, mode = modeOf(user)): Screen {
  const p = user.prefs;
  // the city is asked before the count starts, so /setup can skip it honestly
  const head = mode === 'wizard' ? ` <i>${STEPS.indexOf(step)}/${STEPS.length - 1}</i>` : '';
  const now = (list: string[]) => (list.length ? `\n\nЗараз: <b>${escapeHtml(list.map(tagLabel).join(', '))}</b>` : '');

  switch (step) {
    case 'likes':
      return {
        text: `<b>🎛 Що тобі заходить?</b>${head}\n\nТисни все, що твоє — я підніматиму це вище у списках.${now(p.favourite_categories)}`,
        inlineKeyboard: [
          ...rows(
            EVENT_CATEGORIES.filter((c) => c !== 'other').map((c) => ({
              text: tick(hasTag(p.favourite_categories, c), `${EMOJI[c]} ${CATEGORY_LABEL[c]}`),
              callback_data: `onb:like:${c}`,
            })),
            2,
          ),
          footRow(step, mode),
        ],
      };

    case 'dislikes':
      return {
        text: `<b>🚫 Чого не показувати?</b>${head}\n\nЦе я викидатиму зі списків — крім тих, за ким ти стежиш.${now(p.disliked_categories)}`,
        inlineKeyboard: [
          ...rows(
            DISLIKE_SUGGESTIONS.map((t) => ({
              text: tick(hasTag(p.disliked_categories, t), tagLabel(t)),
              callback_data: `onb:dis:${t}`,
            })),
            2,
          ),
          footRow(step, mode),
        ],
      };

    case 'budget':
      return {
        text:
          `<b>💸 Максимум за квиток?</b>${head}\n\nДорожче не показуватиму. ` +
          (mode === 'wizard' ? 'Напиши своє число, якщо цих не досить.' : 'Або напиши «<i>максимум 800 грн</i>».') +
          `\n\nЗараз: <b>${p.max_ticket_price ? `${p.max_ticket_price} ${escapeHtml(p.currency)}` : 'без обмежень'}</b>`,
        inlineKeyboard: [
          ...rows(
            [
              ...BUDGETS.map((n) => ({ text: tick(p.max_ticket_price === n, `до ${n}`), callback_data: `onb:budget:${n}` })),
              { text: tick(p.max_ticket_price === null, 'без ліміту'), callback_data: 'onb:budget:none' },
            ],
            2,
          ),
          footRow(step, mode),
        ],
      };

    case 'follow':
      return {
        text:
          `<b>⭐️ За ким стежити?</b>${head}\n\n` +
          (mode === 'wizard'
            ? 'Напиши імена через кому — <i>Антон Тимошенко, Latexfauna</i>. '
            : 'Щоб додати — напиши «<i>слідкуй за Latexfauna</i>». ') +
          'Їх я шукаю окремо й повідомляю одразу, щойно оголосять виступ — навіть якщо квиток дорожчий за твій ліміт.' +
          (p.follow.length ? `\n\nЗараз: <b>${escapeHtml(p.follow.join(', '))}</b> — тисни, щоб прибрати.` : ''),
        inlineKeyboard: [
          ...rows(
            p.follow.map((name, i) => ({ text: `❌ ${name}`, callback_data: `onb:unfollow:${i}` })),
            2,
          ),
          footRow(step, mode),
        ],
      };
  }
}

/** /settings → 🎛 Мої смаки: the summary, with a way into each screen. */
function tasteMenu(user: BotUser): Screen {
  return {
    text:
      `<b>🎛 Мої смаки</b>\n<code>${escapeHtml(describePrefs(user.prefs))}</code>\n\n` +
      `Тисни, щоб змінити — або просто напиши «<i>додай джаз до улюблених</i>».`,
    inlineKeyboard: [
      [
        { text: '🎛 Улюблене', callback_data: 'onb:step:likes' },
        { text: '🚫 Небажане', callback_data: 'onb:step:dislikes' },
      ],
      [
        { text: '💸 Бюджет', callback_data: 'onb:step:budget' },
        { text: '⭐️ Стежу за', callback_data: 'onb:step:follow' },
      ],
      [{ text: '⬅️ Назад', callback_data: 'set:back' }],
    ],
  };
}

const setupOfferedKey = (chatId: string) => `setup_offered:${chatId}`;

/**
 * Offer the walkthrough once to someone who registered before it existed and
 * therefore still carries the operator's old taste. Declining is remembered.
 *
 * The flag lives in the `state` table rather than a new users column, because
 * `bootstrap` only ever runs `CREATE TABLE IF NOT EXISTS` — a new column would
 * never reach a database that already exists.
 */
async function offerSetup(ctx: HandlerContext, user: BotUser, reply: Reply): Promise<void> {
  if (stepOf(user.row.stage)) return;
  const key = setupOfferedKey(user.chatId);
  if (await ctx.store.getState(key)) return;
  // written before the send, so a flaky send can never turn into a nag
  await ctx.store.setState(key, new Date().toISOString());
  await reply(
    `<b>👋 Тепер смаки можна налаштувати кнопками.</b>\n\n` +
      `Раніше новим людям діставались чужі налаштування — твої, можливо, досі такі. Пройдемося?`,
    {
      inlineKeyboard: [
        [
          { text: '🎛 Налаштувати', callback_data: 'onb:start' },
          { text: 'Не зараз', callback_data: 'onb:later' },
        ],
      ],
    },
  );
}

/** Put someone on a step and show it as a new message. */
async function showStep(ctx: HandlerContext, user: BotUser, step: Step, reply: Reply, lead = ''): Promise<void> {
  await ctx.store.setUserStage(user.chatId, step);
  if (step === 'city') {
    await reply(`${lead}<b>🏙 У якому ти місті?</b>`, { keyboard: cityKeyboard() });
    return;
  }
  const screen = tasteScreen(user, step, 'wizard');
  await reply(lead + screen.text, { inlineKeyboard: screen.inlineKeyboard });
}

/** End the walkthrough: clear the stage, then show what was recorded. */
async function finishWizard(ctx: HandlerContext, chatId: string, show: (screen: Screen) => Promise<void>): Promise<void> {
  await ctx.store.setUserStage(chatId, null);
  await ctx.store.setState(setupOfferedKey(chatId), new Date().toISOString());
  const user = await getUser(ctx.store, chatId, ctx.log);
  if (!user) return;
  await show({
    text:
      `<b>✅ Готово.</b> Ось що я запамʼятав:\n<code>${escapeHtml(describePrefs(user.prefs))}</code>\n\n` +
      `Змінити будь-коли — /settings. Поїхали:`,
    inlineKeyboard: quickActions(),
  });
}

/** Walkthrough: move on from a step, redrawing the same message. */
async function advanceInPlace(
  ctx: HandlerContext,
  chatId: string,
  from: Step,
  draw: (screen: Screen) => Promise<void>,
): Promise<void> {
  const after = nextStep(from);
  if (!after || !isTasteStep(after)) return finishWizard(ctx, chatId, draw);
  await ctx.store.setUserStage(chatId, after);
  const fresh = await getUser(ctx.store, chatId, ctx.log);
  if (fresh) await draw(tasteScreen(fresh, after, 'wizard'));
}

/** Tap a category on or off, keeping favourites and dislikes exclusive. */
async function toggleTaste(ctx: HandlerContext, user: BotUser, kind: 'like' | 'dislike', tag: string): Promise<void> {
  const drop = (list: string[]) => list.filter((v) => v.toLowerCase() !== tag.toLowerCase());
  const liking = kind === 'like';
  const mine = liking ? user.prefs.favourite_categories : user.prefs.disliked_categories;
  const other = liking ? user.prefs.disliked_categories : user.prefs.favourite_categories;
  const next = hasTag(mine, tag) ? drop(mine) : [...drop(mine), tag];
  await saveUserPrefs(ctx.store, user, {
    ...user.prefs,
    favourite_categories: liking ? next : drop(other),
    disliked_categories: liking ? drop(other) : next,
  });
}

/** "готово", "далі", "skip" — leaving a step by typing instead of tapping. */
const STEP_DONE = /^\s*(?:готово|далі|дальше|пропустити|next|skip|done|ok|—|-)\s*$/iu;

/**
 * A typed message while the walkthrough is open. Nothing here may fall through
 * to `answerSearch`: typing "Антон Тимошенко" at the follow step must add a
 * name, not start a twenty-second scrape of every ticket site.
 */
async function handleStepText(
  ctx: HandlerContext,
  user: BotUser,
  step: Step,
  text: string,
  reply: Reply,
): Promise<void> {
  const show = (screen: Screen) => reply(screen.text, { inlineKeyboard: screen.inlineKeyboard });

  if (step === 'city') {
    const city = resolveCity(text);
    if (!city) {
      await reply(`Я поки не знаю «${escapeHtml(text)}». Обери зі списку або попроси власника додати твоє місто.`, {
        keyboard: cityKeyboard(),
      });
      return;
    }
    const next = await saveUserPrefs(ctx.store, user, { ...user.prefs, home_city: city });
    // the city keyboard has to go before an inline one can arrive
    await reply(`✅ Нехай буде ${escapeHtml(cityLabel(city))}.`, { removeKeyboard: true });
    await showStep(ctx, next, 'likes', reply);
    return;
  }

  const onwards = async (from: BotUser) => {
    const after = nextStep(step);
    return after ? showStep(ctx, from, after, reply) : finishWizard(ctx, from.chatId, show);
  };

  if (STEP_DONE.test(text)) return onwards(user);

  // a sentence still works mid-walkthrough, and wins: "не люблю класику" at the
  // follow step is a dislike, not the name of a band to watch for
  const edit = applyPrefsCommand(text, user.prefs);
  if (edit.understood && edit.changes.length > 0) {
    const changed = await saveUserPrefs(ctx.store, user, edit.prefs);
    await reply(`✅ Записав:\n${edit.changes.map((c) => `· ${escapeHtml(c)}`).join('\n')}`);
    return show(tasteScreen(changed, step, 'wizard'));
  }

  // a bare list at the likes screen is an answer too — "стендап, джаз" — and it
  // adds to whatever is already ticked rather than replacing it
  if (step === 'likes') {
    const listed = favouritesFromList(text, user.prefs);
    if (listed.understood) {
      const merged = [...user.prefs.favourite_categories];
      for (const tag of listed.prefs.favourite_categories) if (!hasTag(merged, tag)) merged.push(tag);
      const next = await saveUserPrefs(ctx.store, user, { ...user.prefs, favourite_categories: merged });
      await reply(`✅ Записав: ${escapeHtml(merged.map(tagLabel).join(', '))}`);
      return show(tasteScreen(next, step, 'wizard'));
    }
  }

  if (step === 'follow') {
    const names = text.split(/[,;\n]+/).map((n) => n.trim()).filter((n) => n.length >= 2);
    if (names.length === 0) return show(tasteScreen(user, step, 'wizard'));
    const follow = [...user.prefs.follow];
    const added = names.filter((n) => !follow.some((f) => normText(f) === normText(n)));
    const next = await saveUserPrefs(ctx.store, user, { ...user.prefs, follow: [...follow, ...added] });
    await reply(added.length ? `⭐️ Стежу за: ${escapeHtml(added.join(', '))}` : 'За ними я вже стежу.');
    return show(tasteScreen(next, step, 'wizard'));
  }

  if (step === 'budget') {
    const digits = text.replace(/\D+/g, '');
    if (digits && Number(digits) > 0) {
      const next = await saveUserPrefs(ctx.store, user, { ...user.prefs, max_ticket_price: Number(digits) });
      await reply(`💸 Максимум — ${escapeHtml(digits)} ${escapeHtml(next.prefs.currency)}.`);
      return onwards(next);
    }
  }

  return show(tasteScreen(user, step, 'wizard'));
}

/* ------------------------------------------------------------- schedule --- */

/**
 * The quiet-hours windows on offer. A free pair of dials would be four taps
 * and a lot of screens for a setting nobody wants to fine-tune; these cover
 * "I go to bed early", "I go to bed late" and "do not bother".
 */
const QUIET_PRESETS: { from: number; to: number; label: string }[] = [
  { from: 0, to: 0, label: 'вимкнено' },
  { from: 22, to: 8, label: '22:00–08:00' },
  { from: 23, to: 8, label: '23:00–08:00' },
  { from: 0, to: 9, label: '00:00–09:00' },
];

/**
 * "Коли писати" — the hour, the day, how often, and the quiet window.
 *
 * Only six hours are offered, and that is a deliberate limit rather than a
 * shortage of buttons: every distinct hour someone picks is another fan-out
 * that re-scrapes the cities it covers. See src/schedule.ts.
 */
function schedulePanel(user: BotUser): Screen {
  const s = user.schedule;
  const text =
    `<b>🕘 Коли писати</b>\n\n` +
    `Зараз: <b>${escapeHtml(describeSchedule(s))}</b>\n\n` +
    `<b>Година</b> — о котрій приходить дайджест.\n` +
    `<b>День</b> — коли приходить тижневий (вихідні — завжди в четвер).\n` +
    `<b>Частота</b> — ${FREQUENCIES.map((f) => `<i>${escapeHtml(f.label.toLowerCase())}</i> — ${escapeHtml(f.hint)}`).join('; ')}.\n` +
    `<b>Тихі години</b> — не пишу нічого несподіваного. Дайджест о ` +
    `${hourLabel(s.hour)} це не скасовує — ти сам його попросив, — ` +
    `і нагадування «за ~3 години» теж приходить завжди, інакше від нього нуль сенсу.`;
  return {
    text,
    inlineKeyboard: [
      ...rows(
        DIGEST_HOURS.map((h) => ({ text: tick(s.hour === h, hourLabel(h)), callback_data: `when:hour:${h}` })),
        3,
      ),
      ...rows(
        DIGEST_DAYS.map((d) => ({ text: tick(s.day === d.day, d.short), callback_data: `when:day:${d.day}` })),
        4,
      ),
      ...FREQUENCIES.map((f) => [{ text: tick(s.frequency === f.key, f.label), callback_data: `when:freq:${f.key}` }]),
      ...rows(
        QUIET_PRESETS.map((q) => ({
          text: tick(s.quietFrom === q.from && s.quietTo === q.to, `🔇 ${q.label}`),
          callback_data: `when:quiet:${q.from}-${q.to}`,
        })),
        2,
      ),
      [{ text: '⬅️ Назад', callback_data: 'set:back' }],
    ],
  };
}

/**
 * The settings screen: current state as text, every switch as a button.
 * Rendered the same way whether it is a fresh /settings or a redraw after a tap.
 */
function settingsPanel(user: BotUser): { text: string; inlineKeyboard: InlineButton[][] } {
  const on = (key: OptIn) => Boolean(user.row[key]);
  const text =
    `<b>⚙️ Налаштування</b>\n\n` +
    `🏙 Місто — <b>${escapeHtml(cityLabel(user.city))}</b>\n` +
    `🕘 Коли — <b>${escapeHtml(describeSchedule(user.schedule))}</b>\n\n` +
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
        { text: '🕘 Коли писати', callback_data: 'set:when' },
        { text: '🏙 Змінити місто', callback_data: 'set:city' },
      ],
      [{ text: '🎛 Мої смаки', callback_data: 'set:prefs' }],
      [{ text: '🔕 Відписатися', callback_data: 'set:stop' }],
    ],
  };
}

/* ------------------------------------------------------------- the heart --- */

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

/**
 * "покажи налаштування", "мої смаки", "show my settings" — asking to see the
 * panel, which must not turn into a twenty-second scrape for "налаштування".
 */
const SHOW_SETTINGS =
  /^\s*(?:покажи|показати|show|list|які|яке)?\s*(?:my |мої |моє )?(?:налаштування|settings|смаки|уподобання|prefs|preferences)\s*\??\s*$/iu;

/** "❤️", "🔔", "нагадай 3" — the typed fallback for people who do not react. */
export function parseBell(text: string): { bell: boolean; index?: number } {
  const bell =
    /🔔|🛎|⏰|❤|🧡|💛|💚|💙|💜|🤍|🖤|💖|💗|💓|💞|💕|💘|💝|♥/u.test(text) ||
    new RegExp(`^\\s*(bell|remind me|нагадай)${WORD_END}`, 'iu').test(text);
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
 * How long an answer's unshown tail stays pageable. Long enough to scroll back
 * up and keep tapping, short enough that prices and sold-out flags in it have
 * not gone stale — and short enough that `pruneCache` keeps the table small.
 */
const MORE_TTL_SECONDS = 3600;

/** Where one answer's leftovers live: next to the header that paginates them. */
const pageKey = (chatId: string, messageId: number): string => `more:${chatId}:${messageId}`;

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

  // sent directly rather than through `reply`, because taking the hourglass
  // back again needs the message id Telegram gives it
  const placeholder = await sendMessage('⏳ Шукаю…', { chatId: user.chatId, dryRun: ctx.dryRun, log: ctx.log });

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
  const pageSize = opts.top ?? cfg.bot.max_results;
  const items = ranked.items.slice(0, pageSize);
  // what the page size cut off: kept for the "показати ще" button, not dropped
  const rest = ranked.items.slice(pageSize);
  const offTaste = ranked.dropped.filter((d) => d.why === 'not in their taste').length;

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
    more: rest.length,
    // an on-demand answer is allowed to repeat things: they asked for it
    record: !ctx.dryRun,
    // the filter has to admit when it loosened, or a short list looks like a bug
    footer:
      items.length === 0
        ? 'Нічого не знайшлося. Спробуй ширший період («наступного тижня»), інше місто, або глянь /prefs — можливо, я щось відфільтровую.'
        : ranked.toppedUp > 0
          ? `Твого на цей період знайшлося небагато, тож додав ще ${ranked.toppedUp} — просто щоб ти знав(ла), що є. ` +
            `Скажи, що любиш («додай театр до улюблених»), і я звужу.`
          : offTaste > 0
            ? `Показав тільки те, що тобі заходить — ще ${offTaste} події відфільтрував. /prefs, якщо це занадто вузько.`
            : undefined,
  });
  // the hourglass stood in for an answer that has now arrived
  for (const id of placeholder) await deleteMessage(id, { chatId: user.chatId, dryRun: ctx.dryRun, log: ctx.log });

  // park the tail next to the header it belongs to, so paging through it later
  // costs a database read rather than another crawl of somebody's site
  if (rest.length > 0 && outcome.headerMessageId !== undefined && !outcome.chatGone) {
    await ctx.store.putPage(
      pageKey(user.chatId, outcome.headerMessageId),
      { header: outcome.headerText, title, query, rest, size: pageSize },
      MORE_TTL_SECONDS,
    );
  }

  if (failed.length && !outcome.chatGone) {
    await opts.reply(`(до речі: ${failed.join(', ')} не відповіли, тож список може бути неповним)`);
  }
  return items.length;
}

/**
 * Hand out the next page of an answer that did not fit.
 *
 * Nothing is scraped and nothing is re-ranked: the events come out of the
 * stash `answerSearch` left behind, in the order it ranked them. They go out
 * as one message each — the same shape as a first page, so a ❤️ or an ⏰ on a
 * late arrival resolves to its own event exactly like on an early one — and
 * the header is rewritten to count down, losing its button on the last page.
 *
 * This is paging, not searching, so `hitRateLimit` is deliberately not called.
 */
async function showMore(
  ctx: HandlerContext,
  user: BotUser,
  messageId: number | undefined,
  fallbackHeader: string | undefined,
  reply: Reply,
): Promise<void> {
  if (messageId === undefined) return;
  const key = pageKey(user.chatId, messageId);
  const page = await ctx.store.getPage(key);

  if (!page || page.rest.length === 0) {
    // an hour has gone by, or another process already emptied it: take the
    // button away rather than leave one that answers "nothing left"
    const header = page?.header ?? fallbackHeader;
    if (header) {
      await editMessageText(header, {
        chatId: user.chatId,
        messageId,
        inlineKeyboard: [],
        dryRun: ctx.dryRun,
        log: ctx.log,
      });
    }
    await ctx.store.dropPage(key);
    if (!page) await reply('Той список уже застарів — попроси свіжий, і погортаємо далі.');
    return;
  }

  const batch = page.rest.slice(0, page.size);
  const rest = page.rest.slice(page.size);

  const outcome = await deliver({
    title: page.title,
    query: page.query,
    items: batch,
    log: ctx.log,
    store: ctx.store,
    chatId: user.chatId,
    dryRun: ctx.dryRun,
    maxPerDay: 0,
    record: !ctx.dryRun,
    // the header is already in the chat, a few messages up, being edited
    withHeader: false,
  });
  if (outcome.chatGone) return;

  if (rest.length > 0) await ctx.store.putPage(key, { ...page, rest }, MORE_TTL_SECONDS);
  else await ctx.store.dropPage(key);

  await editMessageText(page.header, {
    chatId: user.chatId,
    messageId,
    inlineKeyboard: rest.length > 0 ? moreButton(rest.length) : [],
    dryRun: ctx.dryRun,
    log: ctx.log,
  });
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
    // they are getting the walkthrough right now, so never nudge them about it
    if (created) await ctx.store.setState(setupOfferedKey(chatId), new Date().toISOString());
    const parked = stepOf(user.row.stage);
    if (created || parked) {
      // /start in the middle of the walkthrough resumes it, it does not restart
      const step = parked ?? 'city';
      const lead =
        step === 'city'
          ? `👋 Я знаходжу концерти, стендап, театр, виставки, лекції, вечірки та фестивалі в українських містах — ` +
            `і нові місця, куди варто зайти.\n\nСпершу налаштуємо тебе — місто й чотири коротких екрани.\n\n`
          : '';
      await showStep(ctx, user, step, reply, lead);
      return;
    }
    await reply(`З поверненням. Твоє місто — ${escapeHtml(cityLabel(user.city))}.\n\n${COMMANDS}`, {
      inlineKeyboard: quickActions(),
    });
    return;
  }

  const existing = await getUser(ctx.store, chatId, ctx.log);
  if (!existing) {
    // anyone who starts mid-conversation gets onboarded too
    const { user } = await registerUser(ctx.store, { chatId, username: msg.from?.username ?? null });
    await ctx.store.setState(setupOfferedKey(chatId), new Date().toISOString());
    await showStep(ctx, user, 'city', reply, '👋 Почнімо з головного.\n\n');
    return;
  }
  await ctx.store.touchUser(chatId);
  const user = existing;
  const step = stepOf(user.row.stage);

  // mid-walkthrough, plain text belongs to the open step — commands still work
  if (!command && step) {
    await handleStepText(ctx, user, step, text, reply);
    return;
  }
  await offerSetup(ctx, user, reply);

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

    case '/setup':
      // the city is already known, so the walkthrough starts at the taste
      return showStep(ctx, user, 'likes', reply, 'Зберемо смаки заново.\n\n');

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

    case '/reminders':
      return reply(renderReminders(await ctx.store.listReminders(chatId)));

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
 *   onb:…         the taste screens, shared by the walkthrough and /settings:
 *                 onb:like:<cat> · onb:dis:<tag> · onb:budget:<n|none>
 *                 onb:unfollow:<index> · onb:next · onb:skip
 *                 onb:step:<step> · onb:taste · onb:start · onb:later
 *                 when:hour:<0-23> · when:day:<0-6> · when:freq:<key> · when:quiet:<from>-<to>
 *   more          the next page of an answer, from the stash behind its
 *                 header; which answer comes from the message it is on
 *   ev:<verb>:<item id>  a button under an event card — ev:r toggles the
 *                 reminder, ev:no and ev:share are not built yet (📅 is a
 *                 plain link and never calls back)
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
      // a poster card went out as a photo, so its words are a caption —
      // editMessageText on it is Bad Request: "there is no text in the message"
      const opts = { chatId, messageId, inlineKeyboard: screen.inlineKeyboard, dryRun: ctx.dryRun, log: ctx.log };
      if (cq.message?.photo?.length) await editMessageCaption(screen.text, opts);
      else await editMessageText(screen.text, opts);
    } else {
      await reply(screen.text, { inlineKeyboard: screen.inlineKeyboard });
    }
  };
  const drawPanel = async (inPlace = true) =>
    draw(settingsPanel((await getUser(ctx.store, chatId, ctx.log)) ?? user), inPlace);

  if (kind === 'ev') {
    const cut = arg.indexOf(':');
    return handleCardButton(ctx, user, {
      verb: cut < 0 ? arg : arg.slice(0, cut),
      itemId: cut < 0 ? '' : arg.slice(cut + 1),
      messageId,
      photo: (cq.message?.photo?.length ?? 0) > 0,
      draw,
      reply,
    });
  }

  if (kind === 'more') return showMore(ctx, user, messageId, cq.message?.text, reply);

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
    // someone still on the first step came here instead of using the keyboard,
    // so answer the step rather than ending the walkthrough early
    if (stepOf(user.row.stage) === 'city') return advanceInPlace(ctx, chatId, 'city', draw);
    return drawPanel();
  }

  if (kind === 'onb') {
    const cut = arg.indexOf(':');
    const verb = cut < 0 ? arg : arg.slice(0, cut);
    const payload = cut < 0 ? '' : arg.slice(cut + 1);
    const step = stepOf(user.row.stage);
    const mode = modeOf(user);

    /** Redraw one step in place, with whatever is in the database now. */
    const drawStep = async (which: TasteStep, m = mode) => {
      const fresh = (await getUser(ctx.store, chatId, ctx.log)) ?? user;
      return draw(tasteScreen(fresh, which, m));
    };

    switch (verb) {
      // the nudge: accepting opens the editing screens, so nothing is wiped
      case 'start':
        return draw(tasteMenu(user));
      case 'later':
        return draw({ text: 'Гаразд, нічого не змінюю. /setup — коли захочеш.', inlineKeyboard: [] });

      case 'taste':
        return draw(tasteMenu((await getUser(ctx.store, chatId, ctx.log)) ?? user));
      case 'step':
        if (isTasteStep(payload)) return drawStep(payload, 'settings');
        return;

      case 'like':
      case 'dis': {
        if (!payload) return;
        await toggleTaste(ctx, user, verb === 'like' ? 'like' : 'dislike', payload);
        return drawStep(verb === 'like' ? 'likes' : 'dislikes');
      }

      case 'budget': {
        const price = payload === 'none' ? null : Number(payload);
        if (price !== null && !(Number.isFinite(price) && price > 0)) return;
        await saveUserPrefs(ctx.store, user, { ...user.prefs, max_ticket_price: price });
        if (mode === 'wizard') return advanceInPlace(ctx, chatId, 'budget', draw);
        return drawStep('budget', 'settings');
      }

      case 'unfollow': {
        const i = Number(payload);
        if (!Number.isInteger(i)) return;
        await saveUserPrefs(ctx.store, user, { ...user.prefs, follow: user.prefs.follow.filter((_, n) => n !== i) });
        return drawStep('follow');
      }

      case 'next':
      case 'skip':
        if (!step) return;
        return advanceInPlace(ctx, chatId, step, draw);
    }
    return;
  }

  if (kind === 'when') {
    const cut = arg.indexOf(':');
    const verb = cut < 0 ? arg : arg.slice(0, cut);
    const payload = cut < 0 ? '' : arg.slice(cut + 1);

    if (verb === 'hour' && (DIGEST_HOURS as readonly number[]).includes(Number(payload))) {
      await ctx.store.setSchedule(chatId, { hour: Number(payload) });
    } else if (verb === 'day' && DIGEST_DAYS.some((d) => d.day === Number(payload))) {
      await ctx.store.setSchedule(chatId, { day: Number(payload) });
    } else if (verb === 'freq' && isFrequency(payload)) {
      await ctx.store.setSchedule(chatId, { frequency: payload });
    } else if (verb === 'quiet') {
      const hours = payload.split('-').map(Number);
      const [from, to] = hours;
      if (hours.length !== 2 || !hours.every((n) => Number.isInteger(n) && n >= 0 && n <= 23)) return;
      await ctx.store.setSchedule(chatId, { quietFrom: from, quietTo: to });
    }
    return draw(schedulePanel((await getUser(ctx.store, chatId, ctx.log)) ?? user));
  }

  if (kind !== 'set') return;

  const optIn = OPT_INS.find((o) => o.key === arg);
  if (optIn) {
    await ctx.store.setOptIn(chatId, optIn.key, !user.row[optIn.key]);
    return drawPanel();
  }

  switch (arg) {
    case 'when':
      return draw(schedulePanel(user));

    case 'city':
      return draw({
        text: `<b>🏙 Змінити місто</b>\n\nЗараз у тебе <b>${escapeHtml(cityLabel(user.city))}</b>. Обери інше:`,
        inlineKeyboard: cityButtons(user.city),
      });

    case 'prefs':
      return draw(tasteMenu(user));

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

/** The buttons other tasks will fill in; they answer rather than fail. */
const SOON: Record<string, string> = {
  share: 'Скоро зроблю «поділитись» одним тапом. Поки що перешли саме це повідомлення — у ньому вже є посилання.',
};

/**
 * A tap on one of the buttons under an event card: `ev:<verb>:<item id>`.
 *
 * The event is resolved the way a ❤️ resolves one — through the messages
 * table, from the chat and the message the button sits on — and the id in the
 * callback data only picks the right one out when that message carried several.
 *
 * ⏰ is the same switch as the heart: it goes through `addReminder`, which
 * un-cancels an existing row rather than adding a second one, so hearting and
 * then tapping ⏰ leaves exactly one reminder. Tapping it again cancels.
 */
async function handleCardButton(
  ctx: HandlerContext,
  user: BotUser,
  opts: {
    verb: string;
    itemId: string;
    messageId?: number;
    /** The card went out as a photo, so its redraw has to be a caption. */
    photo?: boolean;
    draw: (screen: { text: string; inlineKeyboard: InlineButton[][] }, inPlace?: boolean) => Promise<void>;
    reply: Reply;
  },
): Promise<void> {
  const { verb, itemId, messageId, draw, reply } = opts;
  const chatId = user.chatId;

  const items = messageId ? await ctx.store.itemsForMessage(chatId, messageId) : [];
  const item = items.find((i) => i.id === itemId) ?? (items.length === 1 ? items[0] : undefined);
  if (!item) {
    return reply('Я вже не памʼятаю, про яку подію було те повідомлення — попроси свіжий список і спробуй там.');
  }

  if (verb === 'no') {
    const unlearned = await learnFromThumbsDown(ctx, user, item);
    ctx.log.info(
      `chat ${chatId} thumbed down "${item.title}"` +
        `${unlearned.tag ? ` (${unlearned.tag} → ${unlearned.score}${unlearned.demoted ? ', demoted' : ''})` : ''}` +
        `${unlearned.blocked ? `, blocked ${unlearned.blocked}` : ''}`,
    );
    return reply(thumbsDownSaid(unlearned));
  }

  if (verb !== 'r') {
    const said = SOON[verb];
    return said ? reply(said) : undefined;
  }

  const reminded = await ctx.store.hasReminder(chatId, item.id);
  if (reminded) {
    await ctx.store.cancelReminder(chatId, item.id);
    ctx.log.info(`chat ${chatId} un-belled "${item.title}"`);
  } else {
    const outcome = await ctx.store.addReminder(chatId, item);
    if (outcome === 'no-date') {
      return reply(`У «${escapeHtml(item.title)}» ще немає часу початку, тож нагадування не поставлю.`);
    }
    const learned = await learnFromHeart(ctx, user, item);
    ctx.log.info(`chat ${chatId} belled "${item.title}" (reminder ${outcome}${learned.tag ? `, learned ${learned.tag}` : ''})`);
  }

  // the card itself is the feedback: the same text, with ⏰ flipped over —
  // as a caption under the poster when the card is a photo, where Telegram
  // allows 1024 characters, not the 4096 a message gets
  const itemOpts = { format: ctx.dryRun ? ('text' as const) : ('html' as const), withDay: true };
  const keyboard = eventKeyboard(item, { reminded: !reminded });
  if (opts.photo) {
    const caption = renderCaption(item, itemOpts);
    // renderCaption gives up only on an absurd URL; rather than edit the photo
    // into a caption Telegram will reject, hand over a card of its own
    return caption
      ? draw({ text: caption, inlineKeyboard: keyboard })
      : draw({ text: renderItem(item, itemOpts), inlineKeyboard: keyboard }, false);
  }
  return draw({ text: renderItem(item, itemOpts), inlineKeyboard: keyboard });
}

async function handleBell(ctx: HandlerContext, msg: TgMessage, chatId: string, index?: number): Promise<string> {
  const replyTo = msg.reply_to_message?.message_id;
  const items = replyTo ? await ctx.store.itemsForMessage(chatId, replyTo) : await ctx.store.lastItemsFor(chatId);

  if (items.length === 0) {
    return replyTo
      ? 'Я вже не памʼятаю, про яку подію було те повідомлення — попроси свіжий список і тапни ❤️ на потрібній.'
      : 'Тапни ❤️ на повідомленні з подією, або спершу попроси щось знайти.';
  }
  const chosen = items.length === 1 ? items[0] : index ? items[index - 1] : undefined;
  if (!chosen) {
    const list = items.slice(0, 20).map((it, i) => `${i + 1}. ${it.title}`).join('\n');
    return `У тому списку було ${countEvents(items.length)}. Яка саме? Тапни ❤️ на потрібній.\n\n${escapeHtml(list)}`;
  }
  if (!chosen.startsAt) return `У «${escapeHtml(chosen.title)}» ще немає часу початку, тож нагадування не поставлю.`;

  const outcome = await ctx.store.addReminder(chatId, chosen);
  if (outcome === 'no-date') return `У «${escapeHtml(chosen.title)}» ще немає часу початку.`;

  const user = await getUser(ctx.store, chatId, ctx.log);
  const learned = user ? await learnFromHeart(ctx, user, chosen) : { tag: null, follow: null };
  return reminderSaid(outcome, chosen.title, learned);
}

/* --------------------------------------------------------- the reactions --- */

function reminderSaid(outcome: string, title: string, learned: Learned): string {
  const said = `⏰ Нагадування ${outcome === 'exists' ? 'вже стоїть' : 'поставив'} — <b>${escapeHtml(title)}</b>. Нагадаю за добу та за 3 години до початку.`;
  const notes = [
    learned.tag ? `додав «${escapeHtml(tagLabel(learned.tag))}» до улюбленого` : '',
    learned.follow ? `стежу за «${escapeHtml(learned.follow)}» — скажу, щойно оголосять ще щось` : '',
  ].filter(Boolean);
  return notes.length ? `${said}\n(${notes.join('; ')})` : said;
}

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
  if (items.length > 1) return reply('Тапни ❤️ на самій події — на цьому повідомленні їх багато.');
  const item = items[0]!;

  if (!has) {
    await ctx.store.cancelReminder(chatId, item.id);
    ctx.log.info(`chat ${chatId} un-hearted "${item.title}"`);
    return reply(`Прибрав нагадування — <b>${escapeHtml(item.title)}</b>.`);
  }

  if (!item.startsAt) return reply(`У «${escapeHtml(item.title)}» ще немає часу початку, тож нагадування не поставлю.`);

  const outcome = await ctx.store.addReminder(chatId, item);
  if (outcome === 'no-date') return reply(`У «${escapeHtml(item.title)}» ще немає часу початку.`);

  // a group has a single row in `users`, so one member's ❤️ would rewrite the
  // taste of everyone else in it. The reminder is the group's either way; the
  // taste model stays whatever the group set itself.
  const shared = (update.chat.type ?? 'private') !== 'private';
  const learned = shared ? { tag: null, follow: null } : await learnFromHeart(ctx, user, item);
  ctx.log.info(
    `chat ${chatId} hearted "${item.title}" (reminder ${outcome}` +
      `${shared ? ', shared chat: taste not touched' : ''}` +
      `${learned.tag ? `, learned ${learned.tag}` : ''}${learned.follow ? `, now following ${learned.follow}` : ''})`,
  );
  return reply(reminderSaid(outcome, item.title, learned));
}

/** What one 👎 taught us, in the words the reply is built from. */
interface Unlearned {
  /** The category that lost a point, if the event had one we understand. */
  tag: string | null;
  /** That category's tally after the hit. */
  score: number;
  /** The tally crossed the threshold: the category is in the dislikes now. */
  demoted: boolean;
  /** The performer added to the stop list. */
  blocked: string | null;
}

/**
 * The 👎 half of the taste model — see applyThumbsDown for the rules. All this
 * does is pick the event apart (category, and a performer if the ticket site
 * named one) and save the result, the way learnFromHeart does.
 */
async function learnFromThumbsDown(ctx: HandlerContext, user: BotUser, item: Item): Promise<Unlearned> {
  const who = item.kind === 'place' ? undefined : (item.performers ?? []).map((n) => n.trim()).find((n) => n.length >= 3);
  const edit = applyThumbsDown(user.prefs, { tag: item.category, act: who });
  await saveUserPrefs(ctx.store, user, edit.prefs);
  return { tag: edit.tag, score: edit.score, demoted: edit.demoted, blocked: edit.blocked };
}

/**
 * Say what changed, not "ок". A first 👎 is a nudge and sounds like one; the
 * one that crosses the threshold is a promise to stop showing the category.
 */
function thumbsDownSaid(u: Unlearned): string {
  const label = u.tag ? escapeHtml(tagLabel(u.tag)) : '';
  const lines: string[] = [];
  if (u.tag) {
    lines.push(
      u.demoted
        ? `👎 Зрозумів — більше не показуватиму ${label}.`
        : `👎 Записав: ${label} тепер важить менше. Поки що не прибираю всю категорію — просто опускаю її нижче.`,
    );
  }
  if (u.blocked) lines.push(`«${escapeHtml(u.blocked)}» прибрав зі стрічки — навіть якщо категорія тобі заходить.`);
  if (lines.length === 0) return '👎 Записав. Ця подія без категорії та без виконавця, тож зі смаку я нічого не зміг зчитати — скажи словами, що саме не твоє.';
  lines.push('Передумаєш — «люблю ' + (u.tag ? tagLabel(u.tag) : 'це') + '» все вертає.');
  return lines.join('\n');
}

/** What one ❤️ taught us that is worth saying out loud. */
interface Learned {
  /** The tag added to their favourites/interests, if it was not there already. */
  tag: string | null;
  /** The performer added to their follow list. */
  follow: string | null;
}

/**
 * A heart is a free sample of someone's taste, so take all of it:
 *
 *  · the event's category joins their favourites (a place joins their interests)
 *  · the tally for that tag goes up, every time — that is what makes hearting
 *    twenty concerts mean more to the ranker than hearting one
 *  · whoever is on stage joins the follow list, where the real weight lives:
 *    followed acts are alerted on by name and ignore budget and dislikes
 *
 * One save, because two in a row from the same loaded user would lose the
 * first one's changes.
 */
async function learnFromHeart(ctx: HandlerContext, user: BotUser, item: Item): Promise<Learned> {
  const nothing: Learned = { tag: null, follow: null };
  const tag = canonicalTag(item.category);
  if (!tag) return nothing;
  const has = (list: string[], value: string) => list.some((v) => normText(v) === normText(value));
  if (has(user.prefs.disliked_categories, tag)) return nothing;

  const place = item.kind === 'place';
  const list = place ? user.prefs.interests : user.prefs.favourite_categories;
  const fresh = !has(list, tag);

  // schema.org gives us a performer only when the ticket site bothered to fill
  // it in, and a title is not a name ("Вечір імпровізації" is nobody)
  const who = place ? undefined : (item.performers ?? []).map((n) => n.trim()).find((n) => n.length >= 3);
  const follow = who && !has(user.prefs.follow, who) ? who : null;

  await saveUserPrefs(ctx.store, user, {
    ...user.prefs,
    taste: { ...user.prefs.taste, [tag]: (user.prefs.taste[tag] ?? 0) + 1 },
    favourite_categories: !place && fresh ? [...list, tag] : user.prefs.favourite_categories,
    interests: place && fresh ? [...list, tag] : user.prefs.interests,
    follow: follow ? [...user.prefs.follow, follow] : user.prefs.follow,
  });
  return { tag: fresh ? tag : null, follow };
}
