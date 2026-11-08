import { planningMetricsSchema, type PlanningMetrics, type PlanningObjective, type PlanningPlacement, type PlanningProblem } from './model.ts'

export const calculateMetrics = (problem: PlanningProblem, placements: readonly PlanningPlacement[]): PlanningMetrics => {
  const byId = new Map(placements.map(placement => [placement.activityId, placement]))
  const completion: [string, number][] = []
  const tardiness: [string, number][] = []
  let finish = problem.horizon.start
  let totalTardiness = 0
  let weightedTardiness = 0
  for (const activity of problem.activities) {
    const placement = byId.get(activity.id)
    if (!placement) throw new Error(`Cannot calculate complete metrics without activity ${activity.id}`)
    const late = activity.due === undefined ? 0 : Math.max(0, placement.end - activity.due)
    finish = Math.max(finish, placement.end)
    totalTardiness += late
    weightedTardiness += late * activity.tardinessWeight
    completion.push([activity.id, placement.end])
    tardiness.push([activity.id, late])
  }
  // Fail visibly if aggregate weights/times exceed the exact integer profile.
  return planningMetricsSchema.parse({
    makespan: finish - problem.horizon.start,
    totalTardiness,
    weightedTardiness,
    completionTimes: Object.fromEntries(completion),
    tardiness: Object.fromEntries(tardiness),
  })
}

export const objectiveValue = (objective: PlanningObjective, metrics: PlanningMetrics): number => {
  if (objective.metric === 'makespan') return metrics.makespan
  if (objective.metric === 'weighted-tardiness') return metrics.weightedTardiness
  const values = objective.metric === 'activity-completion' ? metrics.completionTimes : metrics.tardiness
  const value = values[objective.activityId]
  if (value === undefined) throw new Error(`Metric ${objective.metric} is missing activity ${objective.activityId}`)
  return value
}

const compareObjective = (objective: PlanningObjective, left: PlanningMetrics, right: PlanningMetrics): -1 | 0 | 1 => {
  const difference = objectiveValue(objective, left) - objectiveValue(objective, right)
  if (Math.abs(difference) <= objective.tolerance) return 0
  const improving = objective.direction === 'minimize' ? difference < 0 : difference > 0
  return improving ? -1 : 1
}

/** -1 means the left candidate ranks first; 0 means a tie within tolerances. */
export const compareMetrics = (problem: { readonly objectives: readonly PlanningObjective[] }, left: PlanningMetrics, right: PlanningMetrics): -1 | 0 | 1 => {
  for (const objective of problem.objectives) {
    const compared = compareObjective(objective, left, right)
    if (compared !== 0) return compared
  }
  return 0
}

/** Dominance is only among the supplied, explicitly selected objective metrics. */
export const dominatesMetrics = (problem: { readonly objectives: readonly PlanningObjective[] }, left: PlanningMetrics, right: PlanningMetrics): boolean => {
  let better = false
  for (const objective of problem.objectives) {
    const compared = compareObjective(objective, left, right)
    if (compared > 0) return false
    if (compared < 0) better = true
  }
  return better
}
