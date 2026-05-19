import { describe, expect, test } from 'bun:test'
import type { ActorId, CommandEnvelope, CommandId, ControlInstanceId, DomainId, GeoJsonPolygon, IsoTimestamp } from '../src/core/model/index.ts'
import { geoPointFromLonLat, nowIso } from '../src/core/model/index.ts'
import { createWeatherAreaCommandKind } from '../src/packs/weather/commands.ts'
import { defaultAtmosphere, defaultSurface, evolveWeatherData, weatherSampleAtPoint } from '../src/packs/weather/conditions.ts'
import { renderedWeatherCellsForViewport, weatherCellsForViewport } from '../src/packs/weather/field.ts'
import { weatherDomainDataSchema } from '../src/packs/weather/model.ts'
import { weatherPack } from '../src/packs/weather/pack.ts'
import { createLocalWeatherSimulationAdapter } from '../src/packs/weather/sim/adapter.ts'
import { weatherSimProviderId } from '../src/packs/weather/sim/constants.ts'
import { osloAmbulanceScenario } from '../src/scenarios/index.ts'

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

describe('weather pack', () => {
  test('validates generic atmosphere and surface condition data', () => {
    const at = nowIso()
    const parsed = weatherDomainDataSchema.parse({
      type: 'weather_condition',
      schemaVersion: 1,
      conditionKind: 'weather_influence',
      severity: 'notice',
      atmosphere: {
        ...defaultAtmosphere(at),
        precipitation: { type: 'rain', intensityMmPerHour: 0.8 },
      },
      surface: {
        ...defaultSurface(),
        wetness: 0.4,
        frictionClass: 'wet',
        labels: ['wet'],
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
              precipitation: { type: 'rain', intensityMmPerHour: 0.8 },
            },
            surface: {
              ...defaultSurface(),
              wetness: 0.4,
              frictionClass: 'wet',
              labels: ['wet'],
            },
          },
          falloffCurve: [{ x: 0, y: 1 }, { x: 1, y: 0 }],
        }],
      },
      summary: 'Light rain over the operating area',
    })

    expect(parsed.atmosphere.humidity).toBe(0.65)
    expect(parsed.surface.wetness).toBe(0.4)
  })

  test('evolves precipitation into surface conditions without making routing decisions', () => {
    const at = '2026-01-01T10:00:00.000Z' as IsoTimestamp
    const base = weatherDomainDataSchema.parse({
      type: 'weather_condition',
      schemaVersion: 1,
      conditionKind: 'weather_influence',
      severity: 'notice',
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
          },
          falloffCurve: [{ x: 0, y: 1 }, { x: 1, y: 0 }],
        }],
      },
      summary: 'Freezing rain test',
    })

    const evolved = evolveWeatherData(base, '2026-01-01T10:10:00.000Z' as IsoTimestamp, 600)

    expect(evolved.surface.ice).toBeGreaterThan(base.surface.ice)
    expect(evolved.surface.frictionClass).not.toBe('normal')
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
    expect(presentation.fields.map(field => field.key)).toContain('surface')
    expect(parsedWeather.render?.cellSizeM).toBe(750)
    expect(parsedWeather.conditionKind).toBe('weather_influence')
    expect(weatherObject.spatial.position?.point.type).toBe('Point')
    const sample = weatherSampleAtPoint(osloAmbulanceScenario.initialObjects, geoPointFromLonLat(10.7522, 59.9139), nowIso())
    expect(sample.sourceObjectIds.length).toBeGreaterThan(0)
    expect(['none', 'rain']).toContain(sample.atmosphere.precipitation.type)
  })

  test('pack-owned hex field covers the requested viewport', () => {
    const start = osloAmbulanceScenario.world.startsAt
    if (!start) throw new Error('expected Oslo scenario start time')
    const hexes = weatherCellsForViewport({
      objects: osloAmbulanceScenario.initialObjects,
      viewport: osloViewport,
      zoom: 12,
      at: start,
    })
    const bounds = polygonBounds(hexes.map(cell => cell.polygon))

    expect(hexes.length).toBeGreaterThan(0)
    expect(bounds.west).toBeLessThanOrEqual(10.62)
    expect(bounds.east).toBeGreaterThanOrEqual(10.88)
    expect(bounds.south).toBeLessThanOrEqual(59.88)
    expect(bounds.north).toBeGreaterThanOrEqual(59.98)
  })

  test('rendered weather field limits map overlay cells without weakening truth sampling', () => {
    const start = osloAmbulanceScenario.world.startsAt
    if (!start) throw new Error('expected Oslo scenario start time')
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
    const truthCells = weatherCellsForViewport({
      objects: osloAmbulanceScenario.initialObjects,
      viewport: wideViewport,
      zoom: 12,
      at: start,
    })
    const renderedCells = renderedWeatherCellsForViewport({
      objects: osloAmbulanceScenario.initialObjects,
      viewport: wideViewport,
      zoom: 12,
      at: start,
    })

    expect(truthCells.length).toBeGreaterThan(1_000)
    expect(renderedCells.length).toBeGreaterThan(0)
    expect(renderedCells.length).toBeLessThan(truthCells.length / 10)
  })

  test('moving weather influence shapes follow simulation time', () => {
    const start = osloAmbulanceScenario.world.startsAt
    if (!start) throw new Error('expected Oslo scenario start time')
    const later = new Date(Date.parse(start) + 420_000).toISOString() as IsoTimestamp
    const startFeatures = weatherPack.mapAreaFeatures?.({
      objects: osloAmbulanceScenario.initialObjects,
      currentTime: start,
      map: { viewport: osloViewport, zoom: 12 },
    }) ?? []
    const laterFeatures = weatherPack.mapAreaFeatures?.({
      objects: osloAmbulanceScenario.initialObjects,
      currentTime: later,
      map: { viewport: osloViewport, zoom: 12 },
    }) ?? []
    const startOuter = startFeatures.find(feature => feature.id === 'weather:weather:oslo-moving-rain-band:influence:4')
    const laterOuter = laterFeatures.find(feature => feature.id === 'weather:weather:oslo-moving-rain-band:influence:4')
    if (!startOuter || !laterOuter) throw new Error('expected moving weather influence features')
    const startCenter = polygonCentroid(startOuter.geometry)
    const laterCenter = polygonCentroid(laterOuter.geometry)

    expect(laterCenter.lon).toBeGreaterThan(startCenter.lon + 0.1)
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
      severity: 'notice',
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
    expect(['none', 'rain']).toContain(parsed.atmosphere.precipitation.type)
  })
})
