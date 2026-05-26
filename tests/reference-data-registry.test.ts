import { describe, expect, test } from 'bun:test'
import { aeroNorwayDatasetId } from '../src/reference-data/datasets/aero-norway.ts'
import {
  findRegisteredDataset,
  registeredDatasets,
  type RegistryEnvironment,
} from '../src/reference-data/registry.ts'

const okEnv: RegistryEnvironment = { OPENAIP_API_KEY: 'test-key' }
const emptyEnv: RegistryEnvironment = {}

describe('reference-data registry', () => {
  test('lists aero-norway by id', () => {
    const datasets = registeredDatasets(okEnv)
    expect(datasets.map(d => String(d.id))).toContain(String(aeroNorwayDatasetId))
  })

  test('build() throws when OPENAIP_API_KEY is missing', () => {
    const descriptor = findRegisteredDataset(String(aeroNorwayDatasetId), emptyEnv)
    expect(descriptor).not.toBeNull()
    expect(() => descriptor!.build()).toThrow(/OPENAIP_API_KEY/)
  })

  test('build() returns a valid DatasetConfig when env is set', () => {
    const descriptor = findRegisteredDataset(String(aeroNorwayDatasetId), okEnv)!
    const config = descriptor.build()
    expect(String(config.id)).toBe(String(aeroNorwayDatasetId))
    expect(config.sources.length).toBe(3)
    expect(config.licences.length).toBe(3)
  })

  test('findRegisteredDataset returns null for unknown id', () => {
    expect(findRegisteredDataset('does-not-exist', okEnv)).toBeNull()
  })

  test('registry resolution is lazy (does not throw when env is missing)', () => {
    // Calling the registry itself should not throw — only build() does.
    const datasets = registeredDatasets(emptyEnv)
    expect(datasets.length).toBeGreaterThan(0)
  })
})
