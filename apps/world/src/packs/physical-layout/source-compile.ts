import type { PackPhysicalScene } from '../../core/packs/scene.ts'
import { canonicalPhysicalJson, physicalLayoutDataSchema, type PhysicalLayoutData,type CampusPhysicalLayoutData,type ArchitecturePhysicalLayoutData,type DraftingPhysicalLayoutData } from './model.ts'
import { physicalSceneShapeHash, validateRetainedPhysicalSource } from './source-validation.ts'
import { compilePhysicalScene as compileExplorer } from './native/explorer/compile-scene.ts'
import { compilePhysicalScene as compileOriginal } from './native/compile-scene.ts'
import { compilePhysicalScene as compileCampus } from './native/campus/compile-scene.ts'
import { compilePhysicalScene as compileArchitecture } from './native/architecture/compile-scene.ts'
import { compilePhysicalScene as compileDrafting } from './native/drafting/compile-scene.ts'
import { architecturePhysicalCompilerRef, draftingPhysicalCompilerRef } from './compiler-identity.ts'

/** Runs in the browser's source worker; non-browser authoring/tests use the same real compiler. */
export const compileRetainedPhysicalSource = async (input: unknown): Promise<PackPhysicalScene> => {
  const data = physicalLayoutDataSchema.parse(input)
  await validateRetainedPhysicalSource(data)
  if ('physicalApplicability' in data) {
    // The complete discriminated boundary above already validated this exact
    // profile, including its literal compiler digest and cross-facet checks.
    const scene = data.compiler.id === draftingPhysicalCompilerRef.id ? compileDrafting(data.design.id, data as DraftingPhysicalLayoutData) : data.compiler.id === architecturePhysicalCompilerRef.id ? compileArchitecture(data.design.id, data as ArchitecturePhysicalLayoutData) : compileExplorer(data.design.id, data)
    if (await physicalSceneShapeHash(scene.objects) !== data.physicalApplicability.geometryDigest) throw new Error(`Physical layout ${data.design.id} shape recipe differs from its physical applicability`)
    if (canonicalPhysicalJson({ scopes: scene.scopes, layers: scene.layers }) !== canonicalPhysicalJson(data.presentation)) throw new Error(`Physical layout ${data.design.id} compiled scope manifest mismatch`)
    return scene
  }
  if (data.compiler.id === 'physical-layout-native') {
    return compileOriginal(data.design.id, data as PhysicalLayoutData)
  }
  return compileCampus(data.design.id, data as CampusPhysicalLayoutData)
}
