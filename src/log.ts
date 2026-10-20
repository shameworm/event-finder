import { appendFileSync } from 'node:fs';
import { LOG_FILE, ensureDirs } from './paths.ts';

type Level = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

/** Local wall-clock time, so a tailed log lines up with your own clock. */
const stamp = () => new Date().toLocaleString('sv-SE').slice(0, 19);

/**
 * Logs go to the Hermes log file and to stderr, so stdout stays clean for
 * digests and JSON. EVENTS_FINDER_QUIET=1 silences the progress lines on
 * stderr but never the errors.
 */
export function makeLogger(scope: string) {
  const write = (level: Level, msg: string) => {
    if (level === 'DEBUG' && !process.env['EVENTS_FINDER_DEBUG']) return;
    const line = `${stamp()} ${level.padEnd(5)} [events-finder.${scope}] ${msg}`;
    try {
      ensureDirs();
      appendFileSync(LOG_FILE, line + '\n');
    } catch {
      /* logging must never break a run */
    }
    // QUIET silences progress noise, never errors: a cron job that fails
    // must still say so on stderr
    if (level === 'ERROR' || !process.env['EVENTS_FINDER_QUIET']) process.stderr.write(line + '\n');
  };
  return {
    info: (m: string) => write('INFO', m),
    warn: (m: string) => write('WARN', m),
    error: (m: string) => write('ERROR', m),
    debug: (m: string) => write('DEBUG', m),
    child: (sub: string) => makeLogger(`${scope}.${sub}`),
  };
}

export type Logger = ReturnType<typeof makeLogger>;
