import { describe, expect, test } from 'bun:test'
import { packCapabilityManifestSchema } from '@leitbild/contracts'
import { BUNDLED_PACKS } from './bundled.ts'
import { buildAgentPackCapabilityManifest } from './capabilities.ts'

describe('Leitbild Workspace capability manifest', () => {
  test('derives generic capabilities from Pack descriptors', () => {
    const manifest = buildAgentPackCapabilityManifest(BUNDLED_PACKS.map(pack => pack.descriptor))
    expect(packCapabilityManifestSchema.safeParse(manifest).success).toBe(true)
    expect(manifest.capabilities).toContainEqual(expect.objectContaining({
      id: 'core.tool',
      kind: 'tool',
      packId: 'core',
      version: '1.0.0',
    }))
    expect(manifest.capabilities).toContainEqual(expect.objectContaining({
      id: 'pwr-ops.wiki',
      kind: 'data',
      packId: 'pwr-ops',
    }))
  })
})
