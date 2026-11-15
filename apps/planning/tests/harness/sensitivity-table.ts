// The +25 % sensitivity table (lane K batch 2, decision 3) for the Train A flagship, printed as markdown:
//   bun apps/planning/tests/harness/sensitivity-table.ts
// The flagship's recommended option (lane S's search, seed 1, 600 evaluations per sub-solve, so the same
// option on any machine) is re-timed by lane S's repair path (solve/retime.ts: the same order, crews and
// bought time, nothing earlier) in each case, and lane K judges each re-timing (check/retime.ts). Every
// figure in the table is lane K's: the longest outage from the checker on the judged rows, the outcome from
// judgeRetiming. The coordinator copies the output into the wiki at release, naming the commit.
// Cases: every job with its own estimate at +25 %; every three-point job at its high estimate; each alone.
import { judgedInputs, judgeRetiming, rangedJobs, type RetimeJudgement } from '../../src/check/retime.ts'
import { checkPlan, type CheckRow } from '../../src/check/check.ts'
import type { Plan, PlanInputs } from '../../src/plan/schema.ts'
import { compile } from '../../src/solve/compile.ts'
import { dateSchedule, undate } from '../../src/solve/date.ts'
import { finishOf, prepare, repair } from '../../src/solve/decode.ts'
import { laneKCheck, laneKVerify, laneKVerifyBound } from '../../src/solve/fixtures/lane-k.ts'
import { trainAInputs } from '../../src/solve/fixtures/train-a-case.ts'
import { generate } from '../../src/solve/generate.ts'
import { atHigh, retimedRows } from '../../src/solve/retime.ts'
import { searchEngine } from '../../src/solve/search.ts'

type Option = NonNullable<Plan['options']>['options'][number]

/**
 * The rows lane S's repair places when it cannot place a job (solve/retime.ts retimedRows answers only
 * `{unplaced}` then): the same compile, read-back and repair, keeping the placed jobs' rows. The jobs it loses
 * are dated at the first slot where they fit only so dating runs, and are then left out. For lane K's judgement.
 */
export const placedRows = (planned: PlanInputs, pessimistic: PlanInputs, option: Pick<Option, 'variant' | 'rows'>): CheckRow[] => {
  const sub = { methods: option.variant.methods, buy: option.variant.purchases }
  const before = compile(planned, sub), after = compile(pessimistic, sub)
  if (!before.ok || !after.ok) throw new Error('The plan does not compile for this option')
  const saved = undate(prepare(before.problem), before.index, option.rows)
  if (!saved.ok) throw new Error('The option does not read back')
  const prep = prepare(after.problem)
  const { decoded } = repair(prep, saved.schedule)
  const lost = new Set(after.index.jobs.flatMap((job, a) => job !== null && (decoded.finish[a]! < 0 || decoded.finish[a]! >= prep.H) ? [job] : []))
  const fitting = (a: number): number => { for (let t = 0; t < prep.H; t++) if (finishOf(prep, a, decoded.mode[a]!, t) >= 0) return t; throw new Error(`${after.index.jobs[a]} fits nowhere in the horizon`) }
  const start = Int32Array.from(decoded.start, (slot, a) => lost.has(after.index.jobs[a] ?? '') ? fitting(a) : slot)
  return dateSchedule(prep, after.index, { start, mode: decoded.mode }).filter(row => !lost.has(row.job))
}

export interface SensitivityRow {
  readonly label: string
  /** The inputs the case re-times on (the plan's, with the case's high estimates as ranges) and the jobs it lengthens. */
  readonly inputs: PlanInputs
  readonly high: readonly string[]
  /** The re-timed rows; absent, with the reason in `none`, when lane S's repair gave none. */
  readonly retimed?: readonly CheckRow[]
  readonly none?: string| { readonly none: string }
  readonly judged?: RetimeJudgement
  /** The checker's longest outage of the outage group on the judged rows (h), or 'open' when it is not returned. */
  readonly outage?: number | 'open'
}

/** The outage group: the plan's first span-over goal's single group. */
const outageGroup = (inputs: PlanInputs): string => {
  const goal = inputs.goals.find(entry => entry.metric === 'span-over')
  const group = goal?.scope?.groups?.length === 1 ? goal.scope.groups[0] : undefined
  if (group === undefined) throw new Error('The plan has no span-over goal over one group')
  return group
}

/** The checker's longest outage of `group` on these rows: its span, or 'open' when a member is never returned. */
export const outageOf = (inputs: PlanInputs, variant: Option['variant'], rows: readonly CheckRow[], group: string): number | 'open' => {
  const check = checkPlan(inputs, variant, rows)
  const members = inputs.equipment.filter(item => item.group === group).map(item => item.key)
  if (members.some(member => (check.outages.get(member) ?? []).some(interval => interval.to === Infinity))) return 'open'
  return check.metrics.find(metric => metric.id === `span:${group}`)?.value ?? 0
}

/** Each job with its own estimate (not World values, not a duration per crew), at +25 % as its high estimate. */
const plus25 = (inputs: PlanInputs, scheduled: ReadonlySet<string>): { readonly inputs: PlanInputs; readonly high: string[] } => {
  const own = inputs.jobs.filter(job => scheduled.has(job.key) && job.duration.origin.by !== 'world' && job.durationWith.length === 0 && job.duration.value !== null && job.duration.value > 0)
  const keys = new Set(own.map(job => job.key))
  return {
    inputs: { ...inputs, jobs: inputs.jobs.map(job => keys.has(job.key) ? { ...job, duration: { ...job.duration, range: { low: job.duration.range?.low ?? job.duration.value!, high: job.duration.value! * 1.25 } } } : job) },
    high: [...keys],
  }
}

/** The table's rows for one option of a plan. */
export const sensitivityRows = (inputs: PlanInputs, option: Option): SensitivityRow[] => {
  const group = outageGroup(inputs)
  const scheduled = new Set(option.rows.map(row => row.job))
  const title = (key: string) => inputs.jobs.find(job => job.key === key)?.title ?? key
  const ranged = rangedJobs(inputs, option.variant)
  const everyJob = plus25(inputs, scheduled)
  const cases = [
    { label: '+25 % on every job', ...everyJob },
    { label: 'Every three-point job at its high estimate', inputs, high: ranged },
    ...ranged.map(key => ({ label: `${title(key)} alone at its high estimate`, inputs, high: [key] })),
  ]
  return cases.map(({ label, inputs: caseInputs, high }): SensitivityRow => {
    const pessimistic = atHigh(caseInputs, new Set(high))
    const found = retimedRows(caseInputs, pessimistic, option)
    if (found === undefined) return { label, inputs: caseInputs, high, none: 'the repair path could not re-time this option' }
    const retimed = 'rows' in found ? found.rows : placedRows(caseInputs, pessimistic, option)
    const judged = judgeRetiming(caseInputs, option.variant, option.rows, retimed, high)
    return { label, inputs: caseInputs, high, retimed, judged, outage: outageOf(judgedInputs(caseInputs, high, retimed), option.variant, retimed, group) }
  })
}

const hours = (value: number): string => `${Number(value.toFixed(2))} h`

/** The table as markdown, from the plan, the option and its rows; every figure from the rows' lane K results. */
export const renderTable = (inputs: PlanInputs, option: Option, rows: readonly SensitivityRow[]): string => {
  const group = outageGroup(inputs)
  const zone = inputs.settings.timeZone ?? 'UTC'
  const when = (instant: string): string => {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant))
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(entry => entry.type === type)?.value ?? ''
    return `${part('weekday')} ${part('day')} ${part('month')} ${part('hour')}:${part('minute')}`
  }
  const title = (key: string) => inputs.jobs.find(job => job.key === key)?.title ?? key
  const resource = (key: string) => inputs.resources.find(entry => entry.key === key)?.label ?? key
  const groupLabel = inputs.groups.find(entry => entry.key === group)?.label ?? group
  const limit = inputs.rules.find(rule => rule.kind === 'span-limit' && rule.group === group)
  const ruleWords = (key: string): string => {
    const rule = inputs.rules.find(entry => entry.key === key)
    if (rule?.kind === 'span-limit') return `the ${rule.limit.value} ${rule.limit.unit} limit on ${inputs.groups.find(entry => entry.key === rule.group)?.label ?? rule.group}`
    if (rule?.kind === 'due') return `the due time of '${title(rule.job)}'`
    return key
  }
  const outcome = (row: SensitivityRow): string => {
    if (row.retimed === undefined) return `not re-timed: ${row.none}`
    const judged = row.judged!
    if (!judged.ok) return `not judged: ${judged.problems[0]}`
    const result = judged.outcome
    if (result.holds) return 'keeps every rule'
    if ('rule' in result) return `breaks ${ruleWords(result.rule)} at '${title(result.job)}', by ${hours(result.by.value)}`
    if ('window' in result) return `runs past the window end at '${title(result.job)}'; the work would end ${when(result.window.by)}`
    return `'${title(result.unplaced.job)}' could not be done: ${resource(result.unplaced.resource)} has no time left after ${when(result.unplaced.after)}`
  }
  const outage = (row: SensitivityRow): string => row.outage === undefined ? 'not measured' : row.outage === 'open' ? 'not returned' : hours(row.outage)
  const planned = outageOf(inputs, option.variant, option.rows, group)
  return [
    `Pessimistic re-timing of "${option.label}" on the Train A flagship: the same order and crews, nothing earlier than planned; judged by lane K's checker.`,
    '',
    `| Case | Longest outage, ${groupLabel}${limit?.kind === 'span-limit' ? ` (limit ${limit.limit.value} ${limit.limit.unit})` : ''} | Pessimistic check |`,
    '|---|---|---|',
    `| As planned (most likely durations) | ${planned === 'open' ? 'not returned' : hours(planned)} | ${judgeRetiming(inputs, option.variant, option.rows, option.rows, []).ok ? 'keeps every rule' : 'not judged'} |`,
    ...rows.map(row => `| ${row.label} | ${outage(row)} | ${outcome(row)} |`),
  ].join('\n')
}

/** The flagship's recommended option, solved the same way on every machine. */
export const flagshipOption = async (inputs: PlanInputs): Promise<Option> => {
  const set = (await generate({ engine: searchEngine(), check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound }, {
    inputs, revision: 1, previous: null, input: {}, by: { kind: 'service', name: 'sensitivity table' }, signal: new AbortController().signal, seed: 1, evals: 600,
  })).optionSet
  const option = set.options.find(entry => entry.key === set.recommended)
  if (option === undefined) throw new Error('The flagship has no recommended option')
  return option
}

if (import.meta.main) {
  const inputs = trainAInputs({ read: true })
  const option = await flagshipOption(inputs)
  console.log(renderTable(inputs, option, sensitivityRows(inputs, option)))
}
