import { packPhysicalSceneSchema, type PackPhysicalScene } from '../../../../core/packs/scene.ts'
import { compilePhysicalScene as compileArchitectureScene, type PhysicalSceneInput as ArchitectureInput } from '../architecture/compile-scene.ts'
import { compilePlanDrawing } from './architecture-plan.ts'
import type { Source } from './source.ts'
export { compilePhysicalObjects, compilePlanAnnotations, physicalObjectsBounds, architectureLayers } from '../architecture/compile-scene.ts'
export interface PhysicalSceneInput extends Omit<ArchitectureInput,'source'>{readonly source:Source}
/** One source, physical geometry and explicit drafting delivery. The retained
 * R3 compiler remains byte-identical; this is a separately admitted closure. */
export const compilePhysicalScene=(id:string,data:PhysicalSceneInput):PackPhysicalScene=>{
 const scene=compileArchitectureScene(id,data)
 return packPhysicalSceneSchema.parse({...scene,planDrawing:compilePlanDrawing(data.source,scene)})
}
