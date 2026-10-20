/**
 * Drizzle schema — Postgres dialect. Used when DATABASE_URL is set.
 * Mirrors drizzle/schema.sqlite.ts column for column; the boolean-ish columns
 * stay integers so one set of queries works against both dialects.
 */
import { index, integer, pgTable, primaryKey, serial, text } from 'drizzle-orm/pg-core';

/** One row per person using the bot. `prefs` is their Preferences as JSON. */
export const users = pgTable(
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
    /** 1 = stopped the bot or was blocked; no sends, no digests. */
    blocked: integer('blocked').notNull().default(0),
    lastSeenAt: text('last_seen_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('idx_users_city').on(t.city)],
);

/** What each person has already been shown, and the fingerprint we compare to. */
export const deliveries = pgTable(
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
export const messages = pgTable(
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
export const reminders = pgTable(
  'reminders',
  {
    id: serial('id').primaryKey(),
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
  (t) => [index('idx_rem_start').on(t.startsAt), index('idx_rem_chat').on(t.chatId, t.itemId)],
);

/**
 * Scraped results, cached per city + window + source set. This is what makes
 * the bot multi-user: one scrape serves everyone in that city.
 */
export const scrapeCache = pgTable('scrape_cache', {
  key: text('key').primaryKey(),
  payload: text('payload').notNull(),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
});

/** Per-person request counters, for rate limiting a public bot. */
export const usage = pgTable(
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
export const state = pgTable('state', {
  key: text('key').primaryKey(),
  value: text('value'),
});
