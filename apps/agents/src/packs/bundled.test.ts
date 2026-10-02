// Sanity tests on the bundled-Pack registry.

import { describe, expect, test } from 'bun:test'
import { BUNDLED_PACKS, getBundledPack } from './bundled.ts'

describe('BUNDLED_PACKS', () => {
  test('contains only real compiled Agent Packs', () => {
    expect(BUNDLED_PACKS.map(pack => pack.manifest.descriptor.id)).toEqual(['demos'])
  })

  test('every entry has the expected shape', () => {
    for (const pack of BUNDLED_PACKS) {
      expect(String(pack.manifest.descriptor.moduleId)).toBe('agents')
      expect(pack.manifest.descriptor.id.length).toBeGreaterThan(0)
      expect(pack.manifest.descriptor.name.length).toBeGreaterThan(0)
      expect(pack.manifest.descriptor.description?.length).toBeGreaterThan(0)
    }
  })

  test('getBundledPack lookup', () => {
    expect(getBundledPack('demos')?.manifest.descriptor.id).toBe('demos')
    expect(getBundledPack('pwr-ops')).toBeUndefined()
    expect(getBundledPack('nope')).toBeUndefined()
  })
})
