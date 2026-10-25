import { canonicalPhysicalJson, physicalDesignManifest, type RetainedPhysicalLayoutData } from './model.ts'
import { physicalApplicabilityContent, physicalSourceFacts } from './applicability.ts'

export const physicalContentHash = async (value: unknown): Promise<string> => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalPhysicalJson(value))))).map(value => value.toString(16).padStart(2, '0')).join('')

/** Verify every retained instance even when another placement warmed the asset cache. */
export const validateRetainedPhysicalSource = async (data: RetainedPhysicalLayoutData): Promise<void> => {
  const hash = physicalContentHash
  if (await hash(data.source) !== data.sourceDigest || await hash(data.bindings) !== data.bindingDigest) throw new Error(`Physical layout ${data.design.id} retained source/binding digest mismatch`)
  if ('coverageDigest' in data && await hash(data.coverageEvidence) !== data.coverageDigest) throw new Error(`Physical layout ${data.design.id} retained coverage digest mismatch`)
  if (await hash(physicalDesignManifest(data)) !== data.design.digest || data.design.id !== data.source.id) throw new Error(`Physical layout ${data.design.id} retained Design digest mismatch`)
  if ('physicalApplicability' in data && (await hash(physicalSourceFacts(data.source)) !== data.physicalApplicability.sourceDigest
    || await hash(physicalApplicabilityContent({ ...data, modelRequirement: { modelRef: data.owner.modelRef, modelDigest: data.owner.modelDigest } })) !== data.physicalApplicability.digest
    || await hash(data.presentation) !== data.presentationDigest)) throw new Error(`Physical layout ${data.design.id} applicability or presentation mismatch`)
}
