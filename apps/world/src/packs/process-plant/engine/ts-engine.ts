import { createProcessPlantRuntime } from '../runtime/runtime.ts'
import type { ProcessPlantRuntime } from '../runtime/model.ts'

// The reference PWR Plant's engine: this Pack's TS runtime, unchanged. It ticks synchronously inside the
// adapter's exchange, exactly as before the engine port existed.

export interface TsProcessPlantEngine {
  readonly kind: 'ts'
  readonly runtime: ProcessPlantRuntime
}

export const createTsProcessPlantEngine = (config: Parameters<typeof createProcessPlantRuntime>[0]): TsProcessPlantEngine => ({
  kind: 'ts',
  runtime: createProcessPlantRuntime(config),
})
