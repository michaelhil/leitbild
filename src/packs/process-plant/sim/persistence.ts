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
    const currentSave = saveQueue.then(async () => {
      await config.connection.runtimeStateStore?.save(state)
    })
    saveQueue = currentSave.catch(() => undefined)
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
      void queueSave().catch(err => {
        console.error('process-plant runtime state save failed:', err)
      })
    }, runtimeStateFlushIntervalMs)
    timer.unref?.()
  }

  return { saveNow, scheduleSave }
}
