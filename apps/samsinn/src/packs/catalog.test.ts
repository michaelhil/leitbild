import { describe, expect, test } from 'bun:test'
import { createSamsinnPackDescriptor, parsePackManifest } from './manifest.ts'
import { resolvePackLoadOrder, satisfiesPackVersion } from './catalog.ts'
import type { Pack } from './types.ts'

const pack = (
  id: string,
  version = '1.0.0',
  dependencies: ReadonlyArray<{ id: string; versionRange: string }> = [],
): Pack => ({
  id,
  dirPath: `/packs/${id}`,
  manifest: parsePackManifest({
    descriptor: createSamsinnPackDescriptor({
      id,
      version,
      name: id,
      contributions: [{ kind: 'tool' }],
      dependencies,
    }),
    wikis: [],
    uiExtensions: [],
  }),
})

describe('Pack catalog', () => {
  test('supports exact and caret compatibility without accepting unrelated majors', () => {
    expect(satisfiesPackVersion('1.3.0', '^1.2.0')).toBe(true)
    expect(satisfiesPackVersion('2.0.0', '^1.2.0')).toBe(false)
    expect(satisfiesPackVersion('0.2.4', '^0.2.1')).toBe(true)
    expect(satisfiesPackVersion('0.3.0', '^0.2.1')).toBe(false)
    expect(satisfiesPackVersion('1.2.3', '1.2.3')).toBe(true)
  })

  test('orders dependencies before dependents', () => {
    const base = pack('base', '1.2.0')
    const feature = pack('feature', '1.0.0', [{ id: 'base', versionRange: '^1.0.0' }])
    expect(resolvePackLoadOrder([feature, base]).map(candidate => candidate.id)).toEqual(['base', 'feature'])
  })

  test('rejects missing, incompatible, duplicate, and cyclic Packs', () => {
    expect(() => resolvePackLoadOrder([
      pack('feature', '1.0.0', [{ id: 'missing', versionRange: '^1.0.0' }]),
    ])).toThrow('requires missing Pack')
    expect(() => resolvePackLoadOrder([
      pack('base', '2.0.0'),
      pack('feature', '1.0.0', [{ id: 'base', versionRange: '^1.0.0' }]),
    ])).toThrow('installed version is 2.0.0')
    expect(() => resolvePackLoadOrder([pack('duplicate'), pack('duplicate')])).toThrow('duplicate Pack id')
    expect(() => resolvePackLoadOrder([
      pack('first', '1.0.0', [{ id: 'second', versionRange: '^1.0.0' }]),
      pack('second', '1.0.0', [{ id: 'first', versionRange: '^1.0.0' }]),
    ])).toThrow('dependency cycle')
  })
})
