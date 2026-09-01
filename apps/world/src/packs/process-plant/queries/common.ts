import { z } from 'zod'
import type { IsoTimestamp } from '../../../core/model/index.ts'
import { idSchema } from '../../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../../core/packs/protocol.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'

export const plantQuerySchema = z.object({
  plantId: idSchema,
})

export const success = (
  request: PackQueryRequest,
  result: unknown,
  generatedAt: IsoTimestamp,
): PackQueryResponse => ({
  ok: true,
  packId: request.packId,
  kind: request.kind,
  result,
  generatedAt,
})

export const failure = (
  request: PackQueryRequest,
  reason: string,
  generatedAt: IsoTimestamp,
): PackQueryResponse => ({
  ok: false,
  packId: request.packId,
  kind: request.kind,
  reason,
  generatedAt,
})

export const requirePlant = (
  plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>,
  plantId: string,
): ProcessPlantRuntimeInstance => {
  const plant = plants.get(plantId)
  if (!plant) throw new Error(`process plant not found: ${plantId}`)
  return plant
}
