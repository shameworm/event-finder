/** Tiny flag parser: --flag, --key value, --key=value, positional rest. */
export interface Args {
  flags: Set<string>;
  opts: Record<string, string>;
  rest: string[];
  has(name: string): boolean;
  get(name: string, fallback?: string): string | undefined;
  num(name: string, fallback?: number): number | undefined;
  list(name: string): string[];
  /** Everything not consumed by a flag, joined — the free-text request. */
  text(): string;
}

/**
 * Flags that take a value. A flag missing from this list is parsed as a bare
 * switch and its value is swept into the free-text request instead — which is
 * how `--timeout 60` and `--ttl 3` used to be ignored in silence.
 *
 * Keep it in step with `args.get/num/list` across scripts/.
 */
const KNOWN_VALUE_FLAGS = new Set([
  'city', 'cities', 'from', 'to', 'like', 'dislike', 'max-price', 'top', 'pages', 'days',
  'chat', 'hour', 'day', 'source', 'limit', 'ingest', 'out', 'format', 'base', 'per-day', 'label', 'title', 'channel',
  'only', 'skip', 'timeout', 'ttl', 'cancel',
]);

export function parseArgs(argv = process.argv.slice(2)): Args {
  const flags = new Set<string>();
  const opts: Record<string, string> = {};
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith('--')) {
      rest.push(a);
      continue;
    }
    const body = a.slice(2);
    const eq = body.indexOf('=');
    if (eq > 0) {
      opts[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (KNOWN_VALUE_FLAGS.has(body) && next !== undefined && !next.startsWith('--')) {
      opts[body] = next;
      i++;
    } else {
      flags.add(body);
    }
  }

  return {
    flags,
    opts,
    rest,
    has: (n) => flags.has(n) || n in opts,
    get: (n, fallback) => opts[n] ?? fallback,
    num: (n, fallback) => (opts[n] !== undefined && opts[n] !== '' ? Number(opts[n]) : fallback),
    list: (n) =>
      (opts[n] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    text: () => rest.join(' ').trim(),
  };
}
