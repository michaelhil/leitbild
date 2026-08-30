import { describe, expect, test } from 'bun:test'
import {
  capabilityIdSchema,
  moduleCapabilityDescriptorSchema,
  moduleIdSchema,
  moduleCapabilityInvocationSchema,
  resourceTypeSchema,
  type ModuleCapabilityInvocation,
} from '@leitbild/contracts'
import { createModuleCapabilityRegistry } from './index.ts'

const descriptor = moduleCapabilityDescriptorSchema.parse({
  id: 'world.simulation-run.read',
  moduleId: 'world',
  kind: 'query',
  scope: { kind: 'resource', resourceType: 'world.simulation-run' },
  title: 'Read Simulation Run',
  description: 'Reads one Simulation Run.',
  risk: 'read',
  idempotent: true,
  inputSchema: { type: 'object', additionalProperties: false },
  outputSchema: { type: 'object' },
})

const workspaceId = '11111111-1111-4111-8111-111111111111'

const invocation = (resourceType = 'world.simulation-run'): ModuleCapabilityInvocation => moduleCapabilityInvocationSchema.parse({
  workspaceId,
  capabilityId: descriptor.id,
  resource: {
    workspaceId,
    moduleId: 'world',
    type: resourceType,
    id: 'run-1',
  },
  input: {},
  access: {
    workspaceId,
    requestId: '22222222-2222-4222-8222-222222222222',
    actor: { kind: 'system', id: 'test' },
  },
})

describe('Module Capability Registry', () => {
  test('lists and invokes registered Capabilities', async () => {
    const registry = createModuleCapabilityRegistry(moduleIdSchema.parse('world'), [{
      descriptor,
      invoke: async (_context: { marker: string }, input) => `${input.resource?.id}:ok`,
    }])

    expect(registry.descriptors).toEqual([descriptor])
    expect(registry.idsForResourceType(resourceTypeSchema.parse('world.simulation-run'))).toEqual([descriptor.id])
    expect(await registry.invoke(descriptor.id, { marker: 'ok' }, invocation())).toBe('run-1:ok')
    expect(await registry.invoke(capabilityIdSchema.parse('world.unknown'), { marker: 'ok' }, invocation())).toBeUndefined()
  })

  test('rejects duplicate registrations and invalid Resource scope', async () => {
    expect(() => createModuleCapabilityRegistry(moduleIdSchema.parse('world'), [
      { descriptor, invoke: async () => 'one' },
      { descriptor, invoke: async () => 'two' },
    ])).toThrow('Duplicate Capability registration')

    const registry = createModuleCapabilityRegistry(moduleIdSchema.parse('world'), [{ descriptor, invoke: async () => 'ok' }])
    expect(registry.invoke(descriptor.id, {}, invocation('world.scenario')))
      .rejects.toThrow('requires a world.simulation-run Resource')
  })
})
