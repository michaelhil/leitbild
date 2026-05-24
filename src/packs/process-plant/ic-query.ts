import { z } from 'zod'
import type { IsoTimestamp } from '../../core/model/index.ts'
import { idSchema } from '../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../core/packs/protocol.ts'
import type { ProcessPlantSystemRuntime } from './system-runtime.ts'

const systemQuerySchema = z.object({
  systemId: idSchema,
})

const success = (
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

const failure = (
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

const requireSystem = (
  systems: ReadonlyMap<string, ProcessPlantSystemRuntime>,
  systemId: string,
): ProcessPlantSystemRuntime => {
  const system = systems.get(systemId)
  if (!system) throw new Error(`process plant system not found: ${systemId}`)
  return system
}

export const answerProcessPlantIcQuery = (config: {
  readonly request: PackQueryRequest
  readonly systems: ReadonlyMap<string, ProcessPlantSystemRuntime>
  readonly at: IsoTimestamp
}): PackQueryResponse | undefined => {
  if (config.request.kind !== 'process-plant.ic.status' && config.request.kind !== 'process-plant.ic.catalog') {
    return undefined
  }
  try {
    const payload = systemQuerySchema.parse(config.request.payload)
    const system = requireSystem(config.systems, payload.systemId)
    if (!system.protection) return failure(config.request, `process plant I&C is not configured for system: ${payload.systemId}`, config.at)
    if (config.request.kind === 'process-plant.ic.status') {
      return success(config.request, {
        systemId: payload.systemId,
        ic: system.protection.snapshot(),
      }, config.at)
    }
    return success(config.request, {
      systemId: payload.systemId,
      ic: system.protection.catalog(),
    }, config.at)
  } catch (err) {
    return failure(config.request, err instanceof Error ? err.message : String(err), config.at)
  }
}
