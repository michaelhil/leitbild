import { describe, expect, test } from 'bun:test'
import { compileProcessPlant, createPwrReferencePlantDefinition, variablePathSchema } from '../src/packs/process-plant/index.ts'
import { createPlantOperations, plantOperationsStateSchema, type OperationRecord } from '../src/packs/process-plant/operations/plant-operations.ts'

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:latest-receipts', loopCount: 4 }))
const first = variablePathSchema.parse('steamGeneratorReliefValveA.controllerSetpoint')
const unrelated = variablePathSchema.parse('steamGeneratorReliefValveB.controllerSetpoint')
const receipt = (path = first, elapsedMs = 0, value: number | boolean = 7.4): OperationRecord => ({
  commandId: `command:${path}:${elapsedMs}:${value}`, path, value, origin: 'person', actorId: 'operator:handoff', elapsedMs, kind: 'write',
})

describe('model-bounded latest accepted control receipts', () => {
  test('unrelated recent-log eviction does not remove an accepted human operation, including after restoration', () => {
    const operations = createPlantOperations({ graph: plant.graph })
    const original = receipt()
    operations.record(original, { elapsedMs: 0, wallMs: 0 })
    for (let index = 1; index <= 300; index++) operations.record(receipt(unrelated, index), { elapsedMs: index, wallMs: index })
    expect(operations.log().some(record => record.path === first)).toBe(false)
    expect(operations.latest(first)).toEqual(original)
    expect(operations.snapshot()!.latestByPath).toHaveLength(2)
    const restored = createPlantOperations({ graph: plant.graph, restored: operations.snapshot()! })
    expect(restored.latest(first)).toEqual(original)
    const changed = { ...receipt(first, 301, 7.3), origin: 'ai' as const, actorId: 'agent:continued' }
    restored.record(changed, { elapsedMs: 301, wallMs: 301 })
    expect(restored.latest(first)).toEqual(changed)
    expect(restored.snapshot()!.latestByPath).toHaveLength(2)
  })

  test('a current graph validates every live and restored path, value type and declared range', () => {
    const operations = createPlantOperations({ graph: plant.graph })
    for (const bad of [receipt(variablePathSchema.parse('missing.command')), receipt(variablePathSchema.parse('sgA.pressureMPa')), receipt(first, 0, true), receipt(variablePathSchema.parse('hotwellRejectValve.positionFraction'), 0, 2)]) {
      expect(() => operations.record(bad, { elapsedMs: 0, wallMs: 0 })).toThrow()
      expect(() => createPlantOperations({ graph: plant.graph, restored: { log: [bad], latestByPath: [bad], proposals: [] } })).toThrow()
    }
    const d = receipt(variablePathSchema.parse('steamGeneratorReliefValveD.controllerSetpoint'))
    const smaller = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:two-loop', loopCount: 2 }))
    expect(() => createPlantOperations({ graph: smaller.graph, restored: { log: [d], latestByPath: [d], proposals: [] } })).toThrow('canonical writable path')
    expect(operations.snapshot()).toBeUndefined()
  })

  test('missing, duplicated or contradictory retained indices are rejected instead of rebuilt from a truncated UI log', () => {
    const original = receipt()
    expect(plantOperationsStateSchema.safeParse({ log: [original], proposals: [] }).success).toBe(false)
    expect(plantOperationsStateSchema.safeParse({ log: [original], latestByPath: [original, original], proposals: [] }).success).toBe(false)
    expect(plantOperationsStateSchema.safeParse({ log: [original], latestByPath: [{ ...original, value: 7.3 }], proposals: [] }).success).toBe(false)
    const operations = createPlantOperations({ graph: plant.graph })
    operations.record(receipt(first, 10), { elapsedMs: 10, wallMs: 10 })
    expect(() => operations.record(receipt(first, 9), { elapsedMs: 9, wallMs: 11 })).toThrow('time reverses')
    expect(operations.latest(first)?.elapsedMs).toBe(10)
  })
})
