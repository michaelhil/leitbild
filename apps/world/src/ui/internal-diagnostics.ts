import type { OperationalObject, ScenarioDefinition } from '../core/model/index.ts'
import type { PackPresentationDiagnosticsSnapshot } from '../core/packs/presentation-composer.ts'
import type { StartupStep } from './startup.ts'
import type { MapPerformanceDiagnosticsSnapshot } from './map-runtime/map-performance-diagnostics.ts'
import type { MapRuntimeDiagnosticsSnapshot } from './map-runtime/types.ts'

export interface InternalDiagnosticsRouteSnapshot {
  readonly href: string
  readonly pathname: string
  readonly search: string
}

export interface InternalDiagnosticsBrowserSnapshot {
  readonly userAgent: string
  readonly viewport: {
    readonly width: number
    readonly height: number
    readonly devicePixelRatio: number
  }
  readonly visibilityState: DocumentVisibilityState
  readonly memory?: {
    readonly jsHeapSizeLimit: number
    readonly totalJSHeapSize: number
    readonly usedJSHeapSize: number
  }
}

export interface InternalDiagnosticsStartupMark {
  readonly label: string
  readonly atMs: number
  readonly deltaMs: number
}

export interface InternalDiagnosticsStartupSnapshot {
  readonly status: string
  readonly commandStatus: string
  readonly dismissed: boolean
  readonly statusModalOpen: boolean
  readonly steps: ReadonlyArray<StartupStep>
  readonly marks: ReadonlyArray<InternalDiagnosticsStartupMark>
}

export interface InternalDiagnosticsSimulationRunSnapshot {
  readonly id: string | null
  readonly expectedScenarioId: string | null
  readonly snapshotReady: boolean
  readonly realtimeAttached: boolean
  readonly mapReady: boolean
  readonly selectedControllerId: string | null
}

export interface InternalDiagnosticsScenarioSnapshot {
  readonly id: string | null
  readonly packs: ReadonlyArray<string>
  readonly objectCount: number
  readonly objectCountsByPack: Readonly<Record<string, number>>
}

export interface InternalDiagnosticsMapSnapshot {
  readonly visible: boolean
  readonly ready: boolean
  readonly config: {
    readonly center: readonly [number, number] | null
    readonly zoom: number | null
    readonly layers: ReadonlyArray<string>
  }
  readonly layerGroups: ReadonlyArray<{
    readonly id: string
    readonly visible: boolean
  }>
  readonly referenceDatasetIds: ReadonlyArray<string>
  readonly runtime: MapRuntimeDiagnosticsSnapshot | null
}

export interface InternalDiagnosticsLongTaskAttribution {
  readonly name: string
  readonly entryType: string
  readonly containerType?: string
  readonly containerName?: string
  readonly containerSrc?: string
  readonly containerId?: string
}

export interface InternalDiagnosticsLongTaskSample {
  readonly name: string
  readonly durationMs: number
  readonly startedAtMs: number
  readonly recordedAtMs: number
  readonly attribution: ReadonlyArray<InternalDiagnosticsLongTaskAttribution>
}

export interface InternalDiagnosticsResourceSample {
  readonly name: string
  readonly initiatorType: string
  readonly durationMs: number
  readonly startedAtMs: number
  readonly transferSize: number
  readonly encodedBodySize: number
  readonly decodedBodySize: number
  readonly responseStatus?: number
}

export interface InternalDiagnosticsCapabilityQuerySample {
  readonly ownerId: string
  readonly capabilityId: string
  readonly startedAtMs: number
  readonly durationMs: number
  readonly requestBytes: number
  readonly responseBytes: number
  readonly status?: number
  readonly ok: boolean
  readonly error?: string
}

export interface InternalDiagnosticsCapabilityQuerySummary {
  readonly count: number
  readonly totalResponseBytes: number
  readonly maxResponseBytes: number
  readonly maxDurationMs: number
}

export interface InternalDiagnosticsCapabilityQuerySnapshot {
  readonly sampleCount: number
  readonly recent: ReadonlyArray<InternalDiagnosticsCapabilityQuerySample>
  readonly byCapability: Readonly<Record<string, InternalDiagnosticsCapabilityQuerySummary>>
}

export interface InternalDiagnosticsPerformanceSnapshot {
  readonly map: MapPerformanceDiagnosticsSnapshot
  readonly longTasks: {
    readonly supported: boolean
    readonly sampleCount: number
    readonly worst: InternalDiagnosticsLongTaskSample | null
    readonly recent: ReadonlyArray<InternalDiagnosticsLongTaskSample>
  }
  readonly resources: ReadonlyArray<InternalDiagnosticsResourceSample>
  readonly capabilityQueries: InternalDiagnosticsCapabilityQuerySnapshot
}

export interface InternalDiagnosticsSnapshot {
  readonly capturedAt: string
  readonly appVersion: string
  readonly route: InternalDiagnosticsRouteSnapshot
  readonly browser: InternalDiagnosticsBrowserSnapshot
  readonly startup: InternalDiagnosticsStartupSnapshot
  readonly simulationRun: InternalDiagnosticsSimulationRunSnapshot
  readonly scenario: InternalDiagnosticsScenarioSnapshot
  readonly presentation: PackPresentationDiagnosticsSnapshot
  readonly map: InternalDiagnosticsMapSnapshot
  readonly performance: InternalDiagnosticsPerformanceSnapshot
}

export interface InternalDiagnosticsGlobal {
  readonly snapshot: () => InternalDiagnosticsSnapshot
  readonly snapshotJson: () => string
  readonly clear: () => void
}

export interface LongTaskDiagnosticsMonitor {
  readonly snapshot: () => InternalDiagnosticsPerformanceSnapshot['longTasks']
  readonly clear: () => void
  readonly stop: () => void
}

declare global {
  interface Window {
    __leitbildDiagnostics?: InternalDiagnosticsGlobal
  }
}

const maxLongTaskSamples = 120
const maxResourceSamples = 120
const maxCapabilityQuerySamples = 160
const capabilityQuerySamples: InternalDiagnosticsCapabilityQuerySample[] = []

const pushRing = <T>(items: T[], item: T, limit: number): void => {
  items.push(item)
  if (items.length > limit) items.splice(0, items.length - limit)
}

const objectCountsByPack = (
  objects: ReadonlyArray<OperationalObject>,
): Readonly<Record<string, number>> => {
  const counts: Record<string, number> = {}
  for (const object of objects) {
    counts[object.packId] = (counts[object.packId] ?? 0) + 1
  }
  return counts
}

export const scenarioDiagnosticsFor = (
  scenario: ScenarioDefinition | null,
  objects: ReadonlyArray<OperationalObject>,
): InternalDiagnosticsScenarioSnapshot => ({
  id: scenario?.id ?? null,
  packs: scenario?.packs ?? [],
  objectCount: objects.length,
  objectCountsByPack: objectCountsByPack(objects),
})

const memoryDiagnostics = (): InternalDiagnosticsBrowserSnapshot['memory'] => {
  const candidate = performance as Performance & {
    readonly memory?: {
      readonly jsHeapSizeLimit: number
      readonly totalJSHeapSize: number
      readonly usedJSHeapSize: number
    }
  }
  return candidate.memory
}

export const browserDiagnostics = (): InternalDiagnosticsBrowserSnapshot => {
  const memory = memoryDiagnostics()
  const snapshot: InternalDiagnosticsBrowserSnapshot = {
    userAgent: navigator.userAgent,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    },
    visibilityState: document.visibilityState,
  }
  return memory === undefined ? snapshot : { ...snapshot, memory }
}

export const routeDiagnostics = (): InternalDiagnosticsRouteSnapshot => ({
  href: location.href,
  pathname: location.pathname,
  search: location.search,
})

const unknownString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const longTaskAttribution = (
  entry: PerformanceEntry,
): ReadonlyArray<InternalDiagnosticsLongTaskAttribution> => {
  const candidate = entry as PerformanceEntry & {
    readonly attribution?: ReadonlyArray<{
      readonly name?: unknown
      readonly entryType?: unknown
      readonly containerType?: unknown
      readonly containerName?: unknown
      readonly containerSrc?: unknown
      readonly containerId?: unknown
    }>
  }
  return (candidate.attribution ?? []).map(attribution => {
    const containerType = unknownString(attribution.containerType)
    const containerName = unknownString(attribution.containerName)
    const containerSrc = unknownString(attribution.containerSrc)
    const containerId = unknownString(attribution.containerId)
    const sample: InternalDiagnosticsLongTaskAttribution = {
      name: unknownString(attribution.name) ?? 'unknown',
      entryType: unknownString(attribution.entryType) ?? 'unknown',
    }
    return {
      ...sample,
      ...(containerType === undefined ? {} : { containerType }),
      ...(containerName === undefined ? {} : { containerName }),
      ...(containerSrc === undefined ? {} : { containerSrc }),
      ...(containerId === undefined ? {} : { containerId }),
    }
  })
}

export const createLongTaskDiagnosticsMonitor = (
  now: () => number = () => performance.now(),
): LongTaskDiagnosticsMonitor => {
  const samples: InternalDiagnosticsLongTaskSample[] = []
  let observer: PerformanceObserver | null = null
  const supported = typeof PerformanceObserver !== 'undefined'
    && PerformanceObserver.supportedEntryTypes.includes('longtask')

  if (supported) {
    observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        pushRing(samples, {
          name: entry.name,
          durationMs: entry.duration,
          startedAtMs: entry.startTime,
          recordedAtMs: now(),
          attribution: longTaskAttribution(entry),
        }, maxLongTaskSamples)
      }
    })
    observer.observe({ type: 'longtask', buffered: true })
  }

  return {
    snapshot: () => {
      const worst = samples.reduce<InternalDiagnosticsLongTaskSample | null>(
        (currentWorst, sample) => !currentWorst || sample.durationMs > currentWorst.durationMs ? sample : currentWorst,
        null,
      )
      return {
        supported,
        sampleCount: samples.length,
        worst,
        recent: samples.slice(-24),
      }
    },
    clear: () => {
      samples.splice(0, samples.length)
    },
    stop: () => {
      observer?.disconnect()
      observer = null
    },
  }
}

const interestingResource = (entry: PerformanceResourceTiming): boolean =>
  entry.name.includes('/map/')
  || entry.name.includes('/api/')
  || entry.name.includes('/assets/')
  || entry.name.includes('.pmtiles')
  || entry.name.includes('.pbf')
  || entry.name.includes('.glyph')

export const resourceDiagnostics = (): ReadonlyArray<InternalDiagnosticsResourceSample> =>
  performance.getEntriesByType('resource')
    .filter((entry): entry is PerformanceResourceTiming => entry.entryType === 'resource')
    .filter(interestingResource)
    .slice(-maxResourceSamples)
    .map(entry => ({
      name: entry.name,
      initiatorType: entry.initiatorType,
      durationMs: entry.duration,
      startedAtMs: entry.startTime,
      transferSize: entry.transferSize,
      encodedBodySize: entry.encodedBodySize,
      decodedBodySize: entry.decodedBodySize,
      ...(entry.responseStatus === 0 ? {} : { responseStatus: entry.responseStatus }),
    }))

export const recordCapabilityQueryDiagnostics = (sample: InternalDiagnosticsCapabilityQuerySample): void => {
  pushRing(capabilityQuerySamples, sample, maxCapabilityQuerySamples)
}

export const capabilityQueryDiagnostics = (): InternalDiagnosticsCapabilityQuerySnapshot => {
  const byCapability: Record<string, InternalDiagnosticsCapabilityQuerySummary> = {}
  for (const sample of capabilityQuerySamples) {
    const current = byCapability[sample.capabilityId] ?? {
      count: 0,
      totalResponseBytes: 0,
      maxResponseBytes: 0,
      maxDurationMs: 0,
    }
    byCapability[sample.capabilityId] = {
      count: current.count + 1,
      totalResponseBytes: current.totalResponseBytes + sample.responseBytes,
      maxResponseBytes: Math.max(current.maxResponseBytes, sample.responseBytes),
      maxDurationMs: Math.max(current.maxDurationMs, sample.durationMs),
    }
  }
  return {
    sampleCount: capabilityQuerySamples.length,
    recent: capabilityQuerySamples.slice(-40),
    byCapability,
  }
}

export const clearCapabilityQueryDiagnostics = (): void => {
  capabilityQuerySamples.splice(0, capabilityQuerySamples.length)
}

export const installInternalDiagnosticsGlobal = (
  config: {
    readonly snapshot: () => InternalDiagnosticsSnapshot
    readonly clear: () => void
  },
): (() => void) => {
  if (typeof window === 'undefined') return () => undefined
  const previous = window.__leitbildDiagnostics
  window.__leitbildDiagnostics = {
    snapshot: config.snapshot,
    snapshotJson: () => JSON.stringify(config.snapshot(), null, 2),
    clear: config.clear,
  }
  return () => {
    if (previous) window.__leitbildDiagnostics = previous
    else delete window.__leitbildDiagnostics
  }
}
