import { loadConfig } from './config.ts';
import { sleep } from './util.ts';
import type { Logger } from './log.ts';

/** Last request time per host, so we stay polite even across several scripts in one process. */
const lastHit = new Map<string, number>();

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
    const since = Date.now() - (lastHit.get(host) ?? 0);
    if (since < delayMs) await sleep(delayMs - since);
    lastHit.set(host, Date.now());

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
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      opts.log?.warn(`GET ${url} failed (attempt ${attempt + 1}/${retries + 1}): ${msg}`);
      if (attempt < retries) await sleep(delayMs * (attempt + 2));
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
