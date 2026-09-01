import { describe, expect, test } from 'bun:test'
import { confirmedFact, geoPointFromLonLat, nowIso, type AdapterId, type ObjectId, type OperationalObject, type PackId } from '../src/core/model/index.ts'
import { createActivePackViews } from '../src/core/packs/active-views.ts'
import { createPackPresentationComposer } from '../src/core/packs/presentation-composer.ts'
import { packField, packStatus } from '../src/core/packs/presentation.ts'
import { createScenarioCatalog } from '../src/core/scenarios/catalog.ts'
import { ambulancePack } from '../src/packs/ambulance/pack.ts'
import { ambulancePackDataSchema, hospitalPackDataSchema, type HospitalPackData } from '../src/packs/ambulance/model.ts'
import { trafficPack } from '../src/packs/traffic/pack.ts'
import { trafficSimRuntimeId } from '../src/packs/traffic/sim/constants.ts'
import { weatherPack } from '../src/packs/weather/pack.ts'
import { weatherSimRuntimeId } from '../src/packs/weather/sim/constants.ts'
import { expectFieldKeys, expectStatusIndicator } from './helpers/pack-presentation.ts'
import {
  cancelDestinationCommandKind,
  createObjectCommandKind,
  setDestinationCommandKind,
} from '../src/packs/ambulance/commands.ts'
import { ambulanceSimRuntimeId } from '../src/packs/ambulance/sim/constants.ts'
import { createAmbulanceSimEngine } from '../src/packs/ambulance/sim/engine.ts'
import { osloAmbulanceScenario } from '../src/scenarios/index.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import type { SimulationRunId } from '../src/core/model/index.ts'
import { createWorldPackDescriptor, emptyPackScenarioConfigSchema, type WorldPack, type PackObjectPresentation } from '../src/core/packs/protocol.ts'

describe('pack architecture', () => {
  test('ambulance pack builds pack commands behind the generic pack interface', () => {
    const engine = createAmbulanceSimEngine({
      simulationRunId: 'run-pack-architecture' as SimulationRunId,
      objects: osloAmbulanceScenario.initialObjects,
      routing: createDirectRoutingAdapter(),
    })
    const objects = engine.snapshot().objects
    const controller = objects.find(object => ambulancePack.targeting?.isController(object))
    const target = objects.find(object => controller && object.id !== controller.id && ambulancePack.targeting?.isTarget(controller, object, { objects }))
    if (!controller || !target) throw new Error('scenario missing pack controller or target')

    const createCommand = ambulancePack.creation!.buildCreateObjectCommand(
      'hospital',
      'Hospital 2',
      { kind: 'point', point: geoPointFromLonLat(10.75, 59.92) },
    )
    const setTargetCommand = ambulancePack.targeting!.buildSetTargetCommand(controller, target, { objects })
    const cancelCommand = ambulancePack.targeting!.buildCancelTargetCommand(controller, { objects })

    expect(createCommand.kind).toBe(createObjectCommandKind)
    expect(setTargetCommand.kind).toBe(setDestinationCommandKind)
    expect(cancelCommand.kind).toBe(cancelDestinationCommandKind)
    expect(setTargetCommand.targetObjectIds).toEqual([controller.id, target.id])
    expect(cancelCommand.targetObjectIds).toEqual([controller.id])
  })

  test('ambulance pack exposes structured fields and semantic status indicators', () => {
    const engine = createAmbulanceSimEngine({
      simulationRunId: 'run-pack-presentation' as SimulationRunId,
      objects: osloAmbulanceScenario.initialObjects,
      routing: createDirectRoutingAdapter(),
    })
    const objects = engine.snapshot().objects
    const ambulance = objects.find(object => ambulancePack.targeting?.isController(object))
    const incident = objects.find(object => object.kind === 'incident')
    const hospital = objects.find(object => object.kind === 'facility')
    if (!ambulance || !incident || !hospital) throw new Error('scenario missing ambulance presentation fixtures')

    const incidentBound: OperationalObject = {
      ...ambulance,
      tasking: { currentTaskId: incident.id as ObjectId },
      operational: { ...ambulance.operational, status: 'en_route' },
    }
    const incidentPresentation = ambulancePack.presentation.presentObject(incidentBound, { objects: [incidentBound, incident, hospital] })
    expectFieldKeys(incidentPresentation, ['destination'])
    expectStatusIndicator(incidentPresentation, { shape: 'arrow', direction: 'left', pulse: true })

    const data = ambulancePackDataSchema.parse(ambulance.packData)
    const hospitalBound: OperationalObject = {
      ...ambulance,
      tasking: { currentTaskId: hospital.id as ObjectId },
      operational: { ...ambulance.operational, status: 'en_route' },
      packData: {
        ...data,
        transport: {
          ...data.transport,
          patientsOnBoard: confirmedFact(1, nowIso(), 'scenario', 1),
        },
      },
    }
    const hospitalPresentation = ambulancePack.presentation.presentObject(hospitalBound, { objects: [hospitalBound, incident, hospital] })
    expectStatusIndicator(hospitalPresentation, { shape: 'arrow', direction: 'right', pulse: true })

    const resolvedIncident: OperationalObject = {
      ...incident,
      operational: { ...incident.operational, status: 'resolved' },
    }
    const resolvedPresentation = ambulancePack.presentation.presentObject(resolvedIncident, { objects: [ambulance, resolvedIncident, hospital] })
    expect(resolvedPresentation.status?.tone).toBe('idle')
    expect(resolvedPresentation.status?.label).toBe('Resolved')
    expect(resolvedPresentation.muted).toBe(true)
  })

  test('ambulance pack presents hospital trauma beds as available capacity', () => {
    const engine = createAmbulanceSimEngine({
      simulationRunId: 'run-hospital-capacity-presentation' as SimulationRunId,
      objects: osloAmbulanceScenario.initialObjects,
      routing: createDirectRoutingAdapter(),
    })
    const hospital = engine.snapshot().objects.find(object => object.kind === 'facility')
    if (!hospital) throw new Error('scenario missing hospital')

    const hospitalWithAvailableBeds = (availableBeds: number): OperationalObject => {
      const data = hospitalPackDataSchema.parse(hospital.packData)
      return {
        ...hospital,
        packData: {
          ...data,
          emergencyDepartment: {
            ...data.emergencyDepartment,
            traumaBedsTotal: confirmedFact(3, nowIso(), 'scenario', 1),
            traumaBedsAvailable: confirmedFact(availableBeds, nowIso(), 'scenario', 1),
          },
        } satisfies HospitalPackData,
      }
    }

    const openPresentation = ambulancePack.presentation.presentObject(hospitalWithAvailableBeds(3), { objects: [] })
    expect(openPresentation.fields.find(field => field.key === 'trauma-beds')?.value).toBe('3 / 3')
    expect(openPresentation.status?.tone).toBe('ready')
    expect(openPresentation.status?.label).toBe('Trauma beds available 3/3')

    const limitedPresentation = ambulancePack.presentation.presentObject(hospitalWithAvailableBeds(1), { objects: [] })
    expect(limitedPresentation.fields.find(field => field.key === 'trauma-beds')?.value).toBe('1 / 3')
    expect(limitedPresentation.status?.tone).toBe('working')
    expect(limitedPresentation.status?.label).toBe('Limited trauma beds available (1/3)')

    const fullPresentation = ambulancePack.presentation.presentObject(hospitalWithAvailableBeds(0), { objects: [] })
    expect(fullPresentation.fields.find(field => field.key === 'trauma-beds')?.value).toBe('0 / 3')
    expect(fullPresentation.status?.tone).toBe('error')
    expect(fullPresentation.status?.label).toBe('No trauma beds available (0/3)')
  })

  test('active Pack views reject ambiguous surfaces without inventing a composite Pack', () => {
    expect(() => createActivePackViews([ambulancePack, ambulancePack])).toThrow('duplicate Pack ids')

    const activeViews = createActivePackViews([ambulancePack, trafficPack, weatherPack])

    expect(activeViews.creation?.createObjectTypes.map(type => type.id).sort()).toEqual([
      'ambulance',
      'hospital',
      'incident',
      'traffic_area',
      'traffic_road_segment',
      'weather_area',
      'weather_probe',
    ].sort())
    expect(() => activeViews.creation?.defaultObjectLabel('missing', { objects: [] })).toThrow('unknown create object type')
  })

  test('active Pack contextual fields are detail-tier only so map and rail summaries stay cheap', () => {
    const at = nowIso()
    const object: OperationalObject = {
      id: 'object:contextual-field-target' as ObjectId,
      kind: 'facility',
      packId: 'base-pack' as PackId,
      label: 'Contextual field target',
      lifecycle: 'active',
      revision: 0,
      spatial: {
        position: {
          point: geoPointFromLonLat(10, 59),
          observedAt: at,
        },
        frame: { kind: 'wgs84' },
      },
      operational: {
        status: 'nominal',
        priority: 'normal',
        mode: 'simulated',
      },
      alerts: [],
      provenance: {
        source: 'simulator',
        adapterId: 'adapter:test' as AdapterId,
        externalId: 'object:contextual-field-target',
      },
      timestamps: {
        createdAt: at,
        updatedAt: at,
      },
      packData: {},
    }
    let contextualFieldCalls = 0
    const basePack: WorldPack = {
      descriptor: createWorldPackDescriptor({
        id: 'base-pack', version: '1.0.0', name: 'Base Pack', contributions: ['presentation'],
      }),
      scenarioConfigSchema: emptyPackScenarioConfigSchema,
      presentation: {
        categories: [{ id: 'base', label: 'Base', emptyLabel: 'No base objects', matches: candidate => candidate.packId === 'base-pack' }],
        presentObject: (): PackObjectPresentation => ({
          categoryId: 'base',
          icon: 'grid',
          color: '#64748b',
          summary: 'base',
          status: packStatus('ready', 'Ready'),
          fields: [packField('base', 'Base', 'yes')],
        }),
      },
    }
    const enrichmentPack: WorldPack = {
      ...basePack,
      descriptor: createWorldPackDescriptor({
        id: 'enrichment-pack', version: '1.0.0', name: 'Enrichment Pack', contributions: ['presentation'],
      }),
      presentation: {
        ...basePack.presentation,
        categories: [],
        contextualFields: () => {
          contextualFieldCalls += 1
          return [packField('contextual', 'Contextual', 'yes')]
        },
      },
    }
    const activeViews = createActivePackViews([basePack, enrichmentPack])

    const summaryPresentation = activeViews.presentation.presentObject(object, { objects: [object] })
    expect(contextualFieldCalls).toBe(0)
    expect(summaryPresentation.fields.map(field => field.key)).toEqual(['base'])

    const mapPresentation = activeViews.presentation.presentObject(object, {
      objects: [object],
      tier: 'map',
    })
    expect(contextualFieldCalls).toBe(0)
    expect(mapPresentation.fields.map(field => field.key)).toEqual(['base'])

    const detailPresentation = activeViews.presentation.presentObject(object, {
      objects: [object],
      tier: 'detail',
    })
    expect(contextualFieldCalls).toBe(1)
    expect(detailPresentation.fields.map(field => field.key)).toEqual(['base', 'contextual'])
  })

  test('active Pack views aggregate map-area feature activation layers once', () => {
    const packWithWeatherLayer: WorldPack = {
      ...ambulancePack,
      descriptor: createWorldPackDescriptor({
        id: 'weather-layer-one', version: '1.0.0', name: 'Weather Layer One', contributions: ['presentation'],
      }),
      presentation: { ...ambulancePack.presentation, categories: [], mapAreaFeatureLayers: ['weather'] },
    }
    const secondPackWithWeatherLayer: WorldPack = {
      ...trafficPack,
      descriptor: createWorldPackDescriptor({
        id: 'weather-layer-two', version: '1.0.0', name: 'Weather Layer Two', contributions: ['presentation'],
      }),
      presentation: { ...trafficPack.presentation, categories: [], mapAreaFeatureLayers: ['weather'] },
    }

    const activeViews = createActivePackViews([packWithWeatherLayer, secondPackWithWeatherLayer])

    expect(activeViews.presentation.mapAreaFeatureLayers).toEqual(['weather'])
  })

  test('presentation composer caches by tier and exposes pack object indexes', () => {
    let presentCalls = 0
    let indexedWeatherObjectCount = -1
    const object = osloAmbulanceScenario.initialObjects.find(candidate => candidate.packId === 'ambulance')
    if (!object) throw new Error('scenario missing ambulance object')
    const weatherObject = {
      ...object,
      id: 'weather:indexed-presenter' as ObjectId,
      packId: 'weather' as PackId,
    }
    const objects = [object, weatherObject]
    const currentTime = nowIso()
    const pack: WorldPack = {
      descriptor: createWorldPackDescriptor({
        id: 'ambulance', version: '1.0.0', name: 'Indexed Presenter', contributions: ['presentation'],
      }),
      scenarioConfigSchema: emptyPackScenarioConfigSchema,
      presentation: {
        categories: [{
          id: 'ambulances',
          label: 'Ambulances',
          emptyLabel: 'No ambulances',
          matches: candidate => candidate.id === object.id,
        }],
        presentObject: (_candidate, context): PackObjectPresentation => {
          presentCalls += 1
          indexedWeatherObjectCount = context.objectsForPack?.('weather').length ?? -1
          return {
            categoryId: 'ambulances',
            icon: 'ambulance',
            color: '#16834f',
            summary: context.tier ?? 'summary',
            fields: [packField('tier', 'Tier', context.tier ?? 'summary')],
          }
        },
      },
    }
    const activeViews = createActivePackViews([pack])
    const composer = createPackPresentationComposer({
      getContext: () => ({
        pack: activeViews,
        objects,
        currentTime,
      }),
      nowMs: () => 0,
    })

    expect(composer.present(object).summary).toBe('summary')
    expect(composer.present(object).summary).toBe('summary')
    expect(composer.present(object, { tier: 'map' }).summary).toBe('map')
    expect(presentCalls).toBe(2)
    expect(indexedWeatherObjectCount).toBe(1)
    expect(composer.diagnostics().tiers.summary.cacheHits).toBe(1)
    expect(composer.diagnostics().tiers.map.cacheMisses).toBe(1)
    composer.reset()
    expect(composer.diagnostics().cacheSize).toBe(0)
    expect(composer.diagnostics().tiers.summary.calls).toBe(0)
  })

  test('weather contextual fields use the presentation object index instead of scanning all objects', () => {
    const object = osloAmbulanceScenario.initialObjects.find(candidate => candidate.packId === 'ambulance')
    const weatherObject = osloAmbulanceScenario.initialObjects.find(candidate => candidate.packId === 'weather')
    if (!object || !weatherObject) throw new Error('scenario missing ambulance or weather object')
    let requestedPackId = ''

    const fields = weatherPack.presentation.contextualFields?.(object, {
      objects: [object],
      objectsForPack: packId => {
        requestedPackId = packId
        return [weatherObject]
      },
      currentTime: osloAmbulanceScenario.world.startsAt ?? nowIso(),
      tier: 'detail',
    }) ?? []

    expect(requestedPackId).toBe('weather')
    expect(fields.map(field => field.key)).toEqual(['weather'])
  })

  test('scenario catalog resolves scenario packs to internal pack runtimes', () => {
    const catalog = createScenarioCatalog({
      packs: [ambulancePack, trafficPack, weatherPack],
      scenarios: [osloAmbulanceScenario],
    })
    const runtime = catalog.runtimeFor('oslo-ambulance')

    expect(catalog.listScenarios()[0]?.packs).toEqual(['ambulance', 'traffic', 'weather'])
    expect(runtime?.runtimes.map(runtime => runtime.runtimeId).sort()).toEqual([
      ambulanceSimRuntimeId,
      trafficSimRuntimeId,
      weatherSimRuntimeId,
    ].sort())
    expect(runtime?.runtimeConfigByRuntimeId).toEqual({
      [ambulanceSimRuntimeId]: {},
      [trafficSimRuntimeId]: {},
      [weatherSimRuntimeId]: {
        fields: {
          extensions: {
            'research.operatorWeatherLoad': {
              type: 'number',
              unit: '0..1',
              default: 0,
              min: 0,
              max: 1,
              interpolation: 'linear',
            },
          },
        },
      },
    })
  })

  test('keeps runtime-free Packs active without inventing no-op runtimes', () => {
    const passivePack: WorldPack = {
      descriptor: createWorldPackDescriptor({
        id: 'passive', version: '1.0.0', name: 'Passive', contributions: ['presentation'],
      }),
      scenarioConfigSchema: emptyPackScenarioConfigSchema,
      presentation: {
        categories: [],
        presentObject: () => { throw new Error('passive Pack does not own objects') },
      },
    }
    const scenario = {
      ...osloAmbulanceScenario,
      id: 'passive-only',
      title: 'Passive only',
      packs: ['passive'],
      packRuntimes: {},
      packConfigs: {},
      initialObjects: [],
      surface: { schemaVersion: 1 as const, regions: [] },
    }
    const runtime = createScenarioCatalog({ packs: [passivePack], scenarios: [scenario] }).runtimeFor('passive-only')

    expect(runtime?.packs).toEqual([passivePack])
    expect(runtime?.runtimes).toEqual([])
  })

  test('scenario catalog rejects runtime selections outside the owning Pack', () => {
    expect(() => createScenarioCatalog({
      packs: [ambulancePack, trafficPack, weatherPack],
      scenarios: [{
        ...osloAmbulanceScenario,
        id: 'bad-runtime-override',
        packRuntimes: {
          ambulance: trafficSimRuntimeId,
        },
      }],
    })).toThrow('runtime traffic.local is not registered by pack ambulance')
  })
})
