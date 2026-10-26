import { describe, expect, test, spyOn } from 'bun:test'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { geoPointFromLonLat, type GeoJsonPolygon } from '../src/core/model/index.ts'
import type { PackMapFeature } from '../src/core/packs/protocol.ts'
import { createMapPerformanceDiagnostics } from '../src/ui/map-runtime/map-performance-diagnostics.ts'
import { createPackOverlayController } from '../src/ui/map-runtime/pack-overlay-controller.ts'
import type { MapRuntimeDiagnosticPhaseReport, MapRuntimeHandle } from '../src/ui/map-runtime/types.ts'

const viewport: GeoJsonPolygon = {
  type: 'Polygon',
  coordinates: [[
    geoPointFromLonLat(10, 59).coordinates,
    geoPointFromLonLat(11, 59).coordinates,
    geoPointFromLonLat(11, 60).coordinates,
    geoPointFromLonLat(10, 60).coordinates,
    geoPointFromLonLat(10, 59).coordinates,
  ]],
}

const featureFor = (id: string): PackMapFeature => ({
  id,
  categoryId: 'weather',
  geometry: viewport,
  color: '#2563eb',
  summary: id,
})

const createRuntime = (
  reports: MapRuntimeDiagnosticPhaseReport[],
): MapRuntimeHandle => ({
  map: {
    getZoom: () => 8,
  } as unknown as MapLibreMap,
  claimErrors: () => () => undefined,
  updateLayers: () => undefined,
  reportDiagnosticPhase: report => {
    reports.push(report)
  },
  setDiagnosticDetails: () => undefined,
  setStyleUrl: async () => undefined,
  resize: () => undefined,
  setCameraInteraction: () => undefined,
  setPickingRadius: () => undefined,
  diagnostics: () => ({ phases: [] }),
  destroy: () => undefined,
})

describe('PackOverlayController', () => {
  test('does not query when disabled and clears active features', async () => {
    const reports: MapRuntimeDiagnosticPhaseReport[] = []
    let loadCalls = 0
    let features: ReadonlyArray<PackMapFeature> = [featureFor('stale')]
    let changed = 0
    const controller = createPackOverlayController({
      getRuntime: () => createRuntime(reports),
      getViewport: () => viewport,
      getCurrentTime: () => undefined,
      getSourceRevisionKey: () => 'r1',
      active: () => true,
      enabled: () => false,
      loadFeatures: async () => {
        loadCalls += 1
        return [featureFor('fresh')]
      },
      setFeatures: next => {
        features = next
        changed += 1
      },
      onError: () => undefined,
      performanceDiagnostics: createMapPerformanceDiagnostics(() => 0),
    })

    await controller.refresh()

    expect(loadCalls).toBe(0)
    expect(features).toEqual([])
    expect(changed).toBe(1)
    expect(reports.at(-1)?.message).toBe('No pack area features active')
    controller.destroy()
  })

  test('disabled sync is idempotent when no overlay features are active', () => {
    const reports: MapRuntimeDiagnosticPhaseReport[] = []
    let features: ReadonlyArray<PackMapFeature> = []
    let changed = 0
    const controller = createPackOverlayController({
      getRuntime: () => createRuntime(reports),
      getViewport: () => viewport,
      getCurrentTime: () => undefined,
      getSourceRevisionKey: () => 'r1',
      active: () => true,
      enabled: () => false,
      loadFeatures: async () => [featureFor('unused')],
      setFeatures: next => {
        features = next
        changed += 1
      },
      onError: () => undefined,
      performanceDiagnostics: createMapPerformanceDiagnostics(() => 0),
    })

    controller.syncEnabled()
    controller.syncEnabled()

    expect(features).toEqual([])
    expect(changed).toBe(1)
    expect(reports.filter(report => report.message === 'No pack area features active')).toHaveLength(1)
    controller.destroy()
  })

  test('disabled sync waits for a runtime before reporting ready diagnostics', () => {
    const reports: MapRuntimeDiagnosticPhaseReport[] = []
    let runtime: MapRuntimeHandle | null = null
    let changed = 0
    const controller = createPackOverlayController({
      getRuntime: () => runtime,
      getViewport: () => viewport,
      getCurrentTime: () => undefined,
      getSourceRevisionKey: () => 'r1',
      active: () => true,
      enabled: () => false,
      loadFeatures: async () => [featureFor('unused')],
      setFeatures: () => { changed += 1 },
      onError: () => undefined,
      performanceDiagnostics: createMapPerformanceDiagnostics(() => 0),
    })

    controller.syncEnabled()
    runtime = createRuntime(reports)
    controller.syncEnabled()
    controller.syncEnabled()

    expect(changed).toBe(1)
    expect(reports.filter(report => report.message === 'No pack area features active')).toHaveLength(1)
    controller.destroy()
  })

  test('caches enabled overlay results by viewport, zoom, time bucket, and source revision', async () => {
    const reports: MapRuntimeDiagnosticPhaseReport[] = []
    let loadCalls = 0
    let changed = 0
    let revision = 'r1'
    let features: ReadonlyArray<PackMapFeature> = []
    const controller = createPackOverlayController({
      getRuntime: () => createRuntime(reports),
      getViewport: () => viewport,
      getCurrentTime: () => undefined,
      getSourceRevisionKey: () => revision,
      active: () => true,
      enabled: () => true,
      loadFeatures: async () => {
        loadCalls += 1
        return [featureFor(`fresh-${loadCalls}`)]
      },
      setFeatures: next => {
        features = next
        changed += 1
      },
      onError: () => undefined,
      performanceDiagnostics: createMapPerformanceDiagnostics(() => 0),
    })

    await controller.refresh()
    await controller.refresh()
    revision = 'r2'
    await controller.refresh()

    expect(loadCalls).toBe(2)
    expect(features.map(feature => feature.id)).toEqual(['fresh-2'])
    expect(reports.filter(report => report.message === 'Pack area features ready')).toHaveLength(2)
    controller.destroy()
  })
})

const settleRequests = async (): Promise<void> => { for (let round = 0; round < 8; round++) await Promise.resolve() }

/** Test-only timer inventory proves suspension stops wakeups, without waiting on real time. */
const controlledIntervals = () => {
  const pending = new Map<number, () => void>(); let id = 0
  const set = spyOn(globalThis, 'setInterval').mockImplementation(((handler: () => void) => { const next = ++id; pending.set(next, handler); return next }) as unknown as typeof setInterval)
  const clear = spyOn(globalThis, 'clearInterval').mockImplementation(((handle: number) => { pending.delete(Number(handle)) }) as unknown as typeof clearInterval)
  return { pending, restore() { set.mockRestore(); clear.mockRestore() } }
}

test('a covered viewport stops its timer and all explicit/queued demand, keeps valid features, and refreshes current data on return', async () => {
  const timers = controlledIntervals(), reports: MapRuntimeDiagnosticPhaseReport[] = []
  let active = true, revision = 'r1', calls = 0, features: ReadonlyArray<PackMapFeature> = []
  const controller = createPackOverlayController({
    getRuntime: () => createRuntime(reports), getViewport: () => viewport, getCurrentTime: () => undefined, getSourceRevisionKey: () => revision,
    active: () => active, enabled: () => true, loadFeatures: async () => { calls++; return [featureFor(revision)] }, setFeatures: value => { features = value }, onError: () => {}, performanceDiagnostics: createMapPerformanceDiagnostics(() => 0),
  })
  try {
    controller.syncEnabled(); await settleRequests(); expect(calls).toBe(1); expect(timers.pending.size).toBe(1)
    const alreadyQueuedWakeup = [...timers.pending.values()][0]!, retained = features
    active = false; controller.syncEnabled(); expect(timers.pending.size).toBe(0); expect(features).toBe(retained)
    revision = 'r2'; alreadyQueuedWakeup(); await controller.refresh(); await settleRequests(); expect(calls).toBe(1); expect(features).toBe(retained)
    active = true; controller.syncEnabled(); await settleRequests(); expect(calls).toBe(2); expect(timers.pending.size).toBe(1); expect(features[0]!.id).toBe('r2')
    await controller.refresh(); expect(calls).toBe(2)
  } finally { controller.destroy(); expect(timers.pending.size).toBe(0); timers.restore() }
})

test('suspension aborts pending work and resumes before a late provider settles, without letting its finally erase the new request', async () => {
  const timers = controlledIntervals(), reports: MapRuntimeDiagnosticPhaseReport[] = [], errors: string[] = []
  const requests: { signal: AbortSignal; resolve: (features: ReadonlyArray<PackMapFeature>) => void }[] = []
  let active = true, revision = 'r1', features: ReadonlyArray<PackMapFeature> = []
  const controller = createPackOverlayController({
    getRuntime: () => createRuntime(reports), getViewport: () => viewport, getCurrentTime: () => undefined, getSourceRevisionKey: () => revision,
    active: () => active, enabled: () => true, loadFeatures: context => new Promise(resolve => { requests.push({ signal: context.signal!, resolve }) }), setFeatures: value => { features = value }, onError: value => { errors.push(value) }, performanceDiagnostics: createMapPerformanceDiagnostics(() => 0),
  })
  try {
    controller.syncEnabled(); expect(requests).toHaveLength(1)
    active = false; controller.syncEnabled(); expect(requests[0]!.signal.aborted).toBe(true); expect(timers.pending.size).toBe(0)
    revision = 'r2'; active = true; controller.syncEnabled(); expect(requests).toHaveLength(2)
    requests[0]!.resolve([featureFor('obsolete')]); await settleRequests(); expect(features).toEqual([])
    await controller.refresh(); expect(requests).toHaveLength(2); expect(requests[1]!.signal.aborted).toBe(false)
    requests[1]!.resolve([featureFor('current')]); await settleRequests(); expect(features[0]!.id).toBe('current'); expect(errors).toEqual([])
    await controller.refresh(); expect(requests).toHaveLength(2)
  } finally { controller.destroy(); timers.restore() }
})

test('a cancelled hidden request cannot publish a late transport warning or replace the last valid data', async () => {
  const timers = controlledIntervals(), reports: MapRuntimeDiagnosticPhaseReport[] = [], errors: string[] = []
  let active = true, reject!: (error: Error) => void, features: ReadonlyArray<PackMapFeature> = [featureFor('last-valid')]
  const controller = createPackOverlayController({
    getRuntime: () => createRuntime(reports), getViewport: () => viewport, getCurrentTime: () => undefined, getSourceRevisionKey: () => 'r1',
    active: () => active, enabled: () => true, loadFeatures: () => new Promise((_, fail) => { reject = fail }), setFeatures: value => { features = value }, onError: value => { errors.push(value) }, performanceDiagnostics: createMapPerformanceDiagnostics(() => 0),
  })
  try {
    controller.syncEnabled(); active = false; controller.syncEnabled(); reject(Error('late transport failure')); await settleRequests()
    expect(errors).toEqual([]); expect(features[0]!.id).toBe('last-valid'); expect(reports.some(value => value.status === 'failed')).toBe(false)
  } finally { controller.destroy(); timers.restore() }
})
