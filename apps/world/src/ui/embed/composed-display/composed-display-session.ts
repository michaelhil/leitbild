import type { SimulationRunId } from '../../../core/model/index.ts'
import type { ComposedDisplayClient, ComposedDisplaySample, ComposedDisplayViewResult } from './composed-display-client.ts'
import { appendPoint, type TrendPoint, type ValueDomain } from './trend-geometry.ts'

export type ComposedDisplayPhase =
  | { readonly kind: 'checking' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'inactive' }
  | { readonly kind: 'starting' }
  | { readonly kind: 'live' }
  | { readonly kind: 'suspended' }
  | { readonly kind: 'failed'; readonly message: string }

export interface ComposedDisplaySnapshot {
  readonly phase: ComposedDisplayPhase
  readonly view?: ComposedDisplayViewResult
  readonly series: ReadonlyMap<string, ReadonlyArray<TrendPoint>>
  /** Signals without recorded history in the window; their trend starts when the view opened. */
  readonly historyMissing: ReadonlySet<string>
  /** Value range seen per panel since the view opened; it only grows, so scales never jump inward. */
  readonly ranges: ReadonlyArray<ValueDomain | null>
  readonly latest?: ComposedDisplaySample
  readonly playback?: 'playing' | 'paused'
  readonly lastSampleWallMs?: number
  /** Message of the last failed sample; null once a sample succeeds again. */
  readonly sampleError: string | null
  /** The Run's time moved backwards after the advice (reset); the advice may no longer apply. */
  readonly resetSinceAdvice: boolean
}

// Live polling matches the operations recording interval. Presence is cheap
// but only needed to notice pause and removal, so it runs less often.
export const SAMPLE_INTERVAL_MS = 1_000
const PRESENCE_EVERY_SAMPLES = 5
// After this long without interaction the view stops polling, so a forgotten
// open chat cannot keep a Run simulating indefinitely.
export const IDLE_SUSPEND_MS = 15 * 60_000

export const createComposedDisplaySession = (config: {
  readonly runId: SimulationRunId
  readonly plantId: string
  readonly state: string
  readonly client: ComposedDisplayClient
  readonly onChange: (snapshot: ComposedDisplaySnapshot) => void
  readonly wallNow?: () => number
}) => {
  const wallNow = config.wallNow ?? (() => Date.now())
  let closed = false
  let timer: ReturnType<typeof setInterval> | undefined
  let polls = 0
  let lastInteractionWallMs = wallNow()
  let lastSimulationMs: number | undefined
  let snapshot: ComposedDisplaySnapshot = { phase: { kind: 'checking' }, series: new Map(), historyMissing: new Set(), ranges: [], sampleError: null, resetSinceAdvice: false }

  const update = (patch: Partial<ComposedDisplaySnapshot>): void => {
    if (closed) return
    snapshot = { ...snapshot, ...patch }
    config.onChange(snapshot)
  }

  const fail = (error: unknown): void => update({ phase: { kind: 'failed', message: error instanceof Error ? error.message : String(error) } })

  const stopPolling = (): void => { clearInterval(timer); timer = undefined }

  const pens = (): ReadonlyArray<{ readonly path: string; readonly seriesId: string; readonly horizonMs: number }> =>
    snapshot.view?.display.panels.flatMap(panel => panel.pens.map(pen => ({ path: String(pen.path), seriesId: pen.seriesId, horizonMs: panel.horizonMs }))) ?? []

  const grownRanges = (series: ReadonlyMap<string, ReadonlyArray<TrendPoint>>): ReadonlyArray<ValueDomain | null> =>
    (snapshot.view?.display.panels ?? []).map((panel, index) => {
      const values = panel.pens.flatMap(pen => (series.get(String(pen.path)) ?? []).map(point => point.v))
      const previous = snapshot.ranges[index] ?? null
      if (values.length === 0) return previous
      const min = Math.min(...values, ...(previous === null ? [] : [previous.min]))
      const max = Math.max(...values, ...(previous === null ? [] : [previous.max]))
      return { min, max }
    })

  const applySample = (sample: ComposedDisplaySample): void => {
    const at = Date.parse(sample.simulationTime)
    const reset = lastSimulationMs !== undefined && at < lastSimulationMs
    lastSimulationMs = at
    const series = new Map(reset ? [] : snapshot.series)
    for (const pen of pens()) {
      const value = sample.values.find(entry => entry.path === pen.path)?.value
      if (typeof value !== 'number') continue
      series.set(pen.path, appendPoint(series.get(pen.path) ?? [], { t: at, v: value }, at - pen.horizonMs))
    }
    update({ series, ranges: grownRanges(series), latest: sample, lastSampleWallMs: wallNow(), sampleError: null, resetSinceAdvice: snapshot.resetSinceAdvice || reset })
  }

  const checkPresence = async (): Promise<boolean> => {
    const presence = await config.client.presence(config.runId)
    if (presence === null) { stopPolling(); update({ phase: { kind: 'missing' } }); return false }
    if (!presence.loaded) { stopPolling(); update({ phase: { kind: 'inactive' } }); return false }
    update({ playback: presence.playback })
    return true
  }

  const poll = async (): Promise<void> => {
    if (closed || snapshot.phase.kind !== 'live') return
    if (wallNow() - lastInteractionWallMs > IDLE_SUSPEND_MS) { stopPolling(); update({ phase: { kind: 'suspended' } }); return }
    polls += 1
    try {
      if (polls % PRESENCE_EVERY_SAMPLES === 0 && !await checkPresence()) return
      applySample(await config.client.sample(config.runId, config.plantId, pens().map(pen => pen.path)))
    } catch (error) {
      // Keep the last values on screen; the stale marker and this message say they are old.
      update({ sampleError: error instanceof Error ? error.message : String(error) })
    }
  }

  const startPolling = (): void => {
    stopPolling()
    timer = setInterval(() => { void poll() }, SAMPLE_INTERVAL_MS)
  }

  const begin = async (): Promise<void> => {
    update({ phase: { kind: 'starting' } })
    const view = await config.client.view(config.runId, config.plantId, config.state)
    update({ view })
    const now = Date.parse(view.simulationTime)
    const series = new Map<string, ReadonlyArray<TrendPoint>>()
    const historyMissing = new Set<string>()
    await Promise.all(pens().map(async pen => {
      const points = await config.client.history(config.runId, pen.seriesId, { from: now - pen.horizonMs, to: now })
      if (points.length === 0) historyMissing.add(pen.path)
      series.set(pen.path, points)
    }))
    lastSimulationMs = now
    update({ series, ranges: grownRanges(series), historyMissing, phase: { kind: 'live' } })
  }

  return {
    /** Checks presence first and never loads an inactive Run on its own. */
    start: async (options: { readonly poll?: boolean } = {}): Promise<void> => {
      try {
        if (!await checkPresence()) return
        await begin()
        if (options.poll !== false) startPolling()
      } catch (error) { fail(error) }
    },
    loadRun: async (options: { readonly poll?: boolean } = {}): Promise<void> => {
      try {
        update({ phase: { kind: 'starting' } })
        await config.client.loadRun(config.runId)
        await begin()
        if (options.poll !== false) startPolling()
      } catch (error) { fail(error) }
    },
    resume: (): void => {
      lastInteractionWallMs = wallNow()
      if (snapshot.phase.kind !== 'suspended') return
      update({ phase: { kind: 'live' } })
      startPolling()
    },
    interacted: (): void => { lastInteractionWallMs = wallNow() },
    poll,
    setVisible: (visible: boolean): void => {
      if (!visible) { stopPolling(); return }
      if (snapshot.phase.kind === 'live' && timer === undefined) startPolling()
    },
    close: (): void => { closed = true; stopPolling() },
  }
}
