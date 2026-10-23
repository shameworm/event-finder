#!/usr/bin/env -S npx tsx
/**
 * One-time GramJS login, so the Telegram source can read public channels.
 *
 *   npx tsx scripts/tg-login.ts
 *
 * You need TELEGRAM_API_ID and TELEGRAM_API_HASH first — create them at
 * https://my.telegram.org → API development tools.
 *
 * It asks for your phone number, the code Telegram sends you (in the app, not
 * by SMS), and your 2FA password if you have one. It then writes the session
 * string to ~/.hermes/data/events-finder/gramjs.session and prints the line to
 * add to ~/.hermes/.env. The session is as sensitive as your password — it is
 * a logged-in session for your account.
 *
 * This is an interactive script: run it in a terminal yourself, not from cron.
 */
import { createInterface } from 'node:readline/promises';
import { writeFileSync, chmodSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import { TG_SESSION_FILE, ensureDirs, loadEnv } from '../src/paths.ts';
import { makeLogger } from '../src/log.ts';

loadEnv();
const log = makeLogger('tg-login');

const apiId = Number(process.env['TELEGRAM_API_ID'] ?? 0);
const apiHash = process.env['TELEGRAM_API_HASH'] ?? '';
if (!apiId || !apiHash) {
  process.stderr.write(
    'TELEGRAM_API_ID / TELEGRAM_API_HASH are missing.\n' +
      'Get them at https://my.telegram.org → API development tools, then put them in ~/.hermes/.env:\n' +
      '  TELEGRAM_API_ID=1234567\n  TELEGRAM_API_HASH=0123456789abcdef0123456789abcdef\n',
  );
  process.exit(1);
}

const { TelegramClient } = await import('telegram');
const { StringSession } = await import('telegram/sessions/index.js');
const { LogLevel } = await import('telegram/extensions/Logger.js');

const rl = createInterface({ input: stdin, output: stdout });
const ask = (q: string) => rl.question(q);

const session = new StringSession('');
const client = new TelegramClient(session, apiId, apiHash, {
  connectionRetries: 3,
  deviceModel: 'Hermes events-finder',
  appVersion: '1.0.0',
});
client.setLogLevel(LogLevel.ERROR);

try {
  await client.start({
    phoneNumber: () => ask('phone number (+380...): '),
    phoneCode: () => ask('code Telegram just sent you: '),
    password: () => ask('2FA password (blank if none): '),
    onError: (err) => {
      process.stderr.write(`login error: ${err.message}\n`);
    },
  });

  const saved = client.session.save() as unknown as string;
  ensureDirs();
  writeFileSync(TG_SESSION_FILE, saved);
  chmodSync(TG_SESSION_FILE, 0o600);

  const me = await client.getMe();
  const who = 'username' in me && me.username ? `@${me.username}` : String(me.id);
  log.info(`logged in as ${who}; session saved to ${TG_SESSION_FILE}`);
  process.stdout.write(
    `\n✅ logged in as ${who}\n\nSession written to ${TG_SESSION_FILE} (chmod 600).\n` +
      `Optionally add it to ~/.hermes/.env instead:\n\nTELEGRAM_SESSION=${saved}\n\n` +
      `Next: list the channels you want per city in config.yaml (cities.<city>.telegram_channels),\n` +
      `then test with:  npx tsx scripts/telegram.ts --city kharkiv\n`,
  );
} finally {
  rl.close();
  await client.disconnect();
  await client.destroy().catch(() => {});
}

process.exit(process.exitCode ?? 0);
