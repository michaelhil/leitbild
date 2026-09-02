import { describe, expect, test } from 'bun:test'
import {
  createWorkspaceInputSchema,
  coreModuleIds,
  moduleCapabilityDescriptorSchema,
  moduleCapabilityInvocationSchema,
  moduleDefinitionDescriptorSchema,
  moduleProvisioningStateSchema,
  moduleResourceDescriptorSchema,
  newWorkspaceId,
  toolGrantSetSchema,
  workspaceModuleManifestSchema,
  workspaceSchema,
} from './index.ts'

const now = '2026-08-29T17:00:00.000Z'

describe('Workspace', () => {
  test('accepts an unnamed Workspace with no default Module set', () => {
    const workspace = workspaceSchema.parse({
      id: newWorkspaceId(),
      name: null,
      modules: [],
      createdAt: now,
      updatedAt: now,
    })
    expect(workspace.name).toBeNull()
    expect(workspace.modules).toEqual([])
  })

  test('keeps Module selection out of Workspace creation', () => {
    const input = createWorkspaceInputSchema.parse({ name: null })
    expect(input).toEqual({ name: null })
    expect(() => createWorkspaceInputSchema.parse({ moduleIds: ['world'] })).toThrow()
  })

  test('rejects duplicate Module provisioning state', () => {
    const state = { moduleId: 'world', status: 'ready', updatedAt: now }
    expect(() => workspaceSchema.parse({
      id: newWorkspaceId(),
      name: null,
      modules: [state, state],
      createdAt: now,
      updatedAt: now,
    })).toThrow('duplicate Module provisioning state')
  })

  test('requires a structured failure only for failed lifecycle states', () => {
    expect(() => moduleProvisioningStateSchema.parse({
      moduleId: 'world',
      status: 'provision_failed',
      updatedAt: now,
    })).toThrow('requires a failure')

    expect(() => moduleProvisioningStateSchema.parse({
      moduleId: 'world',
      status: 'ready',
      failure: { code: 'module_unavailable', message: 'offline', retryable: true },
      updatedAt: now,
    })).toThrow('cannot carry a failure')
  })
})

describe('Module contracts', () => {
  test('defines one fixed core Module set', () => {
    expect(coreModuleIds.map(String)).toEqual(['world', 'agents'])
  })

  test('requires relative Workspace-scoped endpoint templates', () => {
    const manifest = workspaceModuleManifestSchema.parse({
      module: { id: 'world', title: 'World' },
      endpoints: {
        workspace: '/internal/workspaces/{workspaceId}',
        definitions: '/internal/workspaces/{workspaceId}/definitions',
        resources: '/internal/workspaces/{workspaceId}/resources',
        capabilities: '/internal/workspaces/{workspaceId}/capabilities',
        invoke: '/internal/workspaces/{workspaceId}/capabilities/{capabilityId}/invoke',
      },
    })
    expect(String(manifest.module.id)).toBe('world')

    expect(() => workspaceModuleManifestSchema.parse({
      ...manifest,
      endpoints: { ...manifest.endpoints, resources: 'https://module.test/resources' },
    })).toThrow()
  })

})

describe('dynamic Resource and Capability discovery', () => {
  test('keeps a mutable Definition identity separate from its immutable current revision', () => {
    const workspaceId = newWorkspaceId()
    const definition = moduleDefinitionDescriptorSchema.parse({
      ref: { workspaceId, moduleId: 'world', type: 'world.scenario', id: 'halden' },
      title: 'Halden',
      currentRevisionId: 'revision-0123456789abcdef0123456789abcdef',
      capabilityIds: ['world.scenario.start'],
    })
    expect(String(definition.ref.id)).toBe('halden')
    expect(String(definition.currentRevisionId)).toBe('revision-0123456789abcdef0123456789abcdef')
  })

  test('requires Module-owned namespaces', () => {
    const workspaceId = newWorkspaceId()
    const resource = moduleResourceDescriptorSchema.parse({
      ref: {
        workspaceId,
        moduleId: 'world',
        type: 'world.simulation-run',
        id: 'run-01',
      },
      title: 'Run 01',
      capabilityIds: ['world.simulation-run.read'],
      observedAt: now,
    })
    expect(String(resource.ref.id)).toBe('run-01')

    expect(() => moduleResourceDescriptorSchema.parse({
      ...resource,
      capabilityIds: ['agents.simulation-run.read'],
    })).toThrow('Resource Capability must be owned')
  })

  test('publishes agent-usable semantics without a concrete Resource binding', () => {
    const capability = moduleCapabilityDescriptorSchema.parse({
      id: 'world.ambulance.set-destination',
      moduleId: 'world',
      kind: 'command',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Set ambulance destination',
      description: 'Sets one ambulance destination in a selected Simulation Run.',
      risk: 'write',
      idempotent: true,
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    })
    expect(capability.scope.kind).toBe('resource')
    if (capability.scope.kind === 'resource') {
      expect(String(capability.scope.resourceType)).toBe('world.simulation-run')
    }
    expect(capability).not.toHaveProperty('resourceId')
  })

  test('keeps the selected Resource in each invocation instead of Agent configuration', () => {
    const workspaceId = newWorkspaceId()
    const invocation = moduleCapabilityInvocationSchema.parse({
      workspaceId,
      capabilityId: 'world.simulation-run.read',
      resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-01' },
      input: {},
      access: {
        workspaceId,
        requestId: crypto.randomUUID(),
        actor: { kind: 'ai', id: 'agent:operator' },
      },
    })
    expect(String(invocation.resource?.id)).toBe('run-01')
  })

  test('targets either an exact Definition Revision or a Resource, never both', () => {
    const workspaceId = newWorkspaceId()
    const base = {
      workspaceId,
      capabilityId: 'world.scenario.start',
      definition: {
        workspaceId,
        moduleId: 'world',
        type: 'world.scenario',
        id: 'halden',
        revisionId: 'revision-0123456789abcdef0123456789abcdef',
      },
      input: {},
      access: {
        workspaceId,
        requestId: crypto.randomUUID(),
        actor: { kind: 'ai' as const, id: 'agent:operator' },
      },
    }
    expect(String(moduleCapabilityInvocationSchema.parse(base).definition?.id)).toBe('halden')
    expect(() => moduleCapabilityInvocationSchema.parse({
      ...base,
      resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' },
    })).toThrow('cannot target both')
  })

  test('grants Capabilities without pinning concrete Resources', () => {
    const grants = toolGrantSetSchema.parse([
      { capabilityId: 'world.simulation-run.read' },
      { capabilityId: 'world.ambulance.set-destination' },
    ])
    expect(grants).toHaveLength(2)
    expect(grants[0]).not.toHaveProperty('resourceId')
    expect(() => toolGrantSetSchema.parse([
      { capabilityId: 'world.simulation-run.read', resourceId: 'run-01' },
    ])).toThrow()
    expect(() => toolGrantSetSchema.parse([
      { capabilityId: 'world.simulation-run.read' },
      { capabilityId: 'world.simulation-run.read' },
    ])).toThrow('duplicate Tool Grant')
  })
})
