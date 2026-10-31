import { canonicalPhysicalJson, physicalDesignManifest, type RetainedPhysicalLayoutData } from './model.ts'
import type { PackPhysicalScene } from '../../core/packs/scene.ts'
import { physicalApplicabilityContent, physicalShapeFacts, physicalSourceFacts } from './applicability.ts'
import { physicalSourceFacts as architectureSourceFacts } from './native/architecture/source.ts'
import { physicalSourceFacts as draftingSourceFacts } from './native/drafting/source.ts'
import { architecturePhysicalCompilerRef, draftingPhysicalCompilerRef } from './compiler-identity.ts'

/** Keep the frozen JSON fingerprint contract independent of worker transport storage. */
export const physicalSceneShapeFacts = (objects: PackPhysicalScene['objects']) => physicalShapeFacts(objects.map(({ inspectionBoundary: _boundary, planDisplay: _plan, ...object }) => ({ ...object,
  // Fingerprint actual triangles, including indexed connectivity. Every earlier
  // unindexed artifact retains its exact canonical coordinate sequence.
  positions: object.indices ? Array.from(object.indices).flatMap(index => [object.positions[index * 3]!, object.positions[index * 3 + 1]!, object.positions[index * 3 + 2]!]) : Array.isArray(object.positions) ? object.positions : Array.from(object.positions),
})))

const hashCanonicalJson = async (json:string):Promise<string>=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json)))).map(value => value.toString(16).padStart(2, '0')).join('')
export const physicalContentHash = async (value: unknown): Promise<string> => hashCanonicalJson(canonicalPhysicalJson(value))

/** This frozen fact shape is emitted in canonical field order already. Avoid a
 * second recursive clone/sort of every coordinate, while retaining the exact
 * unchanged rounding/index-expansion authority above. Byte-equivalence tests
 * cover plain/typed/indexed geometry and the admitted profile fingerprints. */
export const physicalSceneShapeHash = async (objects: PackPhysicalScene['objects']): Promise<string> =>
  hashCanonicalJson(JSON.stringify(physicalSceneShapeFacts(objects)))

/** Verify every retained instance even when another placement warmed the asset cache. */
export const validateRetainedPhysicalSource = async (data: RetainedPhysicalLayoutData): Promise<void> => {
  const hash = physicalContentHash
  if (await hash(data.source) !== data.sourceDigest || await hash(data.bindings) !== data.bindingDigest) throw new Error(`Physical layout ${data.design.id} retained source/binding digest mismatch`)
  if ('coverageDigest' in data && await hash(data.coverageEvidence) !== data.coverageDigest) throw new Error(`Physical layout ${data.design.id} retained coverage digest mismatch`)
  if (await hash(physicalDesignManifest(data)) !== data.design.digest || data.design.id !== data.source.id) throw new Error(`Physical layout ${data.design.id} retained Design digest mismatch`)
  if ('physicalApplicability' in data && (await hash(data.compiler.id === draftingPhysicalCompilerRef.id ? draftingSourceFacts(data.source as Parameters<typeof draftingSourceFacts>[0]) : data.compiler.id === architecturePhysicalCompilerRef.id ? architectureSourceFacts(data.source as Parameters<typeof architectureSourceFacts>[0]) : physicalSourceFacts(data.source)) !== data.physicalApplicability.sourceDigest
    || await hash(physicalApplicabilityContent({ ...data, modelRequirement: { modelRef: data.owner.modelRef, modelDigest: data.owner.modelDigest } })) !== data.physicalApplicability.digest
    || await hash(data.presentation) !== data.presentationDigest)) throw new Error(`Physical layout ${data.design.id} applicability or presentation mismatch`)
}
