/**
 * The bridge between a Telegram chat and a taste model.
 *
 * In the multi-user bot each person's Preferences live in the `users` table as
 * JSON. A new user starts from an empty taste model (`newUserPrefs`) and fills
 * it in through the /start walkthrough; `preferences.yaml` belongs to whoever
 * runs the bot and is only used by the CLI.
 */
import { PreferencesSchema, formatZodError, type Preferences } from './types.ts';
import { loadConfig, loadPrefs, resolveCity } from './config.ts';
import { loadEnv } from './paths.ts';
import type { OptIn, Store, UserRow } from './db.ts';
import type { Logger } from './log.ts';

export interface BotUser {
  chatId: string;
  /** Authoritative city for this person (mirrors prefs.home_city). */
  city: string;
  prefs: Preferences;
  row: UserRow;
}

/** The chat id of whoever runs the bot, used by the CLI and for /stats. */
export function ownerChatId(): string | undefined {
  loadEnv();
  return process.env['TELEGRAM_CHAT_ID'];
}

export function isOwner(chatId: string): boolean {
  const owner = ownerChatId();
  return Boolean(owner && owner === chatId);
}

/**
 * The taste model a brand new user starts with: nothing.
 *
 * `preferences.yaml` is the operator's own profile, not a template for
 * strangers — inheriting it would rank everyone against someone else's taste.
 * The /start walkthrough is where a new person's favourites, dislikes, budget
 * and follow list actually come from; only the city and the currency are
 * carried over, and the walkthrough asks for the city anyway.
 */
export function newUserPrefs(city?: string): Preferences {
  const cfg = loadConfig();
  const seed = loadPrefs();
  return PreferencesSchema.parse({
    home_city: (city && resolveCity(city)) || seed.home_city || cfg.default_city,
    currency: seed.currency,
  });
}

/** The operator's own preferences: preferences.yaml, with their city applied. */
export function defaultPrefs(city?: string): Preferences {
  const cfg = loadConfig();
  const seed = loadPrefs();
  const home = (city && resolveCity(city)) || seed.home_city || cfg.default_city;
  return PreferencesSchema.parse({
    ...seed,
    home_city: home,
    // the seed file's follow list belongs to the operator, not to new users
    follow: [],
    trip: null,
    watch_cities: [],
  });
}

function parsePrefs(json: string, city: string, log?: Logger): Preferences {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    log?.warn('stored preferences are not valid JSON — falling back to defaults');
    return defaultPrefs(city);
  }
  const parsed = PreferencesSchema.safeParse(raw);
  if (!parsed.success) {
    log?.warn(`stored preferences are invalid (${formatZodError(parsed.error, 2)}) — falling back to defaults`);
    return defaultPrefs(city);
  }
  // the users table is the source of truth for the city
  return { ...parsed.data, home_city: city };
}

export function toBotUser(row: UserRow, log?: Logger): BotUser {
  return { chatId: row.chat_id, city: row.city, prefs: parsePrefs(row.prefs, row.city, log), row };
}

export async function getUser(store: Store, chatId: string, log?: Logger): Promise<BotUser | null> {
  const row = await store.getUser(chatId);
  return row ? toBotUser(row, log) : null;
}

/**
 * Get or create the user. A new user starts in the 'city' onboarding stage, so
 * scheduled jobs skip them until they have picked a city.
 */
export async function registerUser(
  store: Store,
  input: { chatId: string; username?: string | null; firstName?: string | null; city?: string },
): Promise<{ user: BotUser; created: boolean }> {
  const existing = await store.getUser(input.chatId);
  if (existing) {
    await store.ensureUser({
      chatId: input.chatId,
      city: existing.city,
      prefs: existing.prefs,
      username: input.username ?? existing.username,
      firstName: input.firstName ?? existing.first_name,
      stage: existing.stage,
    });
    const refreshed = await store.getUser(input.chatId);
    return { user: toBotUser(refreshed ?? existing), created: false };
  }

  const city = (input.city && resolveCity(input.city)) || loadConfig().default_city;
  const prefs = newUserPrefs(city);
  const row = await store.ensureUser({
    chatId: input.chatId,
    city,
    prefs: JSON.stringify(prefs),
    username: input.username ?? null,
    firstName: input.firstName ?? null,
    stage: input.city ? null : 'city',
  });
  return { user: toBotUser(row), created: true };
}

export async function saveUserPrefs(store: Store, user: BotUser, prefs: Preferences): Promise<BotUser> {
  const city = resolveCity(prefs.home_city) ?? user.city;
  const next = { ...prefs, home_city: city };
  await store.setUserPrefs(user.chatId, JSON.stringify(next));
  if (city !== user.city) await store.setUserCity(user.chatId, city);
  return { ...user, city, prefs: next };
}

/** Every active, onboarded user — optionally only those opted in to one job. */
export async function allUsers(store: Store, optIn?: OptIn, log?: Logger): Promise<BotUser[]> {
  const rows = await store.listUsers(optIn ? { optIn } : {});
  return rows.map((r) => toBotUser(r, log));
}

/** Group users by the cities a job needs to scrape for them. */
export function byCity(users: BotUser[], opts: { includeWatch?: boolean; today?: string } = {}): Map<string, BotUser[]> {
  const map = new Map<string, BotUser[]>();
  const push = (city: string, user: BotUser) => {
    const list = map.get(city);
    if (list) {
      if (!list.includes(user)) list.push(user);
    } else map.set(city, [user]);
  };
  for (const user of users) {
    const trip = user.prefs.trip;
    const onTrip = trip && opts.today && trip.from <= opts.today && opts.today <= trip.to;
    push(onTrip && trip ? trip.city : user.city, user);
    if (opts.includeWatch) for (const c of user.prefs.watch_cities) push(c, user);
  }
  return map;
}

/**
 * The cities a single user cares about right now: their city (or trip city),
 * plus their watch list.
 */
export function citiesFor(user: BotUser, today?: string, includeWatch = false): string[] {
  const trip = user.prefs.trip;
  const onTrip = trip && today && trip.from <= today && today <= trip.to;
  const primary = onTrip && trip ? trip.city : user.city;
  return [...new Set([primary, ...(includeWatch ? user.prefs.watch_cities : [])])];
}
