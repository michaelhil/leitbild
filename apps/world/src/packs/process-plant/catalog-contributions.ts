import type { PlantGraphSpec } from './graph/index.ts'
import type { CompiledPlantGraph } from './graph/index.ts'
import type { GraphFragmentInstance, GraphFragmentSpec } from './assembly/graph-fragment.ts'
import type { ProcessPlantIcConfig } from './runtime/index.ts'
import type { ProcessSurfaceDefinition } from './surfaces/model.ts'
import { processPlantPwrReferenceCatalogContribution } from './pwr-reference-catalog-contribution.ts'

export interface ProcessPlantGraphSpecCatalogEntry {
  readonly ref: string
  readonly sourcePath?: string
  readonly graph: () => PlantGraphSpec
}

export interface ProcessPlantAssemblyCatalogEntry {
  readonly ref: string
  readonly sourcePath?: string
  readonly assemble: (config: unknown) => PlantGraphSpec
}

export interface ProcessPlantGraphFragmentCatalogEntry {
  readonly ref: string
  readonly sourcePath?: string
  readonly fragment: (config: unknown) => GraphFragmentSpec
}

export interface ProcessPlantGraphFragmentInstancePresetCatalogEntry {
  readonly ref: string
  readonly sourcePath?: string
  readonly instance: (config: unknown) => GraphFragmentInstance
}

export interface ProcessPlantIcCatalogEntry {
  readonly ref: string
  readonly sourcePath?: string
  readonly config: () => ProcessPlantIcConfig
}

export interface ProcessPlantDynamicIcCatalogEntry {
  readonly id: string
  readonly refPattern: string
  readonly sourcePath?: string
  readonly description?: string
  readonly matches: (icRef: string) => boolean
  readonly config: (icRef: string) => ProcessPlantIcConfig
  readonly listedRefs?: () => ReadonlyArray<string>
}

export interface ProcessPlantGraphIcCatalogEntry {
  readonly ref: string
  readonly sourcePath?: string
  readonly configForGraph: (graph: CompiledPlantGraph) => ProcessPlantIcConfig
}

export interface ProcessPlantSurfaceCatalogEntry {
  readonly id: string
  readonly sourcePath?: string
  readonly surface: (config: {
    readonly graph: CompiledPlantGraph
  }) => ProcessSurfaceDefinition
}

export type ProcessPlantCredibilityArtifactLanguage = 'json' | 'svg'

export interface ProcessPlantCredibilityArtifactCatalogEntry {
  readonly id: string
  readonly title: string
  readonly language: ProcessPlantCredibilityArtifactLanguage
  readonly contentType: string
  readonly path: string
}

export interface ProcessPlantCredibilityEvidenceCatalogEntry {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly scope: string
  readonly generatedFromCommand: string
  readonly sourcePath?: string
  readonly appliesToGraph: (graph: CompiledPlantGraph) => boolean
  readonly artifacts: ReadonlyArray<ProcessPlantCredibilityArtifactCatalogEntry>
}

export interface ProcessPlantCatalogContribution {
  readonly id: string
  readonly graphSpecs?: ReadonlyArray<ProcessPlantGraphSpecCatalogEntry>
  readonly assemblies?: ReadonlyArray<ProcessPlantAssemblyCatalogEntry>
  readonly graphFragments?: ReadonlyArray<ProcessPlantGraphFragmentCatalogEntry>
  readonly graphFragmentInstancePresets?: ReadonlyArray<ProcessPlantGraphFragmentInstancePresetCatalogEntry>
  readonly icConfigs?: ReadonlyArray<ProcessPlantIcCatalogEntry>
  readonly dynamicIcConfigs?: ReadonlyArray<ProcessPlantDynamicIcCatalogEntry>
  readonly graphIcConfigs?: ReadonlyArray<ProcessPlantGraphIcCatalogEntry>
  readonly surfaces?: ReadonlyArray<ProcessPlantSurfaceCatalogEntry>
  readonly credibilityEvidence?: ReadonlyArray<ProcessPlantCredibilityEvidenceCatalogEntry>
}

export interface ProcessPlantCatalog {
  readonly graphSpecsByRef: ReadonlyMap<string, ProcessPlantGraphSpecCatalogEntry>
  readonly assembliesByRef: ReadonlyMap<string, ProcessPlantAssemblyCatalogEntry>
  readonly graphFragmentsByRef: ReadonlyMap<string, ProcessPlantGraphFragmentCatalogEntry>
  readonly graphFragmentInstancePresetsByRef: ReadonlyMap<string, ProcessPlantGraphFragmentInstancePresetCatalogEntry>
  readonly icConfigsByRef: ReadonlyMap<string, ProcessPlantIcCatalogEntry>
  readonly dynamicIcConfigsById: ReadonlyMap<string, ProcessPlantDynamicIcCatalogEntry>
  readonly graphIcConfigsByRef: ReadonlyMap<string, ProcessPlantGraphIcCatalogEntry>
  readonly surfacesById: ReadonlyMap<string, ProcessPlantSurfaceCatalogEntry>
  readonly credibilityEvidenceById: ReadonlyMap<string, ProcessPlantCredibilityEvidenceCatalogEntry>
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

const collectEntriesById = <TEntry extends { readonly id: string }>(
  kind: string,
  contributions: ReadonlyArray<ProcessPlantCatalogContribution>,
  entriesFor: (contribution: ProcessPlantCatalogContribution) => ReadonlyArray<TEntry> | undefined,
): ReadonlyMap<string, TEntry> => {
  const contributorsById = new Map<string, string>()
  const entriesById = new Map<string, TEntry>()
  for (const contribution of contributions) {
    for (const entry of entriesFor(contribution) ?? []) {
      if (entry.id.length === 0) throw new Error(`process plant catalog contribution "${contribution.id}" has empty ${kind}`)
      const existingContributor = contributorsById.get(entry.id)
      if (existingContributor !== undefined) {
        throw new Error(`process plant catalog duplicate ${kind} "${entry.id}" contributed by "${existingContributor}" and "${contribution.id}"`)
      }
      contributorsById.set(entry.id, contribution.id)
      entriesById.set(entry.id, entry)
    }
  }
  return entriesById
}

const collectIcEntries = (
  contributions: ReadonlyArray<ProcessPlantCatalogContribution>,
): Pick<ProcessPlantCatalog, 'icConfigsByRef' | 'graphIcConfigsByRef'> => {
  const contributorsByRef = new Map<string, string>()
  const icConfigsByRef = new Map<string, ProcessPlantIcCatalogEntry>()
  const graphIcConfigsByRef = new Map<string, ProcessPlantGraphIcCatalogEntry>()
  const rememberRef = (contributionId: string, ref: string): void => {
    if (ref.length === 0) throw new Error(`process plant catalog contribution "${contributionId}" has empty icRef`)
    const existingContributor = contributorsByRef.get(ref)
    if (existingContributor !== undefined) {
      throw new Error(`process plant catalog duplicate icRef "${ref}" contributed by "${existingContributor}" and "${contributionId}"`)
    }
    contributorsByRef.set(ref, contributionId)
  }

  for (const contribution of contributions) {
    for (const entry of contribution.icConfigs ?? []) {
      rememberRef(contribution.id, entry.ref)
      icConfigsByRef.set(entry.ref, entry)
    }
    for (const entry of contribution.graphIcConfigs ?? []) {
      rememberRef(contribution.id, entry.ref)
      graphIcConfigsByRef.set(entry.ref, entry)
    }
  }

  return { icConfigsByRef, graphIcConfigsByRef }
}

const collectDynamicIcEntries = (
  contributions: ReadonlyArray<ProcessPlantCatalogContribution>,
): ReadonlyMap<string, ProcessPlantDynamicIcCatalogEntry> => {
  const entriesById = collectEntriesById('dynamic icRef resolver id', contributions, contribution => contribution.dynamicIcConfigs)
  for (const entry of entriesById.values()) {
    if (entry.refPattern.length === 0) throw new Error(`process plant catalog dynamic icRef resolver "${entry.id}" has empty refPattern`)
  }
  return entriesById
}

const collectCredibilityEvidenceEntries = (
  contributions: ReadonlyArray<ProcessPlantCatalogContribution>,
): ReadonlyMap<string, ProcessPlantCredibilityEvidenceCatalogEntry> => {
  const entriesById = collectEntriesById('credibility evidence id', contributions, contribution => contribution.credibilityEvidence)
  for (const entry of entriesById.values()) {
    const artifactIds = new Set<string>()
    for (const artifact of entry.artifacts) {
      if (artifact.id.length === 0) throw new Error(`process plant credibility evidence "${entry.id}" has empty artifact id`)
      if (artifactIds.has(artifact.id)) throw new Error(`process plant credibility evidence "${entry.id}" has duplicate artifact id: ${artifact.id}`)
      artifactIds.add(artifact.id)
    }
  }
  return entriesById
}

export const collectProcessPlantCatalog = (
  contributions: ReadonlyArray<ProcessPlantCatalogContribution>,
): ProcessPlantCatalog => {
  const icEntries = collectIcEntries(contributions)
  return {
    graphSpecsByRef: collectEntries('graphRef', contributions, contribution => contribution.graphSpecs),
    assembliesByRef: collectEntries('assemblyRef', contributions, contribution => contribution.assemblies),
    graphFragmentsByRef: collectEntries('graph fragmentRef', contributions, contribution => contribution.graphFragments),
    graphFragmentInstancePresetsByRef: collectEntries('graph fragment instance presetRef', contributions, contribution => contribution.graphFragmentInstancePresets),
    ...icEntries,
    dynamicIcConfigsById: collectDynamicIcEntries(contributions),
    surfacesById: collectEntriesById('surfaceId', contributions, contribution => contribution.surfaces),
    credibilityEvidenceById: collectCredibilityEvidenceEntries(contributions),
  }
}

export const processPlantCatalogContributions: ReadonlyArray<ProcessPlantCatalogContribution> = [
  processPlantPwrReferenceCatalogContribution,
]

export const processPlantCatalog: ProcessPlantCatalog =
  collectProcessPlantCatalog(processPlantCatalogContributions)
