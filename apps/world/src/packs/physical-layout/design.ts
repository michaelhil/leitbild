import { createHash } from 'node:crypto'
import { rejectCapabilityInput } from '../../simulation/capability-rejection.ts'
import unitManifestData from './pwr-full-unit-shutdown-cooling.design.json'
import campusManifestData from './pwr-campus-shutdown-cooling.design.json'
import { physicalCatalogContent, physicalCatalogManifestSchema, type PhysicalCatalogManifest } from './catalog-manifest.ts'
import { canonicalPhysicalJson, physicalCorrespondenceSchema, physicalDesignRefSchema } from './model.ts'
import { physicalSourceSchema, physicalSourceFacts, type Source } from './native/drafting/source.ts'
import { physicalApplicabilityContent } from './applicability.ts'
import { physicalCoverageEvidenceSchema, type PhysicalCoverageEvidence } from './coverage.ts'
import type { z } from 'zod'

const hash = (value: unknown): string => createHash('sha256').update(canonicalPhysicalJson(value)).digest('hex')
const unitManifest = physicalCatalogManifestSchema.parse(unitManifestData)
const campusManifest = physicalCatalogManifestSchema.parse(campusManifestData)
export const pwrShutdownCoolingUnitPhysicalDesignRef = Object.freeze({ ...unitManifest.design })
export const pwrShutdownCoolingCampusPhysicalDesignRef = Object.freeze({ ...campusManifest.design })

export type ResolvedPhysicalDesign = PhysicalCatalogManifest & {
  readonly source: Source
  readonly bindings: Array<z.infer<typeof physicalCorrespondenceSchema>>
  readonly coverageEvidence: PhysicalCoverageEvidence
}
interface CatalogEntry {
  readonly manifest: PhysicalCatalogManifest
  readonly load: () => Promise<{ readonly source: unknown; readonly bindings: unknown; readonly coverage: unknown }>
}
const entries: ReadonlyArray<CatalogEntry> = [
  { manifest: unitManifest, load: async () => ({
    source: (await import('./pwr-full-unit-shutdown-cooling.source.json')).default,
    bindings: (await import('./pwr-full-unit-shutdown-cooling.bindings.json')).default,
    coverage: (await import('./pwr-full-unit-shutdown-cooling.coverage.json')).default,
  }) },
  { manifest: campusManifest, load: async () => ({
    source: (await import('./pwr-campus-shutdown-cooling.source.json')).default,
    bindings: (await import('./pwr-campus-shutdown-cooling.bindings.json')).default,
    coverage: (await import('./pwr-campus-shutdown-cooling.coverage.json')).default,
  }) },
]
const catalog = new Map(entries.map(entry => [canonicalPhysicalJson(entry.manifest.design), entry]))
if (catalog.size !== entries.length) throw new Error('Duplicate exact physical Design Revision')

const entryFor = (reference: unknown): CatalogEntry => {
  const parsed = physicalDesignRefSchema.parse(reference)
  return catalog.get(canonicalPhysicalJson(parsed))
    ?? rejectCapabilityInput(`Unsupported or mismatched physical Design Revision: ${parsed.id}/${parsed.revision}`)
}

/** Compact immutable choices without reading source, bindings or geometry. */
export const physicalDesignChoices = () => entries.map(({ manifest }) => ({
  design: { ...manifest.design }, modelRequirement: { ...manifest.modelRequirement },
  ownerRole: manifest.requirements.ownerRole,
  relatedRoles: manifest.requirements.relatedMembers.map(member => member.role),
}))

export const physicalDesignManifest = (reference: unknown): PhysicalCatalogManifest => structuredClone(entryFor(reference).manifest)

const loaded = new Map<CatalogEntry, Promise<ResolvedPhysicalDesign>>()
const load = async ({ manifest, load }: CatalogEntry): Promise<ResolvedPhysicalDesign> => {
  const raw = await load()
  const source = physicalSourceSchema.parse(raw.source)
  const bindings = physicalCorrespondenceSchema.array().parse(raw.bindings)
  const coverageEvidence = physicalCoverageEvidenceSchema.parse(raw.coverage)
  if (source.id !== manifest.design.id || hash(source) !== manifest.sourceDigest || hash(bindings) !== manifest.bindingDigest || hash(physicalCatalogContent(manifest)) !== manifest.design.digest) throw new Error(`Physical catalog source or admission mismatch: ${manifest.design.id}`)
  if (hash(coverageEvidence) !== manifest.coverageDigest || canonicalPhysicalJson(coverageEvidence.modelRequirement) !== canonicalPhysicalJson(manifest.modelRequirement)) throw new Error(`Physical catalog coverage mismatch: ${manifest.design.id}`)
  if (hash(physicalSourceFacts(source)) !== manifest.physicalApplicability.sourceDigest || hash(physicalApplicabilityContent(manifest)) !== manifest.physicalApplicability.digest || hash(manifest.presentation) !== manifest.presentationDigest) throw new Error(`Physical applicability or presentation mismatch: ${manifest.design.id}`)
  return { ...manifest, source, bindings, coverageEvidence }
}

export const resolvePhysicalDesign = async (reference: unknown): Promise<ResolvedPhysicalDesign> => {
  const entry = entryFor(reference)
  let pending = loaded.get(entry)
  if (pending === undefined) {
    pending = load(entry)
    loaded.set(entry, pending)
  }
  return structuredClone(await pending)
}
