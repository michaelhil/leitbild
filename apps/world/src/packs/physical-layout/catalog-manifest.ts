import { z } from 'zod'
import { physicalSceneBoundsSchema } from '../../core/packs/scene.ts'
import { draftingPhysicalCompilerRef } from './compiler-identity.ts'
import { physicalDesignRequirementsSchema } from './requirements.ts'
import { physicalApplicabilitySchema, physicalPresentationSchema } from './model.ts'

const id = z.string().min(1).max(200), digest = z.string().regex(/^[a-f0-9]{64}$/)
const common = {
  design: z.object({ id, revision: id, digest }).strict(), sourceDigest: digest, bindingDigest: digest,
  modelRequirement: z.object({ modelRef: id, modelDigest: digest }).strict(), bounds: physicalSceneBoundsSchema,
}
export const physicalCatalogManifestSchema = z.object({
  ...common, profile: z.literal('drafting'),
  compiler: z.object({ id: z.literal(draftingPhysicalCompilerRef.id), digest: z.literal(draftingPhysicalCompilerRef.digest) }).strict(),
  coverageDigest: digest, requirements: physicalDesignRequirementsSchema,
  physicalApplicability: physicalApplicabilitySchema, presentation: physicalPresentationSchema, presentationDigest: digest,
}).strict()
export type PhysicalCatalogManifest = z.infer<typeof physicalCatalogManifestSchema>
export type PhysicalCatalogContent = Omit<PhysicalCatalogManifest, 'design' | 'bounds'>

/** Resolved member IDs and derived bounds do not alter reusable Design identity. */
export const physicalCatalogContent = (manifest: PhysicalCatalogContent) => ({
  sourceDigest: manifest.sourceDigest, bindingDigest: manifest.bindingDigest, modelRequirement: manifest.modelRequirement, compiler: manifest.compiler,
  coverageDigest: manifest.coverageDigest, requirements: manifest.requirements,
  physicalApplicability: manifest.physicalApplicability, presentationDigest: manifest.presentationDigest,
})
