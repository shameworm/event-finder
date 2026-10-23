/**
 * Per-person delivery schedule: at what hour, and on which days of the week.
 *
 * The cron used to carry the schedule ("Monday 09:00 for everyone"). It now
 * ticks every hour and this module decides, for each user, whether *this* hour
 * is theirs. Everything here is pure and reads only the `users` row, so the
 * same answer comes out in a test, in the fan-out and in the settings screen.
 *
 * **The whole schedule is an hour and a set of days.** There is no separate
 * "how often": ticking two days *is* twice a week. Thursday is the one day
 * with a meaning of its own — the digest that arrives on Thursday covers
 * Friday–Sunday, because a weekend digest any later would be useless — so
 * ticking Thursday is how you ask for the weekend picks.
 *
 * Three rules worth knowing before changing anything:
 *
 *  - **Hours are a short menu, not a free dial** (`DIGEST_HOURS`). A free
 *    choice of all 24 hours would smear the weekly digest across 7 × 24 = 168
 *    separate fan-outs a week, and every one of them re-scrapes the cities it
 *    covers — the 30-minute cache only shares a scrape *inside* one hour. Six
 *    slots keep that bounded; see the README for the arithmetic.
 *
 *  - **Quiet hours do not apply to a digest.** Someone who asks for 07:00 has
 *    already said 07:00 is fine, and silently swallowing their own choice
 *    would make the hour picker look broken. Quiet hours gate the sends the
 *    user did not schedule: follow alerts, place tips, and the "tomorrow"
 *    reminder. The "in ~3 hours" reminder always goes out — arriving late is
 *    the one failure mode that makes it worthless. They are not on the
 *    settings panel any more; the columns keep their defaults and the operator
 *    can still set them by hand.
 *
 *  - **The panel offers an hour and days, and nothing else.** `frequency` and
 *    the quiet window are still read here — a row written before this was
 *    simplified keeps behaving exactly as it did — but nothing in the bot
 *    writes them any more.
 */
import type { UserRow } from './db.ts';

/** The hours a digest may be delivered at, local to `config.timezone`. */
export const DIGEST_HOURS = [7, 9, 12, 15, 18, 21] as const;

/** 0 = Sunday … 6 = Saturday, matching `localWeekday()`. */
export const DIGEST_DAYS: { day: number; label: string; short: string }[] = [
  { day: 1, label: 'понеділок', short: 'Пн' },
  { day: 2, label: 'вівторок', short: 'Вт' },
  { day: 3, label: 'середа', short: 'Ср' },
  { day: 4, label: 'четвер', short: 'Чт' },
  { day: 5, label: 'пʼятниця', short: 'Пт' },
  { day: 6, label: 'субота', short: 'Сб' },
  { day: 0, label: 'неділя', short: 'Нд' },
];

/**
 * The weekend digest is about Friday–Sunday, so its day is not a matter of
 * taste: any later and it is useless. The user picks only the hour.
 */
export const WEEKEND_DAY = 4; // Thursday

export type Frequency = 'weekly' | 'twice' | 'mine';

/** Kept only for rows written before the panel was simplified — see `scheduleOf`. */
export function isFrequency(value: unknown): value is Frequency {
  return value === 'weekly' || value === 'twice' || value === 'mine';
}

export interface UserSchedule {
  hour: number;
  /** The weekdays a digest arrives, 0 = Sunday … 6 = Saturday. Never empty. */
  days: number[];
  quietFrom: number;
  quietTo: number;
  /** Legacy only — the "say nothing rather than pad the list" narrowing. */
  frequency: Frequency;
}

const DEFAULTS: UserSchedule = {
  hour: 9,
  // what the single hard-wired cron did: Monday, plus Thursday's weekend picks
  days: [1, WEEKEND_DAY],
  quietFrom: 23,
  quietTo: 8,
  frequency: 'twice',
};

/** Пн … Нд, so Sunday reads last rather than first. */
const byWeekday = (a: number, b: number): number => (a || 7) - (b || 7);

const isDay = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 6;

function hourish(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : fallback;
}

/**
 * The days out of the `digest_days` bitmask, or — when that column is still
 * NULL — the days the legacy `digest_day` + `digest_freq` pair meant: that one
 * day, plus Thursday unless they had asked for the weekly one only.
 */
function daysOf(mask: number | null | undefined, day: number, frequency: Frequency): number[] {
  if (mask !== null && mask !== undefined && Number.isInteger(mask) && mask > 0) return daysFromMask(mask);
  return [...new Set(frequency === 'weekly' ? [day] : [day, WEEKEND_DAY])].sort(byWeekday);
}

/** The weekday set as one bit per day (bit 0 = Sunday), which is how it is stored. */
export function daysMask(days: number[]): number {
  return days.filter(isDay).reduce((mask, day) => mask | (1 << day), 0);
}

/** The inverse: the stored bitmask as a sorted Пн…Нд array. */
export function daysFromMask(mask: number): number[] {
  const days: number[] = [];
  for (let day = 0; day <= 6; day++) if (mask & (1 << day)) days.push(day);
  return days.sort(byWeekday);
}

/** The schedule of a user row, with every pre-schedule row reading as the old default. */
export function scheduleOf(row: Partial<UserRow> | undefined): UserSchedule {
  const day = Number(row?.digest_day);
  const weekly = isDay(day) ? day : DEFAULTS.days[0]!;
  const frequency = isFrequency(row?.digest_freq) ? row.digest_freq : DEFAULTS.frequency;
  return {
    hour: hourish(row?.digest_hour, DEFAULTS.hour),
    days: daysOf(row?.digest_days, weekly, frequency),
    quietFrom: hourish(row?.quiet_from, DEFAULTS.quietFrom),
    quietTo: hourish(row?.quiet_to, DEFAULTS.quietTo),
    frequency,
  };
}

export const defaultSchedule = (): UserSchedule => ({ ...DEFAULTS, days: [...DEFAULTS.days] });

/**
 * Is `hour` inside the quiet window? The window may wrap midnight (23 → 8),
 * and `from === to` means "no quiet hours at all" rather than "all day".
 */
export function inQuietHours(hour: number, quiet: { quietFrom: number; quietTo: number }): boolean {
  const { quietFrom: from, quietTo: to } = quiet;
  if (from === to) return false;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

/** Which digest a fan-out is delivering. */
export type DigestKind = 'weekly' | 'weekend';

/**
 * Is this the hour at which this person wants this digest?
 *
 * The whole rule is "their hour, and one of their days" — with Thursday
 * reserved for the weekend picks, so it never doubles up: someone who ticks
 * Thursday gets the Fri–Sun digest there, not the weekly one as well.
 */
export function digestDueNow(
  schedule: UserSchedule,
  kind: DigestKind,
  now: { hour: number; weekday: number },
): boolean {
  if (schedule.hour !== now.hour) return false;
  if (!schedule.days.includes(now.weekday)) return false;
  return kind === 'weekend' ? now.weekday === WEEKEND_DAY : now.weekday !== WEEKEND_DAY;
}

/**
 * May this reminder go out at `hour`?
 *
 * The "in ~3 hours" reminder is exempt from quiet hours, and that is the
 * deliberate decision rather than an oversight: a reminder for a 21:00 gig,
 * held until the quiet window ends at 08:00 the next morning, is not a
 * politeness — it is the feature failing. The "tomorrow" one has a whole day
 * of slack, so it waits; the row is left unfired and the next tick delivers it.
 */
export function reminderAllowedNow(which: '1d' | '3h', hour: number, schedule: UserSchedule): boolean {
  return which === '3h' || !inQuietHours(hour, schedule);
}

/** 'mine' means: say nothing rather than send a list that had to be padded. */
export function wantsOnlyMine(schedule: UserSchedule): boolean {
  return schedule.frequency === 'mine';
}

/* ------------------------------------------------------------------ words --- */

export const hourLabel = (hour: number): string => `${String(hour).padStart(2, '0')}:00`;

export function dayLabelUk(day: number): string {
  return DIGEST_DAYS.find((d) => d.day === day)?.label ?? 'понеділок';
}

/**
 * Flip one day on or off. The last day always stays on — a schedule with no
 * days in it would be a user who opted in and can never hear from the bot,
 * which is the same trap as an empty allowlist.
 *
 * @returns the new set, or null when the tap would have emptied it.
 */
export function toggleDay(days: number[], day: number): number[] | null {
  const next = days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort(byWeekday);
  return next.length ? next : null;
}

/** "понеділок і четвер", "усі сім днів", or one day on its own. */
export function daysLabel(days: number[]): string {
  if (days.length === 0) return 'ніколи';
  if (days.length === 7) return 'щодня';
  const names = [...days].sort(byWeekday).map(dayLabelUk);
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} і ${names[names.length - 1]!}`;
}

/** One line for the settings screen. */
export function describeSchedule(s: UserSchedule): string {
  return `${daysLabel(s.days)}, ${hourLabel(s.hour)}`;
}
