import { describe, expect, test } from 'bun:test'
import { CHILD_JSC_OPTIONS } from './pool.ts'

// A solver child runs with CHILD_JSC_OPTIONS (pool.ts), so lane K's checker, called as often as a sub-solve
// with pessimistic re-timings calls it, is never DFG-compiled there, while a small hot function, as in the
// search, still is. The JIT runs on this thread (not concurrently) so the counts are exact. Without the
// options this Bun does DFG-compile the checker: the test would see a change of JSC's option.
const checkPath = new URL('../check/check.ts', import.meta.url).pathname
const choosePath = new URL('../api/fixtures/choose.ts', import.meta.url).pathname
const probe = `
import { numberOfDFGCompiles } from 'bun:jsc'
import { checkPlan } from ${JSON.stringify(checkPath)}
import { trainAInputs, rebuild } from ${JSON.stringify(choosePath)}
const sum = xs => { let total = 0; for (const x of xs) total += x; return total }
const xs = Array.from({ length: 100 }, (_, i) => i)
for (let i = 0; i < 14; i++) checkPlan(trainAInputs, rebuild.variant, rebuild.rows)
for (let i = 0; i < 2000; i++) sum(xs)
console.log(JSON.stringify({ checker: numberOfDFGCompiles(checkPlan), small: numberOfDFGCompiles(sum) }))
`
const compiles = async (env: Readonly<Record<string, string>>): Promise<{ checker: number; small: number }> => {
  const child = Bun.spawn([process.execPath, '--smol', '-e', probe], { env: { ...process.env, BUN_JSC_useConcurrentJIT: '0', ...env }, stdout: 'pipe', stderr: 'inherit' })
  const printed = await new Response(child.stdout).text()
  expect(await child.exited).toBe(0)
  return JSON.parse(printed.trim().split('\n').at(-1)!) as { checker: number; small: number }
}

describe('the solver child JIT', () => {
  test('lane K\'s checker stays out of the DFG in a solver child; a small hot function does not', async () => {
    const plain = await compiles({})
    expect(plain.checker).toBeGreaterThan(0)
    const child = await compiles(CHILD_JSC_OPTIONS)
    expect(child.checker).toBe(0)
    expect(child.small).toBeGreaterThan(0)
  }, 60_000)
})
