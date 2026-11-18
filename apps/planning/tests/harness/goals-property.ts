// Test harness, the goals property (acceptance row 3): no goal order, threshold or tolerance produces a plan
// that breaks a hard rule. Every option an engine calls "validated feasible" under any goal setting must
// pass the product checker, and no option may carry proof words it cannot back.
import type { PlanInputs } from '../../src/plan/schema.ts'
import { checkPlan } from '../../src/check/check.ts'
import type { GeneratePort } from './ports.ts'

type Goal = PlanInputs['goals'][number]

export interface GoalsFailure { readonly trial: number; readonly goals: readonly Goal[]; readonly option: string; readonly problem: string }

/** A small deterministic generator (mulberry32), so a failing trial can be replayed from its seed. */
export const random = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** A random goal setting over the metrics the plan can measure: order, thresholds and tolerances. */
export const randomGoals = (inputs: PlanInputs, next: () => number): Goal[] => {
  const currency = inputs.settings.currency
  const metrics: Array<Goal['metric']> = ['span-over', 'finish', 'extra-cost', 'unavailable-hours', 'lateness']
  const order = metrics.map(metric => ({ metric, key: next() })).sort((left, right) => left.key - right.key).map(entry => entry.metric)
  const count = 1 + Math.floor(next() * order.length)
  return order.slice(0, count).map((metric): Goal => {
    const unit = metric === 'extra-cost' ? currency : 'h'
    const scale = metric === 'extra-cost' ? 100_000 : 48
    const threshold = next() < 0.5 ? undefined : { value: Math.round(next() * scale), unit }
    const tolerance = { value: next() < 0.4 ? 0 : Math.round(next() * scale / 10), unit }
    const scope = metric === 'span-over' && inputs.groups.length > 0 ? { groups: inputs.groups.filter(() => next() < 0.7).map(group => group.key) } : undefined
    return { metric, ...(scope === undefined || scope.groups.length === 0 ? {} : { scope }), ...(threshold === undefined ? {} : { threshold }), tolerance }
  })
}

export const goalsProperty = async (inputs: PlanInputs, port: GeneratePort, trials: number, seed: number): Promise<GoalsFailure[]> => {
  const failures: GoalsFailure[] = []
  const next = random(seed)
  for (let trial = 0; trial < trials; trial++) {
    const goals = randomGoals(inputs, next)
    const tried = { ...inputs, goals }
    for (const option of await port.generate(tried)) {
      const status = option.status
      if (status.word === 'validated feasible') {
        const check = checkPlan(tried, option.variant, option.rows)
        if (!check.feasible) failures.push({ trial, goals, option: option.key, problem: `called validated feasible with ${check.violations.length} violations: ${check.violations[0]!.words}` })
        if (status.goals.length > goals.length) failures.push({ trial, goals, option: option.key, problem: 'reports more goal values than the plan has goals' })
      } else if (option.rows.length > 0 && status.word !== 'unresolved' && status.word !== 'cancelled') {
        failures.push({ trial, goals, option: option.key, problem: `a ${status.word} option carries a schedule` })
      }
    }
  }
  return failures
}
