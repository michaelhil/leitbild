import { z } from 'zod'
import type { IsoTimestamp } from '../../../core/model/index.ts'
import { idSchema } from '../../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../../core/packs/protocol.ts'
import type { ProcessPlantSystemRuntime } from '../system-runtime.ts'

export const systemQuerySchema = z.object({
  systemId: idSchema,
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

export const requireSystem = (
  systems: ReadonlyMap<string, ProcessPlantSystemRuntime>,
  systemId: string,
): ProcessPlantSystemRuntime => {
  const system = systems.get(systemId)
  if (!system) throw new Error(`process plant system not found: ${systemId}`)
  return system
}
