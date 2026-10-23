import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';

/** Root of the skill (the directory holding SKILL.md). */
export const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Hermes home, overridable for tests. */
export const HERMES_HOME = process.env['HERMES_HOME'] || join(homedir(), '.hermes');

// Read .env *before* the paths below. These consts are evaluated on import,
// and the first thing to call loadEnv() used to be loadConfig() — long after,
// so an EVENTS_FINDER_DB or EVENTS_FINDER_CONFIG set in .env was ignored in
// silence. (HERMES_HOME cannot come from .env: it is where .env lives.)
loadEnv();

/** Per-skill data dir: SQLite db, logs, GramJS session, websearch inbox. */
export const DATA_DIR = process.env['EVENTS_FINDER_DATA'] || join(HERMES_HOME, 'data', 'events-finder');
export const LOG_DIR = join(DATA_DIR, 'logs');
export const LOG_FILE = join(LOG_DIR, 'events-finder.log');
/**
 * SQLite database file, used unless DATABASE_URL points at Postgres.
 * (A stale `state.db` from an older implementation is left alone.)
 */
export const DB_FILE = process.env['EVENTS_FINDER_DB'] || join(DATA_DIR, 'events.db');
export const TG_SESSION_FILE = join(DATA_DIR, 'gramjs.session');
export const WEBSEARCH_INBOX = join(DATA_DIR, 'websearch-inbox.json');

export const CONFIG_FILE = process.env['EVENTS_FINDER_CONFIG'] || join(SKILL_DIR, 'config.yaml');
export const PREFS_FILE = process.env['EVENTS_FINDER_PREFS'] || join(SKILL_DIR, 'preferences.yaml');

export function ensureDirs(): void {
  for (const d of [DATA_DIR, LOG_DIR]) if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

/**
 * Minimal .env loader (no dotenv dependency). Later files do not override
 * variables already set in the real environment.
 * Reads <skill>/.env then ~/.hermes/.env.
 */
export function loadEnv(): void {
  for (const file of [join(SKILL_DIR, '.env'), join(HERMES_HOME, '.env')]) {
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  }
}
