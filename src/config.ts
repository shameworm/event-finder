import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { CONFIG_FILE, PREFS_FILE, SKILL_DIR, loadEnv } from './paths.ts';
import { normText } from './util.ts';
import { ConfigSchema, type CityConfig, type Config } from './schemas.ts';
import { PreferencesSchema, formatZodError, type Preferences } from './types.ts';

export type { CityConfig, Config } from './schemas.ts';

function readYaml(file: string): unknown {
  if (!existsSync(file)) return {};
  return parseYaml(readFileSync(file, 'utf8')) ?? {};
}

let cached: Config | null = null;

/** Which config file is actually in use (falls back to the committed example). */
export function configSource(): string {
  return existsSync(CONFIG_FILE) ? CONFIG_FILE : join(SKILL_DIR, 'config.example.yaml');
}

/** Load and validate config.yaml. Throws with a readable message if it is wrong. */
export function loadConfig(): Config {
  if (cached) return cached;
  loadEnv();
  const file = configSource();
  if (!existsSync(file)) throw new Error(`No config.yaml and no config.example.yaml in ${SKILL_DIR}`);

  const parsed = ConfigSchema.safeParse(readYaml(file));
  if (!parsed.success) {
    throw new Error(`${file} is invalid — ${formatZodError(parsed.error)}`);
  }
  const cfg = parsed.data;
  // default a city's label to its key
  for (const [key, city] of Object.entries(cfg.cities)) {
    if (!city.label) city.label = key;
  }
  cached = cfg;
  return cfg;
}

/** Test seam: forget the cached config (used by tests and by prefs edits). */
export function resetConfigCache(): void {
  cached = null;
}

/**
 * Resolve any spelling of a city ("Харкові", "kharkov", "Kharkiv") to its
 * config key, or null when the city is unknown.
 */
export function resolveCity(name: string, cfg = loadConfig()): string | null {
  const n = normText(name);
  if (!n) return null;
  if (cfg.cities[n]) return n;
  for (const [key, c] of Object.entries(cfg.cities)) {
    if (normText(key) === n || normText(c.label ?? key) === n) return key;
    if (c.aliases.some((a) => normText(a) === n)) return key;
  }
  // last resort: partial match, so "харкові" still finds "харків"
  for (const [key, c] of Object.entries(cfg.cities)) {
    for (const a of [key, c.label ?? key, ...c.aliases]) {
      const na = normText(a);
      if (na.length >= 4 && (n.includes(na) || na.includes(n))) return key;
    }
  }
  return null;
}

export function cityLabel(key: string, cfg = loadConfig()): string {
  return cfg.cities[key]?.label ?? key;
}

export function cityConfig(key: string, cfg = loadConfig()): CityConfig | undefined {
  return cfg.cities[key];
}

/**
 * The city's name in Ukrainian, for web-search queries — Ukrainian listings do
 * not say "Kharkiv". Taken from the first Cyrillic alias in config.yaml.
 */
export function cityLocalName(key: string, cfg = loadConfig()): string {
  const alias = cfg.cities[key]?.aliases.find((a) => /[\u0400-\u04ff]/.test(a));
  if (!alias) return cityLabel(key, cfg);
  return alias.charAt(0).toUpperCase() + alias.slice(1);
}

/* ------------------------------------------------------------ preferences --- */

export function prefsSource(): string {
  return existsSync(PREFS_FILE) ? PREFS_FILE : join(SKILL_DIR, 'preferences.example.yaml');
}

/**
 * Load and validate preferences.yaml. A broken file degrades to defaults with a
 * warning rather than killing a cron job.
 */
export function loadPrefs(warn: (msg: string) => void = () => {}): Preferences {
  const parsed = PreferencesSchema.safeParse(readYaml(prefsSource()));
  if (parsed.success) return parsed.data;
  warn(`${prefsSource()} is invalid — ${formatZodError(parsed.error)}; using defaults`);
  return PreferencesSchema.parse({});
}

/** Write preferences back in a fixed key order, with a header comment. */
export function savePrefs(prefs: Preferences): void {
  const validated = PreferencesSchema.parse(prefs);
  const body = stringifyYaml(
    {
      home_city: validated.home_city,
      watch_cities: validated.watch_cities,
      favourite_categories: validated.favourite_categories,
      disliked_categories: validated.disliked_categories,
      follow: validated.follow,
      max_ticket_price: validated.max_ticket_price,
      currency: validated.currency,
      trip: validated.trip,
      interests: validated.interests,
      notes: validated.notes,
    },
    { lineWidth: 0 },
  );
  writeFileSync(
    PREFS_FILE,
    '# events-finder preferences — edit by hand or with: npx tsx scripts/prefs.ts "add stand-up to favourites"\n' + body,
  );
}

export function prefsFile(): string {
  return PREFS_FILE;
}
