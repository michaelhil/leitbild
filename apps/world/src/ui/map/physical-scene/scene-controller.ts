import { MercatorCoordinate } from 'maplibre-gl'
import type { PackPhysicalScene, PhysicalSceneBounds } from '../../../core/packs/scene.ts'
import type { PhysicalLayerEntry } from './layer.ts'
import type { PhysicalMesh } from './geometry.ts'
import { boundsCorners, localMercatorMatrix, transform } from './math.ts'
import { createPhysicalGeometryPreparer, type PhysicalPreparedGeometry } from './preparation.ts'
import { admitPhysicalPickAcceleration, derivePhysicalPickAcceleration } from './picking.ts'
import { createPhysicalOverviewScene, physicalOverviewContextMeshes } from './overview-geometry.ts'
import { projectedInspectionFeature, automaticInspectionDemand } from './inspection-demand.ts'
import { visiblePhysicalBounds } from './renderer.ts'
import { visiblePhysicalSurfaceOwners } from './surface-ownership.ts'
import type { PhysicalViewport, PhysicalViewportRenderer } from './viewport.ts'
import { defaultPhysicalSceneView, type PhysicalSceneControllerOptions, type PhysicalSceneFocus, type PhysicalScenePalette, type PhysicalScenePresentation, type PhysicalSceneSource, type PhysicalSceneView, type PhysicalSubjectStyle } from './types.ts'

interface Entry { renderRevision: number; source: PhysicalSceneSource; generation: number; viewGeneration: number; scene: PackPhysicalScene | null; prepared: PhysicalPreparedGeometry | null; meshes: ReadonlyArray<PhysicalMesh>; view: PhysicalSceneView; status: ReadonlyMap<string, PhysicalSubjectStyle>; signature: string; state: PhysicalScenePresentation['status']; reason?: string | undefined; loading: boolean; preparing?: boolean; eligible: boolean; failure?: string | undefined; scopeId?: string | undefined; overview?: { scene: PackPhysicalScene; asset: PhysicalPreparedGeometry } | undefined; overviewPreparing?: boolean; overviewFilter?: { key: string; meshes: ReadonlyArray<PhysicalMesh> } | undefined }
type Options = Omit<PhysicalSceneControllerOptions, 'map' | 'beforeId'>
const worldBounds = (anchor: readonly [number, number], bearing: number, bounds: PhysicalSceneBounds): PhysicalSceneBounds => {
  const matrix = localMercatorMatrix(anchor, bearing), points = boundsCorners(bounds).map(p => transform(matrix, p))
  return { min: [0, 1, 2].map(a => Math.min(...points.map(p => p[a]!))) as [number, number, number], max: [0, 1, 2].map(a => Math.max(...points.map(p => p[a]!))) as [number, number, number] }
}
const combinedBounds = (values: ReadonlyArray<PhysicalSceneBounds>): PhysicalSceneBounds => ({ min: [0, 1, 2].map(a => Math.min(...values.map(b => b.min[a]!))) as [number, number, number], max: [0, 1, 2].map(a => Math.max(...values.map(b => b.max[a]!))) as [number, number, number] })

let controllerSequence = 0
/** Common retained scene orchestration; viewport adapters own real cameras and contexts. */
export const createPhysicalSceneControllerForViewport = (viewport: PhysicalViewport, options: Options) => {
  const entries = new Map<string, Entry>(), prepare = options.prepare ?? createPhysicalGeometryPreparer(), privateNamespace = ++controllerSequence
  const identityFor = (entry: Entry, sourceGeneration = entry.generation) => entry.source.descriptor.geometryKey ?? `private/${privateNamespace}/${entry.source.descriptor.id}/${sourceGeneration}`
  let palette = options.palette, renderer: PhysicalViewportRenderer | null = null, active = true, destroyed = false, generation = 0, mode: PhysicalSceneView['mode'] = '2d', lastPresentation = '', queued = false, contextLost = false
  let focusedId: string | null = null, forcedId: string | null = null
  let pendingFocus: { entry: Entry; source: number; view: number; target: PhysicalSceneFocus; preservePose: boolean } | null = null
  const disposals: NonNullable<ReturnType<PhysicalViewportRenderer['metrics']>>[] = []
  const presentations = (): PhysicalScenePresentation[] => [...entries.values()].map(entry => ({ descriptor: entry.source.descriptor, view: entry.view, status: entry.state, ...(entry.reason ? { reason: entry.reason } : {}), renderRevision: entry.renderRevision, occurrenceCount: entry.scene?.objects.length ?? 0 }))
  const emit = (): void => { const next = presentations(), signature = JSON.stringify(next); if (lastPresentation === signature) return; lastPresentation = signature; options.onChange(next) }
  const drawable = (): PhysicalLayerEntry[] => !active ? [] : [...entries.values()].flatMap(entry => {
    const result: PhysicalLayerEntry[] = [], detailed = Boolean(entry.scene && entry.prepared && entry.eligible && entry.state === 'ready')
    if (detailed) result.push({ scene: entry.scene!, meshes: entry.meshes, asset: entry.prepared!, view: entry.view, status: entry.status })
    if (!entry.overview || !entry.source.descriptor.locationValid || entry.view.detail === 'hidden') return result
    let meshes = visiblePhysicalSurfaceOwners(entry.overview.asset.meshes, entry.overview.asset.acceleration)
    if (detailed) {
      if (!entry.scopeId) return result
      const key = `${entry.overview.asset.key}/${entry.scopeId}`
      if (entry.overviewFilter?.key !== key) {
        const filtered = physicalOverviewContextMeshes(entry.source.descriptor, meshes, entry.scopeId)
        derivePhysicalPickAcceleration(filtered, entry.overview.asset.acceleration); entry.overviewFilter = { key, meshes: filtered }
      }
      meshes = entry.overviewFilter.meshes
    } else if (viewport.surface.kind !== 'canvas') return result
    if (meshes.length) result.push({ scene: entry.overview.scene, meshes, asset: entry.overview.asset, view: entry.view, status: new Map() })
    return result
  })
  const removeRenderer = (): void => { if (!renderer) return; const prior = renderer; renderer = null; viewport.removeRenderer(prior); const receipt = prior.metrics(); if (receipt) disposals.push(receipt) }
  const reconcileRenderer = (): void => {
    if (destroyed || contextLost) return
    if (!active || !entries.size || [...entries.values()].every(entry => entry.failure || !entry.source.descriptor.locationValid)) { removeRenderer(); return }
    if (!drawable().length && !renderer) return
    if (!viewport.ready()) return
    if (renderer && viewport.registered(renderer)) { viewport.orderRenderer(); return }
    if (renderer) removeRenderer()
    try { renderer = viewport.installRenderer(drawable, palette, error => { for (const entry of entries.values()) if (entry.eligible) { entry.failure = error.message; entry.state = 'unavailable'; entry.reason = error.message }; options.reportError(error); emit(); queueMicrotask(reconcileRenderer) }); viewport.requestRender() }
    catch (error) { options.reportError(error instanceof Error ? error : new Error(String(error))) }
  }
  const filteredMeshes = (entry: Entry, prepared: PhysicalPreparedGeometry): ReadonlyArray<PhysicalMesh> => {
    const hidden = new Set(entry.view.hiddenLayerIds ?? entry.scene?.layers?.filter(layer => !layer.defaultVisible).map(layer => layer.id) ?? [])
    const scopes = new Map((entry.scene?.scopes ?? []).map(scope => [scope.id, scope]))
    const inScope = (id: string): boolean => { let current: string | undefined = id; while (current !== undefined) { if (current === entry.scopeId) return true; current = scopes.get(current)?.parentId } return false }
    const separated = entry.view.levelId === 'all' && entry.view.separation > 0
    const meshes = separated ? prepared.meshes.map(mesh => ({ ...mesh, offset: mesh.offset.map(value => value * entry.view.separation) as unknown as readonly [number, number, number] })) : prepared.meshes
    const filtered = !hidden.size && !entry.scopeId ? meshes : meshes.filter(mesh => !(mesh.object.layerId && hidden.has(mesh.object.layerId)) && (!entry.scopeId || mesh.object.scopeIds?.some(inScope)))
    if (filtered !== prepared.meshes) derivePhysicalPickAcceleration(filtered, prepared.acceleration)
    return visiblePhysicalSurfaceOwners(filtered, prepared.acceleration)
  }
  const prepareView = async (entry: Entry): Promise<void> => {
    if (!entry.scene) return
    const expected = ++entry.viewGeneration, sourceGeneration = entry.generation
    const view = { ...entry.view, separation: entry.view.levelId === 'all' && entry.view.separation > 0 ? 1 : 0 }, identity = identityFor(entry, sourceGeneration), key = `${identity}/${JSON.stringify([view.mode, view.levelId, view.cutaway, view.separation])}`
    entry.state = 'loading'; entry.preparing = true; renderer?.invalidatePicks(); emit()
    try {
      const prepared = await prepare(entry.scene, view, key, identity, `${identity}/detail`)
      if (destroyed || sourceGeneration !== entry.generation || expected !== entry.viewGeneration || entries.get(entry.source.descriptor.id) !== entry) return
      const objects = new Map(entry.scene!.objects.map(object => [object.id, object]))
      const rebound = { ...prepared, sourceAsset: prepared, meshes: prepared.meshes.map(mesh => { const object = objects.get(mesh.object.id); if (!object) throw new Error('Shared physical asset occurrence identity mismatch'); return { ...mesh, object } }) }
      admitPhysicalPickAcceleration(rebound.meshes, rebound.acceleration)
      entry.renderRevision++; entry.preparing = false; entry.prepared = rebound; entry.meshes = filteredMeshes(entry, rebound); entry.state = !active ? 'hidden' : entry.eligible ? 'ready' : 'distant';
      if (active && pendingFocus?.entry === entry && pendingFocus.source === entry.generation && pendingFocus.view <= expected) { const intent = pendingFocus; pendingFocus = null; viewport.fitWorld(entryBounds(entry, intent.target), { padding: padding(), preservePose: intent.preservePose, mode, bearing: entry.source.descriptor.bearing + (!intent.preservePose && mode === '3d' ? -25 : 0) }) }; reconcileRenderer(); viewport.requestRender(); emit()
    } catch (error) { if (expected !== entry.viewGeneration || sourceGeneration !== entry.generation || destroyed || entries.get(entry.source.descriptor.id) !== entry) return; entry.preparing = false; entry.failure = error instanceof Error ? error.message : String(error); entry.state = 'unavailable'; entry.reason = entry.failure; options.reportError(new Error(entry.failure)); reconcileRenderer(); emit() }
  }
  const prepareOverview = async (entry: Entry): Promise<void> => {
    if (entry.overview || entry.overviewPreparing || !entry.source.descriptor.overviewFootprints?.length || (viewport.surface.kind !== 'canvas' && !entry.scopeId)) return
    entry.overviewPreparing = true; const expected = entry.generation, requestedMode = mode, scene = createPhysicalOverviewScene(entry.source.descriptor)
    const identity = identityFor(entry, expected), key = `${identity}/overview/${mode}`
    try { const asset = await prepare(scene, { ...entry.view, mode, levelId: 'all', cutaway: false, separation: 0 }, key, identity, `${identity}/overview`); if (destroyed || expected !== entry.generation || requestedMode !== mode || entries.get(scene.id) !== entry) return; entry.overviewPreparing = false; entry.overview = { scene, asset }; entry.renderRevision++; reconcileRenderer(); emit(); viewport.requestRender() }
    catch (error) { if (destroyed || expected !== entry.generation) return; entry.overviewPreparing = false; options.reportError(error instanceof Error ? error : new Error(String(error))) }
  }
  const load = async (entry: Entry): Promise<void> => {
    if (entry.loading || entry.scene || entry.failure) return
    entry.loading = true; entry.state = 'loading'; emit(); const expected = entry.generation
    try {
      const scene = await entry.source.load(), descriptor = entry.source.descriptor
      if (destroyed || expected !== entry.generation || entries.get(descriptor.id) !== entry) return
      if (scene.id !== descriptor.id || scene.revision !== descriptor.revision || scene.targetObjectId !== descriptor.targetObjectId || JSON.stringify(scene.anchor) !== JSON.stringify(descriptor.anchor) || scene.bearing !== descriptor.bearing || JSON.stringify(scene.bounds) !== JSON.stringify(descriptor.bounds) || JSON.stringify(scene.levels) !== JSON.stringify(descriptor.levels)) throw new Error('Physical scene delivery does not match its retained descriptor')
      entry.scene = scene; entry.loading = false; if (!active || !entry.eligible) { entry.state = active ? 'distant' : 'hidden'; emit(); return }; await prepareView(entry)
    } catch (error) { if (destroyed || expected !== entry.generation) return; entry.loading = false; entry.failure = error instanceof Error ? error.message : String(error); entry.state = 'unavailable'; entry.reason = entry.failure; options.reportError(new Error(entry.failure)); reconcileRenderer(); emit() }
  }
  const reconcile = (): void => {
    if (destroyed || contextLost) return
    const size = viewport.surface.getSize(), pixelError = options.quality?.pixelError ?? 1
    if (!(pixelError > 0) || !Number.isFinite(pixelError)) throw new Error('Physical representation quality must specify a finite positive pixel error')
    for (const entry of [...entries.values()].sort((a, b) => Number(b.source.descriptor.id === focusedId) - Number(a.source.descriptor.id === focusedId))) {
      const d = entry.source.descriptor, bounds = worldBounds(d.anchor, d.bearing, d.bounds), points = boundsCorners(bounds).map(p => viewport.projectGeographic(new MercatorCoordinate(p[0], p[1]).toLngLat())), xs = points.map(p => p.x), ys = points.map(p => p.y)
      const intersects = size.width > 0 && size.height > 0 && viewport.intersectsBounds(bounds, mode)
      const physicalSpan = Math.max(...d.bounds.max.map((value, axis) => value - d.bounds.min[axis]!)), pixels = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)), error = d.overviewGeometricErrorMetres ?? physicalSpan
      const inspectionPixels = intersects ? projectedInspectionFeature(d, viewport.projectGeographic) : 0
      const overviewErrorPixels = error * pixels / Math.max(physicalSpan, Number.EPSILON)
      const explicitDetail = forcedId === d.id || (viewport.surface.kind === 'canvas' && mode === '3d' && focusedId === null)
      const needsDetail = explicitDetail || automaticInspectionDemand(inspectionPixels, overviewErrorPixels, pixelError)
      const planAllowsDetail = mode !== '2d' || focusedId === d.id || (viewport.surface.kind === 'map' && focusedId === null)
      entry.eligible = active && d.locationValid && entry.view.detail !== 'hidden' && intersects && needsDetail && planAllowsDetail
      if (d.locationValid && !entry.failure) entry.reason = undefined
      if (active && intersects && d.locationValid && (!entry.eligible || entry.scopeId)) void prepareOverview(entry)
      if (!d.locationValid) { entry.state = 'unavailable'; entry.reason = d.reason ?? 'Layout location no longer matches its owner' }
      else if (entry.failure) { entry.state = 'unavailable'; entry.reason = entry.failure }
      else if (!active || entry.view.detail === 'hidden') entry.state = 'hidden'
      else if (!entry.eligible) { entry.state = 'distant'; entry.reason = d.inspectionFeatureMetres === undefined && !explicitDetail ? 'Automatic inspection scale is not declared; choose a layout scope to inspect it' : undefined }
      else if (entry.preparing) entry.state = 'loading'
      else if (entry.prepared) entry.state = 'ready'
      else if (entry.scene) { entry.state = 'loading'; void prepareView(entry) }
      else if (entry.loading) entry.state = 'loading'
      else void load(entry)
    }
    reconcileRenderer(); emit()
  }
  const enqueue = (): void => { if (queued || destroyed) return; queued = true; queueMicrotask(() => { queued = false; reconcile() }) }
  const cleanup = [viewport.on('change', enqueue), viewport.on('resize', enqueue), viewport.on('style', enqueue), viewport.on('idle', enqueue), viewport.on('contextlost', () => { contextLost = true; removeRenderer() }), viewport.on('contextrestored', () => { contextLost = false; enqueue() })]
  const requireEntry = (id: string): Entry => { const value = entries.get(id); if (!value) throw new Error(`Unknown physical scene: ${id}`); return value }
  const padding = () => options.fitPadding?.() ?? viewport.surface.getPadding()
  const entryBounds = (entry: Entry, target: PhysicalSceneFocus = {}): PhysicalSceneBounds => {
    const visible = entry.scene && entry.meshes.length ? visiblePhysicalBounds({ scene: entry.scene, meshes: entry.meshes, view: entry.view, status: entry.status }, target) : null
    const physical = visible ?? (target.occurrenceId ? entry.scene?.objects.find(object => object.id === target.occurrenceId)?.bounds : null) ?? (target.scopeId ? entry.source.descriptor.scopes?.find(scope => scope.id === target.scopeId)?.bounds : null) ?? entry.source.descriptor.bounds
    const bounds = entry.view.mode === '2d' ? { min: [physical.min[0], physical.min[1], 0] as [number, number, number], max: [physical.max[0], physical.max[1], 0] as [number, number, number] } : physical
    return worldBounds(entry.source.descriptor.anchor, entry.source.descriptor.bearing, bounds)
  }
  const fitEntry = (entry: Entry, target: PhysicalSceneFocus, preservePose: boolean): void => {
    pendingFocus = null; viewport.fitWorld(entryBounds(entry, target), { padding: padding(), preservePose, mode, bearing: entry.source.descriptor.bearing + (!preservePose && mode === '3d' ? -25 : 0) })
    if (!entry.prepared || entry.preparing) pendingFocus = { entry, source: entry.generation, view: entry.viewGeneration, target, preservePose }
  }
  cleanup.push(viewport.on('movestart', () => { pendingFocus = null }))
  return {
    surface: viewport.surface,
    setSources(sources: ReadonlyArray<PhysicalSceneSource>): void {
      if (destroyed) return
      if (new Set(sources.map(source => source.descriptor.id)).size !== sources.length) throw new Error('Physical scene IDs must be unique in a Run')
      const next = new Set(sources.map(source => source.descriptor.id)); let changed = false
      for (const [id, entry] of entries) if (!next.has(id)) { entry.generation = ++generation; entries.delete(id); changed = true }
      for (const source of sources) {
        const previous = entries.get(source.descriptor.id)
        if (previous && JSON.stringify(previous.source.descriptor) === JSON.stringify(source.descriptor)) { previous.source = source; continue }
        if (previous) previous.generation = ++generation
        entries.set(source.descriptor.id, { renderRevision: 0, source, generation: ++generation, viewGeneration: 0, scene: null, prepared: null, meshes: [], view: previous?.view ?? { ...defaultPhysicalSceneView(source.descriptor.levels), mode }, status: new Map(), signature: '', state: 'distant', loading: false, eligible: false }); changed = true
      }
      if (focusedId !== null && !entries.has(focusedId)) { focusedId = null; forcedId = null }
      if (changed) { prepare.retainIdentities?.(new Set([...entries.values()].map(entry => identityFor(entry)))); renderer?.retainGeometryIdentities(new Set([...entries.values()].map(entry => identityFor(entry)))); renderer?.invalidatePicks(); reconcile(); viewport.requestRender() }
    },
    setView(sceneId: string, view: PhysicalSceneView): void {
      const entry = requireEntry(sceneId)
      if (!Number.isFinite(view.separation) || view.separation < 0) throw new Error('Level separation must be a finite nonnegative display distance')
      if (view.levelId !== 'all' && !entry.source.descriptor.levels.some(level => level.id === view.levelId)) throw new Error(`Unknown physical level: ${view.levelId}`)
      pendingFocus = null
      const changedMode = mode !== view.mode; mode = view.mode
      for (const target of entries.values()) {
        const desired = target === entry ? view : changedMode ? { ...target.view, mode } : target.view
        const normalized = mode === '2d' && desired.levelId === 'all' ? { ...desired, levelId: target.source.descriptor.levels[0]!.id } : desired
        const old = target.view; target.view = normalized
        if (changedMode) { target.overview = undefined; target.overviewPreparing = false }
        if (JSON.stringify([old.mode, old.levelId, old.cutaway, old.levelId === 'all' && old.separation > 0]) !== JSON.stringify([normalized.mode, normalized.levelId, normalized.cutaway, normalized.levelId === 'all' && normalized.separation > 0])) { target.viewGeneration++; target.preparing = false; target.prepared = null; target.meshes = [] }
        else if (target.prepared) target.meshes = filteredMeshes(target, target.prepared)
      }
      renderer?.invalidatePicks(); if (mode === '2d') { viewport.cancelCamera(); viewport.setNavigationTool('pan') }; if (changedMode) viewport.setPose({ pitch: mode === '2d' ? 0 : 50, ...(mode === '2d' ? { elevation: 0 } : {}) }); reconcile(); viewport.requestRender()
    },
    setStatus(sceneId: string, status: ReadonlyMap<string, PhysicalSubjectStyle>): void {
      const entry = entries.get(sceneId); if (!entry) return
      for (const style of status.values()) if (!Number.isFinite(style.emphasis) || style.emphasis < 0 || style.emphasis > 1 || style.color?.some(value => !Number.isFinite(value) || value < 0 || value > 1)) throw new Error('Invalid physical status presentation')
      const signature = JSON.stringify([...status].sort(([a], [b]) => a.localeCompare(b))); if (signature === entry.signature) return; entry.signature = signature; entry.status = status; if (active && entry.eligible && entry.view.live) viewport.requestRender()
    },
    setPalette(next: PhysicalScenePalette): void { if (JSON.stringify(next) === JSON.stringify(palette)) return; palette = next; renderer?.setPalette(next); viewport.requestRender() },
    selectScope(sceneId: string, scopeId?: string): void { const entry = requireEntry(sceneId); if (scopeId && !entry.source.descriptor.scopes?.some(scope => scope.id === scopeId)) throw new Error(`Unknown physical scope: ${scopeId}`); focusedId = sceneId; forcedId = sceneId; if (entry.scopeId !== scopeId) entry.renderRevision++; entry.scopeId = scopeId; if (entry.prepared) entry.meshes = filteredMeshes(entry, entry.prepared); renderer?.invalidatePicks(); reconcile(); viewport.requestRender() },
    focus(sceneId: string, target: PhysicalSceneFocus = {}): void { this.selectScope(sceneId, target.scopeId); const entry = requireEntry(sceneId); fitEntry(entry, target, target.preservePose ?? true) },
    fit(sceneId: string): void { const entry = requireEntry(sceneId); fitEntry(entry, { scopeId: entry.scopeId }, true) },
    fitAll(sceneIds?: ReadonlyArray<string>): void { const selected = sceneIds ? sceneIds.map(requireEntry) : [...entries.values()]; if (!selected.length) return; pendingFocus = null; focusedId = null; forcedId = null; for (const entry of entries.values()) { if (entry.scopeId !== undefined) entry.renderRevision++; entry.scopeId = undefined; if (entry.prepared) entry.meshes = filteredMeshes(entry, entry.prepared) }; viewport.fitWorld(combinedBounds(selected.map(entry => entryBounds(entry))), { padding: padding(), preservePose: true, mode, bearing: 0 }); reconcile() },
    home(sceneId: string, scopeId?: string): void { const entry = requireEntry(sceneId); this.selectScope(sceneId, scopeId); fitEntry(entry, { scopeId }, false) },
    reset(sceneId: string): void { const entry = requireEntry(sceneId); this.setView(sceneId, defaultPhysicalSceneView(entry.source.descriptor.levels)); this.home(sceneId) },
    cameraPose: viewport.cameraPose, zoomBy: (delta: number) => viewport.setPose({ zoom: viewport.cameraPose().zoom + delta }), tiltBy: (degrees: number) => viewport.setPose({ pitch: viewport.cameraPose().pitch + degrees }), turnBy: (degrees: number) => viewport.setPose({ bearing: viewport.cameraPose().bearing + degrees }), panBy: viewport.panBy, cancelCamera: () => { pendingFocus = null; viewport.cancelCamera() }, setNavigationTool: viewport.setNavigationTool,
    setActive(value: boolean): void { if (active === value || destroyed) return; active = value; if (!active) { pendingFocus = null; viewport.cancelCamera(); renderer?.invalidatePicks() }; reconcile(); viewport.requestRender() },
    pick: (point: { x: number; y: number }) => active ? renderer?.pick(point) ?? null : null,
    cheapProject: (sceneId: string, occurrenceId: string, levelId?: string) => active ? renderer?.cheapProject(sceneId, occurrenceId, levelId) ?? null : null,
    visibleAt: (sceneId: string, occurrenceId: string, point: { x: number; y: number }) => active && (renderer?.visibleAt(sceneId, occurrenceId, point) ?? false),
    project: (sceneId: string, occurrenceId: string, levelId?: string) => active ? renderer?.project(sceneId, occurrenceId, levelId) ?? null : null,
    presentations, scene: (sceneId: string) => entries.get(sceneId)?.scene ?? null,
    retry(sceneId: string): void { const entry = requireEntry(sceneId); entry.generation = ++generation; entry.viewGeneration++; entry.loading = false; entry.preparing = false; entry.failure = undefined; entry.reason = undefined; entry.scene = null; entry.prepared = null; entry.meshes = []; prepare.retainIdentities?.(new Set([...entries.values()].map(entry => identityFor(entry)))); reconcile() },
    metrics: () => renderer?.metrics() ?? null,
    diagnostics: () => ({ surfaceOwnership: [...entries.values()].filter(entry => entry.prepared).map(entry => ({ sceneId: entry.source.descriptor.id, key: entry.prepared!.key, ...entry.prepared!.surfaceOwnership })), preparation: prepare.diagnostics?.() ?? null, current: renderer?.metrics() ?? null, disposals: [...disposals], retainedScenes: [...entries.values()].filter(entry => entry.scene).length, loadingScenes: [...entries.values()].filter(entry => entry.loading || entry.state === 'loading').length }),
    destroy(): void { if (destroyed) return; destroyed = true; pendingFocus = null; for (const entry of entries.values()) { entry.generation = ++generation; entry.viewGeneration++ }; entries.clear(); prepare.destroy?.(); for (const remove of cleanup) remove(); removeRenderer(); viewport.destroy() },
  }
}
