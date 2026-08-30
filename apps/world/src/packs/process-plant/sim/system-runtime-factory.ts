import { createProcessPlantRuntime } from '../runtime/index.ts'
import {
  createProcessPlantRampRunner,
  createProcessPlantTelemetryRecorder,
  createProcessPlantProtectionRunner,
  type ProcessPlantTelemetryConfig,
  type ProcessPlantTelemetryRecorder,
} from '../runtime/index.ts'
import type { CompiledProcessPlantSystem } from '../process-systems.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantSystemRuntime } from '../system-runtime.ts'
import type { ProcessPlantRuntimeConfig } from './runtime-config.ts'
import { protectionConfigFor } from './runtime-config.ts'
import {
  restoredProtectionSnapshotFor,
  restoredRuntimeSnapshotFor,
  restoredRampSnapshotFor,
  restoredTelemetrySnapshotFor,
  type ProcessPlantRuntimeState,
} from './runtime-state.ts'

export const createProcessPlantSystemRuntimes = (config: {
  readonly compiledSystems: ReadonlyArray<CompiledProcessPlantSystem>
  readonly runtimeConfig: ProcessPlantRuntimeConfig
  readonly runtimeState: ProcessPlantRuntimeState | null
}): ReadonlyMap<string, ProcessPlantSystemRuntime> => new Map(config.compiledSystems.map(system => [
  system.id,
  (() => {
    const systemConfig = config.runtimeConfig.systems[system.id]
    const telemetryConfig: ProcessPlantTelemetryConfig | undefined = systemConfig?.telemetry
    const protectionConfig = protectionConfigFor(systemConfig, system)
    const restoredRuntimeSnapshot = restoredRuntimeSnapshotFor(config.runtimeState, system.id)
    const runtime = createProcessPlantRuntime({
      system,
      ...(restoredRuntimeSnapshot === undefined ? {} : { restoredSnapshot: restoredRuntimeSnapshot }),
    })
    const restoredTelemetrySnapshot = restoredTelemetrySnapshotFor(config.runtimeState, system.id)
    const telemetry: ProcessPlantTelemetryRecorder | undefined = telemetryConfig === undefined
      ? undefined
      : createProcessPlantTelemetryRecorder({
          systemId: system.id,
          telemetry: telemetryConfig,
          ...(restoredTelemetrySnapshot === undefined ? {} : { restoredSnapshot: restoredTelemetrySnapshot }),
        })
    telemetry?.recordDueSamples(runtime)
    const restoredRamps = restoredRampSnapshotFor(config.runtimeState, system.id)
    const restoredProtectionSnapshot = restoredProtectionSnapshotFor(config.runtimeState, system.id)
    const protection = protectionConfig === undefined
      ? undefined
      : createProcessPlantProtectionRunner({
          system,
          protection: protectionConfig,
          ...(restoredProtectionSnapshot === undefined ? {} : { restoredSnapshot: restoredProtectionSnapshot }),
        })
    return {
      system,
      runtime,
      ramps: createProcessPlantRampRunner({
        runtime,
        ...(restoredRamps === undefined ? {} : { restoredSnapshot: restoredRamps }),
      }),
      ...(telemetry === undefined ? {} : { telemetry }),
      ...(protection === undefined ? {} : { protection }),
      performance: createProcessPlantRuntimePerformance(),
    }
  })(),
]))
