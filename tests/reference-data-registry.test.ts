import { describe, expect, test } from 'bun:test'
import { aviationPack } from '../src/packs/aviation/pack.ts'
import { aeroNorwayDatasetId } from '../src/packs/aviation/datasets/aero-norway.ts'
import {
  collectRegisteredDatasets,
  findRegisteredDataset,
  type RegistryEnvironment,
} from '../src/reference-data/registry.ts'
import type { LeitbildPack } from '../src/core/packs/protocol.ts'

const okEnv: RegistryEnvironment = { OPENAIP_API_KEY: 'test-key' }
const emptyEnv: RegistryEnvironment = {}

const packs: ReadonlyArray<LeitbildPack> = [aviationPack]

describe('reference-data registry (collector)', () => {
  test('lists aero-norway as the aviation pack contribution', () => {
    const datasets = collectRegisteredDatasets(packs)
    expect(datasets.map(d => String(d.id))).toContain(String(aeroNorwayDatasetId))
  })

  test('build() throws when OPENAIP_API_KEY is missing', () => {
    const descriptor = findRegisteredDataset(String(aeroNorwayDatasetId), packs)
    expect(descriptor).not.toBeNull()
    expect(() => descriptor!.build(emptyEnv)).toThrow(/OPENAIP_API_KEY/)
  })

  test('build() returns a valid DatasetConfig when env is set', () => {
    const descriptor = findRegisteredDataset(String(aeroNorwayDatasetId), packs)!
    const config = descriptor.build(okEnv)
    expect(String(config.id)).toBe(String(aeroNorwayDatasetId))
    expect(config.sources.length).toBe(3)
    expect(config.licences.length).toBe(3)
  })

  test('findRegisteredDataset returns null for unknown id', () => {
    expect(findRegisteredDataset('does-not-exist', packs)).toBeNull()
  })

  test('empty pack list yields zero datasets without throwing', () => {
    expect(collectRegisteredDatasets([])).toEqual([])
  })

  test('duplicate dataset id across packs throws', () => {
    const dup: LeitbildPack = { ...aviationPack, id: 'aviation-clone' }
    expect(() => collectRegisteredDatasets([aviationPack, dup])).toThrow(/duplicate dataset id/)
  })
})
