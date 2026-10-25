import type { PackPhysicalScene } from '../../core/packs/scene.ts'
import { canonicalPhysicalJson, physicalLayoutDataSchema, turbineIslandLayoutDataSchema, campusLayoutDataSchema } from './model.ts'
import { physicalContentHash, physicalSceneShapeFacts, validateRetainedPhysicalSource } from './source-validation.ts'
import { compilePhysicalScene as compileExplorer } from './native/explorer/compile-scene.ts'
import { compilePhysicalScene as compileOriginal } from './native/compile-scene.ts'
import { compilePhysicalScene as compileCampus } from './native/campus/compile-scene.ts'

/** Runs in the browser's source worker; non-browser authoring/tests use the same real compiler. */
export const compileRetainedPhysicalSource = async (input: unknown): Promise<PackPhysicalScene> => {
  const data = physicalLayoutDataSchema.parse(input)
  await validateRetainedPhysicalSource(data)
  if ('physicalApplicability' in data) {
    const scene = compileExplorer(data.design.id, data)
    if (await physicalContentHash(physicalSceneShapeFacts(scene.objects)) !== data.physicalApplicability.geometryDigest) throw new Error(`Physical layout ${data.design.id} shape recipe differs from its physical applicability`)
    if (canonicalPhysicalJson({ scopes: scene.scopes, layers: scene.layers }) !== canonicalPhysicalJson(data.presentation)) throw new Error(`Physical layout ${data.design.id} compiled scope manifest mismatch`)
    return scene
  }
  if (data.compiler.id === 'physical-layout-native') {
    return compileOriginal(data.design.id, turbineIslandLayoutDataSchema.parse(data))
  }
  return compileCampus(data.design.id, campusLayoutDataSchema.parse(data))
}
