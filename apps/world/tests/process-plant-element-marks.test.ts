import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import { createMarksReader, elementMarks, OFFERED_EVERY_MS } from '../src/packs/process-plant/ui/displays/operation/element-marks.ts'
import type { OperationClient } from '../src/packs/process-plant/ui/displays/operation/operation-client.ts'

// What a drawing in the display window marks on the Plant's items (plan v5 W3.6): the items World offers controls
// on, whose magnifier always shows, and the items pending proposals wait on, the one that lapses first first.

const proposal = (item: string, expiresAtElapsedMs: number, status: 'pending' | 'approved', origin: 'person' | 'ai') =>
  ({ item, expiresAtElapsedMs, status, proposer: { actorId: 'x', origin } })

describe('element marks', () => {
  test('items with offered controls, and pending proposals by their item, the one that lapses first first', () => {
    const items = [{ id: 'rcpA', offered: [{}] }, { id: 'sgA', offered: [] }, { id: 'auxFeedwaterValveA', offered: [{}] }] as never
    const marks = elementMarks(items, [proposal('auxFeedwaterValveA', 300, 'pending', 'person'), proposal('pressurizer.reliefValve', 120, 'pending', 'ai'), proposal('rcpA', 50, 'approved', 'ai')] as never)
    expect(marks.operated).toEqual(['rcpA', 'auxFeedwaterValveA'])
    expect(marks.pending).toEqual([{ element: 'pressurizer.reliefValve', ai: true }, { element: 'auxFeedwaterValveA', ai: false }])
  })

  test('the offered items are read again only every so often; the proposals every time', async () => {
    let clock = 0
    const asked = { controls: 0, proposals: 0 }
    const client = {
      controls: async () => { asked.controls += 1; return { plantElapsedMs: 0, items: [{ id: 'rcpA', offered: [{}] }], resets: [] } },
      proposals: async () => { asked.proposals += 1; return { plantElapsedMs: 0, proposals: [] } },
    } as unknown as OperationClient
    const read = createMarksReader(client, () => clock)
    await read('run-1' as SimulationRunId, 'plant:a' as never)
    await read('run-1' as SimulationRunId, 'plant:a' as never)
    clock = OFFERED_EVERY_MS
    await read('run-1' as SimulationRunId, 'plant:a' as never)
    expect(asked).toEqual({ controls: 2, proposals: 3 })
  })
})
