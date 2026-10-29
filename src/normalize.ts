import type { Category, Item, Status } from './types.ts';
import { ItemSchema, formatZodError } from './types.ts';
import { SchemaEventSchema, type SchemaEvent } from './schemas.ts';
import { categoryFromSchemaType, classify } from './categories.ts';
import { localDate, sha1, titleKey, truncate } from './util.ts';
import { loadConfig } from './config.ts';

/**
 * Stable id, so the same show from three sources collapses into one row.
 *
 * The literal 'event' is the first thing hashed because it always was: ids
 * used to be keyed by an item's kind, and every id already in `deliveries`,
 * `saved` and `reminders` was hashed with it. Dropping it from the hash would
 * change every id there is and re-send everybody everything they have already
 * seen, which is a far worse outcome than one constant nobody reads.
 */
export function itemId(title: string, city: string, startsAt?: string, tz = loadConfig().timezone): string {
  const day = startsAt ? localDate(startsAt, tz) : '';
  return sha1('event', titleKey(title), city, day);
}

/** schema.org availability / eventStatus -> our status. */
export function statusFrom(availability?: string, eventStatus?: string): Status {
  const a = (availability ?? '').split('/').pop()?.toLowerCase() ?? '';
  const e = (eventStatus ?? '').split('/').pop()?.toLowerCase() ?? '';
  if (e.includes('cancel')) return 'cancelled';
  if (e.includes('postpone') || e.includes('reschedul')) return 'postponed';
  if (a.includes('soldout')) return 'soldout';
  if (a.includes('limited')) return 'limited';
  if (a.includes('instock') || a.includes('preorder') || e.includes('scheduled')) return 'scheduled';
  return 'unknown';
}

/**
 * Decide a category from three weak signals: the site's schema.org @type, our
 * text classifier, and the catalog page the item was found on.
 *
 * Ticket sites mark nearly everything as MusicEvent, so a clear text signal
 * ("вечір імпровізації", "вистава") is allowed to overrule that one type.
 */
export function pickCategory(schemaCat: Category | null, textCat: Category | null, slugCat?: Category): Category {
  if (schemaCat && schemaCat !== 'other') {
    if (schemaCat === 'concert' && textCat && textCat !== 'concert') return textCat;
    return schemaCat;
  }
  return textCat ?? (slugCat && slugCat !== 'other' ? slugCat : undefined) ?? schemaCat ?? 'other';
}

/**
 * One usable poster URL out of whatever a source published.
 *
 * Accepts a string, a schema.org ImageObject, or a list of either, and returns
 * only an absolute http(s) URL — Telegram is the one fetching it, and anything
 * else (a `data:` blob, a protocol-relative fragment, an empty attribute) would
 * come back as an error on the whole message.
 *
 * `base` is the event's own page, so a site serving `/uploads/poster.jpg` still
 * resolves. A URL that cannot be parsed yields undefined: an event with no
 * poster is a text message, which is what it was before.
 */
export function pickImage(raw: unknown, base?: string): string | undefined {
  for (const candidate of Array.isArray(raw) ? raw : [raw]) {
    const value =
      typeof candidate === 'string'
        ? candidate
        : candidate && typeof candidate === 'object'
          ? ['url', 'contentUrl'].map((k) => (candidate as Record<string, unknown>)[k]).find((v) => typeof v === 'string')
          : undefined;
    if (typeof value !== 'string' || !value.trim()) continue;
    let url: URL;
    try {
      url = new URL(value.trim(), base);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    // Concert.ua appends an imgproxy-style ":<preset>" to the file name, and the
    // preset its catalog pages use is a 270x200 thumbnail. The bare path is the
    // full-size poster, which is what belongs under a digest card.
    if (/(^|\.)concert\.ua$/.test(url.hostname)) {
      url.pathname = url.pathname.replace(/\.(jpe?g|png|webp):[\w.-]+$/i, '.$1');
    }
    return url.toString();
  }
  return undefined;
}

export interface NormalizeOpts {
  city: string;
  source: string;
  /** Fallback category when the object and its text give nothing away. */
  fallbackCategory?: Category;
  confidence?: 'high' | 'low';
  /** Called with a reason when an object is rejected. */
  onReject?: (reason: string) => void;
}

/**
 * A scraped schema.org Event (JSON-LD or microdata, already flattened) -> Item.
 * Returns null when the object is not usable; `onReject` explains why.
 */
export function fromSchemaEvent(raw: unknown, opts: NormalizeOpts): Item | null {
  const parsed = SchemaEventSchema.safeParse(raw);
  if (!parsed.success) {
    opts.onReject?.(formatZodError(parsed.error, 2));
    return null;
  }
  return buildFromSchemaEvent(parsed.data, opts);
}

function buildFromSchemaEvent(ev: SchemaEvent, opts: NormalizeOpts): Item | null {
  const url = ev.url ?? ev['@id'];
  if (!url) return null;

  const offer = ev.offers;
  const min = offer?.lowPrice ?? offer?.price;
  const maxRaw = offer?.highPrice ?? (offer?.lowPrice !== undefined ? offer.price ?? offer.lowPrice : offer?.price);
  const priceMax = maxRaw !== undefined && min !== undefined && maxRaw < min ? min : maxRaw;

  const address = typeof ev.location?.address === 'string' ? ev.location.address : ev.location?.address?.streetAddress;

  const performers = [ev.performer?.name, ev.workPerformed?.name].filter((n): n is string => Boolean(n));
  const description = ev.description?.trim() || undefined;

  const category = pickCategory(
    categoryFromSchemaType(ev['@type']),
    classify(`${ev.name} ${description ?? ''} ${performers.join(' ')}`),
    opts.fallbackCategory,
  );

  return validate(
    {
      id: itemId(ev.name, opts.city, ev.startDate),
      title: truncate(ev.name, 160),
      category,
      city: opts.city,
      venue: ev.location?.name?.trim() || undefined,
      address: address?.trim() || undefined,
      startsAt: ev.startDate,
      endsAt: ev.endDate,
      priceMin: min,
      priceMax,
      currency: offer?.priceCurrency ?? 'UAH',
      free: ev.isAccessibleForFree === true || min === 0 ? true : undefined,
      url,
      image: pickImage(ev.image, url),
      description: description ? truncate(description, 400) : undefined,
      source: opts.source,
      sources: [opts.source],
      status: statusFrom(offer?.availability, ev.eventStatus),
      performers: performers.length ? [...new Set(performers)] : undefined,
      confidence: opts.confidence ?? 'high',
    },
    opts,
  );
}

/** Build an Item from loose fields (Telegram posts, web results). */
export function makeItem(
  fields: Partial<Item> & { title: string; url: string; city: string; source: string },
  opts: { onReject?: (reason: string) => void } = {},
): Item | null {
  const category = fields.category ?? classify(`${fields.title} ${fields.description ?? ''}`) ?? 'other';
  return validate(
    {
      ...fields,
      id: fields.id ?? itemId(fields.title, fields.city, fields.startsAt),
      title: truncate(fields.title, 160),
      category,
      currency: fields.currency ?? 'UAH',
      free: fields.free ?? (fields.priceMin === 0 ? true : undefined),
      image: pickImage(fields.image, fields.url),
      description: fields.description ? truncate(fields.description, 400) : undefined,
      sources: fields.sources ?? [fields.source],
      status: fields.status ?? 'unknown',
      confidence: fields.confidence ?? 'low',
    },
    opts,
  );
}

function validate(candidate: unknown, opts: { onReject?: (reason: string) => void }): Item | null {
  const parsed = ItemSchema.safeParse(candidate);
  if (!parsed.success) {
    opts.onReject?.(formatZodError(parsed.error, 2));
    return null;
  }
  return parsed.data;
}

/** Price text for output: "350–900 ₴", "від 500 ₴", "до 390 ₴", "безкоштовно". */
export function priceText(item: Item): string {
  const sym = !item.currency || item.currency === 'UAH' ? '₴' : item.currency;
  if (item.free || item.priceMin === 0) return 'безкоштовно';
  const min = item.priceMin;
  const max = item.priceMax;
  // some sites use 0.01 as a placeholder "price on request" floor; rounding it
  // to 0 would advertise a free ticket that does not exist
  if (min !== undefined && min < 1 && max !== undefined && max >= 1) return `до ${Math.round(max)} ${sym}`;
  if (min !== undefined && max !== undefined && max > min) return `${Math.round(min)}–${Math.round(max)} ${sym}`;
  const one = min ?? max;
  if (one !== undefined) return one < 1 ? 'ціна невідома' : `від ${Math.round(one)} ${sym}`;
  return 'ціна невідома';
}

/** Parse "вхід вільний", "300 грн", "від 250 грн", "150-400 uah" out of free text. */
export function parsePriceText(text: string): { priceMin?: number; priceMax?: number; free?: boolean } {
  const t = text.toLowerCase();
  if (/(вхід|вход)\s*(вільний|вільна|свободный|free)|free entry|безкоштовн|бесплатн|donation|донат/.test(t)) {
    return { free: true, priceMin: 0 };
  }
  const range = t.match(/(\d{2,5})\s*[–—\-]\s*(\d{2,5})\s*(грн|uah|₴)/);
  if (range) return { priceMin: Number(range[1]), priceMax: Number(range[2]) };
  const from = t.match(/(?:від|от|from)\s*(\d{2,5})\s*(?:грн|uah|₴)?/);
  if (from) return { priceMin: Number(from[1]) };
  const one = t.match(/(\d{2,5})\s*(?:грн|uah|₴)/);
  if (one) return { priceMin: Number(one[1]) };
  return {};
}
