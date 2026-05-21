import type { CompiledProcessPlantSystem } from '../process-systems.ts'
import { createProcessPlantRuntime } from './runtime.ts'
import type { ProcessPlantRuntime, ProcessPlantRuntimeSnapshot } from './model.ts'

export interface ProcessPlantTestbed {
  readonly runtime: ProcessPlantRuntime
  readonly runFor: (durationMs: number) => ProcessPlantRuntimeSnapshot
}

export const createProcessPlantTestbed = (system: CompiledProcessPlantSystem): ProcessPlantTestbed => {
  const runtime = createProcessPlantRuntime(system)
  return {
    runtime,
    runFor: (durationMs: number): ProcessPlantRuntimeSnapshot => {
      runtime.tick(durationMs)
      return runtime.snapshot()
    },
  }
}
