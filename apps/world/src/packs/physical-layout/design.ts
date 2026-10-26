import { createHash } from 'node:crypto'
import turbineManifestData from './pwr-turbine-island.design.json'
import fullUnitManifestData from './pwr-full-unit.design.json'
import campusManifestData from './pwr-campus.design.json'
import explorerUnitManifestData from './pwr-full-unit-explorer.design.json'
import explorerCampusManifestData from './pwr-campus-explorer.design.json'
import architectureUnitManifestData from './pwr-full-unit-architecture.design.json'
import architectureCampusManifestData from './pwr-campus-architecture.design.json'
import { physicalCatalogContent, physicalCatalogManifestSchema, type PhysicalCatalogManifest } from './catalog-manifest.ts'
import { canonicalPhysicalJson, physicalCorrespondenceSchema, physicalDesignRefSchema, turbineIslandCorrespondenceSchema } from './model.ts'
import { physicalSourceSchema as originalSourceSchema, type Source as OriginalSource } from './native/source.ts'
import { physicalSourceSchema as campusSourceSchema, type Source as CampusSource } from './native/campus/source.ts'
import { physicalSourceSchema as explorerSourceSchema, type Source as ExplorerSource } from './native/explorer/source.ts'
import { physicalSourceSchema as architectureSourceSchema, physicalSourceFacts as architectureSourceFacts, type Source as ArchitectureSource } from './native/architecture/source.ts'
import { physicalApplicabilityContent, physicalSourceFacts } from './applicability.ts'
import { physicalCoverageEvidenceSchema, type PhysicalCoverageEvidence } from './coverage.ts'
import type { z } from 'zod'

const hash = (value: unknown): string => createHash('sha256').update(canonicalPhysicalJson(value)).digest('hex')
const turbineManifest = physicalCatalogManifestSchema.parse(turbineManifestData)
const fullUnitManifest = physicalCatalogManifestSchema.parse(fullUnitManifestData)
const campusManifest = physicalCatalogManifestSchema.parse(campusManifestData)
const explorerUnitManifest = physicalCatalogManifestSchema.parse(explorerUnitManifestData)
const explorerCampusManifest = physicalCatalogManifestSchema.parse(explorerCampusManifestData)
const architectureUnitManifest = physicalCatalogManifestSchema.parse(architectureUnitManifestData)
const architectureCampusManifest = physicalCatalogManifestSchema.parse(architectureCampusManifestData)

/** The original reference remains exact; it is not a mutable current/latest pointer. */
export const currentPwrPhysicalDesignRef = Object.freeze({ ...turbineManifest.design, id: 'pwr-turbine-island' as const })
export const pwrFullUnitPhysicalDesignRef = Object.freeze({ ...fullUnitManifest.design, id: 'pwr-full-unit' as const })
export const pwrCampusPhysicalDesignRef = Object.freeze({ ...campusManifest.design, id: 'pwr-campus' as const })
export const pwrExplorerUnitPhysicalDesignRef = Object.freeze({ ...explorerUnitManifest.design, id: 'pwr-full-unit' as const })
export const pwrExplorerCampusPhysicalDesignRef = Object.freeze({ ...explorerCampusManifest.design, id: 'pwr-campus' as const })
export const pwrArchitectureUnitPhysicalDesignRef = Object.freeze({ ...architectureUnitManifest.design, id: 'pwr-full-unit' as const })
export const pwrArchitectureCampusPhysicalDesignRef = Object.freeze({ ...architectureCampusManifest.design, id: 'pwr-campus' as const })

type OriginalDesign = Extract<PhysicalCatalogManifest, { profile: 'turbine-island' }> & { readonly source: OriginalSource; readonly bindings: Array<z.infer<typeof turbineIslandCorrespondenceSchema>> }
type CampusDesign = Extract<PhysicalCatalogManifest, { profile: 'campus' }> & { readonly source: CampusSource; readonly bindings: Array<z.infer<typeof physicalCorrespondenceSchema>>; readonly coverageEvidence: PhysicalCoverageEvidence }
type ExplorerDesign = Extract<PhysicalCatalogManifest, { profile: 'explorer' }> & { readonly source: ExplorerSource; readonly bindings: Array<z.infer<typeof physicalCorrespondenceSchema>>; readonly coverageEvidence: PhysicalCoverageEvidence }
type ArchitectureDesign = Extract<PhysicalCatalogManifest, { profile: 'architecture' }> & { readonly source: ArchitectureSource; readonly bindings: Array<z.infer<typeof physicalCorrespondenceSchema>>; readonly coverageEvidence: PhysicalCoverageEvidence }
export type ResolvedPhysicalDesign = OriginalDesign | CampusDesign | ExplorerDesign | ArchitectureDesign
interface CatalogEntry { readonly manifest: PhysicalCatalogManifest; readonly load: () => Promise<{ readonly source: unknown; readonly bindings: unknown; readonly coverage?: unknown }> }
const entries: ReadonlyArray<CatalogEntry> = [
  { manifest: turbineManifest, load: async () => ({ source: (await import('./pwr-turbine-island.source.json')).default, bindings: (await import('./pwr-turbine-island.bindings.json')).default }) },
  { manifest: fullUnitManifest, load: async () => ({ source: (await import('./pwr-full-unit.source.json')).default, bindings: (await import('./pwr-full-unit.bindings.json')).default, coverage: (await import('./pwr-full-unit.coverage.json')).default }) },
  { manifest: campusManifest, load: async () => ({ source: (await import('./pwr-campus.source.json')).default, bindings: (await import('./pwr-campus.bindings.json')).default, coverage: (await import('./pwr-campus.coverage.json')).default }) },
  { manifest: explorerUnitManifest, load: async () => ({ source: (await import('./pwr-full-unit-explorer.source.json')).default, bindings: (await import('./pwr-full-unit-explorer.bindings.json')).default, coverage: (await import('./pwr-full-unit-explorer.coverage.json')).default }) },
  { manifest: explorerCampusManifest, load: async () => ({ source: (await import('./pwr-campus-explorer.source.json')).default, bindings: (await import('./pwr-campus-explorer.bindings.json')).default, coverage: (await import('./pwr-campus-explorer.coverage.json')).default }) },
  { manifest: architectureUnitManifest, load: async () => ({ source: (await import('./pwr-full-unit-architecture.source.json')).default, bindings: (await import('./pwr-full-unit-architecture.bindings.json')).default, coverage: (await import('./pwr-full-unit-architecture.coverage.json')).default }) },
  { manifest: architectureCampusManifest, load: async () => ({ source: (await import('./pwr-campus-architecture.source.json')).default, bindings: (await import('./pwr-campus-architecture.bindings.json')).default, coverage: (await import('./pwr-campus-architecture.coverage.json')).default }) },
]
const catalog = new Map(entries.map(entry => [canonicalPhysicalJson(entry.manifest.design), entry]))
if (catalog.size !== entries.length) throw new Error('Duplicate exact physical Design Revision')
const loaded = new Map<CatalogEntry, Promise<ResolvedPhysicalDesign>>()
const load = async (entry: CatalogEntry): Promise<ResolvedPhysicalDesign> => {
  const { manifest } = entry
  const raw = await entry.load()
  const source = manifest.profile === 'turbine-island' ? originalSourceSchema.parse(raw.source) : manifest.profile === 'campus' ? campusSourceSchema.parse(raw.source) : manifest.profile === 'architecture' ? architectureSourceSchema.parse(raw.source) : explorerSourceSchema.parse(raw.source)
  const bindings = manifest.profile === 'turbine-island' ? turbineIslandCorrespondenceSchema.array().parse(raw.bindings) : physicalCorrespondenceSchema.array().parse(raw.bindings)
  if (source.id !== manifest.design.id || hash(source) !== manifest.sourceDigest || hash(bindings) !== manifest.bindingDigest || hash(physicalCatalogContent(manifest)) !== manifest.design.digest) throw new Error(`Physical catalog source or admission mismatch: ${manifest.design.id}`)
  if (manifest.profile === 'turbine-island') return { ...manifest, source: originalSourceSchema.parse(source), bindings: turbineIslandCorrespondenceSchema.array().parse(bindings) }
  const coverageEvidence = physicalCoverageEvidenceSchema.parse(raw.coverage)
  if (hash(coverageEvidence) !== manifest.coverageDigest || canonicalPhysicalJson(coverageEvidence.modelRequirement) !== canonicalPhysicalJson(manifest.modelRequirement)) throw new Error(`Physical catalog coverage mismatch: ${manifest.design.id}`)
  if (manifest.profile === 'campus') return { ...manifest, source: campusSourceSchema.parse(source), bindings: physicalCorrespondenceSchema.array().parse(bindings), coverageEvidence }
  if (hash(manifest.profile === 'architecture' ? architectureSourceFacts(architectureSourceSchema.parse(source)) : physicalSourceFacts(source)) !== manifest.physicalApplicability.sourceDigest || hash(physicalApplicabilityContent(manifest)) !== manifest.physicalApplicability.digest || hash(manifest.presentation) !== manifest.presentationDigest) throw new Error(`Physical applicability or presentation mismatch: ${manifest.design.id}`)
  if (manifest.profile === 'architecture') return { ...manifest, source: architectureSourceSchema.parse(source), bindings: physicalCorrespondenceSchema.array().parse(bindings), coverageEvidence }
  return { ...manifest, source: explorerSourceSchema.parse(source), bindings: physicalCorrespondenceSchema.array().parse(bindings), coverageEvidence }
}

export function resolvePhysicalDesign(reference: typeof currentPwrPhysicalDesignRef): Promise<OriginalDesign>
export function resolvePhysicalDesign(reference: unknown): Promise<ResolvedPhysicalDesign>
/** Exact source loading is lazy and read-only; unsupported pins never resolve to a newer entry. */
export async function resolvePhysicalDesign(reference: unknown): Promise<ResolvedPhysicalDesign> {
  const parsed = physicalDesignRefSchema.parse(reference)
  const entry = catalog.get(canonicalPhysicalJson(parsed))
  if (entry === undefined) throw new Error(`Unsupported or mismatched physical Design Revision: ${parsed.id}/${parsed.revision}`)
  let pending = loaded.get(entry)
  if (pending === undefined) { pending = load(entry); loaded.set(entry, pending) }
  return structuredClone(await pending)
}
