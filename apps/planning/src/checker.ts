import { z } from 'zod'
import { checkPlanningProblem, planningPlacementSchema, planningProfileLimits, type PlanningCandidateCheck, type PlanningIssue, type PlanningPlacement } from './model.ts'

/** Independent interval/event-sweep check; this does not call the placement algorithm. */
export const checkCandidate = (problemInput: unknown, placementsInput: unknown, options: { readonly allowPartial?: boolean } = {}): PlanningCandidateCheck => {
  const checked = checkPlanningProblem(problemInput)
  if (checked.status !== 'valid') return { status: checked.status, issues: [...checked.issues] }
  const parsed = z.array(planningPlacementSchema).max(planningProfileLimits.activities).safeParse(placementsInput)
  if (!parsed.success) return { status: 'invalid', issues: parsed.error.issues.map(issue => ({ code: 'invalid_placement', path: issue.path.map(part => typeof part === 'symbol' ? String(part) : part), message: issue.message })) }
  const problem = checked.problem
  const issues: PlanningIssue[] = []
  const unknown: PlanningIssue[] = []
  const add = (code: string, activityId: string, message: string): void => { issues.push({ code, path: ['placements', activityId], activityId, message }) }
  const activities = new Map(problem.activities.map(activity => [activity.id, activity]))
  const placements = new Map<string, PlanningPlacement>()
  for (const placement of parsed.data) {
    const activity = activities.get(placement.activityId)
    if (!activity) { add('unknown_activity', placement.activityId, 'Placement names an unknown activity'); continue }
    if (placements.has(activity.id)) add('duplicate_placement', activity.id, 'Activity has more than one placement')
    placements.set(activity.id, placement)
    if (placement.start < problem.horizon.start || placement.end > problem.horizon.end) add('outside_horizon', activity.id, 'Placement lies outside the horizon')
    if (activity.release !== undefined && placement.start < activity.release) add('release_violation', activity.id, 'Placement precedes its release')
    if (activity.latestFinish !== undefined && placement.end > activity.latestFinish) add('finish_violation', activity.id, 'Placement exceeds its hard latest finish')
    const progress = activity.progress
    if (placement.kind !== progress.kind) add('progress_kind', activity.id, 'Placement kind must preserve actual progress')
    if (progress.kind === 'planned') {
      if (placement.start < problem.asOf) add('past_planned_start', activity.id, 'Unstarted work cannot be planned before asOf')
      if (placement.end - placement.start !== activity.durationSeconds) add('duration_violation', activity.id, 'Placement must have the selected fixed duration')
    } else if (progress.kind === 'completed') {
      if (placement.start !== progress.actualStart || placement.end !== progress.actualFinish) add('actual_history_changed', activity.id, 'Completed actual history cannot be moved')
    } else {
      if (placement.start !== progress.actualStart) add('actual_start_changed', activity.id, 'A started activity retains its actual start')
      if (progress.remainingSeconds === null) unknown.push({ code: 'unknown_remaining', path: ['activities', activity.id, 'progress'], activityId: activity.id, message: 'Remaining duration is unknown; the predicted finish cannot be verified' })
      else if (placement.end - progress.asOf !== progress.remainingSeconds) add('remaining_violation', activity.id, 'Predicted finish must equal asOf plus updated remaining duration')
    }
  }
  if (!options.allowPartial) for (const activity of problem.activities) if (!placements.has(activity.id)) add('missing_placement', activity.id, 'Candidate does not place every activity')
  for (const link of problem.precedences) {
    const predecessor = placements.get(link.predecessorId)
    const successor = placements.get(link.successorId)
    if (predecessor && successor && successor.start - predecessor.end < link.lagSeconds) add('precedence_violation', link.successorId, `Finish-to-start predecessor ${link.predecessorId} plus lag is not satisfied`)
  }
  for (const supply of problem.supplies) {
    const events = new Map<number, bigint>([[problem.asOf, 0n], [problem.horizon.end, 0n]])
    const change = (at: number, amount: bigint): void => { events.set(at, (events.get(at) ?? 0n) + amount) }
    for (const segment of supply.segments) {
      if (segment.start >= problem.asOf) change(segment.start, 0n)
      if (segment.end >= problem.asOf) change(segment.end, 0n)
    }
    for (const [id, placement] of placements) {
      const activity = activities.get(id)
      if (!activity) throw new Error('Checked placement lost its activity')
      const demand = activity.demands.find(item => item.supplyId === supply.id)
      const start = Math.max(problem.asOf, placement.start)
      if (demand && placement.end > start) {
        change(start, BigInt(demand.amount))
        change(placement.end, -BigInt(demand.amount))
      }
    }
    let load = 0n
    for (const at of [...events.keys()].sort((a, b) => a - b)) {
      load += events.get(at) ?? 0n
      if (at >= problem.horizon.end) break
      const capacity = supply.segments.find(segment => segment.start <= at && at < segment.end)?.capacity ?? 0
      if (load > BigInt(capacity)) {
        issues.push({ code: 'capacity_violation', path: ['supplies', supply.id], supplyId: supply.id, message: `Demand ${load} exceeds capacity ${capacity} at second ${at}` })
        break
      }
    }
  }
  return issues.length > 0 ? { status: 'violated', issues: [...issues, ...unknown] } : unknown.length > 0 ? { status: 'unknown', issues: unknown } : { status: 'satisfied', issues: [] }
}
