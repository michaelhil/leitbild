import { MercatorCoordinate } from 'maplibre-gl'
import { physicalSceneInitialVisibleLayers, type PackPhysicalScene, type PhysicalSceneBounds } from '../../../core/packs/scene.ts'
import type { PhysicalLayerEntry } from './layer.ts'
import { meshBounds, type PhysicalMesh } from './geometry.ts'
import { boundsCorners, localMercatorMatrix, transform, type Vector3 } from './math.ts'
import {createPhysicalArchitectureOrdering,physicalArchitectureCohort,type PhysicalArchitectureCohort,type PhysicalArchitectureBspFrame} from './architecture-cohort.ts'
import {createPhysicalArchitectureBspPreparer} from './architecture-bsp-preparation.ts'
import type {PhysicalArchitectureBsp} from './architecture-bsp-types.ts'
import type {PhysicalArchitectureOpacity} from './types.ts'
import { createPhysicalInspectionWorkingSet } from './inspection-working-set.ts'
import { createPhysicalGeometryPreparer, type PhysicalPreparedGeometry } from './preparation.ts'
import { admitPhysicalPickAcceleration, derivePhysicalPickAcceleration } from './picking.ts'
import { createPhysicalOverviewScene, physicalOverviewContextMeshes } from './overview-geometry.ts'
import { projectedInspectionFeature, automaticInspectionDemand } from './inspection-demand.ts'
import { visiblePhysicalBounds } from './renderer.ts'
import { physicalDesiredMeshLayers, physicalLayerUnion, physicalMeshLayers, physicalMissingLayers, physicalViewWithMeshCoverage } from './layer-demand.ts'
import { physicalScopeMembers } from './scopes.ts'
import { visiblePhysicalSurfaceOwners } from './surface-ownership.ts'
import { physicalPlanDrawingBounds } from '../../physical-layout/plan-drawing.ts'
import type { PhysicalViewport, PhysicalViewportRenderer } from './viewport.ts'
import { defaultPhysicalSceneView, type PhysicalSceneControllerOptions, type PhysicalSceneFocus, type PhysicalSceneHighlight, type PhysicalScenePalette, type PhysicalScenePresentation, type PhysicalSceneSource, type PhysicalSceneView, type PhysicalSubjectStyle, type PhysicalViewportFitOptions } from './types.ts'

interface Entry { requestedOpacity?:PhysicalArchitectureOpacity; opaqueOpacity?:PhysicalArchitectureOpacity; planSignature?: string; renderRevision: number; source: PhysicalSceneSource; generation: number; viewGeneration: number; scene: PackPhysicalScene | null; prepared: PhysicalPreparedGeometry | null; meshes: ReadonlyArray<PhysicalMesh>; view: PhysicalSceneView; status: ReadonlyMap<string, PhysicalSubjectStyle>; signature: string; state: PhysicalScenePresentation['status']; reason?: string | undefined; loading: boolean; preparing?: boolean; preparationAbort?: AbortController | undefined; eligible: boolean; failure?: string | undefined; scopeId?: string | undefined; preparedLayers?: ReadonlyArray<string> | undefined; requestedLayers?: ReadonlyArray<string> | undefined; layerFailure?: { layerIds: ReadonlyArray<string>; reason: string } | undefined; overview?: { scene: PackPhysicalScene; asset: PhysicalPreparedGeometry } | undefined; overviewPreparing?: boolean; overviewAbort?: AbortController | undefined; overviewFilter?: { key: string; meshes: ReadonlyArray<PhysicalMesh> } | undefined }
type Options = Omit<PhysicalSceneControllerOptions, 'map' | 'beforeId'>
const worldBounds = (anchor: readonly [number, number], bearing: number, bounds: PhysicalSceneBounds): PhysicalSceneBounds => {
  const matrix = localMercatorMatrix(anchor, bearing), points = boundsCorners(bounds).map(p => transform(matrix, p))
  return { min: [0, 1, 2].map(a => Math.min(...points.map(p => p[a]!))) as [number, number, number], max: [0, 1, 2].map(a => Math.max(...points.map(p => p[a]!))) as [number, number, number] }
}
const combinedBounds = (values: ReadonlyArray<PhysicalSceneBounds>): PhysicalSceneBounds => ({ min: [0, 1, 2].map(a => Math.min(...values.map(b => b.min[a]!))) as [number, number, number], max: [0, 1, 2].map(a => Math.max(...values.map(b => b.max[a]!))) as [number, number, number] })

let controllerSequence = 0
/** Common retained scene orchestration; viewport adapters own real cameras and contexts. */
export const createPhysicalSceneControllerForViewport = (viewport: PhysicalViewport, options: Options) => {
  const entries = new Map<string, Entry>(), prepare = options.prepare ?? createPhysicalGeometryPreparer(), privateNamespace = ++controllerSequence, inspectionWorkingSet = createPhysicalInspectionWorkingSet()
  const identityFor = (entry: Entry, sourceGeneration = entry.generation) => entry.source.descriptor.geometryKey ?? `private/${privateNamespace}/${entry.source.descriptor.id}/${sourceGeneration}`
  let palette = options.palette, renderer: PhysicalViewportRenderer | null = null, active = true, destroyed = false, generation = 0, mode: PhysicalSceneView['mode'] = '2d', lastPresentation = '', queued = false, contextLost = false
  let focusedId: string | null = null, forcedId: string | null = null
  let collectionIds: ReadonlySet<string> | null = null
  let pendingFocus: { entry: Entry; source: number; view: number; target: PhysicalSceneFocus; preservePose: boolean } | null = null
  let pendingCollectionFocus: { targets: ReadonlyArray<{ entry: Entry; source: number }>; preservePose: boolean } | null = null
  let cameraOwned = true, reconcilingCamera = false
  let highlight: PhysicalSceneHighlight | null = null
  const architecturePrepare=options.prepareArchitecture??createPhysicalArchitectureBspPreparer()
  const architectureOrdering=createPhysicalArchitectureOrdering(architecturePrepare,()=>enqueue())
  let architectureAsset:PhysicalArchitectureBsp|null=null,architectureInput:PhysicalArchitectureCohort|null=null,architectureFrame:PhysicalArchitectureBspFrame|null=null,architectureRetry=false
  let architectureSelection:ReadonlyArray<{scene:PackPhysicalScene;asset:PhysicalPreparedGeometry|undefined;meshes:ReadonlyArray<PhysicalMesh>;mode:PhysicalSceneView['mode'];level:string;separation:number}>=[]
  const opacityOf=(view:PhysicalSceneView):PhysicalArchitectureOpacity=>({wallOpacity:view.wallOpacity??1,floorOpacity:view.floorOpacity??1})
  const fractional=(value:number):boolean=>value>0&&value<1
  const wantedOpacity=(entry:Entry):PhysicalArchitectureOpacity=>entry.requestedOpacity??opacityOf(entry.view)
  const opacityPresentation=(entry:Entry):PhysicalScenePresentation['opacityPreparation']=>{
    const desired=wantedOpacity(entry),actual=opacityOf(entry.view)
    if(desired.wallOpacity===actual.wallOpacity&&desired.floorOpacity===actual.floorOpacity)return undefined
    const state=architectureOrdering.state()
    return{status:state.status==='unavailable'?'unavailable':'loading',requested:desired,...(state.reason?{reason:state.reason}:{})}
  }
  const clearHighlight = (): void => { highlight = null; renderer?.setHighlight(null) }
  const setPlanarity = (value: boolean): void => { const prior = reconcilingCamera; reconcilingCamera = true; try { viewport.setPlanarInspection?.(value) } finally { reconcilingCamera = prior } }
  const syncPlanarity = (): void => setPlanarity(active && cameraOwned && mode === '2d' && [...entries.values()].some(entry => entry.eligible && entry.state === 'ready' && entry.scene?.planDrawing?.views.some(view => view.levelId === entry.view.levelId)))
  const occurrenceBounds = new WeakMap<PackPhysicalScene['objects'][number], PhysicalSceneBounds>()
  const planPlacements = new WeakMap<PhysicalSceneSource['descriptor'], Float64Array>()
  const emptyStatus: ReadonlyMap<string, PhysicalSubjectStyle> = new Map()
  const disposals: NonNullable<ReturnType<PhysicalViewportRenderer['metrics']>>[] = []
  const hasPlanInk = (entry: Entry): boolean => entry.view.mode === '2d' && Boolean(entry.scene?.planDrawing?.views.some(view => view.levelId === entry.view.levelId))
  const readyGeometry = (entry: Entry): boolean => hasPlanInk(entry) || entry.prepared !== null
  const initialView = (source: PhysicalSceneSource): PhysicalSceneView => {
    const descriptor = source.descriptor, visible = new Set(physicalSceneInitialVisibleLayers(descriptor)), base = { ...defaultPhysicalSceneView(descriptor.levels), mode }
    return descriptor.layers ? { ...base, hiddenLayerIds: descriptor.layers.filter(layer => !layer.defaultVisible && !visible.has(layer.id)).map(layer => layer.id) } : base
  }
  const layerPresentation = (entry: Entry): PhysicalScenePresentation['layerPreparation'] => {
    if (!entry.scene || !entry.prepared) return undefined
    const missing = physicalMissingLayers(physicalDesiredMeshLayers(entry.scene, entry.view), entry.preparedLayers)
    if (!missing.length) return undefined
    if (entry.layerFailure) return { status: 'unavailable', layerIds: missing, reason: entry.layerFailure.reason }
    return entry.preparing ? { status: 'loading', layerIds: missing } : undefined
  }
  const presentations = (): PhysicalScenePresentation[] => [...entries.values()].map(entry => {
    const layerPreparation = layerPresentation(entry),opacityPreparation=opacityPresentation(entry)
    return { descriptor: entry.source.descriptor, view: entry.view, status: entry.state, ...(entry.reason ? { reason: entry.reason } : {}), ...(layerPreparation ? { layerPreparation } : {}),...(opacityPreparation?{opacityPreparation}:{}), renderRevision: entry.renderRevision, occurrenceCount: entry.scene?.objects.length ?? 0 }
  })
  const emit = (): void => { const next = presentations(), signature = JSON.stringify(next); if (lastPresentation === signature) return; lastPresentation = signature; options.onChange(next) }
  const drawable = (): PhysicalLayerEntry[] => !active ? [] : [...entries.values()].flatMap(entry => {
    if (focusedId === null && collectionIds !== null && !collectionIds.has(entry.source.descriptor.id)) return []
    if (focusedId !== null && !entries.get(focusedId)?.view.surroundings && entry.source.descriptor.id !== focusedId) return []
    const result: PhysicalLayerEntry[] = [], detailed = Boolean(entry.scene && readyGeometry(entry) && entry.eligible && entry.state === 'ready')
    if (detailed) result.push({ scene: entry.scene!, meshes: entry.meshes, ...(entry.prepared ? { asset: entry.prepared } : {}), ...(entry.scopeId ? { scopeId: entry.scopeId } : {}), view: entry.view, status: entry.status })
    if (!entry.overview || !entry.source.descriptor.locationValid || entry.view.detail === 'hidden') return result
    let meshes = visiblePhysicalSurfaceOwners(entry.overview.asset.meshes, entry.overview.asset.acceleration)
    if (detailed) {
      if (!entry.scopeId || !entry.view.surroundings) return result
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
  const reconcileArchitecture=():void=>{
    const visible:PhysicalLayerEntry[]=[...entries.values()].flatMap(entry=>{
      if(!active||!entry.scene||!entry.prepared||entry.failure||!entry.source.descriptor.locationValid||entry.view.detail==='hidden')return[]
      if(focusedId===null&&collectionIds!==null&&!collectionIds.has(entry.source.descriptor.id))return[]
      if(focusedId!==null&&!entries.get(focusedId)?.view.surroundings&&entry.source.descriptor.id!==focusedId)return[]
      const explicit=focusedId!==null||collectionIds!==null
      if(!explicit&&!entry.eligible)return[]
      return[{scene:entry.scene,asset:entry.prepared,meshes:entry.meshes,view:entry.view,status:entry.status}]
    }),selected=visible.map(entry=>({scene:entry.scene,asset:entry.asset,meshes:entry.meshes,mode:entry.view.mode,level:entry.view.levelId,separation:entry.view.separation}))
    const same=selected.length===architectureSelection.length&&selected.every((entry,index)=>{const before=architectureSelection[index]!;return entry.scene===before.scene&&entry.asset===before.asset&&entry.meshes===before.meshes&&entry.mode===before.mode&&entry.level===before.level&&entry.separation===before.separation})
    const needs=visible.some(draw=>{const entry=entries.get(draw.scene.id);if(!entry||draw.view.mode==='2d'&&hasPlanInk(entry))return false;const desired=wantedOpacity(entry);return fractional(desired.wallOpacity)||fractional(desired.floorOpacity)})
    if(!same){architectureSelection=selected;const candidate=needs?physicalArchitectureCohort(visible):null;if(candidate?.key!==architectureInput?.key){architectureOrdering.request(null);architectureInput=candidate}else if(!architectureInput)architectureInput=candidate}
    else if(needs&&!architectureInput)architectureInput=physicalArchitectureCohort(visible)
    if(needs&&architectureInput){architectureOrdering.request(architectureInput,architectureRetry);architectureRetry=false}
    else architectureOrdering.suspend()
    const next=architectureInput?architectureOrdering.asset(architectureInput.key):null
    const nextFrame=next?architectureInput!.frame:null
    if(next!==architectureAsset||nextFrame!==architectureFrame){architectureAsset=next;architectureFrame=nextFrame;renderer?.setArchitectureBsp(next,nextFrame)}
    const drawn=new Set(visible.map(entry=>entry.scene.id))
    for(const entry of entries.values()){
      if(!entry.requestedOpacity)continue
      const desired=entry.requestedOpacity,requires=drawn.has(entry.source.descriptor.id)&&!(entry.view.mode==='2d'&&hasPlanInk(entry))&&architectureInput!==null&&!next
      const fallback=entry.opaqueOpacity??{wallOpacity:1,floorOpacity:1}
      const applied={wallOpacity:requires&&fractional(desired.wallOpacity)?fallback.wallOpacity:desired.wallOpacity,floorOpacity:requires&&fractional(desired.floorOpacity)?fallback.floorOpacity:desired.floorOpacity}
      if(entry.view.wallOpacity!==applied.wallOpacity||entry.view.floorOpacity!==applied.floorOpacity)entry.view={...entry.view,...applied}
    }
  }
  const removeRenderer = (): void => { if (!renderer) return; const prior = renderer; renderer = null; viewport.removeRenderer(prior); const receipt = prior.metrics(); if (receipt) disposals.push(receipt) }
  const reconcileRenderer = (): void => {
    if (destroyed || contextLost) return
    if (!active || !entries.size || [...entries.values()].every(entry => entry.failure || !entry.source.descriptor.locationValid)) { removeRenderer(); return }
    if (!drawable().length && !renderer) return
    if (!viewport.ready()) return
    if (renderer && viewport.registered(renderer)) { viewport.orderRenderer(); return }
    if (renderer) removeRenderer()
    try { renderer = viewport.installRenderer(drawable, palette, error => { for (const entry of entries.values()) if (entry.eligible) { entry.failure = error.message; entry.state = 'unavailable'; entry.reason = error.message }; syncPlanarity(); options.reportError(error); emit(); queueMicrotask(reconcileRenderer) }, options.planFontFamily); renderer.setHighlight(highlight);renderer.setArchitectureBsp(architectureAsset,architectureFrame); viewport.requestRender() }
    catch (error) { options.reportError(error instanceof Error ? error : new Error(String(error))) }
  }
  const filteredMeshes = (entry: Entry, prepared: PhysicalPreparedGeometry): ReadonlyArray<PhysicalMesh> => {
    const hidden = new Set(entry.view.hiddenLayerIds ?? entry.scene?.layers?.filter(layer => !layer.defaultVisible).map(layer => layer.id) ?? [])
    const members = entry.scopeId ? physicalScopeMembers(entry.scene?.scopes ?? [], entry.scopeId) : null
    const separated = entry.view.levelId === 'all' && entry.view.separation > 0
    const meshes = separated ? prepared.meshes.map(mesh => ({ ...mesh, offset: mesh.offset.map(value => value * entry.view.separation) as unknown as readonly [number, number, number] })) : prepared.meshes
    const filtered = !hidden.size && !entry.scopeId ? meshes : meshes.filter(mesh => {
      const layerId = mesh.annotation?.layerId ?? mesh.object.layerId, scopes = mesh.annotation?.scopeIds ?? mesh.object.scopeIds
      return !(layerId && hidden.has(layerId)) && (!entry.scopeId || mesh.inspectionScopeId === entry.scopeId || scopes?.some(id => members!.has(id)))
    })
    if (filtered !== prepared.meshes) derivePhysicalPickAcceleration(filtered, prepared.acceleration)
    // Authored full/cut boundary alternatives must reach the camera-facing
    // selector together. Only then can coincident display owners be chosen.
    return filtered
  }
  const cancelPreparation = (entry: Entry): void => { entry.viewGeneration++; entry.preparationAbort?.abort(); entry.preparationAbort = undefined; entry.preparing = false; entry.requestedLayers = undefined }
  const discardPrepared = (entry: Entry): void => { entry.prepared = null; entry.preparedLayers = undefined; entry.meshes = []; entry.layerFailure = undefined }
  const scopedCoverage = (entry: Entry, coverage: ReadonlyArray<string> = []): boolean => {
    const included = new Set(coverage)
    return entry.scene?.objects.some(object => object.clipToScope && (!object.layerId || included.has(object.layerId))) ?? false
  }
  // A scope change invalidates only geometry that actually used its clipping
  // volume. Unprepared hidden routes must not discard a valid base-only asset.
  const changePreparedScope = (entry: Entry): void => {
    const invalidPrepared = entry.prepared !== null && scopedCoverage(entry, entry.preparedLayers)
    if (invalidPrepared || entry.preparing && scopedCoverage(entry, entry.requestedLayers)) cancelPreparation(entry)
    if (invalidPrepared) discardPrepared(entry)
    else if (entry.layerFailure && scopedCoverage(entry, physicalLayerUnion(entry.preparedLayers ?? [], entry.layerFailure.layerIds))) entry.layerFailure = undefined
  }
  const cancelOverview = (entry: Entry): void => { entry.overviewAbort?.abort(); entry.overviewAbort = undefined; entry.overviewPreparing = false }
  const admitPlanInk = (entry: Entry): boolean => {
    if (!hasPlanInk(entry)) return false
    if (entry.preparing) cancelPreparation(entry)
    if (entry.prepared) discardPrepared(entry)
    const key = JSON.stringify([entry.view.levelId, entry.scopeId ?? null, [...(entry.view.hiddenLayerIds ?? [])].sort()])
    if (entry.planSignature !== key) { entry.planSignature = key; entry.renderRevision++ }
    entry.state = !active ? 'hidden' : entry.eligible ? 'ready' : 'distant'
    return true
  }
  const prepareView = async (entry: Entry): Promise<void> => {
    if (!entry.scene) return
    if (admitPlanInk(entry)) { syncPlanarity(); refreshCollectionFit(); reconcile(); viewport.requestRender(); return }
    const expected = ++entry.viewGeneration, sourceGeneration = entry.generation, request = new AbortController()
    entry.preparationAbort = request
    const retained = inspectionWorkingSet.select(entry.source.descriptor.id, entry.view, entry.scopeId)
    const coverage = physicalLayerUnion(entry.preparedLayers ?? [], retained?.coverage ?? [], physicalDesiredMeshLayers(entry.scene, entry.view))
    const scopeId = entry.scopeId && scopedCoverage(entry, coverage) ? entry.scopeId : undefined
    const demandView = physicalViewWithMeshCoverage(entry.scene, entry.view, coverage)
    const view = { ...demandView, ...(scopeId ? { scopeId } : {}), separation: entry.view.levelId === 'all' && entry.view.separation > 0 ? 1 : 0 }, identity = identityFor(entry, sourceGeneration)
    const key = `${identity}/${JSON.stringify([view.mode, view.levelId, view.cutaway, view.separation, ...(scopeId ? [scopeId] : []), ...(physicalMeshLayers(entry.scene, view).length ? [{ layers: coverage }] : [])])}`
    entry.requestedLayers = coverage; entry.preparing = true; entry.state = entry.prepared ? 'ready' : 'loading'; if (!entry.prepared) renderer?.invalidatePicks(); emit()
    try {
      const prepared = retained?.asset.key === key ? retained.asset : await prepare(entry.scene, view, key, identity, `${identity}/detail`, request.signal)
      if (destroyed || sourceGeneration !== entry.generation || expected !== entry.viewGeneration || entries.get(entry.source.descriptor.id) !== entry) return
      inspectionWorkingSet.remember(entry.source.descriptor.id, entry.view, entry.scopeId, coverage, prepared)
      const objects = new Map(entry.scene!.objects.map(object => [object.id, object]))
      const rebound = { ...prepared, sourceAsset: prepared, meshes: prepared.meshes.map(mesh => { const object = objects.get(mesh.object.id); if (!object) throw new Error('Shared physical asset occurrence identity mismatch'); return { ...mesh, object } }) }
      admitPhysicalPickAcceleration(rebound.meshes, rebound.acceleration)
      entry.renderRevision++; entry.preparing = false; entry.requestedLayers = undefined; entry.preparedLayers = coverage; entry.layerFailure = undefined; entry.prepared = rebound; entry.meshes = filteredMeshes(entry, rebound); entry.state = !active ? 'hidden' : entry.eligible ? 'ready' : 'distant';
      syncPlanarity()
      if (active && pendingFocus?.entry === entry && pendingFocus.source === entry.generation && pendingFocus.view <= expected) { const intent = pendingFocus; pendingFocus = null; applyFit(entry, intent.target, intent.preservePose) }; refreshCollectionFit(); reconcile(); viewport.requestRender()
    } catch (error) {
      if (request.signal.aborted || expected !== entry.viewGeneration || sourceGeneration !== entry.generation || destroyed || entries.get(entry.source.descriptor.id) !== entry) return
      entry.preparing = false; entry.requestedLayers = undefined
      const reason = error instanceof Error ? error.message : String(error)
      if (entry.prepared) {
        entry.layerFailure = { layerIds: physicalMissingLayers(physicalDesiredMeshLayers(entry.scene, entry.view), entry.preparedLayers), reason }
        entry.state = !active ? 'hidden' : entry.eligible ? 'ready' : 'distant'
      } else { entry.failure = reason; entry.state = 'unavailable'; entry.reason = reason }
      options.reportError(new Error(reason)); refreshCollectionFit(); reconcile(); viewport.requestRender()
    }
    finally { if (entry.preparationAbort === request) entry.preparationAbort = undefined }
  }
  const prepareOverview = async (entry: Entry): Promise<void> => {
    if (entry.overview || entry.overviewPreparing || !entry.source.descriptor.overviewFootprints?.length || (viewport.surface.kind !== 'canvas' && !entry.scopeId)) return
    entry.overviewPreparing = true; const expected = entry.generation, requestedMode = mode, scene = createPhysicalOverviewScene(entry.source.descriptor), request = new AbortController()
    entry.overviewAbort = request
    const identity = identityFor(entry, expected), key = `${identity}/overview/${mode}`
    try { const asset = await prepare(scene, { ...entry.view, mode, levelId: 'all', cutaway: false, separation: 0 }, key, identity, `${identity}/overview`, request.signal); if (request.signal.aborted || destroyed || expected !== entry.generation || requestedMode !== mode || entries.get(scene.id) !== entry) return; entry.overviewPreparing = false; entry.overview = { scene, asset }; entry.renderRevision++; reconcileRenderer(); emit(); viewport.requestRender() }
    catch (error) { if (request.signal.aborted || destroyed || expected !== entry.generation || requestedMode !== mode) return; entry.overviewPreparing = false; options.reportError(error instanceof Error ? error : new Error(String(error))) }
    finally { if (entry.overviewAbort === request) entry.overviewAbort = undefined }
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
      const canPresent = focusedId === null ? collectionIds === null || collectionIds.has(entry.source.descriptor.id) : entry.source.descriptor.id === focusedId || entries.get(focusedId)?.view.surroundings === true
      const d = entry.source.descriptor, bounds = worldBounds(d.anchor, d.bearing, d.bounds), points = boundsCorners(bounds).map(p => viewport.projectGeographic(new MercatorCoordinate(p[0], p[1]).toLngLat())), xs = points.map(p => p.x), ys = points.map(p => p.y)
      const intersects = size.width > 0 && size.height > 0 && viewport.intersectsBounds(bounds, mode)
      const physicalSpan = Math.max(...d.bounds.max.map((value, axis) => value - d.bounds.min[axis]!)), pixels = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)), error = d.overviewGeometricErrorMetres ?? physicalSpan
      const inspectionPixels = intersects ? projectedInspectionFeature(d, viewport.projectGeographic) : 0
      const overviewErrorPixels = error * pixels / Math.max(physicalSpan, Number.EPSILON)
      // Explicit source/collection inspection is a task intent on the same map,
      // independent of the viewport adapter. Unselected map entry stays automatic.
      const explicitDetail = forcedId === d.id || collectionIds?.has(d.id) === true
      const needsDetail = explicitDetail || automaticInspectionDemand(inspectionPixels, overviewErrorPixels, pixelError)
      const planAllowsDetail = mode !== '2d' || focusedId === d.id || focusedId === null
      entry.eligible = active && canPresent && d.locationValid && entry.view.detail !== 'hidden' && intersects && needsDetail && planAllowsDetail
      if (d.locationValid && !entry.failure) entry.reason = undefined
      if (active && canPresent && intersects && d.locationValid && (!entry.eligible || entry.scopeId && entry.view.surroundings)) void prepareOverview(entry)
      if (!d.locationValid) { entry.state = 'unavailable'; entry.reason = d.reason ?? 'Layout location no longer matches its owner' }
      else if (entry.failure) { entry.state = 'unavailable'; entry.reason = entry.failure }
      else if (!active || entry.view.detail === 'hidden') entry.state = 'hidden'
      else if (!entry.eligible) { entry.state = 'distant'; entry.reason = d.inspectionFeatureMetres === undefined && !explicitDetail ? 'Automatic inspection scale is not declared; choose a layout scope to inspect it' : undefined }
      else if (admitPlanInk(entry)) { /* Native ink owns Plan colour and picking; no solid asset is required. */ }
      else if (entry.preparing) entry.state = entry.prepared ? 'ready' : 'loading'
      else if (entry.prepared) {
        entry.state = 'ready'
        if (entry.scene && !entry.layerFailure && physicalMissingLayers(physicalDesiredMeshLayers(entry.scene, entry.view), entry.preparedLayers).length) void prepareView(entry)
      }
      else if (entry.scene) { entry.state = 'loading'; void prepareView(entry) }
      else if (entry.loading) entry.state = 'loading'
      else void load(entry)
    }
    const selected = new Set([...entries.values()].filter(entry => entry.source.descriptor.locationValid && entry.view.detail !== 'hidden' && (focusedId !== null ? entry.source.descriptor.id === focusedId : collectionIds !== null ? collectionIds.has(entry.source.descriptor.id) : entry.eligible)).map(entry => entry.source.descriptor.id))
    inspectionWorkingSet.retainScenes(selected)
    reconcileArchitecture();syncPlanarity(); reconcileRenderer(); refreshCollectionFit(); emit()
  }
  const enqueue = (): void => { if (queued || destroyed) return; queued = true; queueMicrotask(() => { queued = false; reconcile() }) }
  const cleanup = [viewport.on('change', enqueue), viewport.on('resize', enqueue), viewport.on('style', enqueue), viewport.on('idle', enqueue), viewport.on('contextlost', () => { contextLost = true; removeRenderer() }), viewport.on('contextrestored', () => { contextLost = false; enqueue() })]
  const requireEntry = (id: string): Entry => { const value = entries.get(id); if (!value) throw new Error(`Unknown physical scene: ${id}`); return value }
  const padding = (bounds: PhysicalSceneBounds, fit: Omit<PhysicalViewportFitOptions, 'padding'>) => options.fitPadding?.({ bounds, ...fit, ...(viewport.measureFit ? { measure: (padding: PhysicalViewportFitOptions['padding']) => viewport.measureFit!(bounds, { ...fit, padding }) } : {}) }) ?? viewport.surface.getPadding()
  const entryBounds = (entry: Entry, target: PhysicalSceneFocus = {}): PhysicalSceneBounds => {
    const visible = entry.scene && entry.meshes.length ? visiblePhysicalBounds({ scene: entry.scene, meshes: entry.meshes, view: entry.view, status: entry.status }, target) : null
    const object = target.occurrenceId ? entry.scene?.objects.find(object => object.id === target.occurrenceId) : undefined
    let objectBounds = object?.bounds ?? (object ? occurrenceBounds.get(object) : null)
    if (!objectBounds && object?.positions.length) { objectBounds = meshBounds(object.positions, 3); occurrenceBounds.set(object, objectBounds) }
    const physical = visible ?? objectBounds ?? (target.scopeId ? entry.source.descriptor.scopes?.find(scope => scope.id === target.scopeId)?.bounds : null) ?? entry.source.descriptor.bounds
    const drawing = entry.view.mode === '2d' && entry.scene ? physicalPlanDrawingBounds(entry.scene, entry.view, target.scopeId ?? entry.scopeId ?? null, target.occurrenceId) : null
    const presented = drawing ? target.occurrenceId ? drawing : combinedBounds([physical, drawing]) : physical
    const bounds = entry.view.mode === '2d' ? { min: [presented.min[0], presented.min[1], 0] as [number, number, number], max: [presented.max[0], presented.max[1], 0] as [number, number, number] } : physical
    return worldBounds(entry.source.descriptor.anchor, entry.source.descriptor.bearing, bounds)
  }
  const applyFit = (entry: Entry, target: PhysicalSceneFocus, preservePose: boolean): void => {
    const scope = !target.occurrenceId && target.scopeId ? entry.source.descriptor.scopes?.find(scope => scope.id === target.scopeId) : undefined
    const preferred = mode === '3d' ? scope?.levelInspectionViews?.find(candidate => candidate.levelId === entry.view.levelId)?.view ?? scope?.inspectionView : undefined
    const placement = preferred?.target ? transform(localMercatorMatrix(entry.source.descriptor.anchor, entry.source.descriptor.bearing), preferred.target) : undefined
    const bounds = entryBounds(entry, target), fit = { preservePose, mode, bearing: entry.source.descriptor.bearing + (preferred?.bearing ?? (mode === '3d' ? -25 : 0)), ...(preferred ? { pitch: preferred.pitch } : {}), ...(placement ? { target: placement } : {}) }
    viewport.fitWorld(bounds, { ...fit, padding: padding(bounds, fit) })
  }
  const fitEntry = (entry: Entry, target: PhysicalSceneFocus, preservePose: boolean): void => {
    pendingFocus = null; pendingCollectionFocus = null; applyFit(entry, target, preservePose)
    if (!readyGeometry(entry) || entry.preparing) pendingFocus = { entry, source: entry.generation, view: entry.viewGeneration, target, preservePose }
  }
  const applyCollectionFit = (selected: ReadonlyArray<Entry>, preservePose: boolean): void => {
    const bounds = combinedBounds(selected.map(entry => entryBounds(entry))), fit = { preservePose, mode, bearing: 0, ...(mode === '3d' ? { pitch: 50 } : {}) }
    viewport.fitWorld(bounds, { ...fit, padding: padding(bounds, fit) })
  }
  const refreshCollectionFit = (): void => {
    const intent = pendingCollectionFocus
    if (!intent) return
    if (!active || intent.targets.some(({ entry, source }) => entries.get(entry.source.descriptor.id) !== entry || entry.generation !== source || entry.failure)) { pendingCollectionFocus = null; return }
    if (intent.targets.some(({ entry }) => !readyGeometry(entry) || entry.preparing || entry.state !== 'ready')) return
    pendingCollectionFocus = null; applyCollectionFit(intent.targets.map(target => target.entry), intent.preservePose)
  }
  cleanup.push(viewport.on('movestart', () => { if (!reconcilingCamera) { pendingFocus = null; pendingCollectionFocus = null } }))
  return {
    surface: viewport.surface,
    setSources(sources: ReadonlyArray<PhysicalSceneSource>): void {
      if (destroyed) return
      if (new Set(sources.map(source => source.descriptor.id)).size !== sources.length) throw new Error('Physical scene IDs must be unique in a Run')
      const next = new Set(sources.map(source => source.descriptor.id)); let changed = false
      for (const [id, entry] of entries) if (!next.has(id)) { entry.generation = ++generation; cancelPreparation(entry); cancelOverview(entry); entries.delete(id); inspectionWorkingSet.forget(id); if (highlight?.sceneId === id) clearHighlight(); changed = true }
      for (const source of sources) {
        const previous = entries.get(source.descriptor.id)
        if (previous && JSON.stringify(previous.source.descriptor) === JSON.stringify(source.descriptor)) { previous.source = source; continue }
        if (previous) { inspectionWorkingSet.forget(source.descriptor.id); previous.generation = ++generation; cancelPreparation(previous); cancelOverview(previous); if (highlight?.sceneId === source.descriptor.id) clearHighlight() }
        entries.set(source.descriptor.id, { renderRevision: 0, source, generation: ++generation, viewGeneration: 0, scene: null, prepared: null, meshes: [], view: previous?.view ?? initialView(source), ...(previous?.requestedOpacity?{requestedOpacity:previous.requestedOpacity}:{}),...(previous?.opaqueOpacity?{opaqueOpacity:previous.opaqueOpacity}:{}),status: new Map(), signature: '', state: 'distant', loading: false, eligible: false }); changed = true
      }
      if (focusedId !== null && !entries.has(focusedId)) { focusedId = null; forcedId = null }
      if (pendingFocus && (entries.get(pendingFocus.entry.source.descriptor.id) !== pendingFocus.entry || pendingFocus.entry.generation !== pendingFocus.source)) pendingFocus = null
      if (pendingCollectionFocus?.targets.some(({ entry, source }) => entries.get(entry.source.descriptor.id) !== entry || entry.generation !== source)) pendingCollectionFocus = null
      if (changed) { prepare.retainIdentities?.(new Set([...entries.values()].map(entry => identityFor(entry)))); renderer?.retainGeometryIdentities(new Set([...entries.values()].map(entry => identityFor(entry)))); renderer?.invalidatePicks(); reconcile(); viewport.requestRender() }
    },
    setView(sceneId: string, view: PhysicalSceneView): void {
      const entry = requireEntry(sceneId)
      for (const opacity of [view.wallOpacity, view.floorOpacity]) if (opacity !== undefined && (!Number.isFinite(opacity) || opacity < 0 || opacity > 1)) throw new Error('Physical architecture opacity must be between zero and one')
      if (!Number.isFinite(view.separation) || view.separation < 0) throw new Error('Level separation must be a finite nonnegative display distance')
      if (view.levelId !== 'all' && !entry.source.descriptor.levels.some(level => level.id === view.levelId)) throw new Error(`Unknown physical level: ${view.levelId}`)
      pendingFocus = null; pendingCollectionFocus = null
      const changedMode = mode !== view.mode; mode = view.mode
      if (changedMode && mode === '3d') setPlanarity(false)
      for (const target of entries.values()) {
        const selected = target === entry ? view : changedMode ? { ...target.view, mode } : target.view
        const desired = changedMode && mode === '3d' && focusedId === null && collectionIds?.has(target.source.descriptor.id) ? { ...selected, levelId: 'all' } : selected
        const normalized = mode === '2d' && desired.levelId === 'all' ? { ...desired, levelId: target.source.descriptor.levels[0]!.id } : desired
        const old = target.view
        if(normalized.wallOpacity!==undefined||normalized.floorOpacity!==undefined||target.requestedOpacity){
          const desired=target!==entry&&target.requestedOpacity?target.requestedOpacity:opacityOf(normalized),prior=target.opaqueOpacity??{wallOpacity:1,floorOpacity:1}
          target.requestedOpacity=desired;target.opaqueOpacity={wallOpacity:fractional(desired.wallOpacity)?prior.wallOpacity:desired.wallOpacity,floorOpacity:fractional(desired.floorOpacity)?prior.floorOpacity:desired.floorOpacity}
          target.view={...normalized,wallOpacity:fractional(desired.wallOpacity)?target.opaqueOpacity.wallOpacity:desired.wallOpacity,floorOpacity:fractional(desired.floorOpacity)?target.opaqueOpacity.floorOpacity:desired.floorOpacity}
        }else target.view=normalized
        if (changedMode) { target.overview = undefined; cancelOverview(target) }
        if (JSON.stringify([old.mode, old.levelId, old.cutaway, old.levelId === 'all' && old.separation > 0]) !== JSON.stringify([normalized.mode, normalized.levelId, normalized.cutaway, normalized.levelId === 'all' && normalized.separation > 0])) { cancelPreparation(target); discardPrepared(target) }
        else {
          if (target.scene && JSON.stringify(physicalDesiredMeshLayers(target.scene, old)) !== JSON.stringify(physicalDesiredMeshLayers(target.scene, normalized))) {
            target.layerFailure = undefined
            const desiredLayers = physicalDesiredMeshLayers(target.scene, normalized)
            const currentCovers = target.prepared !== null && !physicalMissingLayers(desiredLayers, target.preparedLayers).length
            // This also applies before the first asset exists: a newly enabled
            // layer cannot be lost behind an older cold-start request.
            if (target.preparing && (currentCovers || physicalMissingLayers(desiredLayers, target.requestedLayers).length)) cancelPreparation(target)
          }
          if (target.prepared&&(old.separation!==normalized.separation||JSON.stringify(old.hiddenLayerIds??null)!==JSON.stringify(normalized.hiddenLayerIds??null))) target.meshes = filteredMeshes(target, target.prepared)
        }
      }
      renderer?.invalidatePicks(); if (mode === '2d') { if (active && cameraOwned) viewport.cancelCamera(); viewport.setNavigationTool('pan') }; if (changedMode && active && cameraOwned) viewport.setPose({ pitch: mode === '2d' ? 0 : 50, ...(mode === '2d' ? { elevation: 0, bearing: focusedId === null ? 0 : requireEntry(focusedId).source.descriptor.bearing } : {}) }); reconcile(); viewport.requestRender()
    },
    setStatus(sceneId: string, status: ReadonlyMap<string, PhysicalSubjectStyle>): void {
      const entry = entries.get(sceneId); if (!entry) return
      for (const style of status.values()) if (!Number.isFinite(style.emphasis) || style.emphasis < 0 || style.emphasis > 1 || style.color?.some(value => !Number.isFinite(value) || value < 0 || value > 1)) throw new Error('Invalid physical status presentation')
      const signature = JSON.stringify([...status].sort(([a], [b]) => a.localeCompare(b))); if (signature === entry.signature) return; entry.signature = signature; entry.status = status; if (active && entry.eligible && entry.view.live) viewport.requestRender()
    },
    setPalette(next: PhysicalScenePalette): void { if (JSON.stringify(next) === JSON.stringify(palette)) return; palette = next; renderer?.setPalette(next); viewport.requestRender() },
    selectScope(sceneId: string, scopeId?: string): void {
      const entry = requireEntry(sceneId)
      if (scopeId && !entry.source.descriptor.scopes?.some(scope => scope.id === scopeId)) throw new Error(`Unknown physical scope: ${scopeId}`)
      focusedId = sceneId; forcedId = sceneId; collectionIds = null; pendingCollectionFocus = null
      if (entry.scopeId !== scopeId) {
        inspectionWorkingSet.forget(sceneId)
        pendingFocus = null; entry.renderRevision++
        changePreparedScope(entry)
      }
      entry.scopeId = scopeId
      if (entry.prepared) entry.meshes = filteredMeshes(entry, entry.prepared)
      renderer?.invalidatePicks(); reconcile(); viewport.requestRender()
    },
    selectCollection(sceneIds?: ReadonlyArray<string>): void {
      const selected = new Set(sceneIds ?? entries.keys())
      for (const id of selected) requireEntry(id)
      if (focusedId === null && collectionIds !== null && selected.size === collectionIds.size && [...selected].every(id => collectionIds!.has(id))) return
      pendingFocus = null; pendingCollectionFocus = null; focusedId = null; forcedId = null; collectionIds = selected
      for (const entry of entries.values()) {
        const changedScope = entry.scopeId !== undefined
        const changedLevel = mode === '3d' && selected.has(entry.source.descriptor.id) && entry.view.levelId !== 'all'
        if (changedScope) { inspectionWorkingSet.forget(entry.source.descriptor.id); entry.renderRevision++; changePreparedScope(entry) }
        entry.scopeId = undefined
        if (changedLevel) { entry.view = { ...entry.view, levelId: 'all' }; cancelPreparation(entry); discardPrepared(entry) }
        else if (entry.prepared) entry.meshes = filteredMeshes(entry, entry.prepared)
      }
      renderer?.invalidatePicks(); reconcile(); viewport.requestRender()
    },
    focus(sceneId: string, target: PhysicalSceneFocus = {}): void { this.selectScope(sceneId, target.scopeId); const entry = requireEntry(sceneId); fitEntry(entry, target, target.preservePose ?? true) },
    fit(sceneId: string): void { const entry = requireEntry(sceneId); fitEntry(entry, { scopeId: entry.scopeId }, true) },
    fitAll(sceneIds?: ReadonlyArray<string>, options: { readonly preservePose?: boolean } = {}): void {
      const selected = sceneIds ? sceneIds.map(requireEntry) : [...entries.values()]
      if (!selected.length) return
      this.selectCollection(selected.map(entry => entry.source.descriptor.id))
      const preservePose = options.preservePose ?? true
      pendingCollectionFocus = null; applyCollectionFit(selected, preservePose)
      if (selected.some(entry => !readyGeometry(entry) || entry.preparing)) pendingCollectionFocus = { targets: selected.map(entry => ({ entry, source: entry.generation })), preservePose }
    },
    home(sceneId: string, scopeId?: string): void { const entry = requireEntry(sceneId); this.selectScope(sceneId, scopeId); fitEntry(entry, { scopeId }, false) },
    reset(sceneId: string): void { const entry = requireEntry(sceneId); this.setView(sceneId, defaultPhysicalSceneView(entry.source.descriptor.levels)); this.home(sceneId) },
    cameraPose: viewport.cameraPose, zoomBy: (delta: number) => viewport.setPose({ zoom: viewport.cameraPose().zoom + delta }), tiltBy: (degrees: number) => viewport.setPose({ pitch: viewport.cameraPose().pitch + degrees }), turnBy: (degrees: number) => viewport.setPose({ bearing: viewport.cameraPose().bearing + degrees }), panBy: viewport.panBy, cancelCamera: () => { pendingFocus = null; pendingCollectionFocus = null; viewport.cancelCamera() }, setNavigationTool: viewport.setNavigationTool,
    setActive(value: boolean): void { if (active === value || destroyed) return; active = value; viewport.setActive?.(active && cameraOwned); if (!active) { clearHighlight(); pendingFocus = null; pendingCollectionFocus = null; for (const entry of entries.values()) { cancelPreparation(entry); cancelOverview(entry) }; viewport.cancelCamera(); renderer?.invalidatePicks() }; reconcile(); viewport.requestRender() },
    setCameraOwnership(value: boolean): void { if (cameraOwned === value || destroyed) return; cameraOwned = value; if (!value) { pendingFocus = null; pendingCollectionFocus = null; viewport.cancelCamera() }; syncPlanarity(); viewport.setActive?.(active && cameraOwned) },
    setHighlight(value: PhysicalSceneHighlight | null): void {
      if (destroyed) return
      const next = active ? value : null
      if (next && (!entries.has(next.sceneId) || next.color.some(value => !Number.isFinite(value) || value < 0 || value > 1))) throw new Error('Invalid physical occurrence highlight')
      if (JSON.stringify(highlight) === JSON.stringify(next)) return
      highlight = next; renderer?.setHighlight(next); viewport.requestRender()
    },
    projectOccurrencePoints: (sceneId: string, occurrenceId: string, points: ReadonlyArray<Vector3>, levelId?: string) => active ? renderer?.projectOccurrencePoints(sceneId, occurrenceId, points, levelId) ?? [] : [],
    pick: (point: { x: number; y: number }) => active ? renderer?.pick(point) ?? null : null,
    cheapProject: (sceneId: string, occurrenceId: string, levelId?: string) => active ? renderer?.cheapProject(sceneId, occurrenceId, levelId) ?? null : null,
    visibleAt: (sceneId: string, occurrenceId: string, point: { x: number; y: number }) => active && (renderer?.visibleAt(sceneId, occurrenceId, point) ?? false),
    project: (sceneId: string, occurrenceId: string, levelId?: string) => active ? renderer?.project(sceneId, occurrenceId, levelId) ?? null : null,
    projectPlanPoints(sceneId: string, points: ReadonlyArray<Vector3>): ReadonlyArray<{ x: number; y: number }> {
      const entry = entries.get(sceneId)
      if (!active || !entry || entry.state !== 'ready' || entry.view.mode !== '2d') return []
      let matrix = planPlacements.get(entry.source.descriptor)
      if (!matrix) { matrix = localMercatorMatrix(entry.source.descriptor.anchor, entry.source.descriptor.bearing); planPlacements.set(entry.source.descriptor, matrix) }
      return points.map(point => { const world = transform(matrix, point); return viewport.projectGeographic(new MercatorCoordinate(world[0], world[1]).toLngLat()) })
    },
    presentations, scene: (sceneId: string) => entries.get(sceneId)?.scene ?? null,
    subjectStyles: (sceneId: string): ReadonlyMap<string, PhysicalSubjectStyle> => entries.get(sceneId)?.status ?? emptyStatus,
    retry(sceneId: string): void {
      const entry = requireEntry(sceneId)
      if(opacityPresentation(entry)?.status==='unavailable'){architectureRetry=true;reconcile();viewport.requestRender();return}
      if (entry.layerFailure && entry.prepared) { entry.layerFailure = undefined; cancelPreparation(entry); reconcile(); viewport.requestRender(); return }
      inspectionWorkingSet.forget(sceneId); if (highlight?.sceneId === sceneId) clearHighlight(); entry.generation = ++generation; cancelPreparation(entry); cancelOverview(entry); entry.loading = false; entry.failure = undefined; entry.reason = undefined; entry.scene = null; discardPrepared(entry); prepare.retainIdentities?.(new Set([...entries.values()].map(entry => identityFor(entry)))); reconcile()
    },
    metrics: () => renderer?.metrics() ?? null,
    diagnostics: () => ({architecture:{...architectureOrdering.state(),...architecturePrepare.diagnostics()}, inspectionWorkingSet: inspectionWorkingSet.metrics(), surfaceOwnership: [...entries.values()].filter(entry => entry.prepared).map(entry => ({ sceneId: entry.source.descriptor.id, key: entry.prepared!.key, ...entry.prepared!.surfaceOwnership })), preparation: prepare.diagnostics?.() ?? null, current: renderer?.metrics() ?? null, disposals: [...disposals], retainedScenes: [...entries.values()].filter(entry => entry.scene).length, loadingScenes: [...entries.values()].filter(entry => entry.loading || entry.state === 'loading').length }),
    destroy(): void { if (destroyed) return; destroyed = true; pendingFocus = null; pendingCollectionFocus = null; for (const entry of entries.values()) { entry.generation = ++generation; cancelPreparation(entry); cancelOverview(entry) }; entries.clear(); inspectionWorkingSet.clear();architectureOrdering.destroy();architectureAsset=null;architectureInput=null;architectureFrame=null;architectureSelection=[]; prepare.destroy?.(); for (const remove of cleanup) remove(); removeRenderer(); viewport.destroy() },
  }
}
