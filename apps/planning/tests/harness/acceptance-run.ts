// Acceptance run of lane K's harnesses against the integrated real solver (lane S through the operations'
// solver port, lane K's checker), not doubles. Opt-in and slow (minutes):
//   nice -n 10 bun apps/planning/tests/harness/acceptance-run.ts [seconds-per-generate]
// Rows: 1 counterfactual on every job of the flagship baseline and two edit-replans; 3 goals property over
// random goal policies; 2 bounds soundness with the solver's real certificates; daylight saving solved
// across the October change, checked against hand-written instants. Prints each row's result.
import { planInputsSchema, type PlanInputs } from '../../src/plan/schema.ts'
import type { z } from 'zod'
import type { datedRowSchema } from '../../src/plan/schema.ts'
import { checkPlan } from '../../src/check/check.ts'
import { verifyOptimality } from '../../src/check/optimal.ts'
import { createRealSolver } from '../../src/api/wiring.ts'
import { createSolverPool } from '../../src/solve/pool.ts'
import { compile } from '../../src/solve/compile.ts'
import { bounds } from '../../src/solve/bounds.ts'
import caseJson from '../../src/plan/fixtures/train-a.case.json'
import supplyRunJson from '../../src/plan/fixtures/supply-run.case2.json'
import { counterfactualCheck, type CounterfactualFailure } from './counterfactual.ts'
import { goalsProperty } from './goals-property.ts'
import { boundsSoundness } from './bounds-soundness.ts'
import type { GeneratePort, HarnessOption } from './ports.ts'
import { twinPlan, twinV3Options } from './twin-plan.ts'

type DatedRow = z.infer<typeof datedRowSchema>
const seconds = Number(process.argv[2] ?? 10)
/** Rows to run, e.g. "counterfactual,dst"; all by default. */
const rows = new Set((process.argv[3] ?? 'counterfactual,goals,bounds,dst,preview,optimal').split(','))
/** or's frozen size subsets (R/or/inc1/size/) and its MILP schedule for S60 (R/or/gate/runs/), read-only. */
const sizeDirectory = process.env.LANE_K_SIZE_DIR ?? '/Users/hilde/Documents/ChatGPT/leitbild-planning-review-2026-11-10/or/inc1/size'
const s60ScheduleFile = process.env.LANE_K_S60_SCHEDULE ?? '/Users/hilde/Documents/ChatGPT/leitbild-planning-review-2026-11-10/or/gate/runs/best-milp-S60-540.json'
const pool = createSolverPool()
const solver = createRealSolver(pool)
const by = { kind: 'agent' as const, name: 'lane K acceptance run' }
const generateOptions = async (inputs: PlanInputs, revision = 1, budget = seconds) => solver.generate({
  inputs, inputsRevision: revision, variants: undefined, seconds: budget, stored: null, at: new Date().toISOString(), by, signal: new AbortController().signal,
})

// The flagship as frozen, with the two preconditions read as the case expects them at full power
// (case v0.2 world.usedFacts: SW B and CCW B running). A test input standing in for a World read.
const base = planInputsSchema.parse(caseJson)
const locatorOf = (key: string): string => base.equipment.find(item => item.key === key)!.locator!
const flagship = planInputsSchema.parse({
  ...base,
  world: { refreshedAt: '2026-11-12T09:00:00Z', facts: base.jobs.flatMap(job => job.checks).map(check => ({ locator: locatorOf(check.equipment), id: check.fact, label: 'Running', quantity: 'state', value: check.expect, basis: 'observed', at: '2026-11-12T09:00:00Z' })) },
})
const edited = (change: (job: PlanInputs['jobs'][number]) => PlanInputs['jobs'][number]): PlanInputs => planInputsSchema.parse({ ...flagship, jobs: flagship.jobs.map(change) })
// (a) X2 as an estimate change: the CCW A seal 10 h -> 16 h. (b) X1 as a release edit: the spare Wed 08:00 local.
const replanA = edited(job => job.key === 'CCWA-SEAL' ? { ...job, duration: { ...job.duration, value: 16 } } : job)
// The Supply run (case2 v1.1) with the same recorded-facts TEST INPUTS as lane S's portability test: on-scene
// 180 s for every truck, arrival seconds chosen for the test, payloads as configured in the Scenario.
const arrivals: Record<string, number> = {
  'unit:truck-4/arrival-seconds/task:sports-hall-tank': 120, 'unit:truck-1/arrival-seconds/task:sports-hall-tank': 300,
  'unit:truck-3/arrival-seconds/task:field-kitchen': 240, 'unit:truck-4/arrival-seconds/task:field-kitchen': 200, 'unit:truck-1/arrival-seconds/task:field-kitchen': 360,
}
const payloads: Record<string, number> = { 'unit:truck-1/property/payloadKg': 300, 'unit:truck-3/property/payloadKg': 800, 'unit:truck-4/property/payloadKg': 1_500 }
const supplyBase = planInputsSchema.parse(supplyRunJson)
const supplyRefs = [...new Set(JSON.stringify(supplyBase).match(/"locator":"[^"]+","fact":"[^"]+"/g) ?? [])].map(text => JSON.parse(`{${text}}`) as { locator: string; fact: string })
const supplyRun = planInputsSchema.parse({
  ...supplyBase,
  world: {
    refreshedAt: '2026-09-03T08:00:00Z',
    facts: supplyRefs.map(ref => {
      const value = ref.fact.endsWith('/service-seconds') ? 180 : arrivals[ref.fact] ?? payloads[ref.fact]
      if (value === undefined) throw new Error(`no test value for ${ref.fact}`)
      const mass = ref.fact.includes('payload')
      return { locator: ref.locator, id: ref.fact, label: ref.fact, quantity: mass ? 'mass' : 'duration', unit: mass ? 'kg' : 's', value, basis: mass ? 'configured' : 'owner-estimate', at: '2026-09-03T08:00:00Z' }
    }),
  },
})
const replanB = edited(job => job.key === 'SWA-SPARE-PREP' ? { ...job, notBefore: { at: '2026-11-18T07:00:00Z', words: 'The vendor now promises the spare for Wed 08:00', source: { by: 'assumption' as const, note: 'vendor promise' } } } : job)

const counterfactualRow = async (name: string, inputs: PlanInputs): Promise<{ checked: number; steps: number; joint: number; failures: CounterfactualFailure[]; status: string }> => {
  const set = await generateOptions(inputs)
  const option = set.options.find(candidate => candidate.key === set.recommended) ?? set.options[0]!
  if (option.status.word !== 'validated feasible') return { checked: 0, steps: 0, joint: 0, failures: [], status: option.status.word }
  const check = checkPlan(inputs, option.variant, option.rows)
  if (!check.feasible) throw new Error(`${name}: the recommended option fails the checker: ${check.violations[0]!.words}`)
  const failures: CounterfactualFailure[] = []
  let joint = 0
  for (const row of option.rows) {
    const answer = await solver.explain({ inputs, option, ask: 'why-start', job: row.job, cursor: undefined })
    const items = answer.items.filter(item => item.job === row.job)
    joint += items.filter(item => item.joint && item.because.length > 1).length
    failures.push(...counterfactualCheck(inputs, option.variant, option.rows, items))
  }
  // the finish chain: every step is checked the same way, names included
  const chain = await solver.explain({ inputs, option, ask: 'finish', job: undefined, cursor: undefined })
  const chainFailures = counterfactualCheck(inputs, option.variant, option.rows, chain.items)
  failures.push(...chainFailures.map(failure => ({ ...failure, detail: `finish chain: ${failure.detail}` })))
  return { checked: option.rows.length, steps: chain.items.length, joint, failures, status: `${option.status.word}, ${option.label}` }
}

const print = (row: string, text: string): void => console.log(`[${row}] ${text}`)
try {
  // Row 1: counterfactual check
  if (rows.has('counterfactual')) for (const [name, inputs] of [['baseline', flagship], ['replan (a) seal 16 h', replanA], ['replan (b) spare Wed 08:00', replanB], ['Supply run baseline', supplyRun]] as const) {
    const result = await counterfactualRow(name, inputs)
    print('counterfactual', `${name}: ${result.status}; ${result.checked} jobs and ${result.steps} finish-chain steps checked (${result.joint} joint sets checked for minimality; every name checked), ${result.failures.length} failures`)
    for (const failure of result.failures) print('counterfactual', `  ${failure.job}: ${failure.reason} (${failure.causes.map(cause => `${cause.kind} ${cause.about.map(entry => entry.key).join('/')}`).join(' + ')}): ${failure.detail}`)
  }

  // Row 3: goals property, real solver, random goal policies on the flagship
  if (rows.has('goals')) {
  const words = new Map<string, number>()
  const port: GeneratePort = {
    generate: async inputs => {
      const options = (await generateOptions(inputs, 1, Math.max(2, Math.round(seconds / 2)))).options as readonly HarnessOption[]
      for (const option of options) words.set(option.status.word, (words.get(option.status.word) ?? 0) + 1)
      return options
    },
  }
  const trials = 6
  const goalFailures = await goalsProperty(flagship, port, trials, 20261111)
  print('goals property', `${trials} random goal policies on the flagship, options ${JSON.stringify(Object.fromEntries(words))}: ${goalFailures.length} failures`)
  for (const failure of goalFailures) print('goals property', `  trial ${failure.trial} ${failure.option}: ${failure.problem}`)
  }

  // Row 2: bounds soundness with the solver's own certificates and bounds
  if (rows.has('bounds')) {
  let certificates = 0
  const soundness = await boundsSoundness({
    bounds: async (inputs, variant) => {
      const compiled = compile(inputs, { methods: variant.methods, buy: variant.purchases })
      if (!compiled.ok) throw new Error(`compile refused a small instance: ${JSON.stringify(compiled.problems)}`)
      const result = bounds(compiled.problem, compiled.index)
      if (result.certificate !== undefined) certificates++
      return { ...(result.certificate === undefined ? {} : { certificate: result.certificate }), goals: result.goals.flatMap((bound, goal) => typeof bound.value === 'number' ? [{ goal, value: bound.value }] : []) }
    },
  }, Array.from({ length: 120 }, (_, index) => index + 1))
  print('bounds soundness', `120 instances (${soundness.feasible} feasible, ${soundness.infeasible} infeasible), ${certificates} certificates issued: ${soundness.failures.length} failures`)
  for (const failure of soundness.failures) print('bounds soundness', `  seed ${failure.seed}: ${failure.problem}`)
  }

  // Row 6: daylight saving on the solver side. Window Fri 23 Oct 07:00 CEST = 05:00Z to Tue 27 Oct 07:00 CET = 06:00Z.
  // A 12 h day-shift job: Fri 05:00Z-13:00Z (07:00-15:00 CEST), then Mon 26 Oct 06:00Z-10:00Z (07:00-11:00 CET).
  // A 9 h unbroken night job on the Saturday night: 22:00 CEST = Sat 20:00Z to 06:00 CET = Sun 05:00Z.
  if (rows.has('dst')) {
  const planner = { by: 'planner' as const }
  const dst = planInputsSchema.parse({
    settings: { title: 'Daylight saving', timeZone: 'Europe/Oslo', window: { start: '2026-10-23T05:00:00Z', end: '2026-10-27T06:00:00Z' }, dataDate: null, grid: '30min', currency: 'NOK', run: null },
    equipment: [], groups: [],
    calendars: [
      { key: 'day', label: 'Day shift', weekly: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '07:00', to: '15:00' }], periods: [], except: [], source: planner },
      { key: 'night', label: 'Saturday night', weekly: [{ days: ['sat'], from: '22:00', to: '06:00' }], periods: [], except: [], source: planner },
    ],
    resources: [
      { key: 'day-crew', label: 'Day crew', kind: 'crew', count: 1, calendar: 'day', attributes: [], source: planner },
      { key: 'night-crew', label: 'Night crew', kind: 'crew', count: 1, calendar: 'night', attributes: [], source: planner },
    ],
    purchases: [], methods: [], links: [], rules: [],
    jobs: [
      { key: 'D', title: 'Day work', kind: 'work', equipment: [], isolation: 'none', duration: { value: 12, unit: 'h', calendar: 'working', origin: planner }, durationWith: [], needs: [{ anyOf: ['day-crew'], amount: 1, handover: false }], continuous: false, checks: [], tags: [] },
      { key: 'N', title: 'Night work', kind: 'work', equipment: [], isolation: 'none', duration: { value: 9, unit: 'h', calendar: 'working', origin: planner }, durationWith: [], needs: [{ anyOf: ['night-crew'], amount: 1, handover: false }], continuous: true, checks: [], tags: [] },
    ],
    goals: [{ metric: 'finish', tolerance: { value: 0, unit: 'h' } }], world: { refreshedAt: null, facts: [] },
  })
  const dstSet = await generateOptions(dst, 1, 2)
  const dstOption = dstSet.options[0]!
  const expected = { D: ['2026-10-23T05:00:00.000Z', '2026-10-26T10:00:00.000Z'], N: ['2026-10-24T20:00:00.000Z', '2026-10-25T05:00:00.000Z'] } as Record<string, [string, string]>
  const dstCheck = checkPlan(dst, dstOption.variant, dstOption.rows)
  const matches = dstOption.rows.every(row => expected[row.job]?.[0] === new Date(row.start).toISOString() && expected[row.job]?.[1] === new Date(row.finish).toISOString())
  print('daylight saving', `${dstOption.status.word}; checker ${dstCheck.violations.length} violations; rows equal the hand-written instants: ${matches}`)
  if (!matches) for (const row of dstOption.rows) print('daylight saving', `  ${row.job}: ${row.start} to ${row.finish}`)
  }
  // "Proven optimal" re-derived by the checker on every option of the four plans.
  if (rows.has('optimal')) {
    for (const [name, inputs] of [['baseline', flagship], ['replan (a)', replanA], ['replan (b)', replanB], ['Supply run', supplyRun]] as const) {
      const set = await generateOptions(inputs)
      const claims = set.options.flatMap(option => verifyOptimality(inputs, option.variant, option.status).map(entry => ({ option: option.key, ...entry })))
      const unconfirmed = claims.filter(entry => !entry.proves)
      print('optimal', `${name}: ${claims.length} "proven optimal" goals, ${claims.length - unconfirmed.length} confirmed${unconfirmed.length === 0 ? '' : `; unconfirmed: ${unconfirmed.map(entry => `${entry.option} goal ${entry.goal} ${entry.claimed} (bound ${entry.bound})`).join(', ')}`}`)
    }
  }

  // Preview with no edit: re-timing the option with its own order and modes must give the option back.
  if (rows.has('preview')) {
    const sameRows = (left: readonly DatedRow[], right: readonly DatedRow[]) => {
      const key = (row: DatedRow) => `${row.job} ${Date.parse(row.start)} ${Date.parse(row.finish)} ${row.uses.map(use => `${use.resource}:${Date.parse(use.from)}-${Date.parse(use.to)}:${use.purchase ?? ''}`).sort().join(',')}`
      const before = new Set(left.map(key))
      return right.filter(row => !before.has(key(row))).map(row => {
        const was = left.find(entry => entry.job === row.job)
        const shift = was === undefined ? NaN : (Date.parse(row.start) - Date.parse(was.start)) / 3_600_000
        return `${row.job} ${shift === 0 ? 'same start, other uses or finish' : `${shift > 0 ? '+' : ''}${shift} h`}`
      })
    }
    // the flagship's options, from Generate
    const flagshipSet = await generateOptions(flagship)
    for (const option of flagshipSet.options.filter(candidate => candidate.status.word === 'validated feasible')) {
      const preview = await solver.preview({ inputs: flagship, option })
      const changed = sameRows(option.rows, preview.rows)
      print('preview', `flagship ${option.key}: ${changed.length === 0 && preview.violations.length === 0 ? 'identical' : `differs (${changed.slice(0, 4).join(', ')}; ${preview.violations.length} violations)`}`)
    }
    // S60, above the size Generate solves: or's frozen MILP schedule decoded to rows, checked, then previewed
    // through the solver port directly (no operation, no Generate)
    const s60Text = await Bun.file(`${sizeDirectory}/S60.json`).text()
    const s60Bench = JSON.parse(s60Text)
    const s60Plan = twinPlan(s60Bench, { ...twinV3Options(s60Bench), title: 'Size subset S60' })
    const frozen = JSON.parse(await Bun.file(s60ScheduleFile).text())
    const float = { workingHours: 0, limitedBy: { kind: 'window-end' as const } }
    const decoded: DatedRow[] = s60Plan.rowsOf(frozen.solution).map(row => ({ ...row, uses: [...row.uses], float }))
    const decodedCheck = checkPlan(s60Plan.inputs, s60Plan.variant, decoded)
    const run = { grid: '30min' as const, engine: 'or MILP (frozen)', formulation: solver.formulation('30min'), seed: 0, budget: { evals: 0, cpuMs: 0, wallMs: 0 }, stoppedBy: 'done' as const, evals: 0, cpuMs: 0 }
    const s60Option = { key: 's60', label: 'S60 frozen schedule', variant: { methods: s60Plan.variant.methods.map(entry => ({ ...entry })), purchases: [...s60Plan.variant.purchases] }, status: { word: 'validated feasible' as const, goals: [], run }, rows: decoded, metrics: [], inputsRevision: 1 }
    const s60Preview = await solver.preview({ inputs: s60Plan.inputs, option: s60Option })
    const s60Changed = sameRows(decoded, s60Preview.rows)
    const metric = (id: string) => decodedCheck.metrics.find(entry => entry.id === id)?.value
    print('preview', `S60 (sha256 ${new Bun.CryptoHasher('sha256').update(s60Text).digest('hex').slice(0, 8)}), or's frozen schedule: checker ${decodedCheck.violations.length} violations, finish ${metric('finish')} h and cost ${metric('extra-cost')} (or ${frozen.finishH} h, ${frozen.costNok}); preview ${s60Changed.length === 0 && s60Preview.violations.length === 0 ? 'identical' : `differs (${s60Changed.slice(0, 4).join(', ')}; ${s60Preview.violations.length} violations)`}`)
    // The seal +6 h preview on the baseline: only the CCW chain and what it forces may move, and the
    // checker reports only what the edit breaks. "Forced" = reachable from the seal through links, the
    // bracket of its item and the support order (the precedence the edit can push).
    const set = await generateOptions(flagship)
    const option = set.options.find(candidate => candidate.key === set.recommended) ?? set.options[0]!
    const preview = await solver.preview({ inputs: replanA, option })
    const next = new Map<string, Set<string>>()
    const edge = (from: string, to: string) => { const targets = next.get(from) ?? new Set<string>(); targets.add(to); next.set(from, targets) }
    for (const link of replanA.links) edge(link.from, link.to)
    for (const work of replanA.jobs.filter(job => job.kind === 'work' && job.isolation === 'inside')) {
      for (const test of replanA.jobs.filter(job => job.kind === 'test' && job.equipment.includes(work.equipment[0]!))) edge(work.key, test.key)
    }
    const supportersOf = (item: string): string[] => replanA.equipment.find(entry => entry.key === item)?.supportedBy.flatMap(key => [key, ...supportersOf(key)]) ?? []
    for (const test of replanA.jobs.filter(job => job.kind === 'test')) {
      for (const supported of replanA.jobs.filter(job => job.kind === 'test' && job.equipment.some(item => test.equipment.some(supporter => supportersOf(item).includes(supporter))))) edge(test.key, supported.key)
    }
    const forced = new Set<string>(['CCWA-SEAL'])
    for (const queue = ['CCWA-SEAL']; queue.length > 0;) for (const following of next.get(queue.shift()!) ?? []) if (!forced.has(following)) { forced.add(following); queue.push(following) }
    const movedJobs = preview.rows.filter(row => { const was = option.rows.find(entry => entry.job === row.job)!; return Date.parse(was.start) !== Date.parse(row.start) || Date.parse(was.finish) !== Date.parse(row.finish) }).map(row => row.job)
    const outside = movedJobs.filter(job => !forced.has(job))
    const check = checkPlan(replanA, option.variant, preview.rows)
    print('preview', `seal +6 h on '${option.label}': ${movedJobs.length} jobs move (${movedJobs.join(', ')}); outside the seal's forced set: ${outside.length === 0 ? 'none' : outside.join(', ')}; checker: ${check.violations.length === 0 ? 'no violations' : check.violations.map(violation => `${violation.code} ${violation.about.join('/')}`).join('; ')}`)
  }
} finally {
  await pool.shutdown()
}
