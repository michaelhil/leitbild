import type { PlantGraphSpec } from './graph/index.ts'
import type { GraphFragmentInstance, GraphFragmentSpec } from './assembly/graph-fragment.ts'
import { processPlantPwrReferenceCatalogContribution } from './pwr-reference-catalog-contribution.ts'

export interface ProcessPlantGraphSpecCatalogEntry {
  readonly ref: string
  readonly graph: () => PlantGraphSpec
}

export interface ProcessPlantAssemblyCatalogEntry {
  readonly ref: string
  readonly assemble: (config: unknown) => PlantGraphSpec
}

export interface ProcessPlantGraphFragmentCatalogEntry {
  readonly ref: string
  readonly fragment: () => GraphFragmentSpec
}

export interface ProcessPlantGraphFragmentInstancePresetCatalogEntry {
  readonly ref: string
  readonly instance: (config: unknown) => GraphFragmentInstance
}

export interface ProcessPlantCatalogContribution {
  readonly id: string
  readonly graphSpecs?: ReadonlyArray<ProcessPlantGraphSpecCatalogEntry>
  readonly assemblies?: ReadonlyArray<ProcessPlantAssemblyCatalogEntry>
  readonly graphFragments?: ReadonlyArray<ProcessPlantGraphFragmentCatalogEntry>
  readonly graphFragmentInstancePresets?: ReadonlyArray<ProcessPlantGraphFragmentInstancePresetCatalogEntry>
}

export interface ProcessPlantCatalog {
  readonly graphSpecsByRef: ReadonlyMap<string, ProcessPlantGraphSpecCatalogEntry>
  readonly assembliesByRef: ReadonlyMap<string, ProcessPlantAssemblyCatalogEntry>
  readonly graphFragmentsByRef: ReadonlyMap<string, ProcessPlantGraphFragmentCatalogEntry>
  readonly graphFragmentInstancePresetsByRef: ReadonlyMap<string, ProcessPlantGraphFragmentInstancePresetCatalogEntry>
}

const collectEntries = <TEntry extends { readonly ref: string }>(
  kind: string,
  contributions: ReadonlyArray<ProcessPlantCatalogContribution>,
  entriesFor: (contribution: ProcessPlantCatalogContribution) => ReadonlyArray<TEntry> | undefined,
): ReadonlyMap<string, TEntry> => {
  const contributorsByRef = new Map<string, string>()
  const entriesByRef = new Map<string, TEntry>()
  for (const contribution of contributions) {
    for (const entry of entriesFor(contribution) ?? []) {
      if (entry.ref.length === 0) throw new Error(`process plant catalog contribution "${contribution.id}" has empty ${kind}`)
      const existingContributor = contributorsByRef.get(entry.ref)
      if (existingContributor !== undefined) {
        throw new Error(`process plant catalog duplicate ${kind} "${entry.ref}" contributed by "${existingContributor}" and "${contribution.id}"`)
      }
      contributorsByRef.set(entry.ref, contribution.id)
      entriesByRef.set(entry.ref, entry)
    }
  }
  return entriesByRef
}

export const collectProcessPlantCatalog = (
  contributions: ReadonlyArray<ProcessPlantCatalogContribution>,
): ProcessPlantCatalog => ({
  graphSpecsByRef: collectEntries('graphRef', contributions, contribution => contribution.graphSpecs),
  assembliesByRef: collectEntries('assemblyRef', contributions, contribution => contribution.assemblies),
  graphFragmentsByRef: collectEntries('graph fragmentRef', contributions, contribution => contribution.graphFragments),
  graphFragmentInstancePresetsByRef: collectEntries('graph fragment instance presetRef', contributions, contribution => contribution.graphFragmentInstancePresets),
})

export const processPlantCatalogContributions: ReadonlyArray<ProcessPlantCatalogContribution> = [
  processPlantPwrReferenceCatalogContribution,
]

export const processPlantCatalog: ProcessPlantCatalog =
  collectProcessPlantCatalog(processPlantCatalogContributions)
