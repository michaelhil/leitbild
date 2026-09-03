import type { PackRuntimeStateStore } from './protocol.ts'

export interface RuntimeStateWriter {
  readonly saveNow: () => Promise<void>
  readonly scheduleSave: () => void
  readonly close: () => Promise<void>
}

export const createRuntimeStateWriter = <T>(config: {
  readonly store?: PackRuntimeStateStore
  readonly readState: () => T
  readonly delayMs: number
  readonly label: string
  readonly onError?: (error: unknown) => void
}): RuntimeStateWriter => {
  let dirty = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let state: 'open' | 'closing' | 'closed' = 'open'
  let saveTail: Promise<void> = Promise.resolve()
  let closePromise: Promise<void> | null = null

  const clearTimer = (): void => {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
  }

  const queueSave = async (): Promise<void> => {
    if (!config.store) return
    const snapshot = config.readState()
    const previous = saveTail
    const current = (async (): Promise<void> => {
      await previous
      await config.store?.save(snapshot)
    })()
    saveTail = current.catch(() => undefined)
    try {
      await current
    } catch (error) {
      config.onError?.(error)
      throw error
    }
  }

  const saveNow = async (): Promise<void> => {
    if (state !== 'open') throw new Error(`${config.label} state writer is ${state}`)
    clearTimer()
    dirty = false
    await queueSave()
  }

  const scheduleSave = (): void => {
    if (!config.store) return
    if (state !== 'open') throw new Error(`${config.label} state writer is ${state}`)
    dirty = true
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      if (!dirty || state !== 'open') return
      dirty = false
      void queueSave().catch(error => {
        console.error(`${config.label} runtime state save failed:`, error)
      })
    }, config.delayMs)
    timer.unref?.()
  }

  const close = (): Promise<void> => {
    if (closePromise) return closePromise
    state = 'closing'
    clearTimer()
    dirty = false
    closePromise = queueSave().finally(() => { state = 'closed' })
    return closePromise
  }

  return { saveNow, scheduleSave, close }
}
