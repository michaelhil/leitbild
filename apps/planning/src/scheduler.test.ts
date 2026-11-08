import { describe, expect, test } from 'bun:test'
import { checkCandidate } from './checker.ts'
import { calculateMetrics, compareMetrics, dominatesMetrics } from './metrics.ts'
import { checkPlanningProblem, planningProblemSchema, type PlanningActivity, type PlanningProblem } from './model.ts'
import { scheduleProblem } from './scheduler.ts'

const run = { workspaceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', moduleId: 'world', type: 'world.simulation-run', id: 'research-run' }
const activity = (id: string, durationSeconds = 5, release = 0): PlanningActivity => ({ id, title: id, modeId: 'selected', durationSeconds, release, tardinessWeight: 1, demands: [], progress: { kind: 'planned' } })
const problem = (overrides: Partial<PlanningProblem> = {}): PlanningProblem => planningProblemSchema.parse({ profile: 'elapsed-fs', axis: { run, unit: 'second' }, horizon: { start: 0, end: 100 }, asOf: 0, supplies: [], activities: [activity('a')], precedences: [], priorityOrder: ['a'], objectives: [], ...overrides })
const solve = (value: PlanningProblem, maxPlacementChecks = 10_000) => scheduleProblem(value, { maxPlacementChecks })
const handover = (priorityOrder: string[]): PlanningProblem => problem({
  horizon: { start: 0, end: 7200 },
  supplies: [{ id: 'slot', title: 'Receiving slot', segments: [{ start: 0, end: 7200, capacity: 1 }] }],
  activities: [
    { ...activity('a', 15 * 60, 30 * 60), demands: [{ supplyId: 'slot', amount: 1 }] },
    { ...activity('b', 25 * 60, 25 * 60), demands: [{ supplyId: 'slot', amount: 1 }], due: 45 * 60 },
  ], priorityOrder,
  objectives: [{ metric: 'activity-completion', activityId: 'a', direction: 'minimize', tolerance: 0 }, { metric: 'activity-tardiness', activityId: 'b', direction: 'minimize', tolerance: 0 }],
})

describe('hand-derived first-profile schedules', () => {
  test('two handover orders expose the documented tradeoff without choosing units', () => {
    const bFirst = solve(handover(['b', 'a']))
    const aFirst = solve(handover(['a', 'b']))
    expect(bFirst.status).toBe('feasible')
    expect(aFirst.status).toBe('feasible')
    expect(bFirst.placements).toEqual([{ activityId: 'a', start: 3000, end: 3900, kind: 'planned' }, { activityId: 'b', start: 1500, end: 3000, kind: 'planned' }])
    expect(aFirst.placements).toEqual([{ activityId: 'a', start: 1800, end: 2700, kind: 'planned' }, { activityId: 'b', start: 2700, end: 4200, kind: 'planned' }])
    expect(bFirst.metrics?.tardiness.b).toBe(300)
    expect(aFirst.metrics?.tardiness.b).toBe(1500)
    expect(aFirst.metrics).not.toBeNull()
    expect(bFirst.metrics).not.toBeNull()
    if (!aFirst.metrics || !bFirst.metrics) throw new Error('Expected complete metrics')
    expect(compareMetrics(handover(['a', 'b']), aFirst.metrics, bFirst.metrics)).toBe(-1)
    expect(dominatesMetrics(handover(['a', 'b']), aFirst.metrics, bFirst.metrics)).toBe(false)
    expect(dominatesMetrics(handover(['a', 'b']), bFirst.metrics, aFirst.metrics)).toBe(false)
  })

  test('remaining travel refresh moves the forecast without rewriting actual start', () => {
    const value = handover(['travel', 'scene', 'a', 'b'])
    value.asOf = 600
    value.activities = [
      { ...activity('travel', 1200), progress: { kind: 'started', actualStart: 0, asOf: 600, remainingSeconds: 1200 } },
      activity('scene', 600),
      { ...activity('a', 900), demands: [{ supplyId: 'slot', amount: 1 }] },
      { ...activity('b', 1500, 1500), demands: [{ supplyId: 'slot', amount: 1 }], due: 2700 },
    ]
    value.precedences = [{ predecessorId: 'travel', successorId: 'scene', lagSeconds: 0 }, { predecessorId: 'scene', successorId: 'a', lagSeconds: 0 }]
    const result = solve(value)
    expect(result.status).toBe('feasible')
    expect(result.placements.find(item => item.activityId === 'travel')).toEqual({ activityId: 'travel', start: 0, end: 1800, kind: 'started' })
    expect(result.metrics?.completionTimes.a).toBe(3300)
    expect(result.metrics?.completionTimes.b).toBe(4800)
    expect(result.metrics?.tardiness.b).toBe(2100)
  })

  test('a pump method with shared crew and an availability window uses the same kernel', () => {
    const value = problem({
      horizon: { start: 0, end: 20 },
      supplies: [{ id: 'crew', title: 'Crew', segments: [{ start: 4, end: 20, capacity: 1 }] }],
      activities: [
        { ...activity('prepare', 3), demands: [{ supplyId: 'crew', amount: 1 }] },
        { ...activity('repair', 5), demands: [{ supplyId: 'crew', amount: 1 }] },
        { ...activity('verify', 2), demands: [{ supplyId: 'crew', amount: 1 }] },
      ],
      priorityOrder: ['verify', 'repair', 'prepare'],
      precedences: [{ predecessorId: 'prepare', successorId: 'repair', lagSeconds: 1 }, { predecessorId: 'repair', successorId: 'verify', lagSeconds: 0 }],
    })
    expect(solve(value).placements.map(item => [item.activityId, item.start, item.end])).toEqual([['prepare', 4, 7], ['repair', 8, 13], ['verify', 13, 15]])
  })
})

describe('finite capacity event scanning', () => {
  test('a noninterruptible job waits until after a blackout', () => {
    const value = problem({ horizon: { start: 0, end: 20 }, supplies: [{ id: 's', title: 's', segments: [{ start: 0, end: 5, capacity: 1 }, { start: 10, end: 20, capacity: 1 }] }], activities: [{ ...activity('a', 7), demands: [{ supplyId: 's', amount: 1 }] }] })
    expect(solve(value).placements[0]?.start).toBe(10)
  })

  test('a capacity increase permits overlap before the first job finishes', () => {
    const value = problem({ horizon: { start: 0, end: 20 }, supplies: [{ id: 's', title: 's', segments: [{ start: 0, end: 5, capacity: 1 }, { start: 5, end: 20, capacity: 2 }] }], activities: ['a', 'b'].map(id => ({ ...activity(id, 10), demands: [{ supplyId: 's', amount: 1 }] })), priorityOrder: ['a', 'b'] })
    expect(solve(value).placements.map(item => item.start)).toEqual([0, 5])
  })

  test('half-open occupation releases capacity exactly at its end', () => {
    const value = problem({ supplies: [{ id: 's', title: 's', segments: [{ start: 0, end: 100, capacity: 1 }] }], activities: ['a', 'b'].map(id => ({ ...activity(id), demands: [{ supplyId: 's', amount: 1 }] })), priorityOrder: ['a', 'b'] })
    expect(solve(value).placements.map(item => [item.start, item.end])).toEqual([[0, 5], [5, 10]])
  })

  test('a huge horizon is scanned at event points rather than at each second', () => {
    const end = 1_000_000_000_000
    const value = problem({ horizon: { start: 0, end }, supplies: [{ id: 's', title: 's', segments: [{ start: end - 10, end, capacity: 1 }] }], activities: [{ ...activity('a'), demands: [{ supplyId: 's', amount: 1 }] }] })
    const result = solve(value, 2)
    expect(result.status).toBe('feasible')
    expect(result.placementChecks).toBe(2)
    expect(result.placements[0]?.start).toBe(end - 10)
  })

  test('budget exhaustion retains partial placement but never complete metrics', () => {
    const value = problem({ activities: [activity('a'), activity('b')], priorityOrder: ['a', 'b'] })
    const result = solve(value, 1)
    expect(result.status).toBe('unknown')
    expect(result.issues[0]?.code).toBe('budget_exhausted')
    expect(result.placements).toHaveLength(1)
    expect(result.metrics).toBeNull()
  })

  test('no heuristic slot is unknown, not a claim of proved infeasibility', () => {
    const value = problem({ activities: [{ ...activity('a'), latestFinish: 3 }] })
    const result = solve(value)
    expect(result.status).toBe('unknown')
    expect(result.issues[0]?.code).toBe('no_slot_found')
  })
})

describe('actuals and independent checking', () => {
  test('past history is retained, started capacity counted once and future work waits', () => {
    const value = problem({ asOf: 5, supplies: [{ id: 's', title: 's', segments: [{ start: 5, end: 100, capacity: 1 }] }], activities: [
      { ...activity('done', 90), demands: [{ supplyId: 's', amount: 1 }], progress: { kind: 'completed', actualStart: 0, actualFinish: 3 } },
      { ...activity('started', 30), demands: [{ supplyId: 's', amount: 1 }], progress: { kind: 'started', actualStart: 3, asOf: 5, remainingSeconds: 2 } },
      { ...activity('next', 2), demands: [{ supplyId: 's', amount: 1 }] },
    ], priorityOrder: ['next', 'started', 'done'] })
    const result = solve(value)
    expect(result.status).toBe('feasible')
    expect(result.placements.map(item => [item.start, item.end])).toEqual([[0, 3], [3, 7], [7, 9]])
  })

  test('unknown remaining work stays unresolved and stale progress frames fail', () => {
    const value = problem({ asOf: 5, activities: [{ ...activity('a'), progress: { kind: 'started', actualStart: 0, asOf: 5, remainingSeconds: null } }] })
    expect(solve(value).status).toBe('unknown')
    expect(checkCandidate(value, [{ activityId: 'a', kind: 'started', start: 0, end: 10 }]).status).toBe('unknown')
    value.activities[0]!.progress = { kind: 'started', actualStart: 0, asOf: 4, remainingSeconds: 2 }
    expect(solve(value).status).toBe('invalid')
  })

  test('out-of-sequence actual progress is unsupported rather than rewritten', () => {
    const value = problem({ asOf: 6, activities: [
      { ...activity('a'), progress: { kind: 'completed', actualStart: 0, actualFinish: 5 } },
      { ...activity('b'), progress: { kind: 'started', actualStart: 4, asOf: 6, remainingSeconds: 3 } },
    ], priorityOrder: ['a', 'b'], precedences: [{ predecessorId: 'a', successorId: 'b', lagSeconds: 0 }] })
    expect(solve(value).status).toBe('unsupported')
    expect(solve(value).issues[0]?.code).toBe('out_of_sequence_progress')
  })

  test('the checker catches duration, history, capacity and precedence violations', () => {
    const value = problem({ supplies: [{ id: 's', title: 's', segments: [{ start: 0, end: 100, capacity: 1 }] }], activities: ['a', 'b'].map(id => ({ ...activity(id), demands: [{ supplyId: 's', amount: 1 }] })), priorityOrder: ['a', 'b'], precedences: [{ predecessorId: 'a', successorId: 'b', lagSeconds: 1 }] })
    const checked = checkCandidate(value, [{ activityId: 'a', start: 0, end: 4, kind: 'planned' }, { activityId: 'b', start: 0, end: 5, kind: 'planned' }])
    expect(checked.status).toBe('violated')
    expect(checked.issues.map(item => item.code)).toContain('duration_violation')
    expect(checked.issues.map(item => item.code)).toContain('capacity_violation')
    expect(checked.issues.map(item => item.code)).toContain('precedence_violation')
  })

  test('large count sums cannot round back into a feasible resource limit', () => {
    const value = problem({ supplies: [{ id: 's', title: 's', segments: [{ start: 0, end: 100, capacity: Number.MAX_SAFE_INTEGER }] }], activities: [ { ...activity('a'), demands: [{ supplyId: 's', amount: Number.MAX_SAFE_INTEGER }] }, { ...activity('b'), demands: [{ supplyId: 's', amount: 1 }] } ], priorityOrder: ['a', 'b'] })
    expect(checkCandidate(value, [{ activityId: 'a', start: 0, end: 5, kind: 'planned' }, { activityId: 'b', start: 0, end: 5, kind: 'planned' }]).status).toBe('violated')
    expect(solve(value).placements.map(item => item.start)).toEqual([0, 5])
  })
})

describe('strict profile and metric boundaries', () => {
  test('missing references, cycles, priority duplicates and overlapping windows are invalid', () => {
    const value = problem()
    expect(checkPlanningProblem({ ...value, precedences: [{ predecessorId: 'missing', successorId: 'a', lagSeconds: 0 }] }).status).toBe('invalid')
    expect(checkPlanningProblem({ ...value, precedences: [{ predecessorId: 'a', successorId: 'a', lagSeconds: 0 }] }).status).toBe('invalid')
    expect(checkPlanningProblem({ ...value, priorityOrder: ['a', 'a'] }).status).toBe('invalid')
    expect(checkPlanningProblem({ ...value, supplies: [{ id: 's', title: 's', segments: [{ start: 0, end: 8, capacity: 1 }, { start: 7, end: 9, capacity: 2 }] }] }).status).toBe('invalid')
  })

  test('unsupported profiles and extra fields are explicit errors', () => {
    expect(scheduleProblem({ ...problem(), profile: 'working-time' }, { maxPlacementChecks: 1 }).status).toBe('unsupported')
    expect(scheduleProblem({ ...problem(), arbitraryScript: 'return 1' }, { maxPlacementChecks: 1 }).status).toBe('invalid')
    expect(scheduleProblem(problem(), { maxPlacementChecks: 0 }).status).toBe('invalid')
    expect(checkPlanningProblem({ ...problem(), horizon: { start: 0, end: Number.MAX_SAFE_INTEGER + 1 } }).status).toBe('invalid')
  })

  test('a milestone can occur at the horizon end but cannot demand capacity', () => {
    const value = problem({ activities: [activity('a', 0, 100)] })
    expect(solve(value).placements[0]).toEqual({ activityId: 'a', start: 100, end: 100, kind: 'planned' })
    expect(checkPlanningProblem({ ...value, activities: [{ ...value.activities[0], demands: [{ supplyId: 's', amount: 1 }] }] }).status).toBe('invalid')
  })

  test('aggregate metrics fail visibly beyond exact safe integer range', () => {
    const value = problem({ horizon: { start: 0, end: Number.MAX_SAFE_INTEGER }, activities: [{ ...activity('a', Number.MAX_SAFE_INTEGER), due: 0, tardinessWeight: Number.MAX_SAFE_INTEGER }] })
    expect(solve(value).status).toBe('invalid')
    expect(solve(value).issues[0]?.code).toBe('metric_range')
  })

  test('objective direction and tolerance are applied to raw metrics', () => {
    const value = problem()
    const left = calculateMetrics(value, [{ activityId: 'a', start: 0, end: 5, kind: 'planned' }])
    const right = calculateMetrics(value, [{ activityId: 'a', start: 1, end: 6, kind: 'planned' }])
    const near = { objectives: [{ metric: 'makespan', direction: 'minimize', tolerance: 1 }] } as const
    expect(compareMetrics(near, left, right)).toBe(0)
    expect(dominatesMetrics(near, left, right)).toBe(false)
    expect(compareMetrics({ objectives: [{ metric: 'makespan', direction: 'maximize', tolerance: 0 }] }, left, right)).toBe(1)
  })
})
