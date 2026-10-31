export interface PhysicalAnnotationCandidate<T> { readonly key: string; readonly priority: number; readonly value: T }
export interface PhysicalAnnotationProgress<T> { readonly visible: ReadonlyArray<T>; readonly pending: number; readonly total: number; readonly generation: string }
export interface PhysicalWorkDeadline { readonly timeRemaining: () => number }
type Schedule = (work: (deadline: PhysicalWorkDeadline) => void) => () => void

/** Browser idle deadlines adapt to current frame/input load; RAF fallback learns its cadence. */
const browserScheduler = (): Schedule => {
  let lastFrame: number | null = null, interval = Infinity
  return work => {
    if (typeof requestIdleCallback === 'function') { const id = requestIdleCallback(work); return () => cancelIdleCallback(id) }
    const id = requestAnimationFrame(at => {
      if (lastFrame !== null) interval = Math.min(interval, at - lastFrame)
      lastFrame = at
      work({ timeRemaining: () => Number.isFinite(interval) ? Math.max(0, interval - (performance.now() - at)) : 0 })
    })
    return () => cancelAnimationFrame(id)
  }
}

/**
 * Resumable attention work, not an object/badge cap. Completed candidates survive
 * same-generation status refreshes; stale geometry/camera/perspective never does.
 */
export const createPhysicalAnnotationScheduler = <T>(options: {
  readonly test: (value: T) => boolean
  readonly onChange: (state: PhysicalAnnotationProgress<T>) => void
  readonly schedule?: Schedule
  readonly now?: () => number
}) => {
  const schedule = options.schedule ?? browserScheduler(), now = options.now ?? (() => performance.now())
  const candidates = new Map<string, { candidate: PhysicalAnnotationCandidate<T>; enqueued: number; ordinal: number }>(), completed = new Map<string, boolean>()
  let generation = '', active = true, destroyed = false, cancel: (() => void) | null = null, served = 0, ordinal = 0, totalCost = 0, costSamples = 0, preemptKey: string | null = null
  const emit = (): void => options.onChange({ generation, total: candidates.size, pending: candidates.size - completed.size, visible: [...candidates.values()].filter(entry => completed.get(entry.candidate.key)).map(entry => entry.candidate.value) })
  const enqueue = (): void => {
    if (!active || destroyed || cancel !== null || candidates.size === completed.size) return
    cancel = schedule(deadline => {
      cancel = null
      if (!active || destroyed) return
      const expectedGeneration = generation
      let worked = false
      while (candidates.size > completed.size && (!worked || deadline.timeRemaining() > (costSamples ? totalCost / costSamples : 0))) {
        // Service aging eventually overtakes a finite priority difference. New
        // urgent work preempts ordinary peers; it does not erase their progress.
        const pending = [...candidates.values()].filter(entry => !completed.has(entry.candidate.key))
        const next = pending.find(entry => entry.candidate.key === preemptKey) ?? pending.sort((a, b) =>
          (b.candidate.priority + served - b.enqueued) - (a.candidate.priority + served - a.enqueued) || a.ordinal - b.ordinal)[0]
        if (!next) break
        const before = now(), visible = options.test(next.candidate.value)
        if (destroyed || generation !== expectedGeneration || !active) return
        preemptKey = null
        totalCost += Math.max(0, now() - before); costSamples++; served++; completed.set(next.candidate.key, visible); worked = true
      }
      emit(); enqueue()
    })
  }
  return {
    update(nextGeneration: string, values: ReadonlyArray<PhysicalAnnotationCandidate<T>>): void {
      if (destroyed) return
      if (new Set(values.map(value => value.key)).size !== values.length || values.some(value => !Number.isFinite(value.priority))) throw new Error('Annotation candidates need unique keys and finite attention priorities')
      if (generation !== nextGeneration) { cancel?.(); cancel = null; candidates.clear(); completed.clear(); generation = nextGeneration; served = 0; ordinal = 0; preemptKey = null }
      const present = new Set(values.map(value => value.key))
      for (const key of candidates.keys()) if (!present.has(key)) { candidates.delete(key); completed.delete(key) }
      const highestPending = Math.max(-Infinity, ...[...candidates.values()].filter(entry => !completed.has(entry.candidate.key)).map(entry => entry.candidate.priority))
      for (const candidate of values) {
        const prior = candidates.get(candidate.key)
        if ((!prior || candidate.priority > prior.candidate.priority) && candidate.priority > highestPending && (preemptKey === null || candidate.priority > (candidates.get(preemptKey)?.candidate.priority ?? -Infinity))) preemptKey = candidate.key
        candidates.set(candidate.key, prior ? { ...prior, candidate } : { candidate, enqueued: served, ordinal: ordinal++ })
      }
      emit(); enqueue()
    },
    setActive(value: boolean): void { if (active === value || destroyed) return; active = value; if (!active) { cancel?.(); cancel = null } else enqueue() },
    destroy(): void { destroyed = true; cancel?.(); cancel = null; candidates.clear(); completed.clear() },
  }
}
