import {
  createProcessPlantRampRunner,
  createProcessPlantProtectionRunner,
} from '../runtime/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import { createPlantOperations } from '../operations/plant-operations.ts'
import { manualControllerPositionRefusal } from '../control-write-validation.ts'
import { processPlantEngineKindFor } from '../engine/port.ts'
import { createTsProcessPlantEngine } from '../engine/ts-engine.ts'
import type { NativeProcessPlantEngine } from '../engine/native-engine.ts'
import {
  restoredOperationsFor,
  restoredProtectionSnapshotFor,
  restoredRuntimeCheckpointFor,
  restoredRampSnapshotFor,
  type ProcessPlantRuntimeState,
} from './runtime-state.ts'

/**
 * Each Plant's runtime instance, its engine chosen by its Plant Model (engine/port.ts): the TS runtime is made
 * here; an LD-01 Plant's native engine is connected before (it starts a child) and handed in. An LD-01 Plant's
 * protection runs in its kernel, so it has no TS protection runner.
 */
export const createProcessPlantRuntimeInstances = (config: {
  readonly compiledPlants: ReadonlyArray<CompiledProcessPlant>
  readonly runtimeState: ProcessPlantRuntimeState | null
  readonly nativeEngines?: ReadonlyMap<string, NativeProcessPlantEngine>
}): Map<string, ProcessPlantRuntimeInstance> => new Map(config.compiledPlants.map(plant => [
  plant.id,
  (() => {
    const engineKind = processPlantEngineKindFor(plant.modelRef)
    const native = config.nativeEngines?.get(plant.id)
    if (engineKind === 'native' && native === undefined) throw new Error(`LD-01 Plant ${plant.id} has no connected native engine`)
    if (engineKind === 'ts' && native !== undefined) throw new Error(`process plant ${plant.id} runs on the TS runtime, not a native engine`)
    const runtime = native?.runtime ?? (() => {
      const restoredRuntimeCheckpoint = restoredRuntimeCheckpointFor(config.runtimeState, plant.id)
      return createTsProcessPlantEngine({
        system: plant,
        ...(restoredRuntimeCheckpoint === undefined ? {} : { restoredCheckpoint: restoredRuntimeCheckpoint }),
      }).runtime
    })()
    const restoredRamps = restoredRampSnapshotFor(config.runtimeState, plant.id)
    const restoredProtectionSnapshot = restoredProtectionSnapshotFor(config.runtimeState, plant.id)
    const restoredOperations = restoredOperationsFor(config.runtimeState, plant.id)
    const ramps = createProcessPlantRampRunner({
      runtime,
      canApply: path => manualControllerPositionRefusal({ system: plant, runtime, path }) === null,
      ...(restoredRamps === undefined ? {} : { restoredSnapshot: restoredRamps }),
    })
    // An automatic action's write ends a ramp on the same variable: the ramp no longer reopens a valve a trip shut.
    const protection = native !== undefined ? undefined : createProcessPlantProtectionRunner({
      system: plant,
      protection: plant.automation,
      ...(restoredProtectionSnapshot === undefined ? {} : { restoredSnapshot: restoredProtectionSnapshot }),
      onWrite: path => { ramps.cancel(path) },
    })
    return {
      plant,
      runtime,
      ramps,
      ...(protection === undefined ? {} : { protection }),
      operations: createPlantOperations({ graph: plant.graph, ...(restoredOperations === undefined ? {} : { restored: restoredOperations }) }),
      performance: createProcessPlantRuntimePerformance(),
    }
  })(),
]))
