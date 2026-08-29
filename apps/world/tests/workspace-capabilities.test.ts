import { describe, expect, test } from 'bun:test'
import { packCapabilityManifestSchema } from '@leitbild/contracts'
import { worldPacks } from '../src/app-assembly.ts'
import { buildWorldPackCapabilityManifest } from '../src/core/packs/capabilities.ts'

describe('Leitbild Workspace capability manifest', () => {
  test('derives generic capabilities from Pack descriptors', () => {
    const manifest = buildWorldPackCapabilityManifest(worldPacks)
    expect(packCapabilityManifestSchema.safeParse(manifest).success).toBe(true)
    expect(manifest.capabilities).toContainEqual(expect.objectContaining({
      id: 'weather.runtime',
      kind: 'stream',
      packId: 'weather',
    }))
    expect(manifest.capabilities).toContainEqual(expect.objectContaining({
      id: 'process-plant.presentation',
      kind: 'surface',
      packId: 'process-plant',
    }))
  })
})
