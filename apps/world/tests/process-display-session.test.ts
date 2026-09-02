import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import {
  compilePlantGraph, compileProcessDisplay, assemblePwrReferencePlantGraph,
  processPlantComponentRegistry, processPlantUnitOverviewDisplay,
} from '../src/packs/process-plant/index.ts'
import {
  emptyProcessDisplayAlarmSnapshot,
  type ProcessDisplayListItem, type ProcessDisplaySnapshot,
} from '../src/ui/process-display/process-display-client.ts'
import { createProcessDisplaySession } from '../src/ui/process-display/process-display-session.ts'

const display = compileProcessDisplay({
  definition: { ...processPlantUnitOverviewDisplay, id: 'discovered-display' },
  graph: compilePlantGraph(assemblePwrReferencePlantGraph({ loopCount: 4 }), processPlantComponentRegistry),
})
const listing: ProcessDisplayListItem[] = [{ id: display.id, title: display.title, lenses: display.lenses }]
const snapshot: ProcessDisplaySnapshot = {
  plantId: 'plant-a', displayId: display.id, values: [], alarms: emptyProcessDisplayAlarmSnapshot,
}
const fixture = () => {
  const received: ProcessDisplaySnapshot[] = []
  const errors: Array<string | null> = []
  const client = {
    list: async () => listing,
    read: async (_runId: SimulationRunId, _plantId: string, _displayId: string) => display,
    snapshot: async (_runId: SimulationRunId, _plantId: string, _displayId: string) => snapshot,
  }
  const session = createProcessDisplaySession({
    runId: 'test-display-run' as SimulationRunId, plantId: 'plant-a', client,
    onSnapshot: value => { received.push(value) },
    onRefreshError: value => { errors.push(value) },
  })
  return { client, session, received, errors }
}

describe('process display window session', () => {
  test('discovers the display, then reads its definition and first snapshot concurrently', async () => {
    const { client, session } = fixture()
    const definition = Promise.withResolvers<typeof display>()
    const values = Promise.withResolvers<ProcessDisplaySnapshot>()
    const started: string[] = []
    client.read = async (runId, plantId, displayId) => {
      expect([runId, plantId, displayId]).toEqual(['test-display-run', 'plant-a', 'discovered-display'])
      started.push('definition')
      return definition.promise
    }
    client.snapshot = async (_runId, _plantId, displayId) => {
      expect(displayId).toBe('discovered-display')
      started.push('snapshot')
      return values.promise
    }
    const pending = session.load()
    await Promise.resolve()
    expect(started).toEqual(['definition', 'snapshot'])
    definition.resolve(display)
    values.resolve(snapshot)
    expect(await pending).toEqual({ display, snapshot })
    session.close()
  })

  test('coalesces overlapping refreshes and preserves the last snapshot on failure', async () => {
    const { client, session, received, errors } = fixture()
    await session.load()
    const pending = Promise.withResolvers<ProcessDisplaySnapshot>()
    let calls = 0
    client.snapshot = async () => { calls += 1; return pending.promise }
    const first = session.refresh()
    expect(session.refresh()).toBe(first)
    expect(calls).toBe(1)
    pending.resolve(snapshot)
    await first
    expect(received).toEqual([snapshot])
    client.snapshot = async () => { throw new Error('offline') }
    await session.refresh()
    expect(received).toEqual([snapshot])
    expect(errors.at(-1)).toBe('offline')
    client.snapshot = async () => snapshot
    await session.refresh()
    expect(errors.at(-1)).toBeNull()
    expect(received).toHaveLength(2)
    session.close()
  })

  test('closing during discovery prevents the following requests', async () => {
    const { client, session } = fixture()
    const discovery = Promise.withResolvers<ProcessDisplayListItem[]>()
    let calls = 0
    client.list = async () => discovery.promise
    client.read = async () => { calls += 1; return display }
    client.snapshot = async () => { calls += 1; return snapshot }
    const pending = session.load()
    session.close()
    discovery.resolve(listing)
    expect(await pending).toBeNull()
    expect(calls).toBe(0)
    expect(await session.load()).toBeNull()
  })

  test('closing during initial reads discards the completed display', async () => {
    const { client, session, received } = fixture()
    const values = Promise.withResolvers<ProcessDisplaySnapshot>()
    client.snapshot = async () => values.promise
    const pending = session.load()
    await Promise.resolve()
    session.close()
    values.resolve(snapshot)
    expect(await pending).toBeNull()
    expect(received).toEqual([])
  })

  test('closing during refresh ignores both values and errors', async () => {
    for (const reject of [false, true]) {
      const { client, session, received, errors } = fixture()
      await session.load()
      const values = Promise.withResolvers<ProcessDisplaySnapshot>()
      client.snapshot = async () => values.promise
      const pending = session.refresh()
      session.close()
      if (reject) values.reject(new Error('removed plant'))
      else values.resolve(snapshot)
      await pending
      expect(received).toEqual([])
      expect(errors).toEqual([])
    }
  })

  test('a failed initial load can be retried without replacing the session', async () => {
    const { client, session } = fixture()
    client.list = async () => []
    await expect(session.load()).rejects.toThrow('no process displays')
    client.list = async () => listing
    expect(await session.load()).toEqual({ display, snapshot })
    session.close()
  })
})
