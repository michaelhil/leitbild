import { createProcessPlantRuntime } from '../runtime/index.ts'
import {
  createProcessPlantScheduleRunner,
  createProcessPlantTelemetryRecorder,
  createProcessPlantProtectionRunner,
  type ProcessPlantScheduleConfig,
  type ProcessPlantTelemetryConfig,
  type ProcessPlantTelemetryRecorder,
} from '../runtime/index.ts'
import type { CompiledProcessPlantSystem } from '../process-systems.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantSystemRuntime } from '../system-runtime.ts'
import type { ProcessPlantProviderConfig } from './provider-config.ts'
import { protectionConfigFor } from './provider-config.ts'
import {
  restoredProtectionSnapshotFor,
  restoredRuntimeSnapshotFor,
  restoredScheduleSnapshotFor,
  restoredTelemetrySnapshotFor,
  type ProcessPlantProviderState,
} from './provider-state.ts'

export const createProcessPlantSystemRuntimes = (config: {
  readonly compiledSystems: ReadonlyArray<CompiledProcessPlantSystem>
  readonly providerConfig: ProcessPlantProviderConfig
  readonly providerState: ProcessPlantProviderState | null
}): ReadonlyMap<string, ProcessPlantSystemRuntime> => new Map(config.compiledSystems.map(system => [
  system.id,
  (() => {
    const systemConfig = config.providerConfig.systems[system.id]
    const telemetryConfig: ProcessPlantTelemetryConfig | undefined = systemConfig?.telemetry
    const scheduleConfig: ProcessPlantScheduleConfig | undefined = systemConfig?.schedule
    const protectionConfig = protectionConfigFor(systemConfig)
    const restoredRuntimeSnapshot = restoredRuntimeSnapshotFor(config.providerState, system.id)
    const runtime = createProcessPlantRuntime({
      system,
      ...(restoredRuntimeSnapshot === undefined ? {} : { restoredSnapshot: restoredRuntimeSnapshot }),
    })
    const restoredTelemetrySnapshot = restoredTelemetrySnapshotFor(config.providerState, system.id)
    const telemetry: ProcessPlantTelemetryRecorder | undefined = telemetryConfig === undefined
      ? undefined
      : createProcessPlantTelemetryRecorder({
          systemId: system.id,
          telemetry: telemetryConfig,
          ...(restoredTelemetrySnapshot === undefined ? {} : { restoredSnapshot: restoredTelemetrySnapshot }),
        })
    telemetry?.recordDueSamples(runtime)
    const restoredSchedule = restoredScheduleSnapshotFor(config.providerState, system.id)
    const restoredProtectionSnapshot = restoredProtectionSnapshotFor(config.providerState, system.id)
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
      schedule: createProcessPlantScheduleRunner({
        system,
        ...(scheduleConfig === undefined ? {} : { schedule: scheduleConfig }),
        ...(restoredSchedule === undefined ? {} : { restoredSnapshot: restoredSchedule }),
      }),
      ...(telemetry === undefined ? {} : { telemetry }),
      ...(protection === undefined ? {} : { protection }),
      performance: createProcessPlantRuntimePerformance(),
    }
  })(),
]))
