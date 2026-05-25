import type { SimulationConnectionConfig } from '../../../simulation/protocol.ts'
import type { ProcessPlantSystemRuntime } from '../system-runtime.ts'
import { providerStateForProcessPlantSystems } from './provider-state.ts'

export interface ProcessPlantProviderPersistence {
  readonly saveNow: () => Promise<void>
}

export const createProcessPlantProviderPersistence = (config: {
  readonly connection: SimulationConnectionConfig
  readonly systems: ReadonlyMap<string, ProcessPlantSystemRuntime>
}): ProcessPlantProviderPersistence => ({
  saveNow: async (): Promise<void> => {
    if (!config.connection.providerStateStore || config.systems.size === 0) return
    await config.connection.providerStateStore.save(providerStateForProcessPlantSystems(config.systems))
  },
})
