import { z } from 'zod'
import type { GridRuntimeInstance, RestoredGridRuntimeState } from '../runtime/instance.ts'

const finite = z.number().finite()

export const electricGridRuntimeStateSchema = z.object({
  schemaVersion: z.literal(1),
  grids: z.array(z.object({
    gridId: z.string().min(1),
    modelRef: z.string().min(1),
    elapsedMs: finite.nonnegative(),
    tick: z.number().int().nonnegative(),
    frequencies: z.array(z.object({ islandId: z.string().min(1), frequencyHz: finite.positive() }).strict()),
    branches: z.array(z.object({
      id: z.string().min(1),
      state: z.enum(['closed', 'open', 'faulted', 'derated']),
      availability: finite.min(0).max(1),
    }).strict()),
    generators: z.array(z.object({
      id: z.string().min(1),
      state: z.enum(['online', 'offline', 'tripped', 'derated']),
      availableMw: finite.nonnegative(),
      dispatchMw: finite.nonnegative(),
      targetMw: finite.nonnegative(),
    }).strict()),
    loads: z.array(z.object({ id: z.string().min(1), nominalDemandMw: finite.nonnegative() }).strict()),
    storage: z.array(z.object({
      id: z.string().min(1),
      stateOfChargeFraction: finite.min(0).max(1),
      dispatchMw: finite,
    }).strict()),
  }).strict()),
}).strict()
export type ElectricGridRuntimeState = z.infer<typeof electricGridRuntimeStateSchema>

export const runtimeStateForElectricGrids = (grids: ReadonlyMap<string, GridRuntimeInstance>): ElectricGridRuntimeState => ({
  schemaVersion: 1,
  grids: [...grids.values()].map(grid => ({
    gridId: grid.definition.gridId,
    modelRef: grid.definition.model.id,
    elapsedMs: grid.elapsedMs,
    tick: grid.tick,
    frequencies: [...grid.frequencyByIsland].map(([islandId, frequencyHz]) => ({ islandId, frequencyHz })),
    branches: [...grid.branches].map(([id, state]) => ({ id, state: state.state, availability: state.availability })),
    generators: [...grid.generators].map(([id, state]) => ({ id, state: state.state, availableMw: state.availableMw, dispatchMw: state.dispatchMw, targetMw: state.targetMw })),
    loads: [...grid.loads].map(([id, state]) => ({ id, nominalDemandMw: state.nominalDemandMw })),
    storage: [...grid.storage].map(([id, state]) => ({ id, stateOfChargeFraction: state.stateOfChargeFraction, dispatchMw: state.dispatchMw })),
  })),
})

export const restoredGridRuntimeStateFor = (
  state: ElectricGridRuntimeState | null,
  gridId: string,
  modelRef: string,
): RestoredGridRuntimeState | undefined => {
  const grid = state?.grids.find(candidate => candidate.gridId === gridId)
  if (!grid) return undefined
  if (grid.modelRef !== modelRef) throw new Error(`stored Grid ${gridId} uses Model ${grid.modelRef}, expected ${modelRef}`)
  return grid
}
