import type { RenderFamily } from './types.ts'

export interface ScheduledMapUpdate {
  readonly family: RenderFamily
  readonly priority: number
  readonly minIntervalMs?: number
  readonly run: () => void
}

export interface MapUpdateScheduler {
  readonly schedule: (update: ScheduledMapUpdate) => void
  readonly flushNow: () => void
  readonly stop: () => void
}

export interface MapUpdateSchedulerConfig {
  readonly frameBudgetMs?: number
  readonly now?: () => number
  readonly requestFrame?: (callback: FrameRequestCallback) => number
  readonly cancelFrame?: (id: number) => void
}

interface PendingUpdate {
  readonly family: RenderFamily
  readonly priority: number
  readonly minIntervalMs: number
  readonly run: () => void
  readonly queuedAtMs: number
}

const defaultFrameBudgetMs = 7

export const createMapUpdateScheduler = (
  config: MapUpdateSchedulerConfig = {},
): MapUpdateScheduler => {
  const now = config.now ?? (() => performance.now())
  const requestFrame = config.requestFrame ?? requestAnimationFrame
  const cancelFrame = config.cancelFrame ?? cancelAnimationFrame
  const pending = new Map<RenderFamily, PendingUpdate>()
  const lastRunAtMs = new Map<RenderFamily, number>()
  let frameId: number | null = null

  const clearFrame = (): void => {
    if (frameId === null) return
    cancelFrame(frameId)
    frameId = null
  }

  const runFrame = (): void => {
    frameId = null
    const startedAt = now()
    const budget = config.frameBudgetMs ?? defaultFrameBudgetMs
    while (pending.size > 0) {
      const next = [...pending.values()]
        .sort((left, right) => right.priority - left.priority || left.queuedAtMs - right.queuedAtMs)[0]
      if (!next) break
      const lastRun = lastRunAtMs.get(next.family) ?? -Infinity
      if (startedAt - lastRun < next.minIntervalMs) {
        scheduleFrame()
        break
      }
      pending.delete(next.family)
      next.run()
      lastRunAtMs.set(next.family, now())
      if (now() - startedAt >= budget && pending.size > 0) {
        scheduleFrame()
        break
      }
    }
  }

  const scheduleFrame = (): void => {
    if (frameId !== null) return
    frameId = requestFrame(runFrame)
  }

  return {
    schedule: (update) => {
      pending.set(update.family, {
        family: update.family,
        priority: update.priority,
        minIntervalMs: update.minIntervalMs ?? 0,
        run: update.run,
        queuedAtMs: now(),
      })
      scheduleFrame()
    },
    flushNow: () => {
      clearFrame()
      const updates = [...pending.values()]
        .sort((left, right) => right.priority - left.priority || left.queuedAtMs - right.queuedAtMs)
      pending.clear()
      for (const update of updates) {
        update.run()
        lastRunAtMs.set(update.family, now())
      }
    },
    stop: () => {
      clearFrame()
      pending.clear()
      lastRunAtMs.clear()
    },
  }
}
