import { describe, expect, test } from 'bun:test'
import { aviationPack } from '../src/packs/aviation/pack.ts'
import { aeroNorwayDatasetId } from '../src/packs/aviation/datasets/aero-norway.ts'
import { aviationReferenceDatasetBuilders } from '../src/packs/aviation/reference-datasets.ts'
import { electricGridPack } from '../src/packs/electric-grid/pack.ts'
import { gridNorwayDatasetId } from '../src/packs/electric-grid/datasets/grid-norway.ts'
import { electricGridReferenceDatasetBuilders } from '../src/packs/electric-grid/reference-datasets.ts'
import {
  collectRegisteredDatasets,
  findRegisteredDataset,
  type RegistryEnvironment,
} from '../src/reference-data/registry.ts'
import type { WorldPack } from '../src/core/packs/protocol.ts'
import { createWorldPackDescriptor } from '../src/core/packs/protocol.ts'

const okEnv: RegistryEnvironment = { OPENAIP_API_KEY: 'test-key' }
const emptyEnv: RegistryEnvironment = {}

const aviationPackWithReferenceDatasets: WorldPack = {
  ...aviationPack,
  referenceData: {
    builders: aviationReferenceDatasetBuilders,
    datasetIds: aviationPack.referenceData?.datasetIds ?? [],
  },
}
const electricGridPackWithReferenceDatasets: WorldPack = {
  ...electricGridPack,
  referenceData: {
    builders: electricGridReferenceDatasetBuilders,
    datasetIds: electricGridPack.referenceData?.datasetIds ?? [],
  },
}
const packs: ReadonlyArray<WorldPack> = [
  aviationPackWithReferenceDatasets,
  electricGridPackWithReferenceDatasets,
]

describe('reference-data registry (collector)', () => {
  test('lists pack-owned reference dataset contributions', () => {
    const datasets = collectRegisteredDatasets(packs)
    expect(datasets.map(d => String(d.id))).toContain(String(aeroNorwayDatasetId))
    expect(datasets.map(d => String(d.id))).toContain(String(gridNorwayDatasetId))
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

  test('grid-norway build() returns a raw OSM PBF dataset config by default', () => {
    const descriptor = findRegisteredDataset(String(gridNorwayDatasetId), packs)!
    const config = descriptor.build(emptyEnv)
    expect(String(config.id)).toBe(String(gridNorwayDatasetId))
    expect(config.sources.map(source => String(source.id))).toEqual(['osm:pbf-power:NO'])
    expect(config.licences.map(licence => String(licence.id))).toEqual(['osm-odbl-1.0'])
  })

  test('findRegisteredDataset returns null for unknown id', () => {
    expect(findRegisteredDataset('does-not-exist', packs)).toBeNull()
  })

  test('empty pack list yields zero datasets without throwing', () => {
    expect(collectRegisteredDatasets([])).toEqual([])
  })

  test('duplicate dataset id across packs throws', () => {
    const dup: WorldPack = {
      ...aviationPackWithReferenceDatasets,
      descriptor: createWorldPackDescriptor({
        id: 'aviation-clone',
        version: aviationPack.descriptor.version,
        name: 'Aviation Clone',
        description: 'Test Pack.',
        contributions: aviationPack.descriptor.contributions.map(contribution => contribution.kind),
      }),
    }
    expect(() => collectRegisteredDatasets([aviationPackWithReferenceDatasets, dup])).toThrow(/duplicate dataset id/)
  })
})
