import { describe, expect, test } from 'bun:test'
import {
  experienceDescriptorSchema,
  moduleCapabilityDescriptorSchema,
  moduleMembershipSchema,
  moduleResourceDescriptorSchema,
  newBindingId,
  newWorkspaceId,
  resourceBindingSchema,
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

  test('rejects duplicate Module Membership', () => {
    const membership = { moduleId: 'microworld', status: 'ready', updatedAt: now }
    expect(() => workspaceSchema.parse({
      id: newWorkspaceId(),
      name: null,
      modules: [membership, membership],
      createdAt: now,
      updatedAt: now,
    })).toThrow('duplicate Module Membership')
  })

  test('requires a structured failure only for failed lifecycle states', () => {
    expect(() => moduleMembershipSchema.parse({
      moduleId: 'microworld',
      status: 'join_failed',
      updatedAt: now,
    })).toThrow('requires a failure')

    expect(() => moduleMembershipSchema.parse({
      moduleId: 'microworld',
      status: 'ready',
      failure: { code: 'module_unavailable', message: 'offline', retryable: true },
      updatedAt: now,
    })).toThrow('cannot carry a failure')
  })
})

describe('Module contracts', () => {
  test('requires relative Workspace-scoped endpoint templates', () => {
    const manifest = workspaceModuleManifestSchema.parse({
      module: { id: 'microworld', title: 'Microworld' },
      endpoints: {
        workspace: '/internal/workspaces/{workspaceId}',
        resources: '/internal/workspaces/{workspaceId}/resources',
        capabilities: '/internal/workspaces/{workspaceId}/capabilities',
        invoke: '/internal/workspaces/{workspaceId}/capabilities/{capabilityId}/invoke',
      },
    })
    expect(String(manifest.module.id)).toBe('microworld')

    expect(() => workspaceModuleManifestSchema.parse({
      ...manifest,
      endpoints: { ...manifest.endpoints, resources: 'https://module.test/resources' },
    })).toThrow()
  })

  test('keeps Experience composition separate from Module ownership', () => {
    const samsinn = experienceDescriptorSchema.parse({
      id: 'samsinn',
      title: 'Samsinn',
      requiredModules: ['collaboration', 'agents'],
    })
    expect(samsinn.requiredModules.map(String)).toEqual(['collaboration', 'agents'])
  })
})

describe('dynamic Resource and Capability discovery', () => {
  test('requires Module-owned namespaces', () => {
    const workspaceId = newWorkspaceId()
    const resource = moduleResourceDescriptorSchema.parse({
      ref: {
        workspaceId,
        moduleId: 'microworld',
        type: 'microworld.simulation-run',
        id: 'run-01',
      },
      title: 'Run 01',
      capabilityIds: ['microworld.simulation-run.read'],
      updatedAt: now,
    })
    expect(String(resource.ref.id)).toBe('run-01')

    expect(() => moduleResourceDescriptorSchema.parse({
      ...resource,
      capabilityIds: ['agents.simulation-run.read'],
    })).toThrow('Resource Capability must be owned')
  })

  test('publishes agent-usable semantics without a concrete Resource binding', () => {
    const capability = moduleCapabilityDescriptorSchema.parse({
      id: 'microworld.simulation-run.issue-command',
      moduleId: 'microworld',
      kind: 'command',
      scope: { kind: 'resource', resourceType: 'microworld.simulation-run' },
      title: 'Issue simulation command',
      description: 'Issues a validated command to a selected Simulation Run.',
      risk: 'write',
      idempotent: true,
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    })
    expect(capability.scope.kind).toBe('resource')
    if (capability.scope.kind === 'resource') {
      expect(String(capability.scope.resourceType)).toBe('microworld.simulation-run')
    }
    expect(capability).not.toHaveProperty('resourceId')
  })
})

describe('Binding', () => {
  test('is same-Workspace, explicit, and owned by the behavior Module', () => {
    const workspaceId = newWorkspaceId()
    const binding = resourceBindingSchema.parse({
      id: newBindingId(),
      workspaceId,
      ownerModuleId: 'collaboration',
      kind: 'collaboration.room-mirror',
      source: { workspaceId, moduleId: 'microworld', type: 'microworld.simulation-run', id: 'run-01' },
      target: { workspaceId, moduleId: 'collaboration', type: 'collaboration.room', id: 'ops' },
      configuration: {},
      createdAt: now,
      updatedAt: now,
    })
    expect(String(binding.ownerModuleId)).toBe('collaboration')

    expect(() => resourceBindingSchema.parse({
      ...binding,
      source: { ...binding.source, workspaceId: newWorkspaceId() },
    })).toThrow('Binding source must belong')
  })
})
