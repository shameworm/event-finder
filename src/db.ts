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
import { ItemSchema, QuerySchema, type Item } from './types.ts';
import { DB_FILE, ensureDirs, loadEnv } from './paths.ts';
import { fingerprint } from './dedupe.ts';
import { daysMask } from './schedule.ts';
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

/**
 * Add a column to an existing table, idempotently.
 *
 * Postgres has `ADD COLUMN IF NOT EXISTS`; SQLite has no such thing and errors
 * with "duplicate column name", which on the second start-up is exactly the
 * outcome we wanted. Table and column names come from the literals above,
 * never from user input.
 */
async function addColumn(d: Driver, table: string, column: string, type: string): Promise<void> {
  const ifNotExists = d.dialect === 'postgres' ? 'IF NOT EXISTS ' : '';
  try {
    await d.run(sql.raw(`ALTER TABLE ${table} ADD COLUMN ${ifNotExists}${column} ${type}`));
  } catch (err) {
    // drizzle wraps driver errors, so the real complaint is down the `cause`
    // chain rather than in the top-level message
    const messages: string[] = [];
    for (let e: unknown = err; e instanceof Error; e = e.cause) messages.push(e.message);
    if (!/duplicate column|already exists/i.test(messages.join(' | '))) throw err;
  }
}

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
    digest_hour    integer NOT NULL DEFAULT 9,
    digest_day     integer NOT NULL DEFAULT 1,
    digest_days    integer,
    quiet_from     integer NOT NULL DEFAULT 23,
    quiet_to       integer NOT NULL DEFAULT 8,
    digest_freq    text NOT NULL DEFAULT 'twice',
    blocked        integer NOT NULL DEFAULT 0,
    last_seen_at   text,
    created_at     text NOT NULL,
    updated_at     text NOT NULL
  )`);
  await d.run(sql`CREATE INDEX IF NOT EXISTS idx_users_city ON ${t.users} (city)`);

  // There are no migration files in this project, so a database created before
  // the personal schedule existed has the old `users` shape and the CREATE
  // TABLE above is a no-op for it. Add the columns by hand instead, with the
  // defaults that reproduce the single hard-wired cron it was built around.
  for (const [column, type] of [
    ['digest_hour', `integer NOT NULL DEFAULT 9`],
    ['digest_day', `integer NOT NULL DEFAULT 1`],
    // deliberately nullable and defaultless: NULL is what says "use the
    // digest_day/freq above", and giving it a default would silently move
    // every existing user onto Monday-and-Thursday
    ['digest_days', `integer`],
    ['quiet_from', `integer NOT NULL DEFAULT 23`],
    ['quiet_to', `integer NOT NULL DEFAULT 8`],
    ['digest_freq', `text NOT NULL DEFAULT 'twice'`],
  ] as const) {
    await addColumn(d, 'users', column, type);
  }

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
 * How long bookkeeping rows are kept by `Store.prune()`. Generous on purpose:
 * `messages` is what a late ❤️ resolves through, and `deliveries` is what
 * stops a digest repeating itself.
 */
const RETENTION = {
  messagesDays: 120,
  deliveriesDays: 180,
  /** Reminders for events this far in the past are of no use to anyone. */
  remindersDays: 60,
  /** Hourly rate-limit buckets. */
  usageHours: 48,
};

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
  // the personal schedule; defaulted rather than required, so a row that
  // predates these columns still parses and behaves as it always did
  digest_hour: z.coerce.number().int().default(9),
  digest_day: z.coerce.number().int().default(1),
  /**
   * The days a digest arrives, as one bit per weekday (bit 0 = Sunday). NULL
   * means nobody has touched this row since it existed — the legacy
   * `digest_day` + `digest_freq` below still say what they want.
   */
  digest_days: z.coerce.number().int().nullable().default(null),
  quiet_from: z.coerce.number().int().default(23),
  quiet_to: z.coerce.number().int().default(8),
  digest_freq: z.string().default('twice'),
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

/**
 * What one answer left over: the events it ranked but had no room to show,
 * plus the header text they hang under so the "показати ще" button on it can
 * be redrawn (or taken away) without rebuilding the answer from scratch.
 */
export const PendingPageSchema = z.object({
  header: z.string(),
  title: z.string(),
  query: QuerySchema,
  /** Ranked, in order, none of them shown yet. */
  rest: z.array(ItemSchema),
  /** How many to hand out per tap — the same page size the first answer used. */
  size: z.number().int().positive(),
});
export type PendingPage = z.infer<typeof PendingPageSchema>;

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

  /**
   * Change one piece of someone's delivery schedule. Each field is written
   * through its own statement so the column list stays a closed set of
   * literals rather than something assembled from input.
   *
   * `days` is the weekday set as a bitmask (bit 0 = Sunday), and writing it is
   * what retires the legacy `digest_day`/`digest_freq` for that user.
   */
  async setSchedule(
    chatId: string,
    patch: { hour?: number; days?: number[]; quietFrom?: number; quietTo?: number; frequency?: string },
  ): Promise<void> {
    const t = this.d.schema;
    const ts = nowIso();
    const set = async (column: SQL, value: number | string) => {
      await this.d.run(sql`UPDATE ${t.users} SET ${column} = ${value}, updated_at = ${ts} WHERE chat_id = ${chatId}`);
    };
    if (patch.hour !== undefined) await set(sql`digest_hour`, patch.hour);
    if (patch.days !== undefined) await set(sql`digest_days`, daysMask(patch.days));
    if (patch.quietFrom !== undefined) await set(sql`quiet_from`, patch.quietFrom);
    if (patch.quietTo !== undefined) await set(sql`quiet_to`, patch.quietTo);
    if (patch.frequency !== undefined) await set(sql`digest_freq`, patch.frequency);
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

  /**
   * Live reminders. A chat that said /stop ("більше нічого не надсилаю") is
   * excluded even though its reminder rows stay put — /start brings them back.
   */
  async listReminders(chatId?: string, window?: { from: string; to: string }): Promise<ReminderRow[]> {
    const t = this.d.schema;
    const scope = chatId ? sql` AND r.chat_id = ${chatId}` : sql``;
    // the reminder cron runs every 15 minutes and only ever cares about the day
    // either side of now, so it asks for that slice instead of every row
    const bound = window ? sql` AND r.starts_at >= ${window.from} AND r.starts_at <= ${window.to}` : sql``;
    const rows = await this.d.all(
      sql`SELECT r.id, r.chat_id, r.item_id, r.title, r.city, r.venue, r.starts_at, r.url, r.fired_1d, r.fired_3h
          FROM ${t.reminders} r
          WHERE r.cancelled = 0${scope}${bound}
            AND r.chat_id NOT IN (SELECT chat_id FROM ${t.users} WHERE blocked = 1)
          ORDER BY r.starts_at`,
    );
    return rows.flatMap((r) => {
      const parsed = ReminderRowSchema.safeParse(r);
      return parsed.success ? [parsed.data] : [];
    });
  }

  /** Reminders whose 1-day or 3-hour mark has passed but has not fired yet. */
  async dueReminders(now = new Date()): Promise<{ row: ReminderRow; which: '1d' | '3h' }[]> {
    const due: { row: ReminderRow; which: '1d' | '3h' }[] = [];
    // nothing outside this window can be due. The bound is text comparison on
    // ISO strings whose offsets may differ from ours, so it is deliberately two
    // days wide either way; the exact arithmetic below still decides.
    const window = {
      from: new Date(now.getTime() - 2 * 86_400_000).toISOString(),
      to: new Date(now.getTime() + 2 * 86_400_000).toISOString(),
    };
    for (const row of await this.listReminders(undefined, window)) {
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

  /** Is a reminder standing for this event right now? — what ⏰ toggles on. */
  async hasReminder(chatId: string, itemId: string): Promise<boolean> {
    const rows = await this.d.all(
      sql`SELECT id FROM ${this.d.schema.reminders} WHERE chat_id = ${chatId} AND item_id = ${itemId} AND cancelled = 0`,
    );
    return rows.length > 0;
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

  /* --------------------------------------------------- "show more" stash --- */

  /**
   * Park the ranked-but-unshown tail of one answer, so "показати ще" can hand
   * out the next page without scraping anybody's site a second time.
   *
   * It lives in the scrape-cache table on purpose: that table already carries
   * `expires_at`, and `pruneCache` already sweeps it, so a stash nobody comes
   * back for disappears within the hour instead of growing forever.
   */
  async putPage(key: string, page: PendingPage, ttlSeconds: number): Promise<void> {
    const t = this.d.schema;
    const now = Date.now();
    const payload = JSON.stringify(page);
    await this.d.run(sql`
      INSERT INTO ${t.scrapeCache} (key, payload, created_at, expires_at)
      VALUES (${key}, ${payload}, ${new Date(now).toISOString()}, ${new Date(now + ttlSeconds * 1000).toISOString()})
      ON CONFLICT (key) DO UPDATE SET
        payload    = ${payload},
        created_at = ${new Date(now).toISOString()},
        expires_at = ${new Date(now + ttlSeconds * 1000).toISOString()}
    `);
  }

  /** The stash for one answer, or null when it expired or was never there. */
  async getPage(key: string): Promise<PendingPage | null> {
    const rows = await this.d.all(
      sql`SELECT payload, expires_at FROM ${this.d.schema.scrapeCache} WHERE key = ${key}`,
    );
    const row = rows[0];
    if (!row) return null;
    const expires = typeof row['expires_at'] === 'string' ? Date.parse(row['expires_at']) : 0;
    if (!expires || expires <= Date.now()) return null;
    try {
      const parsed = PendingPageSchema.safeParse(JSON.parse(String(row['payload'] ?? 'null')));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async dropPage(key: string): Promise<void> {
    await this.d.run(sql`DELETE FROM ${this.d.schema.scrapeCache} WHERE key = ${key}`);
  }

  async pruneCache(): Promise<void> {
    // `<=`, as getCache reads it: an entry whose ttl is up already counts as
    // stale, and a strict `<` left a 0-ttl row behind whenever the prune
    // happened in the same millisecond the row was written.
    await this.d.run(sql`DELETE FROM ${this.d.schema.scrapeCache} WHERE expires_at <= ${nowIso()}`);
  }

  /**
   * Housekeeping: drop the cache rows that have expired and the bookkeeping
   * nobody can use any more. Without this, `messages`, `deliveries` and
   * `usage` only ever grow — a year of weekly digests for a hundred people is
   * a few hundred thousand rows about events that have already happened.
   *
   * Called at the end of every fan-out job, so there is nothing extra to cron.
   */
  async prune(): Promise<void> {
    await this.pruneCache();
    const t = this.d.schema;
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    // a ❤️ resolves through `messages`, so these outlive the digest itself
    await this.d.run(sql`DELETE FROM ${t.messages} WHERE sent_at < ${daysAgo(RETENTION.messagesDays)}`);
    await this.d.run(sql`DELETE FROM ${t.deliveries} WHERE last_sent_at < ${daysAgo(RETENTION.deliveriesDays)}`);
    await this.d.run(sql`DELETE FROM ${t.reminders} WHERE starts_at < ${daysAgo(RETENTION.remindersDays)}`);
    await this.d.run(
      sql`DELETE FROM ${t.usage} WHERE bucket < ${new Date(Date.now() - RETENTION.usageHours * 3_600_000).toISOString().slice(0, 13)}`,
    );
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
