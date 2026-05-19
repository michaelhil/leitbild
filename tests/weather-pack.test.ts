import { describe, expect, test } from 'bun:test'
import type { ActorId, CommandEnvelope, CommandId, ControlInstanceId, DomainId, IsoTimestamp } from '../src/core/model/index.ts'
import { geoPointFromLonLat, nowIso } from '../src/core/model/index.ts'
import { createWeatherAreaCommandKind } from '../src/packs/weather/commands.ts'
import { defaultAtmosphere, defaultSurface, evolveWeatherData, weatherSampleAtPoint } from '../src/packs/weather/conditions.ts'
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
