import { checkCandidate } from './checker.ts'
import { calculateMetrics } from './metrics.ts'
import { checkPlanningProblem, planningScheduleResultSchema, type PlanningActivity, type PlanningIssue, type PlanningPlacement, type PlanningProblem, type PlanningScheduleResult } from './model.ts'

export interface PlanningScheduleBudget { readonly maxPlacementChecks: number }

/** A finite event-point scan: no per-second advance and no rescheduling actuals. */
export const scheduleProblem = (input: unknown, budget: PlanningScheduleBudget): PlanningScheduleResult => {
  const checked = checkPlanningProblem(input)
  const result = (status: PlanningScheduleResult['status'], placements: readonly PlanningPlacement[], issues: readonly PlanningIssue[], placementChecks: number): PlanningScheduleResult => planningScheduleResultSchema.parse({ status, algorithm: 'serial-elapsed-fs', placements, metrics: null, issues, placementChecks })
  if (checked.status !== 'valid') return result(checked.status, [], checked.issues, 0)
  if (!Number.isSafeInteger(budget.maxPlacementChecks) || budget.maxPlacementChecks < 1) return result('invalid', [], [{ code: 'invalid_budget', path: ['maxPlacementChecks'], message: 'Placement-check budget must be a positive safe integer' }], 0)
  const problem = checked.problem
  const byId = new Map(problem.activities.map(activity => [activity.id, activity]))
  const placed = new Map<string, PlanningPlacement>()
  let placementChecks = 0
  const ordered = (): PlanningPlacement[] => problem.activities.flatMap(activity => { const placement = placed.get(activity.id); return placement ? [placement] : [] })
  const issue = (code: string, activity: PlanningActivity, message: string): PlanningIssue => ({ code, path: ['activities', activity.id], activityId: activity.id, message })
  for (const activity of problem.activities) {
    const progress = activity.progress
    if (progress.kind === 'planned') continue
    if (progress.kind === 'completed') placed.set(activity.id, { activityId: activity.id, start: progress.actualStart, end: progress.actualFinish, kind: 'completed' })
    else {
      if (progress.remainingSeconds === null) return result('unknown', ordered(), [issue('unknown_remaining', activity, 'Refresh the remaining-duration estimate before scheduling')], 0)
      if (progress.remainingSeconds > problem.horizon.end - progress.asOf) return result('unknown', ordered(), [issue('remaining_outside_horizon', activity, 'Remaining work extends beyond the declared horizon')], 0)
      placed.set(activity.id, { activityId: activity.id, start: progress.actualStart, end: progress.asOf + progress.remainingSeconds, kind: 'started' })
    }
  }
  for (const link of problem.precedences) {
    const successor = byId.get(link.successorId)
    if (!successor) throw new Error('Validated precedence lost its successor')
    if (successor.progress.kind === 'planned') continue
    const predecessor = placed.get(link.predecessorId)
    const actualStart = successor.progress.actualStart
    if (!predecessor || actualStart - predecessor.end < link.lagSeconds) return result('unsupported', [], [issue('out_of_sequence_progress', successor, 'Actual progress contradicts FS logic; the first profile does not override it')], 0)
  }
  const committedCheck = checkCandidate(problem, ordered(), { allowPartial: true })
  if (committedCheck.status !== 'satisfied') return result('unknown', ordered(), committedCheck.issues, 0)
  const reserved = (): readonly PlanningPlacement[] => [...placed.values()]
  const pending = new Set(problem.activities.filter(activity => activity.progress.kind === 'planned').map(activity => activity.id))
  while (pending.size > 0) {
    const nextId = problem.priorityOrder.find(id => pending.has(id) && problem.precedences.filter(link => link.successorId === id).every(link => placed.has(link.predecessorId)))
    if (nextId === undefined) return result('unknown', ordered(), [{ code: 'no_eligible_activity', path: ['precedences'], message: 'No eligible activity is available in the supported precedence profile' }], placementChecks)
    const activity = byId.get(nextId)
    if (!activity) throw new Error('Validated priority order lost its activity')
    let earliest = Math.max(problem.asOf, problem.horizon.start, activity.release ?? problem.horizon.start)
    const latestEnd = Math.min(problem.horizon.end, activity.latestFinish ?? problem.horizon.end)
    for (const link of problem.precedences.filter(link => link.successorId === nextId)) {
      const predecessor = placed.get(link.predecessorId)
      if (!predecessor) throw new Error('Eligible activity lost its predecessor placement')
      if (link.lagSeconds > problem.horizon.end - predecessor.end) { earliest = problem.horizon.end; break }
      earliest = Math.max(earliest, predecessor.end + link.lagSeconds)
    }
    const points = new Set<number>([earliest])
    for (const supply of problem.supplies.filter(supply => activity.demands.some(demand => demand.supplyId === supply.id))) for (const segment of supply.segments) {
      if (segment.start >= earliest) points.add(segment.start)
      if (segment.end >= earliest) points.add(segment.end)
    }
    for (const placement of placed.values()) if (placement.end >= earliest) points.add(placement.end)
    let selected: PlanningPlacement | undefined
    for (const start of [...points].sort((a, b) => a - b)) {
      if (start > latestEnd || activity.durationSeconds > latestEnd - start) break
      if (placementChecks >= budget.maxPlacementChecks) return result('unknown', ordered(), [issue('budget_exhausted', activity, 'Placement-check budget exhausted before a complete schedule was found')], placementChecks)
      placementChecks++
      const end = start + activity.durationSeconds
      if (slotAvailable(problem, activity, start, end, reserved(), byId)) { selected = { activityId: activity.id, start, end, kind: 'planned' }; break }
    }
    if (!selected) return result('unknown', ordered(), [issue('no_slot_found', activity, 'This priority heuristic found no capacity-feasible slot within the declared window; infeasibility is not proved')], placementChecks)
    placed.set(nextId, selected)
    pending.delete(nextId)
  }
  const placements = ordered()
  const finalCheck = checkCandidate(problem, placements)
  if (finalCheck.status !== 'satisfied') return result('unknown', placements, finalCheck.issues, placementChecks)
  try {
    return planningScheduleResultSchema.parse({ status: 'feasible', algorithm: 'serial-elapsed-fs', placements, metrics: calculateMetrics(problem, placements), issues: [], placementChecks })
  } catch (error) {
    return result('invalid', [], [{ code: 'metric_range', path: ['objectives'], message: error instanceof Error ? error.message : 'Computed metrics exceed the exact integer profile' }], placementChecks)
  }
}

const slotAvailable = (problem: PlanningProblem, activity: PlanningActivity, start: number, end: number, reservations: readonly PlanningPlacement[], activities: ReadonlyMap<string, PlanningActivity>): boolean => {
  if (start === end) return true
  for (const demand of activity.demands) {
    const supply = problem.supplies.find(item => item.id === demand.supplyId)
    if (!supply) throw new Error('Validated demand lost its supply')
    const points = new Set<number>([start])
    for (const segment of supply.segments) {
      if (start < segment.start && segment.start < end) points.add(segment.start)
      if (start < segment.end && segment.end < end) points.add(segment.end)
    }
    for (const reservation of reservations) {
      if (start < reservation.start && reservation.start < end) points.add(reservation.start)
      if (start < reservation.end && reservation.end < end) points.add(reservation.end)
    }
    for (const at of points) {
      const capacity = supply.segments.find(segment => segment.start <= at && at < segment.end)?.capacity ?? 0
      let load = BigInt(demand.amount)
      for (const reservation of reservations) if (reservation.start <= at && at < reservation.end) {
        const other = activities.get(reservation.activityId)
        if (!other) throw new Error('Reservation lost its activity')
        const amount = other.demands.find(item => item.supplyId === supply.id)?.amount ?? 0
        load += BigInt(amount)
      }
      if (load > BigInt(capacity)) return false
    }
  }
  return true
}
