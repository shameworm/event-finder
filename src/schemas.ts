/**
 * Zod schemas for everything that arrives from outside this codebase:
 * YAML files, scraped schema.org markup, Telegram API payloads and the
 * agent's web-search hand-off file.
 *
 * Scraped data is parsed *leniently* — a site adding a field or sending a
 * price as a string must never crash a run — but a missing name/url is a
 * hard failure for that one item, which the caller skips.
 */
import { z } from 'zod';
import { CategorySchema, KindSchema, StatusSchema } from './types.ts';

/* ------------------------------------------------------------ config.yaml --- */

/**
 * Config objects are strict: an unknown key in config.yaml is a typo, and
 * silently falling back to the default for the key the operator *meant* is
 * how `delay_ms: 1500` written as `delay-ms` became "no delay at all, and no
 * way to tell". Scraped data stays lenient (`.loose()`) — that is not ours.
 */
export const ConcertUaCitySchema = z.strictObject({
  slug: z.string().min(1),
  categories: z.array(z.string()).optional(),
});

export const KarabasCitySchema = z.strictObject({
  subdomain: z.string().min(1),
  paths: z.array(z.string()).optional(),
});

export const KontramarkaCitySchema = z.strictObject({
  /** Empty string means the bare domain (Kyiv). */
  subdomain: z.string().default(''),
  categories: z.array(z.string()).optional(),
});

export const CityConfigSchema = z.strictObject({
  label: z.string().optional(),
  aliases: z.array(z.string()).default([]),
  concertua: ConcertUaCitySchema.optional(),
  karabas: KarabasCitySchema.optional(),
  kontramarka: KontramarkaCitySchema.optional(),
  telegram_channels: z.array(z.string()).default([]),
  place_queries: z.array(z.string()).default([]),
});

export const ConfigSchema = z.strictObject({
  timezone: z.string().default('Europe/Kyiv'),
  default_city: z.string().default('kharkiv'),
  locale: z.string().default('uk-UA'),
  http: z
    .strictObject({
      delay_ms: z.number().int().nonnegative().default(1500),
      timeout_ms: z.number().int().positive().default(20000),
      retries: z.number().int().nonnegative().max(10).default(2),
      max_pages: z.number().int().positive().max(50).default(6),
      user_agent: z.string().min(10).default(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      ),
    })
    .prefault({}),
  telegram: z
    .strictObject({
      parse_mode: z.enum(['HTML', 'MarkdownV2']).default('HTML'),
      disable_preview: z.boolean().default(true),
    })
    .prefault({}),
  digest: z
    .strictObject({
      max_items_per_day: z.number().int().nonnegative().default(8),
      week_top: z.number().int().positive().default(15),
      weekend_top: z.number().int().positive().default(5),
      places_top: z.number().int().positive().default(3),
    })
    .prefault({}),
  bot: z
    .strictObject({
      /** false = only chat ids on the allowlist may use the bot. */
      public: z.boolean().default(true),
      allowlist: z.array(z.coerce.string()).default([]),
      /** Searches per user per hour; each one can trigger a scrape. */
      searches_per_hour: z.number().int().positive().default(20),
      /**
       * /feedback messages per user per hour. Its own budget, in its own
       * hourly bucket: a bug report must not cost somebody a search, and a
       * channel pointing at one human still needs a floodgate.
       */
      feedback_per_hour: z.number().int().positive().default(5),
      /** Items the header's "показати ще" hands out in one go. */
      max_results: z.number().int().positive().default(10),
      /**
       * Cards sent for a fresh answer, before anyone taps anything. One, so a
       * busy weekend arrives as a card you can act on rather than forty
       * notifications; "Далі →" under it walks the rest, one at a time.
       */
      cards_at_once: z.number().int().positive().default(1),
      /** Pause between users when fanning a digest out, to stay under Telegram's rate limit. */
      send_delay_ms: z.number().int().nonnegative().default(60),
      /** Pause between the messages of one digest — each event is its own message. */
      message_delay_ms: z.number().int().nonnegative().default(400),
      /** Pages per source for on-demand searches — keep it small, people are waiting. */
      interactive_pages: z.number().int().positive().default(2),
      /**
       * Answers are filtered to what each person likes. When fewer than this
       * many of their things are on, the next best are let back in rather than
       * sending someone an almost empty list.
       */
      taste_floor: z.number().int().nonnegative().default(5),
    })
    .prefault({}),
  cache: z
    .strictObject({
      /** How long a scraped city/window stays reusable. 0 disables the cache. */
      ttl_seconds: z.number().int().nonnegative().default(1800),
    })
    .prefault({}),
  cities: z.record(z.string(), CityConfigSchema).default({}),
});

export type ConfigInput = z.input<typeof ConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;
export type CityConfig = z.infer<typeof CityConfigSchema>;

/* --------------------------------------------------- scraped schema.org --- */

/** A price that may arrive as 790, "790", "790.00" or "от 790 грн". */
export const LoosePrice = z.preprocess((v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    const m = v.replace(/\s/g, '').replace(',', '.').match(/\d+(\.\d+)?/);
    return m ? Number(m[0]) : undefined;
  }
  return undefined;
}, z.number().nonnegative().optional());

/** schema.org values are often wrapped in a one-element array. */
const unwrap = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (Array.isArray(v) ? v[0] : v), schema);

const NameOnly = z.object({ name: z.string().optional() }).loose();

/**
 * schema.org `image`: a bare URL on Concert.ua, an ImageObject on Karabas, and
 * sometimes a list of either. Anything else becomes undefined rather than a
 * parse failure — a site changing this field must cost the poster, not the event.
 */
export const SchemaImageSchema = z
  .union([
    z.string(),
    z.object({ url: z.string().optional(), contentUrl: z.string().optional() }).loose(),
    z.array(z.union([z.string(), z.object({ url: z.string().optional(), contentUrl: z.string().optional() }).loose()])),
  ])
  .optional()
  .catch(undefined);

export const SchemaOfferSchema = z
  .object({
    price: LoosePrice,
    lowPrice: LoosePrice,
    highPrice: LoosePrice,
    priceCurrency: z.string().optional(),
    availability: z.string().optional(),
    url: z.string().optional(),
  })
  .loose();

export const SchemaPlaceSchema = z
  .object({
    name: z.string().optional(),
    address: unwrap(
      z.union([z.string(), z.object({ streetAddress: z.string().optional(), addressLocality: z.string().optional() }).loose()]).optional(),
    ),
  })
  .loose();

/** One schema.org Event, as published by Concert.ua / Karabas / Kontramarka. */
export const SchemaEventSchema = z
  .object({
    '@type': z.union([z.string(), z.array(z.string())]).optional(),
    '@id': z.string().optional(),
    name: z.string().min(1),
    url: z.string().optional(),
    description: z.string().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    eventStatus: z.string().optional(),
    isAccessibleForFree: z.boolean().optional(),
    image: SchemaImageSchema,
    location: unwrap(SchemaPlaceSchema.optional()),
    offers: unwrap(SchemaOfferSchema.optional()),
    performer: unwrap(NameOnly.optional()),
    workPerformed: unwrap(NameOnly.optional()),
  })
  .loose()
  // either url or @id must be usable as a link
  .refine((o) => Boolean(o.url || o['@id']), { message: 'event has no url' });

export type SchemaEvent = z.infer<typeof SchemaEventSchema>;

/* ------------------------------------------------------ telegram bot api --- */

export const TgMessageSchema = z
  .object({
    message_id: z.number().int(),
    date: z.number().int(),
    chat: z.object({ id: z.union([z.number(), z.string()]), type: z.string().optional() }).loose(),
    text: z.string().optional(),
    /** A poster card arrives as a photo: its words are here, not in `text`. */
    caption: z.string().optional(),
    /** Present exactly when the message is a photo; only its existence is ever used. */
    photo: z.array(z.object({ file_id: z.string() }).loose()).optional(),
    reply_to_message: z.object({ message_id: z.number().int(), text: z.string().optional() }).loose().optional(),
    from: z.object({ id: z.number(), username: z.string().optional() }).loose().optional(),
  })
  .loose();

/** One entry of a reaction list: `{ type: 'emoji', emoji: '❤️' }`. */
export const TgReactionTypeSchema = z
  .object({ type: z.string(), emoji: z.string().optional() })
  .loose();

/**
 * A `message_reaction` update: someone added or removed a reaction on one of
 * our messages. Telegram sends the whole before/after list rather than a diff,
 * so "did a heart appear?" is a comparison of the two.
 */
export const TgReactionUpdateSchema = z
  .object({
    chat: z.object({ id: z.union([z.number(), z.string()]), type: z.string().optional() }).loose(),
    message_id: z.number().int(),
    date: z.number().int().optional(),
    user: z.object({ id: z.number(), username: z.string().optional() }).loose().optional(),
    old_reaction: z.array(TgReactionTypeSchema).default([]),
    new_reaction: z.array(TgReactionTypeSchema).default([]),
  })
  .loose();

/** A tap on an inline button, e.g. one of the toggles in /settings. */
export const TgCallbackQuerySchema = z
  .object({
    id: z.string(),
    data: z.string().optional(),
    message: TgMessageSchema.optional(),
    from: z.object({ id: z.union([z.number(), z.string()]), username: z.string().optional() }).loose().optional(),
  })
  .loose();

export const TgUpdateSchema = z
  .object({
    update_id: z.number().int(),
    message: TgMessageSchema.optional(),
    edited_message: TgMessageSchema.optional(),
    callback_query: TgCallbackQuerySchema.optional(),
    message_reaction: TgReactionUpdateSchema.optional(),
  })
  .loose();

export const TgResponseSchema = <T extends z.ZodTypeAny>(result: T) =>
  z.object({ ok: z.boolean(), result: result.optional(), description: z.string().optional() }).loose();

export type TgMessage = z.infer<typeof TgMessageSchema>;
export type TgUpdate = z.infer<typeof TgUpdateSchema>;
export type TgCallbackQuery = z.infer<typeof TgCallbackQuerySchema>;
export type TgReactionUpdate = z.infer<typeof TgReactionUpdateSchema>;

/* -------------------------------------------------- web-search hand-off --- */

/**
 * What the agent writes back after running the queries from
 * `scripts/websearch.ts --queries` with its own web_search tool.
 * Deliberately forgiving: title + url are the only required fields.
 */
export const WebResultSchema = z.object({
  title: z.string().min(1),
  url: z.string().min(1),
  snippet: z.string().optional(),
  description: z.string().optional(),
  city: z.string().optional(),
  kind: KindSchema.optional(),
  category: CategorySchema.optional(),
  venue: z.string().optional(),
  address: z.string().optional(),
  /** ISO date/time or free text ("25 жовтня, 19:00") — parsed downstream. */
  date: z.string().optional(),
  startsAt: z.string().optional(),
  price: z.string().optional(),
  status: StatusSchema.optional(),
  /** Poster URL, if the result carried one. */
  image: z.string().optional(),
});

export const WebIngestSchema = z.union([
  z.array(WebResultSchema),
  z.object({
    city: z.string().optional(),
    kind: KindSchema.optional(),
    results: z.array(WebResultSchema),
  }),
]);

export type WebResult = z.infer<typeof WebResultSchema>;

/* ------------------------------------------------------- gramjs messages --- */

export const TgChannelPostSchema = z.object({
  id: z.number().int(),
  channel: z.string().min(1),
  date: z.number().int().optional(),
  text: z.string().default(''),
});

export type TgChannelPost = z.infer<typeof TgChannelPostSchema>;
