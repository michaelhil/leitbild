// Sanity tests on the bundled-Pack registry.

import { describe, expect, test } from 'bun:test'
import { BUNDLED_PACKS, getBundledPack } from './bundled.ts'

describe('BUNDLED_PACKS', () => {
  test('contains only real compiled Agent Packs', () => {
    expect(BUNDLED_PACKS.map(pack => pack.descriptor.id)).toEqual(['demos', 'pwr-ops'])
  })

  test('every entry has the expected shape', () => {
    for (const pack of BUNDLED_PACKS) {
      expect(String(pack.descriptor.moduleId)).toBe('agents')
      expect(pack.descriptor.id.length).toBeGreaterThan(0)
      expect(pack.descriptor.name.length).toBeGreaterThan(0)
      expect(pack.descriptor.description?.length).toBeGreaterThan(0)
    }
  })

  test('getBundledPack lookup', () => {
    expect(getBundledPack('pwr-ops')?.descriptor.id).toBe('pwr-ops')
    expect(getBundledPack('nope')).toBeUndefined()
  })
})
