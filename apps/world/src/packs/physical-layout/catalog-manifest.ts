import { z } from 'zod'
import { physicalSceneBoundsSchema } from '../../core/packs/scene.ts'
import { campusPhysicalCompilerRef, physicalCompilerRef } from './compiler-identity.ts'
import { physicalDesignRequirementsSchema } from './requirements.ts'

const id = z.string().min(1).max(200), digest = z.string().regex(/^[a-f0-9]{64}$/)
const common = {
  design: z.object({ id, revision: id, digest }).strict(), sourceDigest: digest, bindingDigest: digest,
  modelRequirement: z.object({ modelRef: id, modelDigest: digest }).strict(), bounds: physicalSceneBoundsSchema,
}
export const physicalCatalogManifestSchema = z.discriminatedUnion('profile', [
  z.object({ ...common, profile: z.literal('turbine-island'), compiler: z.object({ id: z.literal(physicalCompilerRef.id), digest: z.literal(physicalCompilerRef.digest) }).strict() }).strict(),
  z.object({ ...common, profile: z.literal('campus'), compiler: z.object({ id: z.literal(campusPhysicalCompilerRef.id), digest: z.literal(campusPhysicalCompilerRef.digest) }).strict(), coverageDigest: digest, requirements: physicalDesignRequirementsSchema }).strict(),
])
export type PhysicalCatalogManifest = z.infer<typeof physicalCatalogManifestSchema>
export type PhysicalCatalogContent = Omit<Extract<PhysicalCatalogManifest, { profile: 'turbine-island' }>, 'design' | 'bounds'> | Omit<Extract<PhysicalCatalogManifest, { profile: 'campus' }>, 'design' | 'bounds'>

/** Resolved member IDs and derived bounds do not alter reusable Design identity. */
export const physicalCatalogContent = (manifest: PhysicalCatalogContent) => ({
  sourceDigest: manifest.sourceDigest, bindingDigest: manifest.bindingDigest, modelRequirement: manifest.modelRequirement, compiler: manifest.compiler,
  ...('coverageDigest' in manifest ? { coverageDigest: manifest.coverageDigest, requirements: manifest.requirements } : {}),
})
