import { describe, expect, test } from 'bun:test'
import { confirmedFact, geoPointFromLonLat, nowIso, type ObjectId, type OperationalObject } from '../src/core/model/index.ts'
import { createCompositePack } from '../src/core/packs/composite.ts'
import { createPackRegistry } from '../src/core/packs/registry.ts'
import { createScenarioCatalog } from '../src/core/scenarios/catalog.ts'
import { ambulancePack } from '../src/packs/ambulance/pack.ts'
import { ambulanceDomainDataSchema, hospitalDomainDataSchema, type HospitalDomainData } from '../src/packs/ambulance/model.ts'
import { trafficPack } from '../src/packs/traffic/pack.ts'
import { trafficSimProviderId } from '../src/packs/traffic/sim/constants.ts'
import { weatherPack } from '../src/packs/weather/pack.ts'
import { weatherSimProviderId } from '../src/packs/weather/sim/constants.ts'
import { expectFieldKeys, expectStatusIndicator } from './helpers/pack-presentation.ts'
import {
  cancelDestinationCommandKind,
  createObjectCommandKind,
  setDestinationCommandKind,
} from '../src/packs/ambulance/commands.ts'
import { ambulanceSimProviderId } from '../src/packs/ambulance/sim/constants.ts'
import { createAmbulanceSimEngine } from '../src/packs/ambulance/sim/engine.ts'
import { osloAmbulanceScenario } from '../src/scenarios/index.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import type { ControlInstanceId } from '../src/core/model/index.ts'

describe('pack architecture', () => {
  test('registers static packs by unique id', () => {
    const registry = createPackRegistry([ambulancePack])

    expect(registry.require('ambulance')).toBe(ambulancePack)
    expect(registry.list().map(pack => pack.id)).toEqual(['ambulance'])
    expect(() => createPackRegistry([ambulancePack, ambulancePack])).toThrow('duplicate pack id')
  })

  test('ambulance pack builds domain commands behind the generic pack interface', () => {
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

    const data = ambulanceDomainDataSchema.parse(ambulance.domainData)
    const hospitalBound: OperationalObject = {
      ...ambulance,
      tasking: { currentTaskId: hospital.id as ObjectId },
      operational: { ...ambulance.operational, status: 'en_route' },
      domainData: {
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
      const data = hospitalDomainDataSchema.parse(hospital.domainData)
      return {
        ...hospital,
        domainData: {
          ...data,
          emergencyDepartment: {
            ...data.emergencyDepartment,
            traumaBedsTotal: confirmedFact(3, nowIso(), 'scenario', 1),
            traumaBedsAvailable: confirmedFact(availableBeds, nowIso(), 'scenario', 1),
          },
        } satisfies HospitalDomainData,
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

  test('scenario catalog resolves scenario packs to internal simulation providers', () => {
    const catalog = createScenarioCatalog({
      packs: [ambulancePack, trafficPack, weatherPack],
      scenarios: [osloAmbulanceScenario],
    })
    const runtime = catalog.runtimeFor('oslo-ambulance')

    expect(catalog.listScenarios()[0]?.packs).toEqual(['ambulance', 'traffic', 'weather'])
    expect(runtime?.providers.map(provider => provider.providerId).sort()).toEqual([
      ambulanceSimProviderId,
      trafficSimProviderId,
      weatherSimProviderId,
    ].sort())
    expect(runtime?.providerConfigs).toEqual({
      [ambulanceSimProviderId]: {},
      [trafficSimProviderId]: {},
      [weatherSimProviderId]: {},
    })
  })

  test('scenario catalog rejects provider overrides outside the owning pack', () => {
    expect(() => createScenarioCatalog({
      packs: [ambulancePack, trafficPack, weatherPack],
      scenarios: [{
        ...osloAmbulanceScenario,
        id: 'bad-provider-override',
        providerOverrides: {
          ambulance: trafficSimProviderId,
        },
      }],
    })).toThrow('provider traffic-local is not registered by pack ambulance')
  })
})
