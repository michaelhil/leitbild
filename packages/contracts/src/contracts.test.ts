import { describe, expect, test } from 'bun:test'
import {
  inspectionViewSchema,
  moduleDefinitionDescriptorSchema,
  moduleResourceDescriptorSchema,
  newWorkspaceId,
  packDescriptorSchema,
  workspaceResourceFocusMessageSchema,
} from './index.ts'

describe('pack contracts', () => {
  test('rejects self-dependencies and duplicate contributions', () => {
    expect(() => packDescriptorSchema.parse({
      schemaVersion: '1.0.0',
      id: 'weather',
      moduleId: 'world',
      version: '1.0.0',
      name: 'Weather',
      platformVersionRange: '^1.0.0',
      dependencies: [{ id: 'weather', versionRange: '^1.0.0' }],
      contributions: [{ kind: 'runtime' }, { kind: 'runtime' }],
    })).toThrow()
  })
})

describe('package exports', () => {
  test('every declared export resolves to a source file', async () => {
    const packageJson = await Bun.file(new URL('../package.json', import.meta.url)).json() as {
      readonly exports: Readonly<Record<string, string>>
    }
    for (const target of Object.values(packageJson.exports)) {
      expect(await Bun.file(new URL(`../${target.replace(/^\.\//, '')}`, import.meta.url)).exists()).toBe(true)
    }
  })
})

describe('Resource Summary contracts', () => {
  test('accepts typed overview facts and rejects duplicate keys', () => {
    const workspaceId = newWorkspaceId()
    const resource = {
      ref: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' },
      title: 'Exercise',
      uiPath: `/workspaces/${workspaceId}/world/runs/run-1`,
      links: [],
      capabilityIds: [],
      summary: [
        { key: 'started-at', label: 'Started', kind: 'timestamp', value: new Date().toISOString() },
        { key: 'viewer-count', label: 'Viewers', kind: 'count', value: 2 },
      ],
      observedAt: new Date().toISOString(),
    }
    expect(moduleResourceDescriptorSchema.parse(resource).summary).toHaveLength(2)
    expect(() => moduleResourceDescriptorSchema.parse({
      ...resource,
      summary: [...resource.summary, { key: 'viewer-count', label: 'Other viewers', kind: 'count', value: 3 }],
    })).toThrow('duplicate Resource Summary key')
  })
})

describe('transient Resource focus contract', () => {
  test('accepts an exact Resource reference or an explicit cleared focus', () => {
    const workspaceId = newWorkspaceId()
    const focused = workspaceResourceFocusMessageSchema.parse({
      type: 'leitbild:resource-focus',
      resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' },
    })
    expect(String(focused.resource?.id)).toBe('run-1')
    expect(workspaceResourceFocusMessageSchema.parse({ type: 'leitbild:resource-focus', resource: null }).resource).toBeNull()
  })
})

describe('Inspection View contracts', () => {
  test('links inspection through an advertised Capability and validates structured sections', () => {
    const workspaceId = newWorkspaceId()
    const definition = moduleDefinitionDescriptorSchema.parse({
      ref: { workspaceId, moduleId: 'world', type: 'world.scenario', id: 'exercise' },
      title: 'Exercise',
      uiPath: `/workspaces/${workspaceId}/world/scenarios/new?definition=exercise`,
      currentRevisionId: 'revision-0123456789abcdef0123456789abcdef',
      capabilityIds: ['world.scenario.inspect'],
      inspectionCapabilityId: 'world.scenario.inspect',
    })
    expect(String(definition.inspectionCapabilityId)).toBe('world.scenario.inspect')
    expect(definition.uiPath).toContain('definition=exercise')
    expect(() => moduleDefinitionDescriptorSchema.parse({
      ...definition,
      capabilityIds: [],
    })).toThrow('Card Capability must be included')

    const view = {
      target: {
        kind: 'definition',
        definition: { ...definition.ref, revisionId: definition.currentRevisionId },
      },
      title: definition.title,
      observedAt: new Date().toISOString(),
      sections: [{ id: 'configuration', title: 'Configuration', data: { packs: ['weather'] } }],
    }
    expect(inspectionViewSchema.parse(view).sections).toHaveLength(1)
    expect(() => inspectionViewSchema.parse({ ...view, sections: [...view.sections, view.sections[0]] }))
      .toThrow('duplicate Inspection Section')
  })
})
