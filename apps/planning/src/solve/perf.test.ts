import { describe, expect, test } from 'bun:test'
import { repair, prepare } from './decode.ts'
import { generate } from './generate.ts'
import { createSolverPool, SOLVER_CPU_CAP_CORES } from './pool.ts'
import { laneKCheck, laneKVerify } from './fixtures/lane-k.ts'
import { fromBenchInstance, type BenchInstance } from './fixtures/bench-instance.ts'
import { trainAInputs } from './fixtures/train-a-case.ts'
import twinJson from './fixtures/twin-v3.json'

// Floors (design §9 row 8), OPT-IN: PLANNING_PERF=1 nice -n 10 bun test apps/planning/src/solve/perf.test.ts
// Records CPU-ms and memory on the flagship and on twin v3 (frozen 955824a9…). macOS here; the Linux run
// under systemd-run -p MemoryMax=256M -p CPUQuota=50% belongs to ops before Release A. The process RSS
// below includes the test runner itself.
const enabled = process.env.PLANNING_PERF === '1'
const sampleRss = () => {
  let peak = process.memoryUsage.rss()
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage.rss()) }, 50)
  return () => { clearInterval(timer); return Math.round(peak / 1e6) }
}
const p95 = (values: number[]) => values.toSorted((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!

describe.skipIf(!enabled)('solver floors (opt-in)', () => {
  test('flagship: Generate within 20 s, solver CPU within the cap, memory recorded', async () => {
    const pool = createSolverPool()
    const stop = sampleRss()
    const at = performance.now()
    const result = await generate({ engine: pool, check: laneKCheck, verify: laneKVerify }, { inputs: trainAInputs({ read: true }), revision: 1, previous: null, input: {}, by: { kind: 'agent' }, signal: new AbortController().signal })
    const wallMs = performance.now() - at
    const peakRssMb = stop()
    const runs = result.optionSet.options.map(option => ({ key: option.key, word: option.status.word, ...('run' in option.status ? { cpuMs: option.status.run.cpuMs, stoppedBy: option.status.run.stoppedBy } : {}) }))
    const cpuMs = runs.reduce((sum, run) => sum + (run.cpuMs ?? 0), 0)
    console.log(JSON.stringify({ flagship: { wallMs: Math.round(wallMs), cpuMs, peakRssMb, runs, records: pool.records() } }))
    expect(wallMs).toBeLessThanOrEqual(20_000)
    expect(cpuMs).toBeLessThanOrEqual(9_000)
    expect(cpuMs).toBeLessThanOrEqual(SOLVER_CPU_CAP_CORES * 18_000 + 200)
    expect(peakRssMb).toBeLessThanOrEqual(200)
  }, 60_000)

  test('twin v3: two concurrent solves within the cap and under 200 MB; preview p95 within 300 ms', async () => {
    const { problem } = fromBenchInstance(twinJson as unknown as BenchInstance)
    const pool = createSolverPool()
    const stop = sampleRss()
    const wallMs = 18_000
    const budget = { evals: Number.MAX_SAFE_INTEGER, cpuMs: wallMs * SOLVER_CPU_CAP_CORES, wallMs, memoryMb: 80 }
    const signal = new AbortController().signal
    const [a, b] = await Promise.all([pool.solve(problem, { budget, seed: 1, signal }), pool.solve(problem, { budget, seed: 2, signal })])
    const peakRssMb = stop()
    const prep = prepare(problem)
    const times: number[] = []
    for (let i = 0; i < 20; i++) { const at = performance.now(); repair(prep, a.candidates[0]!); times.push(performance.now() - at) }
    console.log(JSON.stringify({ twinV3: { solves: pool.records(), peakRssMb, previewP95Ms: +p95(times).toFixed(1), stoppedBy: [a.stoppedBy, b.stoppedBy] } }))
    expect(peakRssMb).toBeLessThanOrEqual(200)
    expect(a.cpuMs + b.cpuMs).toBeLessThanOrEqual(SOLVER_CPU_CAP_CORES * wallMs + 300)
    expect(p95(times)).toBeLessThanOrEqual(300)
  }, 60_000)
})
