import { describe, expect, test } from 'bun:test'
import { moduleCapabilityDescriptorSchema, moduleDefinitionDescriptorSchema, moduleResourceDescriptorSchema, newWorkspaceId } from '@leitbild/contracts'
import { cardCapability } from '../src/ui/card-actions.ts'

const workspaceId = newWorkspaceId()
const start = moduleCapabilityDescriptorSchema.parse({
  id: 'world.scenario.start', moduleId: 'world', kind: 'command', scope: { kind: 'definition', definitionType: 'world.scenario' },
  title: 'Start', description: 'Start a run', risk: 'write', idempotent: false,
  inputSchema: { type: 'object', properties: {} }, outputSchema: { type: 'object' },
})
const definition = moduleDefinitionDescriptorSchema.parse({
  ref: { workspaceId, moduleId: 'world', type: 'world.scenario', id: 'exercise' },
  title: 'Exercise', currentRevisionId: `revision-${'a'.repeat(32)}`,
  capabilityIds: [start.id], primaryCapabilityId: start.id,
})

describe('explicit catalog card actions', () => {
  test('uses the declared primary action, not capability order or labels', () => {
    expect(cardCapability(definition, 'primary', [start])?.id).toBe(start.id)
    expect(cardCapability({ ...definition, primaryCapabilityId: undefined } as typeof definition, 'primary', [start])).toBeUndefined()
    expect(cardCapability(definition, 'delete', [start])).toBeUndefined()
    expect(cardCapability(definition, 'primary', [])).toBeUndefined()
  })
  test('rejects destructive primary operations and mismatched scope', () => {
    expect(() => cardCapability(definition, 'primary', [{ ...start, risk: 'destructive' }])).toThrow('Invalid primary')
    expect(() => cardCapability(definition, 'primary', [{ ...start, scope: { kind: 'workspace' } }])).toThrow('Invalid primary')
  })
  test('references must be advertised by the owning Module', () => {
    expect(() => moduleDefinitionDescriptorSchema.parse({ ...definition, deleteCapabilityId: 'world.scenario.delete' })).toThrow()
    expect(() => moduleResourceDescriptorSchema.parse({
      ref: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-example' },
      title: 'Example', capabilityIds: [], renameCapabilityId: 'world.simulation-run.rename', observedAt: new Date().toISOString(),
    })).toThrow()
  })
})
