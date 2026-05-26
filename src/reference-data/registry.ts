import {
  aeroNorwayDatasetId,
  createAeroNorwayDataset,
  type AeroNorwayDatasetConfig,
} from './datasets/aero-norway.ts'
import type { DatasetConfig, DatasetId } from './types.ts'

// Reference-data dataset registry.
// Lazy: configs are built from environment when the CLI / pipeline asks for
// them, not at module load. This keeps tests env-free and lets the build CLI
// surface "missing key" errors at the right moment.

export type RegistryEnvironment = {
  readonly [key: string]: string | undefined
}

export interface RegisteredDataset {
  readonly id: DatasetId
  readonly build: () => DatasetConfig
}

const requireString = (env: RegistryEnvironment, key: string, hint: string): string => {
  const value = env[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`reference-data registry: ${key} is required. ${hint}`)
  }
  return value
}

const aeroNorwayBuilder = (env: RegistryEnvironment): RegisteredDataset => ({
  id: aeroNorwayDatasetId,
  build: () => {
    const apiKey = requireString(env, 'OPENAIP_API_KEY', 'Generate one at https://accounts.openaip.net and place it in /etc/leitbild/reference.env (or set the env var locally).')
    const config: AeroNorwayDatasetConfig = { openaipApiKey: apiKey }
    return createAeroNorwayDataset(config)
  },
})

/**
 * Lazy registry. Returns dataset descriptors whose `build()` constructs the
 * DatasetConfig on demand. Missing required env throws inside `build()`, not
 * at registry resolution time.
 */
export const registeredDatasets = (env: RegistryEnvironment = process.env): ReadonlyArray<RegisteredDataset> => [
  aeroNorwayBuilder(env),
]

export const findRegisteredDataset = (
  datasetId: string,
  env: RegistryEnvironment = process.env,
): RegisteredDataset | null => {
  for (const d of registeredDatasets(env)) {
    if (String(d.id) === datasetId) return d
  }
  return null
}
