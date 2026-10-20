/** Three-function test harness — no test framework, no watch mode, no config. */
import { strict as assert } from 'node:assert';

type Fn = () => void | Promise<void>;
const cases: { name: string; fn: Fn }[] = [];
let current = '';

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

export async function run(): Promise<void> {
  let passed = 0;
  const failures: { name: string; error: unknown }[] = [];
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
      process.stdout.write(`  ✅ ${c.name}\n`);
    } catch (error) {
      failures.push({ name: c.name, error });
      process.stdout.write(`  ❌ ${c.name}\n`);
    }
  }
  for (const f of failures) {
    process.stdout.write(`\n❌ ${f.name}\n${f.error instanceof Error ? f.error.message : String(f.error)}\n`);
  }
  process.stdout.write(`\n${passed}/${cases.length} passed${failures.length ? `, ${failures.length} failed` : ''}\n`);
  process.exit(failures.length === 0 ? 0 : 1);
}
