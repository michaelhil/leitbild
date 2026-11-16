// The +25 % sensitivity table (lane K batch 2, decision 3; fix round): a stored plan's baseline option, as
// markdown. The coordinator runs it on the published demo's plan, the baseline the walkthrough names:
//   bun apps/planning/tests/harness/sensitivity-table.ts <data root> <workspace id> <plan id> [baseline key]
// It reads the plan through Planning's own store, takes the named baseline (else the plan in force, the latest
// baseline) on the inputs frozen with it, and prints at the top which plan, revision, baseline and option it
// used. Each case re-times that option by lane S's repair path (solve/retime.ts: the same order, crews and
// bought time, nothing earlier) and lane K judges it (check/retime.ts): the longest outage from the checker
// on the judged rows, the outcome from judgeRetiming. The wiki copy names what the header says.
// Cases: every job with its own estimate at +25 %; every three-point job at its high estimate; each alone.
import { judgedInputs, judgeRetiming, rangedJobs, type RetimeJudgement } from '../../src/check/retime.ts'
import { checkPlan, type CheckRow } from '../../src/check/check.ts'
import type { Plan, PlanInputs } from '../../src/plan/schema.ts'
import { compile } from '../../src/solve/compile.ts'
import { dateSchedule, undate } from '../../src/solve/date.ts'
import { finishOf, prepare, repair } from '../../src/solve/decode.ts'
import { atHigh, retimedRows } from '../../src/solve/retime.ts'
import { workspaceIdSchema } from '@leitbild/contracts'
import { createPlanStore } from '../../src/plan/store.ts'

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

type Baseline = Plan['baselines'][number]

/** The named baseline, else the plan in force (the latest baseline). Refused when there is none or no such key. */
export const baselineOf = (plan: Plan, key?: string): Baseline => {
  const named = key === undefined ? [...plan.baselines].sort((x, y) => Date.parse(y.at) - Date.parse(x.at))[0] : plan.baselines.find(baseline => baseline.key === key)
  if (named === undefined) throw new Error(`The plan has ${key === undefined ? 'no baseline' : `no baseline '${key}'`}; its baselines: ${plan.baselines.map(baseline => `${baseline.key} ('${baseline.name}')`).join(', ') || 'none'}`)
  return named
}

/** The table as markdown for one baseline of a plan; every figure from the rows' lane K results. */
export const renderTable = (plan: Plan, baseline: Baseline, rows: readonly SensitivityRow[]): string => {
  const { inputs, option } = baseline
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
  // the bound the unplaced search used (check/retime.ts): the window's length again past the window end
  const windowMs = inputs.settings.window === null ? 0 : Date.parse(inputs.settings.window.end) - Date.parse(inputs.settings.window.start)
  const bound = windowMs % 86_400_000 === 0 ? `${windowMs / 86_400_000} day${windowMs === 86_400_000 ? '' : 's'}` : hours(windowMs / 3_600_000)
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
    if ('lock' in result) return `'${title(result.lock.job)}' could not keep its fixed start: '${title(result.lock.after)}' would finish ${hours(result.by.value)} later`
    return `'${title(result.unplaced.job)}' could not be done: ${resource(result.unplaced.resource)} has no slot long enough left after ${when(result.unplaced.after)}, within ${bound} after the window`
  }
  const outage = (row: SensitivityRow): string => row.outage === undefined ? 'not measured' : row.outage === 'open' ? 'not returned' : hours(row.outage)
  const planned = outageOf(inputs, option.variant, option.rows, group)
  return [
    `Plan '${plan.inputs.settings.title}' (${plan.id}) at revision ${plan.revision}. Baseline '${baseline.name}' (${baseline.key}), saved ${when(baseline.at)}: option '${option.label}' (${option.key}), solved on inputs revision ${option.inputsRevision}, re-timed on the inputs frozen with the baseline.`,
    'Pessimistic re-timing: the same order and crews, nothing earlier than planned; judged by lane K\'s checker.',
    '',
    `| Case | Longest outage, ${groupLabel}${limit?.kind === 'span-limit' ? ` (limit ${limit.limit.value} ${limit.limit.unit})` : ''} | Pessimistic check |`,
    '|---|---|---|',
    `| As planned (most likely durations) | ${planned === 'open' ? 'not returned' : hours(planned)} | ${judgeRetiming(inputs, option.variant, option.rows, option.rows, []).ok ? 'keeps every rule' : 'not judged'} |`,
    ...rows.map(row => `| ${row.label} | ${outage(row)} | ${outcome(row)} |`),
  ].join('\n')
}

/** The table for a stored plan, read through Planning's own store. */
export const tableFor = async (root: string, workspaceId: string, planId: string, key?: string): Promise<{ readonly plan: Plan; readonly baseline: Baseline; readonly rows: SensitivityRow[]; readonly markdown: string }> => {
  const plan = await createPlanStore(root).read(workspaceIdSchema.parse(workspaceId), planId)
  const baseline = baselineOf(plan, key)
  const rows = sensitivityRows(baseline.inputs, baseline.option)
  return { plan, baseline, rows, markdown: renderTable(plan, baseline, rows) }
}

if (import.meta.main) {
  const [root, workspaceId, planId, key] = process.argv.slice(2)
  if (root === undefined || workspaceId === undefined || planId === undefined) throw new Error('usage: sensitivity-table.ts <data root> <workspace id> <plan id> [baseline key]')
  console.log((await tableFor(root, workspaceId, planId, key)).markdown)
}
