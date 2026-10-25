import { MercatorCoordinate } from 'maplibre-gl'
import { packPhysicalSceneSchema, type PackPhysicalScene } from '../../../core/packs/scene.ts'
import { buildVisibleMeshes, type PhysicalMesh } from './geometry.ts'
import { createPhysicalSceneLayer, type PhysicalLayerEntry } from './layer.ts'
import { boundsCorners, localMercatorMatrix, transform } from './math.ts'
import { physicalSceneLayerId } from './order.ts'
import { defaultPhysicalSceneView, type PhysicalSceneControllerOptions, type PhysicalSceneDescriptor, type PhysicalScenePalette, type PhysicalScenePresentation, type PhysicalSceneSource, type PhysicalSceneView, type PhysicalSubjectStyle } from './types.ts'

const layerId = physicalSceneLayerId
const maximumResidentScenes = 4
interface Entry {
  source: PhysicalSceneSource
  generation: number
  scene: PackPhysicalScene | null
  meshes: PhysicalMesh[]
  view: PhysicalSceneView
  status: ReadonlyMap<string, PhysicalSubjectStyle>
  statusSignature: string
  state: PhysicalScenePresentation['status']
  reason: string | undefined
  loading: boolean
  loadError: string | undefined
  eligible: boolean
  lastUsed: number
}

const geographicCorners = (descriptor: PhysicalSceneDescriptor) => {
  const matrix = localMercatorMatrix(descriptor.anchor, descriptor.bearing)
  return boundsCorners(descriptor.bounds).map(point => {
    const p = transform(matrix, point)
    return new MercatorCoordinate(p[0], p[1], p[2]).toLngLat()
  })
}

/** The same footprint criterion supports loader decisions and the user-visible detail state. */
export const physicalSceneExtent = (descriptor: PhysicalSceneDescriptor, project: (point: { lng: number; lat: number }) => { x: number; y: number }, width: number, height: number) => {
  const points = geographicCorners(descriptor).map(project)
  const left = Math.min(...points.map(point => point.x)), right = Math.max(...points.map(point => point.x))
  const top = Math.min(...points.map(point => point.y)), bottom = Math.max(...points.map(point => point.y))
  return { pixels: Math.max(right - left, bottom - top), intersects: right >= -64 && left <= width + 64 && bottom >= -64 && top <= height + 64, distance: Math.hypot((left + right - width) / 2, (top + bottom - height) / 2) }
}

export const detailEligible = (pixels: number, intersects: boolean, wasEligible: boolean): boolean => intersects && pixels >= (wasEligible ? 180 : 240)

export const createPhysicalSceneController = (options: PhysicalSceneControllerOptions) => {
  const { map } = options
  const entries = new Map<string, Entry>()
  let palette = options.palette
  let currentLayer: ReturnType<typeof createPhysicalSceneLayer> | null = null
  let destroyed = false
  let generation = 0
  let lastPresentation = ''
  let contextLost = false
  let reconcileQueued = false
  let layerFailure: string | null = null
  const disposals: Array<NonNullable<ReturnType<ReturnType<typeof createPhysicalSceneLayer>['metrics']>>> = []
  const presentation = (): PhysicalScenePresentation[] => [...entries.values()].map(entry => ({ descriptor: entry.source.descriptor, view: entry.view, status: entry.state, ...(entry.reason ? { reason: entry.reason } : {}), occurrenceCount: entry.scene?.objects.length ?? 0 }))
  const emit = (): void => {
    const value = presentation(), signature = JSON.stringify(value)
    if (signature === lastPresentation) return
    lastPresentation = signature; options.onChange(value)
  }
  const drawable = (): PhysicalLayerEntry[] => [...entries.values()].flatMap(entry => entry.scene && entry.eligible && entry.state === 'ready' ? [{ scene: entry.scene, meshes: entry.meshes, view: entry.view, status: entry.status }] : [])
  const removeLayer = (): void => {
    // Full MapLibre style replacement can remove registration without invoking onRemove.
    if (currentLayer) {
      currentLayer.dispose()
      const receipt = currentLayer.metrics()
      if (receipt) { disposals.push(receipt); if (disposals.length > 40) disposals.shift() }
      currentLayer = null
    }
    if (!contextLost && map.getLayer(layerId)) map.removeLayer(layerId)
  }
  const reconcileLayer = (): void => {
    if (destroyed || contextLost) return
    if (!drawable().length) { removeLayer(); return }
    if (!map.isStyleLoaded()) return
    if (currentLayer && map.getLayer(layerId)) {
      const before = options.beforeId()
      if (before && map.getLayer(before)) {
        const layers = map.getLayersOrder()
        if (layers.indexOf(layerId) > layers.indexOf(before)) map.moveLayer(layerId, before)
      }
      return
    }
    if (currentLayer) removeLayer()
    currentLayer = createPhysicalSceneLayer(layerId, drawable, palette, error => {
      layerFailure = error.message
      for (const entry of entries.values()) if (entry.eligible) { entry.state = 'unavailable'; entry.reason = error.message }
      emit(); options.reportError(error)
    })
    try {
      const before = options.beforeId()
      map.addLayer(currentLayer.layer, before && map.getLayer(before) ? before : undefined)
      map.triggerRepaint()
    } catch (error) {
      currentLayer.dispose(); currentLayer = null
      const failure = error instanceof Error ? error : new Error(String(error))
      layerFailure = failure.message
      for (const entry of entries.values()) if (entry.eligible) { entry.state = 'unavailable'; entry.reason = failure.message }
      emit(); options.reportError(failure)
    }
  }
  const unloadDistant = (): void => {
    const loaded = [...entries.values()].filter(entry => entry.scene).sort((a, b) => b.lastUsed - a.lastUsed)
    for (const entry of loaded.slice(maximumResidentScenes)) if (!entry.eligible) { entry.scene = null; entry.meshes = [] }
  }
  const load = async (entry: Entry): Promise<void> => {
    if (entry.loading || entry.scene || entry.loadError) return
    const expected = entry.generation
    entry.loading = true; entry.state = 'loading'; entry.reason = undefined; emit()
    try {
      const scene = packPhysicalSceneSchema.parse(await entry.source.load())
      if (destroyed || expected !== entry.generation || entries.get(scene.id) !== entry) return
      const descriptor = entry.source.descriptor
      if (scene.id !== descriptor.id || scene.revision !== descriptor.revision || scene.targetObjectId !== descriptor.targetObjectId || JSON.stringify(scene.anchor) !== JSON.stringify(descriptor.anchor) || scene.bearing !== descriptor.bearing || JSON.stringify(scene.bounds) !== JSON.stringify(descriptor.bounds) || JSON.stringify(scene.levels) !== JSON.stringify(descriptor.levels)) throw new Error('Physical scene delivery does not match its retained descriptor')
      entry.loading = false; entry.scene = scene; entry.lastUsed = performance.now(); entry.meshes = buildVisibleMeshes(scene, entry.view)
      entry.state = entry.eligible ? 'ready' : entry.view.detail === 'hidden' ? 'hidden' : 'distant'
      unloadDistant(); reconcileLayer(); map.triggerRepaint(); emit()
    } catch (error) {
      if (destroyed || expected !== entry.generation) return
      const failure = error instanceof Error ? error : new Error(String(error))
      entry.loading = false; entry.loadError = failure.message; entry.state = 'unavailable'; entry.reason = failure.message; entry.meshes = []; entry.scene = null
      options.reportError(failure); emit()
    }
  }
  const reconcile = (): void => {
    if (destroyed || contextLost) return
    const rectangle = map.getCanvas().getBoundingClientRect()
    const extents = [...entries.values()].map(entry => ({ entry, extent: physicalSceneExtent(entry.source.descriptor, point => map.project(point), rectangle.width, rectangle.height) })).sort((a, b) => a.extent.distance - b.extent.distance)
    let accepted = 0
    for (const { entry, extent } of extents) {
      const valid = entry.source.descriptor.locationValid && entry.view.detail !== 'hidden'
      entry.eligible = valid && detailEligible(extent.pixels, extent.intersects, entry.eligible) && accepted < maximumResidentScenes
      if (entry.eligible) accepted++
      if (!entry.source.descriptor.locationValid) { entry.state = 'unavailable'; entry.reason = entry.source.descriptor.reason ?? 'Layout location no longer matches its owner' }
      else if (entry.loadError) { entry.state = 'unavailable'; entry.reason = entry.loadError }
      else if (layerFailure && entry.eligible) { entry.state = 'unavailable'; entry.reason = layerFailure }
      else if (entry.view.detail === 'hidden') entry.state = 'hidden'
      else if (!entry.eligible) entry.state = 'distant'
      else if (entry.scene) { entry.state = 'ready'; entry.lastUsed = performance.now() }
      else if (entry.loading) entry.state = 'loading'
      else void load(entry)
    }
    unloadDistant(); reconcileLayer(); emit()
  }
  const queueReconcile = (): void => {
    if (destroyed || reconcileQueued) return
    reconcileQueued = true
    queueMicrotask(() => { reconcileQueued = false; reconcile() })
  }
  const onStyle = (): void => { if (currentLayer && !map.getLayer(layerId)) removeLayer(); queueReconcile() }
  const onLost = (): void => { contextLost = true; removeLayer() }
  const onRestored = (): void => { contextLost = false; layerFailure = null; if (map.getLayer(layerId)) map.removeLayer(layerId); queueReconcile() }
  map.on('move', queueReconcile); map.on('resize', queueReconcile); map.on('style.load', onStyle); map.on('styledata', onStyle); map.on('idle', queueReconcile)
  map.getCanvas().addEventListener('webglcontextlost', onLost); map.getCanvas().addEventListener('webglcontextrestored', onRestored)
  const duration = (): number => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 250
  const requireEntry = (id: string): Entry => { const entry = entries.get(id); if (!entry) throw new Error(`Unknown physical scene: ${id}`); return entry }
  return {
    setSources(sources: ReadonlyArray<PhysicalSceneSource>): void {
      if (destroyed) return
      if (new Set(sources.map(source => source.descriptor.id)).size !== sources.length) throw new Error('Physical scene IDs must be unique in a Run')
      const next = new Set(sources.map(source => source.descriptor.id))
      let changed = false
      for (const [id, entry] of entries) if (!next.has(id)) { entry.generation = ++generation; entries.delete(id); changed = true }
      for (const source of sources) {
        const previous = entries.get(source.descriptor.id)
        if (previous && JSON.stringify(previous.source.descriptor) === JSON.stringify(source.descriptor)) { previous.source = source; continue }
        if (previous) previous.generation = ++generation
        changed = true
        entries.set(source.descriptor.id, { source, generation: ++generation, scene: null, meshes: [], view: previous?.view ?? defaultPhysicalSceneView(source.descriptor.levels), status: new Map(), statusSignature: '[]', state: 'distant', eligible: false, lastUsed: 0, reason: undefined, loading: false, loadError: undefined })
      }
      if (changed) { layerFailure = null; currentLayer?.invalidatePicks() }
      reconcile(); map.triggerRepaint()
    },
    setView(sceneId: string, view: PhysicalSceneView): void {
      const entry = requireEntry(sceneId)
      if (!Number.isFinite(view.separation) || view.separation < 0 || view.separation > 100) throw new Error('Level separation must be between 0 and 100 metres')
      if (view.levelId !== 'all' && !entry.source.descriptor.levels.some(level => level.id === view.levelId)) throw new Error(`Unknown physical level: ${view.levelId}`)
      const old = entry.view
      entry.view = { ...view }
      const geometryChanged = old.levelId !== view.levelId || old.cutaway !== view.cutaway || old.separation !== view.separation || old.mode !== view.mode
      if (geometryChanged || old.detail !== view.detail) currentLayer?.invalidatePicks()
      if (geometryChanged && entry.scene) entry.meshes = buildVisibleMeshes(entry.scene, view)
      if (old.mode !== view.mode) map.easeTo({ pitch: view.mode === '2d' ? 0 : 50, duration: duration() })
      reconcile(); map.triggerRepaint()
    },
    setStatus(sceneId: string, status: ReadonlyMap<string, PhysicalSubjectStyle>): void {
      const entry = entries.get(sceneId)
      if (!entry) return
      for (const style of status.values()) if (!Number.isFinite(style.emphasis) || style.emphasis < 0 || style.emphasis > 1 || style.color?.some(value => !Number.isFinite(value) || value < 0 || value > 1)) throw new Error('Invalid physical status presentation')
      const signature = JSON.stringify([...status].sort(([a], [b]) => a.localeCompare(b)))
      if (signature === entry.statusSignature) return
      entry.statusSignature = signature
      entry.status = status
      if (entry.eligible && entry.view.live) map.triggerRepaint()
    },
    setPalette(next: PhysicalScenePalette): void { palette = next; layerFailure = null; removeLayer(); reconcile() },
    fit(sceneId: string): void {
      const entry = requireEntry(sceneId), points = geographicCorners(entry.source.descriptor)
      const west = Math.min(...points.map(point => point.lng)), east = Math.max(...points.map(point => point.lng)), south = Math.min(...points.map(point => point.lat)), north = Math.max(...points.map(point => point.lat))
      const canvas = map.getCanvas().getBoundingClientRect(), inherited = map.getPadding()
      const desired = options.fitPadding?.() ?? { top: (inherited.top ?? 0) + 24, right: (inherited.right ?? 0) + 24, bottom: (inherited.bottom ?? 0) + 24, left: (inherited.left ?? 0) + 24 }
      const xScale = Math.min(1, canvas.width * 0.55 / Math.max(1, desired.left + desired.right)), yScale = Math.min(1, canvas.height * 0.55 / Math.max(1, desired.top + desired.bottom))
      const padding = { top: Math.max(0, desired.top * yScale), right: Math.max(0, desired.right * xScale), bottom: Math.max(0, desired.bottom * yScale), left: Math.max(0, desired.left * xScale) }
      map.fitBounds([[west, south], [east, north]], { padding, bearing: entry.source.descriptor.bearing, pitch: entry.view.mode === '2d' ? 0 : 50, maxZoom: 21, duration: duration() })
    },
    reset(sceneId: string): void { const entry = requireEntry(sceneId); this.setView(sceneId, defaultPhysicalSceneView(entry.source.descriptor.levels)); this.fit(sceneId) },
    pick(point: { x: number; y: number }) { return currentLayer?.pick(point) ?? null },
    project(sceneId: string, occurrenceId: string) { return currentLayer?.project(sceneId, occurrenceId) ?? null },
    presentations: presentation,
    /** Immutable source read for accessible occurrence lists; null until admitted detail has loaded. */
    scene(sceneId: string): PackPhysicalScene | null { return entries.get(sceneId)?.scene ?? null },
    retry(sceneId: string): void { const entry = requireEntry(sceneId); entry.loadError = undefined; entry.reason = undefined; layerFailure = null; removeLayer(); reconcile() },
    metrics() { return currentLayer?.metrics() ?? null },
    diagnostics() { return { current: currentLayer?.metrics() ?? null, disposals: [...disposals], retainedScenes: [...entries.values()].filter(entry => entry.scene).length, loadingScenes: [...entries.values()].filter(entry => entry.loading).length } },
    destroy(): void {
      if (destroyed) return
      destroyed = true; generation++
      map.off('move', queueReconcile); map.off('resize', queueReconcile); map.off('style.load', onStyle); map.off('styledata', onStyle); map.off('idle', queueReconcile)
      map.getCanvas().removeEventListener('webglcontextlost', onLost); map.getCanvas().removeEventListener('webglcontextrestored', onRestored)
      for (const entry of entries.values()) entry.generation = generation
      entries.clear(); removeLayer()
    },
  }
}

export type PhysicalSceneController = ReturnType<typeof createPhysicalSceneController>
