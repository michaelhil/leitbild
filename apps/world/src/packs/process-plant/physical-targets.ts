import type { OperationalObject } from '../../core/model/index.ts'
import type { PackPhysicalTargetDescription } from '../../core/packs/protocol.ts'
import { processPlantPackId, processPlantUnitPackDataSchema } from './model.ts'
import { compileProcessPlant } from './plant-compiler.ts'

/** Model description only. No simulator construction, observation or state advancement. */
export const describeProcessPlantPhysicalTargets = (object: OperationalObject): PackPhysicalTargetDescription => {
  if (object.packId !== processPlantPackId) throw new Error(`Not a Process Plant owner: ${object.id}`)
  const data = processPlantUnitPackDataSchema.parse(object.packData)
  const plant = compileProcessPlant({ id: object.id, model: data.model, operatingPoint: data.operatingPoint, automation: data.automation })
  return {
    objectId: object.id,
    modelRef: plant.modelRef,
    modelDigest: plant.modelDigest,
    subjects: plant.sourceGraph.components.map(component => ({ id: component.id, label: component.label ?? component.id })),
  }
}
