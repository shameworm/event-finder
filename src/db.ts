/**
 * Storage for the bot: who uses it, what each person has been shown, their
 * reminders and follow alerts, plus the scrape cache that lets one scrape of a
 * city serve every user in it.
 *
 * Drizzle owns the schema (drizzle/schema.sqlite.ts, drizzle/schema.pg.ts) and
 * the connection. Default is SQLite — one file, no server. Set DATABASE_URL and
 * the same repository runs on Postgres through drizzle's node-postgres driver,
 * which is what you want once the bot has real users on a server.
 *
 * Statements are built with drizzle's `sql` tag and interpolated table objects
 * (not hand-written names), so one implementation serves both dialects.
 */
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { ItemSchema, type Item } from './types.ts';
import { DB_FILE, ensureDirs, loadEnv } from './paths.ts';
import { fingerprint } from './dedupe.ts';
import * as sqliteSchema from '../drizzle/schema.sqlite.ts';
import * as pgSchema from '../drizzle/schema.pg.ts';

export type Dialect = 'sqlite' | 'postgres';
type Schema = typeof sqliteSchema | typeof pgSchema;

interface Driver {
  dialect: Dialect;
  schema: Schema;
  /** Where the data lives, for `doctor` output. */
  target: string;
  all(query: SQL): Promise<Record<string, unknown>[]>;
  run(query: SQL): Promise<void>;
  close(): Promise<void>;
}

async function createDriver(): Promise<Driver> {
  loadEnv();
  const url = process.env['DATABASE_URL'];

  if (url) {
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: url });
    const db = drizzle(pool, { schema: pgSchema });
    return {
      dialect: 'postgres',
      schema: pgSchema,
      target: url.replace(/:\/\/[^@]*@/, '://***@'),
      all: async (query) => (await db.execute(query)).rows as Record<string, unknown>[],
      run: async (query) => {
        await db.execute(query);
      },
      close: async () => {
        await pool.end();
      },
    };
  }

  ensureDirs();
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const { default: Database } = await import('better-sqlite3');
  const sqlite = new Database(DB_FILE);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle(sqlite, { schema: sqliteSchema });
  return {
    dialect: 'sqlite',
    schema: sqliteSchema,
    target: DB_FILE,
    all: async (query) => db.all(query) as Record<string, unknown>[],
    run: async (query) => {
      db.run(query);
    },
    close: async () => {
      sqlite.close();
    },
  };
}

/* ------------------------------------------------------------- bootstrap --- */

async function bootstrap(d: Driver): Promise<void> {
  const t = d.schema;
  const pk = d.dialect === 'postgres' ? sql`serial PRIMARY KEY` : sql`integer PRIMARY KEY AUTOINCREMENT`;

  await d.run(sql`CREATE TABLE IF NOT EXISTS ${t.users} (
    chat_id        text PRIMARY KEY,
    username       text,
    first_name     text,
    city           text NOT NULL,
    prefs          text NOT NULL,
    stage          text,
    weekly_digest  integer NOT NULL DEFAULT 1,
    weekend_digest integer NOT NULL DEFAULT 1,
    follow_alerts  integer NOT NULL DEFAULT 1,
    place_tips     integer NOT NULL DEFAULT 1,
    blocked        integer NOT NULL DEFAULT 0,
    last_seen_at   text,
    created_at     text NOT NULL,
    updated_at     text NOT NULL
  )`);
  await d.run(sql`CREATE INDEX IF NOT EXISTS idx_users_city ON ${t.users} (city)`);

  await d.run(sql`CREATE TABLE IF NOT EXISTS ${t.deliveries} (
    chat_id       text NOT NULL,
    item_id       text NOT NULL,
    kind          text NOT NULL DEFAULT 'event',
    title         text NOT NULL,
    city          text,
    starts_at     text,
    url           text,
    fingerprint   text,
    first_sent_at text NOT NULL,
    last_sent_at  text NOT NULL,
    send_count    integer NOT NULL DEFAULT 1,
    payload       text,
    PRIMARY KEY (chat_id, item_id)
  )`);
  await d.run(sql`CREATE INDEX IF NOT EXISTS idx_deliveries_last ON ${t.deliveries} (last_sent_at)`);

  await d.run(sql`CREATE TABLE IF NOT EXISTS ${t.messages} (
    message_id integer NOT NULL,
    chat_id    text NOT NULL,
    item_id    text NOT NULL,
    sent_at    text NOT NULL,
    payload    text,
    PRIMARY KEY (chat_id, message_id)
  )`);

  await d.run(sql`CREATE TABLE IF NOT EXISTS ${t.reminders} (
    id         ${pk},
    chat_id    text NOT NULL,
    item_id    text NOT NULL,
    title      text NOT NULL,
    city       text,
    venue      text,
    starts_at  text NOT NULL,
    url        text,
    created_at text NOT NULL,
    fired_1d   integer NOT NULL DEFAULT 0,
    fired_3h   integer NOT NULL DEFAULT 0,
    cancelled  integer NOT NULL DEFAULT 0
  )`);
  await d.run(sql`CREATE INDEX IF NOT EXISTS idx_rem_start ON ${t.reminders} (starts_at)`);
  await d.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_rem_chat_item ON ${t.reminders} (chat_id, item_id)`);

  await d.run(sql`CREATE TABLE IF NOT EXISTS ${t.scrapeCache} (
    key        text PRIMARY KEY,
    payload    text NOT NULL,
    created_at text NOT NULL,
    expires_at text NOT NULL
  )`);

  await d.run(sql`CREATE TABLE IF NOT EXISTS ${t.usage} (
    chat_id text NOT NULL,
    bucket  text NOT NULL,
    count   integer NOT NULL DEFAULT 0,
    PRIMARY KEY (chat_id, bucket)
  )`);

  await d.run(sql`CREATE TABLE IF NOT EXISTS ${t.state} (
    key   text PRIMARY KEY,
    value text
  )`);

  // tables from the single-user version this bot replaced; they only held
  // dedupe bookkeeping, so dropping them costs at most one repeated digest
  for (const legacy of ['sent', 'announced', 'alerts']) {
    await d.run(sql.raw(`DROP TABLE IF EXISTS ${legacy}`));
  }
}

/* ------------------------------------------------------------------ rows --- */

const nowIso = () => new Date().toISOString();

/**
 * Onboarded enough to be sent something. The /start walkthrough parks its step
 * in `stage`, but only the city is actually required to build a digest — so
 * someone who walked away at "what's your budget?" still gets one, and only
 * someone who never picked a city does not.
 */
const ONBOARDED = sql`(stage IS NULL OR stage <> 'city')`;

export const UserRowSchema = z.object({
  chat_id: z.coerce.string(),
  username: z.string().nullable().default(null),
  first_name: z.string().nullable().default(null),
  city: z.string(),
  prefs: z.string(),
  stage: z.string().nullable().default(null),
  weekly_digest: z.coerce.number().int(),
  weekend_digest: z.coerce.number().int(),
  follow_alerts: z.coerce.number().int(),
  place_tips: z.coerce.number().int(),
  blocked: z.coerce.number().int(),
});
export type UserRow = z.infer<typeof UserRowSchema>;

export const ReminderRowSchema = z.object({
  id: z.coerce.number().int(),
  chat_id: z.coerce.string(),
  item_id: z.string(),
  title: z.string(),
  city: z.string().nullable().default(null),
  venue: z.string().nullable().default(null),
  starts_at: z.string(),
  url: z.string().nullable().default(null),
  fired_1d: z.coerce.number().int(),
  fired_3h: z.coerce.number().int(),
});
export type ReminderRow = z.infer<typeof ReminderRowSchema>;

export interface SendDecision {
  send: boolean;
  /** 'new' | 'new date' | 'sold out' | 'few tickets left' | 'cancelled' | 'price changed' | 'already sent' */
  reason: string;
}

export type OptIn = 'weekly_digest' | 'weekend_digest' | 'follow_alerts' | 'place_tips';

function itemsFromPayload(payload: unknown): Item[] {
  if (typeof payload !== 'string' || !payload) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }
  const result = z.union([ItemSchema, z.array(ItemSchema)]).safeParse(parsed);
  if (!result.success) return [];
  return Array.isArray(result.data) ? result.data : [result.data];
}

export class Store {
  private constructor(private readonly d: Driver) {}

  static async open(): Promise<Store> {
    const d = await createDriver();
    await bootstrap(d);
    return new Store(d);
  }

  get dialect(): Dialect {
    return this.d.dialect;
  }

  get target(): string {
    return this.d.target;
  }

  async close(): Promise<void> {
    await this.d.close();
  }

  /* ------------------------------------------------------------- users --- */

  async getUser(chatId: string): Promise<UserRow | null> {
    const rows = await this.d.all(sql`SELECT * FROM ${this.d.schema.users} WHERE chat_id = ${chatId}`);
    if (!rows[0]) return null;
    const parsed = UserRowSchema.safeParse(rows[0]);
    return parsed.success ? parsed.data : null;
  }

  /** Create the row if new, otherwise just refresh the Telegram profile fields. */
  async ensureUser(input: {
    chatId: string;
    city: string;
    prefs: string;
    username?: string | null;
    firstName?: string | null;
    stage?: string | null;
  }): Promise<UserRow> {
    const t = this.d.schema;
    const ts = nowIso();
    await this.d.run(sql`
      INSERT INTO ${t.users} (chat_id, username, first_name, city, prefs, stage, created_at, updated_at, last_seen_at)
      VALUES (${input.chatId}, ${input.username ?? null}, ${input.firstName ?? null}, ${input.city}, ${input.prefs}, ${input.stage ?? null}, ${ts}, ${ts}, ${ts})
      ON CONFLICT (chat_id) DO UPDATE SET
        username     = ${input.username ?? null},
        first_name   = ${input.firstName ?? null},
        last_seen_at = ${ts},
        blocked      = 0
    `);
    const user = await this.getUser(input.chatId);
    if (!user) throw new Error(`failed to create user ${input.chatId}`);
    return user;
  }

  async setUserPrefs(chatId: string, prefsJson: string): Promise<void> {
    await this.d.run(
      sql`UPDATE ${this.d.schema.users} SET prefs = ${prefsJson}, updated_at = ${nowIso()} WHERE chat_id = ${chatId}`,
    );
  }

  async setUserCity(chatId: string, city: string): Promise<void> {
    await this.d.run(
      sql`UPDATE ${this.d.schema.users} SET city = ${city}, updated_at = ${nowIso()} WHERE chat_id = ${chatId}`,
    );
  }

  async setUserStage(chatId: string, stage: string | null): Promise<void> {
    await this.d.run(
      sql`UPDATE ${this.d.schema.users} SET stage = ${stage}, updated_at = ${nowIso()} WHERE chat_id = ${chatId}`,
    );
  }

  async setOptIn(chatId: string, which: OptIn, on: boolean): Promise<void> {
    const t = this.d.schema;
    const value = on ? 1 : 0;
    const ts = nowIso();
    // the column is chosen from a closed union, never from user input
    const column =
      which === 'weekly_digest' ? sql`weekly_digest`
      : which === 'weekend_digest' ? sql`weekend_digest`
      : which === 'follow_alerts' ? sql`follow_alerts`
      : sql`place_tips`;
    await this.d.run(sql`UPDATE ${t.users} SET ${column} = ${value}, updated_at = ${ts} WHERE chat_id = ${chatId}`);
  }

  /** 1 = the user pressed /stop or Telegram told us the chat is gone. */
  async setBlocked(chatId: string, blocked: boolean): Promise<void> {
    await this.d.run(
      sql`UPDATE ${this.d.schema.users} SET blocked = ${blocked ? 1 : 0}, updated_at = ${nowIso()} WHERE chat_id = ${chatId}`,
    );
  }

  async touchUser(chatId: string): Promise<void> {
    await this.d.run(sql`UPDATE ${this.d.schema.users} SET last_seen_at = ${nowIso()} WHERE chat_id = ${chatId}`);
  }

  /** Active users, optionally only those opted in to one job. */
  async listUsers(opts: { optIn?: OptIn; city?: string } = {}): Promise<UserRow[]> {
    const t = this.d.schema;
    const optIn =
      opts.optIn === 'weekly_digest' ? sql` AND weekly_digest = 1`
      : opts.optIn === 'weekend_digest' ? sql` AND weekend_digest = 1`
      : opts.optIn === 'follow_alerts' ? sql` AND follow_alerts = 1`
      : opts.optIn === 'place_tips' ? sql` AND place_tips = 1`
      : sql``;
    const city = opts.city ? sql` AND city = ${opts.city}` : sql``;
    const rows = await this.d.all(
      sql`SELECT * FROM ${t.users} WHERE blocked = 0 AND ${ONBOARDED}${optIn}${city} ORDER BY created_at`,
    );
    return rows.flatMap((r) => {
      const parsed = UserRowSchema.safeParse(r);
      return parsed.success ? [parsed.data] : [];
    });
  }

  async countUsers(): Promise<{ total: number; active: number }> {
    const t = this.d.schema;
    const all = await this.d.all(sql`SELECT COUNT(*) AS n FROM ${t.users}`);
    const active = await this.d.all(sql`SELECT COUNT(*) AS n FROM ${t.users} WHERE blocked = 0 AND ${ONBOARDED}`);
    return { total: Number(all[0]?.['n'] ?? 0), active: Number(active[0]?.['n'] ?? 0) };
  }

  /* -------------------------------------------- already-sent, per person --- */

  async decideSend(chatId: string, item: Item): Promise<SendDecision> {
    const t = this.d.schema;
    const rows = await this.d.all(
      sql`SELECT fingerprint, starts_at, payload FROM ${t.deliveries} WHERE chat_id = ${chatId} AND item_id = ${item.id}`,
    );
    const row = rows[0];
    if (!row) return { send: true, reason: 'new' };
    if (row['fingerprint'] === fingerprint(item)) return { send: false, reason: 'already sent' };

    const prev = itemsFromPayload(row['payload'])[0];
    const prevStart = typeof row['starts_at'] === 'string' ? row['starts_at'] : undefined;
    if (item.startsAt && prevStart && item.startsAt.slice(0, 16) !== prevStart.slice(0, 16)) {
      return { send: true, reason: 'new date' };
    }
    if (prev && prev.status !== item.status) {
      if (item.status === 'cancelled') return { send: true, reason: 'cancelled' };
      if (item.status === 'soldout') return { send: true, reason: 'sold out' };
      if (item.status === 'limited') return { send: true, reason: 'few tickets left' };
    }
    if (prev && prev.priceMin !== item.priceMin) return { send: true, reason: 'price changed' };
    return { send: false, reason: 'already sent' };
  }

  async filterUnsent(chatId: string, items: Item[]): Promise<{ fresh: { item: Item; reason: string }[]; skipped: number }> {
    const fresh: { item: Item; reason: string }[] = [];
    let skipped = 0;
    for (const item of items) {
      const decision = await this.decideSend(chatId, item);
      if (decision.send) fresh.push({ item, reason: decision.reason });
      else skipped++;
    }
    return { fresh, skipped };
  }

  async recordSent(chatId: string, items: Item[]): Promise<void> {
    const t = this.d.schema;
    const ts = nowIso();
    for (const i of items) {
      await this.d.run(sql`
        INSERT INTO ${t.deliveries} (chat_id, item_id, kind, title, city, starts_at, url, fingerprint, first_sent_at, last_sent_at, send_count, payload)
        VALUES (${chatId}, ${i.id}, ${i.kind}, ${i.title}, ${i.city}, ${i.startsAt ?? null}, ${i.url}, ${fingerprint(i)}, ${ts}, ${ts}, 1, ${JSON.stringify(i)})
        ON CONFLICT (chat_id, item_id) DO UPDATE SET
          fingerprint  = ${fingerprint(i)},
          last_sent_at = ${ts},
          starts_at    = ${i.startsAt ?? null},
          send_count   = ${t.deliveries}.send_count + 1,
          payload      = ${JSON.stringify(i)}
      `);
    }
  }

  async forgetSent(chatId: string, itemId?: string): Promise<void> {
    const t = this.d.schema;
    if (itemId) await this.d.run(sql`DELETE FROM ${t.deliveries} WHERE chat_id = ${chatId} AND item_id = ${itemId}`);
    else await this.d.run(sql`DELETE FROM ${t.deliveries} WHERE chat_id = ${chatId}`);
  }

  /* ------------------------------------------------------ message → items --- */

  async recordMessage(chatId: string, messageId: number, items: Item[]): Promise<void> {
    if (items.length === 0) return;
    const t = this.d.schema;
    await this.d.run(sql`
      INSERT INTO ${t.messages} (message_id, chat_id, item_id, sent_at, payload)
      VALUES (${messageId}, ${chatId}, ${items[0]!.id}, ${nowIso()}, ${JSON.stringify(items)})
      ON CONFLICT (chat_id, message_id) DO UPDATE SET
        item_id = ${items[0]!.id},
        payload = ${JSON.stringify(items)}
    `);
  }

  async itemsForMessage(chatId: string, messageId: number): Promise<Item[]> {
    const rows = await this.d.all(
      sql`SELECT payload FROM ${this.d.schema.messages} WHERE chat_id = ${chatId} AND message_id = ${messageId}`,
    );
    return itemsFromPayload(rows[0]?.['payload']);
  }

  /** The most recent message we sent this chat that carried items. */
  async lastItemsFor(chatId: string): Promise<Item[]> {
    const rows = await this.d.all(
      sql`SELECT payload FROM ${this.d.schema.messages} WHERE chat_id = ${chatId} ORDER BY sent_at DESC LIMIT 1`,
    );
    return itemsFromPayload(rows[0]?.['payload']);
  }

  /* ------------------------------------------------------------ reminders --- */

  async addReminder(chatId: string, item: Item): Promise<'added' | 'exists' | 'no-date'> {
    if (!item.startsAt) return 'no-date';
    const t = this.d.schema;
    const existing = await this.d.all(
      sql`SELECT id FROM ${t.reminders} WHERE chat_id = ${chatId} AND item_id = ${item.id}`,
    );
    if (existing.length > 0) {
      await this.d.run(
        sql`UPDATE ${t.reminders} SET cancelled = 0, starts_at = ${item.startsAt} WHERE chat_id = ${chatId} AND item_id = ${item.id}`,
      );
      return 'exists';
    }
    await this.d.run(sql`
      INSERT INTO ${t.reminders} (chat_id, item_id, title, city, venue, starts_at, url, created_at)
      VALUES (${chatId}, ${item.id}, ${item.title}, ${item.city}, ${item.venue ?? null}, ${item.startsAt}, ${item.url}, ${nowIso()})
    `);
    return 'added';
  }

  async listReminders(chatId?: string): Promise<ReminderRow[]> {
    const t = this.d.schema;
    const scope = chatId ? sql` AND chat_id = ${chatId}` : sql``;
    const rows = await this.d.all(
      sql`SELECT id, chat_id, item_id, title, city, venue, starts_at, url, fired_1d, fired_3h
          FROM ${t.reminders} WHERE cancelled = 0${scope} ORDER BY starts_at`,
    );
    return rows.flatMap((r) => {
      const parsed = ReminderRowSchema.safeParse(r);
      return parsed.success ? [parsed.data] : [];
    });
  }

  /** Reminders whose 1-day or 3-hour mark has passed but has not fired yet. */
  async dueReminders(now = new Date()): Promise<{ row: ReminderRow; which: '1d' | '3h' }[]> {
    const due: { row: ReminderRow; which: '1d' | '3h' }[] = [];
    for (const row of await this.listReminders()) {
      if (row.fired_1d === 1 && row.fired_3h === 1) continue;
      const start = Date.parse(row.starts_at);
      if (Number.isNaN(start)) continue;
      const left = start - now.getTime();
      if (left < -3_600_000) continue; // started over an hour ago: let it go
      if (!row.fired_1d && left <= 24 * 3_600_000 && left > 3 * 3_600_000) due.push({ row, which: '1d' });
      if (!row.fired_3h && left <= 3 * 3_600_000) due.push({ row, which: '3h' });
    }
    return due;
  }

  async markReminderFired(id: number, which: '1d' | '3h'): Promise<void> {
    const t = this.d.schema;
    if (which === '3h') await this.d.run(sql`UPDATE ${t.reminders} SET fired_3h = 1, fired_1d = 1 WHERE id = ${id}`);
    else await this.d.run(sql`UPDATE ${t.reminders} SET fired_1d = 1 WHERE id = ${id}`);
  }

  async cancelReminder(chatId: string, itemId: string): Promise<void> {
    await this.d.run(
      sql`UPDATE ${this.d.schema.reminders} SET cancelled = 1 WHERE chat_id = ${chatId} AND item_id = ${itemId}`,
    );
  }

  /* -------------------------------------------------------- scrape cache --- */

  /** Cached items for a city/window/source key, or null when stale or absent. */
  async getCache(key: string): Promise<Item[] | null> {
    const rows = await this.d.all(
      sql`SELECT payload, expires_at FROM ${this.d.schema.scrapeCache} WHERE key = ${key}`,
    );
    const row = rows[0];
    if (!row) return null;
    const expires = typeof row['expires_at'] === 'string' ? Date.parse(row['expires_at']) : 0;
    if (!expires || expires <= Date.now()) return null;
    const parsed = z.array(ItemSchema).safeParse(JSON.parse(String(row['payload'] ?? '[]')));
    return parsed.success ? parsed.data : null;
  }

  async putCache(key: string, items: Item[], ttlSeconds: number): Promise<void> {
    const t = this.d.schema;
    const now = Date.now();
    await this.d.run(sql`
      INSERT INTO ${t.scrapeCache} (key, payload, created_at, expires_at)
      VALUES (${key}, ${JSON.stringify(items)}, ${new Date(now).toISOString()}, ${new Date(now + ttlSeconds * 1000).toISOString()})
      ON CONFLICT (key) DO UPDATE SET
        payload    = ${JSON.stringify(items)},
        created_at = ${new Date(now).toISOString()},
        expires_at = ${new Date(now + ttlSeconds * 1000).toISOString()}
    `);
  }

  async pruneCache(): Promise<void> {
    await this.d.run(sql`DELETE FROM ${this.d.schema.scrapeCache} WHERE expires_at < ${nowIso()}`);
  }

  /* -------------------------------------------------------- rate limiting --- */

  /**
   * Count one request and report whether the user is over their hourly budget.
   * Scraping is the expensive part, so the budget is about protecting the
   * source sites as much as this process.
   */
  async hitRateLimit(chatId: string, limitPerHour: number): Promise<{ allowed: boolean; used: number }> {
    const t = this.d.schema;
    const bucket = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
    await this.d.run(sql`
      INSERT INTO ${t.usage} (chat_id, bucket, count) VALUES (${chatId}, ${bucket}, 1)
      ON CONFLICT (chat_id, bucket) DO UPDATE SET count = ${t.usage}.count + 1
    `);
    const rows = await this.d.all(
      sql`SELECT count FROM ${t.usage} WHERE chat_id = ${chatId} AND bucket = ${bucket}`,
    );
    const used = Number(rows[0]?.['count'] ?? 1);
    return { allowed: used <= limitPerHour, used };
  }

  /* ---------------------------------------------------------------- state --- */

  async getState(key: string): Promise<string | null> {
    const rows = await this.d.all(sql`SELECT value FROM ${this.d.schema.state} WHERE key = ${key}`);
    const v = rows[0]?.['value'];
    return typeof v === 'string' ? v : null;
  }

  async setState(key: string, value: string): Promise<void> {
    const t = this.d.schema;
    await this.d.run(sql`
      INSERT INTO ${t.state} (key, value) VALUES (${key}, ${value})
      ON CONFLICT (key) DO UPDATE SET value = ${value}
    `);
  }

  async stats(): Promise<Record<string, number>> {
    const t = this.d.schema;
    const count = async (table: object, where?: SQL): Promise<number> => {
      const rows = await this.d.all(
        where ? sql`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}` : sql`SELECT COUNT(*) AS n FROM ${table}`,
      );
      return Number(rows[0]?.['n'] ?? 0);
    };
    return {
      users: await count(t.users),
      activeUsers: await count(t.users, sql`blocked = 0 AND ${ONBOARDED}`),
      deliveries: await count(t.deliveries),
      reminders: await count(t.reminders, sql`cancelled = 0`),
      messages: await count(t.messages),
      cached: await count(t.scrapeCache),
    };
  }
}

/** Convenience for scripts: open, use, close. */
export async function withStore<T>(fn: (store: Store) => Promise<T>): Promise<T> {
  const store = await Store.open();
  try {
    return await fn(store);
  } finally {
    await store.close();
  }
}
