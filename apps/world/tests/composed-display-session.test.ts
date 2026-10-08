import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import type { ComposedDisplayClient, ComposedDisplayViewResult, RunPresence } from '../src/ui/embed/composed-display/composed-display-client.ts'
import {
  createComposedDisplaySession,
  IDLE_SUSPEND_MS,
  type ComposedDisplaySnapshot,
} from '../src/ui/embed/composed-display/composed-display-session.ts'

const runId = 'run-1' as SimulationRunId
const at = (offsetMs: number): string => new Date(Date.parse('2026-01-01T09:00:00.000Z') + offsetMs).toISOString()

const view: ComposedDisplayViewResult = {
  plantId: 'plant:1',
  plantLabel: 'Unit 1',
  issuedAt: at(0),
  simulationTime: at(0),
  modelChanged: false,
  display: {
    plantId: 'plant:1',
    title: 'Pressure',
    question: 'Is pressure recovering?',
    need: 'Decide on spray',
    modelDigest: 'a'.repeat(64),
    panels: [{
      kind: 'trend',
      horizon: '2m',
      horizonMs: 120_000,
      unit: 'MPa',
      pens: [
        { ref: 'PT-455', role: 'primary', path: 'pressurizer.pressureMPa', tagId: 'PT-455', label: 'Pressure', unit: 'MPa', quantity: 'pressure', seriesId: 'series:pressure', thresholds: [], combinedRules: [] },
        { ref: 'X', role: 'context', path: 'x.value', label: 'X', unit: 'MPa', quantity: 'pressure', seriesId: 'series:x', thresholds: [], combinedRules: [] },
      ],
    }],
  } as unknown as ComposedDisplayViewResult['display'],
}

const fakeClient = (config: {
  presence: RunPresence | null
  samples?: Array<{ readonly time: string; readonly value: number } | Error>
}) => {
  const calls: string[] = []
  let presence = config.presence
  const client: ComposedDisplayClient = {
    presence: async () => { calls.push('presence'); return presence },
    loadRun: async () => { calls.push('loadRun'); presence = presence && { ...presence, loaded: true } },
    view: async () => { calls.push('view'); return view },
    history: async (_run, seriesId) => {
      calls.push(`history:${seriesId}`)
      return seriesId === 'series:pressure' ? [{ t: Date.parse(at(-60_000)), v: 15.4 }] : []
    },
    sample: async () => {
      calls.push('sample')
      const next = config.samples?.shift()
      if (next === undefined) throw new Error('no sample scripted')
      if (next instanceof Error) throw next
      return { simulationTime: next.time, values: [{ path: 'pressurizer.pressureMPa', value: next.value, quality: 'good' }] }
    },
  }
  return { client, calls }
}

const session = (client: ComposedDisplayClient, wall = { now: 0 }) => {
  const snapshots: ComposedDisplaySnapshot[] = []
  const controller = createComposedDisplaySession({
    runId, plantId: 'plant:1', state: '{}', client,
    onChange: snapshot => { snapshots.push(snapshot) },
    wallNow: () => wall.now,
  })
  return { controller, last: () => snapshots[snapshots.length - 1]! }
}

describe('composed display session', () => {
  test('never loads an inactive Run on its own and loads it only on request', async () => {
    const { client, calls } = fakeClient({ presence: { loaded: false, playback: 'playing', currentSimulationTime: at(0) } })
    const { controller, last } = session(client)
    await controller.start({ poll: false })
    expect(last().phase.kind).toBe('inactive')
    expect(calls).toEqual(['presence'])
    await controller.loadRun({ poll: false })
    expect(calls.slice(0, 3)).toEqual(['presence', 'loadRun', 'view'])
    expect(last().phase.kind).toBe('live')
  })

  test('reports a removed Run explicitly', async () => {
    const { client } = fakeClient({ presence: null })
    const { controller, last } = session(client)
    await controller.start({ poll: false })
    expect(last().phase.kind).toBe('missing')
  })

  test('backfills history, marks signals without recorded history and appends live samples', async () => {
    const { client } = fakeClient({ presence: { loaded: true, playback: 'playing', currentSimulationTime: at(0) }, samples: [{ time: at(1_000), value: 15.5 }] })
    const { controller, last } = session(client)
    await controller.start({ poll: false })
    expect([...last().historyMissing]).toEqual(['x.value'])
    await controller.poll()
    expect(last().series.get('pressurizer.pressureMPa')!.map(point => point.v)).toEqual([15.4, 15.5])
  })

  test('flags a Run reset after the advice and keeps stale values on failure', async () => {
    const { client } = fakeClient({
      presence: { loaded: true, playback: 'playing', currentSimulationTime: at(0) },
      samples: [{ time: at(-30_000), value: 15.0 }, new Error('Capability query failed: 503')],
    })
    const { controller, last } = session(client)
    await controller.start({ poll: false })
    await controller.poll()
    expect(last().resetSinceAdvice).toBe(true)
    expect(last().series.get('pressurizer.pressureMPa')!.map(point => point.v)).toEqual([15.0])
    await controller.poll()
    expect(last().sampleError).toContain('503')
    expect(last().series.get('pressurizer.pressureMPa')!.map(point => point.v)).toEqual([15.0])
  })

  test('suspends after a long time without interaction and resumes on request', async () => {
    const wall = { now: 0 }
    const { client, calls } = fakeClient({ presence: { loaded: true, playback: 'playing', currentSimulationTime: at(0) }, samples: [{ time: at(1_000), value: 15.5 }] })
    const { controller, last } = session(client, wall)
    await controller.start({ poll: false })
    wall.now = IDLE_SUSPEND_MS + 1
    await controller.poll()
    expect(last().phase.kind).toBe('suspended')
    expect(calls).not.toContain('sample')
    controller.resume()
    expect(last().phase.kind).toBe('live')
    controller.close()
  })
})
