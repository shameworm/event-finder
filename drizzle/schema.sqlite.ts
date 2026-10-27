/**
 * Drizzle schema — SQLite dialect (the default: a single file under
 * ~/.hermes/data/events-finder/events.db, no server to run).
 *
 * The bot is multi-user: every row that represents "what this person was told"
 * is keyed by their Telegram chat id. Keep this in sync with
 * drizzle/schema.pg.ts; `src/db.ts` picks one at runtime.
 */
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** One row per person using the bot. `prefs` is their Preferences as JSON. */
export const users = sqliteTable(
  'users',
  {
    chatId: text('chat_id').primaryKey(),
    username: text('username'),
    firstName: text('first_name'),
    /** Canonical city key from config.yaml. */
    city: text('city').notNull(),
    prefs: text('prefs').notNull(),
    /** Onboarding step, or null once set up. */
    stage: text('stage'),
    weeklyDigest: integer('weekly_digest').notNull().default(1),
    weekendDigest: integer('weekend_digest').notNull().default(1),
    followAlerts: integer('follow_alerts').notNull().default(1),
    placeTips: integer('place_tips').notNull().default(1),
    /**
     * Personal schedule. Additive with defaults that reproduce the old
     * hard-wired cron (Monday 09:00 + Thursday), because there are no
     * migrations here: a row written before these columns existed must still
     * read, and must behave exactly as it did.
     */
    digestHour: integer('digest_hour').notNull().default(9),
    /** The legacy single weekday — see `digestDays`, which supersedes it. */
    digestDay: integer('digest_day').notNull().default(1),
    /**
     * The days a digest arrives: one bit per weekday, bit 0 = Sunday. NULL
     * means the user has never touched the schedule, so the legacy
     * `digestDay` + `digestFreq` pair still decides. See src/schedule.ts.
     */
    digestDays: integer('digest_days'),
    /** Quiet window, local hours; from === to means "no quiet hours". */
    quietFrom: integer('quiet_from').notNull().default(23),
    quietTo: integer('quiet_to').notNull().default(8),
    /** 'weekly' | 'twice' | 'mine' — see src/schedule.ts. */
    digestFreq: text('digest_freq').notNull().default('twice'),
    /** 1 = stopped the bot or was blocked; no sends, no digests. */
    blocked: integer('blocked').notNull().default(0),
    lastSeenAt: text('last_seen_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('idx_users_city').on(t.city)],
);

/** What each person has already been shown, and the fingerprint we compare to. */
export const deliveries = sqliteTable(
  'deliveries',
  {
    chatId: text('chat_id').notNull(),
    itemId: text('item_id').notNull(),
    kind: text('kind').notNull().default('event'),
    title: text('title').notNull(),
    city: text('city'),
    startsAt: text('starts_at'),
    url: text('url'),
    fingerprint: text('fingerprint'),
    firstSentAt: text('first_sent_at').notNull(),
    lastSentAt: text('last_sent_at').notNull(),
    sendCount: integer('send_count').notNull().default(1),
    payload: text('payload'),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.itemId] }), index('idx_deliveries_last').on(t.lastSentAt)],
);

/** Telegram message -> the items it was about, so a "🔔" reply can be resolved. */
export const messages = sqliteTable(
  'messages',
  {
    messageId: integer('message_id').notNull(),
    chatId: text('chat_id').notNull(),
    itemId: text('item_id').notNull(),
    sentAt: text('sent_at').notNull(),
    payload: text('payload'),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.messageId] })],
);

/** Reminder requests: fire 1 day and 3 hours before the start, per person. */
export const reminders = sqliteTable(
  'reminders',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    chatId: text('chat_id').notNull(),
    itemId: text('item_id').notNull(),
    title: text('title').notNull(),
    city: text('city'),
    venue: text('venue'),
    startsAt: text('starts_at').notNull(),
    url: text('url'),
    createdAt: text('created_at').notNull(),
    fired1d: integer('fired_1d').notNull().default(0),
    fired3h: integer('fired_3h').notNull().default(0),
    cancelled: integer('cancelled').notNull().default(0),
  },
  // unique, and named exactly as src/db.ts bootstraps it: one reminder per
  // chat per event is what makes a second ❤️ an update instead of a duplicate.
  // src/db.ts's CREATE TABLE is the authority — these must not drift from it.
  (t) => [index('idx_rem_start').on(t.startsAt), uniqueIndex('idx_rem_chat_item').on(t.chatId, t.itemId)],
);

/**
 * Scraped results, cached per city + window + source set. This is what makes
 * the bot multi-user: one scrape serves everyone in that city.
 */
export const scrapeCache = sqliteTable('scrape_cache', {
  key: text('key').primaryKey(),
  payload: text('payload').notNull(),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
});

/** Per-person request counters, for rate limiting a public bot. */
export const usage = sqliteTable(
  'usage',
  {
    chatId: text('chat_id').notNull(),
    /** Hour bucket, e.g. 2026-10-20T14. */
    bucket: text('bucket').notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.bucket] })],
);

/** Small key/value bag: Telegram getUpdates offset, last cron runs. */
export const state = sqliteTable('state', {
  key: text('key').primaryKey(),
  value: text('value'),
});

/**
 * Events someone put a 🔖 on. Separate from `reminders` on purpose: a reminder
 * needs a start time and expires with the event, while a saved event is a
 * bookmark — it keeps the whole item, so the card can be redrawn later without
 * going back to the ticket site.
 */
export const saved = sqliteTable(
  'saved',
  {
    chatId: text('chat_id').notNull(),
    itemId: text('item_id').notNull(),
    title: text('title').notNull(),
    startsAt: text('starts_at'),
    /** The whole Item as JSON, so the card survives the scrape cache. */
    payload: text('payload').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.itemId] }), index('idx_saved_chat').on(t.chatId)],
);

/**
 * One row per event that has already fed this person's taste model. ❤️ and
 * 🔖 both mean "yes, this one", so without this marker an event that got
 * both would score its category twice. There is nothing to un-learn here: a
 * row stays even when the bookmark goes, because 👎 is the only gesture that
 * takes a point back off.
 */
export const taught = sqliteTable(
  'taught',
  {
    chatId: text('chat_id').notNull(),
    itemId: text('item_id').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.itemId] })],
);
