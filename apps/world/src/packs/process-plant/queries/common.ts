import { z } from 'zod'
import { idSchema } from '../../../core/model/index.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import { rejectCapabilityTarget } from '../../../simulation/capability-rejection.ts'

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
  return rejectCapabilityTarget(message)
}

/** How many live Plant ids a not-found rejection names before pointing to the catalogue. */
const NAMED_PLANT_COUNT = 8

export const requirePlant = (
  plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>,
  plantId: string,
): ProcessPlantRuntimeInstance => {
  const plant = plants.get(plantId)
  if (!plant) {
    // Naming the live ids lets a guessed id be corrected without another call.
    const ids = [...plants.keys()].sort()
    const named = ids.length === 0 ? 'No Process Plant is live.'
      : `Live Plants: ${ids.slice(0, NAMED_PLANT_COUNT).join(', ')}${ids.length > NAMED_PLANT_COUNT ? ` and ${ids.length - NAMED_PLANT_COUNT} more` : ''}.`
    return capabilityTargetNotFound(`Process Plant not found: ${plantId}. ${named} Their labels are in world.process-plant.plants.list.`)
  }
  return plant
}
