import type { ControlInstanceId } from '../../core/model/index.ts'
import type { CompiledProcessSurface, ProcessSurfaceValue } from '../../packs/process-plant/surfaces/index.ts'
import { queryControlInstancePack } from '../control-instance-client.ts'

export interface ProcessSurfaceListItem {
  readonly id: string
  readonly title: string
  readonly description?: string
}

export interface ProcessSurfaceSnapshot {
  readonly systemId: string
  readonly surfaceId: string
  readonly values: ReadonlyArray<ProcessSurfaceValue>
}

const assertObject = (value: unknown, message: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

const assertArray = (value: unknown, message: string): ReadonlyArray<unknown> => {
  if (!Array.isArray(value)) throw new Error(message)
  return value
}

const requireOkResult = (value: unknown): Record<string, unknown> => {
  const envelope = assertObject(value, 'process surface query returned a malformed response')
  if (envelope.ok !== true) throw new Error(typeof envelope.reason === 'string' ? envelope.reason : 'process surface query failed')
  return assertObject(envelope.result, 'process surface query returned a malformed result')
}

export const listProcessSurfaces = async (
  controlInstanceId: ControlInstanceId,
  systemId: string,
): Promise<ReadonlyArray<ProcessSurfaceListItem>> => {
  const body = await queryControlInstancePack(controlInstanceId, {
    packId: 'process-plant',
    kind: 'process-plant.surfaces.list',
    payload: { systemId },
  })
  const result = requireOkResult(body.response)
  return assertArray(result.surfaces, 'process surface list result has no surfaces array').map(item => {
    const surface = assertObject(item, 'process surface list item is malformed')
    if (typeof surface.id !== 'string' || typeof surface.title !== 'string') throw new Error('process surface list item requires id and title')
    return {
      id: surface.id,
      title: surface.title,
      ...(typeof surface.description === 'string' ? { description: surface.description } : {}),
    }
  })
}

export const readProcessSurface = async (
  controlInstanceId: ControlInstanceId,
  systemId: string,
  surfaceId: string,
): Promise<CompiledProcessSurface> => {
  const body = await queryControlInstancePack(controlInstanceId, {
    packId: 'process-plant',
    kind: 'process-plant.surface.read',
    payload: { systemId, surfaceId },
  })
  const result = requireOkResult(body.response)
  return assertObject(result.surface, 'process surface read result has no surface') as unknown as CompiledProcessSurface
}

export const readProcessSurfaceSnapshot = async (
  controlInstanceId: ControlInstanceId,
  systemId: string,
  surfaceId: string,
): Promise<ProcessSurfaceSnapshot> => {
  const body = await queryControlInstancePack(controlInstanceId, {
    packId: 'process-plant',
    kind: 'process-plant.surface.snapshot',
    payload: { systemId, surfaceId },
  })
  const result = requireOkResult(body.response)
  if (typeof result.systemId !== 'string' || typeof result.surfaceId !== 'string') throw new Error('process surface snapshot result requires systemId and surfaceId')
  return {
    systemId: result.systemId,
    surfaceId: result.surfaceId,
    values: assertArray(result.values, 'process surface snapshot result has no values array') as ReadonlyArray<ProcessSurfaceValue>,
  }
}
