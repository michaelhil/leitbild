import { z } from 'zod'
import { idSchema } from '../../../core/model/index.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'

export const plantQuerySchema = z.object({
  plantId: idSchema,
}).strict()

export const failure = (
  reason: string,
): never => { throw new Error(reason) }

export const requirePlant = (
  plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>,
  plantId: string,
): ProcessPlantRuntimeInstance => {
  const plant = plants.get(plantId)
  if (!plant) throw new Error(`process plant not found: ${plantId}`)
  return plant
}
