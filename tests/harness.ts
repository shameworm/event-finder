/** Three-function test harness — no test framework, no watch mode, no config. */
import { strict as assert } from 'node:assert';

type Fn = () => void | Promise<void>;
const cases: { name: string; fn: Fn }[] = [];
let current = '';

/**
 * A case that hangs — an unresolved promise, a fetch nobody stubbed — would
 * otherwise hold the whole suite open with no clue which one it was.
 */
const TIMEOUT_MS = Number(process.env['EVENTS_FINDER_TEST_TIMEOUT'] ?? 15_000);

export function describe(name: string, body: () => void): void {
  const previous = current;
  current = previous ? `${previous} › ${name}` : name;
  body();
  current = previous;
}

export function it(name: string, fn: Fn): void {
  cases.push({ name: current ? `${current} › ${name}` : name, fn });
}

export { assert };

/** Run one case, failing it rather than hanging if it never settles. */
async function runCase(fn: Fn): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
  });
  try {
    await Promise.race([(async () => fn())(), limit]);
  } finally {
    clearTimeout(timer);
  }
}

export async function run(): Promise<void> {
  let passed = 0;
  const failures: { name: string; error: unknown }[] = [];
  for (const c of cases) {
    try {
      await runCase(c.fn);
      passed++;
      process.stdout.write(`  ✅ ${c.name}\n`);
    } catch (error) {
      failures.push({ name: c.name, error });
      process.stdout.write(`  ❌ ${c.name}\n`);
    }
  }
  for (const f of failures) {
    // the stack, not just the message: an assertion deep inside a helper is
    // otherwise impossible to place
    process.stdout.write(`\n❌ ${f.name}\n${f.error instanceof Error ? (f.error.stack ?? f.error.message) : String(f.error)}\n`);
  }
  process.stdout.write(`\n${passed}/${cases.length} passed${failures.length ? `, ${failures.length} failed` : ''}\n`);
  process.exit(failures.length === 0 ? 0 : 1);
}
