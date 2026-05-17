import { describe, expect, test } from 'bun:test'
import { geoPointFromLonLat } from '../src/core/model/index.ts'
import { createPackRegistry } from '../src/core/packs/registry.ts'
import { ambulancePack } from '../src/domains/ambulance/pack.ts'
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
})
