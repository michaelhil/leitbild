import type { OperationalObject } from '../../core/model/index.ts'
import type { PackPhysicalTargetDescription } from '../../core/packs/protocol.ts'
import { processPlantPackId, processPlantUnitPackDataSchema } from './model.ts'
import { compileProcessPlant } from './plant-compiler.ts'
import { createHash } from 'node:crypto'

const descriptions = new Map<string, Omit<PackPhysicalTargetDescription, 'objectId'>>()

/** Model description only. No simulator construction, observation or state advancement. */
export const describeProcessPlantPhysicalTargets = (object: OperationalObject): PackPhysicalTargetDescription => {
  if (object.packId !== processPlantPackId) throw new Error(`Not a Process Plant owner: ${object.id}`)
  const data = processPlantUnitPackDataSchema.parse(object.packData)
  // Exact immutable selections, including inline graphs/parameters where used.
  // Runtime projection changes do not rebuild a model description each second.
  const key = createHash('sha256').update(JSON.stringify([data.model, data.operatingPoint, data.automation])).digest('hex')
  const cached = descriptions.get(key)
  if (cached) return { objectId: object.id, ...cached }
  const plant = compileProcessPlant({ id: object.id, model: data.model, operatingPoint: data.operatingPoint, automation: data.automation })
  const description = Object.freeze({
    modelRef: plant.modelRef,
    modelDigest: plant.modelDigest,
    subjects: Object.freeze(plant.sourceGraph.components.map(component => Object.freeze({ id: component.id, label: component.label ?? component.id }))),
  })
  if (descriptions.size >= 64) descriptions.delete(descriptions.keys().next().value!)
  descriptions.set(key, description)
  return { objectId: object.id, ...description }
}
