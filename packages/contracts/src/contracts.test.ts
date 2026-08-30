import { describe, expect, test } from 'bun:test'
import { moduleResourceDescriptorSchema, newWorkspaceId, packDescriptorSchema } from './index.ts'

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
