import { describe, expect, test } from 'bun:test'
import { geoPointFromLonLat } from '../../../core/model/index.ts'
import { einsatzCommandIds as ids, einsatzQueryIds } from '../capabilities.ts'
import { low, middle, templates, top, types } from '../fixtures/engine-harness.ts'
import { isoAt, lonLat, openRun, taskItem, unitItem, type OpenRun } from '../fixtures/run-harness.ts'
import { einsatzRuntimeId } from '../ids.ts'
import type { RecommendAnswer as Recommendation } from '../recommendation-schema.ts'

/**
 * Job chains on a real Run with its clock running: every command goes
 * through the Run's Capability path and reads the state the clock has
 * brought the runtime to.
 */

const point = (east: number, north = 0) => ({ type: 'Point', coordinates: lonLat(east, north) })

const fleet = [
  unitItem('c1', types.roadCarrier, lonLat(0)),
  unitItem('c2', types.roadCarrier, lonLat(0, 0.001)),
  unitItem('d1', types.directCarrier, lonLat(0)),
  unitItem('s1', types.publicSite, lonLat(0.02)),
  unitItem('s2', types.publicSite, lonLat(-0.02)),
  taskItem('low1', templates.load, lonLat(0.01), { [low]: 1 }),
  taskItem('mid1', templates.load, lonLat(0.015), { [middle]: 1 }),
  taskItem('top1', templates.load, lonLat(0.03), { [top]: 1 }),
  taskItem('far1', templates.load, lonLat(-0.015), { [low]: 1 }),
]

const withRun = async (body: (run: OpenRun) => Promise<void>): Promise<void> => {
  const run = await openRun({ items: fleet })
  try { await body(run) } finally { await run.close() }
}

const accepted = async (run: OpenRun, capabilityId: string, input: unknown): Promise<void> => {
  const result = await run.invoke(capabilityId, input)
  if (!result.ok) throw new Error(`${capabilityId} refused: ${result.reason}`)
}

/** The stop an order created, as its caller learns it: the unit's last order names it. */
const createdStep = (run: OpenRun, unitId: string): string => {
  const stepId = run.unit(unitId).lastAction?.stepId
  if (stepId === undefined) throw new Error(`${unitId} names no step in its last order`)
  return stepId
}

const steps = (run: OpenRun, unitId: string) => run.unit(unitId).orders.map(step => [step.id, step.kind, step.state])
const pointOf = (run: OpenRun, id: string) => run.object(id)?.spatial.position?.point
const healthy = (run: OpenRun) => expect(run.connection.health?.().map(entry => entry.state)).toEqual(['ready'])

describe('Einsatz job chains on a running clock', () => {
  test('an order after starts a free unit at once and waits behind a busy one; the caller learns each stop id; recommend proposes another unit', async () => {
    await withRun(async run => {
      await accepted(run, ids.order, { units: ['c1'], stops: [{ taskId: 'low1' }], when: 'after' })
      expect(run.unit('c1')).toMatchObject({ phase: 'mobilizing', taskId: 'low1', lastAction: { verb: 'send', target: 'low1' } })
      expect(createdStep(run, 'c1')).toBe('step-1')

      run.forward(1_000)
      await accepted(run, ids.order, { units: ['c1'], stops: [{ taskId: 'mid1' }], when: 'after' })
      expect(createdStep(run, 'c1')).toBe('step-2')
      expect(steps(run, 'c1')).toEqual([['step-1', 'serve', 'active'], ['step-2', 'serve', 'queued']])
      expect(run.task('mid1').coverage.loads).toEqual([{ classId: middle, waiting: 1, covered: 0 }])
      const answer = await run.query<Recommendation>(einsatzQueryIds.recommend, { taskId: 'mid1' })
      expect(answer.proposal?.units.map(entry => entry.unitId) ?? []).not.toContain('c1')
      healthy(run)
    })
  })

  test('removing a queued stop shortens the plan; removing the active one releases it and starts the next; an order is undone by its command', async () => {
    await withRun(async run => {
      await accepted(run, ids.order, { units: ['c1'], stops: [{ taskId: 'low1' }] })
      await accepted(run, ids.order, { units: ['c1'], stops: [{ point: point(0.005, 0.005) }], when: 'after' })
      await accepted(run, ids.order, { units: ['c1'], stops: [{ taskId: 'mid1' }], when: 'after' })
      run.forward(3_000)
      await accepted(run, ids.stopRemove, { unitId: 'c1', stopId: 'step-2' })
      expect(steps(run, 'c1')).toEqual([['step-1', 'serve', 'active'], ['step-3', 'serve', 'queued']])

      run.forward(2_000)
      await accepted(run, ids.stopRemove, { unitId: 'c1', stopId: 'step-1' })
      expect(run.unit('c1')).toMatchObject({ phase: 'mobilizing', taskId: 'mid1', lastAction: { verb: 'send', target: 'mid1', by: 'standing-order:chain', stepId: 'step-3' } })
      expect(run.task('low1')).toMatchObject({ alerts: [{ code: 'work_returned' }], coverage: { loads: [{ classId: low, waiting: 1, covered: 0 }] } })

      const ordered = await run.invoke(ids.order, { units: ['c2'], stops: [{ taskId: 'top1' }] })
      expect(run.task('top1').coverage.loads).toEqual([{ classId: top, waiting: 1, covered: 1 }])
      await accepted(run, ids.undo, { unitId: 'c2', commandId: ordered.commandId })
      expect(run.unit('c2')).toMatchObject({ phase: 'available', orders: [], atBase: true })
      expect(run.task('top1').coverage.loads).toEqual([{ classId: top, waiting: 1, covered: 0 }])
      expect((await run.refusal(ids.stopRemove, { unitId: 'c2', stopId: 'step-1' })).code).toBe('step_not_found')
      healthy(run)
    })
  })

  test('a step is skipped under an alert when its task is closed or its site stops accepting, and the chain goes on', async () => {
    await withRun(async run => {
      await accepted(run, ids.order, { units: ['c1'], stops: [{ taskId: 'low1' }] })
      await accepted(run, ids.order, { units: ['c1'], stops: [{ siteId: 's2' }], when: 'after' })
      await accepted(run, ids.order, { units: ['c1'], stops: [{ taskId: 'far1' }], when: 'after' })
      await accepted(run, ids.order, { units: ['c2'], stops: [{ taskId: 'mid1' }] })
      await accepted(run, ids.order, { units: ['c2'], stops: [{ taskId: 'top1' }], when: 'after' })
      run.forward(10_000)
      await accepted(run, ids.taskClose, { taskId: 'top1', reason: 'Withdrawn' })
      expect(run.unit('c2')).toMatchObject({ taskId: 'mid1', orders: [{ id: 'step-1' }], alerts: [{ code: 'step_skipped', message: 'Skipped TOP1 (closed)' }] })

      await accepted(run, ids.siteSet, { siteId: 's2', accepting: false })
      run.forward(60_000)
      await run.settle()
      expect(run.unit('c1').alerts).toMatchObject([{ code: 'step_skipped', message: 'Skipped S2 (S2 is not accepting)' }])
      expect(run.unit('c1')).toMatchObject({ phase: 'transporting', siteId: 's1', lastAction: { verb: 'deliver', by: 'standing-order:deliver' }, orders: [{ kind: 'deliver', state: 'active', by: 'standing-order:deliver' }, { kind: 'serve', target: { taskId: 'far1' }, state: 'queued' }] })
      run.forward(300_000)
      await run.settle()
      expect(run.task('far1').pickedUp).toEqual({ [low]: 1 })
      healthy(run)
    })
  })

  test('capacity is refused with the reason, and a delivery queued first makes room', async () => {
    await withRun(async run => {
      await accepted(run, ids.order, { units: ['d1'], stops: [{ taskId: 'low1' }] })
      expect(await run.refusal(ids.order, { units: ['d1'], stops: [{ taskId: 'mid1' }], when: 'after' })).toEqual({ code: 'unit_loaded', reason: 'unit_loaded: D1 will have 1 person on board by then; add a delivery stop first' })
      await accepted(run, ids.order, { units: ['d1'], stops: [{ siteId: 's1' }], when: 'after' })
      await accepted(run, ids.order, { units: ['d1'], stops: [{ taskId: 'mid1' }], when: 'after' })
      expect(steps(run, 'd1')).toEqual([['step-1', 'serve', 'active'], ['step-2', 'deliver', 'queued'], ['step-3', 'serve', 'queued']])
      run.forward(120_000)
      await run.settle()
      expect(run.unit('s1').received).toEqual({ [low]: 1 })
      expect(run.task('mid1').pickedUp).toEqual({ [middle]: 1 })
      healthy(run)
    })
  })

  test('a divert removes only the current step; the queued chain follows the new task', async () => {
    await withRun(async run => {
      await accepted(run, ids.order, { units: ['c1'], stops: [{ taskId: 'low1' }] })
      await accepted(run, ids.order, { units: ['c1'], stops: [{ point: point(0, 0.01) }], when: 'after' })
      run.forward(5_000)
      await accepted(run, ids.order, { units: ['c1'], stops: [{ taskId: 'top1' }], when: 'now', drops: 'low1' })
      expect(steps(run, 'c1')).toEqual([['step-3', 'serve', 'active'], ['step-2', 'move', 'queued']])
      expect(run.task('low1').alerts).toMatchObject([{ code: 'work_returned' }])
      expect(createdStep(run, 'c1')).toBe('step-3')
      healthy(run)
    })
  })

  test('a plan stays within its limit, and a Run restored with a delivery in front of a full plan carries on', async () => {
    const items = [unitItem('c1', types.roadCarrier, lonLat(0)), unitItem('g1', types.pairServer, lonLat(0)), unitItem('s1', types.publicSite, lonLat(0.02)), taskItem('here', templates.load, lonLat(0), { [low]: 1 })]
    const run = await openRun({ items })
    try {
      await accepted(run, ids.order, { units: ['g1'], stops: [{ point: point(0.5) }] })
      for (let index = 1; index < 20; index++) await accepted(run, ids.order, { units: ['g1'], stops: [{ point: point(0.5, 0.001 * index) }], when: 'after' })
      expect(await run.refusal(ids.order, { units: ['g1'], stops: [{ point: point(0.4) }], when: 'after' })).toEqual({ code: 'chain_full', reason: 'chain_full: G1 already holds 20 stops; remove one first' })
      expect(run.unit('g1').orders).toHaveLength(20)

      await accepted(run, ids.order, { units: ['c1'], stops: [{ taskId: 'here' }] })
      for (let index = 1; index < 20; index++) await accepted(run, ids.order, { units: ['c1'], stops: [{ point: point(-0.01, 0.001 * index) }], when: 'after' })
      run.forward(6_000)
      await run.settle()
      expect(run.unit('c1').orders).toHaveLength(20)
      expect(run.unit('c1')).toMatchObject({ phase: 'transporting', siteId: 's1' })
      expect(run.unit('c1').orders[0]).toMatchObject({ kind: 'deliver', state: 'active', by: 'standing-order:deliver' })
      healthy(run)

      const checkpoint = await run.run.checkpointForCopy()
      const restored = await openRun({ items, restore: { snapshot: checkpoint.snapshot, runtimeState: checkpoint.runtimeStates[einsatzRuntimeId] } })
      try {
        expect(restored.unit('c1')).toEqual(run.unit('c1'))
        const targetMs = run.nowMs() + 120_000
        for (const copy of [run, restored]) {
          await copy.run.setClock({ paused: true })
          await copy.run.runMaximumPace(isoAt(targetMs), { shouldStop: () => false })
        }
        expect(restored.unit('c1')).toEqual(run.unit('c1'))
        expect(restored.unit('s1').received).toEqual({ [low]: 1 })
        healthy(restored)
      } finally { await restored.close() }
    } finally { await run.close() }
  })

  test('a chain across sites: pick up at one task, deliver at the second site, then serve another task', async () => {
    await withRun(async run => {
      await accepted(run, ids.order, { units: ['c1'], stops: [{ taskId: 'low1' }] })
      await accepted(run, ids.order, { units: ['c1'], stops: [{ siteId: 's2' }], when: 'after' })
      await accepted(run, ids.order, { units: ['c1'], stops: [{ taskId: 'far1' }], when: 'after' })
      expect(steps(run, 'c1')).toEqual([['step-1', 'serve', 'active'], ['step-2', 'deliver', 'queued'], ['step-3', 'serve', 'queued']])
      expect(run.task('far1').coverage.loads).toEqual([{ classId: low, waiting: 1, covered: 0 }])
      run.forward(170_000)
      await run.settle()
      expect(run.unit('s2').received).toEqual({ [low]: 1 })
      expect(run.unit('c1')).toMatchObject({ taskId: 'far1', orders: [{ id: 'step-3', state: 'active' }] })
      expect(run.task('far1').coverage.loads).toEqual([{ classId: low, waiting: 1, covered: 1 }])
      run.forward(300_000)
      await run.settle()
      expect(run.unit('s2').received).toEqual({ [low]: 2 })
      expect(run.unit('c1').orders).toEqual([])
      healthy(run)
    })
  })
})
