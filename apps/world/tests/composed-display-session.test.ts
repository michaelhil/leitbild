import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import type { ComposedDisplayClient, ComposedDisplayViewResult, RunPresence, ViewSize } from '../src/ui/embed/composed-display/composed-display-client.ts'
import {
  createComposedDisplaySession,
  IDLE_SUSPEND_MS,
  type ComposedDisplaySnapshot,
} from '../src/ui/embed/composed-display/composed-display-session.ts'

const runId = 'run-1' as SimulationRunId
const at = (offsetMs: number): string => new Date(Date.parse('2026-01-01T09:00:00.000Z') + offsetMs).toISOString()

const view: ComposedDisplayViewResult = {
  kind: 'advice',
  plantId: 'plant:1',
  plantLabel: 'Unit 1',
  issuedAt: at(0),
  simulationTime: at(0),
  modelChanged: false,
  drawingChanged: false,
  display: {
    plantId: 'plant:1',
    title: 'Pressure',
    advice: { question: 'Is pressure recovering?', need: 'Decide on spray' },
    modelDigest: 'a'.repeat(64),
    panels: [{
      kind: 'trend',
      horizon: '2m',
      horizonMs: 120_000,
      live: [],
      strips: [{
        unit: 'MPa',
        thresholds: [],
        pens: [
          { ref: 'PT-455', role: 'primary', path: 'pressurizer.pressureMPa', tagId: 'PT-455', label: 'Pressure', unit: 'MPa', quantity: 'pressure', seriesId: 'series:pressure', thresholds: [], combinedRules: [] },
          { ref: 'X', role: 'context', path: 'x.value', label: 'X', unit: 'MPa', quantity: 'pressure', seriesId: 'series:x', thresholds: [], combinedRules: [] },
        ],
      }],
    }],
  } as unknown as ComposedDisplayViewResult['display'],
}

const fakeClient = (config: {
  presence: RunPresence | null
  samples?: Array<{ readonly time: string; readonly value: number } | Error>
  view?: ComposedDisplayViewResult
}) => {
  const calls: string[] = []
  let presence = config.presence
  const client: ComposedDisplayClient = {
    presence: async () => { calls.push('presence'); return presence },
    loadRun: async () => { calls.push('loadRun'); presence = presence && { ...presence, loaded: true } },
    view: async (_run, _plant, _state, size) => { calls.push(size === null ? 'view' : `view:${size.width}x${size.height}`); return config.view ?? view },
    history: async (_run, seriesId) => {
      calls.push(`history:${seriesId}`)
      return seriesId === 'series:pressure' ? [{ t: Date.parse(at(-60_000)), v: 15.4 }] : []
    },
    sample: async () => {
      calls.push('sample')
      const next = config.samples?.shift()
      if (next === undefined) throw new Error('no sample scripted')
      if (next instanceof Error) throw next
      return { simulationTime: next.time, plantElapsedMs: 0, values: [{ path: 'pressurizer.pressureMPa', value: next.value, quality: 'good' as const }] }
    },
  }
  return { client, calls }
}

const session = (client: ComposedDisplayClient, wall = { now: 0 }, suspendWhenIdle = true, size: () => ViewSize | null = () => null) => {
  const snapshots: ComposedDisplaySnapshot[] = []
  const controller = createComposedDisplaySession({
    runId, plantId: 'plant:1', state: '{}', client,
    onChange: snapshot => { snapshots.push(snapshot) },
    suspendWhenIdle,
    size,
    wallNow: () => wall.now,
  })
  return { controller, last: () => snapshots[snapshots.length - 1]! }
}

describe('composed display session', () => {
  test('never loads an inactive Run on its own and loads it only on request', async () => {
    const { client, calls } = fakeClient({ presence: { title: 'Run', loaded: false, playback: 'playing', currentSimulationTime: at(0) }, samples: [{ time: at(0), value: 15.4 }] })
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
    const { client } = fakeClient({ presence: { title: 'Run', loaded: true, playback: 'playing', currentSimulationTime: at(0) }, samples: [{ time: at(0), value: 15.45 }, { time: at(1_000), value: 15.5 }] })
    const { controller, last } = session(client)
    await controller.start({ poll: false })
    expect([...last().historyMissing]).toEqual(['x.value'])
    expect(last().latest?.values[0]?.value).toBe(15.45)
    await controller.poll()
    expect(last().series.get('pressurizer.pressureMPa')!.map(point => point.v)).toEqual([15.4, 15.5])
  })

  test('flags a Run reset after the advice and keeps stale values on failure', async () => {
    const { client } = fakeClient({
      presence: { title: 'Run', loaded: true, playback: 'playing', currentSimulationTime: at(0) },
      samples: [{ time: at(0), value: 15.4 }, { time: at(-30_000), value: 15.0 }, new Error('Capability query failed: 503')],
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
    const { client, calls } = fakeClient({ presence: { title: 'Run', loaded: true, playback: 'playing', currentSimulationTime: at(0) }, samples: [{ time: at(0), value: 15.4 }, { time: at(1_000), value: 15.5 }] })
    const { controller, last } = session(client, wall)
    await controller.start({ poll: false })
    wall.now = IDLE_SUSPEND_MS + 1
    await controller.poll()
    expect(last().phase.kind).toBe('suspended')
    expect(calls.filter(call => call === 'sample')).toHaveLength(1)
    controller.resume()
    expect(last().phase.kind).toBe('live')
    controller.close()
  })

  test('an overview is drawn for its window, and again when the window settles at a new size', async () => {
    const overview: ComposedDisplayViewResult = { kind: 'overview', plantId: 'plant:1', plantLabel: 'Unit 1', simulationTime: at(0), display: view.display }
    const window = { width: 1896, height: 972 }
    const { client, calls } = fakeClient({ presence: { title: 'Run', loaded: true, playback: 'playing', currentSimulationTime: at(0) }, samples: [{ time: at(0), value: 15.4 }], view: overview })
    const { controller } = session(client, { now: 0 }, false, () => window)
    await controller.start({ poll: false })
    window.width = 1440
    await controller.relayout()
    expect(calls.filter(call => call.startsWith('view'))).toEqual(['view:1896x972', 'view:1440x972'])
    controller.close()
  })

  test('a generated display opens equipment in place, samples it at once and keeps drawing it for the window', async () => {
    const overview: ComposedDisplayViewResult = { kind: 'overview', plantId: 'plant:1', plantLabel: 'Unit 1', simulationTime: at(0), display: view.display }
    const detail: ComposedDisplayViewResult = { ...overview, kind: 'detail', display: { ...view.display, title: 'Steam Generator B' } }
    const window = { width: 1896, height: 972 }
    const { client: base, calls } = fakeClient({ presence: { title: 'Run', loaded: true, playback: 'playing', currentSimulationTime: at(0) }, samples: [{ time: at(0), value: 15.4 }, { time: at(1_000), value: 15.5 }] })
    const states: string[] = []
    const client: ComposedDisplayClient = {
      ...base,
      view: async (run, plant, state, size) => {
        states.push(state)
        if (state === 'unknown') throw new Error('cannot be opened')
        await base.view(run, plant, state, size)
        return state === 'detail' ? detail : overview
      },
    }
    const { controller, last } = session(client, { now: 0 }, false, () => window)
    await controller.start({ poll: false })
    // A display that cannot be drawn rejects and leaves the overview shown.
    await expect(controller.open('unknown')).rejects.toThrow('cannot be opened')
    expect(last().view?.kind).toBe('overview')
    await controller.open('detail')
    expect(last().view?.display.title).toBe('Steam Generator B')
    expect(calls.filter(call => call === 'sample')).toHaveLength(2)
    window.width = 1440
    await controller.relayout()
    expect(states).toEqual(['{}', 'unknown', 'detail', 'detail'])
    expect(calls.filter(call => call.startsWith('view'))).toEqual(['view:1896x972', 'view:1896x972', 'view:1440x972'])
    controller.close()
  })

  test('advice keeps the size it was composed with', async () => {
    const { client, calls } = fakeClient({ presence: { title: 'Run', loaded: true, playback: 'playing', currentSimulationTime: at(0) }, samples: [{ time: at(0), value: 15.4 }] })
    const { controller } = session(client)
    await controller.start({ poll: false })
    await controller.relayout()
    expect(calls.filter(call => call.startsWith('view'))).toEqual(['view'])
    controller.close()
  })

  test('an operating overview keeps updating however long it is left unattended', async () => {
    const wall = { now: 0 }
    const { client, calls } = fakeClient({ presence: { title: 'Run', loaded: true, playback: 'playing', currentSimulationTime: at(0) }, samples: [{ time: at(0), value: 15.4 }, { time: at(1_000), value: 15.5 }] })
    const { controller, last } = session(client, wall, false)
    await controller.start({ poll: false })
    wall.now = IDLE_SUSPEND_MS + 1
    await controller.poll()
    expect(last().phase.kind).toBe('live')
    expect(calls.filter(call => call === 'sample')).toHaveLength(2)
    controller.close()
  })
})
