/**
 * Putting one event into somebody's own calendar.
 *
 * Google's TEMPLATE form takes everything in the query string, so this is a
 * plain link — no server side, nothing to generate at tap time, and it rides
 * along as a `url` button under the card.
 *
 * The stamps go out as honest UTC: `item.startsAt` already carries its offset,
 * so Google gets the instant and shows it in whatever zone the person is in,
 * with no TZID of ours to be trusted. An event with no start time has nothing
 * a calendar can hold — this returns undefined and `eventKeyboard` leaves the
 * button off that card rather than offering one that apologises.
 */
import type { Item } from './types.ts';

/** Two hours: long enough for a gig, short enough not to eat someone's evening. */
const DEFAULT_HOURS = 2;

/** `20261023T163000Z` — the only date form Google's `dates` parameter needs. */
function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** When it starts and ends, as instants. `endsAt` is often missing — guess, and say so. */
function window(item: Item): { start: Date; end: Date; guessedEnd: boolean } | undefined {
  if (!item.startsAt) return undefined;
  const start = new Date(Date.parse(item.startsAt));
  if (Number.isNaN(start.getTime())) return undefined;

  const parsed = item.endsAt ? Date.parse(item.endsAt) : NaN;
  // an end before the start is worse than no end at all
  if (!Number.isNaN(parsed) && parsed > start.getTime()) {
    return { start, end: new Date(parsed), guessedEnd: false };
  }
  return { start, end: new Date(start.getTime() + DEFAULT_HOURS * 3600_000), guessedEnd: true };
}

/**
 * A Google Calendar "add event" link with the form already filled in: title,
 * time, place, and the ticket link in the notes.
 */
export function googleCalendarUrl(item: Item): string | undefined {
  const when = window(item);
  if (!when) return undefined;

  const details = [
    item.description?.trim(),
    item.url,
    // the entry says 21:00 either way, so it had better admit where that came from
    when.guessedEnd ? `Тривалість приблизна (${DEFAULT_HOURS} год) — перевір на сторінці події.` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: item.title,
    dates: `${stamp(when.start)}/${stamp(when.end)}`,
    details,
  });
  const place = [item.venue, item.address].filter((x): x is string => Boolean(x?.trim())).join(', ');
  if (place) params.set('location', place);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
