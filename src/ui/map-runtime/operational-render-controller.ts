import type { GeoJsonPoint, OperationalObject } from '../../core/model/index.ts'
import type { PackMapAreaFeature, PackObjectPresentation } from '../../core/packs/protocol.ts'
import {
  createDisplayMotionState,
  displayObjectsFor,
  hasActiveDisplayMotion,
  reconcileDisplayMotionState,
  type DisplayMotionState,
} from '../display-motion.ts'
import { createMapFeatureStore } from './map-feature-store.ts'
import type { MapPerformanceDiagnostics } from './map-performance-diagnostics.ts'
import { createMapUpdateScheduler } from './map-update-scheduler.ts'
import { createOperationalDeckLayerFactory, visibleFamiliesKey } from './operational-deck-layers.ts'
import type {
  MapRuntimeHandle,
  OperationalRenderSnapshot,
  RenderFamily,
} from './types.ts'

export interface OperationalRenderControllerState {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly selectedControllerId: string | null
  readonly highlightedObjectIds: ReadonlyArray<string>
  readonly hiddenObjectCategoryIds: ReadonlyArray<string>
  readonly placementPoints: ReadonlyArray<GeoJsonPoint>
  readonly packAreaFeatures: ReadonlyArray<PackMapAreaFeature>
  readonly visibleFamilies: ReadonlySet<string>
  readonly placementCursorActive: boolean
}

export interface OperationalRenderControllerConfig {
  readonly getRuntime: () => MapRuntimeHandle | null
  readonly getState: () => OperationalRenderControllerState
  readonly hasNewInfo: (object: OperationalObject) => boolean
  readonly presentationFor: (object: OperationalObject) => PackObjectPresentation
  readonly onObjectSelected: (object: OperationalObject) => void
  readonly onObjectSeen: (object: OperationalObject) => void
  readonly onObjectHover: (object: OperationalObject | null) => void
  readonly setCursor: (cursor: 'crosshair' | 'pointer' | '') => void
  readonly refreshPopup: (objects: ReadonlyArray<OperationalObject>) => void
  readonly onDiagnostic: (runtime: MapRuntimeHandle) => void
  readonly performanceDiagnostics: MapPerformanceDiagnostics
}

export interface OperationalRenderController {
  readonly syncObjects: () => void
  readonly syncPlacement: () => void
  readonly syncAreaFeatures: () => void
  readonly syncVisibility: () => void
  readonly syncObjectVisibility: () => void
  readonly flushNow: () => void
  readonly destroy: () => void
}

const fullRenderFamilies: ReadonlyArray<RenderFamily> = [
  'operational-points',
  'operational-paths',
  'operational-areas',
  'placement',
]

const renderFamiliesForObjects: ReadonlyArray<RenderFamily> = [
  'operational-points',
  'operational-paths',
  'operational-areas',
]

const renderFamiliesForAreaFeatures: ReadonlyArray<RenderFamily> = [
  'operational-paths',
  'operational-areas',
]

const createRenderPresentationFor = (
  presentationFor: (object: OperationalObject) => PackObjectPresentation,
): ((object: OperationalObject) => PackObjectPresentation) => {
  const cache = new Map<string, PackObjectPresentation>()
  return (object) => {
    const key = `${object.id}:${object.revision}`
    const cached = cache.get(key)
    if (cached) return cached
    const presentation = presentationFor(object)
    cache.set(key, presentation)
    return presentation
  }
}

const createRenderHasNewInfo = (
  hasNewInfo: (object: OperationalObject) => boolean,
): ((object: OperationalObject) => boolean) => {
  const cache = new Map<string, boolean>()
  return (object) => {
    const key = `${object.id}:${object.revision}`
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    const next = hasNewInfo(object)
    cache.set(key, next)
    return next
  }
}

const renderSignatureFor = (
  snapshot: OperationalRenderSnapshot,
  visibleFamilies: ReadonlySet<string>,
): string => [
  snapshot.revisions.points,
  snapshot.revisions.paths,
  snapshot.revisions.areas,
  snapshot.revisions.areaSymbols,
  snapshot.revisions.placement,
  visibleFamiliesKey(visibleFamilies),
].join('|')

export const createOperationalRenderController = (
  config: OperationalRenderControllerConfig,
): OperationalRenderController => {
  const featureStore = createMapFeatureStore()
  const updateScheduler = createMapUpdateScheduler({ frameBudgetMs: 6 })
  const deckLayerFactory = createOperationalDeckLayerFactory()
  const pendingFamilies = new Set<RenderFamily>()
  let displayMotionState: DisplayMotionState = createDisplayMotionState()
  let previousMotionObjects: ReadonlyArray<OperationalObject> = []
  let displayFrame: number | null = null
  let lastRenderSignature: string | null = null
  let lastDiagnosticAtMs = 0
  let lastRenderDetailsAtMs = -Infinity
  let uiOverlayReported = false

  const stopDisplayAnimation = (): void => {
    if (displayFrame === null) return
    cancelAnimationFrame(displayFrame)
    displayFrame = null
  }

  const emitDiagnostic = (runtime: MapRuntimeHandle): void => {
    const nowMs = performance.now()
    if (nowMs - lastDiagnosticAtMs < 750) return
    lastDiagnosticAtMs = nowMs
    config.onDiagnostic(runtime)
  }

  const currentDisplayObjects = (
    objects: ReadonlyArray<OperationalObject>,
    nowMs: number,
  ): ReadonlyArray<OperationalObject> =>
    config.performanceDiagnostics.measure(
      'operational-dynamic',
      'displayObjectsFor',
      () => displayObjectsFor(objects, displayMotionState, nowMs),
      { objects: objects.length },
    )

  const renderPending = (): void => {
    const runtime = config.getRuntime()
    if (!runtime || pendingFamilies.size === 0) return
    const families = new Set(pendingFamilies)
    pendingFamilies.clear()
    const state = config.getState()
    const startedAtMs = performance.now()
    const updatesFeatureFamilies = families.has('operational-points')
      || families.has('operational-paths')
      || families.has('operational-areas')
      || families.has('placement')
    const displayObjects = updatesFeatureFamilies
      ? currentDisplayObjects(state.objects, startedAtMs)
      : state.objects
    const snapshot = updatesFeatureFamilies
      ? config.performanceDiagnostics.measure(
        'operational-dynamic',
        'featureStore.updateFamilies',
        () => featureStore.updateFamilies({
          objects: displayObjects,
          selectedControllerId: state.selectedControllerId,
          highlightedObjectIds: state.highlightedObjectIds,
          hiddenObjectCategoryIds: state.hiddenObjectCategoryIds,
          placementPoints: state.placementPoints,
          packAreaFeatures: state.packAreaFeatures,
          hasNewInfo: createRenderHasNewInfo(config.hasNewInfo),
          presentationFor: createRenderPresentationFor(config.presentationFor),
        }, families),
        {
          objects: displayObjects.length,
          packAreaFeatures: state.packAreaFeatures.length,
          families: [...families].sort().join(','),
        },
      )
      : featureStore.snapshot()
    const renderSignature = renderSignatureFor(snapshot, state.visibleFamilies)
    const deckUpdated = renderSignature !== lastRenderSignature
    if (deckUpdated) {
      lastRenderSignature = renderSignature
      const deckLayers = config.performanceDiagnostics.measure(
        'operational-dynamic',
        'deckLayerFactory.createLayers',
        () => deckLayerFactory.createLayers({
          snapshot,
          visibleFamilies: state.visibleFamilies,
          onObjectSelected: point => {
            config.onObjectSelected(point.object)
          },
          onObjectSeen: point => {
            config.onObjectSeen(point.object)
          },
          onObjectHover: point => {
            if (!point) {
              config.setCursor(state.placementCursorActive ? 'crosshair' : '')
              config.onObjectHover(null)
              return
            }
            config.setCursor(state.placementCursorActive ? 'crosshair' : 'pointer')
            config.onObjectSeen(point.object)
            config.onObjectHover(point.object)
          },
        }),
        {
          points: snapshot.points.length,
          paths: snapshot.paths.length,
          areas: snapshot.areas.length,
          areaSymbols: snapshot.areaSymbols.length,
          placementPoints: snapshot.placementPoints.length,
        },
      )
      config.performanceDiagnostics.measure(
        'operational-dynamic',
        'runtime.updateLayers',
        () => runtime.updateLayers({ deckLayers }),
        { deckLayers: deckLayers.length },
      )
      const nowMs = performance.now()
      if (nowMs - lastRenderDetailsAtMs >= 750) {
        lastRenderDetailsAtMs = nowMs
        runtime.setDiagnosticDetails('operational-dynamic', [
          { label: 'Objects', value: String(state.objects.length) },
          { label: 'Points', value: String(snapshot.points.length) },
          { label: 'Paths', value: String(snapshot.paths.length) },
          { label: 'Areas', value: String(snapshot.areas.length) },
          { label: 'Deck layers', value: String(deckLayers.length) },
        ])
      }
    }
    if (updatesFeatureFamilies) {
      config.performanceDiagnostics.measure(
        'ui-overlay',
        'popupController.refresh',
        () => config.refreshPopup(displayObjects),
        { objects: displayObjects.length },
      )
      if (!uiOverlayReported) {
        uiOverlayReported = true
        runtime.reportDiagnosticPhase({
          phase: 'ui-overlay',
          status: 'ready',
          message: 'Operational UI overlays synchronized',
          details: [
            { label: 'Objects', value: String(displayObjects.length) },
          ],
        })
      }
    }
    const totalMs = performance.now() - startedAtMs
    config.performanceDiagnostics.record('operational-dynamic', 'renderPending total', totalMs, {
      points: snapshot.points.length,
      paths: snapshot.paths.length,
      areas: snapshot.areas.length,
      deckUpdated,
    })
    emitDiagnostic(runtime)
  }

  const schedule = (
    family: RenderFamily,
    priority: number,
    minIntervalMs = 0,
  ): void => {
    pendingFamilies.add(family)
    updateScheduler.schedule({
      family,
      priority,
      minIntervalMs,
      run: renderPending,
    })
  }

  const scheduleMany = (
    families: ReadonlyArray<RenderFamily>,
    priority: number,
    minIntervalMs = 0,
  ): void => {
    for (const family of families) schedule(family, priority, minIntervalMs)
  }

  const scheduleDisplayAnimation = (): void => {
    if (displayFrame !== null) return
    displayFrame = requestAnimationFrame(() => {
      displayFrame = null
      const nowMs = performance.now()
      schedule('operational-points', 85)
      if (hasActiveDisplayMotion(displayMotionState, nowMs)) {
        scheduleDisplayAnimation()
      }
    })
  }

  return {
    syncObjects: () => {
      const nowMs = performance.now()
      const state = config.getState()
      displayMotionState = reconcileDisplayMotionState({
        previousState: displayMotionState,
        previousObjects: previousMotionObjects,
        nextObjects: state.objects,
        nowMs,
      })
      previousMotionObjects = state.objects
      scheduleMany(renderFamiliesForObjects, 75)
      if (hasActiveDisplayMotion(displayMotionState, nowMs)) scheduleDisplayAnimation()
    },
    syncPlacement: () => {
      schedule('placement', 70)
    },
    syncAreaFeatures: () => {
      scheduleMany(renderFamiliesForAreaFeatures, 55)
    },
    syncVisibility: () => {
      schedule('diagnostics', 65)
    },
    syncObjectVisibility: () => {
      scheduleMany(renderFamiliesForObjects, 70)
    },
    flushNow: () => {
      for (const family of fullRenderFamilies) pendingFamilies.add(family)
      updateScheduler.schedule({
        family: 'operational-points',
        priority: 100,
        run: renderPending,
      })
      updateScheduler.flushNow()
    },
    destroy: () => {
      updateScheduler.stop()
      stopDisplayAnimation()
      deckLayerFactory.reset()
      pendingFamilies.clear()
      lastRenderSignature = null
      lastRenderDetailsAtMs = -Infinity
      uiOverlayReported = false
      previousMotionObjects = []
      displayMotionState = createDisplayMotionState()
    },
  }
}
