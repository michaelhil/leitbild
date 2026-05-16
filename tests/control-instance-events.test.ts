import { describe, expect, test } from 'bun:test'
import type { ControlInstanceId, ObjectId } from '../src/core/model/index.ts'
import {
  applyControlInstanceEventMessage,
  commandStatusForResult,
  parseControlInstanceEventMessage,
  removeOperationalObject,
  upsertOperationalObject,
} from '../src/ui/control-instance-events.ts'
import { createOsloAmbulanceScenario } from '../src/domains/ambulance/scenario.ts'
import { createAmbulanceSimEngine } from '../src/domains/ambulance/sim/engine.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'

const scenarioObjects = () =>
  createAmbulanceSimEngine({
    controlInstanceId: 'control-instance:event-helper-test' as ControlInstanceId,
    scenario: createOsloAmbulanceScenario(),
    routing: createDirectRoutingAdapter(),
  }).snapshot().objects

describe('control instance event helpers', () => {
  test('parses valid event messages and ignores unrelated messages', () => {
    const object = scenarioObjects()[0]
    if (!object) throw new Error('scenario fixture missing object')

    const parsed = parseControlInstanceEventMessage(JSON.stringify({
      type: 'event',
      event: { type: 'object.upserted', object },
    }))

    expect(parsed?.event.type).toBe('object.upserted')
    expect(parsed?.event.object?.id).toBe(object.id)
    expect(parseControlInstanceEventMessage(JSON.stringify({ type: 'snapshot' }))).toBeNull()
  })

  test('fails visibly for malformed WebSocket protocol payloads', () => {
    expect(() => parseControlInstanceEventMessage('{')).toThrow('invalid WebSocket JSON')
    expect(() => parseControlInstanceEventMessage(JSON.stringify({
      type: 'event',
      event: {},
    }))).toThrow('missing event type')
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

  test('applies supported event messages to object and command-status state', () => {
    const objects = scenarioObjects()
    const object = objects[0]
    if (!object) throw new Error('scenario fixture missing object')

    const deleted = applyControlInstanceEventMessage(
      { objects, selectedControllerId: object.id },
      { type: 'event', event: { type: 'object.deleted', objectId: object.id as ObjectId } },
    )
    expect(deleted.objectUpdate?.selectedControllerId).toBeNull()

    const rejected = applyControlInstanceEventMessage(
      { objects, selectedControllerId: object.id },
      { type: 'event', event: { type: 'command.result', result: { ok: false, reason: 'blocked' } } },
    )
    expect(rejected.commandStatusUpdate?.commandStatus).toBe('Command rejected: blocked')
    expect(commandStatusForResult({ ok: true })).toBe('Command accepted')
  })
})
