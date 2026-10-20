import type { Item, Query } from './types.ts';
import { localDate } from './util.ts';
import { loadConfig } from './config.ts';

/** Is this item inside the requested local date window? Items without a date pass. */
export function inWindow(item: Item, query: Query, tz = loadConfig().timezone): boolean {
  if (!item.startsAt) return true;
  const day = localDate(item.startsAt, tz);
  if (!day) return true;
  return day >= query.from && day <= query.to;
}

/** Keep only the kinds the request asked for. */
export function wantedKind(item: Item, query: Query): boolean {
  return query.kinds.includes(item.kind);
}
