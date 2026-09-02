import { defaultSimulationRunRuntimePolicy } from '../../../core/simulation-runs/runtime-persistence-policy.ts'
import type { PackRuntimeConnectionConfig } from '../../../simulation/protocol.ts'
import type { GridRuntimeInstance } from '../runtime/instance.ts'
import { runtimeStateForElectricGrids } from './runtime-state.ts'

export interface ElectricGridRuntimePersistence {
  readonly saveNow: () => Promise<void>
  readonly scheduleSave: () => void
}

export const createElectricGridRuntimePersistence = (config: {
  readonly connection: PackRuntimeConnectionConfig
  readonly grids: ReadonlyMap<string, GridRuntimeInstance>
  readonly onError?: (error: unknown) => void
}): ElectricGridRuntimePersistence => {
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
    const state = runtimeStateForElectricGrids(config.grids)
    const previous = saveQueue
    const save = async (): Promise<void> => {
      try { await previous } catch (error) { void error }
      await config.connection.runtimeStateStore?.save(state)
    }
    const current = save()
    saveQueue = current.catch(() => undefined)
    try {
      await current
    } catch (error) {
      config.onError?.(error)
      throw error
    }
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
      void queueSave().catch(error => {
        console.error('electric-grid runtime state save failed:', error)
      })
    }, defaultSimulationRunRuntimePolicy.runtimePrivateStateFlushIntervalMs)
    timer.unref?.()
  }
  return { saveNow, scheduleSave }
}
