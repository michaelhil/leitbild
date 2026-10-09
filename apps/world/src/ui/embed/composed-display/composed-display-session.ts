import type { SimulationRunId } from '../../../core/model/index.ts'
import type { CompiledComposedPanel, ComposedDisplayPen } from '../../../packs/process-plant/displays/compose.ts'
import type { ComposedDisplayClient, ComposedDisplaySample, ComposedDisplayViewResult, ViewSize } from './composed-display-client.ts'
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
  /**
   * Value range seen per panel scale (one per trend strip, one for a
   * comparison) since the view opened; it only grows, so scales never jump inward.
   */
  readonly ranges: ReadonlyArray<ReadonlyArray<ValueDomain | null>>
  readonly latest?: ComposedDisplaySample
  readonly playback?: 'playing' | 'paused'
  readonly runTitle?: string
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
const COMPARISON_SERIES_MS = 600_000
// Alarm state marks values in alarm on every panel, not only the alarms strip.
const WITH_ALARMS = true

const pensOf = (panel: CompiledComposedPanel): ReadonlyArray<ComposedDisplayPen> => {
  if (panel.kind === 'alarms' || panel.kind === 'mimic') return []
  return panel.kind === 'trend' ? [...panel.strips.flatMap(strip => strip.pens), ...panel.live] : panel.pens
}

/** Pens drawn over time: trend strips (not their live-only rows) and comparisons, which show rates. */
const plottedPensOf = (panel: CompiledComposedPanel): ReadonlyArray<ComposedDisplayPen> => {
  if (panel.kind === 'trend') return panel.strips.flatMap(strip => strip.pens)
  return panel.kind === 'comparison' ? panel.pens : []
}

export const createComposedDisplaySession = (config: {
  readonly runId: SimulationRunId
  readonly plantId: string
  readonly state: string
  readonly client: ComposedDisplayClient
  readonly onChange: (snapshot: ComposedDisplaySnapshot) => void
  /** Advice stops updating after a quarter of an hour unattended; an operating overview keeps updating. */
  readonly suspendWhenIdle: boolean
  /** The view's current size, which a generated display is drawn for; null for advice. */
  readonly size: () => ViewSize | null
  readonly wallNow?: () => number
}) => {
  const wallNow = config.wallNow ?? (() => Date.now())
  let closed = false
  let timer: ReturnType<typeof setInterval> | undefined
  let polls = 0
  let lastInteractionWallMs = wallNow()
  let lastSimulationMs: number | undefined
  let snapshot: ComposedDisplaySnapshot = { phase: { kind: 'checking' }, series: new Map(), historyMissing: new Set(), ranges: [], sampleError: null, resetSinceAdvice: false }
  // What the view shows: the state it was embedded with, or equipment opened from a generated display.
  let state = config.state

  const update = (patch: Partial<ComposedDisplaySnapshot>): void => {
    if (closed) return
    snapshot = { ...snapshot, ...patch }
    config.onChange(snapshot)
  }

  const fail = (error: unknown): void => update({ phase: { kind: 'failed', message: error instanceof Error ? error.message : String(error) } })

  const stopPolling = (): void => { clearInterval(timer); timer = undefined }

  const panels = () => snapshot.view?.display.panels ?? []

  /** Every displayed signal is sampled once, however many panels show it. */
  const sampledPaths = (): ReadonlyArray<string> => [...new Set(panels().flatMap(panel => panel.kind === 'mimic'
    ? panel.mimic.paths.map(String)
    : pensOf(panel).map(pen => String(pen.path))))]

  /** Trends keep their horizon; comparisons keep ten minutes for rates. Readouts use the latest sample. */
  const trendPens = (): ReadonlyArray<{ readonly path: string; readonly seriesId: string; readonly horizonMs: number }> =>
    panels().flatMap(panel => plottedPensOf(panel).map(pen => ({
      path: String(pen.path),
      seriesId: pen.seriesId,
      horizonMs: panel.kind === 'trend' ? panel.horizonMs : COMPARISON_SERIES_MS,
    })))

  /** Values on each scale of a panel: trends their history per strip, comparisons the latest sample. */
  const scaleValues = (
    panel: CompiledComposedPanel,
    series: ReadonlyMap<string, ReadonlyArray<TrendPoint>>,
    latest: ComposedDisplaySample | undefined,
  ): ReadonlyArray<ReadonlyArray<number>> => {
    if (panel.kind === 'trend') return panel.strips.map(strip => strip.pens.flatMap(pen => (series.get(String(pen.path)) ?? []).map(point => point.v)))
    if (panel.kind !== 'comparison') return []
    const paths = new Set(panel.pens.map(pen => String(pen.path)))
    return [(latest?.values ?? []).flatMap(entry => paths.has(entry.path) && typeof entry.value === 'number' ? [entry.value] : [])]
  }

  const grownRanges = (
    series: ReadonlyMap<string, ReadonlyArray<TrendPoint>>,
    latest: ComposedDisplaySample | undefined,
  ): ReadonlyArray<ReadonlyArray<ValueDomain | null>> => panels().map((panel, index) =>
    scaleValues(panel, series, latest).map((values, scale) => {
      const previous = snapshot.ranges[index]?.[scale] ?? null
      if (values.length === 0) return previous
      return {
        min: Math.min(...values, ...(previous === null ? [] : [previous.min])),
        max: Math.max(...values, ...(previous === null ? [] : [previous.max])),
      }
    }))

  const applySample = (sample: ComposedDisplaySample): void => {
    const at = Date.parse(sample.simulationTime)
    const reset = lastSimulationMs !== undefined && at < lastSimulationMs
    lastSimulationMs = at
    const series = new Map(reset ? [] : snapshot.series)
    for (const pen of trendPens()) {
      const value = sample.values.find(entry => entry.path === pen.path)?.value
      if (typeof value !== 'number') continue
      series.set(pen.path, appendPoint(series.get(pen.path) ?? [], { t: at, v: value }, at - pen.horizonMs))
    }
    update({ series, ranges: grownRanges(series, sample), latest: sample, lastSampleWallMs: wallNow(), sampleError: null, resetSinceAdvice: snapshot.resetSinceAdvice || reset })
  }

  const checkPresence = async (): Promise<boolean> => {
    const presence = await config.client.presence(config.runId)
    if (presence === null) { stopPolling(); update({ phase: { kind: 'missing' } }); return false }
    if (!presence.loaded) { stopPolling(); update({ phase: { kind: 'inactive' } }); return false }
    update({ playback: presence.playback, runTitle: presence.title })
    return true
  }

  const poll = async (): Promise<void> => {
    if (closed || snapshot.phase.kind !== 'live') return
    if (config.suspendWhenIdle && wallNow() - lastInteractionWallMs > IDLE_SUSPEND_MS) { stopPolling(); update({ phase: { kind: 'suspended' } }); return }
    polls += 1
    try {
      if (polls % PRESENCE_EVERY_SAMPLES === 0 && !await checkPresence()) return
      applySample(await config.client.sample(config.runId, config.plantId, sampledPaths(), WITH_ALARMS))
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
    const view = await config.client.view(config.runId, config.plantId, state, config.size())
    update({ view })
    const now = Date.parse(view.simulationTime)
    const series = new Map<string, ReadonlyArray<TrendPoint>>()
    const historyMissing = new Set<string>()
    await Promise.all(trendPens().map(async pen => {
      const points = await config.client.history(config.runId, pen.seriesId, { from: now - pen.horizonMs, to: now })
      if (points.length === 0) historyMissing.add(pen.path)
      series.set(pen.path, points)
    }))
    lastSimulationMs = now
    // The first sample fills readouts, comparisons and alarms before polling starts.
    const first = await config.client.sample(config.runId, config.plantId, sampledPaths(), WITH_ALARMS)
    update({ series, historyMissing, latest: first, lastSampleWallMs: wallNow(), ranges: grownRanges(series, first), phase: { kind: 'live' } })
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
    /** A generated display is drawn again for the view's new size; its samples carry on. */
    relayout: async (): Promise<void> => {
      if (closed || (snapshot.view?.kind !== 'overview' && snapshot.view?.kind !== 'detail')) return
      const drawn = state
      try {
        const view = await config.client.view(config.runId, config.plantId, drawn, config.size())
        if (drawn === state) update({ view })
      } catch (error) {
        update({ sampleError: error instanceof Error ? error.message : String(error) })
      }
    },
    /**
     * Shows another generated display of the same Plant in place (equipment
     * opened from an overview, or back). Generated displays have no trends,
     * so only the latest sample carries over until the next one arrives. A
     * display that cannot be drawn leaves the current one and rejects.
     */
    open: async (next: string): Promise<void> => {
      if (closed) return
      const view = await config.client.view(config.runId, config.plantId, next, config.size())
      if (closed) return
      state = next
      update({ view, series: new Map(), historyMissing: new Set(), ranges: [] })
      if (snapshot.phase.kind === 'live') await poll()
    },
    poll,
    setVisible: (visible: boolean): void => {
      if (!visible) { stopPolling(); return }
      if (snapshot.phase.kind === 'live' && timer === undefined) startPolling()
    },
    close: (): void => { closed = true; stopPolling() },
  }
}
