import { z } from 'zod'
import { workspaceResourceReferenceSchema } from '@leitbild/contracts/resources'

// These limits bound the first interactive research profile, not a solver claim
// about larger projects. Search itself has a caller-supplied work budget.
export const planningProfileLimits = { activities: 256, supplies: 64, segmentsPerSupply: 256, precedences: 4096 } as const
export const planningProfile = 'elapsed-fs' as const

export const planningIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._~-]*$/)
export const planningSecondSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const quantitySchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const planningIntervalSchema = z.object({ start: planningSecondSchema, end: planningSecondSchema }).strict()
  .refine(interval => interval.end > interval.start, { message: 'Interval end must be greater than start', path: ['end'] })

export const planningSubjectSchema = z.object({
  resource: workspaceResourceReferenceSchema,
  // An owner-returned opaque locator. Planning never parses or mutates it.
  locator: z.string().min(1).max(1024),
}).strict()
export type PlanningSubject = z.infer<typeof planningSubjectSchema>

export const planningProgressSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('planned') }).strict(),
  z.object({ kind: z.literal('started'), actualStart: planningSecondSchema, asOf: planningSecondSchema, remainingSeconds: planningSecondSchema.nullable() }).strict(),
  z.object({ kind: z.literal('completed'), actualStart: planningSecondSchema, actualFinish: planningSecondSchema }).strict(),
])

export const planningActivitySchema = z.object({
  id: planningIdSchema,
  title: z.string().trim().min(1).max(256),
  modeId: planningIdSchema,
  durationSeconds: planningSecondSchema,
  demands: z.array(z.object({ supplyId: planningIdSchema, amount: quantitySchema.refine(amount => amount > 0, 'Demand must be positive') }).strict()).max(planningProfileLimits.supplies),
  release: planningSecondSchema.optional(),
  latestFinish: planningSecondSchema.optional(),
  due: planningSecondSchema.optional(),
  tardinessWeight: quantitySchema,
  subject: planningSubjectSchema.optional(),
  progress: planningProgressSchema,
}).strict()

export const planningSupplySchema = z.object({
  id: planningIdSchema,
  title: z.string().trim().min(1).max(256),
  unit: z.string().trim().min(1).max(64).optional(),
  // Capacity is zero outside these nonoverlapping half-open segments.
  segments: z.array(planningIntervalSchema.extend({ capacity: quantitySchema })).max(planningProfileLimits.segmentsPerSupply),
}).strict()

export const planningObjectiveSchema = z.discriminatedUnion('metric', [
  z.object({ metric: z.literal('makespan'), direction: z.enum(['minimize', 'maximize']), tolerance: planningSecondSchema }).strict(),
  z.object({ metric: z.literal('weighted-tardiness'), direction: z.enum(['minimize', 'maximize']), tolerance: quantitySchema }).strict(),
  z.object({ metric: z.literal('activity-completion'), activityId: planningIdSchema, direction: z.enum(['minimize', 'maximize']), tolerance: planningSecondSchema }).strict(),
  z.object({ metric: z.literal('activity-tardiness'), activityId: planningIdSchema, direction: z.enum(['minimize', 'maximize']), tolerance: planningSecondSchema }).strict(),
])

export const planningProblemSchema = z.object({
  profile: z.literal(planningProfile),
  axis: z.object({ run: workspaceResourceReferenceSchema, unit: z.literal('second') }).strict(),
  horizon: planningIntervalSchema,
  asOf: planningSecondSchema,
  supplies: z.array(planningSupplySchema).max(planningProfileLimits.supplies),
  activities: z.array(planningActivitySchema).min(1).max(planningProfileLimits.activities),
  precedences: z.array(z.object({ predecessorId: planningIdSchema, successorId: planningIdSchema, lagSeconds: planningSecondSchema }).strict()).max(planningProfileLimits.precedences),
  priorityOrder: z.array(planningIdSchema).min(1).max(planningProfileLimits.activities),
  objectives: z.array(planningObjectiveSchema).max(32),
}).strict()

export type PlanningProblem = z.infer<typeof planningProblemSchema>
export type PlanningActivity = z.infer<typeof planningActivitySchema>
export type PlanningSupply = z.infer<typeof planningSupplySchema>
export type PlanningObjective = z.infer<typeof planningObjectiveSchema>

export const planningIssueSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  path: z.array(z.union([z.string(), z.number()])),
  activityId: planningIdSchema.optional(),
  supplyId: planningIdSchema.optional(),
}).strict()
export type PlanningIssue = z.infer<typeof planningIssueSchema>

export const planningPlacementSchema = z.object({
  activityId: planningIdSchema,
  start: planningSecondSchema,
  end: planningSecondSchema,
  kind: z.enum(['planned', 'started', 'completed']),
}).strict().refine(placement => placement.end >= placement.start, { message: 'Placement end cannot precede start', path: ['end'] })
export type PlanningPlacement = z.infer<typeof planningPlacementSchema>

export const planningMetricsSchema = z.object({
  makespan: planningSecondSchema,
  totalTardiness: quantitySchema,
  weightedTardiness: quantitySchema,
  completionTimes: z.record(planningIdSchema, planningSecondSchema),
  tardiness: z.record(planningIdSchema, planningSecondSchema),
}).strict()
export type PlanningMetrics = z.infer<typeof planningMetricsSchema>

export const planningScheduleResultSchema = z.object({
  status: z.enum(['feasible', 'unknown', 'invalid', 'unsupported']),
  algorithm: z.literal('serial-elapsed-fs'),
  placements: z.array(planningPlacementSchema).max(planningProfileLimits.activities),
  metrics: planningMetricsSchema.nullable(),
  issues: z.array(planningIssueSchema),
  placementChecks: planningSecondSchema,
}).strict().superRefine((result, ctx) => {
  if (result.status === 'feasible' && (result.metrics === null || result.issues.length > 0)) ctx.addIssue({ code: 'custom', path: ['status'], message: 'A feasible result requires metrics and no unresolved issues' })
  if (result.status !== 'feasible' && result.metrics !== null) ctx.addIssue({ code: 'custom', path: ['metrics'], message: 'Incomplete results do not publish complete metrics' })
})
export type PlanningScheduleResult = z.infer<typeof planningScheduleResultSchema>

export const planningCandidateCheckSchema = z.object({
  status: z.enum(['satisfied', 'violated', 'unknown', 'invalid', 'unsupported']),
  issues: z.array(planningIssueSchema),
}).strict()
export type PlanningCandidateCheck = z.infer<typeof planningCandidateCheckSchema>

export type PlanningProblemCheck =
  | { readonly status: 'valid'; readonly problem: PlanningProblem; readonly issues: readonly [] }
  | { readonly status: 'invalid' | 'unsupported'; readonly issues: readonly PlanningIssue[] }

export const checkPlanningProblem = (input: unknown): PlanningProblemCheck => {
  if (typeof input === 'object' && input !== null && 'profile' in input && typeof input.profile === 'string' && input.profile !== planningProfile) {
    return { status: 'unsupported', issues: [{ code: 'unsupported_profile', path: ['profile'], message: `Supported profile is ${planningProfile}` }] }
  }
  const parsed = planningProblemSchema.safeParse(input)
  if (!parsed.success) return {
    status: 'invalid',
    issues: parsed.error.issues.map(issue => ({ code: 'invalid_input', path: issue.path.map(part => typeof part === 'symbol' ? String(part) : part), message: issue.message })),
  }
  const problem = parsed.data
  const issues: PlanningIssue[] = []
  const add = (code: string, path: (string | number)[], message: string): void => { issues.push({ code, path, message }) }
  if (problem.axis.run.moduleId !== 'world' || problem.axis.run.type !== 'world.simulation-run') add('invalid_axis', ['axis', 'run'], 'The first profile requires an exact World Simulation Run')
  if (problem.asOf < problem.horizon.start || problem.asOf > problem.horizon.end) add('invalid_as_of', ['asOf'], 'asOf must be inside the planning horizon')
  const activities = new Map<string, PlanningActivity>()
  problem.activities.forEach((activity, index) => {
    if (activities.has(activity.id)) add('duplicate_activity', ['activities', index, 'id'], `Duplicate activity ${activity.id}`)
    activities.set(activity.id, activity)
    if (activity.subject && activity.subject.resource.workspaceId !== problem.axis.run.workspaceId) add('different_workspace', ['activities', index, 'subject'], 'Subject must belong to the axis Workspace')
    if (activity.release !== undefined && activity.release > problem.horizon.end) add('invalid_release', ['activities', index, 'release'], 'Release exceeds the horizon')
    if (activity.latestFinish !== undefined && activity.latestFinish < problem.horizon.start) add('invalid_latest_finish', ['activities', index, 'latestFinish'], 'Latest finish precedes the horizon')
    if (activity.durationSeconds === 0 && activity.demands.length > 0) add('milestone_demand', ['activities', index, 'demands'], 'A zero-duration milestone cannot occupy capacity')
    const demandIds = new Set<string>()
    activity.demands.forEach((demand, demandIndex) => {
      if (demandIds.has(demand.supplyId)) add('duplicate_demand', ['activities', index, 'demands', demandIndex], 'Combine demand for one supply into one quantity')
      demandIds.add(demand.supplyId)
    })
    const progress = activity.progress
    if (progress.kind !== 'planned') {
      if (progress.actualStart < problem.horizon.start || progress.actualStart > problem.asOf) add('invalid_actual_start', ['activities', index, 'progress', 'actualStart'], 'Actual start must be between horizon start and asOf')
      if (progress.kind === 'started' && progress.asOf !== problem.asOf) add('mixed_progress_frame', ['activities', index, 'progress', 'asOf'], 'Refresh remaining work to the problem asOf frame')
      if (progress.kind === 'completed' && (progress.actualFinish < progress.actualStart || progress.actualFinish > problem.asOf)) add('invalid_actual_finish', ['activities', index, 'progress', 'actualFinish'], 'Actual finish must be between actual start and asOf')
    }
  })
  const supplyIds = new Set<string>()
  problem.supplies.forEach((supply, index) => {
    if (supplyIds.has(supply.id)) add('duplicate_supply', ['supplies', index, 'id'], `Duplicate supply ${supply.id}`)
    supplyIds.add(supply.id)
    const sorted = [...supply.segments].sort((a, b) => a.start - b.start)
    sorted.forEach((segment, segmentIndex) => {
      if (segment.start < problem.horizon.start || segment.end > problem.horizon.end) add('segment_outside_horizon', ['supplies', index, 'segments'], 'Capacity segments must lie inside the horizon')
      const prior = sorted[segmentIndex - 1]
      if (prior && segment.start < prior.end) add('overlapping_capacity', ['supplies', index, 'segments'], 'Capacity segments cannot overlap')
    })
  })
  problem.activities.forEach((activity, index) => activity.demands.forEach((demand, demandIndex) => {
    if (!supplyIds.has(demand.supplyId)) add('missing_supply', ['activities', index, 'demands', demandIndex, 'supplyId'], `Unknown supply ${demand.supplyId}`)
  }))
  const orderIds = new Set(problem.priorityOrder)
  if (orderIds.size !== problem.priorityOrder.length || orderIds.size !== activities.size || problem.priorityOrder.some(id => !activities.has(id))) add('invalid_priority_order', ['priorityOrder'], 'priorityOrder must contain every activity exactly once')
  const adjacency = new Map<string, string[]>([...activities.keys()].map(id => [id, []]))
  const incoming = new Map<string, number>([...activities.keys()].map(id => [id, 0]))
  const linkIds = new Set<string>()
  problem.precedences.forEach((link, index) => {
    if (!activities.has(link.predecessorId) || !activities.has(link.successorId)) {
      add('missing_activity', ['precedences', index], 'Precedence endpoints must identify existing activities')
      return
    }
    const key = `${link.predecessorId}\u0000${link.successorId}`
    if (linkIds.has(key)) add('duplicate_precedence', ['precedences', index], 'Only one FS link per activity pair is supported')
    linkIds.add(key)
    adjacency.get(link.predecessorId)?.push(link.successorId)
    incoming.set(link.successorId, (incoming.get(link.successorId) ?? 0) + 1)
  })
  const ready = [...incoming].filter(([, count]) => count === 0).map(([id]) => id)
  let visited = 0
  for (let cursor = 0; cursor < ready.length; cursor++) {
    const id = ready[cursor]
    if (id === undefined) throw new Error('Topological queue index is missing')
    visited++
    for (const next of adjacency.get(id) ?? []) {
      const count = (incoming.get(next) ?? 0) - 1
      incoming.set(next, count)
      if (count === 0) ready.push(next)
    }
  }
  if (visited !== activities.size) add('cyclic_precedence', ['precedences'], 'The first profile requires an acyclic precedence graph')
  problem.objectives.forEach((objective, index) => {
    if ('activityId' in objective && !activities.has(objective.activityId)) add('missing_activity', ['objectives', index, 'activityId'], `Unknown activity ${objective.activityId}`)
  })
  return issues.length === 0 ? { status: 'valid', problem, issues: [] } : { status: 'invalid', issues }
}
