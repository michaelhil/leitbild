import type { CompiledProcessPlantSystem } from './process-systems.ts'
import type { ProcessPlantProtectionRunner, ProcessPlantRuntime } from './runtime/index.ts'
import type { ProcessPlantScheduleRunner, ProcessPlantTelemetryRecorder } from './runtime/index.ts'

export interface ProcessPlantSystemRuntime {
  readonly system: CompiledProcessPlantSystem
  readonly runtime: ProcessPlantRuntime
  readonly schedule: ProcessPlantScheduleRunner
  readonly telemetry?: ProcessPlantTelemetryRecorder
  readonly protection?: ProcessPlantProtectionRunner
}
