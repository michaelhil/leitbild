import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import type { PackCreateObjectType } from '../src/core/packs/protocol.ts'
import {
  categoryRowsFor,
  placementCursorFor,
  selectedControllerObjectFor,
} from '../src/ui/control-surface-selectors.ts'
import { ambulancePack } from '../src/packs/ambulance/pack.ts'
import { weatherPack } from '../src/packs/weather/pack.ts'
import { responseScenario } from './fixtures/scenarios.ts'
import { createAmbulanceSimEngine } from '../src/packs/ambulance/sim/engine.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { createActivePackViews } from '../src/core/packs/active-views.ts'

const ambulanceViews = createActivePackViews([ambulancePack])

const scenarioObjects = () =>
  createAmbulanceSimEngine({
    simulationRunId: 'run-control-surface-selectors' as SimulationRunId,
    objects: responseScenario.initialObjects,
    simulationTimeMs: Date.parse(responseScenario.world.startsAt),
    routing: createDirectRoutingAdapter(),
  }).snapshot().objects

const ambulanceObjects = () => scenarioObjects().filter(object => object.packId === 'ambulance')

describe('control surface selectors', () => {
  test('builds category rows through the active pack vocabulary', () => {
    const rows = categoryRowsFor(ambulanceObjects(), ambulanceViews)

    expect(rows.map(row => [row.category.id, row.objects.length, row.createType?.id])).toEqual([
      ['ambulances', 3, undefined],
      ['incidents', 3, undefined],
      ['patients', 4, undefined],
      ['care-sites', 3, undefined],
    ])
  })

  test('keeps category object order deterministic regardless of incoming object order', () => {
    const objects = ambulanceObjects()
    const ambulance = objects.find(object => object.kind === 'mobile_entity')
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

  test('does not expose unvalidated point-and-click dispatch on Ambulance assets', () => {
    const objects = scenarioObjects()
    const ambulance = objects.find(object => object.kind === 'mobile_entity')
    const hospital = objects.find(object => object.id === 'facility:ous')
    if (!ambulance || !hospital) throw new Error('scenario fixture missing expected objects')

    expect(selectedControllerObjectFor(objects, ambulance.id, ambulanceViews)).toBeNull()
    expect(selectedControllerObjectFor(objects, hospital.id, ambulanceViews)).toBeNull()
    expect(selectedControllerObjectFor(objects, 'object:missing', ambulanceViews)).toBeNull()
  })

  test('creates placement cursor data and rejects unknown pack icons visibly', () => {
    const weatherCreateType = weatherPack.creation?.createObjectTypes.find(type => type.id === 'weather_probe')
    if (!weatherCreateType) throw new Error('weather create type missing')

    expect(placementCursorFor(weatherCreateType, ambulanceViews)).toEqual({
      icon: 'cloud-rain',
      color: '#2563eb',
    })
    expect(placementCursorFor(null, ambulanceViews)).toBeNull()

    const invalidCreateType: PackCreateObjectType = {
      ...weatherCreateType,
      icon: 'not-a-real-icon',
    }
    expect(() => placementCursorFor(invalidCreateType, ambulanceViews)).toThrow('unknown create cursor icon')
  })
})
