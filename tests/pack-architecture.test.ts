import { describe, expect, test } from 'bun:test'
import { confirmedFact, geoPointFromLonLat, nowIso, type ObjectId, type OperationalObject } from '../src/core/model/index.ts'
import { createCompositePack } from '../src/core/packs/composite.ts'
import { createPackRegistry } from '../src/core/packs/registry.ts'
import { ambulancePack } from '../src/domains/ambulance/pack.ts'
import { ambulanceDomainDataSchema } from '../src/domains/ambulance/model.ts'
import { trafficPack } from '../src/domains/traffic/pack.ts'
import { expectFieldKeys, expectStatusIndicator } from './helpers/pack-presentation.ts'
import {
  cancelDestinationCommandKind,
  createObjectCommandKind,
  setDestinationCommandKind,
} from '../src/domains/ambulance/commands.ts'
import { createAmbulanceSimEngine } from '../src/domains/ambulance/sim/engine.ts'
import { createOsloAmbulanceScenario } from '../src/domains/ambulance/scenario.ts'
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
      scenario: createOsloAmbulanceScenario(),
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
      scenario: createOsloAmbulanceScenario(),
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
    expectStatusIndicator(incidentPresentation, { shape: 'arrow', direction: 'right', pulse: true })

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
    expectStatusIndicator(hospitalPresentation, { shape: 'arrow', direction: 'left', pulse: true })

    const resolvedIncident: OperationalObject = {
      ...incident,
      operational: { ...incident.operational, status: 'resolved' },
    }
    const resolvedPresentation = ambulancePack.presentObject(resolvedIncident, { objects: [ambulance, resolvedIncident, hospital] })
    expect(resolvedPresentation.status?.tone).toBe('idle')
    expect(resolvedPresentation.status?.label).toBe('Resolved')
    expect(resolvedPresentation.muted).toBe(true)
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
      packs: [ambulancePack, trafficPack],
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
})
