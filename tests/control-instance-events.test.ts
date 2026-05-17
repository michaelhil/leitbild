import { describe, expect, test } from 'bun:test'
import type { ControlInstanceId, GeoJsonLineString, ObjectId } from '../src/core/model/index.ts'
import { geoPointFromLonLat } from '../src/core/model/index.ts'
import {
  applyControlInstanceEventBatchMessage,
  commandStatusForResult,
  parseControlInstanceEventBatchMessage,
  removeOperationalObject,
  upsertOperationalObject,
} from '../src/ui/control-instance-events.ts'
import { osloAmbulanceTutorialScenario } from '../src/domains/ambulance/scenario.ts'
import { createAmbulanceSimEngine } from '../src/domains/ambulance/sim/engine.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'

const scenarioObjects = () =>
  createAmbulanceSimEngine({
    controlInstanceId: 'control-instance:event-helper-test' as ControlInstanceId,
    objects: osloAmbulanceTutorialScenario.initialObjects,
    routing: createDirectRoutingAdapter(),
  }).snapshot().objects

describe('control instance event helpers', () => {
  test('parses valid event-array messages and ignores unrelated messages', () => {
    const object = scenarioObjects()[0]
    if (!object) throw new Error('scenario fixture missing object')

    const parsed = parseControlInstanceEventBatchMessage(JSON.stringify({
      type: 'events',
      events: [{ type: 'object.upserted', object }],
    }))

    expect(parsed?.events[0]?.type).toBe('object.upserted')
    expect(parsed?.events[0]?.object?.id).toBe(object.id)
    expect(parseControlInstanceEventBatchMessage(JSON.stringify({ type: 'snapshot' }))).toBeNull()
  })

  test('fails visibly for malformed WebSocket protocol payloads', () => {
    expect(() => parseControlInstanceEventBatchMessage('{')).toThrow('invalid WebSocket JSON')
    expect(() => parseControlInstanceEventBatchMessage(JSON.stringify({
      type: 'events',
      events: [{}],
    }))).toThrow('missing event type')
    expect(() => parseControlInstanceEventBatchMessage(JSON.stringify({
      type: 'events',
    }))).toThrow('missing events array')
  })

  test('upserts objects without duplicating object ids', () => {
    const objects = scenarioObjects()
    const object = objects[0]
    if (!object) throw new Error('scenario fixture missing object')

    const updated = { ...object, label: 'Updated object', revision: object.revision + 1 }
    const next = upsertOperationalObject(objects, updated)

    expect(next.filter(candidate => candidate.id === object.id)).toHaveLength(1)
    expect(next.find(candidate => candidate.id === object.id)?.label).toBe('Updated object')
  })

  test('upserts existing objects without changing their list order', () => {
    const objects = scenarioObjects()
    const first = objects[0]
    const second = objects[1]
    const third = objects[2]
    if (!first || !second || !third) throw new Error('scenario fixture missing expected objects')

    const updatedSecond = { ...second, label: 'Updated second object', revision: second.revision + 1 }
    const next = upsertOperationalObject(objects, updatedSecond)

    expect(next.map(object => object.id)).toEqual(objects.map(object => object.id))
    expect(next[1]?.label).toBe('Updated second object')
  })

  test('removes deleted objects and clears selection when the selected controller is deleted', () => {
    const objects = scenarioObjects()
    const selected = objects[0]
    if (!selected) throw new Error('scenario fixture missing object')

    const next = removeOperationalObject({ objects, selectedControllerId: selected.id }, selected.id)

    expect(next.objects.some(object => object.id === selected.id)).toBe(false)
    expect(next.selectedControllerId).toBeNull()
  })

  test('applies supported event-array messages to object and command-status state', () => {
    const objects = scenarioObjects()
    const object = objects[0]
    if (!object) throw new Error('scenario fixture missing object')

    const deleted = applyControlInstanceEventBatchMessage(
      { objects, selectedControllerId: object.id },
      { type: 'events', events: [{ type: 'object.deleted', objectId: object.id as ObjectId }] },
    )
    expect(deleted.objectUpdate?.selectedControllerId).toBeNull()
    expect(deleted.routesChanged).toBe(false)

    const rejected = applyControlInstanceEventBatchMessage(
      { objects, selectedControllerId: object.id },
      { type: 'events', events: [{ type: 'command.result', result: { ok: false, reason: 'blocked' } }] },
    )
    expect(rejected.commandStatusUpdate?.commandStatus).toBe('Command rejected: blocked')
    expect(rejected.routesChanged).toBe(false)
    expect(commandStatusForResult({ ok: true })).toBe('Command accepted')
  })

  test('applies multiple object updates in one pass while preserving existing order', () => {
    const objects = scenarioObjects()
    const first = objects[0]
    const second = objects[1]
    const third = objects[2]
    if (!first || !second || !third) throw new Error('scenario fixture missing expected objects')

    const updatedSecond = { ...second, label: 'Updated second', revision: second.revision + 1 }
    const updatedAgain = { ...updatedSecond, label: 'Updated second again', revision: updatedSecond.revision + 1 }
    const newObject = { ...first, id: 'object:new' as ObjectId, label: 'New object' }
    const applied = applyControlInstanceEventBatchMessage(
      { objects, selectedControllerId: first.id },
      {
        type: 'events',
        events: [
          { type: 'object.upserted', object: updatedSecond },
          { type: 'object.upserted', object: newObject },
          { type: 'object.upserted', object: updatedAgain },
        ],
      },
    )

    expect(applied.objectUpdate?.objects.map(candidate => candidate.id)).toEqual([...objects.map(candidate => candidate.id), newObject.id])
    expect(applied.objectUpdate?.objects[1]?.label).toBe('Updated second again')
  })

  test('reports route changes separately from position-only updates', () => {
    const objects = scenarioObjects()
    const object = objects[0]
    if (!object) throw new Error('scenario fixture missing object')

    const positionOnly = applyControlInstanceEventBatchMessage(
      { objects, selectedControllerId: object.id },
      {
        type: 'events',
        events: [{ type: 'object.upserted', object: { ...object, revision: object.revision + 1 } }],
      },
    )
    expect(positionOnly.routesChanged).toBe(false)

    const plannedRoute: GeoJsonLineString = {
      type: 'LineString',
      coordinates: [
        geoPointFromLonLat(10.7, 59.9).coordinates,
        geoPointFromLonLat(10.8, 59.95).coordinates,
      ],
    }
    const routed = {
      ...object,
      revision: object.revision + 2,
      spatial: {
        ...object.spatial,
        route: {
          planned: plannedRoute,
          source: 'operator' as const,
        },
      },
    }
    const routeUpdate = applyControlInstanceEventBatchMessage(
      { objects, selectedControllerId: object.id },
      {
        type: 'events',
        events: [{ type: 'object.upserted', object: routed }],
      },
    )
    expect(routeUpdate.routesChanged).toBe(true)
  })
})
