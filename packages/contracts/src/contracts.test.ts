import { describe, expect, test } from 'bun:test'
import {
  packDescriptorSchema,
  packCapabilityManifestSchema,
} from './index.ts'

const now = '2026-08-29T12:00:00.000Z'

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

  test('capability manifests contain derived application capabilities', () => {
    const manifest = packCapabilityManifestSchema.parse({
      generatedAt: now,
      capabilities: [{ id: 'weather-map-features', kind: 'query', packId: 'weather', version: '1.0.0' }],
    })
    expect(manifest.capabilities).toHaveLength(1)
  })
})
