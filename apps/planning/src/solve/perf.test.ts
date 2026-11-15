import { afterAll, describe, expect, test } from 'bun:test'
import { createRealSolver } from '../api/wiring.ts'
import { twinPlan, twinV3Options } from '../../tests/harness/twin-plan.ts'
import { planInputsSchema } from '../plan/schema.ts'
import { jobsPerSolve } from '../plan/summary.ts'
import { CERTIFIED_SIZE, generate } from './generate.ts'
import { CHILD_RSS_LIMIT_MB, createSolverPool, SOLVER_CPU_CAP_CORES } from './pool.ts'
import { methodLabel } from './keys.ts'
import { ladderRungs, rungRequest } from './ladder.ts'
import { laneKCheck, laneKVerify, laneKVerifyBound } from './fixtures/lane-k.ts'
import { SIZE_CURVE_SHA256, sizeCurveSubset } from './fixtures/size-curve.ts'
import { trainAInputs } from './fixtures/train-a-case.ts'

// Floors (design §9 row 8), OPT-IN: PLANNING_PERF=1 nice -n 10 bun test apps/planning/src/solve/perf.test.ts
// At the certified size (33 jobs per solve): Generate within 20 s and 200 MB, preview p95 within 300 ms.
// Records the flagship Generate (wall, solver CPU, peak memory), the preview p95 through the real preview
// (in a solver child: spawn, compile, repair, dates, float, check), and one Generate each of or's frozen
// 33-job subset S33v3 and 60-job subset S60 (above the 40-job limit, lifted for it; read-only from PLANNING_SIZE_DIR, the review
// folder's or/inc1/size, when present, else rebuilt from twin v3; either way the sha256 must be or's). The
// service runs one solver child at a time, and each whole sub-solve runs in it: `servicePeakMb` is this
// process's RSS (the test runner included), sampled every 50 ms, and `childPeaksMb` each child's own peak
// (pool records). Service plus child against the unit's 256 MB is recorded, not asserted beyond the child
// ceiling at the certified size. macOS here; the Linux run under systemd-run -p MemoryMax=256M
// -p CPUQuota=50% belongs to ops before Release A.
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
  const run = (inputs = flagship, input = {}, certifiedSize = CERTIFIED_SIZE, previous: Result['optionSet'] | null = null) => generate({ engine: pool, check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound, subSolver: pool.subSolver, certifiedSize }, { inputs, revision: 1, previous, input, by, signal: new AbortController().signal })

  test('"What overtime buys" on the flagship: each rung one Generate within 20 s, lowest first, each child under its ceiling', async () => {
    let previous: Result['optionSet'] | null = null
    const rungs: unknown[] = []
    for (const rung of ladderRungs(flagship)) {
      const stop = sampleRss()
      const at = performance.now()
      const request = rungRequest(flagship, rung, combo => `${methodLabel(flagship, combo)}: rung ${rung.rung}`)
      const result = await run(flagship, request, CERTIFIED_SIZE, previous)
      const wallMs = performance.now() - at
      const childPeaksMb = pool.records().slice(-(request.variants?.length ?? 2)).map(record => record.peakRssMb ?? 0)
      rungs.push({ rung: rung.rung, wallMs: Math.round(wallMs), servicePeakMb: stop(), childPeaksMb, words: wordsOf(result), stoppedBy: stoppedOf(result), robust: result.optionSet.options.map(option => option.robust === undefined ? null : option.robust.allPessimistic.holds) })
      expect(wallMs).toBeLessThanOrEqual(20_000)
      for (const peak of childPeaksMb) expect(peak).toBeLessThanOrEqual(CHILD_RSS_LIMIT_MB)
      previous = result.optionSet
    }
    console.log(JSON.stringify({ ladder: rungs }))
  }, 120_000)

  test('"Finish AFW A first" on the flagship: one lead what-if Generate within 20 s, each child under its ceiling', async () => {
    const stop = sampleRss()
    const at = performance.now()
    const result = await run(flagship, { variants: [{ label: 'Finish AFW A first', lead: { group: 'AFW-A' } }] })
    const wallMs = performance.now() - at
    const childPeaksMb = pool.records().slice(-2).map(record => record.peakRssMb ?? 0)
    const status = result.optionSet.options[0]!.status
    console.log(JSON.stringify({ leadGroup: { wallMs: Math.round(wallMs), servicePeakMb: stop(), childPeaksMb, words: wordsOf(result), stoppedBy: stoppedOf(result), lead: status.word === 'validated feasible' ? status.lead : null } }))
    expect(wallMs).toBeLessThanOrEqual(20_000)
    for (const peak of childPeaksMb) expect(peak).toBeLessThanOrEqual(CHILD_RSS_LIMIT_MB)
  }, 60_000)

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

  test('40 jobs, the size limit (the flagship plus 7 found-work jobs): Generate within 20 s, no memory stop, each child under its ceiling', async () => {
    const found = (k: number) => ({
      key: `FOUND-${k}`, title: `Found work ${k}`, kind: 'work' as const, equipment: [], isolation: 'none' as const,
      duration: { value: 1, unit: 'h' as const, calendar: 'working' as const, origin: { by: 'planner' as const } }, durationWith: [],
      needs: [{ anyOf: ['elec-station'], amount: 1, handover: false }], continuous: false, checks: [], tags: [],
    })
    const inputs = planInputsSchema.parse({ ...flagship, jobs: [...flagship.jobs, ...Array.from({ length: 7 }, (_, k) => found(k + 1))] })
    expect([jobsPerSolve(inputs), CERTIFIED_SIZE.limitJobs]).toEqual([40, 40])
    const stop = sampleRss()
    const at = performance.now()
    const result = await run(inputs)
    const wallMs = performance.now() - at
    const servicePeakMb = stop()
    const childPeaksMb = pool.records().slice(-2).map(record => record.peakRssMb ?? 0)
    console.log(JSON.stringify({ jobs40: { wallMs: Math.round(wallMs), cpuMs: cpuOf(result), servicePeakMb, childPeaksMb, words: wordsOf(result), stoppedBy: stoppedOf(result) } }))
    expect(wallMs).toBeLessThanOrEqual(20_000)
    expect(result.optionSet.options.map(option => [option.status.word, option.sizeCaution])).toEqual([['validated feasible', true], ['validated feasible', true]])
    expect(stoppedOf(result)).not.toContain('memory')
    for (const peak of childPeaksMb) expect(peak).toBeLessThanOrEqual(CHILD_RSS_LIMIT_MB)
  }, 60_000)

  test('S60, or\'s frozen 60-job subset, the limit lifted: why Planning stops at 40 (child peak recorded, above its ceiling)', async () => {
    const frozen = Bun.file(`${sizeDir}/S60.json`)
    const text = (await frozen.exists()) ? await frozen.text() : JSON.stringify(sizeCurveSubset('S60').bench)
    expect(new Bun.CryptoHasher('sha256').update(text).digest('hex')).toBe(SIZE_CURVE_SHA256.S60)
    const bench = JSON.parse(text)
    const twin = twinPlan(bench, twinV3Options(bench))
    const stop = sampleRss()
    const at = performance.now()
    const result = await run(twin.inputs, { variants: [{ label: 'S60', methods: [...twin.variant.methods], buy: [...twin.variant.purchases] }] }, { ...CERTIFIED_SIZE, limitJobs: 60 })
    const wallMs = performance.now() - at
    const servicePeakMb = stop()
    const childPeaksMb = pool.records().slice(-1).map(record => record.peakRssMb ?? 0)
    console.log(JSON.stringify({ s60: { wallMs: Math.round(wallMs), cpuMs: cpuOf(result), servicePeakMb, childPeaksMb, childCeilingMb: CHILD_RSS_LIMIT_MB, words: wordsOf(result), stoppedBy: stoppedOf(result) } }))
    expect(wallMs).toBeLessThanOrEqual(20_000)
    expect(result.optionSet.options.map(option => [option.status.word, option.sizeCaution])).toEqual([['validated feasible', true]])
    // Recorded, not asserted: measured on macOS (15 Nov) the child's peak at its answer is 144-164 MB, above
    // the 140 MB ceiling (the guard does not tick during the final check), and 1 run in 3 stopped early at
    // the ceiling during the search ('memory', the plan kept and said as stopped early). An open decision.
  }, 60_000)

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
