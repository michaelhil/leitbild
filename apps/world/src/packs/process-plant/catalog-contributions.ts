import type { CompiledPlantGraph } from './graph/index.ts'
import { processPlantPwrReferenceCatalogContribution } from './pwr-reference-catalog-contribution.ts'

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
  readonly appliesToGraph: (graph: CompiledPlantGraph) => boolean
  readonly artifacts: ReadonlyArray<ProcessPlantCredibilityArtifactCatalogEntry>
}

export interface ProcessPlantCatalogContribution {
  readonly id: string
  readonly credibilityEvidence?: ReadonlyArray<ProcessPlantCredibilityEvidenceCatalogEntry>
}

export interface ProcessPlantCatalog {
  readonly credibilityEvidenceById: ReadonlyMap<string, ProcessPlantCredibilityEvidenceCatalogEntry>
}

const collectById = <TEntry extends { readonly id: string }>(
  kind: string,
  contributions: ReadonlyArray<ProcessPlantCatalogContribution>,
  entriesFor: (contribution: ProcessPlantCatalogContribution) => ReadonlyArray<TEntry> | undefined,
): ReadonlyMap<string, TEntry> => {
  const contributorById = new Map<string, string>()
  const entriesById = new Map<string, TEntry>()
  for (const contribution of contributions) {
    for (const entry of entriesFor(contribution) ?? []) {
      if (entry.id.length === 0) throw new Error(`process plant catalog contribution "${contribution.id}" has empty ${kind}`)
      const previous = contributorById.get(entry.id)
      if (previous !== undefined) {
        throw new Error(`process plant catalog duplicate ${kind} "${entry.id}" contributed by "${previous}" and "${contribution.id}"`)
      }
      contributorById.set(entry.id, contribution.id)
      entriesById.set(entry.id, entry)
    }
  }
  return entriesById
}

export const collectProcessPlantCatalog = (
  contributions: ReadonlyArray<ProcessPlantCatalogContribution>,
): ProcessPlantCatalog => ({
  credibilityEvidenceById: collectById('credibility evidence id', contributions, contribution => contribution.credibilityEvidence),
})

export const processPlantCatalogContributions: ReadonlyArray<ProcessPlantCatalogContribution> = [
  processPlantPwrReferenceCatalogContribution,
]

export const processPlantCatalog = collectProcessPlantCatalog(processPlantCatalogContributions)
