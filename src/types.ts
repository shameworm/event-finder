/**
 * Shared, typed shape of everything this skill produces.
 *
 * Zod is the single source of truth: types are inferred from the schemas, and
 * anything crossing a trust boundary (scraped HTML, Telegram posts, web-search
 * results, YAML config, the SQLite/Postgres round-trip) is parsed through them.
 */
import { z } from 'zod';

export const CategorySchema = z.enum([
  // events
  'concert', 'standup', 'theatre', 'exhibition', 'lecture', 'party', 'festival',
  'workshop', 'cinema', 'kids', 'sport', 'other',
  // places
  'cafe', 'bar', 'gallery', 'spot',
]);
export type Category = z.infer<typeof CategorySchema>;

export const StatusSchema = z.enum(['scheduled', 'limited', 'soldout', 'cancelled', 'postponed', 'unknown']);
export type Status = z.infer<typeof StatusSchema>;

export const KindSchema = z.enum(['event', 'place']);
export type Kind = z.infer<typeof KindSchema>;

/** One normalized event or place — the only format the pipeline passes around. */
export const ItemSchema = z.object({
  /** Stable id: sha1 of (kind, title signature, city, local date). Drives dedupe and "already sent". */
  id: z.string().min(1),
  kind: KindSchema,
  title: z.string().min(1),
  category: CategorySchema,
  /** Canonical city key from config.yaml, e.g. "kharkiv". */
  city: z.string().min(1),
  venue: z.string().optional(),
  address: z.string().optional(),
  /**
   * ISO 8601 with offset, e.g. 2026-10-24T22:00:00+03:00. Absent for places.
   * Sources do hand over human text ("щотижня", "25 жовтня") — an unparseable
   * date is dropped rather than kept, so it renders as "дата уточнюється"
   * instead of poisoning the ranking and the day grouping with NaN.
   */
  startsAt: z
    .string()
    .optional()
    .transform((v) => (v !== undefined && Number.isNaN(Date.parse(v)) ? undefined : v)),
  endsAt: z.string().optional(),
  priceMin: z.number().nonnegative().optional(),
  priceMax: z.number().nonnegative().optional(),
  currency: z.string().optional(),
  free: z.boolean().optional(),
  url: z.string().min(1),
  /**
   * Poster URL, absolute http(s). Telegram fetches it itself when the card
   * goes out as a photo, so nothing is ever downloaded here.
   *
   * Optional on purpose: it arrived after scrape_cache was already full of
   * payloads without it, and those rows must keep parsing.
   */
  image: z.string().optional(),
  description: z.string().optional(),
  /** Source key: "concert.ua", "karabas", "kontramarka", "telegram:@channel", "websearch". */
  source: z.string().min(1),
  /** Every source this item was seen on (filled by the deduper). */
  sources: z.array(z.string()).default([]),
  status: StatusSchema,
  performers: z.array(z.string()).optional(),
  /** Ranker output; higher is better. */
  score: z.number().optional(),
  /** Why it scored that way — shown with --explain. */
  reasons: z.array(z.string()).optional(),
  /** Telegram posts and web results are 'low': the agent may rewrite them. */
  confidence: z.enum(['high', 'low']).optional(),
});
export type Item = z.infer<typeof ItemSchema>;

/** Every source returns this, so one failing source can never kill a run. */
export const SourceResultSchema = z.object({
  source: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
  items: z.array(ItemSchema),
  /** Pages/channels/queries actually fetched — for logging. */
  fetched: z.number().int().optional(),
});
export type SourceResult = z.infer<typeof SourceResultSchema>;

const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/** A parsed user request. */
export const QuerySchema = z.object({
  /** Canonical city keys; the first is the primary city. */
  cities: z.array(z.string()).min(1),
  from: DateOnly,
  to: DateOnly,
  /** Category keys and free-text tags liked / disliked for this request. */
  like: z.array(z.string()).default([]),
  dislike: z.array(z.string()).default([]),
  maxPrice: z.number().positive().optional(),
  /** Original free text, kept for logging and for the agent. */
  text: z.string().optional(),
  /** How the date range was understood ("this weekend", "25–27 жовтня"). */
  rangeLabel: z.string(),
  kinds: z.array(KindSchema).min(1),
});
export type Query = z.infer<typeof QuerySchema>;

export const TripSchema = z.object({
  city: z.string().min(1),
  from: DateOnly,
  to: DateOnly,
});
export type Trip = z.infer<typeof TripSchema>;

/** preferences.yaml, after validation. */
export const PreferencesSchema = z.object({
  home_city: z.string().min(1).default('kharkiv'),
  watch_cities: z.array(z.string()).default([]),
  favourite_categories: z.array(z.string()).default([]),
  disliked_categories: z.array(z.string()).default([]),
  follow: z.array(z.string()).default([]),
  max_ticket_price: z.number().positive().nullable().default(null),
  currency: z.string().default('UAH'),
  /** Temporary location, set by "I'm in Lviv next week". */
  trip: TripSchema.nullable().default(null),
  /** Free-text interests used for ranking and place suggestions. */
  interests: z.array(z.string()).default([]),
  /**
   * The running tally for each tag: ❤️ adds a point, 👎 takes one away, so a
   * category someone keeps hearting outranks one they hearted once and a
   * category they keep waving off sinks towards the dislikes. Goes negative —
   * that is the whole point of the 👎 side. Written by the bot, not by hand.
   */
  taste: z.record(z.string(), z.number()).default({}),
  /**
   * Performers silenced by an explicit 👎. Stronger than `follow`: a name here
   * is never shown even if the category is a favourite, and even if the same
   * name wandered into the follow list from an earlier ❤️.
   */
  blocked_acts: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
});
export type Preferences = z.infer<typeof PreferencesSchema>;

/** Render a zod failure as a short, human list of problems. */
export function formatZodError(err: z.ZodError, limit = 6): string {
  return err.issues
    .slice(0, limit)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}
