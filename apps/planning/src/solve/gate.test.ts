import { describe, expect, test } from 'bun:test'
import { bounds } from './bounds.ts'
import { searchEngine } from './search.ts'
import { fromBenchInstance, type BenchInstance } from './fixtures/bench-instance.ts'

// The solver gate (acceptance row 9), ON DEMAND: PLANNING_GATE=1 nice -n 10 bun test apps/planning/src/solve/gate.test.ts
// It reads or's frozen gate files (PLANNING_GATE_DIR, default the review folder's or/gate), runs this
// engine on twin v3 and its U1, U2 and S240 subsets at 10 thread-CPU-s (or's half-core measure) with
// three seeds, re-checks every plan with or's independent bench checker, and applies or's pass rule
// unchanged: guideline excess, finish (1 h) and cost (NOK 5,000), each within max(tolerance, 5 %) of
// verdict-v3.json's best known plan. Twin v1 is recorded as the stress case: no plan expected, with the
// binding resource named. The twins, subsets and pass rule are or's and maint's; nothing here changes them.
const dir = process.env.PLANNING_GATE_DIR ?? '/Users/hilde/Documents/ChatGPT/leitbild-planning-review-2026-11-10/or/gate'
const enabled = process.env.PLANNING_GATE === '1'
const cpuMs = Number(process.env.PLANNING_GATE_CPU_MS ?? 10_000)
const seeds = [1, 2, 3]
const sha256 = async (path: string) => new Bun.CryptoHasher('sha256').update(await Bun.file(path).arrayBuffer()).digest('hex')
const frozen: Record<string, string> = {
  'twin-v3': '955824a9e7368a4bccad688e5974d8db8a966335e8b081069ab6a91ddb66a047',
  'v3-U1': '217f8dae6ad65d07b14bc04f8dc92d0a92451e1ff25bd5b8d1caf4f9ba8cbe20',
  'v3-U2': 'd32183e42d45ca36ed0f22d27bf4e1742ebd3b0aa46cba4d2e18885f89f0b1e3',
  'v3-S240': 'b2284ece0b09ecd12d61dc48fb8be5f2753ebfcb810294228d53259a74ed23e7',
  'twin-v1-overloaded': '7f8c2732f6fa4b66bdf71b2b05bddc89c39a27b6d81aaf130173a72737031237',
}

describe.skipIf(!enabled)('solver gate on the frozen twins (on demand)', () => {
  test('twin v3 and its subsets: per-seed results under or\'s pass rule', async () => {
    const { checkSchedule } = await import(`${dir}/src/check.ts`)
    const { normalizeMilestones } = await import(`${dir}/src/normalize.ts`)
    const verdict = await Bun.file(`${dir}/runs/verdict-v3.json`).json()
    const best: Record<string, [number, number, number]> = {
      'twin-v3': [verdict.bestKnown.guidelineH, verdict.bestKnown.finishH, verdict.bestKnown.costNok],
      ...Object.fromEntries(verdict.sizeCurve.filter((row: { subset: string }) => row.subset !== 'full v3').map((row: { subset: string; bestKnown: [number, number, number] }) => [{ 'U1 only': 'v3-U1', 'U2 only': 'v3-U2', S240: 'v3-S240' }[row.subset]!, row.bestKnown])),
    }
    const within = (value: number, ref: number, tolerance: number) => value <= ref + Math.max(tolerance, 0.05 * ref) + 1e-9
    const rows: unknown[] = []
    for (const name of ['twin-v3', 'v3-U1', 'v3-U2', 'v3-S240']) {
      const path = `${dir}/runs/${name}.json`
      expect(await sha256(path)).toBe(frozen[name]!)
      const inst: BenchInstance = await Bun.file(path).json()
      const { problem, toBench } = fromBenchInstance(inst)
      for (const seed of seeds) {
        let peak = 0
        const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage.rss()) }, 50)
        const result = await searchEngine().solve(problem, { budget: { evals: Number.MAX_SAFE_INTEGER, cpuMs, wallMs: 10 * cpuMs, memoryMb: 80 }, seed, signal: new AbortController().signal })
        clearInterval(sampler)
        const checked = checkSchedule(inst, normalizeMilestones(inst, toBench(result.candidates[0]!)))
        const [g, f, c] = [checked.metrics.guideline / 2, checked.metrics.finish / 2, checked.metrics.cost]
        const [bg, bf, bc] = best[name]!
        const pass = checked.violations.length === 0 && within(g, bg, 0) && within(f, bf, 1) && within(c, bc, 5_000)
        rows.push({ instance: name, seed, cpuMs: result.cpuMs, evals: result.evals, stoppedBy: result.stoppedBy, violations: checked.violations.length, guidelineH: g, finishH: f, costNok: c, costVsBestPct: +((100 * (c - bc)) / bc).toFixed(2), pass, peakRssMb: Math.round(peak / 1e6) })
        expect(checked.violations).toEqual([])
      }
    }
    console.log(JSON.stringify({ gate: rows }, null, 1))
  }, 600_000)

  test('twin v1 (stress case): no plan, the binding resource named', async () => {
    const path = `${dir}/runs/twin-v1-overloaded.json`
    expect(await sha256(path)).toBe(frozen['twin-v1-overloaded']!)
    const inst: BenchInstance = await Bun.file(path).json()
    const { problem } = fromBenchInstance(inst)
    const result = await searchEngine().solve(problem, { budget: { evals: Number.MAX_SAFE_INTEGER, cpuMs, wallMs: 10 * cpuMs, memoryMb: 80 }, seed: 1, signal: new AbortController().signal })
    const { prepare, finishOf } = await import('./decode.ts')
    const prep = prepare(problem)
    const best = result.candidates[0]!
    const late = problem.activities.filter((activity, a) => { const f = finishOf(prep, a, best.mode[a]!, best.start[a]!); return f < 0 || f > activity.deadline }).length
    const index = { origin: problem.origin, slotMs: problem.slotMs, resources: problem.resources.map(resource => resource.id), resourceCalendars: problem.resources.map(() => []), spans: problem.spans.map(span => ({ id: span.id, group: span.id })), jobs: problem.activities.map(activity => activity.id), dueRules: problem.activities.map(() => undefined), needs: problem.activities.map(() => []) }
    const found = bounds(problem, index as never, prep)
    console.log(JSON.stringify({ v1: { lateJobs: late, cpuMs: result.cpuMs, busiest: found.busiest, certificate: found.certificate?.kind ?? null } }))
    expect(late).toBeGreaterThan(0)
    expect(found.certificate).toBeUndefined()
    expect(found.busiest?.resource).toBe('work-control')
  }, 120_000)
})
