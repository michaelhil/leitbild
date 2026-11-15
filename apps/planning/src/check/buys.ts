// "What overtime buys" (design §4.1, C7): where each rung stands, from what Generate stored only. It never runs
// the checker: a read calls it in the service process, which stays light. Every figure it reads was made by
// lane K's checker in the solver child, and every proof word was re-derived there by lane K, so they stand
// exactly while the option's inputs revision and formulation (which names the checker's version) are the
// plan's. Otherwise the rung is unsolved. tests/harness/buys-honesty.ts guards it with the checker itself.
//
// An end is "proven" only when its proof fixes the figure a row compares, the longest outage:
// - the plan's first span-over goal (the outage goal) is stored as proven optimal;
// - its stored value is the stored figure of the goal (its group's span past the threshold);
// - the goal covers one group, so its value is that group's span past the threshold;
// - and the value is above the threshold (or the threshold is 0). At 0 past a threshold a proof says only
//   "no more than the threshold": the outage itself may still shorten, so the end is only "found".
// Figures: the outage is the outage goal's stored span per group ('goal:<k>:<group>', in the goal's unit; a
// goal over every group stores only the groups that are out), the cost the extra-cost goal's 'goal:<k>' or,
// with no such goal, the checker's 'extra-cost', and the bought time the 'bought:<purchase>' figures.
import type { buysEndSchema, buysWordSchema } from '../api/contract.ts'
import type { z } from 'zod'
import { goalResolution, type Plan } from '../plan/schema.ts'
import type { Metric } from './metrics.ts'

export type BuysEnd = z.infer<typeof buysEndSchema>
export type BuysWord = z.infer<typeof buysWordSchema>
type Option = NonNullable<Plan['options']>['options'][number]

export interface RungStanding {
  readonly end: BuysEnd
  /** The longest outage of the outage goal's groups, in h, and the extra cost, when solved. */
  readonly outage?: number
  readonly cost?: number
  /** The option's 'bought:<purchase>' figures. */
  readonly bought: readonly Metric[]
  /** Solved on another inputs revision or formulation: a rung names only a fresh option. */
  readonly stale: boolean
  readonly why: string
}

const unitHours: Readonly<Record<string, number>> = { s: 1 / 3_600, min: 1 / 60, h: 1, d: 24 }

/** The outage goal (the plan's first span-over goal) and the groups whose longest span a row compares. */
export const outageGoal = (plan: Plan) => {
  const index = plan.inputs.goals.findIndex(goal => goal.metric === 'span-over')
  const goal = index < 0 ? undefined : plan.inputs.goals[index]!
  return { index, goal, groups: goal?.scope?.groups ?? plan.inputs.groups.map(group => group.key) }
}

/** Where one stored option stands as a rung, from its stored status and figures. No option: unsolved. */
export const rungStanding = (plan: Plan, option: Option | undefined, formulation: string): RungStanding => {
  const unsolved = (why: string, stale = false): RungStanding => ({ end: 'unsolved', bought: [], stale, why })
  if (option === undefined) return unsolved('no stored option')
  const status = option.status
  if (option.inputsRevision !== plan.revision) return unsolved(`solved at revision ${option.inputsRevision}, not ${plan.revision}`, true)
  if ('run' in status && status.run.formulation !== formulation) return unsolved('solved with another formulation', true)
  if (status.word === 'proven infeasible') return { end: 'refused', bought: [], stale: false, why: 'refused with a certificate lane K re-verified' }
  if (status.word !== 'validated feasible') return unsolved(status.word)
  const { index, goal, groups } = outageGoal(plan)
  if (goal === undefined) return unsolved('the plan has no outage goal (span-over), so a rung has no outage to compare')
  const stored = (id: string) => option.metrics.find(metric => metric.id === id)
  const unit = goal.tolerance.unit
  const spans: number[] = []
  for (const group of groups) {
    const figure = stored(`goal:${index}:${group}`)
    if (figure === undefined && goal.scope?.groups !== undefined) return unsolved(`no stored 'goal:${index}:${group}'`)
    spans.push(figure?.value ?? 0)   // a goal over every group stores only the groups that are out
  }
  const costGoal = plan.inputs.goals.findIndex(entry => entry.metric === 'extra-cost')
  const costId = costGoal < 0 ? 'extra-cost' : `goal:${costGoal}`
  const cost = stored(costId)
  if (cost === undefined) return unsolved(`no stored '${costId}'`)
  const solved = { outage: Math.max(0, ...spans) * (unitHours[unit] ?? 1), cost: cost.value, bought: option.metrics.filter(metric => metric.id.startsWith('bought:')), stale: false }
  const line = status.goals[index]
  if (line === undefined || line.word !== 'proven optimal') return { end: 'found', ...solved, why: 'no proof on the outage goal' }
  // the proof fixes the outage only on the goal's own figure, for one group, above its threshold
  const resolution = goalResolution(line.unit, plan.inputs.settings.grid) ?? 0
  const threshold = goal.threshold === undefined ? 0 : goal.threshold.value * (unitHours[goal.threshold.unit] ?? 1) / (unitHours[line.unit] ?? 1)
  const excess = spans.reduce((sum, span) => sum + Math.max(0, span * (unitHours[unit] ?? 1) / (unitHours[line.unit] ?? 1) - threshold), 0)
  if (!(Math.abs(excess - line.value) < resolution / 2)) return { end: 'found', ...solved, why: 'the proven value is not the stored figure' }
  if (groups.length !== 1) return { end: 'found', ...solved, why: 'the outage goal sums several groups, so its proof fixes no one outage' }
  if (threshold > 0 && line.value < resolution / 2) return { end: 'found', ...solved, why: 'proven at 0 past the threshold: the outage itself is not fixed' }
  return { end: 'proven', ...solved, why: 'proven on the outage, which the proof fixes' }
}

const solvedEnd = (end: BuysEnd): boolean => end === 'proven' || end === 'found'

/**
 * Whether a word is true of two ends and of the higher rung's outage minus the lower's (h). The weaker
 * "found" and "not found better" are true of proven ends too; no word with a proof in it is true without one.
 */
export const wordStands = (word: BuysWord, ends: { readonly from: BuysEnd; readonly to: BuysEnd }, outage: number | undefined): boolean => {
  const both = solvedEnd(ends.from) && solvedEnd(ends.to)
  const proven = ends.from === 'proven' && ends.to === 'proven'
  switch (word) {
    case 'makes it possible': return ends.from === 'refused' && solvedEnd(ends.to)
    case 'not solved': return ends.from === 'unsolved' || ends.to === 'unsolved'
    case 'proven': return proven && outage !== undefined && outage < 0
    case 'proven: no gain': return proven && outage !== undefined && Math.abs(outage) < 1e-9
    case 'found': return both && outage !== undefined && outage < 0
    case 'not found better': return both && outage !== undefined && outage >= 0
  }
}
