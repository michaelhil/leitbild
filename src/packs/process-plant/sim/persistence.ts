import type { PackRuntimeConnectionConfig } from '../../../simulation/protocol.ts'
import { defaultControlInstanceRuntimePolicy } from '../../../core/control-instances/runtime-persistence-policy.ts'
import type { ProcessPlantSystemRuntime } from '../system-runtime.ts'
import { runtimeStateForProcessPlantSystems } from './runtime-state.ts'

export interface ProcessPlantRuntimePersistence {
  readonly saveNow: () => Promise<void>
  readonly scheduleSave: () => void
}

const runtimeStateFlushIntervalMs = defaultControlInstanceRuntimePolicy.runtimePrivateStateFlushIntervalMs

export const createProcessPlantRuntimePersistence = (config: {
  readonly connection: PackRuntimeConnectionConfig
  readonly systems: ReadonlyMap<string, ProcessPlantSystemRuntime>
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
    if (!config.connection.runtimeStateStore || config.systems.size === 0) return
    const state = runtimeStateForProcessPlantSystems(config.systems)
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
    if (!config.connection.runtimeStateStore || config.systems.size === 0) return
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
