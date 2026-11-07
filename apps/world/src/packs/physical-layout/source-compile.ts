import type { PackPhysicalScene } from '../../core/packs/scene.ts'
import { canonicalPhysicalJson, physicalLayoutDataSchema } from './model.ts'
import { physicalSceneShapeHash, validateRetainedPhysicalSource } from './source-validation.ts'
import { compilePhysicalScene } from './native/drafting/compile-scene.ts'

/** Runs in the browser source worker and in non-browser checks. */
export const compileRetainedPhysicalSource = async (input: unknown): Promise<PackPhysicalScene> => {
  const data = physicalLayoutDataSchema.parse(input)
  await validateRetainedPhysicalSource(data)
  const scene = compilePhysicalScene(data.design.id, data)
  if (await physicalSceneShapeHash(scene.objects) !== data.physicalApplicability.geometryDigest) throw new Error(`Physical layout ${data.design.id} shape recipe differs from its physical applicability`)
  if (canonicalPhysicalJson({ scopes: scene.scopes, layers: scene.layers }) !== canonicalPhysicalJson(data.presentation)) throw new Error(`Physical layout ${data.design.id} compiled scope manifest mismatch`)
  return scene
}
