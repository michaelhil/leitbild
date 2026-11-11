import { afterAll, describe, expect, test } from 'bun:test'
import { createRealSolver } from '../api/wiring.ts'
import { twinPlan, twinV3Options } from '../../tests/harness/twin-plan.ts'
import { generate } from './generate.ts'
import { CHILD_RSS_LIMIT_MB, createSolverPool, SOLVER_CPU_CAP_CORES } from './pool.ts'
import { laneKCheck, laneKVerify, laneKVerifyBound } from './fixtures/lane-k.ts'
import { SIZE_CURVE_SHA256, sizeCurveSubset } from './fixtures/size-curve.ts'
import { trainAInputs } from './fixtures/train-a-case.ts'

// Floors (design §9 row 8), OPT-IN: PLANNING_PERF=1 nice -n 10 bun test apps/planning/src/solve/perf.test.ts
// At the certified size (33 jobs per solve): Generate within 20 s and 200 MB, preview p95 within 300 ms.
// Records the flagship Generate (wall, solver CPU, peak memory), the preview p95 through the real preview
// (compile, repair, dates, float, check), two concurrent flagship Generates on one pool, and one solve of
// or's frozen 33-job subset S33v3 (read-only from PLANNING_SIZE_DIR, the review folder's or/inc1/size, when
// present, else rebuilt from twin v3; either way its sha256 must be or's). Each solve runs in its own solver
// child process: `servicePeakMb` is this process's RSS (the test runner included), sampled every 50 ms, and
// `childPeaksMb` each child's own peak (pool records); each child stays under CHILD_RSS_LIMIT_MB. Service plus
// children against the unit's 256 MB is recorded, not asserted: an open decision (see pool.ts). macOS here;
// the Linux run under systemd-run -p MemoryMax=256M -p CPUQuota=50% belongs to ops before Release A.
const enabled = process.env.PLANNING_PERF === '1'
const sizeDir = process.env.PLANNING_SIZE_DIR ?? '/Users/hilde/Documents/ChatGPT/leitbild-planning-review-2026-11-10/or/inc1/size'
const sampleRss = () => {
  let peak = process.memoryUsage.rss()
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage.rss()) }, 50)
  return () => { clearInterval(timer); return Math.round(peak / 1e6) }
}
const p95 = (values: number[]) => values.toSorted((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!
const by = { kind: 'agent' as const }
type Result = Awaited<ReturnType<typeof generate>>
const cpuOf = (result: Result) => result.optionSet.options.reduce((sum, option) => sum + ('run' in option.status ? option.status.run.cpuMs : 0), 0)
const wordsOf = (result: Result) => result.optionSet.options.map(option => option.status.word)
const stoppedOf = (result: Result) => result.optionSet.options.map(option => ('run' in option.status ? option.status.run.stoppedBy : null))

describe.skipIf(!enabled)('solver floors at the certified size (opt-in)', () => {
  const pool = createSolverPool()
  const solver = createRealSolver(pool)
  afterAll(() => pool.shutdown())
  const flagship = trainAInputs({ read: true })
  const run = (inputs = flagship, input = {}) => generate({ engine: pool, check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound }, { inputs, revision: 1, previous: null, input, by, signal: new AbortController().signal })

  test('flagship: Generate within 20 s and 200 MB, solver CPU within the cap; preview p95 within 300 ms', async () => {
    const stop = sampleRss()
    const at = performance.now()
    const result = await run()
    const wallMs = performance.now() - at
    const servicePeakMb = stop()
    const childPeaksMb = pool.records().slice(-4).map(record => record.peakRssMb ?? 0)
    const cpuMs = cpuOf(result)
    const option = result.optionSet.options.find(candidate => candidate.key === result.optionSet.recommended)!
    const times: number[] = []
    for (let i = 0; i < 20; i++) { const start = performance.now(); await solver.preview({ inputs: flagship, option }); times.push(performance.now() - start) }
    console.log(JSON.stringify({ flagship: { wallMs: Math.round(wallMs), cpuMs, servicePeakMb, childPeaksMb, words: wordsOf(result), stoppedBy: stoppedOf(result), previewP95Ms: +p95(times).toFixed(1) } }))
    expect(wallMs).toBeLessThanOrEqual(20_000)
    expect(cpuMs).toBeLessThanOrEqual(SOLVER_CPU_CAP_CORES * 20_000 + 300)
    for (const peak of childPeaksMb) expect(peak).toBeLessThanOrEqual(CHILD_RSS_LIMIT_MB)
    expect(p95(times)).toBeLessThanOrEqual(300)
  }, 60_000)

  test('two concurrent flagship Generates on one pool: each within 20 s, together within the cap and 200 MB', async () => {
    const stop = sampleRss()
    const at = performance.now()
    const [a, b] = await Promise.all([run(), run()])
    const wallMs = performance.now() - at
    const servicePeakMb = stop()
    const childPeaksMb = pool.records().slice(-4).map(record => record.peakRssMb ?? 0)
    console.log(JSON.stringify({ twoFlagships: { wallMs: Math.round(wallMs), cpuMs: [cpuOf(a), cpuOf(b)], servicePeakMb, childPeaksMb, words: [wordsOf(a), wordsOf(b)], stoppedBy: [stoppedOf(a), stoppedOf(b)] } }))
    expect(wallMs).toBeLessThanOrEqual(20_000)
    expect(cpuOf(a) + cpuOf(b)).toBeLessThanOrEqual(SOLVER_CPU_CAP_CORES * 20_000 + 600)
    for (const peak of childPeaksMb) expect(peak).toBeLessThanOrEqual(CHILD_RSS_LIMIT_MB)
  }, 90_000)

  test('S33v3, or\'s frozen 33-job subset: one Generate within 20 s and 200 MB', async () => {
    const frozen = Bun.file(`${sizeDir}/S33v3.json`)
    const text = (await frozen.exists()) ? await frozen.text() : JSON.stringify(sizeCurveSubset('S33v3').bench)
    expect(new Bun.CryptoHasher('sha256').update(text).digest('hex')).toBe(SIZE_CURVE_SHA256.S33v3)
    const bench = JSON.parse(text)
    const twin = twinPlan(bench, twinV3Options(bench))
    const stop = sampleRss()
    const at = performance.now()
    const result = await run(twin.inputs, { variants: [{ label: 'S33v3', methods: [...twin.variant.methods], buy: [...twin.variant.purchases] }] })
    const wallMs = performance.now() - at
    const servicePeakMb = stop()
    const childPeaksMb = pool.records().slice(-4).map(record => record.peakRssMb ?? 0)
    console.log(JSON.stringify({ s33v3: { source: (await frozen.exists()) ? 'frozen file' : 'rebuilt', wallMs: Math.round(wallMs), cpuMs: cpuOf(result), servicePeakMb, childPeaksMb, words: wordsOf(result), stoppedBy: stoppedOf(result) } }))
    expect(wallMs).toBeLessThanOrEqual(20_000)
    for (const peak of childPeaksMb) expect(peak).toBeLessThanOrEqual(CHILD_RSS_LIMIT_MB)
  }, 60_000)
})
