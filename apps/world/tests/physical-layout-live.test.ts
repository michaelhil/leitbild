import { describe, expect, test } from 'bun:test'
import { embeddedViewEnvelopeSchema, newWorkspaceId } from '@leitbild/contracts'
import { objectIdSchema } from '../src/core/model/ids.ts'
import { isoTimestampSchema } from '../src/core/model/time.ts'
import type { Observation } from '../src/core/observation/model.ts'
import type { AlertRow } from '../src/features/displays/alerts/rows.ts'
import type { VignetteValue } from '../src/features/displays/compose/model.ts'
import { createLayoutLiveSession, layoutLiveFrozen, type LayoutLiveRoutes, type LayoutLiveSnapshot } from '../src/ui/physical-layout/client.ts'
import { layoutInspectionEnvelope, layoutInspectionExpected, layoutInspectionMessageSchema } from '../src/ui/physical-layout/inspection.ts'
import { layoutLiveExpectedSchema, layoutLiveResponseSchema, type LayoutLiveResponse } from '../src/ui/physical-layout/read-model.ts'
import { admitPhysicalLiveStamp, physicalLayoutStatusSummary, physicalSubjectKey, physicalSubjectStatus, physicalSubjectStyle, type PhysicalLayoutSubject } from '../src/ui/physical-layout/status.ts'
import { changePhysicalLayoutView, initialPhysicalLayoutView } from '../src/ui/physical-layout/view.ts'

const expected = layoutLiveExpectedSchema.parse({ runId: 'run-layout', layoutObjectId: 'layout:one', objectId: 'plant:one', packId: 'process-plant', modelDigest: 'a'.repeat(64), revision: 'physical-two-room-r1' })
const at = isoTimestampSchema.parse('2026-10-24T12:00:00.000Z')
const subject: PhysicalLayoutSubject = { packId: expected.packId, objectId: expected.objectId, elementId: 'pump', label: 'Feed pump' }
const value: VignetteValue = { ref: 'plant:one#running', label: 'PWR · Feed pump · Running', quantity: 'state', unit: '', valueType: 'boolean', thresholds: [], series: null, states: [{ value: 'true', label: 'Running', active: true }, { value: 'false', label: 'Stopped' }] }
const observation: Observation = { ref: value.ref, at, clock: 'simulation', value: true, quality: 'good', priority: 'none' }
const reading = (patch: Partial<LayoutLiveResponse['scope']> = {}): LayoutLiveResponse => ({
  scope: { ...expected, epoch: 'owner-epoch-1', sequence: 10, ...patch }, acquiredAt: at,
  sample: { at: { at, clock: 'simulation', paused: true }, observations: [observation], alerts: [], entities: {}, maps: {}, slots: {} },
  subjects: [{ elementId: subject.elementId, label: subject.label, values: [value], word: null, devices: [] }],
})
const alert = (id: string, element = 'pump', state: AlertRow['state'] = 'active-unack'): AlertRow => ({
  key: `plant:one|${id}`, objectId: objectIdSchema.parse('plant:one'), objectLabel: 'PWR', packId: 'process-plant', categoryId: 'plants',
  group: { objectId: objectIdSchema.parse('plant:one') }, priority: 'alarm', state, raised: { at, clock: 'simulation' },
  alert: { id, kind: 'process-alarm', message: 'Pump fault', severity: 'critical', priority: 'alarm', raisedAt: at, acknowledged: state === 'active-ack', subject: { element }, ...(state === 'returned-unack' ? { returned: true as const } : {}) },
})
const settle = async (): Promise<void> => { for (let index = 0; index < 20; index += 1) await Promise.resolve() }

const harness = (overrides: Partial<LayoutLiveRoutes> = {}, demand: { readonly subjectIds?: ReadonlyArray<string>; readonly requiredSubjectId?: string } = {}) => {
  let wall = 0
  const scheduled: Array<{ delay: number; callback: () => void; cancelled: boolean }> = []
  const calls: string[] = []
  const states: LayoutLiveSnapshot[] = []
  let nextReading = reading()
  let epoch = 'owner-epoch-1'
  const session = createLayoutLiveSession({
    expected, ...demand, onChange: state => states.push(state), wallNow: () => wall,
    routes: {
      presence: async () => { calls.push('presence'); return { loaded: true, displayEpoch: epoch, snapshotSeq: 10 } },
      read: async () => { calls.push('read'); return nextReading }, ...overrides,
    },
    schedule: (callback, delay) => { const scheduledTimer = { delay, callback, cancelled: false }; scheduled.push(scheduledTimer); return () => { scheduledTimer.cancelled = true } },
  })
  const advance = async (): Promise<void> => {
    const next = scheduled.find(timer => !timer.cancelled)
    if (next === undefined) throw new Error('No live timer was scheduled')
    next.cancelled = true
    wall += next.delay
    next.callback()
    await settle()
  }
  return { session, calls, states, advance, last: () => states.at(-1)!, setReading: (next: LayoutLiveResponse) => { nextReading = next }, setEpoch: (next: string) => { epoch = next }, now: () => wall }
}

describe('layout acquisition stays inside the real owner scope', () => {
  test('reads no unloaded Run, and does not turn demand into a load action', async () => {
    const run = harness({ presence: async () => ({ loaded: false, displayEpoch: null, snapshotSeq: null }) })
    run.session.start(); await settle()
    expect(run.last().phase).toBe('inactive')
    expect(run.calls).toEqual([])
    run.session.close()
  })

  test('paused simulation time remains fresh after successful wall-time acquisition', async () => {
    const run = harness(); run.session.start(); await settle()
    expect(run.calls).toEqual(['presence', 'read'])
    expect(layoutLiveFrozen(run.last(), run.now())).toBe(false)
    await run.advance()
    expect(run.last().latest?.sample.at.at).toBe(at)
    expect(layoutLiveFrozen(run.last(), run.now())).toBe(false)
    expect(layoutLiveFrozen(run.last(), run.now() + 5_001)).toBe(true)
    run.session.close()
  })

  test('rejects wrong Run/model/plant/Pack/revision replies and out-of-order sequences', async () => {
    for (const patch of [{ runId: 'run-another' as typeof expected.runId }, { modelDigest: 'b'.repeat(64) }, { objectId: objectIdSchema.parse('plant:two') }, { packId: 'another-pack' }, { revision: 'another-revision' }]) {
      const run = harness(); run.setReading(reading(patch)); run.session.start(); await settle()
      expect(run.last().phase).toBe('failed')
      expect(run.last().latest).toBeNull()
      run.session.close()
    }
    const run = harness(); run.session.start(); await settle(); run.setReading(reading({ sequence: 9 })); await run.advance()
    expect(run.last().phase).toBe('failed')
    expect(run.last().latest?.scope.sequence).toBe(10)
    expect(layoutLiveFrozen(run.last(), run.now())).toBe(true)
    run.session.close()
  })

  test('an epoch change is confirmed through presence and reacquired; lower time never declares a reset', async () => {
    const run = harness(); run.session.start(); await settle()
    const reset = reading({ epoch: 'owner-epoch-2', sequence: 1 })
    run.setReading({ ...reset, sample: { ...reset.sample, at: { ...reset.sample.at, at: '2026-10-24T00:00:00.000Z' } } })
    await run.advance()
    expect(run.last().phase).toBe('connecting')
    expect(run.last().latest?.scope.epoch).toBe('owner-epoch-1')
    run.setEpoch('owner-epoch-2'); await run.advance()
    expect(run.calls.slice(-2)).toEqual(['presence', 'read'])
    expect(run.last().latest?.scope.epoch).toBe('owner-epoch-2')
    expect(run.last().phase).toBe('live')
    run.session.close()
  })

  test('hidden and replaced views abort demand and discard late replies even when a transport ignores abort', async () => {
    let answer: ((value: unknown) => void) | undefined
    const run = harness({ read: async () => new Promise(resolve => { answer = resolve }) })
    run.session.start(); await settle(); run.session.setVisible(false)
    answer!(reading()); await settle()
    expect(run.last().phase).toBe('suspended')
    expect(run.last().latest).toBeNull()
    expect(run.calls).toEqual(['presence'])
    run.session.close()
  })

  test('strict response validation rejects cross-owner metadata, duplicate subjects and hidden arbitrary data', () => {
    expect(layoutLiveResponseSchema.parse(reading()).subjects[0]?.values[0]?.states?.[0]?.label).toBe('Running')
    const response = reading()
    expect(() => layoutLiveResponseSchema.parse({ ...response, subjects: [...response.subjects, ...response.subjects] })).toThrow('Duplicate layout live subject')
    expect(() => layoutLiveResponseSchema.parse({ ...response, sample: { ...response.sample, alerts: [{ ...alert('x'), packId: 'foreign-pack' }] } })).toThrow('another owner')
    expect(() => layoutLiveResponseSchema.parse({ ...response, sample: { ...response.sample, alerts: [{ ...alert('x'), state: 'active-ack' }] } })).toThrow('owner lifecycle')
    expect(() => layoutLiveResponseSchema.parse({ ...response, extraHiddenPlant: { private: true } })).toThrow()
  })

  test('a partial or extra subject set cannot pass as a live map, and a missing requested card refuses explicitly', async () => {
    const incomplete = harness({}, { subjectIds: ['pump', 'turbine'] })
    incomplete.session.start(); await settle()
    expect(incomplete.last().phase).toBe('failed')
    expect(incomplete.last().failure).toContain('complete admitted subject set')
    expect(incomplete.last().latest).toBeNull()
    incomplete.session.close()
    const extra = harness({}, { subjectIds: ['pump'] })
    const response = reading()
    extra.setReading({ ...response, subjects: [...response.subjects, { ...response.subjects[0]!, elementId: 'turbine' }] })
    extra.session.start(); await settle()
    expect(extra.last().phase).toBe('failed')
    expect(extra.last().failure).toContain('complete admitted subject set')
    extra.session.close()
    const card = harness({}, { requiredSubjectId: 'turbine' })
    card.session.start(); await settle()
    expect(card.last().failure).toContain('requested component is absent')
    expect(card.last().latest).toBeNull()
    card.session.close()
    const complete = harness({}, { subjectIds: ['pump'], requiredSubjectId: 'pump' })
    complete.session.start(); await settle()
    expect(complete.last().phase).toBe('live')
    complete.session.close()
  })
})

describe('layout status is the owner display meaning, not another alarm system', () => {
  test('shares declared words, retains acknowledged active and returned lifecycles, and freezes without current alarm tint', () => {
    const input = { subject, values: [value], observations: [observation] }
    const rows = [alert('a', 'pump', 'active-ack'), alert('b', 'pump', 'returned-unack')]
    const live = physicalSubjectStatus(input, rows, false)
    expect([live.word, live.priority, live.active, live.returned, live.census.total, live.census.unacknowledged]).toEqual(['Running', 'alarm', 1, 1, 2, 1])
    expect(physicalSubjectStyle(live, 'day').color).not.toBeNull()
    const retained = physicalSubjectStatus(input, rows, true)
    expect([retained.word, retained.priority, retained.quality, retained.census.total]).toEqual([null, null, 'stale', 2])
    expect(physicalSubjectStyle(retained, 'day')).toEqual({ color: null, emphasis: 0 })
  })

  test('does not invent green-normal from missing readings, expected alarms or a numeric lead value', () => {
    const expectedAlert = { ...alert('expected'), expected: { after: 'Turbine trip' } }
    const normal = physicalSubjectStatus({ subject, values: [value], observations: [observation] }, [expectedAlert], false)
    expect(normal.priority).toBe('none')
    expect(normal.census.expected).toBe(1)
    expect(physicalSubjectStatus({ subject, values: [value], observations: [] }, [], false).quality).toBe('bad')
    expect(physicalSubjectStatus({ subject, values: [], observations: [] }, [], false).quality).toBe('not-observed')
    const numeric = { ...value, quantity: 'flow' as const, unit: 'kg/s', valueType: 'number' as const }
    expect(physicalSubjectStatus({ subject, values: [numeric], observations: [observation] }, [], false).word).toBeNull()
  })

  test('counts one owner lifecycle separately from many casings and keeps hidden/unlocated alarms', () => {
    const rows = [alert('one'), alert('one'), alert('two', 'unplaced')]
    const summary = physicalLayoutStatusSummary({ owners: [subject], alerts: rows, occurrences: [
      { id: 'casing-a', subjects: [subject], disposition: 'installed' }, { id: 'casing-b', subjects: [subject], disposition: 'installed' },
      { id: 'proposed', subjects: [{ ...subject, elementId: 'unplaced' }], disposition: 'proposed' },
    ], visibleOccurrenceIds: new Set(['casing-a']) })
    expect([summary.census.total, summary.affectedSubjects, summary.affectedLocations, summary.hiddenLocations, summary.unlocatedAlerts, summary.unlocatedSubjects]).toEqual([2, 2, 2, 1, 1, 1])
    const another = { ...subject, objectId: 'plant:two' }
    expect(physicalSubjectKey(subject)).not.toBe(physicalSubjectKey(another))
    expect(physicalSubjectStatus({ subject: another, values: [], observations: [] }, rows, false).census.total).toBe(0)
    expect(() => physicalLayoutStatusSummary({ owners: [subject], alerts: [alert('one'), { ...alert('one'), state: 'active-ack' }], occurrences: [], visibleOccurrenceIds: new Set() })).toThrow('Conflicting lifecycle')
  })

  test('an unconfirmed epoch and old sequence cannot replace the admitted sample', () => {
    const stamp = { scope: expected, epoch: 'one', sequence: 10, receivedWallMs: 0 }
    expect(() => admitPhysicalLiveStamp(expected, 'one', stamp, { ...stamp, epoch: 'two' })).toThrow('not been confirmed')
    expect(() => admitPhysicalLiveStamp(expected, 'one', stamp, { ...stamp, sequence: 9 })).toThrow('older')
  })
})

describe('physical inspection and local view controls', () => {
  test('a 2D plan returns to a real level and separation changes only the view', () => {
    const levels = [{ id: 'lower', label: 'Condenser floor', elevation: 0 }, { id: 'operating', label: 'Operating floor', elevation: 15 }]
    const initial = initialPhysicalLayoutView(levels)
    const all = changePhysicalLayoutView(initial, { mode: '3d', levelId: 'all', separation: 15 }, levels)
    expect(changePhysicalLayoutView(all, { mode: '2d' }, levels)).toEqual({ ...initial })
    expect(() => changePhysicalLayoutView(initial, { levelId: 'unknown' }, levels)).toThrow('Unknown layout level')
    expect(() => changePhysicalLayoutView(initial, { separation: -1 }, levels)).toThrow('between 0 and 30')
  })

  test('the faceplate envelope retains exact owner/model/layout scope and validates close/size messages', () => {
    const { runId, ...state } = expected
    const envelope = layoutInspectionEnvelope({ workspaceId: newWorkspaceId(), runId, state: { ...state, elementId: 'pump', label: 'Feed pump' } })
    expect(layoutInspectionExpected(envelope).expected).toEqual(expected)
    expect(() => layoutInspectionExpected(embeddedViewEnvelopeSchema.parse({ ...envelope, subject: { ...envelope.subject, type: 'world.object' } }))).toThrow('Simulation Run')
    expect(layoutInspectionMessageSchema.safeParse({ type: 'world:layout-inspection-size', layoutObjectId: expected.layoutObjectId, elementId: 'pump', height: 400 }).success).toBe(true)
    expect(layoutInspectionMessageSchema.safeParse({ type: 'world:layout-inspection-close', layoutObjectId: expected.layoutObjectId, elementId: 'pump', returnFocus: true, operate: true }).success).toBe(false)
  })
})
