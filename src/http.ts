import { loadConfig } from './config.ts';
import { sleep } from './util.ts';
import type { Logger } from './log.ts';

/** Last request time per host, so we stay polite even across several scripts in one process. */
const lastHit = new Map<string, number>();

/**
 * One queue per host. `runPipeline` fires every city × source at once, so a
 * plain "read the clock, then set it" check let five requests sail through the
 * same 1.5s window and hit one site five times at once. Each request now waits
 * for the previous one on that host to claim its slot before claiming its own.
 */
const hostQueue = new Map<string, Promise<void>>();

/** Wait for this host's turn, then reserve the next slot. */
function takeTurn(host: string, delayMs: number): Promise<void> {
  const turn = (hostQueue.get(host) ?? Promise.resolve()).then(async () => {
    const since = Date.now() - (lastHit.get(host) ?? 0);
    if (since < delayMs) await sleep(delayMs - since);
    lastHit.set(host, Date.now());
  });
  // a rejected slot must not poison every later request to the host
  hostQueue.set(host, turn.catch(() => {}));
  return turn;
}

/** Longest we will honour a `Retry-After`; beyond that the digest moves on. */
const MAX_RETRY_AFTER_MS = 60_000;

/** A non-OK HTTP response, with the status kept so retrying can be selective. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly statusText = '',
    /** From the `Retry-After` header, when the server sent one. */
    readonly retryAfterMs?: number,
  ) {
    super(`HTTP ${status}${statusText ? ` ${statusText}` : ''}`);
    this.name = 'HttpError';
  }

  /**
   * Worth another go? A 404 past the last page or a 403 block will say the
   * same thing on the third attempt — only overload (429), a server-side
   * timeout (408) and 5xx are worth the backoff.
   */
  get retryable(): boolean {
    return this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

/** `Retry-After` in milliseconds: delta-seconds or an HTTP date, capped. */
function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

export interface FetchOptions {
  log?: Logger;
  timeoutMs?: number;
  retries?: number;
  delayMs?: number;
  headers?: Record<string, string>;
}

/**
 * GET a URL politely: real browser UA, per-host delay, timeout, bounded retries
 * with backoff. Throws on a non-OK response after the last retry.
 */
export async function politeFetch(url: string, opts: FetchOptions = {}): Promise<string> {
  const cfg = loadConfig();
  const timeoutMs = opts.timeoutMs ?? cfg.http.timeout_ms;
  const retries = opts.retries ?? cfg.http.retries;
  const delayMs = opts.delayMs ?? cfg.http.delay_ms;
  const host = new URL(url).host;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await takeTurn(host, delayMs);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: {
          'user-agent': cfg.http.user_agent,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'uk-UA,uk;q=0.9,en;q=0.8',
          ...opts.headers,
        },
      });
      if (!res.ok) throw new HttpError(res.status, url, res.statusText, retryAfterMs(res));
      return await res.text();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      // a permanent answer is not worth three attempts and two backoffs
      if (err instanceof HttpError && !err.retryable) {
        opts.log?.warn(`GET ${url} failed: ${msg} (not retrying)`);
        throw err;
      }
      opts.log?.warn(`GET ${url} failed (attempt ${attempt + 1}/${retries + 1}): ${msg}`);
      if (attempt < retries) {
        // the server's own number beats our guess when it bothered to send one
        const wait = err instanceof HttpError && err.retryAfterMs ? err.retryAfterMs : delayMs * (attempt + 2);
        await sleep(wait);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** GET + JSON.parse, same politeness. */
export async function politeJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const text = await politeFetch(url, { ...opts, headers: { accept: 'application/json', ...opts.headers } });
  return JSON.parse(text) as T;
}
