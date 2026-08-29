import { describe, expect, test } from 'bun:test'
import {
  capabilityManifestSchema,
  moduleDiscoverySchema,
  newRequestId,
  newWorkspaceId,
  packDescriptorSchema,
  platformError,
  platformEventEnvelopeSchema,
  workspaceDescriptorSchema,
} from './index.ts'

const now = '2026-08-29T12:00:00.000Z'

describe('platform identifiers', () => {
  test('creates opaque Workspace and request ids', () => {
    expect(newWorkspaceId()).toMatch(/^[0-9a-f-]{36}$/)
    expect(newRequestId()).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('workspace contracts', () => {
  test('rejects duplicate module bindings', () => {
    const workspaceId = newWorkspaceId()
    const binding = {
      moduleId: 'leitbild',
      baseUrl: 'https://leitbild.example.test',
      discoveryUrl: 'https://leitbild.example.test/.well-known/leitbild',
      protocolVersion: '1.0.0',
    }
    expect(() => workspaceDescriptorSchema.parse({
      id: workspaceId,
      displayName: 'Exercise Alpha',
      status: 'active',
      modules: [binding, binding],
      createdAt: now,
      updatedAt: now,
    })).toThrow('duplicate module binding')
  })

  test('publishes versioned module discovery', () => {
    const discovery = moduleDiscoverySchema.parse({
      schemaVersion: '1.0.0',
      generatedAt: now,
      module: { id: 'samsinn', title: 'Samsinn', implementationVersion: '0.15.0' },
      supportedProtocolVersions: ['1.0.0'],
      workspaceScope: { mode: 'path', pathTemplate: '/api/v1/workspaces/{workspaceId}' },
      access: { posture: 'open', modes: ['none'] },
      links: { self: 'https://samsinn.example.test/.well-known/samsinn' },
    })
    expect(String(discovery.module.id)).toBe('samsinn')
  })
})

describe('shared envelopes', () => {
  test('builds one structured error shape', () => {
    expect(platformError({ code: 'workspace_not_found', message: 'Workspace not found' })).toEqual({
      error: { code: 'workspace_not_found', message: 'Workspace not found' },
    })
  })

  test('keeps domain payloads opaque inside transport metadata', () => {
    const workspaceId = newWorkspaceId()
    const parsed = platformEventEnvelopeSchema.parse({
      schemaVersion: '1.0.0',
      id: crypto.randomUUID(),
      workspaceId,
      resource: { moduleId: 'leitbild', kind: 'simulation-run', id: 'run-01' },
      type: 'object.upserted',
      at: now,
      sequence: 4,
      payload: { object: { packId: 'ambulance' } },
    })
    expect(parsed.payload).toEqual({ object: { packId: 'ambulance' } })
  })
})

describe('pack contracts', () => {
  test('rejects self-dependencies and duplicate contributions', () => {
    expect(() => packDescriptorSchema.parse({
      schemaVersion: '1.0.0',
      id: 'weather',
      moduleId: 'leitbild',
      version: '1.0.0',
      name: 'Weather',
      platformVersionRange: '^1.0.0',
      dependencies: [{ id: 'weather', versionRange: '^1.0.0' }],
      contributions: [{ kind: 'runtime' }, { kind: 'runtime' }],
    })).toThrow()
  })

  test('capability manifests contain derived application capabilities', () => {
    const manifest = capabilityManifestSchema.parse({
      generatedAt: now,
      capabilities: [{ id: 'weather-map-features', kind: 'query', packId: 'weather', version: '1.0.0' }],
    })
    expect(manifest.capabilities).toHaveLength(1)
  })
})
