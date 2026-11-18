import { createHash } from 'node:crypto'
import { planningError } from '../errors.ts'
import type { Plan } from '../plan/schema.ts'
import { resultLimitBytes, type StatusOut } from './contract.ts'
import { scheduleDisplayResultSchema, type ScheduleDisplayResult } from './schedule-display-contract.ts'

type Option = NonNullable<Plan['options']>['options'][number]

/** Read-only publication of retained owner evidence. The chart loads the usual
 * paged jobs/rows, then rechecks this digest; a later result never replaces an
 * old answer's dates silently. No extra snapshot store is introduced. */
export const scheduleDisplay = (config: {
  plan: Plan
  option: Option
  fresh: (option: Option) => boolean
  status: (option: Option) => StatusOut
  expectedDigest?: string
}): ScheduleDisplayResult => {
  const { plan, option } = config
  const finish = (candidate: Option): string | null => candidate.rows.reduce<string | null>((last, row) => last === null || Date.parse(row.finish) > Date.parse(last) ? row.finish : last, null)
  const costGoal = plan.inputs.goals.findIndex(goal => goal.metric === 'extra-cost')
  const cost = (candidate: Option): number | null => candidate.metrics.find(metric => metric.id === (costGoal < 0 ? 'extra-cost' : `goal:${costGoal}`))?.value ?? null
  const fresh = config.fresh(option)
  const referenceOption = fresh && option.status.word !== 'validated feasible'
    ? (plan.options?.options ?? []).filter(candidate => config.fresh(candidate) && candidate.status.word === 'validated feasible' && finish(candidate) !== null)
      .sort((left, right) => Date.parse(finish(left)!) - Date.parse(finish(right)!)
        || Number(left.variant.also !== undefined || left.variant.lead !== undefined) - Number(right.variant.also !== undefined || right.variant.lead !== undefined)
        || left.key.localeCompare(right.key))[0]
    : undefined
  const due = option.variant.also?.find(rule => rule.kind === 'due')
  const digest = createHash('sha256').update(JSON.stringify({ revision: plan.revision, inputs: plan.inputs, option, fresh, reference: referenceOption ?? null })).digest('hex')
  if (config.expectedDigest !== undefined && config.expectedDigest !== digest) throw planningError(409, 'schedule_display_changed', 'This published schedule no longer matches its retained evidence. Ask for a new schedule view.')
  const result = scheduleDisplayResultSchema.parse({
    view: { viewType: 'planning.schedule', title: `${option.label}: schedule`.slice(0, 120), height: 650, state: JSON.stringify({ plan: plan.id, option: option.key, digest }) },
    schedule: {
      plan: { id: plan.id, title: plan.inputs.settings.title, revision: plan.revision, timeZone: plan.inputs.settings.timeZone, window: plan.inputs.settings.window, currency: plan.inputs.settings.currency },
      option: { key: option.key, label: option.label, inputsRevision: option.inputsRevision, fresh, status: config.status(option), cost: cost(option), finish: finish(option) },
      deadline: due === undefined ? null : { job: due.job, finishBy: due.finishBy },
      certificate: option.status.word === 'proven infeasible' ? option.status.cause : null,
      reference: referenceOption === undefined ? null : { key: referenceOption.key, label: referenceOption.label, inputsRevision: referenceOption.inputsRevision, fresh: true, cost: cost(referenceOption), finish: finish(referenceOption) },
      digest,
    },
  })
  if (Buffer.byteLength(JSON.stringify(result)) > resultLimitBytes) throw planningError(422, 'record_too_large', 'This schedule proof is larger than one display receipt. Read its schedule and refusal explanation through the plan sections.')
  return result
}
