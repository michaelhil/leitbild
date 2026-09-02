import { describe, expect, test } from 'bun:test'
import {
  commandEnvelopeSchema,
  geoPointFromLonLat,
  geoJsonPolygonSchema,
  nowIso,
  type CommandEnvelope,
  type IsoTimestamp,
  type SimulationRunId,
  type OperationalObject,
} from '../src/core/model/index.ts'
import {
  advanceWeather,
  checkpointWeatherField,
  createWeatherField,
  interveneGround,
  sampleWeather,
  setWeatherObjects,
} from '../src/packs/weather/cell-field.ts'
import {
  weatherItemSchema,
  weatherPackConfigSchema,
  weatherPackDataSchema,
  weatherSampleSchema,
} from '../src/packs/weather/model.ts'
import { createWeatherObject } from '../src/packs/weather/scenario.ts'
import { frameAt } from '../src/packs/weather/influence.ts'
import { createLocalWeatherPackRuntimeAdapter } from '../src/packs/weather/sim/adapter.ts'
import {
  hexCellAtPoint,
  hexCellBoundary,
  hexCellCenter,
  hexCellsForPolygon,
  hexResolution,
} from '../src/core/spatial/index.ts'
import { answerWeatherQuery, weatherQueryCapabilities } from '../src/packs/weather/query.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { weatherPack } from '../src/packs/weather/pack.ts'
import { formatWeatherQuantity } from '../src/packs/weather/quantities.ts'
import { testRuntimeConnectionConfig } from './helpers.ts'

const at = '2026-01-01T00:00:00.000Z' as IsoTimestamp
const later = (seconds: number) => new Date(Date.parse(at) + seconds * 1000).toISOString() as IsoTimestamp
const point = geoPointFromLonLat(10.7522, 59.9139)
const settings = weatherPackConfigSchema.parse({})
const area = (extra: Record<string, unknown> = {}) =>
  weatherItemSchema.parse({
    pack: 'weather',
    type: 'weather_area',
    id: 'weather:rain',
    label: 'Rain',
    center: point.coordinates,
    semiMajorAxisM: 1500,
    semiMinorAxisM: 1500,
    falloff: 'uniform',
    atmosphere: { precipitation: { type: 'rain', intensityMmPerHour: 30 } },
    ...extra,
  })
const object = (extra: Record<string, unknown> = {}) => createWeatherObject(area(extra), at, settings)
const fieldWith = (objects = [object()]) => {
  const field = createWeatherField(settings, at)
  setWeatherObjects(field, objects)
  return field
}
const polygon = (west: number, south: number, east: number, north: number) =>
  geoJsonPolygonSchema.parse({
    type: 'Polygon',
    coordinates: [
      [
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ],
    ],
  })
const envelope = (kind: string, payload: unknown): CommandEnvelope =>
  commandEnvelopeSchema.parse({
    id: 'command:' + crypto.randomUUID(),
    actorId: 'actor:test',
    simulationRunId: 'run-test',
    kind,
    targetObjectIds: [],
    issuedAt: nowIso(),
    payload,
  }) as CommandEnvelope
const connect = (objects: OperationalObject[] = [], extra: Record<string, unknown> = {}) => {
  const config = testRuntimeConnectionConfig({
    simulationRunId: 'run-test' as SimulationRunId,
    runtimeIds: ['weather.local'],
  })
  return createLocalWeatherPackRuntimeAdapter().connect({
    ...config,
    ...extra,
    scenario: { ...config.scenario, initialObjects: objects },
  })
}

describe('authoritative Weather field', () => {
  test('display formatting stays compact without rounding query data', () => {
    expect(formatWeatherQuantity(0.3943925115, 'fraction')).toBe('39%')
    expect(formatWeatherQuantity(-1.950311201, '°C')).toBe('-1.95 °C')
    expect(formatWeatherQuantity('freezing_rain', '')).toBe('freezing rain')
  })
  test('authored areas and probes share the live schema and discoverable catalog', () => {
    const catalog = scenarioAuthoringCatalogFor([weatherPack])
    expect(catalog.packs[0]?.itemTypes.map((t) => t.id)).toEqual(['weather_area', 'weather_probe'])
    expect(() => area({ surface: { wetness: 1 } })).toThrow()
    expect(() => area({ type: 'weather_condition' })).toThrow()
    expect(() => weatherPackConfigSchema.parse({ gridResolution: 12 })).toThrow()
    expect(weatherPackConfigSchema.parse({ gridResolution: 0 }).gridResolution).toBe(0)
  })
  test('rejects unordered keyframes and missing starting quantities', () => {
    expect(() => area({ keyframes: [{ atSeconds: 20 }, { atSeconds: 10 }] })).toThrow('increasing')
    expect(() => area({ keyframes: [{ atSeconds: 10, atmosphere: { windSpeedMps: 10 } }] })).toThrow('starting')
  })
  test('interpolates only explicit quantities and uses shortest wind rotation', () => {
    const definition = area({
      atmosphere: { windSpeedMps: 5, windDirectionDeg: 350 },
      keyframes: [{ atSeconds: 10, atmosphere: { windSpeedMps: 15, windDirectionDeg: 10 } }],
    })
    if (definition.type !== 'weather_area') throw Error()
    const frame = frameAt(
      { objectId: definition.id, label: definition.label, area: definition, startsAt: at },
      later(5),
    )
    expect(frame.atmosphere.windSpeedMps).toBe(10)
    expect(frame.atmosphere.windDirectionDeg).toBe(0)
    expect(frame.atmosphere.airTemperatureC).toBeUndefined()
  })
  test('precipitation fades without pairing a nonzero rate with no precipitation', () => {
    expect(() => area({ atmosphere: { precipitation: { type: 'none', intensityMmPerHour: 1 } } })).toThrow()
    const definition = area({
      atmosphere: { precipitation: { type: 'none', intensityMmPerHour: 0 } },
      keyframes: [{ atSeconds: 10, atmosphere: { precipitation: { type: 'rain', intensityMmPerHour: 10 } } }],
    })
    if (definition.type !== 'weather_area') throw Error()
    expect(frameAt({ objectId: definition.id, label: definition.label, area: definition, startsAt: at }, later(2)).atmosphere.precipitation)
      .toEqual({ type: 'rain', intensityMmPerHour: 2 })
    const field = fieldWith([object({ falloff: 'linear' })])
    const edgePoint = geoPointFromLonLat(point.coordinates[0], point.coordinates[1] + 1000 / 111320)
    const sample = weatherSampleSchema.parse(sampleWeather(field, edgePoint))
    expect(sample.state.atmosphere.precipitation.type).toBe('rain')
    expect(sample.state.atmosphere.precipitation.intensityMmPerHour).toBeCloseTo(10)
  })
  test('zero-time observations never repeatedly blend ground state', () => {
    const field = fieldWith()
    for (let i = 0; i < 5; i++) {
      setWeatherObjects(field, [object()])
      advanceWeather(field, at)
    }
    expect(sampleWeather(field, point).state.surface.wetness).toBe(0)
    expect(sampleWeather(field, point).state.atmosphere.precipitation.intensityMmPerHour).toBe(30)
  })
  test('tick partition does not change ground physics', () => {
    const a = fieldWith(),
      b = fieldWith()
    advanceWeather(a, later(12))
    for (const t of [0.3, 1.4, 3, 6.8, 12]) advanceWeather(b, later(t))
    expect(checkpointWeatherField(b)).toEqual(checkpointWeatherField(a))
    expect(sampleWeather(a, point).state.surface.wetness).toBeGreaterThan(0)
  })
  test('restart preserves ground state and rejects incompatible checkpoints', () => {
    const field = fieldWith()
    advanceWeather(field, later(30))
    const restored = createWeatherField(settings, at, checkpointWeatherField(field))
    setWeatherObjects(restored, [object()])
    expect(sampleWeather(restored, point)).toEqual(sampleWeather(field, point))
    expect(() => createWeatherField({ ...settings, gridResolution: 7 }, at, checkpointWeatherField(field))).toThrow(
      'mismatch',
    )
  })
  test('deleting or disabling forcing retains ground history', () => {
    const field = fieldWith()
    advanceWeather(field, later(30))
    const wet = sampleWeather(field, point).state.surface.wetness
    setWeatherObjects(field, [])
    expect(sampleWeather(field, point).state.surface.wetness).toBe(wet)
    expect(sampleWeather(field, point).state.atmosphere.precipitation.type).toBe('none')
    setWeatherObjects(field, [object({ enabled: false })])
    expect(field.influences).toHaveLength(0)
  })
  test('sub-cell influence affects precise atmospheric samples without inflating ground coverage', () => {
    const field = fieldWith([object({ semiMajorAxisM: 1, semiMinorAxisM: 1 })])
    expect(sampleWeather(field, point).state.atmosphere.precipitation.type).toBe('rain')
    advanceWeather(field, later(1))
    expect(field.cells.size).toBe(0)
  })
  test('queries agree and never advance time or mutate physics', () => {
    const field = fieldWith()
    advanceWeather(field, later(3))
    const before = checkpointWeatherField(field)
    const sample = answerWeatherQuery(field, { capabilityId: 'world.weather.sample-at-point', input: { point } })
    expect(sample).toEqual(sampleWeather(field, point))
    const batch = answerWeatherQuery(field, { capabilityId: 'world.weather.sample-points', input: { points: [point] } })
    expect(batch).toEqual([{ point, sample }])
    expect(checkpointWeatherField(field)).toEqual(before)
    for (const cap of weatherQueryCapabilities) expect(cap.output).toBeDefined()
  })
  test('polygon holes exclude ground cells and huge geometry rejects before allocation', () => {
    const center = hexCellAtPoint(point, hexResolution(8))
    const outer = polygon(10.7, 59.89, 10.8, 59.94)
    const hole = polygon(10.74, 59.905, 10.77, 59.925)
    expect(
      hexCellsForPolygon(
        { ...outer, coordinates: [...outer.coordinates, ...hole.coordinates] },
        hexResolution(8),
      ).includes(center),
    ).toBe(false)
    expect(() => hexCellsForPolygon(polygon(-100, -50, 100, 50), hexResolution(11))).toThrow()
  })
  test('ground interventions are local and sampling includes unaffected background', () => {
    const field = fieldWith([])
    const cell = hexCellAtPoint(point, hexResolution(8))
    interveneGround(field, [cell], { ice: 0.8 })
    expect(sampleWeather(field, hexCellCenter(cell)).state.surface.ice).toBe(0.8)
    expect(sampleWeather(field, geoPointFromLonLat(11, 60)).state.surface.ice).toBe(0)
    const result = answerWeatherQuery(field, {
      capabilityId: 'world.weather.summarize-area',
      input: { area: hexCellBoundary(cell) },
    }) as { cellCount: number }
    expect(result.cellCount).toBeGreaterThan(0)
  })
  test('bounded routes and rewind rejection are explicit and atomic', () => {
    const field = fieldWith()
    advanceWeather(field, later(5))
    const before = checkpointWeatherField(field)
    expect(() => advanceWeather(field, at)).toThrow('backward')
    expect(() => advanceWeather(field, later(8000))).toThrow('budget')
    expect(() =>
      answerWeatherQuery(field, {
        capabilityId: 'world.weather.sample-along-route',
        input: {
          route: {
            type: 'LineString',
            coordinates: [
              [10, 59],
              [12, 60],
            ],
          },
          intervalM: 10,
        },
      }),
    ).toThrow('budget')
    expect(checkpointWeatherField(field)).toEqual(before)
  })
  test('map work is bounded and display zoom never changes physics', () => {
    const field = fieldWith()
    advanceWeather(field, later(10))
    const before = checkpointWeatherField(field)
    for (const zoom of [5, 10, 16]) {
      const result = answerWeatherQuery(field, {
        capabilityId: 'world.weather.map-features',
        input: {
          viewport: polygon(10.6, 59.8, 10.9, 60),
          zoom,
          layers: ['baseGrid', 'affectedCells', 'influenceShapes'],
        },
      })
      weatherQueryCapabilities.find((c) => c.id === 'world.weather.map-features')!.output.parse(result)
    }
    expect(checkpointWeatherField(field)).toEqual(before)
  })
})

describe('Weather runtime controls and lifecycle', () => {
  test('paused create and update immediately refresh probes at simulation time', async () => {
    const probe = createWeatherObject(
      weatherItemSchema.parse({
        pack: 'weather',
        type: 'weather_probe',
        id: 'probe:one',
        label: 'Probe',
        point: point.coordinates,
      }),
      at,
      settings,
    )
    const connection = await connect([probe])
    try {
      await connection.setClock({ currentTime: at, updatedAt: nowIso(), paused: true, speed: 1 })
      expect(
        (await connection.sendCommand(envelope('world.weather.create', area({ atmosphere: { windSpeedMps: 15 } })))).ok,
      ).toBe(true)
      const snapshot = await connection.getSnapshot()
      const sample = weatherPackDataSchema.parse(snapshot.objects.find((o) => o.id === probe.id)!.packData).sample
      expect(sample.quality.validAt).toBe(at)
      expect(sample.state.atmosphere.windSpeedMps).toBe(15)
      expect(sample).toEqual(
        weatherSampleSchema.parse(
          await connection.invokeQuery({ capabilityId: 'world.weather.sample-at-point', input: { point } }),
        ),
      )
      const obj = snapshot.objects.find((o) => o.id === 'weather:rain')!
      const result = await connection.sendCommand(
        envelope('world.weather.set-enabled', { objectId: obj.id, enabled: false, expectedRevision: obj.revision }),
      )
      expect(result.ok).toBe(true)
      expect(
        weatherSampleSchema.parse(
          await connection.invokeQuery({ capabilityId: 'world.weather.sample-at-point', input: { point } }),
        ).state.atmosphere.windSpeedMps,
      ).toBe(3)
      expect(
        (
          await connection.sendCommand(
            envelope('world.weather.set-enabled', { objectId: obj.id, enabled: true, expectedRevision: obj.revision }),
          )
        ).ok,
      ).toBe(false)
    } finally {
      await connection.close()
    }
  })
  test('private checkpoints survive close and restore', async () => {
    let stored: unknown = null
    const store = {
      load: async () => stored,
      save: async (value: unknown) => {
        stored = structuredClone(value)
      },
    }
    const connection = await connect([object()], { runtimeStateStore: store })
    await connection.setClock({ currentTime: later(20), updatedAt: nowIso(), paused: true, speed: 1 })
    const sample = await connection.invokeQuery({ capabilityId: 'world.weather.sample-at-point', input: { point } })
    const snapshot = await connection.getSnapshot()
    await connection.close()
    const restored = await connect([], { runtimeStateStore: store, initialObjects: snapshot.objects })
    try {
      expect(await restored.invokeQuery({ capabilityId: 'world.weather.sample-at-point', input: { point } })).toEqual(
        sample,
      )
    } finally {
      await restored.close()
    }
  })
  test('configured probe recording uses canonical samples and actual simulation time', async () => {
    const probe = createWeatherObject(
      weatherItemSchema.parse({
        pack: 'weather',
        type: 'weather_probe',
        id: 'probe:one',
        label: 'Probe',
        point: point.coordinates,
      }),
      at,
      settings,
    )
    const connection = await connect([probe], {
      recording: { packId: 'weather', profileId: 'probes', intervalMs: 1000 },
    })
    const batches: unknown[] = []
    connection.subscribe((e) => {
      if (e.recording) batches.push(e.recording)
    })
    try {
      await connection.setClock({ currentTime: later(1), updatedAt: nowIso(), paused: true, speed: 1 })
      expect(batches.length).toBe(1)
      expect(JSON.stringify(batches)).toContain('windSpeedMps')
      expect(JSON.stringify(batches)).toContain(later(1))
    } finally {
      await connection.close()
    }
  })
})
