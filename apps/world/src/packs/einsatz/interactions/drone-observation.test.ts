import { describe, expect, test } from 'bun:test'
import { nowIso, type IsoTimestamp, type ObjectId, type OperationalObject, type SimulationRunEvent } from '../../../core/model/index.ts'
import { droneObservationSignal } from '../../drone/interactions.ts'
import { einsatzQueryIds } from '../capabilities.ts'
import { low, templates, types } from '../fixtures/engine-harness.ts'
import { observerObject } from '../fixtures/cross-pack.ts'
import { lonLat, openRun, taskItem, unitItem, type OpenRun } from '../fixtures/run-harness.ts'
import type { Situation } from '../situation/schema.ts'
import { judgeObservation } from './drone-observation.ts'

/**
 * Decision 3 (plan D.5): the Drone Pack's reconnaissance observation of an
 * Einsatz task is recorded on the task, shown on its call row in
 * `world.einsatz.situation`, and noticed in the Run, as the cut Pack's link
 * did. The signal is the Drone Pack's own, built by its own function.
 */

const observer = observerObject('drone:d1', 'D-1')

const withRun = async (others: ReadonlyArray<OperationalObject>, body: (run: OpenRun) => Promise<void>): Promise<void> => {
  const run = await openRun({
    items: [unitItem('c1', types.roadCarrier, lonLat(0)), taskItem('t1', templates.load, lonLat(0.01), { [low]: 1 })],
    paused: true,
    others,
  })
  try { await body(run) } finally { await run.close() }
}

const observe = async (run: OpenRun, input: { readonly observerId?: string; readonly targetId: string; readonly observedAtMs?: number; readonly sourceId?: string }): Promise<void> => {
  const signal = droneObservationSignal({
    simulationRunId: 'run-einsatz-open',
    at: nowIso(),
    observedAtMs: input.observedAtMs ?? run.nowMs(),
    observerId: (input.observerId ?? observer.id) as ObjectId,
    targetId: input.targetId as ObjectId,
    sensorId: 'camera',
  })
  const sent = input.sourceId === undefined ? signal : { ...signal, source: { kind: 'object' as const, id: input.sourceId as ObjectId } }
  await run.run.publishInteractionSignal(sent, { source: 'simulator' })
  await run.settle()
}

const notices = (run: OpenRun) => run.journal
  .filter((event): event is Extract<SimulationRunEvent, { type: 'notification.emitted' }> => event.type === 'notification.emitted')
  .map(event => ({ title: event.notification.title, message: event.notification.message, severity: event.notification.severity }))

const healthy = (run: OpenRun) => expect(run.connection.health?.().map(entry => entry.state)).toEqual(['ready'])

describe('Einsatz drone observation', () => {
  test('a Drone observation of a task records who observed it and when, shows it on the call row and emits the notice', async () => {
    await withRun([observer], async run => {
      const atMs = run.nowMs()
      await observe(run, { targetId: 't1', observedAtMs: atMs })
      expect(run.task('t1').observed).toEqual({ by: 'D-1', atMs })
      const situation = await run.query<Situation>(einsatzQueryIds.situation, {})
      expect(situation.calls.find(call => call.id === 't1')!.observed).toEqual({ by: 'D-1', at: new Date(atMs).toISOString() })
      expect(notices(run)).toEqual([{ title: 'Observation recorded', message: 'D-1 observed T1', severity: 'notice' }])
      healthy(run)
    })
  })

  test('a later observation replaces the earlier one; the call row of a task never observed carries none', async () => {
    const second = observerObject('drone:d2', 'D-2', { east: 0.02 })
    await withRun([observer, second], async run => {
      const situation = await run.query<Situation>(einsatzQueryIds.situation, {})
      expect(situation.calls.find(call => call.id === 't1')!.observed).toBeUndefined()
      await observe(run, { targetId: 't1', observedAtMs: run.nowMs() })
      await observe(run, { observerId: second.id, targetId: 't1', observedAtMs: run.nowMs() + 60_000 })
      expect(run.task('t1').observed).toEqual({ by: 'D-2', atMs: run.nowMs() + 60_000 })
    })
  })

  test('an observation of a unit, by an object that did not send the signal, or with a malformed payload is not recorded, and its notice says why', async () => {
    await withRun([observer], async run => {
      await observe(run, { targetId: 'c1' })
      await observe(run, { targetId: 't1', sourceId: 'drone:other' })
      const malformed = { ...droneObservationSignal({ simulationRunId: 'run-einsatz-open', at: nowIso(), observedAtMs: run.nowMs(), observerId: observer.id, targetId: 't1' as ObjectId, sensorId: 'camera' }), payload: { targetId: 't1' } }
      await run.run.publishInteractionSignal(malformed, { source: 'simulator' })
      await run.settle()
      expect(run.task('t1').observed).toBeUndefined()
      expect(notices(run)).toEqual([
        { title: 'Observation not recorded', message: 'C1 is not a task; only a task records an observation', severity: 'warning' },
        { title: 'Observation not recorded', message: 'The reconnaissance observer is not available', severity: 'warning' },
        { title: 'Observation not recorded', message: 'The reconnaissance signal does not carry an observer, a target, a sensor and an observation time', severity: 'warning' },
      ])
      healthy(run)
    })
  })

  test('an observation of another Pack\'s object is not Einsatz\'s: no record and no notice', async () => {
    const other = observerObject('grid:substation', 'Substation', { packId: 'grid', east: 0.03 })
    await withRun([observer, other], async run => {
      await observe(run, { targetId: other.id })
      expect(notices(run)).toEqual([])
      healthy(run)
    })
  })

  test('in a Run with sides the observer\'s label is written on a task only when every side that sees the task sees the observer', async () => {
    await withRun([observer], async run => {
      const task = { ...run.object('t1')!, audience: ['blue'] } as OperationalObject
      const signal = droneObservationSignal({ simulationRunId: 'run-einsatz-open', at: nowIso() as IsoTimestamp, observedAtMs: 0, observerId: observer.id, targetId: task.id, sensorId: 'camera' })
      const judge = (watcher: OperationalObject) => judgeObservation(signal, id => [task, watcher].find(object => object.id === id)).kind
      expect(judge(observer)).toBe('refused')
      expect(judge({ ...observer, audience: ['red'] })).toBe('refused')
      expect(judge({ ...observer, audience: ['blue', 'red'] })).toBe('observed')
      expect(judge({ ...observer, audience: 'public' })).toBe('observed')
    })
  })
})
