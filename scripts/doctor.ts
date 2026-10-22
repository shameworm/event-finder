#!/usr/bin/env -S npx tsx
/**
 * Health check: run this first, and whenever something stops working.
 *
 *   npx tsx scripts/doctor.ts            # config, env, database, preferences
 *   npx tsx scripts/doctor.ts --network  # also probe every source site
 *
 * Exit code is 1 if anything required is broken, 0 otherwise (warnings are fine).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configSource, loadConfig, loadPrefs, prefsSource } from '../src/config.ts';
import { DATA_DIR, DB_FILE, LOG_FILE, SKILL_DIR, TG_SESSION_FILE, WEBSEARCH_INBOX, loadEnv } from '../src/paths.ts';
import { makeLogger } from '../src/log.ts';
import { parseArgs } from '../src/cli.ts';
import { withStore } from '../src/db.ts';
import { botToken, defaultChatId, getMe, getMyCommands } from '../src/telegram-api.ts';
import { politeFetch } from '../src/http.ts';
import { credentials } from './telegram.ts';
import { BOT_COMMANDS } from '../src/bot-handlers.ts';
import { describePrefs } from '../src/prefs-engine.ts';
import { cityLabel } from '../src/config.ts';
import { today } from '../src/util.ts';

const args = parseArgs();
const log = makeLogger('doctor');
loadEnv();

let failures = 0;
let warnings = 0;
const ok = (msg: string) => process.stdout.write(`  ✅ ${msg}\n`);
const warn = (msg: string) => {
  warnings++;
  process.stdout.write(`  ⚠️  ${msg}\n`);
};
const bad = (msg: string) => {
  failures++;
  process.stdout.write(`  ❌ ${msg}\n`);
};
const section = (name: string) => process.stdout.write(`\n${name}\n`);

/* --- runtime ----------------------------------------------------------- */
section('runtime');
const major = Number(process.versions.node.split('.')[0]);
if (major >= 20) ok(`node ${process.version}`);
else bad(`node ${process.version} — this skill needs Node 20 or newer`);
if (existsSync(join(SKILL_DIR, 'node_modules'))) ok('dependencies installed');
else bad('node_modules missing — run: npm install');

/* --- config ------------------------------------------------------------ */
section('config');
let cities: string[] = [];
try {
  const cfg = loadConfig();
  cities = Object.keys(cfg.cities);
  const which = configSource();
  if (which.endsWith('config.example.yaml')) warn(`using ${which} — copy it: cp config.example.yaml config.yaml`);
  else ok(which);
  ok(`timezone ${cfg.timezone}, default city ${cfg.default_city}, today is ${today(cfg.timezone)}`);
  ok(`${cities.length} cities configured: ${cities.join(', ')}`);
  for (const [key, city] of Object.entries(cfg.cities)) {
    const missing = (['concertua', 'karabas', 'kontramarka'] as const).filter((s) => !city[s]);
    if (missing.length) warn(`${key}: no ${missing.join(', ')} section — those sources will be skipped`);
  }
  const withChannels = Object.entries(cfg.cities).filter(([, c]) => c.telegram_channels.length > 0);
  if (withChannels.length === 0) warn('no telegram_channels configured in any city — the Telegram source will return nothing');
  else ok(`telegram channels: ${withChannels.map(([k, c]) => `${k}:${c.telegram_channels.length}`).join(', ')}`);
} catch (err) {
  bad(`config: ${err instanceof Error ? err.message : String(err)}`);
}

/* --- the operator's own profile ---------------------------------------- */
section("the operator's own profile (preferences.yaml — the CLI's defaults)");
try {
  const prefs = loadPrefs((m) => warn(m));
  const which = prefsSource();
  if (which.endsWith('preferences.example.yaml')) warn(`using ${which} — copy it: cp preferences.example.yaml preferences.yaml`);
  else ok(which);
  if (!cities.includes(prefs.home_city)) bad(`home_city "${prefs.home_city}" is not in config.yaml → cities`);
  for (const c of prefs.watch_cities) if (!cities.includes(c)) warn(`watch city "${c}" is not in config.yaml → cities`);
  process.stdout.write(describePrefs(prefs).split('\n').map((l) => `     ${l}`).join('\n') + '\n');
} catch (err) {
  bad(`preferences: ${err instanceof Error ? err.message : String(err)}`);
}

/* --- storage ----------------------------------------------------------- */
section('storage');
try {
  await withStore(async (store) => {
    ok(`${store.dialect} → ${store.target}`);
    const s = await store.stats();
    ok(
      `rows: users=${s['users']} (active ${s['activeUsers']}), deliveries=${s['deliveries']}, ` +
        `reminders=${s['reminders']}, messages=${s['messages']}, cached scrapes=${s['cached']}`,
    );
    await store.setState('doctor:last_run', new Date().toISOString());

    const users = await store.listUsers();
    if (users.length === 0) {
      warn('no users yet — someone has to send /start to the bot');
    } else {
      const perCity = new Map<string, number>();
      for (const u of users) perCity.set(u.city, (perCity.get(u.city) ?? 0) + 1);
      ok(`users per city: ${[...perCity].map(([c, n]) => `${cityLabel(c)}:${n}`).join(', ')}`);
      const unknown = [...perCity.keys()].filter((c) => !cities.includes(c));
      if (unknown.length) bad(`users in cities missing from config.yaml: ${unknown.join(', ')}`);
      const noFollows = users.filter((u) => {
        try {
          return (JSON.parse(u.prefs).follow ?? []).length === 0;
        } catch {
          return true;
        }
      }).length;
      if (noFollows === users.length) warn('nobody follows anyone yet — follow alerts will stay quiet');
    }
  });
} catch (err) {
  bad(`database: ${err instanceof Error ? err.message : String(err)}`);
}
ok(`data dir ${DATA_DIR}`);
if (existsSync(LOG_FILE)) {
  const lines = readFileSync(LOG_FILE, 'utf8').trimEnd().split('\n');
  ok(`log ${LOG_FILE} (${lines.length} lines) — last: ${lines[lines.length - 1]?.slice(0, 110) ?? ''}`);
} else {
  warn(`no log file yet at ${LOG_FILE}`);
}
if (existsSync(WEBSEARCH_INBOX)) ok(`websearch inbox ${WEBSEARCH_INBOX}`);
else warn('websearch inbox is empty — run scripts/websearch.ts --queries, then --ingest');
if (!process.env['DATABASE_URL']) ok(`sqlite file: ${DB_FILE}`);
else ok('DATABASE_URL is set — using Postgres through drizzle');

/* --- telegram ---------------------------------------------------------- */
section('telegram bot');
if (!botToken()) bad('TELEGRAM_BOT_TOKEN missing — create a bot with @BotFather and put it in ~/.hermes/.env');
else {
  try {
    const me = await getMe();
    ok(`bot @${me.username ?? me.id} reachable`);
  } catch (err) {
    bad(`bot token rejected: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!defaultChatId()) warn('TELEGRAM_CHAT_ID missing — set it to your own chat id for /stats and the CLI');
  else ok(`owner chat id ${defaultChatId()}`);
  try {
    const published = await getMyCommands();
    const missing = BOT_COMMANDS.filter((c) => !published.some((p) => p.command === c.command));
    if (published.length === 0) warn('no command menu published — start the bot once and it will upload BOT_COMMANDS');
    else if (missing.length) warn(`command menu is stale, missing ${missing.map((c) => `/${c.command}`).join(' ')} — restart the bot`);
    else ok(`command menu: ${published.length} command(s), "/" autocompletes`);
  } catch (err) {
    warn(`could not read the command menu: ${err instanceof Error ? err.message : String(err)}`);
  }
}

section('bot policy');
try {
  const cfg = loadConfig();
  ok(cfg.bot.public ? 'open to anyone who starts it' : `allowlist only (${cfg.bot.allowlist.length} chat id(s))`);
  ok(`${cfg.bot.searches_per_hour} searches/user/hour, ${cfg.bot.max_results} results per answer, ${cfg.bot.interactive_pages} page(s) per source`);
  if (cfg.cache.ttl_seconds === 0) warn('cache is disabled (cache.ttl_seconds: 0) — every user triggers their own scrape');
  else ok(`scrape cache ${cfg.cache.ttl_seconds}s — one crawl per city serves everyone in it`);
} catch {
  /* already reported above */
}

section('telegram (gramjs: reading channels)');
const creds = credentials();
if ('missing' in creds) warn(`channel reading disabled — missing ${creds.missing.join(', ')}`);
else ok(`api id ${creds.apiId}, session ${existsSync(TG_SESSION_FILE) ? TG_SESSION_FILE : 'from TELEGRAM_SESSION'}`);

/* --- network ----------------------------------------------------------- */
if (args.has('network')) {
  section('source sites (--network)');
  const cfg = loadConfig();
  const home = loadPrefs().home_city;
  const city = cfg.cities[args.get('city') ?? home] ?? Object.values(cfg.cities)[0];
  const probes: [string, string][] = [];
  if (city?.concertua) probes.push(['concert.ua', `https://concert.ua/en/catalog/${city.concertua.slug}/all-categories`]);
  if (city?.karabas) probes.push(['karabas', `https://${city.karabas.subdomain}.karabas.com/`]);
  if (city?.kontramarka) {
    const sub = city.kontramarka.subdomain;
    probes.push(['kontramarka', `https://${sub ? `${sub}.` : ''}kontramarka.ua/uk/concert`]);
  }
  for (const [name, url] of probes) {
    try {
      const html = await politeFetch(url, { log, retries: 0 });
      ok(`${name}: ${url} (${Math.round(html.length / 1024)} KB)`);
    } catch (err) {
      bad(`${name}: ${url} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/* --- verdict ----------------------------------------------------------- */
process.stdout.write(
  `\n${failures === 0 ? '✅ ready' : `❌ ${failures} problem(s)`}${warnings ? `, ${warnings} warning(s)` : ''}\n`,
);
process.exit(failures === 0 ? 0 : 1);
