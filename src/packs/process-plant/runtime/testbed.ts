import type { CompiledProcessPlantSystem } from '../process-systems.ts'
import { createProcessPlantScheduleRunner, type ProcessPlantScheduleConfig } from './schedule.ts'
import { createProcessPlantTelemetryRecorder, type ProcessPlantTelemetryConfig, type ProcessPlantTelemetrySeries } from './telemetry.ts'
import { createProcessPlantRuntime } from './runtime.ts'
import type { ProcessPlantRuntime, ProcessPlantRuntimeSnapshot } from './model.ts'
import type { PwrTransientDiagnostics } from './pwr-transient-kernel.ts'

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

export interface ProcessPlantMultiSystemConfig {
  readonly system: CompiledProcessPlantSystem
  readonly schedule?: ProcessPlantScheduleConfig
  readonly telemetry?: ProcessPlantTelemetryConfig
}

export interface ProcessPlantMultiSystemSnapshot {
  readonly systemId: string
  readonly runtime: ProcessPlantRuntimeSnapshot
  readonly pwrTransientDiagnostics: PwrTransientDiagnostics
  readonly telemetry?: ReadonlyArray<ProcessPlantTelemetrySeries>
}

export interface ProcessPlantMultiSystemTestbed {
  readonly runFor: (durationMs: number, stepMs: number) => ReadonlyArray<ProcessPlantMultiSystemSnapshot>
}

export const createProcessPlantMultiSystemTestbed = (
  configs: ReadonlyArray<ProcessPlantMultiSystemConfig>,
): ProcessPlantMultiSystemTestbed => {
  const systemIds = new Set<string>()
  const systems = configs.map(config => {
    if (systemIds.has(config.system.id)) throw new Error(`duplicate process plant multi-system id: ${config.system.id}`)
    systemIds.add(config.system.id)
    const runtime = createProcessPlantRuntime({ system: config.system })
    const telemetry = config.telemetry === undefined
      ? undefined
      : createProcessPlantTelemetryRecorder({ systemId: config.system.id, telemetry: config.telemetry })
    const schedule = createProcessPlantScheduleRunner({
      system: config.system,
      ...(config.schedule === undefined ? {} : { schedule: config.schedule }),
    })
    telemetry?.recordDueSamples(runtime)
    return {
      system: config.system,
      runtime,
      telemetry,
      schedule,
    }
  })

  return {
    runFor: (durationMs: number, stepMs: number): ReadonlyArray<ProcessPlantMultiSystemSnapshot> => {
      if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error(`process plant multi-system durationMs must be positive, got ${durationMs}`)
      if (!Number.isFinite(stepMs) || stepMs <= 0) throw new Error(`process plant multi-system stepMs must be positive, got ${stepMs}`)
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
        pwrTransientDiagnostics: system.runtime.pwrTransientDiagnostics(),
        ...(system.telemetry === undefined ? {} : { telemetry: system.telemetry.series() }),
      }))
    },
  }
}
