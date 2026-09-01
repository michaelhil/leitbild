import { createProcessPlantRuntime } from '../runtime/index.ts'
import {
  createProcessPlantRampRunner,
  createProcessPlantProtectionRunner,
} from '../runtime/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import {
  restoredProtectionSnapshotFor,
  restoredRuntimeCheckpointFor,
  restoredRampSnapshotFor,
  type ProcessPlantRuntimeState,
} from './runtime-state.ts'

export const createProcessPlantRuntimeInstances = (config: {
  readonly compiledPlants: ReadonlyArray<CompiledProcessPlant>
  readonly runtimeState: ProcessPlantRuntimeState | null
}): ReadonlyMap<string, ProcessPlantRuntimeInstance> => new Map(config.compiledPlants.map(plant => [
  plant.id,
  (() => {
    const restoredRuntimeCheckpoint = restoredRuntimeCheckpointFor(config.runtimeState, plant.id)
    const runtime = createProcessPlantRuntime({
      system: plant,
      ...(restoredRuntimeCheckpoint === undefined ? {} : { restoredCheckpoint: restoredRuntimeCheckpoint }),
    })
    const restoredRamps = restoredRampSnapshotFor(config.runtimeState, plant.id)
    const restoredProtectionSnapshot = restoredProtectionSnapshotFor(config.runtimeState, plant.id)
    const protection = createProcessPlantProtectionRunner({
      system: plant,
      protection: plant.automation,
      ...(restoredProtectionSnapshot === undefined ? {} : { restoredSnapshot: restoredProtectionSnapshot }),
    })
    return {
      plant,
      runtime,
      ramps: createProcessPlantRampRunner({
        runtime,
        ...(restoredRamps === undefined ? {} : { restoredSnapshot: restoredRamps }),
      }),
      protection,
      performance: createProcessPlantRuntimePerformance(),
    }
  })(),
]))
