import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import { createMarksReader, elementMarks } from '../src/packs/process-plant/ui/displays/operation/element-marks.ts'
import type { OperationClient } from '../src/packs/process-plant/ui/displays/operation/operation-client.ts'

// What a drawing in the display window marks on the Plant's items (plan v5 W3.6): the items pending proposals wait
// on, the one that lapses first first. Offered controls are not marked: with a mouse an item's magnifier shows on
// hover and keyboard focus, at rest only on touch screens and where a proposal waits (R3 lead ruling).

const proposal = (item: string, expiresAtElapsedMs: number, status: 'pending' | 'approved', origin: 'person' | 'ai') =>
  ({ item, expiresAtElapsedMs, status, proposer: { actorId: 'x', origin } })

describe('element marks', () => {
  test('pending proposals by their item, the one that lapses first first', () => {
    const marks = elementMarks([proposal('auxFeedwaterValveA', 300, 'pending', 'person'), proposal('pressurizer.reliefValve', 120, 'pending', 'ai'), proposal('rcpA', 50, 'approved', 'ai')] as never)
    expect(marks).toEqual({ pending: [{ element: 'pressurizer.reliefValve', ai: true }, { element: 'auxFeedwaterValveA', ai: false }] })
  })

  test('a read asks for the proposals only, never the controls offered', async () => {
    const asked = { controls: 0, proposals: 0 }
    const client = {
      controls: async () => { asked.controls += 1; return { plantElapsedMs: 0, items: [], resets: [] } },
      proposals: async () => { asked.proposals += 1; return { plantElapsedMs: 0, proposals: [{ proposal: proposal('rcpA', 10, 'pending', 'person') }] } },
    } as unknown as OperationClient
    const read = createMarksReader(client)
    expect(await read('run-1' as SimulationRunId, 'plant:a' as never)).toEqual({ pending: [{ element: 'rcpA', ai: false }] })
    await read('run-1' as SimulationRunId, 'plant:a' as never)
    expect(asked).toEqual({ controls: 0, proposals: 2 })
  })
})
