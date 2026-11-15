import { describe, expect, test } from 'bun:test'
import { meters, routeDistanceMeters } from '../../core/model/index.ts'
import { createDirectRoutingAdapter } from '../../routing/direct-adapter.ts'
import type { RouteTableResult } from '../../routing/protocol.ts'
import type { RecommendAnswer } from './recommendation-schema.ts'
import type { EngineState } from './engine/model.ts'
import { advance, at, emptyState, first, low, middle, newTask, newUnit, pointOf, run, runAll, send, start, templates, top, types } from './fixtures/engine-harness.ts'
import type { TablePort } from './eta.ts'
import { recommend } from './recommend.ts'
import { refusalCode } from './refusal.ts'
import { openViewer } from './viewer.ts'

const direct = createDirectRoutingAdapter()
const recommendFor = (state: EngineState, taskId: string, routing: TablePort = direct): Promise<RecommendAnswer> =>
  recommend({ state, viewer: openViewer, taskId, routing })
const unitIds = (entries: ReadonlyArray<{ readonly unitId: string }> | undefined): string[] => (entries ?? []).map(entry => entry.unitId)
const alternativeIds = (recommendation: RecommendAnswer): string[][] => recommendation.alternatives.map(entry => unitIds(entry.units))
const far = (index: number) => at(0.05 * (index + 1), 0.02)

/** Five carriers, each en route to or on a task of its own: none is free. */
const busyScenario = async (): Promise<EngineState> => {
  let state = await runAll(emptyState(), [
    ...['a1', 'a2', 'a3'].map((id, index) => newUnit(id, types.roadCarrier, at(0.001 * index))),
    newTask('top1', templates.load, far(0), { [top]: 1 }),
    newTask('c9', templates.load, far(1), { [middle]: 1 }),
    newTask('low3', templates.load, at(0.002), { [low]: 1 }),
  ])
  state = await runAll(state, [send(['a1'], { taskId: 'top1' }), send(['a2'], { taskId: 'c9' }), send(['a3'], { taskId: 'low3' })])
  return await advance(state, start + 3_000)
}

describe('Einsatz recommendations propose free units only', () => {
  test('with every unit busy nothing is proposed, and why not names what each is doing', async () => {
    const state = await run(await busyScenario(), newTask('n1', templates.load, at(0.003), { [top]: 1 }, { priority: first }))
    const recommendation = await recommendFor(state, 'n1')
    expect(recommendation.proposal).toBeNull()
    expect(recommendation.priority).toEqual({ id: first, label: 'First', code: 'Q1', rank: 0 })
    expect(recommendation.whyNot.map(entry => [entry.unitId, entry.reasons[0]])).toEqual([['a1', 'A1 now en route to TOP1'], ['a2', 'A2 now en route to C9'], ['a3', 'A3 now working at LOW3']])
  })

  test('the proposal\'s order is accepted unchanged, and a second recommendation never proposes the unit it sent', async () => {
    let state = await runAll(emptyState(), [
      newUnit('c1', types.roadCarrier, at(0.001)),
      newUnit('c2', types.roadCarrier, at(0.002)),
      newTask('t1', templates.load, at(0), { [top]: 1 }),
      newTask('t2', templates.load, at(0.003), { [top]: 1 }),
    ])
    const first = await recommendFor(state, 't1')
    expect(first.proposal?.order).toEqual({ units: ['c1'], stops: [{ taskId: 't1' }] })
    state = await run(state, { kind: 'order', ...first.proposal!.order })
    const second = await recommendFor(state, 't2')
    expect(unitIds(second.proposal?.units)).toEqual(['c2'])
    expect(second.whyNot.map(entry => entry.unitId)).toEqual(['c1'])
  })
})

describe('Einsatz smallest covering sets', () => {
  test('a counted requirement is proposed the nearest units that cover it; the rest are alternatives for that need, by ETA', async () => {
    const state = await runAll(emptyState(), [
      newUnit('g3', types.pairServer, at(0.03)),
      newUnit('g1', types.pairServer, at(0.001)),
      newUnit('g2', types.pairServer, at(0.002)),
      newTask('pair', templates.pair, at(0)),
    ])
    const recommendation = await recommendFor(state, 'pair')
    expect(recommendation.proposal).toMatchObject({ covers: { covered: 2, needed: 2 }, remainder: [], order: { units: ['g1', 'g2'], stops: [{ taskId: 'pair' }] } })
    expect(recommendation.alternatives).toEqual([{ need: { kind: 'requirement', id: 'guard', label: 'guards' }, units: [expect.objectContaining({ unitId: 'g3', order: { units: ['g3'], stops: [{ taskId: 'pair' }] } })] }])
  })

  test('a free unit on a move is free to propose', async () => {
    let state = await runAll(emptyState(), [
      newUnit('c1', types.roadCarrier, at(0.001)),
      newTask('t1', templates.load, at(0), { [top]: 1 }),
      send(['c1'], { point: at(0.002) }),
    ])
    state = await advance(state, start + 1_000)
    expect(unitIds((await recommendFor(state, 't1')).proposal?.units)).toEqual(['c1'])
  })

  test('fewer units come first: one carrier taking both loads beats two nearer carriers taking one each', async () => {
    const state = await runAll(emptyState(), [
      newUnit('c1', types.roadCarrier, at(0.001)),
      newUnit('c2', types.roadCarrier, at(0.002)),
      newUnit('d1', types.directCarrier, at(0.04)),
      newTask('t1', templates.load, at(0), { [top]: 1, [middle]: 1 }),
    ])
    const recommendation = await recommendFor(state, 't1')
    expect(unitIds(recommendation.proposal?.units)).toEqual(['d1'])
    expect(recommendation.proposal?.covers).toEqual({ covered: 2, needed: 2 })
    expect(alternativeIds(recommendation)).toEqual([['c1', 'c2'], ['c1', 'c2']])
  })

  test('without enough units the best partial set is proposed and the remainder named', async () => {
    const state = await runAll(emptyState(), [
      newUnit('c1', types.roadCarrier, at(0.001)),
      newTask('t1', templates.load, at(0), { [top]: 3 }),
    ])
    const recommendation = await recommendFor(state, 't1')
    expect(recommendation.proposal).toMatchObject({ units: [{ unitId: 'c1' }], covers: { covered: 1, needed: 3 }, remainder: ['C1×2'] })
  })

  test('a carrier that will pick up load is offered the accepting sites for it, nearest first', async () => {
    const state = await runAll(emptyState(), [
      newUnit('c1', types.roadCarrier, at(0.001)),
      newUnit('near', types.publicSite, at(0.004)),
      newUnit('far', types.publicSite, at(0.03)),
      newUnit('camp', types.sidedSite, at(0.002)),
      newTask('t1', templates.load, at(0), { [low]: 1 }),
    ])
    const recommendation = await recommendFor(state, 't1')
    // The camp accepts no low load, so only the public sites are offered.
    expect(recommendation.deliverTo).toEqual([{ unitId: 'c1', label: 'C1', sites: [expect.objectContaining({ siteId: 'near' }), expect.objectContaining({ siteId: 'far' })] }])
  })
})

describe('Einsatz units not proposed', () => {
  test('a unit failing a requirement is listed with the reason in property words; one lacking the property says so', async () => {
    let state = await runAll(emptyState(), [
      newUnit('h1', types.payloadServer, at(0.001)),
      newUnit('c1', types.roadCarrier, at(0.001)),
      newUnit('d1', types.directCarrier, at(0.002)),
      newTask('haul1', templates.payload, at(0)),
      newTask('lift1', templates.lift, at(0)),
    ])
    const haul = await recommendFor(state, 'haul1')
    expect(haul.whyNot).toEqual([{ unitId: 'h1', label: 'H1', reasons: ['H1 · Payload 300 kg · needs ≥ 500 kg'] }])
    expect(haul.proposal).toBeNull()
    const lift = await recommendFor(state, 'lift1')
    expect(lift.whyNot).toEqual([
      { unitId: 'c1', label: 'C1', reasons: ['C1 · Lift 400 kg · needs ≥ 500 kg'] },
      { unitId: 'd1', label: 'D1', reasons: ['Lift not declared on Flyer'] },
    ])
    state = await run(state, { kind: 'unit.adjust', unitId: 'h1', properties: { payloadKg: 800 }, reason: 'Loaded lighter' })
    const eligible = await recommendFor(state, 'haul1')
    expect(eligible.whyNot).toEqual([])
    expect(eligible.proposal).toMatchObject({ units: [{ unitId: 'h1' }], covers: { covered: 1, needed: 1 } })
  })
})

describe('Einsatz ETAs', () => {
  const twoUnits = () => runAll(emptyState(), [
    newUnit('c1', types.roadCarrier, at(0.01)),
    newUnit('d1', types.directCarrier, at(0.02)),
    newTask('t1', templates.load, at(0), { [top]: 1, [low]: 1 }),
  ])
  const table = (cell: { readonly durationS: number | null; readonly distanceM: number | null; readonly sourceSnapM?: number; readonly destinationSnapM?: number }): TablePort & { calls: number } => {
    const port = {
      calls: 0,
      table: async (): Promise<RouteTableResult> => {
        port.calls += 1
        return {
          durationsSeconds: [[cell.durationS]],
          distancesM: [[cell.distanceM === null ? null : meters(cell.distanceM)]],
          sourceSnapsM: [meters(cell.sourceSnapM ?? 5)],
          destinationSnapsM: [meters(cell.destinationSnapM ?? 5)],
          basis: 'routed',
          provider: 'stub',
        }
      },
    }
    return port
  }
  const etaOf = (recommendation: RecommendAnswer, unitId: string) =>
    [...recommendation.proposal?.units ?? [], ...recommendation.alternatives.flatMap(entry => entry.units)].find(entry => entry.unitId === unitId)?.eta

  test('road ETAs come from one router table with turnout added; a direct unit flies a straight line; the direct router says straight-line', async () => {
    const state = await twoUnits()
    const routed = table({ durationS: 100, distanceM: 1_200 })
    const recommendation = await recommendFor(state, 't1', routed)
    expect(routed.calls).toBe(1)
    expect(etaOf(recommendation, 'c1')).toEqual({ kind: 'routed', seconds: 2 + 100, distanceM: 1_200 })
    const straight = routeDistanceMeters(pointOf(state, 'd1'), at(0))
    expect(etaOf(recommendation, 'd1')).toEqual({ kind: 'straight-line', seconds: straight / 50, distanceM: straight })
    expect(etaOf(await recommendFor(state, 't1'), 'c1')?.kind).toBe('straight-line')
  })

  test('a pair without a route has no ETA, only its straight distance, and sorts last', async () => {
    const state = await twoUnits()
    const recommendation = await recommendFor(state, 't1', table({ durationS: null, distanceM: null }))
    expect(etaOf(recommendation, 'c1')).toEqual({ kind: 'unavailable', reason: 'routing_unavailable: ETA unavailable: no route', straightDistanceM: routeDistanceMeters(pointOf(state, 'c1'), at(0)) })
    expect(unitIds(recommendation.proposal?.units)).toEqual(['d1'])
  })

  test('a unit or task more than 1 km from a road has no ETA, refused as a send of it would be', async () => {
    const state = await twoUnits()
    const straightDistanceM = routeDistanceMeters(pointOf(state, 'c1'), at(0))
    expect(etaOf(await recommendFor(state, 't1', table({ durationS: 100, distanceM: 1_200, sourceSnapM: 1_001 })), 'c1'))
      .toEqual({ kind: 'unavailable', reason: 'no_road_near_point: C1 is more than 1 km from a road', straightDistanceM })
    expect(etaOf(await recommendFor(state, 't1', table({ durationS: 100, distanceM: 1_200, destinationSnapM: 1_001 })), 'c1'))
      .toEqual({ kind: 'unavailable', reason: 'no_road_near_point: The destination is more than 1 km from a road', straightDistanceM })
    expect(etaOf(await recommendFor(state, 't1', table({ durationS: 100, distanceM: 1_200, sourceSnapM: 1_000, destinationSnapM: 1_000 })), 'c1')?.kind).toBe('routed')
  })

  test('when the router fails every road ETA is unavailable with the cause, direct units keep theirs, and road units are still proposed by fit then id', async () => {
    const failing: TablePort = { table: async () => { throw new Error('Router offline') } }
    const mixed = await recommendFor(await twoUnits(), 't1', failing)
    expect(etaOf(mixed, 'c1')?.kind).toBe('unavailable')
    expect(etaOf(mixed, 'd1')?.kind).toBe('straight-line')
    expect(unitIds(mixed.proposal?.units)).toEqual(['d1'])

    const state = await runAll(emptyState(), [
      newUnit('c1', types.roadCarrier, at(0.02)),
      newUnit('c2', types.roadCarrier, at(0.001)),
      newTask('t1', templates.load, at(0), { [top]: 1 }),
    ])
    const roadOnly = await recommendFor(state, 't1', failing)
    expect(roadOnly.proposal).toMatchObject({ covers: { covered: 1, needed: 1 }, units: [{ unitId: 'c1', eta: { kind: 'unavailable', reason: 'routing_unavailable: ETA unavailable: Router offline', straightDistanceM: routeDistanceMeters(pointOf(state, 'c1'), at(0)) } }] })
    expect(alternativeIds(roadOnly)).toEqual([['c2']])
  })
})

describe('Einsatz recommendation refusals', () => {
  test('an unknown task is not in the picture and a closed one is refused, both as Capability rejections', async () => {
    const state = await runAll(emptyState(), [newTask('n1', templates.report, at(0)), { kind: 'task.close', taskId: 'n1' }])
    const reasonOf = (taskId: string) => recommendFor(state, taskId).then(() => { throw new Error('expected a refusal') }, (error: Error & { readonly code?: string }) => ({ code: error.code, refusal: refusalCode(error.message) }))
    expect(await reasonOf('ghost')).toEqual({ code: 'capability_target_not_found', refusal: 'not_in_picture' })
    expect(await reasonOf('n1')).toEqual({ code: 'capability_input_rejected', refusal: 'task_closed' })
  })
})
