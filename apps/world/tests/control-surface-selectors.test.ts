import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import type { PackCreateObjectType } from '../src/core/packs/protocol.ts'
import {
  categoryRowsFor,
  placementCursorFor,
  selectedControllerObjectFor,
} from '../src/ui/control-surface-selectors.ts'
import { ambulancePack } from '../src/packs/ambulance/pack.ts'
import { osloAmbulanceScenario } from '../src/scenarios/index.ts'
import { createAmbulanceSimEngine } from '../src/packs/ambulance/sim/engine.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { createActivePackViews } from '../src/core/packs/active-views.ts'

const ambulanceViews = createActivePackViews([ambulancePack])

const scenarioObjects = () =>
  createAmbulanceSimEngine({
    simulationRunId: 'run-control-surface-selectors' as SimulationRunId,
    objects: osloAmbulanceScenario.initialObjects,
    routing: createDirectRoutingAdapter(),
  }).snapshot().objects

const ambulanceObjects = () => scenarioObjects().filter(object => object.packId === 'ambulance')

describe('control surface selectors', () => {
  test('builds category rows through the active pack vocabulary', () => {
    const rows = categoryRowsFor(ambulanceObjects(), ambulanceViews)

    expect(rows.map(row => [row.category.id, row.objects.length, row.createType?.id])).toEqual([
      ['hospitals', 3, 'hospital'],
      ['ambulances', 3, 'ambulance'],
      ['incidents', 3, 'incident'],
    ])
  })

  test('keeps category object order deterministic regardless of incoming object order', () => {
    const objects = ambulanceObjects()
    const ambulance = objects.find(object => ambulancePack.targeting?.isController(object))
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

    const rows = categoryRowsFor([laterAmbulance, ...objects, earlierAmbulance], ambulanceViews)
    const ambulanceRow = rows.find(row => row.category.id === 'ambulances')

    expect(ambulanceRow?.objects.map(object => object.label)).toEqual([
      'Ambulance A-1',
      'Ambulance A-12',
      'Ambulance A-21',
      'Ambulance A-34',
      'Ambulance B-2',
    ])
  })

  test('selects controllers only when the active pack accepts the object as controllable', () => {
    const objects = scenarioObjects()
    const ambulance = objects.find(object => ambulancePack.targeting?.isController(object))
    const hospital = objects.find(object => object.id === 'facility:ous')
    if (!ambulance || !hospital) throw new Error('scenario fixture missing expected objects')

    expect(selectedControllerObjectFor(objects, ambulance.id, ambulanceViews)?.id).toBe(ambulance.id)
    expect(selectedControllerObjectFor(objects, hospital.id, ambulanceViews)).toBeNull()
    expect(selectedControllerObjectFor(objects, 'object:missing', ambulanceViews)).toBeNull()
  })

  test('creates placement cursor data and rejects unknown pack icons visibly', () => {
    const ambulanceCreateType = ambulancePack.creation?.createObjectTypes.find(type => type.id === 'ambulance')
    if (!ambulanceCreateType) throw new Error('ambulance create type missing')

    expect(placementCursorFor(ambulanceCreateType, ambulanceViews)).toEqual({
      icon: 'ambulance',
      color: '#22845d',
    })
    expect(placementCursorFor(null, ambulanceViews)).toBeNull()

    const invalidCreateType: PackCreateObjectType = {
      ...ambulanceCreateType,
      icon: 'not-a-real-icon',
    }
    expect(() => placementCursorFor(invalidCreateType, ambulanceViews)).toThrow('unknown create cursor icon')
  })
})
