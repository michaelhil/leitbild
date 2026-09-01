import type { CompiledProcessPlant } from '../plant-compiler.ts'
import type { SimulationRunId } from '../../../core/model/index.ts'
import { createProcessPlantScheduleRunner, type ProcessPlantScheduleConfig } from './schedule.ts'
import { createProcessPlantTelemetryRecorder, type ProcessPlantTelemetryConfig, type ProcessPlantTelemetrySeries } from './telemetry.ts'
import {
  createProcessPlantProtectionRunner,
  type ProcessPlantIcConfig,
  type ProcessPlantIcSnapshot,
} from '../runtime/ic/control-protection.ts'
import { createProcessPlantRuntime } from '../runtime/runtime.ts'
import type { ProcessPlantRuntime, ProcessPlantRuntimeSnapshot } from '../runtime/model.ts'
import type { PwrTransientDiagnostics } from '../runtime/pwr-transient-kernel.ts'

export interface ProcessPlantTestbed {
  readonly runtime: ProcessPlantRuntime
  readonly runFor: (durationMs: number) => ProcessPlantRuntimeSnapshot
}

export const createProcessPlantTestbed = (plant: CompiledProcessPlant): ProcessPlantTestbed => {
  const runtime = createProcessPlantRuntime({ system: plant })
  return {
    runtime,
    runFor: (durationMs: number): ProcessPlantRuntimeSnapshot => {
      runtime.tick(durationMs)
      return runtime.snapshot()
    },
  }
}

export interface ProcessPlantMultiPlantConfig {
  readonly plant: CompiledProcessPlant
  readonly schedule?: ProcessPlantScheduleConfig
  readonly protection?: ProcessPlantIcConfig
  readonly telemetry?: ProcessPlantTelemetryConfig
}

export interface ProcessPlantMultiPlantSnapshot {
  readonly plantId: string
  readonly runtime: ProcessPlantRuntimeSnapshot
  readonly pwrTransientDiagnostics: PwrTransientDiagnostics
  readonly protection?: ProcessPlantIcSnapshot
  readonly telemetry?: ReadonlyArray<ProcessPlantTelemetrySeries>
}

export interface ProcessPlantMultiPlantTestbed {
  readonly runFor: (durationMs: number, stepMs: number) => ReadonlyArray<ProcessPlantMultiPlantSnapshot>
}

export const createProcessPlantMultiPlantTestbed = (
  configs: ReadonlyArray<ProcessPlantMultiPlantConfig>,
): ProcessPlantMultiPlantTestbed => {
  const simulationRunId = 'run-process-plant-testbed' as SimulationRunId
  const plantIds = new Set<string>()
  const plants = configs.map(config => {
    if (plantIds.has(config.plant.id)) throw new Error(`duplicate Plant id in engineering testbed: ${config.plant.id}`)
    plantIds.add(config.plant.id)
    const runtime = createProcessPlantRuntime({ system: config.plant })
    const protection = config.protection === undefined
      ? undefined
      : createProcessPlantProtectionRunner({ system: config.plant, protection: config.protection })
    const telemetry = config.telemetry === undefined
      ? undefined
      : createProcessPlantTelemetryRecorder({ plantId: config.plant.id, telemetry: config.telemetry })
    const schedule = createProcessPlantScheduleRunner({
      system: config.plant,
      ...(config.schedule === undefined ? {} : { schedule: config.schedule }),
    })
    telemetry?.recordDueSamples(runtime)
    return {
      plant: config.plant,
      runtime,
      protection,
      telemetry,
      schedule,
    }
  })

  return {
    runFor: (durationMs: number, stepMs: number): ReadonlyArray<ProcessPlantMultiPlantSnapshot> => {
      if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error(`Process Plant testbed durationMs must be positive, got ${durationMs}`)
      if (!Number.isFinite(stepMs) || stepMs <= 0) throw new Error(`Process Plant testbed stepMs must be positive, got ${stepMs}`)
      let simulatedMs = 0
      while (simulatedMs < durationMs) {
        const tickMs = Math.min(stepMs, durationMs - simulatedMs)
        const nextElapsedMs = simulatedMs + tickMs
        for (const plant of plants) {
          plant.schedule.applyDueActions(plant.runtime, nextElapsedMs)
          plant.runtime.tick(tickMs)
          plant.protection?.evaluate({
            runtime: plant.runtime,
            elapsedMs: plant.runtime.elapsedMs(),
            simulationRunId,
            sourceRuntimeId: 'process-plant-testbed',
          })
          plant.telemetry?.recordDueSamples(plant.runtime)
        }
        simulatedMs = nextElapsedMs
      }
      return plants.map(plant => ({
        plantId: plant.plant.id,
        runtime: plant.runtime.snapshot(),
        pwrTransientDiagnostics: plant.runtime.pwrTransientDiagnostics(),
        ...(plant.protection === undefined ? {} : { protection: plant.protection.snapshot() }),
        ...(plant.telemetry === undefined ? {} : { telemetry: plant.telemetry.series() }),
      }))
    },
  }
}
