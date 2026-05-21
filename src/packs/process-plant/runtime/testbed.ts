import type { CompiledProcessPlantSystem } from '../process-systems.ts'
import { createProcessPlantScheduleRunner, type ProcessPlantScheduleConfig } from './schedule.ts'
import { createProcessPlantTelemetryRecorder, type ProcessPlantTelemetryConfig, type ProcessPlantTelemetrySeries } from './telemetry.ts'
import { createProcessPlantRuntime } from './runtime.ts'
import type { ProcessPlantRuntime, ProcessPlantRuntimeSnapshot } from './model.ts'

export interface ProcessPlantTestbed {
  readonly runtime: ProcessPlantRuntime
  readonly runFor: (durationMs: number) => ProcessPlantRuntimeSnapshot
}

export const createProcessPlantTestbed = (system: CompiledProcessPlantSystem): ProcessPlantTestbed => {
  const runtime = createProcessPlantRuntime({ system })
  return {
    runtime,
    runFor: (durationMs: number): ProcessPlantRuntimeSnapshot => {
      runtime.tick(durationMs)
      return runtime.snapshot()
    },
  }
}

export interface ProcessPlantClusterSystemConfig {
  readonly system: CompiledProcessPlantSystem
  readonly schedule?: ProcessPlantScheduleConfig
  readonly telemetry?: ProcessPlantTelemetryConfig
}

export interface ProcessPlantClusterSystemSnapshot {
  readonly systemId: string
  readonly runtime: ProcessPlantRuntimeSnapshot
  readonly telemetry?: ReadonlyArray<ProcessPlantTelemetrySeries>
}

export interface ProcessPlantClusterTestbed {
  readonly runFor: (durationMs: number, stepMs: number) => ReadonlyArray<ProcessPlantClusterSystemSnapshot>
}

export const createProcessPlantClusterTestbed = (
  configs: ReadonlyArray<ProcessPlantClusterSystemConfig>,
): ProcessPlantClusterTestbed => {
  const systemIds = new Set<string>()
  const systems = configs.map(config => {
    if (systemIds.has(config.system.id)) throw new Error(`duplicate process plant cluster system id: ${config.system.id}`)
    systemIds.add(config.system.id)
    const runtime = createProcessPlantRuntime({ system: config.system })
    const telemetry = config.telemetry === undefined
      ? undefined
      : createProcessPlantTelemetryRecorder({ telemetry: config.telemetry })
    const schedule = createProcessPlantScheduleRunner(config.schedule === undefined ? {} : { schedule: config.schedule })
    telemetry?.recordDueSamples(runtime)
    return {
      system: config.system,
      runtime,
      telemetry,
      schedule,
    }
  })

  return {
    runFor: (durationMs: number, stepMs: number): ReadonlyArray<ProcessPlantClusterSystemSnapshot> => {
      if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error(`process plant cluster durationMs must be positive, got ${durationMs}`)
      if (!Number.isFinite(stepMs) || stepMs <= 0) throw new Error(`process plant cluster stepMs must be positive, got ${stepMs}`)
      let simulatedMs = 0
      while (simulatedMs < durationMs) {
        const tickMs = Math.min(stepMs, durationMs - simulatedMs)
        const nextElapsedMs = simulatedMs + tickMs
        for (const system of systems) {
          system.schedule.applyDueActions(system.runtime, nextElapsedMs)
          system.runtime.tick(tickMs)
          system.telemetry?.recordDueSamples(system.runtime)
        }
        simulatedMs = nextElapsedMs
      }
      return systems.map(system => ({
        systemId: system.system.id,
        runtime: system.runtime.snapshot(),
        ...(system.telemetry === undefined ? {} : { telemetry: system.telemetry.series() }),
      }))
    },
  }
}
