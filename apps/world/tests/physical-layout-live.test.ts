import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { embeddedViewEnvelopeSchema, newWorkspaceId } from '@leitbild/contracts'
import { objectIdSchema } from '../src/core/model/ids.ts'
import { isoTimestampSchema } from '../src/core/model/time.ts'
import type { Observation } from '../src/core/observation/model.ts'
import type { AlertRow } from '../src/features/displays/alerts/rows.ts'
import type { VignetteValue } from '../src/features/displays/compose/model.ts'
import { createLayoutLiveSession, layoutLiveFrozen, type LayoutLiveRoutes, type LayoutLiveSnapshot } from '../src/ui/physical-layout/client.ts'
import { layoutInspectionContentRoom, layoutInspectionEnvelope, layoutInspectionExpected, layoutInspectionHostRoom, layoutInspectionMessageSchema, layoutInspectionSampleMessage, layoutInspectionSpaceMessage, layoutInspectionStateSchema, readHostedLayoutInspectionSample, readHostedLayoutInspectionSpace } from '../src/ui/physical-layout/inspection.ts'
import { layoutLiveExpectedSchema, layoutLiveResponseSchema, type LayoutLiveResponse } from '../src/ui/physical-layout/read-model.ts'
import { admitPhysicalLiveStamp, physicalLayoutStatusSummary, physicalSubjectKey, physicalSubjectStatus, physicalSubjectStyle, type PhysicalLayoutSubject } from '../src/ui/physical-layout/status.ts'
import { changePhysicalLayoutView, initialPhysicalLayoutView } from '../src/ui/physical-layout/view.ts'
import { valueRows } from '../src/ui/embed/vignette/value-rows.ts'
import { faceplateHeight } from '../src/ui/embed/vignette/popover.ts'
import { physicalExplorerFitPadding } from '../src/ui/physical-layout/explorer-viewport.ts'

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

  test('standalone status requires an owner word, not an unlabelled boolean or arbitrary enum value', () => {
    const { states: _states, ...unlabelled } = value
    expect(physicalSubjectStatus({ subject, values: [unlabelled], observations: [observation] }, [], false).word).toBeNull()
    expect(physicalSubjectStatus({ subject, values: [unlabelled], observations: [{ ...observation, value: false }] }, [], false).word).toBeNull()
    const operation: VignetteValue = { ...value, ref: 'plant:one#operation', valueType: 'enum', states: [{ value: 'run', label: 'RUN' }, { value: 'stop', label: 'STOP' }] }
    const running: Observation = { ...observation, ref: operation.ref, value: 'run' }
    expect(physicalSubjectStatus({ subject, values: [unlabelled, operation], observations: [observation, running] }, [], false).word).toBe('RUN')
    expect(physicalSubjectStatus({ subject, values: [operation], observations: [{ ...running, value: 'unknown-state' }] }, [], false).word).toBeNull()
    const { states: _operationStates, ...openState } = operation
    expect(physicalSubjectStatus({ subject, values: [openState], observations: [{ ...running, value: 'RUN' }] }, [], false).word).toBe('RUN')
    expect(physicalSubjectStatus({ subject, values: [{ ...openState, quantity: 'count', unit: '1' }], observations: [running] }, [], false).word).toBeNull()
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
  test('unrequested map history leaves the owner record declaration intact and never mounts its absence claim', () => {
    const recorded: VignetteValue = { ...value, quantity: 'flow', unit: 'kg/s', valueType: 'number', series: { seriesId: 'feed-flow-record', intervalMs: 1000 } }
    const response = reading()
    const parsed = layoutLiveResponseSchema.parse({ ...response, subjects: [{ ...response.subjects[0]!, values: [recorded] }] })
    const rows = valueRows({ values: parsed.subjects[0]!.values, observations: [{ ...observation, value: 400 }], series: new Map(), now: Date.parse(at), title: 'Feed pump', frozen: false })
    expect(parsed.subjects[0]!.values[0]!.series).toEqual(recorded.series)
    expect(rows[0]?.recorded).toBe(true)
    expect(rows[0]?.series).toBeUndefined()
    // Shared UI usage guards: current-only is a surface choice, not rewritten
    // historian metadata; existing process cards keep history by default.
    const inspection = readFileSync(new URL('../src/ui/embed/physical-layout/Inspection.svelte', import.meta.url), 'utf8')
    const faceplate = readFileSync(new URL('../src/ui/embed/vignette/Faceplate.svelte', import.meta.url), 'utf8')
    const view = readFileSync(new URL('../src/ui/embed/vignette/ValueRows.svelte', import.meta.url), 'utf8')
    expect(inspection).toContain('showHistory={false}')
    expect(faceplate).toContain('showHistory = true')
    expect(faceplate).toContain('<ValueRows {rows} now={readings.now} {showHistory}')
    expect(view).toContain('showHistory = true')
    expect(view).toContain('{#if showHistory && row.recorded}<Sparkline')
    expect(view).toContain('{#if showHistory}<span class="rate"')
  })

  test('a 2D plan returns to a real level and separation changes only the view', () => {
    const levels = [{ id: 'lower', label: 'Condenser floor', elevation: 0 }, { id: 'operating', label: 'Operating floor', elevation: 15 }]
    const initial = initialPhysicalLayoutView(levels)
    const all = changePhysicalLayoutView(initial, { mode: '3d', levelId: 'all', separation: 15 }, levels)
    expect(changePhysicalLayoutView(all, { mode: '2d' }, levels)).toEqual({ ...initial })
    expect(() => changePhysicalLayoutView(initial, { levelId: 'unknown' }, levels)).toThrow('Unknown layout level')
    expect(changePhysicalLayoutView(all, { separation: 75 }, levels).separation).toBe(75)
    expect(() => changePhysicalLayoutView(initial, { separation: -1 }, levels)).toThrow('non-negative')
    expect(() => changePhysicalLayoutView(initial, { separation: Infinity }, levels)).toThrow('finite')
  })

  test('the faceplate envelope retains exact owner/model/layout scope and validates close/size messages', () => {
    const { runId, ...state } = expected
    const envelope = layoutInspectionEnvelope({ workspaceId: newWorkspaceId(), runId, state: { ...state, elementId: 'pump', label: 'Feed pump' } })
    expect(layoutInspectionExpected(envelope).expected).toEqual(expected)
    expect(() => layoutInspectionExpected(embeddedViewEnvelopeSchema.parse({ ...envelope, subject: { ...envelope.subject, type: 'world.object' } }))).toThrow('Simulation Run')
    expect(layoutInspectionMessageSchema.safeParse({ type: 'world:layout-inspection-size', layoutObjectId: expected.layoutObjectId, elementId: 'pump', height: 400 }).success).toBe(true)
    expect(layoutInspectionMessageSchema.safeParse({ type: 'world:layout-inspection-size', layoutObjectId: expected.layoutObjectId, elementId: 'pump', height: 12_000 }).success).toBe(true)
    expect(layoutInspectionMessageSchema.safeParse({ type: 'world:layout-inspection-size', layoutObjectId: expected.layoutObjectId, elementId: 'pump', height: Infinity }).success).toBe(false)
    expect(layoutInspectionMessageSchema.safeParse({ type: 'world:layout-inspection-close', layoutObjectId: expected.layoutObjectId, elementId: 'pump', returnFocus: true, operate: true }).success).toBe(false)
  })

  test('hosted inspection shares the acquired subject without another read or a renewed freshness stamp', () => {
    const { runId: _runId, ...scope } = expected
    const state = layoutInspectionStateSchema.parse({ ...scope, elementId: 'pump', label: 'Feed pump', delivery: 'host', channel: crypto.randomUUID() })
    const base = reading()
    const second = { ...value, ref: 'plant:one#valve' }
    const latest: LayoutLiveResponse = { ...base,
      subjects: [...base.subjects, { elementId: 'valve', label: 'Valve', values: [second], word: null, devices: [] }],
      sample: { ...base.sample, observations: [...base.sample.observations, { ...observation, ref: second.ref }] },
    }
    const snapshot: LayoutLiveSnapshot = { phase: 'live', latest, stamp: { scope: expected, epoch: latest.scope.epoch, sequence: latest.scope.sequence, receivedWallMs: 100 }, failure: null }
    const message = layoutInspectionSampleMessage(state, snapshot)
    const forwarded = readHostedLayoutInspectionSample(state, expected, message)
    expect(forwarded.latest?.subjects.map(subject => subject.elementId)).toEqual(['pump'])
    expect(forwarded.latest?.sample.observations.map(value => value.ref)).toEqual([value.ref])
    expect(forwarded.stamp?.receivedWallMs).toBe(100)
    expect(layoutLiveFrozen(forwarded, 5_101)).toBe(true)
    expect(() => readHostedLayoutInspectionSample({ ...state, channel: crypto.randomUUID() }, expected, message)).toThrow('channel')
    expect(() => readHostedLayoutInspectionSample(state, { ...expected, objectId: objectIdSchema.parse('plant:other') }, message)).toThrow('another Run')
    expect(() => readHostedLayoutInspectionSample(state, expected, { ...message, snapshot: { ...message.snapshot, stamp: { ...message.snapshot.stamp, sequence: 999 } } })).toThrow('disagree')
    expect(() => layoutInspectionStateSchema.parse({ ...scope, elementId: 'pump', label: 'Feed pump', delivery: 'host' })).toThrow('channel')
  })

  test('a delayed first sample can grow a short hosted card, and host shrink/grow does not feed back through its allocation', async () => {
    const { runId: _runId, ...scope } = expected
    const state = layoutInspectionStateSchema.parse({ ...scope, elementId: 'pump', label: 'Feed pump', delivery: 'host', channel: crypto.randomUUID() })
    const padding = { top: 0, right: 0, bottom: 0, left: 0 }
    let firstSample!: (value: LayoutLiveResponse) => void
    const live = harness({ read: () => new Promise(resolve => { firstSample = resolve }) })
    live.session.start(); await settle()
    expect(live.calls).toEqual(['presence'])

    let allocatedHeight = 120 // The loading card has already reported its short intrinsic extent.
    const space = (viewportHeight: number) => {
      const hostRoom = layoutInspectionHostRoom({ width: 800, height: viewportHeight }, padding, 80)
      return readHostedLayoutInspectionSpace(state, layoutInspectionSpaceMessage(state, hostRoom.height))
    }
    const available = space(800)
    const budget = faceplateHeight(layoutInspectionContentRoom(360, available), 1)
    expect(budget).toBeGreaterThan(allocatedHeight)

    firstSample(reading()); await settle()
    const forwarded = readHostedLayoutInspectionSample(state, expected, layoutInspectionSampleMessage(state, live.last()))
    expect(forwarded.latest?.subjects[0]!.values[0]!.ref).toBe(value.ref)
    allocatedHeight = Math.min(360, available) // A measured, larger intrinsic extent is now allowed.
    expect(space(800)).toBe(available)
    expect(faceplateHeight(layoutInspectionContentRoom(360, space(800)), 1)).toBe(budget)
    expect(allocatedHeight).toBeGreaterThan(120)

    const smaller = space(240)
    allocatedHeight = Math.min(allocatedHeight, smaller)
    expect(smaller).toBeLessThan(available)
    expect(allocatedHeight).toBeLessThan(360)
    expect(space(800)).toBe(available)
    expect(faceplateHeight(layoutInspectionContentRoom(360, space(800)), 1)).toBe(budget)
    expect(() => readHostedLayoutInspectionSpace({ ...state, channel: crypto.randomUUID() }, layoutInspectionSpaceMessage(state, available))).toThrow('channel')
    expect(() => layoutInspectionSpaceMessage(state, Infinity)).toThrow()
    expect(() => layoutInspectionSpaceMessage(state, -1)).toThrow()
    live.session.close()
  })

  test('fitting around a Quick look changes camera composition without redefining actual inspection space', () => {
    const viewport = { width: 1280, height: 720 }, reserved = { top: 80, right: 100, bottom: 0, left: 0 }
    const room = layoutInspectionHostRoom(viewport, reserved, 80)
    const short = { x: 12, y: 100, width: 360, height: 120 }, expanded = { ...short, height: 420 }
    const shortFit = physicalExplorerFitPadding(viewport, reserved, [short])
    const expandedFit = physicalExplorerFitPadding(viewport, reserved, [expanded])
    expect(shortFit).not.toEqual(reserved)
    expect(expandedFit).not.toEqual(reserved)
    // Camera composition may exclude a whole strip to fit the model beside a
    // floating card. That strip is not an external UI cover for the next card.
    expect(expandedFit.left).toBeGreaterThan(reserved.left)
    expect(layoutInspectionHostRoom(viewport, reserved, 80)).toEqual(room)
    expect(layoutInspectionHostRoom(viewport, { ...reserved, bottom: 160 }, 80).height).toBe(room.height - 152)
    expect(layoutInspectionHostRoom({ width: 319, height: 180 }, { top: 80, right: 360, bottom: 200, left: 0 }, 80)).toMatchObject({ width: 0, height: 0 })
    expect(layoutInspectionHostRoom(viewport, { top: 0, right: 0, bottom: 0, left: 0 }, 0)).toEqual({ x: 8, y: 8, width: 1264, height: 704 })

    // The actual shared Svelte host receives panel reports, rather than reading
    // an imperative camera state which can also be mid-animation.
    const explorer = readFileSync(new URL('../src/ui/physical-layout/PhysicalExplorer.svelte', import.meta.url), 'utf8')
    const map = readFileSync(new URL('../src/ui/OperationalMap.svelte', import.meta.url), 'utf8')
    expect(map).toContain('reservedPadding={cameraPadding}')
    expect(explorer).toContain('layoutInspectionHostRoom(size, reservedPadding, clearTop - surfaceTop)')
    expect(explorer).not.toContain('surface.getPadding()')
  })
})
