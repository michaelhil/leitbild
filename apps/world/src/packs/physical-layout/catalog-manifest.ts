import { z } from 'zod'
import { physicalSceneBoundsSchema } from '../../core/packs/scene.ts'
import { campusPhysicalCompilerRef, explorerPhysicalCompilerRef, physicalCompilerRef } from './compiler-identity.ts'
import { physicalDesignRequirementsSchema, physicalExplorerRequirementsSchema } from './requirements.ts'
import { physicalApplicabilitySchema, physicalPresentationSchema } from './model.ts'

const id = z.string().min(1).max(200), digest = z.string().regex(/^[a-f0-9]{64}$/)
const common = {
  design: z.object({ id, revision: id, digest }).strict(), sourceDigest: digest, bindingDigest: digest,
  modelRequirement: z.object({ modelRef: id, modelDigest: digest }).strict(), bounds: physicalSceneBoundsSchema,
}
export const physicalCatalogManifestSchema = z.discriminatedUnion('profile', [
  z.object({ ...common, profile: z.literal('turbine-island'), compiler: z.object({ id: z.literal(physicalCompilerRef.id), digest: z.literal(physicalCompilerRef.digest) }).strict() }).strict(),
  z.object({ ...common, profile: z.literal('campus'), compiler: z.object({ id: z.literal(campusPhysicalCompilerRef.id), digest: z.literal(campusPhysicalCompilerRef.digest) }).strict(), coverageDigest: digest, requirements: physicalDesignRequirementsSchema }).strict(),
  z.object({ ...common, profile: z.literal('explorer'), compiler: z.object({ id: z.literal(explorerPhysicalCompilerRef.id), digest: z.literal(explorerPhysicalCompilerRef.digest) }).strict(), coverageDigest: digest, requirements: physicalExplorerRequirementsSchema,
    physicalApplicability: physicalApplicabilitySchema, presentation: physicalPresentationSchema, presentationDigest: digest }).strict(),
])
export type PhysicalCatalogManifest = z.infer<typeof physicalCatalogManifestSchema>
export type PhysicalCatalogContent = PhysicalCatalogManifest extends infer T ? T extends PhysicalCatalogManifest ? Omit<T, 'design' | 'bounds'> : never : never

/** Resolved member IDs and derived bounds do not alter reusable Design identity. */
export const physicalCatalogContent = (manifest: PhysicalCatalogContent) => ({
  sourceDigest: manifest.sourceDigest, bindingDigest: manifest.bindingDigest, modelRequirement: manifest.modelRequirement, compiler: manifest.compiler,
  ...('coverageDigest' in manifest ? { coverageDigest: manifest.coverageDigest, requirements: manifest.requirements } : {}),
  ...('physicalApplicability' in manifest ? { physicalApplicability: manifest.physicalApplicability, presentationDigest: manifest.presentationDigest } : {}),
})
