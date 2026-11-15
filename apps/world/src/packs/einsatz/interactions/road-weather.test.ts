import { describe, expect, test } from 'bun:test'
import { nowIso, type IsoTimestamp, type SimulationRunId } from '../../../core/model/index.ts'
import { createSimulationClock } from '../../../core/model/time.ts'
import { compileScenarioDefinition } from '../../../core/scenarios/compiler.ts'
import { createDirectRoutingAdapter } from '../../../routing/direct-adapter.ts'
import type { PackRuntimeAdapter, PackRuntimeQueries } from '../../../simulation/protocol.ts'
import { unrestrictedQueryReadPolicy } from '../../../simulation/query-read-policy.ts'
import { createRuntimeHub } from '../../../simulation/runtime-hub.ts'
import { weatherPack } from '../../weather/pack.ts'
import { createLocalWeatherPackRuntimeAdapter } from '../../weather/sim/adapter.ts'
import { weatherSimRuntimeId } from '../../weather/sim/constants.ts'
import { einsatzQueryIds } from '../capabilities.ts'
import { motionOf, type EngineState } from '../engine/model.ts'
import { foggyWeather } from '../fixtures/cross-pack.ts'
import { at, config, emptyState, low, newTask, newUnit, runAll, start, templates, types } from '../fixtures/engine-harness.ts'
import fixture from '../fixtures/engine.config.json'
import { definitionOf, lonLat, taskItem, unitItem } from '../fixtures/run-harness.ts'
import { einsatzPackId, einsatzRuntimeId } from '../ids.ts'
import { einsatzPack } from '../pack.ts'
import { recommend } from '../recommend.ts'
import type { RecommendAnswer } from '../recommendation-schema.ts'
import { createEinsatzPackRuntimeAdapter } from '../runtime/adapter.ts'
import { openViewer } from '../viewer.ts'
import { roadWeatherImpact, roadWeatherQueryId, withRoadWeather, type RoadWeatherSample } from './road-weather.ts'

/**
 * Decision 3 (plan D.5): with the Weather Pack in the Run, Weather's ground
 * and visibility at a road unit's position become its route impact through
 * the engine's `setRouteImpacts`, so ETAs and `world.einsatz.recommend`
 * reflect the weather. Units that fly straight lines are not slowed.
 */

const routing = createDirectRoutingAdapter()
const sample = (conditions: { readonly wetness?: number; readonly ice?: number; readonly snow?: number; readonly visibilityM?: number }, validAt = new Date(start).toISOString()): RoadWeatherSample => ({
  state: { atmosphere: { visibilityM: conditions.visibilityM ?? 12_000 }, surface: { wetness: conditions.wetness ?? 0, ice: conditions.ice ?? 0, snow: conditions.snow ?? 0 } },
  quality: { validAt },
})

/** A Weather provider answering the same conditions at every point asked. */
const weatherEverywhere = (answer: RoadWeatherSample): PackRuntimeQueries => ({
  has: capabilityId => capabilityId === roadWeatherQueryId,
  invoke: async query => (query.input as { readonly points: ReadonlyArray<unknown> }).points.map(point => ({ point, sample: answer })),
})

const field = (): Promise<EngineState> => runAll(emptyState(), [
  newUnit('c1', types.roadCarrier, at(0)),
  newUnit('d1', types.directCarrier, at(0)),
  newTask('t1', templates.load, at(0.02), { [low]: 1 }),
])

/** The road carrier's turnout, which weather does not slow. */
const turnoutS = config.unitTypes.find(type => type.id === types.roadCarrier)!.components.mobility!.mobilizeS

const roadWeatherOn = (state: EngineState, unitId: string) =>
  motionOf(state, unitId).impacts.filter(impact => impact.source.kind === 'runtime' && impact.source.id === 'einsatz.road-weather')

/** A unit's ETA in a recommendation, proposed or offered as an alternative. */
const etaOf = (answer: RecommendAnswer, unitId: string): number => {
  const entry = [...answer.proposal?.units ?? [], ...answer.alternatives.flatMap(alternative => alternative.units)].find(candidate => candidate.unitId === unitId)
  if (entry === undefined || entry.eta.kind === 'unavailable') throw new Error(`${unitId} has no ETA in the recommendation`)
  return entry.eta.seconds
}

describe('Einsatz road weather', () => {
  test('the slowest of wet ground, ice, snow and low visibility sets the pace; dry and clear weather slows nothing', () => {
    expect(roadWeatherImpact(sample({}))).toBeUndefined()
    expect(roadWeatherImpact(sample({ wetness: 1 }))).toMatchObject({ speedFactor: 0.8, severity: 'low' })
    expect(roadWeatherImpact(sample({ ice: 1 }))).toMatchObject({ speedFactor: 0.35, severity: 'high' })
    expect(roadWeatherImpact(sample({ snow: 0.5 }))?.speedFactor).toBeCloseTo(0.775, 6)
    expect(roadWeatherImpact(sample({ wetness: 1, visibilityM: 700 }))).toEqual({
      source: { kind: 'runtime', id: 'einsatz.road-weather' },
      label: 'Road weather: 50% speed (wet 100%, ice 0%, snow 0%, visibility 700 m)',
      severity: 'moderate',
      speedFactor: 0.5,
      updatedAt: new Date(start).toISOString() as IsoTimestamp,
    })
  })

  test('each road unit takes the weather at its position as its route impact; a direct unit is not slowed, and without Weather nothing changes', async () => {
    const state = await field()
    expect(await withRoadWeather(state, undefined)).toBe(state)
    expect(await withRoadWeather(state, { has: () => false, invoke: async () => { throw new Error('not asked') } })).toBe(state)
    const foggy = await withRoadWeather(state, weatherEverywhere(sample({ visibilityM: 700 })))
    expect(roadWeatherOn(foggy, 'c1').map(impact => impact.speedFactor)).toEqual([0.5])
    expect(motionOf(foggy, 'd1').impacts).toEqual([])
    // A later sample that slows the unit the same way changes nothing; clear weather lifts the impact.
    expect(await withRoadWeather(foggy, weatherEverywhere(sample({ visibilityM: 700 }, new Date(start + 60_000).toISOString())))).toBe(foggy)
    expect(motionOf(await withRoadWeather(foggy, weatherEverywhere(sample({}))), 'c1').impacts).toEqual([])
  })

  test('a Weather answer for other points than asked is an error, never applied', async () => {
    const state = await field()
    await expect(withRoadWeather(state, { has: () => true, invoke: async () => [] })).rejects.toThrow('Weather answered 0 samples for 1 road units')
    await expect(withRoadWeather(state, { has: () => true, invoke: async () => [{ point: { type: 'Point', coordinates: lonLat(1) }, sample: sample({}) }] }))
      .rejects.toThrow("Weather answered for another point than C1's")
  })

  test('recommend gives a road unit in fog its ETA at the slowed pace, turnout unchanged; the direct unit\'s ETA stays', async () => {
    const state = await field()
    const foggy = await withRoadWeather(state, weatherEverywhere(sample({ visibilityM: 700 })))
    const clear = await recommend({ state, viewer: openViewer, taskId: 't1', routing })
    const fog = await recommend({ state: foggy, viewer: openViewer, taskId: 't1', routing })
    expect(etaOf(fog, 'c1') - turnoutS).toBeCloseTo((etaOf(clear, 'c1') - turnoutS) / 0.5, 6)
    expect(etaOf(fog, 'd1')).toBe(etaOf(clear, 'd1'))
  })

  test('in a Run with the Weather Pack, the runtime reads Weather as it advances: the road unit\'s object carries the impact and recommend slows by it', async () => {
    const items = [unitItem('c1', types.roadCarrier, lonLat(0)), unitItem('d1', types.directCarrier, lonLat(0)), taskItem('t1', templates.load, lonLat(0.02), { [low]: 1 })]
    const definition = { ...definitionOf(items), packs: [foggyWeather, { id: einsatzPackId, config: fixture, items }] }
    const compiled = await compileScenarioDefinition(definition, [weatherPack, einsatzPack], { routing })
    const recommendIn = async (adapters: ReadonlyArray<PackRuntimeAdapter>) => {
      const clock = createSimulationClock({ currentTime: compiled.world.startsAt, updatedAt: nowIso(), paused: true })
      const connection = await createRuntimeHub(adapters).connect({
        simulationRunId: 'run-einsatz-road-weather' as SimulationRunId,
        runClock: clock,
        scenario: {
          scenarioId: compiled.id,
          runtimeIds: adapters.map(adapter => adapter.id),
          world: compiled.world,
          initialObjects: compiled.initialObjects,
          connections: [],
          runtimeConfigByRuntimeId: { [weatherSimRuntimeId]: compiled.packConfigs.weather, [einsatzRuntimeId]: compiled.packConfigs[einsatzPackId] },
          runtimeConfig: {},
        },
      })
      try {
        await connection.setClock(clock.read())
        const objects = (await connection.getSnapshot()).objects
        const answer = await connection.invokeQuery({ capabilityId: einsatzQueryIds.recommend, input: { taskId: 't1' }, readPolicy: unrestrictedQueryReadPolicy }) as RecommendAnswer
        return { objects, answer, health: connection.health?.().map(entry => entry.state).sort() }
      } finally {
        await connection.close()
      }
    }
    const withWeather = await recommendIn([createLocalWeatherPackRuntimeAdapter(), createEinsatzPackRuntimeAdapter({ routing })])
    const without = await recommendIn([createEinsatzPackRuntimeAdapter({ routing })])
    expect(withWeather.health).toEqual(['ready', 'ready'])
    const road = withWeather.objects.find(object => object.id === 'c1')!
    expect(road.spatial.route?.impacts).toMatchObject([{ source: { kind: 'runtime', id: 'einsatz.road-weather' }, speedFactor: 0.5 }])
    expect(withWeather.objects.find(object => object.id === 'd1')!.spatial.route).toBeUndefined()
    expect(without.objects.find(object => object.id === 'c1')!.spatial.route).toBeUndefined()
    expect(etaOf(withWeather.answer, 'c1') - turnoutS).toBeCloseTo((etaOf(without.answer, 'c1') - turnoutS) / 0.5, 6)
    expect(etaOf(withWeather.answer, 'd1')).toBe(etaOf(without.answer, 'd1'))
  })
})
