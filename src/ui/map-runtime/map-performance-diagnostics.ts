export interface MapPerformanceSample {
  readonly label: string
  readonly phase: string
  readonly durationMs: number
  readonly startedAtMs: number
  readonly recordedAtMs: number
  readonly details: Readonly<Record<string, string | number | boolean>>
}

export interface MapFrameLagSample {
  readonly lagMs: number
  readonly deltaMs: number
  readonly recordedAtMs: number
}

export interface MapPerformanceDiagnosticsSnapshot {
  readonly sampleCount: number
  readonly slowSampleCount: number
  readonly recentSamples: ReadonlyArray<MapPerformanceSample>
  readonly recentSlowSamples: ReadonlyArray<MapPerformanceSample>
  readonly worstSample: MapPerformanceSample | null
  readonly frameLag: {
    readonly sampleCount: number
    readonly overBudgetCount: number
    readonly worst: MapFrameLagSample | null
    readonly recent: ReadonlyArray<MapFrameLagSample>
  }
  readonly summaryDetails: ReadonlyArray<{ readonly label: string; readonly value: string }>
}

export interface MapPerformanceDiagnostics {
  readonly measure: <T>(
    phase: string,
    label: string,
    run: () => T,
    details?: Readonly<Record<string, string | number | boolean>>,
  ) => T
  readonly measureAsync: <T>(
    phase: string,
    label: string,
    run: () => Promise<T>,
    details?: Readonly<Record<string, string | number | boolean>>,
  ) => Promise<T>
  readonly record: (
    phase: string,
    label: string,
    durationMs: number,
    details?: Readonly<Record<string, string | number | boolean>>,
  ) => void
  readonly recordFrameLag: (sample: MapFrameLagSample) => void
  readonly snapshot: () => MapPerformanceDiagnosticsSnapshot
  readonly clear: () => void
}

export interface LeitbildMapDiagnosticsGlobal {
  readonly snapshot: () => MapPerformanceDiagnosticsSnapshot
  readonly clear: () => void
}

declare global {
  interface Window {
    __leitbildMapDiagnostics?: LeitbildMapDiagnosticsGlobal
  }
}

const maxSamples = 160
const maxFrameSamples = 80
const slowThresholdMs = 16

const roundedMs = (value: number): string =>
  `${value.toFixed(value >= 100 ? 0 : 1)}ms`

const upsertRing = <T>(items: T[], item: T, limit: number): void => {
  items.push(item)
  if (items.length > limit) items.splice(0, items.length - limit)
}

const sampleSummary = (
  sample: MapPerformanceSample | null,
): string =>
  sample
    ? `${sample.phase}:${sample.label} ${roundedMs(sample.durationMs)}`
    : 'none'

const frameLagSummary = (
  sample: MapFrameLagSample | null,
): string =>
  sample ? `${roundedMs(sample.lagMs)} over frame budget (${roundedMs(sample.deltaMs)} delta)` : 'none'

const createSummaryDetails = (
  samples: ReadonlyArray<MapPerformanceSample>,
  frameSamples: ReadonlyArray<MapFrameLagSample>,
): ReadonlyArray<{ readonly label: string; readonly value: string }> => {
  const slowSamples = samples.filter(sample => sample.durationMs >= slowThresholdMs)
  const worstSample = samples.reduce<MapPerformanceSample | null>(
    (worst, sample) => !worst || sample.durationMs > worst.durationMs ? sample : worst,
    null,
  )
  const overBudgetFrames = frameSamples.filter(sample => sample.lagMs >= slowThresholdMs)
  const worstFrame = frameSamples.reduce<MapFrameLagSample | null>(
    (worst, sample) => !worst || sample.lagMs > worst.lagMs ? sample : worst,
    null,
  )
  const latest = samples[samples.length - 1] ?? null
  const latestFrame = frameSamples[frameSamples.length - 1] ?? null
  return [
    { label: 'Perf samples', value: String(samples.length) },
    { label: 'Slow operations', value: String(slowSamples.length) },
    { label: 'Worst operation', value: sampleSummary(worstSample) },
    { label: 'Latest operation', value: sampleSummary(latest) },
    { label: 'Frame lag events', value: String(overBudgetFrames.length) },
    { label: 'Worst frame lag', value: frameLagSummary(worstFrame) },
    { label: 'Latest frame lag', value: frameLagSummary(latestFrame) },
  ]
}

export const createMapPerformanceDiagnostics = (
  now: () => number = () => performance.now(),
): MapPerformanceDiagnostics => {
  const samples: MapPerformanceSample[] = []
  const frameSamples: MapFrameLagSample[] = []

  const record = (
    phase: string,
    label: string,
    durationMs: number,
    details: Readonly<Record<string, string | number | boolean>> = {},
  ): void => {
    upsertRing(samples, {
      phase,
      label,
      durationMs,
      details,
      startedAtMs: now() - durationMs,
      recordedAtMs: now(),
    }, maxSamples)
  }

  const snapshot = (): MapPerformanceDiagnosticsSnapshot => {
    const slowSamples = samples.filter(sample => sample.durationMs >= slowThresholdMs)
    const worstSample = samples.reduce<MapPerformanceSample | null>(
      (worst, sample) => !worst || sample.durationMs > worst.durationMs ? sample : worst,
      null,
    )
    const overBudgetFrames = frameSamples.filter(sample => sample.lagMs >= slowThresholdMs)
    const worstFrame = frameSamples.reduce<MapFrameLagSample | null>(
      (worst, sample) => !worst || sample.lagMs > worst.lagMs ? sample : worst,
      null,
    )
    return {
      sampleCount: samples.length,
      slowSampleCount: slowSamples.length,
      recentSamples: samples.slice(-24),
      recentSlowSamples: slowSamples.slice(-16),
      worstSample,
      frameLag: {
        sampleCount: frameSamples.length,
        overBudgetCount: overBudgetFrames.length,
        worst: worstFrame,
        recent: frameSamples.slice(-16),
      },
      summaryDetails: createSummaryDetails(samples, frameSamples),
    }
  }

  return {
    measure: (phase, label, run, details = {}) => {
      const startedAtMs = now()
      try {
        return run()
      } finally {
        record(phase, label, now() - startedAtMs, details)
      }
    },
    measureAsync: async (phase, label, run, details = {}) => {
      const startedAtMs = now()
      try {
        return await run()
      } finally {
        record(phase, label, now() - startedAtMs, details)
      }
    },
    record,
    recordFrameLag: sample => {
      upsertRing(frameSamples, sample, maxFrameSamples)
    },
    snapshot,
    clear: () => {
      samples.splice(0, samples.length)
      frameSamples.splice(0, frameSamples.length)
    },
  }
}

export const mapPerformanceDiagnostics = createMapPerformanceDiagnostics()

export const installMapPerformanceDiagnosticsGlobal = (): (() => void) => {
  if (typeof window === 'undefined') return () => undefined
  const previous = window.__leitbildMapDiagnostics
  window.__leitbildMapDiagnostics = {
    snapshot: mapPerformanceDiagnostics.snapshot,
    clear: mapPerformanceDiagnostics.clear,
  }
  return () => {
    if (previous) window.__leitbildMapDiagnostics = previous
    else delete window.__leitbildMapDiagnostics
  }
}

export const startFrameLagMonitor = (
  diagnostics: MapPerformanceDiagnostics,
  config: {
    readonly expectedFrameMs?: number
    readonly lagThresholdMs?: number
    readonly requestFrame?: (callback: FrameRequestCallback) => number
    readonly cancelFrame?: (handle: number) => void
    readonly now?: () => number
  } = {},
): (() => void) => {
  const expectedFrameMs = config.expectedFrameMs ?? 16.7
  const lagThresholdMs = config.lagThresholdMs ?? 32
  const requestFrame = config.requestFrame ?? requestAnimationFrame
  const cancelFrame = config.cancelFrame ?? cancelAnimationFrame
  const now = config.now ?? (() => performance.now())
  let frame: number | null = null
  let stopped = false
  let previousAtMs = now()

  const step = (atMs: number): void => {
    if (stopped) return
    const deltaMs = atMs - previousAtMs
    previousAtMs = atMs
    const lagMs = Math.max(0, deltaMs - expectedFrameMs)
    if (lagMs >= lagThresholdMs) {
      diagnostics.recordFrameLag({
        lagMs,
        deltaMs,
        recordedAtMs: now(),
      })
    }
    frame = requestFrame(step)
  }

  frame = requestFrame(step)
  return () => {
    stopped = true
    if (frame !== null) cancelFrame(frame)
    frame = null
  }
}
