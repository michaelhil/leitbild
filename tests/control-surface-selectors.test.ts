import { describe, expect, test } from 'bun:test'
import type { ControlInstanceId } from '../src/core/model/index.ts'
import type { PackCreateObjectType } from '../src/core/packs/protocol.ts'
import {
  categoryRowsFor,
  placementCursorFor,
  selectedControllerObjectFor,
} from '../src/ui/control-surface-selectors.ts'
import { ambulancePack } from '../src/packs/ambulance/pack.ts'
import { osloAmbulanceTutorialScenario } from '../src/packs/ambulance/scenario.ts'
import { createAmbulanceSimEngine } from '../src/packs/ambulance/sim/engine.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'

const scenarioObjects = () =>
  createAmbulanceSimEngine({
    controlInstanceId: 'control-instance:control-surface-selectors' as ControlInstanceId,
    objects: osloAmbulanceTutorialScenario.initialObjects,
    routing: createDirectRoutingAdapter(),
  }).snapshot().objects

describe('control surface selectors', () => {
  test('builds category rows through the active pack vocabulary', () => {
    const rows = categoryRowsFor(scenarioObjects(), ambulancePack)

    expect(rows.map(row => [row.category.id, row.objects.length, row.createType?.id])).toEqual([
      ['hospitals', 1, 'hospital'],
      ['ambulances', 1, 'ambulance'],
      ['incidents', 1, 'incident'],
    ])
  })

  test('keeps category object order deterministic regardless of incoming object order', () => {
    const objects = scenarioObjects()
    const ambulance = objects.find(object => ambulancePack.isController(object))
    if (!ambulance) throw new Error('scenario fixture missing ambulance')
    const laterAmbulance = {
      ...ambulance,
      id: 'amb:b2' as typeof ambulance.id,
      label: 'Ambulance B-2',
    }
    const earlierAmbulance = {
      ...ambulance,
      id: 'amb:a1' as typeof ambulance.id,
      label: 'Ambulance A-1',
    }

    const rows = categoryRowsFor([laterAmbulance, ...objects, earlierAmbulance], ambulancePack)
    const ambulanceRow = rows.find(row => row.category.id === 'ambulances')

    expect(ambulanceRow?.objects.map(object => object.label)).toEqual([
      'Ambulance A-1',
      'Ambulance A-12',
      'Ambulance B-2',
    ])
  })

  test('selects controllers only when the active pack accepts the object as controllable', () => {
    const objects = scenarioObjects()
    const ambulance = objects.find(object => ambulancePack.isController(object))
    const hospital = objects.find(object => object.id === 'facility:ous')
    if (!ambulance || !hospital) throw new Error('scenario fixture missing expected objects')

    expect(selectedControllerObjectFor(objects, ambulance.id, ambulancePack)?.id).toBe(ambulance.id)
    expect(selectedControllerObjectFor(objects, hospital.id, ambulancePack)).toBeNull()
    expect(selectedControllerObjectFor(objects, 'object:missing', ambulancePack)).toBeNull()
  })

  test('creates placement cursor data and rejects unknown pack icons visibly', () => {
    const ambulanceCreateType = ambulancePack.createObjectTypes.find(type => type.id === 'ambulance')
    if (!ambulanceCreateType) throw new Error('ambulance create type missing')

    expect(placementCursorFor(ambulanceCreateType, ambulancePack)).toEqual({
      icon: 'ambulance',
      color: '#22845d',
    })
    expect(placementCursorFor(null, ambulancePack)).toBeNull()

    const invalidCreateType: PackCreateObjectType = {
      ...ambulanceCreateType,
      icon: 'not-a-real-icon',
    }
    expect(() => placementCursorFor(invalidCreateType, ambulancePack)).toThrow('unknown create cursor icon')
  })
})
