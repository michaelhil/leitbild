import { describe, expect, test } from 'bun:test'
import { confirmedFact, geoPointFromLonLat, nowIso, type AdapterId, type ObjectId, type OperationalObject, type PackId } from '../src/core/model/index.ts'
import { createCompositePack } from '../src/core/packs/composite.ts'
import { createPackPresentationComposer } from '../src/core/packs/presentation-composer.ts'
import { packField, packStatus } from '../src/core/packs/presentation.ts'
import { createPackRegistry } from '../src/core/packs/registry.ts'
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
import type { ControlInstanceId } from '../src/core/model/index.ts'
import type { LeitbildPack, PackObjectPresentation } from '../src/core/packs/protocol.ts'

describe('pack architecture', () => {
  test('registers static packs by unique id', () => {
    const registry = createPackRegistry([ambulancePack])

    expect(registry.require('ambulance')).toBe(ambulancePack)
    expect(registry.list().map(pack => pack.id)).toEqual(['ambulance'])
    expect(() => createPackRegistry([ambulancePack, ambulancePack])).toThrow('duplicate pack id')
  })

  test('ambulance pack builds pack commands behind the generic pack interface', () => {
    const engine = createAmbulanceSimEngine({
      controlInstanceId: 'control-instance:pack-architecture' as ControlInstanceId,
      objects: osloAmbulanceScenario.initialObjects,
      routing: createDirectRoutingAdapter(),
    })
    const objects = engine.snapshot().objects
    const controller = objects.find(object => ambulancePack.isController(object))
    const target = objects.find(object => controller && object.id !== controller.id && ambulancePack.isTarget(controller, object, { objects }))
    if (!controller || !target) throw new Error('scenario missing pack controller or target')

    const createCommand = ambulancePack.buildCreateObjectCommand(
      'hospital',
      'Hospital 2',
      { kind: 'point', point: geoPointFromLonLat(10.75, 59.92) },
    )
    const setTargetCommand = ambulancePack.buildSetTargetCommand(controller, target, { objects })
    const cancelCommand = ambulancePack.buildCancelTargetCommand(controller, { objects })

    expect(createCommand.kind).toBe(createObjectCommandKind)
    expect(setTargetCommand.kind).toBe(setDestinationCommandKind)
    expect(cancelCommand.kind).toBe(cancelDestinationCommandKind)
    expect(setTargetCommand.targetObjectIds).toEqual([controller.id, target.id])
    expect(cancelCommand.targetObjectIds).toEqual([controller.id])
  })

  test('ambulance pack exposes structured fields and semantic status indicators', () => {
    const engine = createAmbulanceSimEngine({
      controlInstanceId: 'control-instance:pack-presentation' as ControlInstanceId,
      objects: osloAmbulanceScenario.initialObjects,
      routing: createDirectRoutingAdapter(),
    })
    const objects = engine.snapshot().objects
    const ambulance = objects.find(object => ambulancePack.isController(object))
    const incident = objects.find(object => object.kind === 'incident')
    const hospital = objects.find(object => object.kind === 'facility')
    if (!ambulance || !incident || !hospital) throw new Error('scenario missing ambulance presentation fixtures')

    const incidentBound: OperationalObject = {
      ...ambulance,
      tasking: { currentTaskId: incident.id as ObjectId },
      operational: { ...ambulance.operational, status: 'en_route' },
    }
    const incidentPresentation = ambulancePack.presentObject(incidentBound, { objects: [incidentBound, incident, hospital] })
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
    const hospitalPresentation = ambulancePack.presentObject(hospitalBound, { objects: [hospitalBound, incident, hospital] })
    expectStatusIndicator(hospitalPresentation, { shape: 'arrow', direction: 'right', pulse: true })

    const resolvedIncident: OperationalObject = {
      ...incident,
      operational: { ...incident.operational, status: 'resolved' },
    }
    const resolvedPresentation = ambulancePack.presentObject(resolvedIncident, { objects: [ambulance, resolvedIncident, hospital] })
    expect(resolvedPresentation.status?.tone).toBe('idle')
    expect(resolvedPresentation.status?.label).toBe('Resolved')
    expect(resolvedPresentation.muted).toBe(true)
  })

  test('ambulance pack presents hospital trauma beds as available capacity', () => {
    const engine = createAmbulanceSimEngine({
      controlInstanceId: 'control-instance:hospital-capacity-presentation' as ControlInstanceId,
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

    const openPresentation = ambulancePack.presentObject(hospitalWithAvailableBeds(3), { objects: [] })
    expect(openPresentation.fields.find(field => field.key === 'trauma-beds')?.value).toBe('3 / 3')
    expect(openPresentation.status?.tone).toBe('ready')
    expect(openPresentation.status?.label).toBe('Trauma beds available 3/3')

    const limitedPresentation = ambulancePack.presentObject(hospitalWithAvailableBeds(1), { objects: [] })
    expect(limitedPresentation.fields.find(field => field.key === 'trauma-beds')?.value).toBe('1 / 3')
    expect(limitedPresentation.status?.tone).toBe('working')
    expect(limitedPresentation.status?.label).toBe('Limited trauma beds available (1/3)')

    const fullPresentation = ambulancePack.presentObject(hospitalWithAvailableBeds(0), { objects: [] })
    expect(fullPresentation.fields.find(field => field.key === 'trauma-beds')?.value).toBe('0 / 3')
    expect(fullPresentation.status?.tone).toBe('error')
    expect(fullPresentation.status?.label).toBe('No trauma beds available (0/3)')
  })

  test('composite packs reject ambiguous pack surfaces', () => {
    expect(() => createCompositePack({
      id: 'duplicate-categories',
      name: 'Duplicate Categories',
      packs: [ambulancePack, ambulancePack],
    })).toThrow('duplicate object category')

    const composite = createCompositePack({
      id: 'clear-composite',
      name: 'Clear Composite',
      packs: [ambulancePack, trafficPack, weatherPack],
    })

    expect(composite.createObjectTypes.map(type => type.id).sort()).toEqual([
      'ambulance',
      'hospital',
      'incident',
      'traffic_area',
      'traffic_road_segment',
    ].sort())
    expect(() => composite.defaultObjectLabel('missing', { objects: [] })).toThrow('unknown create object type')
  })

  test('composite contextual fields are detail-tier only so map and rail summaries stay cheap', () => {
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
    const basePack: LeitbildPack = {
      id: 'base-pack',
      name: 'Base Pack',
      categories: [{ id: 'base', label: 'Base', emptyLabel: 'No base objects', matches: candidate => candidate.packId === 'base-pack' }],
      createObjectTypes: [],
      presentObject: (): PackObjectPresentation => ({
        categoryId: 'base',
        icon: 'grid',
        color: '#64748b',
        summary: 'base',
        status: packStatus('ready', 'Ready'),
        fields: [packField('base', 'Base', 'yes')],
      }),
      defaultObjectLabel: () => 'Base object',
      buildCreateObjectCommand: () => {
        throw new Error('not used')
      },
      isController: () => false,
      isTarget: () => false,
      buildSetTargetCommand: () => {
        throw new Error('not used')
      },
      buildCancelTargetCommand: () => {
        throw new Error('not used')
      },
    }
    const enrichmentPack: LeitbildPack = {
      ...basePack,
      id: 'enrichment-pack',
      name: 'Enrichment Pack',
      categories: [],
      contextualFields: () => {
        contextualFieldCalls += 1
        return [packField('contextual', 'Contextual', 'yes')]
      },
    }
    const composite = createCompositePack({
      id: 'contextual-field-composite',
      name: 'Contextual Field Composite',
      packs: [basePack, enrichmentPack],
    })

    const summaryPresentation = composite.presentObject(object, { objects: [object] })
    expect(contextualFieldCalls).toBe(0)
    expect(summaryPresentation.fields.map(field => field.key)).toEqual(['base'])

    const mapPresentation = composite.presentObject(object, {
      objects: [object],
      tier: 'map',
    })
    expect(contextualFieldCalls).toBe(0)
    expect(mapPresentation.fields.map(field => field.key)).toEqual(['base'])

    const detailPresentation = composite.presentObject(object, {
      objects: [object],
      tier: 'detail',
    })
    expect(contextualFieldCalls).toBe(1)
    expect(detailPresentation.fields.map(field => field.key)).toEqual(['base', 'contextual'])
  })

  test('composite packs aggregate map-area feature activation layers once', () => {
    const packWithWeatherLayer: LeitbildPack = {
      ...ambulancePack,
      id: 'weather-layer-one',
      name: 'Weather Layer One',
      categories: [],
      mapAreaFeatureLayers: ['weather'],
    }
    const secondPackWithWeatherLayer: LeitbildPack = {
      ...trafficPack,
      id: 'weather-layer-two',
      name: 'Weather Layer Two',
      categories: [],
      mapAreaFeatureLayers: ['weather'],
    }

    const composite = createCompositePack({
      id: 'map-area-layer-composite',
      name: 'Map Area Layer Composite',
      packs: [packWithWeatherLayer, secondPackWithWeatherLayer],
    })

    expect(composite.mapAreaFeatureLayers).toEqual(['weather'])
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
    const pack: LeitbildPack = {
      id: 'indexed-presenter',
      name: 'Indexed Presenter',
      categories: [{
        id: 'ambulances',
        label: 'Ambulances',
        emptyLabel: 'No ambulances',
        matches: candidate => candidate.id === object.id,
      }],
      createObjectTypes: [],
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
      defaultObjectLabel: () => 'Unused',
      buildCreateObjectCommand: () => {
        throw new Error('not used')
      },
      isController: () => false,
      isTarget: () => false,
      buildSetTargetCommand: () => {
        throw new Error('not used')
      },
      buildCancelTargetCommand: () => {
        throw new Error('not used')
      },
    }
    const composer = createPackPresentationComposer({
      getContext: () => ({
        pack,
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

    const fields = weatherPack.contextualFields?.(object, {
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
    expect(runtime?.runtimeConfigs).toEqual({
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
            },
          },
        },
      },
    })
  })

  test('scenario catalog rejects runtime overrides outside the owning pack', () => {
    expect(() => createScenarioCatalog({
      packs: [ambulancePack, trafficPack, weatherPack],
      scenarios: [{
        ...osloAmbulanceScenario,
        id: 'bad-runtime-override',
        runtimeOverrides: {
          ambulance: trafficSimRuntimeId,
        },
      }],
    })).toThrow('runtime traffic-local is not registered by pack ambulance')
  })
})
