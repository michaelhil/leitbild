// Acceptance run of lane K's harnesses against the integrated real solver (lane S through the operations'
// solver port, lane K's checker), not doubles. Opt-in and slow (minutes):
//   nice -n 10 bun apps/planning/tests/harness/acceptance-run.ts [seconds-per-generate]
// Rows: 1 counterfactual on every job of the flagship baseline and two edit-replans; 3 goals property over
// random goal policies; 2 bounds soundness with the solver's real certificates; daylight saving solved
// across the October change, checked against hand-written instants. Prints each row's result.
import { planInputsSchema, type PlanInputs } from '../../src/plan/schema.ts'
import { checkPlan } from '../../src/check/check.ts'
import { createRealSolver } from '../../src/api/wiring.ts'
import { createSolverPool } from '../../src/solve/pool.ts'
import { compile } from '../../src/solve/compile.ts'
import { bounds } from '../../src/solve/bounds.ts'
import caseJson from '../../src/plan/fixtures/train-a.case.json'
import { counterfactualCheck, type CounterfactualFailure } from './counterfactual.ts'
import { goalsProperty } from './goals-property.ts'
import { boundsSoundness } from './bounds-soundness.ts'
import type { GeneratePort, HarnessOption } from './ports.ts'

const seconds = Number(process.argv[2] ?? 10)
/** Rows to run, e.g. "counterfactual,dst"; all by default. */
const rows = new Set((process.argv[3] ?? 'counterfactual,goals,bounds,dst').split(','))
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
const replanB = edited(job => job.key === 'SWA-SPARE-PREP' ? { ...job, notBefore: { at: '2026-11-18T07:00:00Z', words: 'The vendor now promises the spare for Wed 08:00', source: { by: 'assumption' as const, note: 'vendor promise' } } } : job)

const counterfactualRow = async (name: string, inputs: PlanInputs): Promise<{ checked: number; failures: CounterfactualFailure[]; status: string }> => {
  const set = await generateOptions(inputs)
  const option = set.options.find(candidate => candidate.key === set.recommended) ?? set.options[0]!
  if (option.status.word !== 'validated feasible') return { checked: 0, failures: [], status: option.status.word }
  const check = checkPlan(inputs, option.variant, option.rows)
  if (!check.feasible) throw new Error(`${name}: the recommended option fails the checker: ${check.violations[0]!.words}`)
  const failures: CounterfactualFailure[] = []
  for (const row of option.rows) {
    const answer = await solver.explain({ inputs, option, ask: 'why-start', job: row.job, cursor: undefined })
    failures.push(...counterfactualCheck(inputs, option.variant, option.rows, answer.items.filter(item => item.job === row.job)))
  }
  return { checked: option.rows.length, failures, status: `${option.status.word}, ${option.label}` }
}

const print = (row: string, text: string): void => console.log(`[${row}] ${text}`)
try {
  // Row 1: counterfactual check
  if (rows.has('counterfactual')) for (const [name, inputs] of [['baseline', flagship], ['replan (a) seal 16 h', replanA], ['replan (b) spare Wed 08:00', replanB]] as const) {
    const result = await counterfactualRow(name, inputs)
    print('counterfactual', `${name}: ${result.status}; ${result.checked} jobs checked, ${result.failures.length} failures`)
    for (const failure of result.failures) print('counterfactual', `  ${failure.job}: ${failure.reason} (${failure.causes.map(cause => `${cause.kind} ${cause.about.join('/')}`).join(' + ')}): ${failure.detail}`)
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
} finally {
  await pool.shutdown()
}
