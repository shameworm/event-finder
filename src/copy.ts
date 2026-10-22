/**
 * Every word the bot says, in one file.
 *
 * The bot speaks Ukrainian and only Ukrainian — there is no locale switch and
 * no message catalogue, because there is no second language to switch to.
 * Keeping the copy together is what makes "is anything still in English?" a
 * question you can answer by reading one file.
 *
 * Recognition is a different matter and stays multilingual: src/categories.ts
 * matches Ukrainian, Russian and English, so someone typing "stand-up" or
 * "джаз" is understood either way. Only the *answers* live here.
 */

/** Ukrainian plural: 1 подія, 2 події, 5 подій. */
export function plural(n: number, forms: [one: string, few: string, many: string]): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

export const countEvents = (n: number): string => `${n} ${plural(n, ['подія', 'події', 'подій'])}`;
export const countPlaces = (n: number): string => `${n} ${plural(n, ['місце', 'місця', 'місць'])}`;

/* ------------------------------------------------------------------ render --- */

export const STATUS_BADGE: Record<string, string> = {
  soldout: ' — 🚫 НЕМАЄ КВИТКІВ',
  cancelled: ' — ❌ СКАСОВАНО',
  postponed: ' — ⏳ ПЕРЕНЕСЕНО',
  limited: ' — ⚠️ мало квитків',
};

/** Why an event is being shown again. Keys come from Store.filterUnsent. */
export const CHANGE_NOTE: Record<string, string> = {
  'new date': 'нова дата',
  'sold out': 'квитки скінчилися',
  'few tickets left': 'мало квитків',
  cancelled: 'скасовано',
  'price changed': 'змінилася ціна',
};

export const TIME_UNKNOWN = 'час невідомий';
export const DATE_UNKNOWN = 'дата невідома';
export const DAY_UNKNOWN = 'Дата невідома';
export const TICKETS_LINK = 'квитки →';
export const DETAILS_LINK = 'детальніше →';
export const andMore = (n: number): string => `…і ще ${n}`;

export const NOTHING_FOUND = 'Нічого не знайшлося. Спробуй ширший період або інше місто.';
export const NOTHING_FOUND_SEARCH =
  'Нічого не знайшлося. Спробуй ширший період («наступного тижня»), інше місто, або глянь /prefs — можливо, я щось відфільтрував.';
export const REMINDER_HINT = 'Тапни ❤️ на події — нагадаю за день і за 3 години до початку.';
export const PLACES_HINT = 'Скажи, що думаєш, і я підлаштую підбірку.';

/* -------------------------------------------------------------- price text --- */

export const FREE = 'безкоштовно';
export const PRICE_UNKNOWN = 'ціна невідома';
export const priceUpTo = (n: number, sym: string): string => `до ${n} ${sym}`;
export const priceRange = (min: number, max: number, sym: string): string => `${min}–${max} ${sym}`;
export const priceFrom = (n: number, sym: string): string => `від ${n} ${sym}`;

/* ----------------------------------------------------------------- digests --- */

export const TITLE_WEEK = '🗓 Цього тижня';
export const TITLE_WEEKEND = '🎉 На вихідних';
export const TITLE_PLACES = '📍 Варто зайти';
export const TITLE_FOLLOW = '❤️ Грає хтось, за ким ти слідкуєш';
export const titleSearch = (): string => '🗓 Що знайшлося';
export const DIGEST_FOOTER = `${REMINDER_HINT} /settings — щоб змінити, що тобі приходить.`;
export const PLACES_FOOTER = `${PLACES_HINT} /mute places — щоб не приходили.`;

/* ------------------------------------------------------------ date windows --- */

/** Window names end up in the digest header, so they are read by people. */
export const RANGE = {
  weekendSunday: 'на вихідних (неділя)',
  weekend: 'на вихідних',
  nextWeekend: 'наступних вихідних',
  thisWeek: 'цього тижня',
  nextWeek: 'наступного тижня',
  thisMonth: 'цього місяця',
  today: 'сьогодні',
  tomorrow: 'завтра',
  dayAfterTomorrow: 'післязавтра',
  openNow: 'відкрито зараз',
  explicit: 'вибраний період',
  nextDays: (n: number) => `наступні ${n} ${plural(n, ['день', 'дні', 'днів'])}`,
};

/** "наступної п'ятниці", 0 = Sunday. Spelled out rather than inflected in code. */
export const WEEKDAY_NEXT = [
  'наступної неділі',
  'наступного понеділка',
  'наступного вівторка',
  'наступної середи',
  'наступного четверга',
  "наступної п'ятниці",
  'наступної суботи',
];

/* ---------------------------------------------------------------- reminders --- */

export const REMIND_TOMORROW = 'Завтра';
export const REMIND_SOON = 'Вже за ~3 години';

/* ----------------------------------------------------------- the conversation --- */

export const COMMANDS = `<b>Що я вмію</b>

/week — усе на цьому тижні
/weekend — з п'ятниці по неділю
/today · /tomorrow — просто зараз
/places — нові кафе, бари, галереї, куди варто зайти
/city — змінити місто
/prefs — що я думаю про твої смаки
/settings — які підбірки тобі приходять
/reminders — твої нагадування
/stop — відписатися

Або просто напиши, чого хочеться:
· <i>стендап на вихідних</i>
· <i>щось цікаве у Львові</i>
· <i>виставки наступного тижня, тільки не класика</i>

Щоб я вивчив твій смак:
· <i>люблю стендап та інді-рок</i>
· <i>не люблю класичну музику</i>
· <i>слідкуй за Latexfauna</i>
· <i>максимум 800 грн</i>
· <i>наступного тижня буду у Львові</i>

Тапни ❤️ на будь-якій події — нагадаю за день і за три години до початку.
Знімеш ❤️ — нагадування теж зникне.`;

export const PRIVATE_BOT = 'Поки що цей бот приватний. Попроси власника додати тебе.';

export const WELCOME = `👋 Я знаходжу концерти, стендап, театр, виставки, лекції, вечірки й фестивалі в українських містах — і нові місця, куди варто зайти.

У якому ти місті?`;
export const WELCOME_SHORT = '👋 Спершу найголовніше — у якому ти місті?';
export const welcomeBack = (city: string): string => `З поверненням. Твоє місто — ${city}.`;
export const cityUnknown = (what: string): string =>
  `Я ще не знаю «${what}». Обери зі списку, або попроси власника додати твоє місто.`;
export const cityUnknownShort = (what: string): string =>
  `Я не знаю «${what}». Напиши /city без назви, щоб побачити список.`;
export const citySet = (city: string): string => `✅ ${city}, записав.`;

/** The taste step of onboarding. */
export const TASTE_ASK = `А тепер — що тобі подобається?

Напиши своїми словами: <i>стендап, інді-рок і виставки, тільки не класика</i>. Можна просто перелічити через кому.`;
export const TASTE_SKIP_BUTTON = 'Пропустити';
/** Nudges for the taste question; tapping one is a valid answer by itself. */
export const TASTE_BUTTONS = [
  ['Стендап', 'Концерти'],
  ['Театр', 'Виставки'],
  ['Вечірки', 'Лекції'],
];
export const TASTE_SKIPPED = 'Гаразд, розберуся по ходу — я вчуся з того, на що ти тапаєш ❤️.';
export const TASTE_UNCLEAR =
  'Не вловив смаки в цьому. Спробуй перелічити через кому — <i>стендап, джаз, театр</i> — або натисни «Пропустити».';
export const tasteNoted = (changes: string[]): string =>
  `✅ Записав:\n${changes.map((c) => `· ${c}`).join('\n')}`;

export const PREFS_HEAD = '<b>Що я думаю про твої смаки</b>';
export const SETTINGS_HEAD = '<b>Твої підбірки</b>';
export const SETTINGS_BODY = (flags: { week: string; weekend: string; follows: string; places: string }): string =>
  `${flags.week} /mute week — понеділок, «цього тижня»\n` +
  `${flags.weekend} /mute weekend — четвер, плани на вихідні\n` +
  `${flags.follows} /mute follows — нові концерти тих, за ким ти слідкуєш\n` +
  `${flags.places} /mute places — щотижневі місця\n\n` +
  `/mute &lt;назва&gt; — вимкнути, /unmute &lt;назва&gt; — повернути.`;
export const MUTE_WHICH = 'Яку саме? week, weekend, follows або places. Дивись /settings.';
export const muteDone = (which: string, on: boolean): string =>
  `${on ? '🔔' : '🔕'} Підбірка «${which}» ${on ? 'увімкнена' : 'вимкнена'}.`;
export const STOPPED = '🔕 Відписав — більше нічого не надсилатиму. /start, коли захочеш назад.';

export const NO_REMINDERS = 'Нагадувань ще немає. Тапни ❤️ на події — і я його поставлю.';
export const REMINDERS_HEAD = '<b>Твої нагадування</b>';

export const followWho = (command: string): string => `За ким? Наприклад: <code>${command} Latexfauna</code>`;
export const nothingToChange = (note: string): string => `Нічого не змінилося — ${note}.`;
export const noted = (changes: string[]): string => `✅ Записав:\n${changes.map((c) => `· ${c}`).join('\n')}`;
export const OWNER_ONLY = 'Це тільки для власника бота.';
export const STATS_HEAD = '<b>Статистика бота</b>';
export const unknownCommand = (command: string): string => `Я не знаю ${command}.`;

export const rateLimited = (used: number): string =>
  `Ти використав ${used} ${plural(used, ['пошук', 'пошуки', 'пошуків'])} за цю годину — це мій ліміт на людину, ` +
  `бо з сайтами квитків треба поводитися чемно. Заплановані підбірки все одно прийдуть; спробуй трохи пізніше.`;
export const LOOKING = '⏳ Шукаю…';
export const sourcesFailed = (sources: string): string =>
  `(до відома: ${sources} не відповіли, тож список може бути неповним)`;

/* --------------------------------------------------------------- the heart --- */

export const reminderSet = (title: string): string =>
  `❤️ Нагадування для <b>${title}</b> — напишу за день і за 3 години до початку.`;
export const reminderAlready = (title: string): string => `❤️ Нагадування для <b>${title}</b> вже стоїть.`;
export const reminderCleared = (title: string): string => `🤍 Знято нагадування для <b>${title}</b>.`;
export const reminderNoDate = (title: string): string =>
  `У «${title}» ще немає часу початку, тож нагадування поставити не можу.`;
export const HEART_ON_EVENT = 'Тапни ❤️ на самій події, а не на цьому повідомленні.';
export const HEART_FORGOTTEN =
  'Я вже не пам\'ятаю, про яку подію було те повідомлення — попроси свіжий список і тапни на ньому.';
export const HEART_NOTHING_YET = 'Тапни ❤️ на повідомленні з подією, або спершу попроси щось знайти.';
export const whichOne = (n: number, list: string): string =>
  `У тому списку було ${countEvents(n)}. Яка саме? Тапни ❤️ на потрібній.\n\n${list}`;
export const tasteLearned = (tag: string): string => `(додав «${tagLabel(tag)}» до улюбленого)`;

/* ---------------------------------------------------------- prefs, in words --- */

/**
 * Taste tags are stored under English keys, because that is what the matching
 * code in src/categories.ts keys on. Nobody should ever *read* "standup", so
 * every tag goes through here on its way into a message. Free-text tags have
 * no key and pass through exactly as the person typed them.
 */
const TAG_LABEL: Record<string, string> = {
  concert: 'концерти', standup: 'стендап', theatre: 'театр', exhibition: 'виставки',
  lecture: 'лекції', party: 'вечірки', festival: 'фестивалі', workshop: 'воркшопи',
  cinema: 'кіно', kids: 'дітям', sport: 'спорт', other: 'інше',
  cafe: 'кафе', bar: 'бари', gallery: 'галереї', spot: 'місця',
  classical: 'класика', opera: 'опера', ballet: 'балет', jazz: 'джаз', rock: 'рок',
  indie: 'інді', metal: 'метал', rap: 'реп', electronic: 'електронна музика',
  pop: 'поп', folk: 'фолк', karaoke: 'караоке', tribute: 'трибют',
  candlelight: 'при свічках', chanson: 'шансон', improv: 'імпровізація',
  wine: 'вино', photo: 'фотографія', poetry: 'поезія',
};

export const tagLabel = (tag: string): string => TAG_LABEL[tag] ?? tag;
export const tagList = (tags: string[]): string => tags.map(tagLabel).join(', ') || '—';

/** "700 ₴" — the currency code is for storage, not for reading. */
export const money = (amount: number, currency: string): string =>
  `${amount} ${!currency || currency === 'UAH' ? '₴' : currency}`;

export const prefsChange = {
  budgetNone: 'максимальна ціна → без обмежень',
  budget: (value: number, currency: string) => `максимальна ціна → ${money(value, currency)}`,
  tripCleared: 'поїздка → скасована',
  trip: (city: string, from: string, to: string, label: string) => `поїздка → ${city} ${from} → ${to} (${label})`,
  homeCity: (city: string) => `домашнє місто → ${city}`,
  watchAdd: (city: string) => `слідкую за містом + ${city}`,
  watchDrop: (city: string) => `слідкую за містом − ${city}`,
  followAdd: (who: string) => `слідкую за «${who}»`,
  followDrop: (who: string) => `більше не слідкую за «${who}»`,
  interestAdd: (tag: string) => `цікавить + ${tagLabel(tag)}`,
  favAdd: (tag: string) => `улюблене + ${tagLabel(tag)}`,
  favDrop: (tag: string) => `улюблене − ${tagLabel(tag)}`,
  dislikeAdd: (tag: string) => `не люблю + ${tagLabel(tag)}`,
  dislikeDrop: (tag: string) => `не люблю − ${tagLabel(tag)}`,
};

export const prefsNote = {
  nothing: 'нічого змінювати',
  budgetUnlimited: 'ліміт уже знятий',
  alreadySet: 'уже так',
  noTrip: 'поїздки й не було',
  alreadyHome: 'це вже твоє домашнє місто',
  notWatched: 'за цим містом я й не слідкував',
  alreadyWatched: 'за цим містом уже слідкую',
  notFollowed: (who: string) => `«${who}» не було у списку`,
  alreadyFollowed: (who: string) => `за «${who}» уже слідкую`,
  alreadyInterest: 'уже в цікавому',
  notDisliked: 'цього й не було в нелюбих',
  alreadyDisliked: 'уже в нелюбих',
  notFavourite: 'цього й не було в улюбленому',
  alreadyFavourite: 'уже в улюбленому',
};

export const prefsLabel = {
  homeCity: 'домашнє місто',
  watchCities: 'слідкую за містами',
  favourites: 'улюблене',
  dislikes: 'не люблю',
  following: 'слідкую за',
  maxPrice: 'максимальна ціна',
  noLimit: 'без обмежень',
  interests: 'цікавить',
  trip: 'поїздка',
};
