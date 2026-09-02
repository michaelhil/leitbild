import type { PackRuntimeConnectionConfig } from '../../../simulation/protocol.ts'
import { defaultSimulationRunRuntimePolicy } from '../../../core/simulation-runs/runtime-persistence-policy.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import { runtimeStateForProcessPlants } from './runtime-state.ts'

export interface ProcessPlantRuntimePersistence {
  readonly saveNow: () => Promise<void>
  readonly scheduleSave: () => void
}

const runtimeStateFlushIntervalMs = defaultSimulationRunRuntimePolicy.runtimePrivateStateFlushIntervalMs

export const createProcessPlantRuntimePersistence = (config: {
  readonly connection: PackRuntimeConnectionConfig
  readonly plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>
}): ProcessPlantRuntimePersistence => {
  let dirty = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let saveQueue: Promise<void> = Promise.resolve()

  const clearTimer = (): void => {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
  }

  const queueSave = async (): Promise<void> => {
    if (!config.connection.runtimeStateStore) return
    const state = runtimeStateForProcessPlants(config.plants)
    const previousSave = saveQueue
    const save = async (): Promise<void> => {
      try {
        await previousSave
      } catch (err) {
        void err
      }
      await config.connection.runtimeStateStore?.save(state)
    }
    const currentSave = save()
    saveQueue = (async (): Promise<void> => {
      try {
        await currentSave
      } catch (err) {
        void err
      }
    })()
    await currentSave
  }

  const saveNow = async (): Promise<void> => {
    clearTimer()
    dirty = false
    await queueSave()
  }

  const scheduleSave = (): void => {
    if (!config.connection.runtimeStateStore) return
    dirty = true
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      if (!dirty) return
      dirty = false
      const save = async (): Promise<void> => {
        try {
          await queueSave()
        } catch (err) {
          console.error('process-plant runtime state save failed:', err)
        }
      }
      void save()
    }, runtimeStateFlushIntervalMs)
    timer.unref?.()
  }

  return { saveNow, scheduleSave }
}
