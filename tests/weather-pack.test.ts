import { describe, expect, test } from 'bun:test'
import type { ActorId, CommandEnvelope, CommandId, ControlInstanceId, DomainId, GeoJsonPolygon, IsoTimestamp } from '../src/core/model/index.ts'
import { geoPointFromLonLat, nowIso } from '../src/core/model/index.ts'
import { createWeatherAreaCommandKind } from '../src/packs/weather/commands.ts'
import {
  createWeatherSparseField,
  updateWeatherSparseField,
  weatherCellForPoint,
  weatherSampleAtPointFromSparseField,
  weatherSparseFieldStats,
  type WeatherGridDefinition,
} from '../src/packs/weather/cell-field.ts'
import { hexResolution } from '../src/core/spatial/index.ts'
import { defaultAtmosphere, defaultSurface, evolveWeatherData, weatherSampleAtPoint } from '../src/packs/weather/conditions.ts'
import { weatherDomainDataSchema } from '../src/packs/weather/model.ts'
import { weatherPack } from '../src/packs/weather/pack.ts'
import { createLocalWeatherSimulationAdapter } from '../src/packs/weather/sim/adapter.ts'
import { weatherSimProviderId } from '../src/packs/weather/sim/constants.ts'
import { osloAmbulanceScenario } from '../src/scenarios/index.ts'
import type { PackMapAreaFeature } from '../src/core/packs/protocol.ts'

const controlInstanceId = 'control-instance:weather-pack' as ControlInstanceId
const actorId = 'actor:test-operator' as ActorId

const command = (payload: unknown): CommandEnvelope => ({
  id: `command:${crypto.randomUUID()}` as CommandId,
  controlInstanceId,
  actorId,
  kind: createWeatherAreaCommandKind,
  targetObjectIds: [],
  payload,
  issuedAt: nowIso(),
})

const osloViewport: GeoJsonPolygon = {
  type: 'Polygon',
  coordinates: [[
    geoPointFromLonLat(10.62, 59.88).coordinates,
    geoPointFromLonLat(10.88, 59.88).coordinates,
    geoPointFromLonLat(10.88, 59.98).coordinates,
    geoPointFromLonLat(10.62, 59.98).coordinates,
    geoPointFromLonLat(10.62, 59.88).coordinates,
  ]],
}

const osloWeatherGrid: WeatherGridDefinition = {
  gridId: 'weather-grid:oslo-test',
  truthResolution: hexResolution(8),
}

const polygonBounds = (polygons: ReadonlyArray<{ readonly coordinates: ReadonlyArray<ReadonlyArray<readonly [number, number]>> }>) => {
  const coordinates = polygons.flatMap(polygon => polygon.coordinates.flatMap(ring => ring))
  if (coordinates.length === 0) throw new Error('expected polygon coordinates')
  return coordinates.reduce((bounds, coordinate) => ({
    west: Math.min(bounds.west, coordinate[0]),
    south: Math.min(bounds.south, coordinate[1]),
    east: Math.max(bounds.east, coordinate[0]),
    north: Math.max(bounds.north, coordinate[1]),
  }), {
    west: Number.POSITIVE_INFINITY,
    south: Number.POSITIVE_INFINITY,
    east: Number.NEGATIVE_INFINITY,
    north: Number.NEGATIVE_INFINITY,
  })
}

const polygonCentroid = (polygon: { readonly coordinates: ReadonlyArray<ReadonlyArray<readonly [number, number]>> }) => {
  const ring = polygon.coordinates[0]
  if (!ring || ring.length === 0) throw new Error('expected polygon ring')
  const unique = ring.slice(0, -1)
  const sum = unique.reduce((acc, coordinate) => ({
    lon: acc.lon + coordinate[0],
    lat: acc.lat + coordinate[1],
  }), { lon: 0, lat: 0 })
  return { lon: sum.lon / unique.length, lat: sum.lat / unique.length }
}

const weatherMapFeatures = async (config: {
  readonly viewport: GeoJsonPolygon
  readonly zoom: number
}): Promise<ReadonlyArray<PackMapAreaFeature>> => {
  const adapter = createLocalWeatherSimulationAdapter()
  const connection = await adapter.connect({ controlInstanceId, scenario: {
    scenarioId: osloAmbulanceScenario.id,
    providerIds: [weatherSimProviderId],
    world: osloAmbulanceScenario.world,
    initialObjects: osloAmbulanceScenario.initialObjects,
    providerConfigs: {},
    providerConfig: {},
  } })
  try {
    const response = await connection.query({
      packId: 'weather',
      kind: 'weather.mapFeatures',
      payload: {
        viewport: config.viewport,
        zoom: config.zoom,
        layers: ['baseGrid', 'affectedCells', 'influenceShapes'],
      },
    })
    if (!response.ok) throw new Error(response.reason)
    const result = response.result as { readonly features: ReadonlyArray<PackMapAreaFeature> }
    return result.features
  } finally {
    await connection.close()
  }
}

describe('weather pack', () => {
  test('validates generic atmosphere and surface condition data', () => {
    const at = nowIso()
    const state = {
      atmosphere: {
        ...defaultAtmosphere(at),
        precipitation: { type: 'rain' as const, intensityMmPerHour: 0.8 },
      },
      surface: {
        ...defaultSurface(),
        wetness: 0.4,
      },
      extensions: {
        'test.blah': 0.6,
      },
    }
    const parsed = weatherDomainDataSchema.parse({
      type: 'weather_condition',
      schemaVersion: 1,
      conditionKind: 'weather_influence',
      state,
      quality: { provenance: 'scenario', confidence: 1, validAt: at },
      influence: {
        priority: 0,
        keyframes: [{
          atSeconds: 0,
          center: geoPointFromLonLat(10.7522, 59.9139),
          semiMajorAxisM: 1000,
          semiMinorAxisM: 500,
          rotationDeg: 0,
          state,
          falloffCurve: [{ x: 0, y: 1 }, { x: 1, y: 0 }],
        }],
      },
      summary: 'Light rain over the operating area',
    })

    expect(parsed.state.atmosphere.humidity).toBe(0.65)
    expect(parsed.state.surface.wetness).toBe(0.4)
    expect(parsed.state.extensions['test.blah']).toBe(0.6)
  })

  test('evolves precipitation into surface conditions without making routing decisions', () => {
    const at = '2026-01-01T10:00:00.000Z' as IsoTimestamp
    const base = weatherDomainDataSchema.parse({
      type: 'weather_condition',
      schemaVersion: 1,
      conditionKind: 'weather_influence',
      state: {
        atmosphere: {
          ...defaultAtmosphere(at),
          airTemperatureC: -1,
          precipitation: { type: 'freezing_rain', intensityMmPerHour: 1.4 },
        },
        surface: {
          ...defaultSurface(),
          groundTemperatureC: -1,
          wetness: 0.35,
        },
        extensions: {},
      },
      quality: { provenance: 'scenario', confidence: 1, validAt: at },
      influence: {
        priority: 0,
        keyframes: [{
          atSeconds: 0,
          center: geoPointFromLonLat(10.7522, 59.9139),
          semiMajorAxisM: 1000,
          semiMinorAxisM: 500,
          rotationDeg: 0,
          state: {
            atmosphere: {
              ...defaultAtmosphere(at),
              airTemperatureC: -1,
              precipitation: { type: 'freezing_rain', intensityMmPerHour: 1.4 },
            },
            surface: {
              ...defaultSurface(),
              groundTemperatureC: -1,
              wetness: 0.35,
            },
            extensions: {},
          },
          falloffCurve: [{ x: 0, y: 1 }, { x: 1, y: 0 }],
        }],
      },
      summary: 'Freezing rain test',
    })

    const evolved = evolveWeatherData(base, '2026-01-01T10:10:00.000Z' as IsoTimestamp, 600)

    expect(evolved.state.surface.ice).toBeGreaterThan(base.state.surface.ice)
    expect(evolved.state.surface.wetness).toBeLessThanOrEqual(1)
    expect(evolved.type).toBe('weather_condition')
  })

  test('built-in scenarios include the weather pack as a sampleable condition provider', () => {
    const weatherObject = osloAmbulanceScenario.initialObjects.find(object => object.domain === 'weather')
    if (!weatherObject) throw new Error('Oslo scenario missing weather condition')

    const presentation = weatherPack.presentObject(weatherObject, { objects: osloAmbulanceScenario.initialObjects })
    const parsedWeather = weatherDomainDataSchema.parse(weatherObject.domainData)

    expect(osloAmbulanceScenario.packs).toContain('weather')
    expect(presentation.categoryId).toBe('weather')
    expect(presentation.noteworthyUpdates).toBe(false)
    expect(presentation.mapIconVisible).toBe(false)
    expect(presentation.fields.map(field => field.key)).toContain('surface')
    expect(parsedWeather.render?.truthResolution).toBe(8)
    expect(parsedWeather.conditionKind).toBe('weather_influence')
    expect(weatherObject.spatial.position?.point.type).toBe('Point')
    const sample = weatherSampleAtPoint(osloAmbulanceScenario.initialObjects, geoPointFromLonLat(10.7522, 59.9139), nowIso())
    expect(sample.activeInfluenceIds.length).toBeGreaterThan(0)
    expect(['none', 'rain']).toContain(sample.state.atmosphere.precipitation.type)
  })

  test('provider-backed map query exposes H3 base grid cells for the requested viewport', async () => {
    const features = await weatherMapFeatures({ viewport: osloViewport, zoom: 12 })
    const baseGrid = features.filter(feature => feature.id.startsWith('weather-grid:'))
    const bounds = polygonBounds(baseGrid.map(feature => feature.geometry))

    expect(baseGrid.length).toBeGreaterThan(0)
    expect(bounds.west).toBeLessThanOrEqual(10.62)
    expect(bounds.east).toBeGreaterThanOrEqual(10.88)
    expect(bounds.south).toBeLessThanOrEqual(59.88)
    expect(bounds.north).toBeGreaterThanOrEqual(59.98)
  })

  test('provider-backed map query separates base grid, affected cells, and influence shapes', async () => {
    const wideViewport: GeoJsonPolygon = {
      type: 'Polygon',
      coordinates: [[
        geoPointFromLonLat(10.35, 59.72).coordinates,
        geoPointFromLonLat(11.10, 59.72).coordinates,
        geoPointFromLonLat(11.10, 60.10).coordinates,
        geoPointFromLonLat(10.35, 60.10).coordinates,
        geoPointFromLonLat(10.35, 59.72).coordinates,
      ]],
    }
    const features = await weatherMapFeatures({ viewport: wideViewport, zoom: 12 })
    const baseGrid = features.filter(feature => feature.id.startsWith('weather-grid:'))
    const affectedCells = features.filter(feature => feature.id.startsWith('weather-cell:'))
    const influenceShapes = features.filter(feature => feature.id.startsWith('weather:'))

    expect(baseGrid.length).toBeGreaterThan(0)
    expect(affectedCells.length).toBeGreaterThan(0)
    expect(influenceShapes.length).toBeGreaterThan(0)
    expect(baseGrid.length).toBeLessThanOrEqual(4_000)
    expect(affectedCells.length).toBeLessThanOrEqual(8_000)
  })

  test('moving weather influence shapes follow simulation time', async () => {
    const start = osloAmbulanceScenario.world.startsAt
    if (!start) throw new Error('expected Oslo scenario start time')
    const later = new Date(Date.parse(start) + 420_000).toISOString() as IsoTimestamp
    const adapter = createLocalWeatherSimulationAdapter()
    const connection = await adapter.connect({ controlInstanceId, scenario: {
      scenarioId: osloAmbulanceScenario.id,
      providerIds: [weatherSimProviderId],
      world: osloAmbulanceScenario.world,
      initialObjects: osloAmbulanceScenario.initialObjects,
      providerConfigs: {},
      providerConfig: {},
    } })
    await connection.setClock({ currentTime: start, updatedAt: nowIso(), paused: true, speed: 1 })
    const startResponse = await connection.query({
      packId: 'weather',
      kind: 'weather.mapFeatures',
      payload: { viewport: osloViewport, zoom: 12, layers: ['influenceShapes'], at: start, animationDurationMs: 2000 },
    })
    await connection.setClock({ currentTime: later, updatedAt: nowIso(), paused: true, speed: 1 })
    const laterResponse = await connection.query({
      packId: 'weather',
      kind: 'weather.mapFeatures',
      payload: { viewport: osloViewport, zoom: 12, layers: ['influenceShapes'] },
    })
    await connection.close()
    if (!startResponse.ok) throw new Error(startResponse.reason)
    if (!laterResponse.ok) throw new Error(laterResponse.reason)
    const startFeatures = (startResponse.result as { readonly features: ReadonlyArray<PackMapAreaFeature> }).features
    const laterFeatures = (laterResponse.result as { readonly features: ReadonlyArray<PackMapAreaFeature> }).features
    const startOuter = startFeatures.find(feature => feature.id === 'weather:weather:oslo-moving-rain-band')
    const laterOuter = laterFeatures.find(feature => feature.id === 'weather:weather:oslo-moving-rain-band')
    if (!startOuter || !laterOuter) throw new Error('expected moving weather influence features')
    const startCenter = polygonCentroid(startOuter.geometry)
    const laterCenter = polygonCentroid(laterOuter.geometry)

    expect(laterCenter.lon).toBeGreaterThan(startCenter.lon + 0.1)
    expect(startOuter.animation?.fromTime).toBe(start)
    expect(startOuter.animation?.toGeometry.coordinates.length).toBe(startOuter.geometry.coordinates.length)
  })

  test('sparse field default query is global without materializing cells', () => {
    const at = '2026-01-01T10:00:00.000Z' as IsoTimestamp
    const field = createWeatherSparseField(osloWeatherGrid)
    const sample = weatherSampleAtPointFromSparseField({
      field,
      point: geoPointFromLonLat(-73.9857, 40.7484),
      at,
    })

    expect(weatherSparseFieldStats(field)).toEqual({ cellCount: 0, activeCellCount: 0 })
    expect(sample.activeInfluenceIds).toHaveLength(0)
    expect(sample.state.atmosphere.airTemperatureC).toBe(defaultAtmosphere(at).airTemperatureC)
    expect(sample.state.surface.wetness).toBe(defaultSurface().wetness)
  })

  test('sparse field materializes only cells touched by weather objects', () => {
    const start = osloAmbulanceScenario.world.startsAt
    if (!start) throw new Error('expected Oslo scenario start time')
    const field = createWeatherSparseField(osloWeatherGrid)
    const updated = updateWeatherSparseField({
      field,
      objects: osloAmbulanceScenario.initialObjects,
      at: start,
      elapsedSeconds: 60,
    })

    expect(updated.field.cells.size).toBeGreaterThan(0)
    expect(updated.field.activeCellIds.size).toBeGreaterThan(0)
    expect(updated.touchedCellIds.size).toBe(updated.field.cells.size)
  })

  test('sparse field preserves surface memory after a weather object moves away', () => {
    const start = osloAmbulanceScenario.world.startsAt
    if (!start) throw new Error('expected Oslo scenario start time')
    const startField = updateWeatherSparseField({
      field: createWeatherSparseField(osloWeatherGrid),
      objects: osloAmbulanceScenario.initialObjects,
      at: start,
      elapsedSeconds: 180,
    }).field
    const rememberedCell = [...startField.cells.values()].find(cell => cell.state.surface.wetness > defaultSurface().wetness)
    if (!rememberedCell) throw new Error('expected rain band to wet at least one weather cell')
    const later = new Date(Date.parse(start) + 900_000).toISOString() as IsoTimestamp
    const laterField = updateWeatherSparseField({
      field: startField,
      objects: osloAmbulanceScenario.initialObjects,
      at: later,
      elapsedSeconds: 60,
    }).field
    const remembered = laterField.cells.get(rememberedCell.id)

    expect(remembered).toBeDefined()
    expect(remembered?.state.surface.wetness).toBeGreaterThan(defaultSurface().wetness)
  })

  test('stable non-default sparse cells remain queryable without staying active', () => {
    const at = '2026-01-01T10:00:00.000Z' as IsoTimestamp
    const point = geoPointFromLonLat(10.7522, 59.9139)
    const id = weatherCellForPoint(osloWeatherGrid, point)
    const storedSurface = {
      ...defaultSurface(),
      groundTemperatureC: -8,
      snow: 0.55,
    }
    const field = {
      grid: osloWeatherGrid,
      cells: new Map([[id, {
        id,
        resolution: osloWeatherGrid.truthResolution,
        center: point,
        state: {
          atmosphere: {
            ...defaultAtmosphere(at),
            airTemperatureC: -8,
          },
          surface: storedSurface,
          extensions: {},
        },
        activeInfluenceIds: [],
        residual: 0,
        updatedAt: at,
      }]]),
      activeCellIds: new Set([id]),
    }
    const updated = updateWeatherSparseField({
      field,
      objects: [],
      at,
      elapsedSeconds: 0,
    }).field
    const sample = weatherSampleAtPointFromSparseField({
      field: updated,
      point,
      at,
    })

    expect(updated.cells.has(id)).toBe(true)
    expect(updated.activeCellIds.has(id)).toBe(false)
    expect(sample.state.surface.snow).toBeGreaterThan(0.5)
  })

  test('overlapping weather objects blend through the same sparse cell update pass', () => {
    const start = osloAmbulanceScenario.world.startsAt
    if (!start) throw new Error('expected Oslo scenario start time')
    const weatherObjects = osloAmbulanceScenario.initialObjects.filter(object => object.domain === 'weather')
    expect(weatherObjects.length).toBeGreaterThanOrEqual(2)
    const updated = updateWeatherSparseField({
      field: createWeatherSparseField(osloWeatherGrid),
      objects: weatherObjects,
      at: start,
      elapsedSeconds: 60,
    }).field
    const overlapped = [...updated.cells.values()].find(cell => cell.activeInfluenceIds.length > 1)

    expect(overlapped).toBeDefined()
    expect(overlapped?.state.surface.wetness).toBeGreaterThan(defaultSurface().wetness)
  })

  test('local provider accepts real weather area commands', async () => {
    const adapter = createLocalWeatherSimulationAdapter()
    const connection = await adapter.connect({ controlInstanceId, initialObjects: [] })
    const result = await connection.sendCommand(command({
      objectType: 'weather_area',
      label: 'Operator rain area',
      center: geoPointFromLonLat(10.71, 59.91),
      semiMajorAxisM: 1800,
      semiMinorAxisM: 700,
      rotationDeg: 20,
      summary: 'Operator-created rain area',
      atmosphere: {
        precipitation: { type: 'rain', intensityMmPerHour: 1 },
      },
    }))
    const snapshot = await connection.getSnapshot()
    await connection.close()

    expect(adapter.id).toBe(weatherSimProviderId)
    expect(result.ok).toBe(true)
    expect(snapshot.objects).toHaveLength(1)
    expect(snapshot.objects[0]?.domain).toBe('weather' as DomainId)
  })

  test('local provider creates weather probes as point observations sampled from active zones', async () => {
    const adapter = createLocalWeatherSimulationAdapter()
    const zone = osloAmbulanceScenario.initialObjects.find(object => object.domain === 'weather')
    if (!zone) throw new Error('Oslo scenario missing weather condition')
    const connection = await adapter.connect({ controlInstanceId, initialObjects: [zone] })
    const result = await connection.sendCommand(command({
      objectType: 'weather_probe',
      label: 'Oslo probe',
      point: geoPointFromLonLat(10.7522, 59.9139),
    }))
    const snapshot = await connection.getSnapshot()
    await connection.close()

    const probe = snapshot.objects.find(object => object.label === 'Oslo probe')
    const parsed = weatherDomainDataSchema.parse(probe?.domainData)
    expect(result.ok).toBe(true)
    expect(probe?.spatial.position?.point.coordinates).toEqual(geoPointFromLonLat(10.7522, 59.9139).coordinates)
    expect(parsed.conditionKind).toBe('point_observation')
    expect(['none', 'rain']).toContain(parsed.state.atmosphere.precipitation.type)
  })
})
