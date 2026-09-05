import { z } from 'zod'
import { idSchema } from '../../../core/model/index.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'

export const plantQuerySchema = z.object({
  plantId: idSchema,
}).strict()

// Runtime catalogs can reach thousands of entries in larger Plants. Search
// Capabilities therefore share one small, predictable pagination contract.
// The limit bounds model-context and network output; callers that need the
// full set can continue from offset + returned while hasMore is true.
export const PROCESS_PLANT_SEARCH_DEFAULT_LIMIT = 100
export const PROCESS_PLANT_SEARCH_MAX_LIMIT = 500
export const processPlantSearchPaginationShape = {
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(PROCESS_PLANT_SEARCH_MAX_LIMIT).default(PROCESS_PLANT_SEARCH_DEFAULT_LIMIT),
} as const

export const paginateProcessPlantSearch = <T>(items: ReadonlyArray<T>, offset: number, limit: number): {
  readonly total: number
  readonly offset: number
  readonly returned: number
  readonly hasMore: boolean
  readonly items: ReadonlyArray<T>
} => {
  const page = items.slice(offset, offset + limit)
  return {
    total: items.length,
    offset,
    returned: page.length,
    hasMore: offset + page.length < items.length,
    items: page,
  }
}

export const failure = (
  reason: string,
): never => { throw new Error(reason) }

export const capabilityTargetNotFound = (message: string): never => {
  throw Object.assign(new Error(message), { code: 'capability_target_not_found' as const })
}

export const requirePlant = (
  plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>,
  plantId: string,
): ProcessPlantRuntimeInstance => {
  const plant = plants.get(plantId)
  if (!plant) return capabilityTargetNotFound(
    `Process Plant not found: ${plantId}. Discover live Plant identities with world.process-plant.plants.list.`,
  )
  return plant
}
