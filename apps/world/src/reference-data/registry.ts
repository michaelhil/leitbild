import type { WorldPack } from '../core/packs/protocol.ts'
import type { DatasetConfig, DatasetId } from './types.ts'

// Reference-data dataset registry.
// Datasets are pack-owned (ADR 0019). The CLI and pipeline collect dataset
// contributions from all active Leitbild packs at runtime via
// `collectRegisteredDatasets`. Packs that need external API keys read them
// from the supplied environment when the CLI calls `build()` — missing env
// throws at that point, not at module load.

export type RegistryEnvironment = {
  readonly [key: string]: string | undefined
}

export interface RegisteredDataset {
  readonly id: DatasetId
  /**
   * Construct the DatasetConfig from the supplied environment. Throws if a
   * required env var (a source-specific access key) is missing.
   */
  readonly build: (env: RegistryEnvironment) => DatasetConfig
}

const buildPackBuilders = (pack: WorldPack): ReadonlyArray<RegisteredDataset> => {
  if (!pack.referenceData || pack.referenceData.builders.length === 0) return []
  return pack.referenceData.builders.map((builder): RegisteredDataset => ({
    id: builder.id,
    build: (env) => {
      const cfg = builder.build(env)
      if (cfg.id !== builder.id) {
        throw new Error(
          `reference-data registry: pack "${pack.descriptor.id}" declared builder id "${String(builder.id)}" but build() returned dataset id "${String(cfg.id)}"`,
        )
      }
      return cfg
    },
  }))
}

/**
 * Walk the supplied pack list and collect every reference-dataset contribution.
 * Pack builders declare their id upfront so the CLI can list / filter without
 * triggering env reads.
 */
export const collectRegisteredDatasets = (
  packs: ReadonlyArray<WorldPack>,
): ReadonlyArray<RegisteredDataset> => {
  const seen = new Set<string>()
  const out: RegisteredDataset[] = []
  for (const pack of packs) {
    for (const descriptor of buildPackBuilders(pack)) {
      const id = String(descriptor.id)
      if (seen.has(id)) {
        throw new Error(`reference-data registry: duplicate dataset id "${id}" contributed by multiple packs`)
      }
      seen.add(id)
      out.push(descriptor)
    }
  }
  return out
}

export const findRegisteredDataset = (
  datasetId: string,
  packs: ReadonlyArray<WorldPack>,
): RegisteredDataset | null => {
  for (const d of collectRegisteredDatasets(packs)) {
    if (String(d.id) === datasetId) return d
  }
  return null
}
