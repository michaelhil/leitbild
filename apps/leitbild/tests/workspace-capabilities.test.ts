import { describe, expect, test } from 'bun:test'
import { capabilityManifestSchema } from '@samsinn-leitbild/platform-contracts'
import { leitbildPacks } from '../src/app-assembly.ts'
import { buildLeitbildCapabilityManifest } from '../src/core/packs/capabilities.ts'

describe('Leitbild Workspace capability manifest', () => {
  test('derives generic capabilities from Pack descriptors', () => {
    const manifest = buildLeitbildCapabilityManifest(leitbildPacks)
    expect(capabilityManifestSchema.safeParse(manifest).success).toBe(true)
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
