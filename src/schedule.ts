/**
 * Per-person delivery schedule: at what hour, on what day, how often, and when
 * to keep quiet.
 *
 * The cron used to carry the schedule ("Monday 09:00 for everyone"). It now
 * ticks every hour and this module decides, for each user, whether *this* hour
 * is theirs. Everything here is pure and reads only the `users` row, so the
 * same answer comes out in a test, in the fan-out and in the settings screen.
 *
 * Two rules worth knowing before changing anything:
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
 *    the one failure mode that makes it worthless.
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

export const FREQUENCIES: { key: Frequency; label: string; hint: string }[] = [
  { key: 'weekly', label: 'Раз на тиждень', hint: 'лише тижневий дайджест' },
  { key: 'twice', label: 'Двічі на тиждень', hint: 'тижневий + вихідні' },
  { key: 'mine', label: 'Тільки коли є моє', hint: 'нічого, якщо список довелось розбавляти' },
];

export function isFrequency(value: unknown): value is Frequency {
  return value === 'weekly' || value === 'twice' || value === 'mine';
}

export interface UserSchedule {
  hour: number;
  day: number;
  quietFrom: number;
  quietTo: number;
  frequency: Frequency;
}

const DEFAULTS: UserSchedule = {
  hour: 9,
  day: 1,
  quietFrom: 23,
  quietTo: 8,
  /**
   * What the single hard-wired cron used to do: a weekly digest and a weekend
   * one. Anyone who registered before this feature existed keeps getting
   * exactly that.
   */
  frequency: 'twice',
};

function hourish(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : fallback;
}

/** The schedule of a user row, with every pre-schedule row reading as the old default. */
export function scheduleOf(row: Partial<UserRow> | undefined): UserSchedule {
  const day = Number(row?.digest_day);
  return {
    hour: hourish(row?.digest_hour, DEFAULTS.hour),
    day: Number.isInteger(day) && day >= 0 && day <= 6 ? day : DEFAULTS.day,
    quietFrom: hourish(row?.quiet_from, DEFAULTS.quietFrom),
    quietTo: hourish(row?.quiet_to, DEFAULTS.quietTo),
    frequency: isFrequency(row?.digest_freq) ? row.digest_freq : DEFAULTS.frequency,
  };
}

export const defaultSchedule = (): UserSchedule => ({ ...DEFAULTS });

/**
 * Is `hour` inside the quiet window? The window may wrap midnight (23 → 8),
 * and `from === to` means "no quiet hours at all" rather than "all day".
 */
export function inQuietHours(hour: number, quiet: { quietFrom: number; quietTo: number }): boolean {
  const { quietFrom: from, quietTo: to } = quiet;
  if (from === to) return false;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

export const hasQuietHours = (s: { quietFrom: number; quietTo: number }): boolean => s.quietFrom !== s.quietTo;

/** Which digest a fan-out is delivering. */
export type DigestKind = 'weekly' | 'weekend';

/**
 * Is this the hour at which this person wants this digest?
 *
 * Frequency is a narrowing on top of the per-job opt-in switches, never a way
 * around them: someone who muted the weekend digest stays muted whatever they
 * pick here. 'mine' leaves the timing alone — it is enforced after ranking,
 * by `toppedUp`, which is the only place that knows whether the list is
 * actually theirs.
 */
export function digestDueNow(
  schedule: UserSchedule,
  kind: DigestKind,
  now: { hour: number; weekday: number },
): boolean {
  if (schedule.hour !== now.hour) return false;
  if (kind === 'weekend') return schedule.frequency !== 'weekly' && now.weekday === WEEKEND_DAY;
  return now.weekday === schedule.day;
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

export function quietLabel(s: UserSchedule): string {
  return hasQuietHours(s) ? `${hourLabel(s.quietFrom)}–${hourLabel(s.quietTo)}` : 'вимкнено';
}

export function frequencyLabel(f: Frequency): string {
  return FREQUENCIES.find((x) => x.key === f)?.label ?? f;
}

/** One line for the settings screen. */
export function describeSchedule(s: UserSchedule): string {
  const when =
    s.frequency === 'weekly' ? `${dayLabelUk(s.day)}, ${hourLabel(s.hour)}`
    : `${dayLabelUk(s.day)} і четвер, ${hourLabel(s.hour)}`;
  return `${when} · ${frequencyLabel(s.frequency).toLowerCase()} · тихі години ${quietLabel(s)}`;
}
