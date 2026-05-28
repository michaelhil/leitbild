import type { PackRuntimeConnectionConfig } from '../../../simulation/protocol.ts'
import type { ProcessPlantSystemRuntime } from '../system-runtime.ts'
import { runtimeStateForProcessPlantSystems } from './runtime-state.ts'

export interface ProcessPlantRuntimePersistence {
  readonly saveNow: () => Promise<void>
}

export const createProcessPlantRuntimePersistence = (config: {
  readonly connection: PackRuntimeConnectionConfig
  readonly systems: ReadonlyMap<string, ProcessPlantSystemRuntime>
}): ProcessPlantRuntimePersistence => ({
  saveNow: async (): Promise<void> => {
    if (!config.connection.runtimeStateStore || config.systems.size === 0) return
    await config.connection.runtimeStateStore.save(runtimeStateForProcessPlantSystems(config.systems))
  },
})
